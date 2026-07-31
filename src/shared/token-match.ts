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
 * OFFERED; its GROUP NAME decides where it ranks and whether it may NAME a
 * row.** Group names are unconstrained — a manifest may call a group `brand`, a
 * CSS-var scan derives groups from the first name segment, Tailwind uses
 * `colors`/`spacing`/… — so they must never remove a token from the picker.
 * Value shapes are universal.
 *
 * Naming is the stricter half, and deliberately so — for two independent
 * reasons layered on top of each other:
 *
 * 1. A group whose name clearly marks a DIFFERENT property family (`radius`
 *    for a `padding` row) is barred from labelling that row: a value shared
 *    across families — `0`, above all — would otherwise be labelled by
 *    whichever such token happened to be detected first. An unrecognized
 *    group name constrains nothing and can still name. See `groupRole`.
 * 2. Even within the RIGHT family, naming requires actual evidence the
 *    element's source references that token — not just that the value
 *    equals it. `getComputedStyle` always resolves `var()` away, so value
 *    equality alone can never tell "this IS `--color-text`" from "happens to
 *    equal it"; only the property's SPECIFIED declaration can. See
 *    `resolveTokenForValue`'s `source`/`provenVar`.
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
 * What a group is FOR, as distinct from what shape its values happen to have.
 * `radius` and `spacing` both hold lengths, so `TokenKind` cannot tell them
 * apart — which is exactly the collision this exists to resolve.
 */
export type TokenRole =
  | 'color'
  | 'spacing'
  | 'radius'
  | 'font-size'
  | 'font-weight'
  | 'line-height'
  | 'tracking'
  | 'font-family'
  | 'shadow'
  | 'opacity'

/**
 * The role a group NAME suggests, or null when it suggests nothing. One table
 * covers all three detection sources: Tailwind's theme categories (`colors`,
 * `spacing`, `fontSize`, …), a manifest's hand-written keys, and `cssGroupOf`'s
 * first-name-segment groups (`--color-text` → `color`, `--space-md` → `space`).
 *
 * Order is load-bearing: `fontSize`/`fontWeight` must be tested before the bare
 * `font` catch-all, and `sizing|size` before nothing (it would swallow
 * `fontsize` if it ran first).
 */
export function groupRole(groupName: string): TokenRole | null {
  const g = groupName.toLowerCase().replace(/[^a-z]/g, '')
  if (/colou?r|palette|swatch/.test(g)) return 'color'
  if (/fontsize|textsize/.test(g)) return 'font-size'
  if (/fontweight|weight/.test(g)) return 'font-weight'
  if (/lineheight|leading/.test(g)) return 'line-height'
  if (/letterspacing|tracking/.test(g)) return 'tracking'
  if (/font|typeface/.test(g)) return 'font-family'
  if (/radius|radii|rounded|corner/.test(g)) return 'radius'
  if (/spacing|space|gap|padding|margin|sizing|size|inset/.test(g)) return 'spacing'
  if (/shadow|elevation/.test(g)) return 'shadow'
  if (/opacity|alpha/.test(g)) return 'opacity'
  return null
}

interface PropRule {
  /** Value shapes this property accepts — the offering gate. */
  kinds: TokenKind[]
  /**
   * Group roles whose tokens may NAME this property. A token from any other
   * *recognized* role is still offered (its value shape vouched for it) but
   * ranks last and won't be used as the row's label — that's what stopped a
   * `--radius-none` from labelling `padding: 0`. A group with no recognized
   * role (`brand`, `rmt`) is unconstrained, so it can still name.
   */
  roles: TokenRole[]
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
  color: { kinds: ['color'], roles: ['color'] },
  'background-color': { kinds: ['color'], roles: ['color'] },
  'padding-top': { kinds: ['length'], roles: ['spacing'] },
  'padding-right': { kinds: ['length'], roles: ['spacing'] },
  'padding-bottom': { kinds: ['length'], roles: ['spacing'] },
  'padding-left': { kinds: ['length'], roles: ['spacing'] },
  'margin-top': { kinds: ['length'], roles: ['spacing'] },
  'margin-right': { kinds: ['length'], roles: ['spacing'] },
  'margin-bottom': { kinds: ['length'], roles: ['spacing'] },
  'margin-left': { kinds: ['length'], roles: ['spacing'] },
  gap: { kinds: ['length'], roles: ['spacing'] },
  'border-radius': { kinds: ['length'], roles: ['radius'] },
  'font-size': { kinds: ['length'], roles: ['font-size'] },
  'letter-spacing': { kinds: ['length'], roles: ['tracking'] },
  // A unitless line-height (1.5) is idiomatic; bound it so a z-index or a
  // duration-ish token can't pose as one.
  // Spacing stays welcome here (unlike radius on padding): line-height is the
  // one property taking both lengths and unitless numbers, and systems really
  // do drive leading off the spacing scale. Predates roles; kept deliberately.
  'line-height': {
    kinds: ['length', 'number'],
    roles: ['line-height', 'spacing'],
    inRange: (v) => !BARE_NUM_RE.test(v.trim()) || (num(v) >= 0.5 && num(v) <= 4)
  },
  // A z-index of 100 or 700 is a legal font weight, so value shape alone can't
  // rule it out. It stays offerable but ranks `neutral`, sitting below any real
  // weight scale in the picker rather than being hidden.
  'font-weight': {
    kinds: ['number'],
    roles: ['font-weight'],
    inRange: (v) => num(v) >= 100 && num(v) <= 900 && num(v) % 100 === 0
  },
  opacity: { kinds: ['number'], roles: ['opacity'], inRange: (v) => num(v) >= 0 && num(v) <= 1 }
}

export interface TokenCandidate {
  token: Token
  /** The group the token came from (its name, verbatim). */
  group: string
  /**
   * `preferred` — the group's role is one the property accepts.
   * `neutral`   — the group name suggests no role at all (a `brand` group, say).
   * `other`     — the group's role belongs to a DIFFERENT property family; still
   *               offered (the value shape already vouched for it), but ranked
   *               last AND barred from naming the row — see resolveTokenForValue.
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
    const role = groupRole(group.name)
    const rank = role === null ? 'neutral' : rule.roles.includes(role) ? 'preferred' : 'other'
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
  /** The element's classes. For a `tailwind`-sourced set this IS the proof of
   *  usage (a Tailwind class names its theme key directly); for other sources
   *  it's a tie-break only. */
  classes?: string[]
  /** The name last shown for this row. NOT a guessing tie-break — it's what
   *  bridges the gap right after an explicit pick, before the write has landed
   *  and reconciled: the live preview injects the RESOLVED value (never a
   *  `var()`), so a real reference briefly looks unproven. We know the pick
   *  happened; that's evidence too, just not source-level evidence. */
  sticky?: string | null
  /** Value comparison, injected — the renderer passes its `sameCssValue`, which
   *  normalizes color notations and units ('#ff0000' ≡ 'rgb(255, 0, 0)'). */
  equals: (a: string, b: string) => boolean
  /**
   * Which detection source `candidates` came from — decides how naming may be
   * PROVEN rather than guessed:
   *  - `css` — `provenVar` must name one of the candidates. `getComputedStyle`
   *    always resolves `var()` away, so value equality alone can never tell
   *    "this IS that token" from "happens to equal it"; only the property's
   *    SPECIFIED declaration can. No proof, no name.
   *  - `tailwind` — no `var()` exists to check; a class naming the token IS
   *    the proof.
   *  - `manifest` (and anything else) — no reference mechanism exists at all
   *    (a manifest token is a hand-picked literal, not a live variable), so
   *    this falls back to the pre-existing value+role heuristic. A known,
   *    disclosed gap, not a silent regression.
   */
  source: TokenSource
  /**
   * The exact `--name` this property's SPECIFIED (unresolved) declaration
   * references — from `preview/style-provenance.ts`, via `styles:read`'s
   * `declaredVars`. Only meaningful when `source === 'css'`; null means the
   * declaration is a literal (no token in play at all).
   */
  provenVar?: string | null
}

export interface TokenResolution {
  match: TokenCandidate
  /** Other candidates with an equal value — shown marked inside the picker. */
  ties: TokenCandidate[]
}

/**
 * Which token (if any) `computed` currently IS — PROVEN, never guessed from
 * value coincidence alone. `0` is the value every "none" token in a theme
 * shares, so among same-valued candidates only real evidence that the source
 * references a token may name the row; showing the raw value beats showing a
 * confidently wrong name.
 *
 * `matches` (value equality, via the injected `equals`) is necessary but never
 * sufficient — it's the pool proof gets applied against, not proof itself.
 * `source` decides what counts as proof; see `ResolveOptions`. `manifest` is
 * the one source with no reference mechanism at all, so it alone keeps the
 * pre-existing value+role heuristic (rank `'other'` excluded, then a class
 * hint, then sticky, then detection order) — ties there are real (a theme may
 * define `--color-title` and `--color-link` as the same hex) and unresolvable
 * without a stronger signal.
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

  /** An explicit pick THIS session, still value-consistent — see `sticky`'s doc. */
  const stuck = (): TokenResolution | null => {
    const s = opts.sticky ? matches.find((c) => c.token.name === opts.sticky) : undefined
    return s ? { match: s, ties: matches.filter((c) => c !== s) } : null
  }

  if (opts.source === 'css') {
    const proven = opts.provenVar
      ? matches.find((c) => bareName(c.token.name) === bareName(opts.provenVar as string))
      : undefined
    return proven ? { match: proven, ties: matches.filter((c) => c !== proven) } : stuck()
  }

  if (opts.source === 'tailwind') {
    const classes = opts.classes ?? []
    const named = matches.filter((c) => {
      const bare = bareName(c.token.name)
      return classes.some((cls) => cls === bare || cls.endsWith(`-${bare}`))
    })
    if (named.length === 0) return stuck()
    const best =
      named.find((c) => c.rank === 'preferred' && c.token.name === opts.sticky) ??
      named.find((c) => c.rank === 'preferred') ??
      named.find((c) => c.token.name === opts.sticky) ??
      named[0]
    return { match: best, ties: matches.filter((c) => c !== best) }
  }

  // 'manifest': no reference mechanism to prove against — the legacy heuristic.
  const roled = matches.filter((c) => c.rank !== 'other' || c.token.name === opts.sticky)
  if (roled.length === 0) return null
  if (roled.length === 1) return { match: roled[0], ties: matches.filter((c) => c !== roled[0]) }
  const classes = opts.classes ?? []
  const named = roled.filter((c) => {
    const bare = bareName(c.token.name)
    return classes.some((cls) => cls === bare || cls.endsWith(`-${bare}`))
  })
  const pool = named.length ? named : roled
  const best =
    pool.find((c) => c.rank === 'preferred' && c.token.name === opts.sticky) ??
    pool.find((c) => c.rank === 'preferred') ??
    pool.find((c) => c.token.name === opts.sticky) ??
    pool[0]
  return { match: best, ties: matches.filter((c) => c !== best) }
}
