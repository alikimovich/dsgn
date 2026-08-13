/**
 * OKLCH perceptual color engine — pure, dependency-free, no Electron import, so
 * it's unit-testable under bun and usable from any process. Powers a future
 * color-scale / gamut-mapping agent tool (mirrors how apca.ts backs
 * `check_contrast` and spring.ts backs `spring_to_css`).
 *
 * The pipeline is Björn Ottosson's OKLab/OKLCH: sRGB is gamma-decoded to linear
 * light, mixed into the LMS cone response, cube-rooted, and rotated into the
 * perceptually-uniform OKLab axes (L lightness, A/B opponent) — then OKLCH is
 * just the polar form (C chroma, H hue). Gamut mapping holds L and H fixed and
 * reduces C by binary search until the color fits inside sRGB, which is what
 * keeps a generated scale hue-consistent while never emitting an unrepresentable
 * color. Matrices are the exact Ottosson constants; see
 * https://bottosson.github.io/posts/oklab/ for the derivation.
 */

export interface Oklch {
  /** Perceptual lightness, 0 (black) .. 1 (white). */
  l: number
  /** Chroma, >= 0 (sRGB tops out around ~0.4). */
  c: number
  /** Hue in degrees, 0 .. 360. */
  h: number
}

export interface Rgb {
  /** Red channel, 0 .. 255. */
  r: number
  /** Green channel, 0 .. 255. */
  g: number
  /** Blue channel, 0 .. 255. */
  b: number
}

/** How far outside [0,1] a linear channel may sit and still count as in-gamut. */
const GAMUT_EPS = 1e-4

// --- sRGB transfer function -------------------------------------------------

/** sRGB gamma decode: a nonlinear channel (0..1) → linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB gamma encode: linear light → a nonlinear channel (0..1). */
function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
}

// --- OKLab core (Ottosson matrices) -----------------------------------------

/** Linear sRGB (0..1 each) → OKLab [L, A, B]. */
function linearRgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  return [L, A, B]
}

/** OKLab [L, A, B] → linear sRGB (0..1 each, may fall outside for OOG colors). */
function oklabToLinearRgb(L: number, A: number, B: number): [number, number, number] {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B
  const s_ = L - 0.0894841775 * A - 1.291485548 * B

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [r, g, b]
}

// --- OKLab ↔ OKLCH ----------------------------------------------------------

/** OKLab [L, A, B] → OKLCH (hue normalized 0..360). */
function oklabToOklch(L: number, A: number, B: number): Oklch {
  const c = Math.hypot(A, B)
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c, h }
}

/** OKLCH → OKLab [L, A, B]. */
function oklchToOklab(color: Oklch): [number, number, number] {
  const hr = (color.h * Math.PI) / 180
  return [color.l, color.c * Math.cos(hr), color.c * Math.sin(hr)]
}

// --- hex parsing ------------------------------------------------------------

/** Parse `#rgb` / `#rrggbb` (with or without leading `#`) into 0..255 channels. */
function parseHex(hex: string): Rgb {
  const n = hex.trim().replace(/^#/, '')
  const full =
    n.length === 3
      ? n
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : n
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Could not parse hex color: ${hex}`)
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

/** 0..255 channels → `#rrggbb`. */
function rgbToHex({ r, g, b }: Rgb): string {
  const h = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

// --- public conversions -----------------------------------------------------

/** Parse a hex color (`#rgb` or `#rrggbb`) into OKLCH. */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex)
  const [L, A, B] = linearRgbToOklab(
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255)
  )
  return oklabToOklch(L, A, B)
}

/**
 * OKLCH → sRGB. `inGamut` reports whether the *unclamped* linear rgb sat within
 * [0,1] (± a tiny epsilon); the returned `rgb` is always gamma-encoded and
 * clamped to [0,255], so it's a usable (if desaturated at the edges) color.
 */
export function oklchToRgb(color: Oklch): { rgb: Rgb; inGamut: boolean } {
  const [L, A, B] = oklchToOklab(color)
  const [lr, lg, lb] = oklabToLinearRgb(L, A, B)

  const within = (v: number): boolean => v >= -GAMUT_EPS && v <= 1 + GAMUT_EPS
  const inGamut = within(lr) && within(lg) && within(lb)

  const enc = (v: number): number => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255)))
  return { rgb: { r: enc(lr), g: enc(lg), b: enc(lb) }, inGamut }
}

/**
 * Reduce chroma (holding L and H) until the color fits in sRGB. Already-in-gamut
 * colors return unchanged; otherwise binary-search the largest C in [0, color.c]
 * that is in gamut (~20 iterations — well below one 8-bit code step).
 */
export function clampToGamut(color: Oklch): Oklch {
  if (oklchToRgb(color).inGamut) return color

  let lo = 0
  let hi = color.c
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (oklchToRgb({ l: color.l, c: mid, h: color.h }).inGamut) lo = mid
    else hi = mid
  }
  return { l: color.l, c: lo, h: color.h }
}

/** OKLCH → `#rrggbb`, gamut-mapped into sRGB (chroma reduced to fit). */
export function oklchToHex(color: Oklch, gamut: 'srgb' = 'srgb'): string {
  void gamut // only sRGB is supported today; param reserved for wider gamuts.
  return rgbToHex(oklchToRgb(clampToGamut(color)).rgb)
}

// --- perceptual scale -------------------------------------------------------

export interface ScaleInput {
  /** Seed color (hex) the scale is derived from. */
  seed: string
  /** Number of steps to emit (default 12, Radix-style). */
  steps?: number
  /** Degrees added to the seed hue (constant across the scale), default 0. */
  hueShift?: number
  /** [darkestL, lightestL] lightness endpoints, default [0.18, 0.98]. */
  lightnessRange?: [number, number]
}

export interface ScaleStep {
  /** 1-based position; index 1 = lightest, index `steps` = darkest. */
  index: number
  /** Gamut-mapped `#rrggbb`. */
  hex: string
  /** The (gamut-mapped) OKLCH the hex was rendered from. */
  oklch: Oklch
  /** Whether the mapped OKLCH was in sRGB gamut (true after mapping). */
  inGamut: boolean
}

/**
 * Build a perceptual OKLCH scale from a seed. Hue is fixed (seed hue + hueShift);
 * lightness is distributed evenly across `lightnessRange` from lightest (index 1)
 * to darkest (index `steps`); chroma follows a bell curve peaking in the mid
 * lightnesses (where sRGB has the most room), scaled by the seed's chroma. Every
 * step is gamut-mapped so its hex is always representable.
 */
export function oklchScale(input: ScaleInput): ScaleStep[] {
  const steps = input.steps ?? 12
  const hueShift = input.hueShift ?? 0
  const [darkL, lightL] = input.lightnessRange ?? [0.18, 0.98]

  const seed = hexToOklch(input.seed)
  let hue = seed.h + hueShift
  hue = ((hue % 360) + 360) % 360

  const out: ScaleStep[] = []
  for (let i = 1; i <= steps; i++) {
    // t: 0 at the lightest end (index 1), 1 at the darkest (index `steps`).
    const t = steps === 1 ? 0 : (i - 1) / (steps - 1)
    const l = lightL + (darkL - lightL) * t

    // Bell curve on lightness, peaking around L ≈ 0.6 (where sRGB is widest).
    const bell = Math.exp(-(((l - 0.6) / 0.28) ** 2))
    const targetC = seed.c * bell

    const mapped = clampToGamut({ l, c: targetC, h: hue })
    const { rgb, inGamut } = oklchToRgb(mapped)
    out.push({ index: i, hex: rgbToHex(rgb), oklch: mapped, inGamut })
  }
  return out
}
