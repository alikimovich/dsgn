/**
 * Unit test for the fluid clamp() engine (src/main/fluid.ts) — pure Utopia-style
 * fluid-sizing math. No Electron; runs under bun so the .ts import transpiles:
 * bun test/fluid.mjs
 */
import assert from 'node:assert'
import { fluidClamp, fluidScale, modularScale } from '../src/main/fluid.ts'

// Tiny CSS clamp() evaluator: recompute size from the intercept/slope the engine
// reports and clamp between the two rem bounds, in px — an independent check
// that the *emitted* numbers (not the engine's internal floats) hit the endpoints.
function evalClamp(result, viewportPx, rootPx = 16) {
  const lowerPx = Math.min(result.minRem, result.maxRem) * rootPx
  const upperPx = Math.max(result.minRem, result.maxRem) * rootPx
  const preferredPx = result.interceptRem * rootPx + (result.slopeVw / 100) * viewportPx
  return Math.min(Math.max(preferredPx, lowerPx), upperPx)
}

// Canonical example: 32px -> 64px across the default viewport range.
{
  const r = fluidClamp({ minPx: 32, maxPx: 64, minViewportPx: 320, maxViewportPx: 1280 })
  assert.ok(r.css.includes('clamp('), 'canonical css has clamp(')
  assert.ok(r.css.includes('2rem'), 'canonical css has 2rem lower bound')
  assert.ok(r.css.includes('4rem'), 'canonical css has 4rem upper bound')
  assert.ok(Math.abs(r.checkAtMinPx - 32) <= 0.5, 'canonical checkAtMinPx ~= 32')
  assert.ok(Math.abs(r.checkAtMaxPx - 64) <= 0.5, 'canonical checkAtMaxPx ~= 64')
  assert.strictEqual(r.isStatic, false, 'canonical is not static')
}

// Core property across several configs, including a shrink-on-grow pair (minPx >
// maxPx): the emitted numbers, independently evaluated, hit both endpoints.
{
  const configs = [
    { minPx: 32, maxPx: 64, minViewportPx: 320, maxViewportPx: 1280 }, // grows
    { minPx: 18, maxPx: 21, minViewportPx: 375, maxViewportPx: 1440 }, // grows, tight
    { minPx: 48, maxPx: 24, minViewportPx: 320, maxViewportPx: 1280 }, // shrink-on-grow
    { minPx: 12.5, maxPx: 96.25, minViewportPx: 400, maxViewportPx: 2000, rootPx: 16 },
    { minPx: 20, maxPx: 20.001, minViewportPx: 320, maxViewportPx: 1280 } // near-static, tiny slope
  ]

  for (const cfg of configs) {
    const r = fluidClamp(cfg)
    const atMin = evalClamp(r, cfg.minViewportPx, cfg.rootPx ?? 16)
    const atMax = evalClamp(r, cfg.maxViewportPx, cfg.rootPx ?? 16)
    assert.ok(
      Math.abs(atMin - cfg.minPx) <= 0.5,
      `config ${JSON.stringify(cfg)} hits minPx at minViewportPx (got ${atMin})`
    )
    assert.ok(
      Math.abs(atMax - cfg.maxPx) <= 0.5,
      `config ${JSON.stringify(cfg)} hits maxPx at maxViewportPx (got ${atMax})`
    )
    // the engine's own reported checkAtMin/MaxPx should agree too
    assert.ok(Math.abs(r.checkAtMinPx - cfg.minPx) <= 0.5, 'reported checkAtMinPx within tolerance')
    assert.ok(Math.abs(r.checkAtMaxPx - cfg.maxPx) <= 0.5, 'reported checkAtMaxPx within tolerance')
  }

  // explicitly confirm bound ordering for the shrink-on-grow pair: lower bound
  // in the css must be the numerically smaller rem (24px -> 1.5rem), not minPx's rem.
  const shrink = fluidClamp({ minPx: 48, maxPx: 24, minViewportPx: 320, maxViewportPx: 1280 })
  assert.ok(shrink.css.includes('1.5rem'), 'shrink-on-grow lower bound is the smaller rem value')
  assert.ok(shrink.css.includes('3rem'), 'shrink-on-grow upper bound is the larger rem value')
  assert.ok(shrink.slopeVw < 0, 'shrink-on-grow has a negative vw slope')
}

// minPx === maxPx -> static, plain rem, no clamp/vw.
{
  const r = fluidClamp({ minPx: 24, maxPx: 24 })
  assert.strictEqual(r.isStatic, true, 'equal min/max is static')
  assert.ok(r.css.endsWith('rem'), 'static css ends with rem')
  assert.ok(!r.css.includes('vw'), 'static css has no vw')
  assert.ok(!r.css.includes('clamp('), 'static css has no clamp(')
  assert.strictEqual(r.checkAtMinPx, 24)
  assert.strictEqual(r.checkAtMaxPx, 24)
}

// minViewportPx === maxViewportPx -> throws (divide by zero slope).
assert.throws(
  () => fluidClamp({ minPx: 16, maxPx: 32, minViewportPx: 768, maxViewportPx: 768 }),
  'equal viewport widths throws'
)

// warning fires when minPx is below the root font size, not otherwise.
{
  const small = fluidClamp({ minPx: 12, maxPx: 40, rootPx: 16 })
  assert.ok(typeof small.warning === 'string' && small.warning.length > 0, 'sub-root minPx warns')
  const big = fluidClamp({ minPx: 32, maxPx: 64, rootPx: 16 })
  assert.strictEqual(big.warning, undefined, 'above-root minPx does not warn')
}

// fluidScale: step 0 equals base, length matches range, and every step's own css
// hits its own min/max endpoints.
{
  const stepsUp = 5
  const stepsDown = 2
  const scale = fluidScale({ baseMinPx: 18, baseMaxPx: 20, stepsUp, stepsDown })
  assert.strictEqual(scale.length, stepsUp + stepsDown + 1, 'scale has stepsUp+stepsDown+1 entries')

  const base = scale.find((s) => s.step === 0)
  assert.ok(base, 'has a step 0')
  assert.ok(Math.abs(base.minPx - 18) < 1e-9, 'step 0 minPx equals baseMinPx')
  assert.ok(Math.abs(base.maxPx - 20) < 1e-9, 'step 0 maxPx equals baseMaxPx')

  for (const s of scale) {
    const r = fluidClamp({ minPx: s.minPx, maxPx: s.maxPx })
    assert.ok(Math.abs(r.checkAtMinPx - s.minPx) <= 0.5, `scale step ${s.step} hits its minPx`)
    assert.ok(Math.abs(r.checkAtMaxPx - s.maxPx) <= 0.5, `scale step ${s.step} hits its maxPx`)
  }
}

// modularScale: plain geometric progression, basePx * ratio**step.
{
  const basePx = 16
  const ratio = 1.25
  const stepsUp = 4
  const stepsDown = 3
  const scale = modularScale(basePx, ratio, stepsUp, stepsDown)
  assert.strictEqual(
    scale.length,
    stepsUp + stepsDown + 1,
    'modularScale has stepsUp+stepsDown+1 entries'
  )
  for (const s of scale) {
    const expected = basePx * ratio ** s.step
    assert.ok(Math.abs(s.px - expected) < 1e-9, `step ${s.step} matches basePx*ratio**step`)
  }
  const zero = scale.find((s) => s.step === 0)
  assert.ok(Math.abs(zero.px - basePx) < 1e-9, 'step 0 equals basePx')
}

console.log(
  'FLUID OK — canonical clamp, endpoint property (incl. shrink-on-grow), static, viewport-equal throw, warning, scale, modularScale'
)
