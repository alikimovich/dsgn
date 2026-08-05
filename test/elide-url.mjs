/**
 * elide-url unit test (pure — no Electron, no DOM). The chat bubble's link
 * shortener: how a URL is abridged for display, and how a plain-text ask is
 * split into text/link runs. Run with: bun test/elide-url.mjs
 */
import { elideUrl, splitUrls } from '../src/renderer/src/lib/elide-url.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

// --- elideUrl ---

// Short enough to keep whole; only the scheme/www/trailing slash go.
eq(elideUrl('https://figma.com/file/abc'), 'figma.com/file/abc', 'short url keeps its path')
eq(elideUrl('http://localhost:5173/'), 'localhost:5173', 'trailing slash dropped')
eq(elideUrl('https://www.example.com/docs'), 'example.com/docs', 'www dropped')

// The case from the bug: a Figma embed link is mostly query string.
eq(
  elideUrl(
    'https://embed.figma.com/design/8cJr4hN6UDrSJVQ6YcX9Qf/portfolio?node-id=127-2510&embed-host=share'
  ),
  'embed.figma.com/…/portfolio',
  'middle path + query collapse, last segment kept'
)

// The query alone can be what busts the budget. Nothing was dropped from the
// middle here, so the ellipsis trails instead of splitting the path.
eq(
  elideUrl('https://example.com/search?q=a-very-long-query-string-that-goes-on-and-on-forever'),
  'example.com/search…',
  'query dropped, single segment kept'
)

// One enormous path segment: nothing structural is small enough, so fall back
// to host + ellipsis rather than emitting something over budget.
const oneSeg = elideUrl(`https://example.com/${'x'.repeat(200)}`)
eq(oneSeg, 'example.com/…', 'over-long single segment falls back to the host')

// A host that busts the budget on its own gets hard-truncated (never returned
// longer than asked for).
const longHost = elideUrl(`https://${'sub.'.repeat(20)}example.com/a`, 30)
ok(longHost.length <= 30, `over-long host stays within max: ${longHost.length}`)
ok(longHost.endsWith('…'), `over-long host is marked truncated: ${longHost}`)

// Every result honors the budget.
for (const u of [
  'https://embed.figma.com/design/8cJr4hN6UDrSJVQ6YcX9Qf/portfolio?node-id=127-2510&embed-host=share',
  'https://github.com/alikimovich/kitOS/blob/main/src/renderer/src/components/ChatPanel.tsx#L120',
  'https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z'
]) {
  ok(elideUrl(u).length <= 44, `within default max: ${u} → ${elideUrl(u)}`)
}

// --- splitUrls ---

const plain = splitUrls('add two articles between Swiftly and the next one')
eq(plain.length, 1, 'link-free text is one run')
eq(plain[0].kind, 'text', 'link-free run is a text run')

const runs = splitUrls('use https://www.figma.com/design/abc/portfolio?node-id=1 here')
eq(runs.length, 3, 'text / link / text')
eq(runs[0].text, 'use ', 'leading text preserved')
eq(runs[1].kind, 'link', 'the url is a link run')
eq(runs[1].href, 'https://www.figma.com/design/abc/portfolio?node-id=1', 'href keeps the FULL url')
eq(runs[2].text, ' here', 'trailing text preserved')

// Sentence punctuation belongs to the sentence, not the link.
const dot = splitUrls('see https://example.com/a.')
eq(dot[1].href, 'https://example.com/a', 'trailing period not swallowed')
eq(dot[2].text, '.', 'trailing period stays in the text run')

const paren = splitUrls('(https://example.com/a)')
eq(paren[1].href, 'https://example.com/a', 'closing paren not swallowed')

// ...but a paren that the URL itself opened is part of it.
const wiki = splitUrls('https://en.wikipedia.org/wiki/Bracket_(disambiguation)')
eq(
  wiki[0].href,
  'https://en.wikipedia.org/wiki/Bracket_(disambiguation)',
  'balanced paren kept in the href'
)

// `www.` counts as a link; a bare `figma.com/x` does not (guessing TLDs would
// elide ordinary words).
eq(splitUrls('www.example.com/a/b').length, 1, 'www. host is one link run')
eq(splitUrls('www.example.com/a/b')[0].kind, 'link', 'www. host detected')
eq(splitUrls('figma.com/design/abc')[0].kind, 'text', 'scheme-less host left alone')

// Multiple links in one ask.
const two = splitUrls('a https://example.com/one b https://example.com/two')
eq(two.filter((r) => r.kind === 'link').length, 2, 'both urls detected')

// The joined runs must reconstruct the original text exactly when nothing was
// elided — the render path relies on losing no characters.
const src = 'left https://example.com/x middle https://example.com/y right'
eq(
  splitUrls(src)
    .map((r) => (r.kind === 'link' ? r.href : r.text))
    .join(''),
  src,
  'runs reconstruct the source text'
)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('elide-url: all checks passed')
