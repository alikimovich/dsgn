/**
 * Spring → CSS `linear()` engine (vendored from the standalone `spring2css` tool,
 * ~/dev/spring2css — keep the two in sync when the algorithm changes).
 *
 * Pure, dependency-free, no Electron import — so it's unit-testable under bun and
 * usable from any process. The `spring_to_css` in-process agent tool (backends/
 * claude.ts) is the primary consumer: it lets the agent compute EXACT easing
 * curves for a target repo instead of hallucinating spring values.
 *
 * The physics: a mass-spring-damper `a = (−k·x − c·v) / m` integrated with
 * semi-implicit (symplectic) Euler at a fixed 1 ms step over a normalized unit
 * step (position 0 → target 1, v0 = 0). Settle time = duration; sampled progress
 * = the `linear()` control points. See the standalone repo's README for the full
 * write-up and gotchas.
 */

export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
}

export interface SpringCssOptions {
  restDelta?: number
  restSpeed?: number
  sampleHz?: number
  maxMs?: number
  precision?: number
  explicitStops?: boolean
  simplify?: number
}

export interface Sample {
  p: number
  tMs: number
}

const DEFAULTS: Required<Omit<SpringCssOptions, never>> = {
  restDelta: 4e-4,
  restSpeed: 0.02,
  sampleHz: 90,
  maxMs: 4000,
  precision: 4,
  explicitStops: false,
  simplify: 0
}

/** Simulate the unit-step spring; returns raw progress samples + settle duration. */
export function simulate(
  cfg: SpringConfig,
  o: SpringCssOptions = {}
): { samples: Sample[]; duration: number; settled: boolean } {
  const { stiffness: k, damping: c, mass: m } = cfg
  const { restDelta, restSpeed, sampleHz, maxMs } = { ...DEFAULTS, ...o }

  if (!(k > 0)) throw new Error(`stiffness must be > 0 (got ${k})`)
  if (!(m > 0)) throw new Error(`mass must be > 0 (got ${m})`)
  if (c < 0) throw new Error(`damping must be >= 0 (got ${c})`)

  const dt = 1 / 1000 // 1 ms integration step
  const target = 1
  let x = 0
  let v = 0
  let tMs = 0

  const every = 1000 / sampleHz
  let nextAt = every
  const samples: Sample[] = [{ p: 0, tMs: 0 }]
  let settled = false

  while (tMs < maxMs) {
    const a = (-k * (x - target) - c * v) / m
    v += a * dt
    x += v * dt
    tMs += 1
    if (tMs >= nextAt) {
      samples.push({ p: x, tMs })
      nextAt += every
    }
    if (Math.abs(target - x) < restDelta && Math.abs(v) < restSpeed) {
      settled = true
      break
    }
  }

  // Land exactly on target so the property never snaps at the end.
  samples.push({ p: 1, tMs })
  const duration = Math.max(1, Math.round(tMs))
  return { samples, duration, settled }
}

/** Convert a spring into a CSS `linear()` easing + duration. */
export function springToCss(
  cfg: SpringConfig,
  o: SpringCssOptions = {}
): { duration: number; easing: string; points: Sample[]; settled: boolean } {
  const opts = { ...DEFAULTS, ...o }
  const { samples, duration, settled } = simulate(cfg, opts)

  const pts = opts.simplify > 0 ? simplify(samples, opts.simplify) : samples
  const round = (n: number): number => Number(n.toFixed(opts.precision))
  const body = opts.explicitStops
    ? pts.map((s) => `${round(s.p)} ${round((s.tMs / duration) * 100)}%`).join(', ')
    : pts.map((s) => round(s.p)).join(', ')

  return { duration, easing: `linear(${body})`, points: pts, settled }
}

// --- input converters -------------------------------------------------------

/** stiffness/damping/mass → damping ratio ζ and natural frequency. */
export function toRatioFreq(cfg: SpringConfig): {
  dampingRatio: number
  omega0: number
  frequencyHz: number
} {
  const { stiffness: k, damping: c, mass: m } = cfg
  const omega0 = Math.sqrt(k / m)
  const dampingRatio = c / (2 * Math.sqrt(k * m))
  return { dampingRatio, omega0, frequencyHz: omega0 / (2 * Math.PI) }
}

/** damping ratio ζ + frequency f(Hz) → stiffness/damping (mass fixed, default 1). */
export function fromRatioFreq(dampingRatio: number, frequencyHz: number, mass = 1): SpringConfig {
  const w0 = 2 * Math.PI * frequencyHz
  return { stiffness: w0 * w0 * mass, damping: 2 * dampingRatio * w0 * mass, mass }
}

/**
 * Framer-style bounce + duration → SpringConfig (approximate). `bounce` maps to
 * ζ = 1 − bounce (clamped); the natural frequency is solved so the spring's
 * settle duration matches `durationMs`. Documented approximation, not bit-exact
 * Framer parity.
 */
export function fromBounceDuration(
  bounce: number,
  durationMs: number,
  mass = 1,
  o: SpringCssOptions = {}
): SpringConfig {
  const zeta = clamp(1 - bounce, 0.05, 5)
  const solveDuration = (w0: number): number =>
    simulate({ stiffness: w0 * w0 * mass, damping: 2 * zeta * w0 * mass, mass }, o).duration

  let lo = 0.1
  let hi = 500
  for (let i = 0; i < 40; i++) {
    if (solveDuration(hi) <= durationMs) break
    hi *= 2
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (solveDuration(mid) > durationMs) lo = mid
    else hi = mid
  }
  const w0 = (lo + hi) / 2
  return { stiffness: w0 * w0 * mass, damping: 2 * zeta * w0 * mass, mass }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

// --- Ramer–Douglas–Peucker point reduction (vertical/progress distance) -----

/**
 * Drop points whose progress stays within `tolerance` of the straight line
 * `linear()` would draw between kept neighbors. Vertical distance in progress
 * units, so `tolerance` directly bounds the easing error. Keeps first & last.
 */
export function simplify(samples: Sample[], tolerance: number): Sample[] {
  if (samples.length < 3 || tolerance <= 0) return samples.slice()

  const keep = new Array<boolean>(samples.length).fill(false)
  keep[0] = keep[samples.length - 1] = true

  const stack: Array<[number, number]> = [[0, samples.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop() as [number, number]
    const a = samples[start]
    const b = samples[end]
    const span = b.tMs - a.tMs || 1e-12
    let maxDist = 0
    let idx = -1
    for (let i = start + 1; i < end; i++) {
      const p = samples[i]
      const f = (p.tMs - a.tMs) / span
      const lineP = a.p + (b.p - a.p) * f
      const dist = Math.abs(p.p - lineP)
      if (dist > maxDist) {
        maxDist = dist
        idx = i
      }
    }
    if (maxDist > tolerance && idx !== -1) {
      keep[idx] = true
      stack.push([start, idx], [idx, end])
    }
  }
  return samples.filter((_, i) => keep[i])
}

// --- metrics ----------------------------------------------------------------

export interface Metrics {
  dampingRatio: number
  omega0: number
  frequencyHz: number
  regime: 'underdamped' | 'critical' | 'overdamped'
  overshoot: number
  settleDuration: number
  visualDuration: number
  settled: boolean
  pointCount: number
}

/** Descriptive metrics: ζ, ω0, Hz, overshoot, settle vs visual duration. */
export function analyze(
  cfg: SpringConfig,
  o: SpringCssOptions & { visualThreshold?: number } = {}
): Metrics {
  const opts = { ...DEFAULTS, ...o }
  const visualThreshold = o.visualThreshold ?? 0.01
  const { samples, duration, settled } = simulate(cfg, opts)
  const { dampingRatio, omega0, frequencyHz } = toRatioFreq(cfg)

  let peak = -Infinity
  let visualMs = 0
  for (const s of samples) {
    if (s.p > peak) peak = s.p
    if (Math.abs(1 - s.p) > visualThreshold) visualMs = s.tMs
  }

  return {
    dampingRatio,
    omega0,
    frequencyHz,
    regime: dampingRatio < 1 ? 'underdamped' : dampingRatio > 1 ? 'overdamped' : 'critical',
    overshoot: Math.max(0, peak - 1),
    settleDuration: duration,
    visualDuration: Math.max(1, visualMs),
    settled,
    pointCount: samples.length
  }
}

// --- output emitters --------------------------------------------------------

export function toTransition(
  cfg: SpringConfig,
  o: SpringCssOptions & { property?: string } = {}
): string {
  const { duration, easing } = springToCss(cfg, o)
  return `${o.property ?? 'transform'} ${duration}ms ${easing}`
}

export function toCssVars(
  cfg: SpringConfig,
  o: SpringCssOptions & { prefix?: string } = {}
): string {
  const { duration, easing } = springToCss(cfg, o)
  const prefix = o.prefix ?? '--spring'
  return `${prefix}-ease: ${easing};\n${prefix}-dur: ${duration}ms;`
}

export function toKeyframes(
  cfg: SpringConfig,
  o: SpringCssOptions & { name?: string; prop?: string } = {}
): string {
  const opts = { ...DEFAULTS, ...o }
  const { samples, duration } = simulate(cfg, opts)
  const pts = opts.simplify > 0 ? simplify(samples, opts.simplify) : samples
  const round = (n: number): number => Number(n.toFixed(opts.precision))
  const name = o.name ?? 'spring'
  const prop = o.prop ?? '--spring-progress'

  const seen = new Set<number>()
  const lines: string[] = []
  for (const s of pts) {
    const pct = round((s.tMs / duration) * 100)
    if (seen.has(pct)) continue
    seen.add(pct)
    lines.push(`  ${pct}% { ${prop}: ${round(s.p)}; }`)
  }
  return `/* duration: ${duration}ms */\n@keyframes ${name} {\n${lines.join('\n')}\n}`
}

// --- presets ----------------------------------------------------------------

export const PRESETS: Record<string, SpringConfig> = {
  ios: { stiffness: 170, damping: 26, mass: 1 },
  'ios-gentle': { stiffness: 120, damping: 20, mass: 1 },
  'ios-wobbly': { stiffness: 180, damping: 12, mass: 1 },
  'ios-stiff': { stiffness: 210, damping: 20, mass: 1 },
  material: { stiffness: 100, damping: 15, mass: 1 },
  'framer-default': { stiffness: 100, damping: 10, mass: 1 },
  'react-spring-default': { stiffness: 170, damping: 26, mass: 1 },
  'react-spring-gentle': { stiffness: 120, damping: 14, mass: 1 },
  'react-spring-wobbly': { stiffness: 180, damping: 12, mass: 1 },
  'react-spring-stiff': { stiffness: 210, damping: 20, mass: 1 },
  'react-spring-slow': { stiffness: 280, damping: 60, mass: 1 },
  'react-spring-molasses': { stiffness: 280, damping: 120, mass: 1 },
  snappy: { stiffness: 400, damping: 30, mass: 1 },
  bouncy: { stiffness: 300, damping: 15, mass: 1 },
  smooth: { stiffness: 300, damping: 40, mass: 1 },
  critical: { stiffness: 200, damping: Math.round(2 * Math.sqrt(200)), mass: 1 }
}
