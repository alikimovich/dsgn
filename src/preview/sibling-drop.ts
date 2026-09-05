/** Geometry only: choose a sibling edge, never a descendant or new parent. */
export interface SiblingBox {
  left: number
  top: number
  width: number
  height: number
}
export interface SiblingSlot {
  index: number
  position: 'before' | 'after'
  x: number
  y: number
  length: number
  vertical: boolean
  distance: number
}

export function siblingSlot(
  boxes: SiblingBox[],
  dragged: number,
  x: number,
  y: number,
  horizontal: boolean,
  reverse: boolean,
  previous: SiblingSlot | null = null
): SiblingSlot | null {
  const slots: SiblingSlot[] = []
  for (const [index, b] of boxes.entries()) {
    if (index === dragged || b.width <= 0 || b.height <= 0) continue
    for (const position of ['before', 'after'] as const) {
      const end = (position === 'after') !== reverse
      const sx = b.left + (horizontal && end ? b.width : 0)
      const sy = b.top + (!horizontal && end ? b.height : 0)
      const length = horizontal ? b.height : b.width
      const dx = horizontal ? x - sx : Math.max(sx - x, 0, x - sx - length)
      const dy = horizontal ? Math.max(sy - y, 0, y - sy - length) : y - sy
      slots.push({
        index,
        position,
        x: sx,
        y: sy,
        length,
        vertical: horizontal,
        distance: Math.hypot(dx, dy)
      })
    }
  }
  slots.sort((a, b) => a.distance - b.distance)
  const best = slots[0] ?? null
  const old =
    previous && slots.find((s) => s.index === previous.index && s.position === previous.position)
  const chosen = best && old && old.distance <= best.distance + 6 ? old : best
  if (
    chosen &&
    ((chosen.position === 'before' && chosen.index === dragged + 1) ||
      (chosen.position === 'after' && chosen.index === dragged - 1))
  )
    return null
  return chosen
}
