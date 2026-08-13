/**
 * Type-metrics engine — pure, deterministic recommenders for CSS `line-height`
 * and `letter-spacing` (tracking) given a font size. Vendored (not a dependency)
 * because it's plain arithmetic: pure TS, ESM, strict, NO external deps, no
 * Electron import — so it runs unit-tested under bun.
 *
 * Powers the `line_height` agent tool (backends/claude.ts). The agent should CALL
 * this instead of defaulting to a hardcoded `1.5` everywhere: leading is
 * size-aware (larger type → tighter) and WCAG-floored for body text.
 *
 * Grounding (cited inline on the coefficients):
 * - WCAG 2.1 SC 1.4.12 (Text Spacing): body text must stay usable at
 *   line-height ≥ 1.5× → we floor body leading at 1.5.
 *   https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
 * - Inverse-to-size leading is the consensus of Material 3, Apple HIG and
 *   Tailwind; the exponential fit below hits their anchor points
 *   (16px→1.50, 24px→1.33, 32px→1.29, 48px→1.17, 64px→1.10).
 * - Measure-aware leading (Bringhurst / Butterick): longer lines want a touch
 *   more leading; ~66ch is the ideal measure.
 * - Tracking is size-specific (Material 3 tokens): large display slightly
 *   negative, body ~0, small text slightly positive; never negative on body.
 *
 * The measure coefficient and display-tracking magnitudes are the tunable/taste
 * part — kept as named consts. The body 1.5 floor and the inverse shape are the
 * settled, defensible core.
 */

export interface LineHeightInput {
  fontSizePx: number
  measureCh?: number // characters per line; omitted = no measure adjustment
  role?: 'body' | 'heading' | 'display' | 'auto' // default 'auto' (inferred from size)
}

export interface LineHeightResult {
  lineHeight: number // unitless, rounded 3dp — THE css value
  lineHeightPx: number // round(lineHeight * fontSizePx)
  rawRatio: number // before clamping
  floored: boolean // true if the WCAG 1.5 body floor was applied
  role: 'body' | 'heading' | 'display'
  rationale: string
}

export interface LetterSpacingResult {
  em: number
  css: string // e.g. "-0.02em", or "0" when zero
  rationale: string
}

export interface TypeMetrics {
  fontSizePx: number
  lineHeight: number
  lineHeightPx: number
  letterSpacingEm: number
  floored: boolean
  role: 'body' | 'heading' | 'display'
}

// --- Line-height model coefficients (fit to Material 3 / Apple HIG / Tailwind) ---

/** baseRatio(s) = BASE_FLOOR + BASE_AMPLITUDE * exp(-s / BASE_DECAY_PX). */
const BASE_FLOOR = 1.0
const BASE_AMPLITUDE = 0.855
const BASE_DECAY_PX = 29.8 // fit anchors: 16→1.500, 32→1.292, 48→1.171, 64→1.100

/** measureAdj(m) = clamp(MEASURE_COEFF * (m - MEASURE_IDEAL_CH), ±MEASURE_LIMIT). */
const MEASURE_COEFF = 0.0015
const MEASURE_IDEAL_CH = 66 // Bringhurst/Butterick ideal measure
const MEASURE_LIMIT = 0.04

/** Auto role thresholds (px), and the per-role minimum leading. */
const BODY_MAX_PX = 20 // s <= 20 → body
const HEADING_MAX_PX = 48 // s <= 48 → heading, else display
const BODY_MIN = 1.5 // WCAG 2.1 SC 1.4.12 body floor
const HEADING_MIN = 1.05
const DISPLAY_MIN = 1.0
const LINE_HEIGHT_MAX = 1.6

// --- Tracking model (letter-spacing, em) — Material 3 size buckets ---

const TRACK_ALL_CAPS = 0.06 // caps set wider
const TRACK_BUCKETS: Array<{ minPx: number; em: number }> = [
  { minPx: 60, em: -0.02 }, // large display
  { minPx: 40, em: -0.015 },
  { minPx: 24, em: -0.01 },
  { minPx: 18, em: -0.005 },
  { minPx: 12, em: 0 }, // body ~0
  { minPx: 0, em: 0.02 } // small text set slightly positive
]

function round(n: number, precision: number): number {
  return Number(n.toFixed(precision))
}

/** clamp(value, lower, upper) — lower must be <= upper. */
function clampValue(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper)
}

/** Resolve an explicit role, or infer one from the font size when 'auto'/omitted. */
function resolveRole(
  role: LineHeightInput['role'],
  fontSizePx: number
): 'body' | 'heading' | 'display' {
  if (role && role !== 'auto') return role
  if (fontSizePx <= BODY_MAX_PX) return 'body'
  if (fontSizePx <= HEADING_MAX_PX) return 'heading'
  return 'display'
}

function minForRole(role: 'body' | 'heading' | 'display'): number {
  if (role === 'body') return BODY_MIN
  if (role === 'heading') return HEADING_MIN
  return DISPLAY_MIN
}

/**
 * Recommend a unitless CSS line-height for a font size. Larger type gets tighter
 * leading (exponential fit); body text is floored at 1.5 per WCAG SC 1.4.12; an
 * optional measure (characters per line) nudges leading up on long lines / down
 * on short. An explicit `role` overrides the size-inferred one — and thus its
 * floor, so a `display` role can legitimately drop below the heading minimum.
 */
export function lineHeight(input: LineHeightInput): LineHeightResult {
  const { fontSizePx, measureCh } = input
  const role = resolveRole(input.role, fontSizePx)

  const baseRatio = BASE_FLOOR + BASE_AMPLITUDE * Math.exp(-fontSizePx / BASE_DECAY_PX)
  const measureAdj =
    measureCh != null
      ? clampValue(MEASURE_COEFF * (measureCh - MEASURE_IDEAL_CH), -MEASURE_LIMIT, MEASURE_LIMIT)
      : 0
  const raw = baseRatio + measureAdj

  const min = minForRole(role)
  const clamped = clampValue(raw, min, LINE_HEIGHT_MAX)
  const floored = raw < min && role === 'body'
  const value = round(clamped, 3)

  const parts = [`${role} @ ${fontSizePx}px → base leading ${round(baseRatio, 3)}`]
  if (measureCh != null) parts.push(`measure ${measureCh}ch adj ${round(measureAdj, 3)}`)
  if (floored) parts.push('floored to 1.5 for WCAG 2.1 SC 1.4.12 body text spacing')
  else if (clamped !== raw) parts.push(`clamped to [${min}, ${LINE_HEIGHT_MAX}]`)

  return {
    lineHeight: value,
    lineHeightPx: Math.round(value * fontSizePx),
    rawRatio: round(raw, 3),
    floored,
    role,
    rationale: parts.join('; ')
  }
}

/**
 * Recommend letter-spacing (tracking) in em for a font size: large display
 * slightly negative, body ~0, small text slightly positive (Material 3 buckets);
 * all-caps runs are set wider. Emits `css` like "-0.02em", or "0" when zero.
 */
export function letterSpacing(
  fontSizePx: number,
  opts?: { allCaps?: boolean }
): LetterSpacingResult {
  const bucket =
    TRACK_BUCKETS.find((b) => fontSizePx >= b.minPx) ?? TRACK_BUCKETS[TRACK_BUCKETS.length - 1]
  const allCaps = opts?.allCaps === true
  const em = round(bucket.em + (allCaps ? TRACK_ALL_CAPS : 0), 3)
  const css = em === 0 ? '0' : `${em}em`

  const parts = [`${fontSizePx}px → ${bucket.em}em (Material 3 size bucket)`]
  if (allCaps) parts.push(`+${TRACK_ALL_CAPS}em for all-caps`)

  return { em, css, rationale: parts.join('; ') }
}

/**
 * Combined recommendation: pairs line-height and letter-spacing for one size, so
 * a single size in yields matching leading + tracking (composes with the fluid
 * type scale). Mirrors the fields callers most often set together.
 */
export function typeMetrics(input: LineHeightInput & { allCaps?: boolean }): TypeMetrics {
  const lh = lineHeight(input)
  const ls = letterSpacing(input.fontSizePx, { allCaps: input.allCaps })
  return {
    fontSizePx: input.fontSizePx,
    lineHeight: lh.lineHeight,
    lineHeightPx: lh.lineHeightPx,
    letterSpacingEm: ls.em,
    floored: lh.floored,
    role: lh.role
  }
}
