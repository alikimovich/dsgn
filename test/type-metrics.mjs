/**
 * Unit test for the type-metrics engine (src/main/type-metrics.ts) — pure
 * line-height / letter-spacing recommenders. No Electron; runs under bun so the
 * .ts import transpiles:
 * bun test/type-metrics.mjs
 */
import assert from 'node:assert'
import { letterSpacing, lineHeight, typeMetrics } from '../src/main/type-metrics.ts'

// WCAG 2.1 SC 1.4.12: body text (12–20px) must never fall below 1.5x leading.
for (const fontSizePx of [12, 14, 16, 18, 20]) {
  const r = lineHeight({ fontSizePx })
  assert.ok(r.lineHeight >= 1.5, `body ${fontSizePx}px floors at >= 1.5 (got ${r.lineHeight})`)
}

// Inverse to size: larger type → tighter leading.
assert.ok(lineHeight({ fontSizePx: 32 }).lineHeight < 1.35, '32px leading < 1.35')
assert.ok(lineHeight({ fontSizePx: 48 }).lineHeight < 1.25, '48px leading < 1.25')
assert.ok(lineHeight({ fontSizePx: 64 }).lineHeight < 1.15, '64px leading < 1.15')

// Non-increasing across the whole range, and strictly decreasing once past the
// body-floor region (24 → 32 → 48 → 64 → 96).
{
  const sizes = [16, 24, 32, 48, 64, 96]
  const lhs = sizes.map((s) => lineHeight({ fontSizePx: s }).lineHeight)
  for (let i = 1; i < lhs.length; i++) {
    assert.ok(lhs[i] <= lhs[i - 1], `line-height non-increasing at ${sizes[i]}px`)
  }
  const strict = [24, 32, 48, 64, 96].map((s) => lineHeight({ fontSizePx: s }).lineHeight)
  for (let i = 1; i < strict.length; i++) {
    assert.ok(strict[i] < strict[i - 1], `line-height strictly decreasing past body floor`)
  }
}

// Anchor sanity against the M3/Apple/Tailwind fit.
assert.ok(Math.abs(lineHeight({ fontSizePx: 16 }).lineHeight - 1.5) <= 0.02, '16px ≈ 1.5')
assert.ok(Math.abs(lineHeight({ fontSizePx: 64 }).lineHeight - 1.1) <= 0.03, '64px ≈ 1.10')

// Measure-aware: a longer line (90ch) gets more leading than a short one (45ch)
// at the same size, and the difference stays within ±0.04.
{
  const wide = lineHeight({ fontSizePx: 16, measureCh: 90 }).lineHeight
  const narrow = lineHeight({ fontSizePx: 16, measureCh: 45 }).lineHeight
  assert.ok(wide > narrow, `90ch (${wide}) gets more leading than 45ch (${narrow})`)
  assert.ok(wide - narrow <= 0.04, `measure delta within ±0.04 (got ${wide - narrow})`)
}

// An explicit role overrides the inferred one — and its floor. A 40px size infers
// 'heading'; forcing 'display' reports 'display'. The display floor is 1.0 (below
// the 1.05 heading floor), so at a large size where the raw ratio dips under 1.05
// a display role lets it through while a heading role clamps up.
{
  const d40 = lineHeight({ fontSizePx: 40, role: 'display' })
  assert.strictEqual(d40.role, 'display', '40px with explicit display role reports display')
  const dBig = lineHeight({ fontSizePx: 96, role: 'display' })
  const hBig = lineHeight({ fontSizePx: 96, role: 'heading' })
  assert.ok(
    dBig.lineHeight < 1.05,
    `display role drops below the 1.05 heading floor (${dBig.lineHeight})`
  )
  assert.ok(hBig.lineHeight >= 1.05, `heading role floors at 1.05 (${hBig.lineHeight})`)
}

// Tracking: negative on large display, ~0 on body, positive on small text and
// for all-caps; every css value ends in "em" or is exactly "0".
{
  const big = letterSpacing(72)
  const body = letterSpacing(16)
  const small = letterSpacing(10)
  const caps = letterSpacing(16, { allCaps: true })
  assert.ok(big.em < 0, `72px tracking negative (got ${big.em})`)
  assert.strictEqual(body.em, 0, '16px tracking is exactly 0')
  assert.strictEqual(body.css, '0', '16px tracking css is "0"')
  assert.ok(small.em > 0, `10px tracking positive (got ${small.em})`)
  assert.ok(caps.em > 0, `all-caps tracking positive (got ${caps.em})`)
  for (const r of [big, body, small, caps]) {
    assert.ok(r.css === '0' || r.css.endsWith('em'), `css "${r.css}" ends in em or is "0"`)
  }
}

// typeMetrics pairs the two: its lineHeight/letterSpacingEm match the individual
// recommenders for the same input.
{
  const tm = typeMetrics({ fontSizePx: 18, allCaps: false })
  const lh = lineHeight({ fontSizePx: 18 })
  const ls = letterSpacing(18, { allCaps: false })
  assert.strictEqual(tm.lineHeight, lh.lineHeight, 'typeMetrics lineHeight matches lineHeight()')
  assert.strictEqual(tm.lineHeightPx, lh.lineHeightPx, 'typeMetrics lineHeightPx matches')
  assert.strictEqual(
    tm.letterSpacingEm,
    ls.em,
    'typeMetrics letterSpacingEm matches letterSpacing()'
  )
  assert.strictEqual(tm.role, lh.role, 'typeMetrics role matches')
  assert.strictEqual(tm.floored, lh.floored, 'typeMetrics floored matches')
}

console.log(
  'TYPE-METRICS OK — WCAG body floor, inverse-to-size leading, anchor fit, measure adj, role override, size/all-caps tracking, combined typeMetrics'
)
