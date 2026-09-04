/**
 * Unit test for the Alt/Option spacing measurement geometry (no DOM needed).
 * Run via bun so the .ts import transpiles: bun run test:measure-distance
 */
import assert from 'node:assert'
import { formatDistance, measureRects } from '../src/preview/measure.ts'

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height
})

/** Segments keyed by axis + rounded distance, for order-independent asserts. */
const bag = (m) => m.segments.map((s) => `${s.axis}:${Math.round(s.distance)}`).sort()

// --- Side by side, vertically overlapping: one horizontal gap ---------------
{
  const a = rect(0, 0, 100, 100)
  const b = rect(140, 20, 60, 60)
  const m = measureRects(a, b)
  assert.deepStrictEqual(bag(m), ['x:40'], 'gap between the facing edges only')
  assert.strictEqual(m.guides.length, 0, 'no guide needed — they share height')
  const [s] = m.segments
  assert.strictEqual(s.x1, 100, 'starts at the anchor right edge')
  assert.strictEqual(s.x2, 140, 'ends at the target left edge')
  assert.strictEqual(s.y1, 50, 'drawn through the middle of the shared height')
  assert.strictEqual(s.y1, s.y2, 'horizontal span')
}

// Mirrored: the target sits to the LEFT of the anchor.
{
  const m = measureRects(rect(140, 20, 60, 60), rect(0, 0, 100, 100))
  assert.deepStrictEqual(bag(m), ['x:40'], 'same gap measured from the other side')
  assert.strictEqual(m.segments[0].x1, 100, 'starts at the target right edge')
  assert.strictEqual(m.segments[0].x2, 140, 'ends at the anchor left edge')
}

// --- Stacked, horizontally overlapping: one vertical gap --------------------
{
  const m = measureRects(rect(0, 0, 100, 50), rect(20, 90, 60, 40))
  assert.deepStrictEqual(bag(m), ['y:40'], 'vertical gap')
  const [s] = m.segments
  assert.strictEqual(s.y1, 50, 'starts at the anchor bottom')
  assert.strictEqual(s.y2, 90, 'ends at the target top')
  assert.strictEqual(s.x1, s.x2, 'vertical span')
  assert.strictEqual(s.x1, 50, 'drawn through the middle of the shared width')
}

// --- Diagonal: both gaps, each with a dashed guide to reach the target ------
{
  const a = rect(0, 0, 100, 100) // centre 50,50
  const b = rect(200, 300, 100, 100)
  const m = measureRects(a, b)
  assert.deepStrictEqual(bag(m), ['x:100', 'y:200'], 'one gap per axis')
  assert.strictEqual(m.guides.length, 2, 'each measured span needs an extended edge')
  const horizontal = m.segments.find((s) => s.axis === 'x')
  assert.strictEqual(horizontal.y1, 50, 'horizontal span rides the anchor mid-height')
  const vGuide = m.guides.find((g) => g.x1 === g.x2)
  assert.strictEqual(vGuide.x1, 200, "extends the target's left edge")
  assert.strictEqual(vGuide.y1, 300, 'from the nearest corner of the target')
  assert.strictEqual(vGuide.y2, 50, 'out to the measurement line')
  const hGuide = m.guides.find((g) => g.y1 === g.y2)
  assert.strictEqual(hGuide.y1, 300, "extends the target's top edge")
  assert.strictEqual(hGuide.x2, 50, 'out to the vertical measurement line')
}

// --- Containment: the four inset distances ---------------------------------
{
  const outer = rect(0, 0, 200, 100)
  const inner = rect(30, 20, 100, 60) // insets: 30 left, 70 right, 20 top, 20 bottom
  const m = measureRects(inner, outer)
  assert.deepStrictEqual(bag(m), ['x:30', 'x:70', 'y:20', 'y:20'], 'four insets')
  assert.strictEqual(m.guides.length, 0, 'nothing to extend inside a box')
  // Horizontal insets are drawn across the inner box's mid-height, vertical
  // ones down its mid-width.
  for (const s of m.segments) {
    if (s.axis === 'x') assert.strictEqual(s.y1, 50, 'inset drawn at the inner mid-height')
    else assert.strictEqual(s.x1, 80, 'inset drawn at the inner mid-width')
  }
  // Measuring the other way round gives the same numbers.
  assert.deepStrictEqual(bag(measureRects(outer, inner)), bag(m), 'symmetric')
}

// --- Flush / identical edges produce no label ------------------------------
{
  const same = rect(10, 10, 50, 50)
  assert.deepStrictEqual(measureRects(same, same).segments, [], 'identical rects: nothing')
  // Touching edges are a zero gap — not worth a label either.
  assert.deepStrictEqual(
    measureRects(rect(0, 0, 100, 100), rect(100, 0, 50, 100)).segments,
    [],
    'adjacent rects: no zero-width span'
  )
  // Sub-pixel offsets are layout noise, not spacing.
  assert.deepStrictEqual(
    measureRects(rect(0, 0, 100, 100), rect(100.3, 0, 50, 100)).segments,
    [],
    'sub-pixel gap ignored'
  )
}

// --- Partial overlap: matched-edge deltas, not a gap ------------------------
{
  const m = measureRects(rect(0, 0, 100, 100), rect(60, 40, 100, 100))
  assert.deepStrictEqual(bag(m), ['x:60', 'x:60', 'y:40', 'y:40'], 'edge-to-edge deltas')
}

// --- formatDistance ---------------------------------------------------------
assert.strictEqual(formatDistance(40), '40', 'whole numbers stay whole')
assert.strictEqual(formatDistance(12.34), '12.3', 'one decimal')
assert.strictEqual(formatDistance(12.04), '12', 'no trailing .0')

console.log('measure-distance: OK')
