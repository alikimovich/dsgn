/**
 * Unit test for the layered elevation → box-shadow engine
 * (src/main/shadows.ts). No Electron; runs under bun so the .ts import
 * transpiles: bun test/shadows.mjs
 */
import assert from 'node:assert'
import { elevationScale, layeredShadow } from '../src/main/shadows.ts'

// Layer count + css shape: default 5 layers, that many rgba(...) occurrences,
// a valid comma-joined list.
{
  const { layers, css } = layeredShadow({ elevation: 8 })
  assert.strictEqual(layers.length, 5, 'default layer count is 5')
  const rgbaCount = (css.match(/rgba\(/g) || []).length
  assert.strictEqual(rgbaCount, layers.length, 'one rgba() per layer')
  const parts = css.split(', ')
  assert.strictEqual(parts.length, layers.length, 'comma-joined list, one entry per layer')
  for (const part of parts) {
    assert.match(
      part,
      /^-?[\d.]+px -?[\d.]+px -?[\d.]+px rgba\([\d, .]+\)$/,
      `well-formed layer: ${part}`
    )
  }
}

// Custom layer count is honored.
{
  const { layers } = layeredShadow({ elevation: 8, layers: 3 })
  assert.strictEqual(layers.length, 3, 'custom layer count honored')
}

// Higher elevation → strictly larger max blur AND max |yPx| than lower elevation.
{
  const low = layeredShadow({ elevation: 4 })
  const high = layeredShadow({ elevation: 16 })
  const maxBlur = (layers) => Math.max(...layers.map((l) => l.blurPx))
  const maxAbsY = (layers) => Math.max(...layers.map((l) => Math.abs(l.yPx)))
  assert.ok(maxBlur(high.layers) > maxBlur(low.layers), 'higher elevation → larger max blur')
  assert.ok(maxAbsY(high.layers) > maxAbsY(low.layers), 'higher elevation → larger max |yPx|')
}

// All alphas in (0, 1]; alpha is non-increasing from first to last layer.
{
  const { layers } = layeredShadow({ elevation: 12 })
  for (const l of layers) {
    assert.ok(l.alpha > 0 && l.alpha <= 1, `alpha ${l.alpha} in (0,1]`)
  }
  for (let i = 1; i < layers.length; i++) {
    assert.ok(layers[i].alpha <= layers[i - 1].alpha, 'alpha non-increasing across layers')
  }
}

// Light angle: default 180 (top) → near-zero x, positive y on every layer.
{
  const { layers } = layeredShadow({ elevation: 12 })
  for (const l of layers) {
    assert.ok(Math.abs(l.xPx) < 1e-6, `default angle: x≈0 (got ${l.xPx})`)
    assert.ok(l.yPx > 0, `default angle: y>0 (got ${l.yPx})`)
  }
}

// Changing lightAngleDeg by 90 changes which axis dominates: x becomes significant.
{
  const { layers } = layeredShadow({ elevation: 12, lightAngleDeg: 90 })
  const maxAbsX = Math.max(...layers.map((l) => Math.abs(l.xPx)))
  assert.ok(maxAbsX > 1, `rotated angle: x significant (got ${maxAbsX})`)
  for (const l of layers) {
    assert.ok(Math.abs(l.yPx) < 1e-6, `rotated angle: y≈0 (got ${l.yPx})`)
  }
}

// elevation <= 0 → css 'none' (empty layers).
assert.deepStrictEqual(
  layeredShadow({ elevation: 0 }),
  { css: 'none', layers: [] },
  'elevation 0 → none'
)
assert.deepStrictEqual(
  layeredShadow({ elevation: -3 }),
  { css: 'none', layers: [] },
  'negative elevation → none'
)

// elevationScale(): default length 5, monotonically increasing max blur across
// levels, all sharing the same light-angle sign pattern.
{
  const scale = elevationScale()
  assert.strictEqual(scale.length, 5, 'default elevationScale length is 5')

  const maxBlurOf = (css) =>
    Math.max(...[...css.matchAll(/-?[\d.]+px -?[\d.]+px (-?[\d.]+)px/g)].map((m) => Number(m[1])))
  let prevMaxBlur = -Infinity
  for (const { css } of scale) {
    const mb = maxBlurOf(css)
    assert.ok(mb > prevMaxBlur, 'max blur strictly increases level over level')
    prevMaxBlur = mb
  }

  // Same light-angle sign pattern (default → x≈0, y>0) across every level.
  for (const { css } of scale) {
    for (const m of css.matchAll(/(-?[\d.]+)px (-?[\d.]+)px -?[\d.]+px/g)) {
      const [, x, y] = m
      assert.ok(Math.abs(Number(x)) < 1e-6, `scale level: x≈0 (got ${x})`)
      assert.ok(Number(y) > 0, `scale level: y>0 (got ${y})`)
    }
  }

  // Labels default to numeric strings; custom labels are honored.
  assert.strictEqual(scale[0].label, '1', 'default label is numeric')
  const named = elevationScale({ levels: 3, labels: ['sm', 'md', 'lg'] })
  assert.deepStrictEqual(
    named.map((l) => l.label),
    ['sm', 'md', 'lg'],
    'custom labels honored'
  )
}

console.log(
  'SHADOWS OK — layer count/css shape, elevation→blur/offset growth, alpha decay, light angle, zero-elevation, elevationScale'
)
