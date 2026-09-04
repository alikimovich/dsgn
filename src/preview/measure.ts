/**
 * Spacing measurement geometry — the pure half of the Alt/Option distance
 * overlay (Figma's "select one thing, hold Option, hover another").
 *
 * Given the selected element's rect (the anchor) and the hovered element's rect
 * (the target), decide which distances to draw and where. Two shapes:
 *
 *   • The rects overlap on BOTH axes (one contains the other, or they merely
 *     intersect) — there is no gap to measure, so measure matched EDGES:
 *     left↔left, right↔right, top↔top, bottom↔bottom. For containment that's
 *     exactly the four inset distances Figma shows.
 *   • They're separated on at least one axis — measure the GAP between the
 *     facing edges on that axis. When they don't overlap on the other axis
 *     either (diagonal), the measurement line can't touch the target's edge, so
 *     a dashed `guide` extends that edge out to meet it.
 *
 * Coordinates are viewport-relative (`getBoundingClientRect`), which is what the
 * fixed-position overlay in preload.ts draws in. No DOM here — it's unit tested
 * by test/measure-distance.mjs.
 */

export type MeasureRect = { left: number; top: number; right: number; bottom: number }

/** A straight line in viewport coordinates. Always axis-aligned here. */
export type MeasureLine = { x1: number; y1: number; x2: number; y2: number }

/** A measured span: the line plus the number to render on it. */
export type MeasureSegment = MeasureLine & { distance: number; axis: 'x' | 'y' }

export type Measurement = { segments: MeasureSegment[]; guides: MeasureLine[] }

/** Sub-pixel spans are layout noise, not a gap worth a label. */
const MIN_DISTANCE = 0.5

/** Do the two 1-D spans share any length at all? Touching (0) doesn't count. */
function spansOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a2, b2) - Math.max(a1, b1) > 0
}

/** Midpoint of the shared length of two 1-D spans (callers only use it when
 *  they overlap, so the intersection is non-empty). */
function overlapCenter(a1: number, a2: number, b1: number, b2: number): number {
  return (Math.max(a1, b1) + Math.min(a2, b2)) / 2
}

function segment(axis: 'x' | 'y', from: number, to: number, cross: number): MeasureSegment | null {
  const distance = Math.abs(to - from)
  if (distance <= MIN_DISTANCE) return null
  return axis === 'x'
    ? { x1: from, y1: cross, x2: to, y2: cross, distance, axis }
    : { x1: cross, y1: from, x2: cross, y2: to, distance, axis }
}

/**
 * Distances from the anchor rect `a` (the selection) to the target rect `b`
 * (the hovered element). Returns viewport-space lines ready to draw.
 */
export function measureRects(a: MeasureRect, b: MeasureRect): Measurement {
  const segments: MeasureSegment[] = []
  const guides: MeasureLine[] = []
  const overlapX = spansOverlap(a.left, a.right, b.left, b.right)
  const overlapY = spansOverlap(a.top, a.bottom, b.top, b.bottom)

  if (overlapX && overlapY) {
    // Nested / intersecting: matched-edge deltas, each drawn across the middle
    // of the shared extent on the other axis.
    const y = overlapCenter(a.top, a.bottom, b.top, b.bottom)
    const x = overlapCenter(a.left, a.right, b.left, b.right)
    for (const s of [
      segment('x', a.left, b.left, y),
      segment('x', a.right, b.right, y),
      segment('y', a.top, b.top, x),
      segment('y', a.bottom, b.bottom, x)
    ]) {
      if (s) segments.push(s)
    }
    return { segments, guides }
  }

  if (!overlapX) {
    const before = a.right <= b.left // the anchor sits to the left of the target
    const from = before ? a.right : b.right
    const to = before ? b.left : a.left
    // Down the middle of the shared height when there is one; otherwise across
    // the anchor's own middle, with the target's facing edge extended to reach it.
    const y = overlapY ? overlapCenter(a.top, a.bottom, b.top, b.bottom) : (a.top + a.bottom) / 2
    const s = segment('x', from, to, y)
    if (s) {
      segments.push(s)
      if (!overlapY) {
        const edgeX = before ? b.left : b.right
        guides.push({ x1: edgeX, y1: y < b.top ? b.top : b.bottom, x2: edgeX, y2: y })
      }
    }
  }

  if (!overlapY) {
    const above = a.bottom <= b.top // the anchor sits above the target
    const from = above ? a.bottom : b.bottom
    const to = above ? b.top : a.top
    const x = overlapX ? overlapCenter(a.left, a.right, b.left, b.right) : (a.left + a.right) / 2
    const s = segment('y', from, to, x)
    if (s) {
      segments.push(s)
      if (!overlapX) {
        const edgeY = above ? b.top : b.bottom
        guides.push({ x1: x < b.left ? b.left : b.right, y1: edgeY, x2: x, y2: edgeY })
      }
    }
  }

  return { segments, guides }
}

/** Label text for a distance — one decimal at most, no trailing `.0`. */
export function formatDistance(px: number): string {
  return String(Math.round(px * 10) / 10)
}
