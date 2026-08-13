/**
 * Pure inline-style splicers, shared by the styles engine (styles.ts, JSX
 * `style={{…}}`) and the Svelte/HTML adapter (styles-svelte.ts, `style="…"`).
 * String surgery only — no electron, no fs, no AST — so everything here is
 * bun-unit-testable (test/inline-style.mjs) and cheap per scrub commit.
 */

/** 'background-color' → 'backgroundColor' (JSX style-object key form). */
export function cssPropToJsKey(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Spans of `text` between top-level `sep` chars. Separators inside quotes or
 * inside (), [], {} don't split, so `cubic-bezier(0.1, 0.2, 0.3, 0.4)` and
 * `content: 'a;b'` survive intact.
 */
function splitTop(text: string, sep: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === sep && depth === 0) {
      spans.push({ start, end: i })
      start = i + 1
    }
  }
  spans.push({ start, end: text.length })
  return spans
}

/** Index of the first top-level `target` char (same quote/paren rules), -1 if
 * none — finds the key/value colon without tripping on `url(data:…)`. */
function indexOfTop(text: string, target: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === target && depth === 0) return i
  }
  return -1
}

/**
 * Merge a declaration into a `style="…"` attribute VALUE (Svelte/HTML).
 * Replaces the existing declaration for `prop` (case-insensitive; duplicates
 * collapse to one), else appends. Other declarations — including shorthands
 * like `transition:` when editing `transition-duration` — pass through
 * untouched. Always returns the new style string.
 */
export function mergeStyleString(
  styleValue: string | null | undefined,
  prop: string,
  value: string
): string {
  const target = prop.trim().toLowerCase()
  const decl = `${target}: ${value}`
  const text = styleValue ?? ''
  const kept: string[] = []
  let replaced = false
  for (const { start, end } of splitTop(text, ';')) {
    const raw = text.slice(start, end)
    if (!raw.trim()) continue // empty segment from a trailing/doubled semicolon
    const colon = indexOfTop(raw, ':')
    const name = (colon === -1 ? raw : raw.slice(0, colon)).trim().toLowerCase()
    if (name === target) {
      if (!replaced) {
        kept.push(decl)
        replaced = true
      }
      continue
    }
    kept.push(raw.trim())
  }
  if (!replaced) kept.push(decl)
  return kept.join('; ')
}

/** Does `text` contain a `//` or `/*` comment outside quotes? splitTop/
 * indexOfTop are comment-blind, so a splice could land INSIDE a comment (the
 * code still compiles, the style silently never applies) — callers refuse.
 * A lone `/` (division: `size / 2`) doesn't trip this. */
function hasComment(text: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true
  }
  return false
}

const STRING_LITERAL = /^(['"])(?:\\.|(?!\1)[^\\\n])*\1$/
const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * Merge a property into the SOURCE TEXT of a JSX `style={{…}}` object literal
 * (pass the inner `{…}` object). Replaces an existing property whose value is
 * a string/number literal, else appends — always as a quoted string value.
 * Returns null when splicing can't be proven safe: a spread entry, or the
 * target property's value is a non-literal expression (fall back to the agent).
 */
export function mergeStyleObjectSource(
  objectSource: string,
  prop: string,
  value: string
): string | null {
  const open = objectSource.indexOf('{')
  const close = objectSource.lastIndexOf('}')
  if (open === -1 || close < open) return null
  const inner = objectSource.slice(open + 1, close)
  if (hasComment(inner)) return null // a splice could land inside the comment
  const jsKey = cssPropToJsKey(prop)
  const literal = JSON.stringify(value)

  // Scan EVERY entry before splicing: a spread anywhere (even after a match)
  // makes the final object unknowable, and with duplicate keys the LAST one
  // wins at runtime — replacing an earlier duplicate would have no effect.
  let target: { start: number; raw: string; colon: number } | null = null
  for (const { start, end } of splitTop(inner, ',')) {
    const raw = inner.slice(start, end)
    const trimmed = raw.trim()
    if (!trimmed) continue // trailing comma / blank segment
    if (trimmed.startsWith('...')) return null // spread: final object unknowable
    const colon = indexOfTop(raw, ':')
    // Shorthand entry (`{ color }`): key only, value is a variable.
    const keyText = (colon === -1 ? raw : raw.slice(0, colon)).trim()
    const key = STRING_LITERAL.test(keyText) ? keyText.slice(1, -1) : keyText
    if (key === jsKey || key === prop) target = { start, raw, colon }
  }
  if (target) {
    const { start, raw, colon } = target
    if (colon === -1) return null // target's value is an identifier, not a literal
    const after = raw.slice(colon + 1)
    if (!STRING_LITERAL.test(after.trim()) && !NUMBER_LITERAL.test(after.trim())) return null
    // Splice just the value token; the key text and whitespace stay as-authored.
    const valStart = colon + 1 + (after.length - after.trimStart().length)
    const valEnd = valStart + raw.slice(valStart).trimEnd().length
    const abs = open + 1 + start
    return objectSource.slice(0, abs + valStart) + literal + objectSource.slice(abs + valEnd)
  }

  // No entry for the prop — append it.
  const entry = `${jsKey}: ${literal}`
  if (!inner.trim()) {
    return `${objectSource.slice(0, open + 1)} ${entry} ${objectSource.slice(close)}`
  }
  const innerEnd = open + 1 + inner.replace(/\s+$/, '').length // after last non-ws char
  const sep = inner.trimEnd().endsWith(',') ? ' ' : ', '
  return objectSource.slice(0, innerEnd) + sep + entry + objectSource.slice(innerEnd)
}
