/**
 * Design-token ⇄ CSS-property matching. Which of a project's detected tokens
 * may be offered for a given css property, how a token is written back as a
 * *reference*, and which token (if any) the element's current computed value
 * corresponds to.
 *
 * Lives in `shared/` because both sides need it: the island's Styles panel to
 * render the picker and name the current value, and `main/styles.ts` to
 * re-validate a pick before splicing it into source (the island's claim is
 * never trusted). Pure + DOM-free + fs-free, like `slash-token.ts` — the proof
 * is `test/token-match.mjs`, which imports it under plain bun.
 *
 * The load-bearing rule: **a token's VALUE SHAPE decides whether it may be
 * offered; its GROUP NAME only decides where it ranks.** Group names are
 * unconstrained — a manifest may call a group `brand`, a CSS-var scan derives
 * groups from the first name segment, Tailwind uses `colors`/`spacing`/… — so
 * they can rank but must never exclude. Value shapes are universal.
 */

import type { Token, TokenSet, TokenSource } from './api'

export type TokenKind = 'color' | 'length' | 'number' | 'shadow' | 'font' | 'unknown'

/**
 * CSS named colors (+ `transparent`/`currentcolor`). Shared with
 * `main/tw-styles.ts`, which needs the same set to tell a color arbitrary-value
 * class (`text-[red]`) from a font-size one.
 */
export const CSS_NAMED_COLORS: ReadonlySet<string> = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent currentcolor'
  ).split(' ')
)

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/
const COLOR_FN_RE = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/
const LENGTH_RE =
  /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em|ch|ex|%|vh|vw|vmin|vmax|svh|lvh|dvh|pt|pc|cm|mm|in|q)$/
const BARE_NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)$/
/** `calc()`/`clamp()`/`min()`/`max()` carrying a length unit — a fluid size token. */
const LENGTH_FN_RE = /^(?:calc|clamp|min|max)\(.*\d\s*(?:px|rem|em|%|vw|vh|ch)/

function isColorText(v: string): boolean {
  return HEX_RE.test(v) || COLOR_FN_RE.test(v) || CSS_NAMED_COLORS.has(v)
}

/**
 * What KIND of value is this? The hard gate on what a token may be offered for.
 *
 * Note `0` is classified as a length, not a number: CSS allows a unitless zero
 * wherever a length is expected, and a `--space-0: 0` token is real. Every
 * other bare number is a `number`, which is what keeps a `--z-modal: 100` out
 * of the padding picker.
 */
export function tokenValueKind(value: string): TokenKind {
  const v = value.trim().toLowerCase()
  if (!v) return 'unknown'
  if (isColorText(v)) return 'color'
  if (LENGTH_RE.test(v) || LENGTH_FN_RE.test(v)) return 'length'
  if (BARE_NUM_RE.test(v)) return Number(v) === 0 ? 'length' : 'number'
  // Multi-part values: a shadow carries a length AND a color; a font stack is a
  // comma-separated list of families with neither.
  const parts = v.split(/[\s,]+/).filter(Boolean)
  if (parts.length > 1) {
    const hasLength = parts.some((p) => LENGTH_RE.test(p) || p === '0')
    const hasColor = parts.some(isColorText)
    if (hasLength && hasColor) return 'shadow'
    if (!hasLength && v.includes(',')) return 'font'
  }
  return 'unknown'
}

/**
 * The kind a group NAME suggests, or null when it suggests nothing. Used only
 * to rank — never to exclude. One table covers all three detection sources:
 * Tailwind's theme categories (`colors`, `spacing`, `fontSize`, …), a
 * manifest's hand-written keys, and `cssGroupOf`'s first-name-segment groups
 * (`--color-text` → `color`, `--space-md` → `space`).
 */
export function groupAffinity(groupName: string): TokenKind | null {
  const g = groupName.toLowerCase().replace(/[^a-z]/g, '')
  if (/colou?r|palette|swatch/.test(g)) return 'color'
  if (/fontsize|textsize/.test(g)) return 'length'
  if (/fontweight|weight/.test(g)) return 'number'
  if (/lineheight|leading/.test(g)) return 'number'
  if (/letterspacing|tracking/.test(g)) return 'length'
  if (/font|typeface/.test(g)) return 'font'
  if (/radius|radii|rounded|corner/.test(g)) return 'length'
  if (/spacing|space|gap|padding|margin|sizing|size|inset/.test(g)) return 'length'
  if (/shadow|elevation/.test(g)) return 'shadow'
  if (/opacity|alpha/.test(g)) return 'number'
  return null
}

interface PropRule {
  kinds: TokenKind[]
  /** Extra numeric sanity check — the property's real domain. */
  inRange?: (value: string) => boolean
}

const num = (v: string): number => Number(v.trim())

/**
 * Which token kinds each editable property accepts. Mirrors `STYLE_PROPS` in
 * `main/styles.ts`; the transition family is deliberately absent (durations and
 * easings aren't design tokens in any of the three sources we read).
 */
export const PROP_TOKEN_RULES: Record<string, PropRule> = {
  color: { kinds: ['color'] },
  'background-color': { kinds: ['color'] },
  'padding-top': { kinds: ['length'] },
  'padding-right': { kinds: ['length'] },
  'padding-bottom': { kinds: ['length'] },
  'padding-left': { kinds: ['length'] },
  'margin-top': { kinds: ['length'] },
  'margin-right': { kinds: ['length'] },
  'margin-bottom': { kinds: ['length'] },
  'margin-left': { kinds: ['length'] },
  gap: { kinds: ['length'] },
  'border-radius': { kinds: ['length'] },
  'font-size': { kinds: ['length'] },
  'letter-spacing': { kinds: ['length'] },
  // A unitless line-height (1.5) is idiomatic; bound it so a z-index or a
  // duration-ish token can't pose as one.
  'line-height': {
    kinds: ['length', 'number'],
    inRange: (v) => !BARE_NUM_RE.test(v.trim()) || (num(v) >= 0.5 && num(v) <= 4)
  },
  // A z-index of 100 or 700 is a legal font weight, so value shape alone can't
  // rule it out. It stays offerable but ranks `neutral`, sitting below any real
  // weight scale in the picker rather than being hidden.
  'font-weight': {
    kinds: ['number'],
    inRange: (v) => num(v) >= 100 && num(v) <= 900 && num(v) % 100 === 0
  },
  opacity: { kinds: ['number'], inRange: (v) => num(v) >= 0 && num(v) <= 1 }
}

export interface TokenCandidate {
  token: Token
  /** The group the token came from (its name, verbatim). */
  group: string
  /**
   * `preferred` — the group name agrees with the property's kind.
   * `neutral`   — the group name says nothing (a `brand` group, say).
   * `other`     — the group name suggests a different kind; still offered
   *               (the value shape already vouched for it), just ranked last.
   */
  rank: 'preferred' | 'neutral' | 'other'
}

const RANK_ORDER = { preferred: 0, neutral: 1, other: 2 } as const

/**
 * Every token that may be offered for `prop`, best-ranked first. Within a rank
 * the TokenSet's own group/token order is preserved — token files are authored
 * in a meaningful order (a tonal ramp, a spacing scale), so never alphabetize.
 */
export function tokensForProp(set: TokenSet | null, prop: string): TokenCandidate[] {
  const rule = PROP_TOKEN_RULES[prop]
  if (!set || !rule || set.source === 'none') return []
  const out: TokenCandidate[] = []
  for (const group of set.groups) {
    const affinity = groupAffinity(group.name)
    const rank =
      affinity === null ? 'neutral' : rule.kinds.includes(affinity) ? 'preferred' : 'other'
    for (const token of group.tokens) {
      if (!rule.kinds.includes(tokenValueKind(token.value))) continue
      if (rule.inRange && !rule.inRange(token.value)) continue
      out.push({ token, group: group.name, rank })
    }
  }
  // Stable by construction: Array.prototype.sort is stable in every engine we
  // target, so equal ranks keep detection order.
  return out.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank])
}

/**
 * How a token is written into source. A `css` source has a real runtime
 * reference (`var(--color-text)`); `tailwind` and `manifest` sources do not —
 * there the value itself is the only thing that can be spliced into a style
 * (the Tailwind *class* path is handled separately, by property, in
 * `main/tw-styles.ts`).
 */
export function tokenReference(source: TokenSource, token: Token): string {
  if (source === 'css') {
    if (/^var\(/.test(token.value)) return token.value
    const n = token.name
    return `var(${n.startsWith('--') ? n : `--${n}`})`
  }
  return token.value
}

/** The `--…` names worth reading off the element with getComputedStyle. */
export function customPropertyNames(set: TokenSet | null): string[] {
  if (set?.source !== 'css') return []
  return set.groups.flatMap((g) => g.tokens.map((t) => t.name)).filter((n) => n.startsWith('--'))
}

/** A token name as it would appear as a class suffix (`--color-text` → `color-text`). */
function bareName(name: string): string {
  return name.replace(/^--/, '')
}

export interface ResolveOptions {
  /**
   * Live values of the project's custom properties **as resolved on the
   * selected element** (`getComputedStyle(el).getPropertyValue('--color-text')`).
   * This is the authoritative signal: it follows the cascade, so it is right
   * under `@media (prefers-color-scheme: dark)` and through `var()` aliasing,
   * where the value recorded in the token file is not. A name missing or empty
   * here falls back to that recorded value.
   */
  resolved?: Record<string, string>
  /** The element's classes — a tie-break only (it's a pick-time snapshot). */
  classes?: string[]
  /** The name last shown for this row; kept when it still ties, so the label
   *  doesn't flip between reconciles of an unchanged value. */
  sticky?: string | null
  /** Value comparison, injected — the renderer passes its `sameCssValue`, which
   *  normalizes color notations and units ('#ff0000' ≡ 'rgb(255, 0, 0)'). */
  equals: (a: string, b: string) => boolean
}

export interface TokenResolution {
  match: TokenCandidate
  /** Other candidates with an equal value — shown marked inside the picker. */
  ties: TokenCandidate[]
}

/**
 * Which token (if any) `computed` currently IS. Ties are common and real — a
 * theme may well define `--color-title` and `--color-link` as the same hex — so
 * one winner is always chosen deterministically rather than showing "2 tokens":
 * a class list that names one → the better-ranked group → the sticky previous
 * choice → detection order.
 */
export function resolveTokenForValue(
  candidates: TokenCandidate[],
  computed: string,
  opts: ResolveOptions
): TokenResolution | null {
  if (!computed) return null
  const matches = candidates.filter((c) => {
    const live = opts.resolved?.[c.token.name]?.trim()
    return opts.equals(computed, live || c.token.value)
  })
  if (matches.length === 0) return null
  if (matches.length === 1) return { match: matches[0], ties: [] }

  const classes = opts.classes ?? []
  const named = matches.filter((c) => {
    const bare = bareName(c.token.name)
    return classes.some((cls) => cls === bare || cls.endsWith(`-${bare}`))
  })
  const pool = named.length ? named : matches
  const best =
    pool.find((c) => c.rank === 'preferred' && c.token.name === opts.sticky) ??
    pool.find((c) => c.rank === 'preferred') ??
    pool.find((c) => c.token.name === opts.sticky) ??
    pool[0]
  return { match: best, ties: matches.filter((c) => c !== best) }
}
