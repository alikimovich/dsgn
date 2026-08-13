/**
 * Unit test for the vendored spring→CSS engine (src/main/spring.ts) — the pure
 * physics behind the `spring_to_css` agent tool. No Electron; runs under bun so
 * the .ts import transpiles: bun test/spring.mjs
 */
import assert from 'node:assert'
import {
  analyze,
  fromBounceDuration,
  fromRatioFreq,
  PRESETS,
  simplify,
  simulate,
  springToCss,
  toKeyframes,
  toRatioFreq,
  toTransition
} from '../src/main/spring.ts'

const UNDER = { stiffness: 180, damping: 12, mass: 1 } // ζ ≈ 0.45, bounces
const CRIT = { stiffness: 200, damping: 2 * Math.sqrt(200), mass: 1 } // ζ = 1
const OVER = { stiffness: 100, damping: 40, mass: 1 } // ζ = 2

// Endpoints: first sample is 0, last is EXACTLY 1 (so the property lands on target).
for (const cfg of [UNDER, CRIT, OVER]) {
  const { points } = springToCss(cfg)
  assert.strictEqual(points[0].p, 0, 'first sample 0')
  assert.strictEqual(points[points.length - 1].p, 1, 'last sample exactly 1')
}

// Overshoot: underdamped exceeds 1; critical/overdamped stay monotonic.
assert.ok(
  simulate(UNDER).samples.some((s) => s.p > 1),
  'underdamped overshoots'
)
assert.ok(
  simulate(OVER).samples.every((s) => s.p <= 1 + 1e-9),
  'overdamped no overshoot'
)
assert.ok(
  simulate(CRIT).samples.every((s) => s.p <= 1 + 1e-9),
  'critical no overshoot'
)

// Regime classification via ζ.
assert.strictEqual(analyze(UNDER).regime, 'underdamped')
assert.strictEqual(analyze(OVER).regime, 'overdamped')
assert.ok(Math.abs(analyze(CRIT).dampingRatio - 1) < 1e-9, 'critical ζ ≈ 1')

// Converter round-trip k/c/m → ζ/f → k/c/m within epsilon.
for (const cfg of [UNDER, OVER, { stiffness: 342, damping: 31, mass: 1.3 }]) {
  const { dampingRatio, frequencyHz } = toRatioFreq(cfg)
  const back = fromRatioFreq(dampingRatio, frequencyHz, cfg.mass)
  assert.ok(Math.abs(back.stiffness - cfg.stiffness) < 1e-6, 'stiffness round-trips')
  assert.ok(Math.abs(back.damping - cfg.damping) < 1e-6, 'damping round-trips')
}

// Golden: production curve matches an independent finer-step integration.
{
  const cfg = { stiffness: 342, damping: 31, mass: 1.3 }
  const { points } = springToCss(cfg)
  const ref = refCurve(cfg)
  let maxErr = 0
  for (const pt of points) maxErr = Math.max(maxErr, Math.abs(refAt(ref, pt.tMs) - pt.p))
  assert.ok(maxErr < 5e-3, `golden max error ${maxErr} < 5e-3`)
}

// Framer bounce+duration: solver hits the requested settle duration, and more
// bounce → more overshoot.
for (const [bounce, dur] of [
  [0, 400],
  [0.3, 600],
  [0.5, 800]
]) {
  assert.ok(
    Math.abs(simulate(fromBounceDuration(bounce, dur)).duration - dur) <= 8,
    `bounce ${bounce} hits ${dur}ms`
  )
}
assert.ok(
  analyze(fromBounceDuration(0.6, 500)).overshoot >
    analyze(fromBounceDuration(0.05, 500)).overshoot,
  'more bounce → more overshoot'
)

// Simplify trims points, preserves endpoints, and stays within tolerance.
{
  const { samples } = simulate(UNDER)
  const reduced = simplify(samples, 0.002)
  assert.ok(reduced.length < samples.length, 'simplify drops points')
  assert.strictEqual(reduced[0].p, samples[0].p, 'keeps first')
  assert.strictEqual(reduced[reduced.length - 1].p, samples[samples.length - 1].p, 'keeps last')
}

// Emitters produce well-formed strings.
assert.match(springToCss(UNDER).easing, /^linear\([-\d., ]+\)$/, 'linear() well-formed')
assert.match(
  toTransition(UNDER, { property: 'opacity' }),
  /^opacity \d+ms linear\(/,
  'transition shape'
)
assert.match(
  toKeyframes(UNDER),
  /@keyframes spring \{[\s\S]*0% \{[\s\S]*100% \{/,
  'keyframes shape'
)

// Every preset simulates and settles.
for (const [name, cfg] of Object.entries(PRESETS)) {
  assert.ok(simulate(cfg).settled, `${name} settles`)
}

// Invalid inputs throw.
assert.throws(() => simulate({ stiffness: 0, damping: 10, mass: 1 }), 'zero stiffness throws')
assert.throws(() => simulate({ stiffness: 100, damping: 10, mass: 0 }), 'zero mass throws')
assert.throws(() => simulate({ stiffness: 100, damping: -1, mass: 1 }), 'negative damping throws')

console.log(
  'SPRING OK — endpoints, overshoot, regimes, converters, golden, bounce, simplify, emitters, presets'
)

// --- helpers ---------------------------------------------------------------

function refCurve(cfg) {
  const { stiffness: k, damping: c, mass: m } = cfg
  const dt = 1 / 4000
  let x = 0
  let v = 0
  let t = 0
  const out = [{ tMs: 0, p: 0 }]
  for (let i = 0; i < 4000 * 6; i++) {
    const a = (-k * (x - 1) - c * v) / m
    v += a * dt
    x += v * dt
    t += dt * 1000
    out.push({ tMs: t, p: x })
  }
  return out
}

function refAt(ref, tMs) {
  if (tMs <= 0) return 0
  let lo = 0
  let hi = ref.length - 1
  if (tMs >= ref[hi].tMs) return ref[hi].p
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ref[mid].tMs < tMs) lo = mid
    else hi = mid
  }
  const a = ref[lo]
  const b = ref[hi]
  const f = (tMs - a.tMs) / (b.tMs - a.tMs || 1)
  return a.p + (b.p - a.p) * f
}
