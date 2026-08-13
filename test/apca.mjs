/**
 * Unit test for the APCA contrast engine (src/main/apca.ts) — the pure logic
 * behind the `check_contrast` agent tool. No Electron; runs under bun so the .ts
 * import (and its dynamic import of apca-w3/colorparsley) resolves:
 *   bun test/apca.mjs
 */
import assert from 'node:assert'
import { checkContrast, hslToRgb, rgbToHex, rgbToHsl, suggestAccessible } from '../src/main/apca.ts'

// --- checkContrast: verdicts + APCA polarity --------------------------------

// Max contrast passes at body defaults; Lc magnitude is large.
{
  const r = await checkContrast({ foreground: '#000', background: '#fff' })
  assert.strictEqual(r.verdict, 'pass', 'black on white passes')
  assert.ok(Math.abs(r.lc) > 100, 'Lc magnitude large')
  assert.strictEqual(r.fontSizePx, 16, 'default font size')
  assert.strictEqual(r.fontWeight, 400, 'default weight')
}

// Signed polarity: dark-on-light positive, light-on-dark negative.
assert.ok(
  (await checkContrast({ foreground: '#000', background: '#fff' })).lc > 0,
  'dark-on-light +Lc'
)
assert.ok(
  (await checkContrast({ foreground: '#fff', background: '#000' })).lc < 0,
  'light-on-dark -Lc'
)

// Same color → prohibited (Lc ≈ 0).
{
  const r = await checkContrast({ foreground: '#fff', background: '#fff' })
  assert.strictEqual(r.verdict, 'prohibited', 'white on white prohibited')
}

// Low contrast fails at body size but passes when large enough.
assert.strictEqual(
  (await checkContrast({ foreground: '#888', background: '#fff' })).verdict,
  'fail',
  '#888 fails at 16/400'
)
assert.strictEqual(
  (await checkContrast({ foreground: '#888', background: '#fff', fontSizePx: 48, fontWeight: 700 }))
    .verdict,
  'pass',
  '#888 passes when large/bold'
)

// The classic "looks fine, fails APCA" case: #767676 on #fff at 16px/400.
{
  const r = await checkContrast({ foreground: '#767676', background: '#fff' })
  assert.strictEqual(r.verdict, 'fail', '#767676 fails APCA at 16/400')
  assert.ok(r.minFontSizePx > 16, 'needs bigger text')
}

// Named + rgb() colors parse.
assert.strictEqual(
  (await checkContrast({ foreground: 'black', background: 'white' })).verdict,
  'pass',
  'named colors'
)
assert.strictEqual(
  (await checkContrast({ foreground: 'rgb(0,0,0)', background: 'rgb(255,255,255)' })).verdict,
  'pass',
  'rgb() colors'
)

// Weight snaps to nearest 100.
assert.strictEqual(
  (await checkContrast({ foreground: '#000', background: '#fff', fontWeight: 450 })).fontWeight,
  500,
  'weight snaps'
)

// WCAG 2 add-on: #767676 on #fff is the canonical ~4.5:1.
{
  const r = await checkContrast({ foreground: '#767676', background: '#fff', wcag2: true })
  assert.ok(r.wcag2, 'wcag2 present when requested')
  assert.ok(Math.abs(r.wcag2.ratioRounded - 4.5) < 0.2, `~4.5:1 (got ${r.wcag2.ratioRounded})`)
  assert.strictEqual(r.wcag2.AA, 'pass', 'passes WCAG2 AA (normal)')
}

// --- suggestAccessible: nearest passing color, hue preserved ----------------

{
  // A muted blue-gray text on white fails; suggestion should pass and keep hue.
  const fg = '#8aa0c0'
  const bg = '#ffffff'
  const before = await checkContrast({ foreground: fg, background: bg })
  assert.notStrictEqual(before.verdict, 'pass', 'starting pair fails (precondition)')

  const s = await suggestAccessible(fg, bg, 'foreground')
  assert.strictEqual(s.role, 'foreground')
  assert.match(s.hex, /^#[0-9a-f]{6}$/, 'suggestion is a hex color')
  assert.strictEqual(s.bestEffort, false, 'a hue-preserving pass exists on white')
  assert.strictEqual(s.verdict, 'pass', 'suggested color passes')

  // Re-check the suggested color end-to-end — it really passes.
  const after = await checkContrast({ foreground: s.hex, background: bg })
  assert.strictEqual(after.verdict, 'pass', 'suggested fg verified against bg')

  // Hue is preserved (within rounding) — only lightness moved.
  const [h0] = rgbToHsl(hexToRgb(fg))
  const [h1] = rgbToHsl(hexToRgb(s.hex))
  assert.ok(hueClose(h0, h1, 4), `hue preserved (${h0.toFixed(0)} vs ${h1.toFixed(0)})`)
}

// Adjusting the background instead is honored: dark text on a mid-gray fails,
// but lightening the background (nearest passing lightness) fixes it.
{
  const fg = '#333333'
  const bg = '#7a7a7a'
  assert.notStrictEqual(
    (await checkContrast({ foreground: fg, background: bg })).verdict,
    'pass',
    'precondition fails'
  )
  // adjust = the background, fixed = the foreground.
  const s = await suggestAccessible(bg, fg, 'background')
  assert.strictEqual(s.role, 'background')
  assert.strictEqual(s.bestEffort, false, 'a passing background lightness exists')
  const after = await checkContrast({ foreground: fg, background: s.hex })
  assert.strictEqual(after.verdict, 'pass', 'adjusted background makes it pass')
}

// --- color-space helpers round-trip -----------------------------------------

for (const hex of ['#8aa0c0', '#ff0000', '#123456', '#00ff88']) {
  const rgb = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(rgb)
  const back = hslToRgb(h, s, l)
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(back[i] - rgb[i]) <= 1, `${hex} channel ${i} round-trips`)
  assert.strictEqual(rgbToHex(rgb), hex, `${hex} hex round-trips`)
}

// Invalid color throws a clear error.
await assert.rejects(
  () => suggestAccessible('not-a-color', '#fff', 'foreground'),
  /Could not parse color/,
  'bad color rejected'
)

console.log(
  'APCA OK — verdicts, polarity, wcag2, hue-preserving suggestions (verified), color round-trips'
)

// --- helpers ---------------------------------------------------------------

function hexToRgb(hex) {
  const n = hex.replace('#', '')
  const full =
    n.length === 3
      ? n
          .split('')
          .map((c) => c + c)
          .join('')
      : n
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ]
}

function hueClose(a, b, tol) {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d) <= tol
}
