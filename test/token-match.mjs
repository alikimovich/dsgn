/**
 * token-match unit test (pure — no Electron, no DOM). The design-token ⇄ css
 * property matcher behind the Styles panel's token chips and picker:
 * value-shape classification, group-name affinity, the per-property gate,
 * reference forms per detection source, and value→token resolution incl. the
 * two-tokens-same-value tie. Run with: bun test/token-match.mjs
 */
import {
  customPropertyNames,
  groupAffinity,
  resolveTokenForValue,
  tokenReference,
  tokenValueKind,
  tokensForProp
} from '../src/shared/token-match.ts'
// Cross-module contract: the panel injects sameCssValue as the comparator, so
// resolution must survive '#6c6c6c' ⇄ 'rgb(108, 108, 108)'.
import { sameCssValue } from '../src/renderer/src/lib/css-values.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
const names = (cands) => cands.map((c) => c.token.name)

// --- tokenValueKind ---------------------------------------------------------

eq(tokenValueKind('#6c6c6c'), 'color', 'hex is a color')
eq(tokenValueKind('#FFF'), 'color', 'short hex, case-insensitive')
eq(tokenValueKind('rgb(108, 108, 108)'), 'color', 'rgb() is a color')
eq(tokenValueKind('oklch(0.7 0.1 250)'), 'color', 'oklch() is a color')
eq(tokenValueKind('rebeccapurple'), 'color', 'a named color is a color')
eq(tokenValueKind('transparent'), 'color', 'transparent is a color')
eq(tokenValueKind('16px'), 'length', 'px is a length')
eq(tokenValueKind('1.5rem'), 'length', 'rem is a length')
eq(tokenValueKind('100%'), 'length', '% is a length')
eq(tokenValueKind('clamp(1rem, 2vw, 2rem)'), 'length', 'a fluid clamp() is a length')
// A unitless zero is CSS-valid wherever a length is, and `--space-0: 0` is real.
eq(tokenValueKind('0'), 'length', 'bare 0 counts as a length')
eq(tokenValueKind('600'), 'number', 'a bare non-zero number is a number')
eq(tokenValueKind('1.5'), 'number', 'a bare decimal is a number')
eq(tokenValueKind('0 1px 2px #0003'), 'shadow', 'length + color is a shadow')
eq(tokenValueKind('"Geist Sans", sans-serif'), 'font', 'a comma-separated stack is a font')
eq(tokenValueKind('Menlo, Monaco, monospace'), 'font', 'an unquoted stack is a font')
eq(tokenValueKind(''), 'unknown', 'empty → unknown')
eq(tokenValueKind('ease-in-out'), 'unknown', 'a keyword we do not model → unknown')

// --- groupAffinity ----------------------------------------------------------

eq(groupAffinity('colors'), 'color', 'tailwind colors')
eq(groupAffinity('color'), 'color', 'css-var first-segment group')
eq(groupAffinity('colour'), 'color', 'british spelling')
eq(groupAffinity('spacing'), 'length', 'tailwind spacing')
eq(groupAffinity('space'), 'length', 'css-var space group')
eq(groupAffinity('borderRadius'), 'length', 'tailwind borderRadius')
eq(groupAffinity('radius'), 'length', 'manifest radius')
eq(groupAffinity('fontSize'), 'length', 'tailwind fontSize')
eq(groupAffinity('fontWeight'), 'number', 'fontWeight ranks as a number')
eq(groupAffinity('boxShadow'), 'shadow', 'tailwind boxShadow')
// Group names are unconstrained — an unrecognized one must stay NEUTRAL, never
// exclude, or a manifest with hand-written keys would surface nothing.
eq(groupAffinity('brand'), null, 'an unrecognized group name says nothing')
eq(groupAffinity('z'), null, 'a z-index group says nothing')

// --- tokensForProp: value shape GATES, group name only RANKS ----------------

const cssSet = {
  source: 'css',
  origin: 'src/routes/styles.less',
  groups: [
    {
      name: 'color',
      tokens: [
        { name: '--color-text', value: '#6c6c6c' },
        { name: '--color-title', value: '#212121' },
        { name: '--color-link', value: '#212121' }
      ]
    },
    { name: 'space', tokens: [{ name: '--space-md', value: '16px' }] },
    // The trap: a z-index token is a bare number in a group with no affinity.
    { name: 'z', tokens: [{ name: '--z-modal', value: '100' }] }
  ]
}

eq(
  names(tokensForProp(cssSet, 'color')).join(','),
  '--color-text,--color-title,--color-link',
  'color offers only the color tokens'
)
eq(names(tokensForProp(cssSet, 'padding-top')).join(','), '--space-md', 'padding offers lengths')
ok(
  !names(tokensForProp(cssSet, 'padding-top')).includes('--z-modal'),
  'a bare number is never offered for a length property'
)
ok(
  !names(tokensForProp(cssSet, 'color')).includes('--space-md'),
  'a length is never offered for a color property'
)
// font-weight accepts numbers, but only ones in the real weight domain. `100`
// IS a legal weight, so a z-index token of 100 is genuinely indistinguishable
// by value — it's offered, but ranked neutral rather than preferred, so it sits
// below any real weight scale instead of being hidden.
eq(names(tokensForProp(cssSet, 'font-weight')).join(','), '--z-modal', '100 is a legal weight')
eq(tokensForProp(cssSet, 'font-weight')[0].rank, 'neutral', '…but ranked neutral, not preferred')
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'z', tokens: [{ name: '--z-drop', value: '250' }] }] },
      'font-weight'
    )
  ).length,
  0,
  '250 is not a step-100 weight → excluded'
)
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'a', tokens: [{ name: '--o', value: '1.5' }] }] },
      'opacity'
    )
  ).length,
  0,
  'opacity rejects a number outside 0–1'
)
eq(
  names(
    tokensForProp(
      { source: 'css', groups: [{ name: 'a', tokens: [{ name: '--z', value: '100' }] }] },
      'line-height'
    )
  ).length,
  0,
  'line-height rejects an out-of-range unitless number'
)
eq(tokensForProp(cssSet, 'transition-duration').length, 0, 'transition props take no tokens')
eq(tokensForProp(null, 'color').length, 0, 'no token set → nothing offered')
eq(tokensForProp({ source: 'none', groups: [] }, 'color').length, 0, 'source none → nothing')

// Ranking: a matching-affinity group comes before a neutral one, and a
// contradicting one comes last — but all of them are still offered.
const mixed = {
  source: 'manifest',
  groups: [
    { name: 'fontWeight', tokens: [{ name: 'w', value: '12px' }] }, // contradicts → other
    { name: 'brand', tokens: [{ name: 'b', value: '14px' }] }, // no affinity → neutral
    { name: 'fontSize', tokens: [{ name: 'f', value: '16px' }] } // agrees → preferred
  ]
}
eq(
  names(tokensForProp(mixed, 'font-size')).join(','),
  'f,b,w',
  'preferred → neutral → other, all offered'
)
// line-height accepts BOTH lengths and unitless numbers, so a spacing group is
// a legitimate preferred source for it — not a contradiction.
eq(
  tokensForProp(
    { source: 'manifest', groups: [{ name: 'spacing', tokens: [{ name: 's', value: '24px' }] }] },
    'line-height'
  )[0].rank,
  'preferred',
  'a length group is preferred for line-height, which accepts lengths'
)

// --- tokenReference ---------------------------------------------------------

eq(
  tokenReference('css', { name: '--color-text', value: '#6c6c6c' }),
  'var(--color-text)',
  'a css var becomes a var() reference'
)
eq(
  tokenReference('css', { name: 'color-text', value: '#6c6c6c' }),
  'var(--color-text)',
  'a dash-less css name is normalized'
)
eq(
  tokenReference('css', { name: '--alias', value: 'var(--other)' }),
  'var(--other)',
  'an aliased value passes through'
)
eq(
  tokenReference('tailwind', { name: 'brand-500', value: '#3b82f6' }),
  '#3b82f6',
  'a tailwind token has no var() form — its value is the inline reference'
)
eq(
  tokenReference('manifest', { name: 'primary', value: '#2563eb' }),
  '#2563eb',
  'a manifest token writes its value'
)

// --- customPropertyNames ----------------------------------------------------

eq(
  customPropertyNames(cssSet).join(','),
  '--color-text,--color-title,--color-link,--space-md,--z-modal',
  'every -- name, in detection order'
)
eq(customPropertyNames({ source: 'tailwind', groups: cssSet.groups }).length, 0, 'tailwind → none')

// --- resolveTokenForValue ---------------------------------------------------

const equals = (prop) => (a, b) => sameCssValue(prop, a, b)
const colorCands = tokensForProp(cssSet, 'color')

// The comparator normalizes notation: the file says #6c6c6c, the browser
// reports rgb(108, 108, 108).
eq(
  resolveTokenForValue(colorCands, 'rgb(108, 108, 108)', { equals: equals('color') })?.match.token
    .name,
  '--color-text',
  'a computed rgb() matches a hex token'
)
eq(resolveTokenForValue(colorCands, '#123456', { equals: equals('color') }), null, 'no match → null')
eq(resolveTokenForValue(colorCands, '', { equals: equals('color') }), null, 'empty value → null')

// The LIVE resolved custom property wins over the value in the token file —
// this is what makes the panel right under a dark-mode override.
eq(
  resolveTokenForValue(colorCands, '#c1c1c1', {
    resolved: { '--color-text': '#c1c1c1' },
    equals: equals('color')
  })?.match.token.name,
  '--color-text',
  'the live var value decides, not the recorded one'
)
eq(
  resolveTokenForValue(colorCands, '#6c6c6c', {
    resolved: { '--color-text': '#c1c1c1' },
    equals: equals('color')
  }),
  null,
  'the recorded value is NOT a fallback once the var resolved to something else'
)

// Ties: --color-title and --color-link are both #212121.
const tie = resolveTokenForValue(colorCands, '#212121', { equals: equals('color') })
eq(tie?.match.token.name, '--color-title', 'a tie resolves to detection order by default')
eq(names(tie?.ties ?? []).join(','), '--color-link', 'the equal-valued sibling is reported')
eq(
  resolveTokenForValue(colorCands, '#212121', {
    classes: ['text-color-link', 'p-4'],
    equals: equals('color')
  })?.match.token.name,
  '--color-link',
  'a class naming one of the tied tokens breaks the tie'
)
eq(
  resolveTokenForValue(colorCands, '#212121', {
    sticky: '--color-link',
    equals: equals('color')
  })?.match.token.name,
  '--color-link',
  'the sticky previous pick breaks the tie, so the label does not flip'
)

if (failed === 0) {
  console.log('TOKEN-MATCH OK — value kinds, affinity, per-prop gate, references, resolution')
} else {
  console.error(`TOKEN-MATCH: ${failed} assertion(s) failed`)
}
process.exitCode = failed === 0 ? 0 : 1
