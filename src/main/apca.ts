/**
 * APCA (Lc) accessible-contrast engine (adapted from the standalone `apca-cli`,
 * ~/dev/apca-cli — keep behavior in sync when either changes).
 *
 * Powers the `check_contrast` agent tool (backends/claude.ts): it not only checks
 * a foreground/background pair against the canonical APCA font-size/weight lookup,
 * but SUGGESTS the nearest accessible color (adjusting lightness, preserving hue)
 * so users can land on matching, readable palettes.
 *
 * APCA is the perceptual contrast model WCAG 3 is built around — more accurate
 * than WCAG 2's 4.5:1 ratio. The Lc math + threshold table come from `apca-w3`
 * (Myndex's reference impl) — we never invent thresholds. Color parsing comes
 * from `colorparsley`. Both are ESM-only, so — like the Agent SDK in a CJS main —
 * they're pulled in via a memoized dynamic import().
 */

type ApcaDeps = {
  calcAPCA: (t: string | number[], b: string | number[], places?: number, round?: boolean) => number
  fontLookupAPCA: (contrast: number, places?: number) => Array<number | string>
  colorParsley: (c: string | number[]) => [number, number, number, number, boolean, string]
}

let depsPromise: Promise<ApcaDeps> | undefined
/** Memoized ESM load of apca-w3 + colorparsley (see file header for why dynamic). */
function loadDeps(): Promise<ApcaDeps> {
  depsPromise ??= Promise.all([import('apca-w3'), import('colorparsley')]).then(
    ([apca, parsley]) => ({
      calcAPCA: apca.calcAPCA,
      fontLookupAPCA: apca.fontLookupAPCA,
      colorParsley: parsley.colorParsley
    })
  )
  return depsPromise
}

export type Verdict = 'pass' | 'fail' | 'non-text-only' | 'spot-text-only' | 'prohibited'

export interface CheckResult {
  foreground: string
  background: string
  fontSizePx: number
  fontWeight: number
  lc: number
  /** Minimum px size at this weight APCA requires for this Lc (null for sentinel verdicts). */
  minFontSizePx: number | null
  verdict: Verdict
  message: string
  wcag2?: Wcag2Result
}

export interface Wcag2Result {
  ratio: number
  ratioRounded: number
  isLargeText: boolean
  AA: 'pass' | 'fail'
  AAA: 'pass' | 'fail'
  uiComponents: 'pass' | 'fail'
  verdict: 'AAA' | 'AA' | 'AA-large' | 'fail'
  message: string
}

export interface CheckInput {
  foreground: string
  background: string
  fontSizePx?: number
  fontWeight?: number
  wcag2?: boolean
}

/** Round font weight to the nearest 100 in [100, 900] — APCA lookup is keyed at hundreds. */
function snapWeight(w: number): number {
  return Math.min(900, Math.max(100, Math.round(w / 100) * 100))
}

/** Interpret a signed Lc against the APCA font lookup for a given size + weight. */
function interpretLc(
  lc: number,
  fontSizePx: number,
  weight: number,
  fontLookupAPCA: ApcaDeps['fontLookupAPCA']
): { verdict: Verdict; minFontSizePx: number | null; message: string } {
  const raw = Number(fontLookupAPCA(lc)[weight / 100])
  if (raw === 999) {
    return {
      verdict: 'prohibited',
      minFontSizePx: null,
      message: `Lc ${lc.toFixed(1)} is below the APCA usable threshold — prohibited for any text at weight ${weight}.`
    }
  }
  if (raw === 777) {
    return {
      verdict: 'non-text-only',
      minFontSizePx: null,
      message: `Lc ${lc.toFixed(1)} is valid only for non-text elements at weight ${weight} (decorative graphics, dividers).`
    }
  }
  if (raw === 666) {
    return {
      verdict: 'spot-text-only',
      minFontSizePx: null,
      message: `Lc ${lc.toFixed(1)} is valid only for spot text at weight ${weight} (copyright, placeholder) — not body text.`
    }
  }
  if (fontSizePx >= raw) {
    return {
      verdict: 'pass',
      minFontSizePx: raw,
      message: `Lc ${lc.toFixed(1)} passes — at weight ${weight} this supports text down to ${raw}px; your ${fontSizePx}px clears it.`
    }
  }
  return {
    verdict: 'fail',
    minFontSizePx: raw,
    message: `Lc ${lc.toFixed(1)} fails — at weight ${weight} this needs at least ${raw}px text; your ${fontSizePx}px is below that.`
  }
}

/** Compute APCA Lc + verdict (and optionally WCAG 2) for a color pair. */
export async function checkContrast(input: CheckInput): Promise<CheckResult> {
  const { calcAPCA, fontLookupAPCA, colorParsley } = await loadDeps()
  const fontSizePx = input.fontSizePx ?? 16
  const weight = snapWeight(input.fontWeight ?? 400)

  const lc = calcAPCA(input.foreground, input.background)
  const { verdict, minFontSizePx, message } = interpretLc(lc, fontSizePx, weight, fontLookupAPCA)

  const result: CheckResult = {
    foreground: input.foreground,
    background: input.background,
    fontSizePx,
    fontWeight: weight,
    lc,
    minFontSizePx,
    verdict,
    message
  }
  if (input.wcag2)
    result.wcag2 = wcag2(input.foreground, input.background, fontSizePx, weight, colorParsley)
  return result
}

// --- suggestion: nearest accessible color, preserving hue -------------------

export interface Suggestion {
  /** Which color was adjusted. */
  role: 'foreground' | 'background'
  /** The suggested color as #rrggbb. */
  hex: string
  lc: number
  verdict: Verdict
  minFontSizePx: number | null
  /** Absolute change in HSL lightness from the original (0..1). */
  lightnessDelta: number
  /** True when no lightness kept hue AND reached a pass; hex is then the best-effort max-contrast pick. */
  bestEffort: boolean
}

/**
 * Find the accessible color closest to `adjust` (in HSL lightness, hue + saturation
 * preserved) that lets the pair pass APCA at the given size/weight. `role` says
 * whether `adjust` is the text (foreground) or the surface (background); the other
 * color (`fixed`) stays put. If nothing passes, returns the max-|Lc| pick with
 * `bestEffort: true`.
 */
export async function suggestAccessible(
  adjust: string,
  fixed: string,
  role: 'foreground' | 'background',
  fontSizePx = 16,
  fontWeight = 400
): Promise<Suggestion> {
  const { calcAPCA, fontLookupAPCA, colorParsley } = await loadDeps()
  const weight = snapWeight(fontWeight)

  const parsed = colorParsley(adjust)
  if (!parsed || parsed[4] !== true) throw new Error(`Could not parse color: '${adjust}'`)
  const [h, s, l0] = rgbToHsl([parsed[0], parsed[1], parsed[2]])

  const lcAt = (l: number): number => {
    const hex = rgbToHex(hslToRgb(h, s, l))
    return role === 'foreground' ? calcAPCA(hex, fixed) : calcAPCA(fixed, hex)
  }
  const passesAt = (l: number): boolean =>
    interpretLc(lcAt(l), fontSizePx, weight, fontLookupAPCA).verdict === 'pass'

  // Scan lightness in fine steps; among passing values, take the one nearest the
  // original lightness (smallest visual change). Track the max-|Lc| as fallback.
  const STEPS = 256
  let bestL = -1
  let bestDelta = Infinity
  let maxAbsLc = -1
  let maxAbsLcL = l0
  for (let i = 0; i <= STEPS; i++) {
    const l = i / STEPS
    const absLc = Math.abs(lcAt(l))
    if (absLc > maxAbsLc) {
      maxAbsLc = absLc
      maxAbsLcL = l
    }
    if (passesAt(l)) {
      const delta = Math.abs(l - l0)
      if (delta < bestDelta) {
        bestDelta = delta
        bestL = l
      }
    }
  }

  const chosenL = bestL >= 0 ? bestL : maxAbsLcL
  const hex = rgbToHex(hslToRgb(h, s, chosenL))
  const lc = role === 'foreground' ? calcAPCA(hex, fixed) : calcAPCA(fixed, hex)
  const info = interpretLc(lc, fontSizePx, weight, fontLookupAPCA)
  return {
    role,
    hex,
    lc,
    verdict: info.verdict,
    minFontSizePx: info.minFontSizePx,
    lightnessDelta: Math.abs(chosenL - l0),
    bestEffort: bestL < 0
  }
}

// --- WCAG 2 (self-contained; only needs parsed sRGB) ------------------------

function wcag2(
  foreground: string,
  background: string,
  fontSizePx: number,
  fontWeight: number,
  colorParsley: ApcaDeps['colorParsley']
): Wcag2Result {
  const fg = parseRgb(foreground, colorParsley)
  const bg = parseRgb(background, colorParsley)
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
  const ratioRounded = Math.round(ratio * 100) / 100

  // WCAG 2 "large text": ≥18pt (24px), or ≥14pt (18.67px) when bold (≥700).
  const large = fontSizePx >= (fontWeight >= 700 ? 14 / 0.75 : 18 / 0.75)
  const aa = large ? 3 : 4.5
  const aaa = large ? 4.5 : 7
  const AA = ratio >= aa ? 'pass' : 'fail'
  const AAA = ratio >= aaa ? 'pass' : 'fail'
  const verdict = AAA === 'pass' ? 'AAA' : AA === 'pass' ? (large ? 'AA-large' : 'AA') : 'fail'
  const sizeLabel = large ? 'large text' : 'normal text'
  const message =
    verdict === 'fail'
      ? `Ratio ${ratioRounded}:1 fails WCAG 2 AA for ${sizeLabel} — needs ${aa}:1 (AA) or ${aaa}:1 (AAA).`
      : verdict === 'AAA'
        ? `Ratio ${ratioRounded}:1 passes WCAG 2 AAA for ${sizeLabel} (threshold ${aaa}:1).`
        : `Ratio ${ratioRounded}:1 passes WCAG 2 AA for ${sizeLabel} (${aa}:1) but fails AAA (${aaa}:1).`

  return {
    ratio,
    ratioRounded,
    isLargeText: large,
    AA,
    AAA,
    uiComponents: ratio >= 3 ? 'pass' : 'fail',
    verdict,
    message
  }
}

function parseRgb(color: string, colorParsley: ApcaDeps['colorParsley']): [number, number, number] {
  const p = colorParsley(color)
  if (!p || p[4] !== true) throw new Error(`Could not parse color: '${color}'`)
  return [p[0], p[1], p[2]]
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

// --- color space helpers (sRGB 8-bit ⇄ HSL) ---------------------------------

/** [r,g,b] 0..255 → [h 0..360, s 0..1, l 0..1]. */
export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

/** [h 0..360, s 0..1, l 0..1] → [r,g,b] 0..255 (rounded). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** [r,g,b] 0..255 → #rrggbb. */
export function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}
