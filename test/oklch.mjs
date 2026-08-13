/**
 * Unit test for the OKLCH color engine (src/main/oklch.ts) — the pure color math
 * behind a future scale / gamut-mapping agent tool. No Electron; runs under bun
 * so the .ts import transpiles: bun test/oklch.mjs
 *
 * Reference values are Ottosson's published OKLCH numbers for the sRGB primaries.
 */
import assert from 'node:assert'
import { clampToGamut, hexToOklch, oklchScale, oklchToHex, oklchToRgb } from '../src/main/oklch.ts'

// --- known reference values (Ottosson) --------------------------------------

{
  const white = hexToOklch('#ffffff')
  assert.ok(Math.abs(white.l - 1.0) < 0.01, `white L≈1 (got ${white.l})`)
  assert.ok(white.c < 0.005, `white C≈0 (got ${white.c})`)

  const black = hexToOklch('#000000')
  assert.ok(Math.abs(black.l - 0.0) < 0.01, `black L≈0 (got ${black.l})`)

  const red = hexToOklch('#ff0000')
  assert.ok(Math.abs(red.l - 0.6279) < 0.01, `red L≈0.6279 (got ${red.l})`)
  assert.ok(Math.abs(red.c - 0.2577) < 0.01, `red C≈0.2577 (got ${red.c})`)
  assert.ok(hueClose(red.h, 29.23, 1), `red H≈29.23 (got ${red.h})`)

  const green = hexToOklch('#00ff00')
  assert.ok(hueClose(green.h, 142, 3), `green H≈142 (got ${green.h})`)

  const blue = hexToOklch('#0000ff')
  assert.ok(hueClose(blue.h, 264, 3), `blue H≈264 (got ${blue.h})`)
}

// --- round-trip: hex → OKLCH → gamut-mapped hex is stable -------------------

for (const hex of ['#8aa0c0', '#ff0000', '#123456', '#00ff88', '#ffffff', '#000000']) {
  const back = oklchToHex(hexToOklch(hex))
  const a = hexToRgb(hex)
  const b = hexToRgb(back)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= 1, `${hex} channel ${i} round-trips (got ${back})`)
  }
}

// --- clampToGamut reduces chroma, keeps L and H, lands in gamut --------------

{
  const oog = { l: 0.7, c: 0.4, h: 150 }
  assert.strictEqual(oklchToRgb(oog).inGamut, false, 'precondition: {l:0.7,c:0.4,h:150} is OOG')

  const clamped = clampToGamut(oog)
  assert.ok(clamped.c < 0.4, `chroma reduced (got ${clamped.c})`)
  assert.ok(oklchToRgb(clamped).inGamut, 'clamped color is in gamut')
  assert.strictEqual(clamped.l, oog.l, 'lightness unchanged')
  assert.strictEqual(clamped.h, oog.h, 'hue unchanged')
}

// --- oklchScale: shape, gamut, monotonic lightness, constant hue -------------

{
  const seedHex = '#3b82f6'
  const seedHue = hexToOklch(seedHex).h
  const scale = oklchScale({ seed: seedHex, steps: 12 })

  assert.strictEqual(scale.length, 12, 'scale has 12 steps')

  for (const step of scale) {
    assert.match(step.hex, /^#[0-9a-f]{6}$/, `step ${step.index} hex is #rrggbb`)
    assert.ok(oklchToRgb(step.oklch).inGamut, `step ${step.index} is in gamut after mapping`)
    assert.ok(hueClose(step.oklch.h, seedHue, 2), `step ${step.index} hue within ±2° of seed`)
  }

  for (let i = 1; i < scale.length; i++) {
    assert.ok(
      scale[i].oklch.l < scale[i - 1].oklch.l,
      `lightness strictly decreases at index ${scale[i].index}`
    )
  }
}

console.log(
  'OKLCH OK — Ottosson reference values, hex round-trips, gamut mapping, perceptual scale'
)

// --- helpers ----------------------------------------------------------------

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
