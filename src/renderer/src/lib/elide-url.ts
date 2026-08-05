/**
 * Shortening long URLs for display.
 *
 * A pasted link is one unbreakable token, so a chat bubble sized to its
 * content (`width: fit-content`) grows as wide as the link and spills out of
 * the chat pane. Wrapping alone stops the spill but leaves two or three lines
 * of query-string noise in the middle of an ask, so links are also elided down
 * to the part a human reads — host + last path segment — with the full URL
 * kept for the `title` tooltip.
 *
 * Pure (no DOM, no React) so it can be unit-tested with bun.
 */

/** Bare URLs inside plain user text. `www.`-prefixed hosts count; anything that
 *  would need a TLD guess (`figma.com/…` with no scheme or `www.`) does not —
 *  false positives here would elide ordinary words. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi

/** Trailing punctuation that is far more likely to be the sentence's than the
 *  URL's ("see https://x.com/a." / "(https://x.com/a)"). A closing paren only
 *  counts as sentence punctuation when the URL has no opening one. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if ('.,;:!?'.includes(ch)) end--
    else if (ch === ')' && !url.slice(0, end).includes('(')) end--
    else break
  }
  return url.slice(0, end)
}

/**
 * A display label for `url`, at most ~`max` characters.
 *
 * Drops the scheme and any `www.`, then — only if it still doesn't fit —
 * collapses the middle of the path and the whole query/hash into an ellipsis,
 * keeping the host and the last path segment (the two bits that say what the
 * link IS): `embed.figma.com/…/portfolio`.
 */
export function elideUrl(url: string, max = 44): string {
  const clean = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
  if (clean.length <= max) return clean

  const host = clean.split(/[/?#]/, 1)[0]
  const path = clean.slice(host.length).replace(/[?#].*$/, '')
  const segments = path.split('/').filter(Boolean)
  const last = segments[segments.length - 1]

  if (last) {
    // The ellipsis goes where content was actually dropped: mid-path when
    // there were segments in between, otherwise trailing (the query/hash).
    const collapsed =
      segments.length > 1 ? `${host}/…/${last}` : `${host}/${last}…`
    if (collapsed.length <= max) return collapsed
  }
  const bare = `${host}/…`
  if (bare.length <= max) return bare
  // A host longer than the budget on its own — nothing structural left to drop.
  return `${clean.slice(0, Math.max(1, max - 1))}…`
}

/** One run of a message's text: either literal text or a URL to render elided. */
export type TextRun =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; label: string }

/**
 * Split plain text into literal runs and URL runs, each URL carrying its
 * display label. Text with no links returns a single text run, so callers can
 * render the result unconditionally.
 */
export function splitUrls(text: string, max?: number): TextRun[] {
  const runs: TextRun[] = []
  let at = 0
  for (const m of text.matchAll(URL_RE)) {
    const href = trimTrailingPunctuation(m[0])
    if (!href) continue
    const start = m.index
    if (start > at) runs.push({ kind: 'text', text: text.slice(at, start) })
    runs.push({ kind: 'link', href, label: elideUrl(href, max) })
    at = start + href.length
  }
  if (at < text.length || runs.length === 0)
    runs.push({ kind: 'text', text: text.slice(at) })
  return runs
}
