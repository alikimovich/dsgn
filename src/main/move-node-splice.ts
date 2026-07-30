/**
 * The Layers panel's drag-to-reorder SPLICE algorithm — pure, no electron, no
 * fs: everything operates on strings and node objects passed in, so it's
 * bun-unit-testable (test/layers-move.mjs) without a real babel/svelte/parse5
 * parse. `move-node.ts` (React), `move-node-svelte.ts`, and `move-node-html.ts`
 * each import this one implementation rather than re-deriving it against
 * their own AST node shape — those three files can't themselves be
 * unit-tested (they import from `props.ts`, which imports electron), so the
 * one piece of genuinely hard logic lives here where it CAN be.
 */

export interface Span {
  start: number
  end: number
}

/**
 * Reorder `dragged` to sit `before`/`after` `target` within their shared
 * `children` array, rebuilding the parent's ENTIRE content span from the
 * (reordered) list of original child text runs. Rebuilding from scratch rather
 * than incremental substring surgery means every untouched sibling's text is
 * copied byte-for-byte, and only the separator immediately around the moved
 * node is recomputed — no fragile offset arithmetic across two edits.
 *
 * The whitespace-only node immediately before `dragged` travels WITH it
 * (that's what gave it its own line/indentation); the separator used at its
 * new position is borrowed from the gap immediately BEFORE `target` — a
 * guaranteed sibling-to-sibling separator, so same nesting depth ⇒ already
 * the right indentation. The gap immediately after `target` is only a
 * fallback when there's nothing before it (target is the first child):
 * preferring "after" instead would occasionally borrow the boundary gap
 * before the PARENT's closing tag rather than a sibling gap, when target is
 * the last child — a real bug this exact tension caught in testing. Where no
 * separator exists to borrow at all (a single-line, no-whitespace-between-
 * siblings file), none is invented — preserve exactly what surrounds it, add
 * nothing where nothing existed.
 *
 * Returns null when `dragged`/`target` aren't both present in `children`, or
 * are the same node (nothing to do).
 */
export function moveSiblingWithinParent<T extends Span>(
  code: string,
  children: T[],
  dragged: T,
  target: T,
  position: 'before' | 'after',
  isWhitespace: (n: T) => boolean
): string | null {
  const draggedIdx = children.indexOf(dragged)
  const targetIdx = children.indexOf(target)
  if (draggedIdx === -1 || targetIdx === -1 || draggedIdx === targetIdx) return null

  const sepBefore =
    draggedIdx > 0 && isWhitespace(children[draggedIdx - 1]) ? children[draggedIdx - 1] : null
  const removed = new Set([draggedIdx, ...(sepBefore ? [draggedIdx - 1] : [])])
  const remaining = children.filter((_, i) => !removed.has(i))

  const remTargetIdx = remaining.indexOf(target)
  if (remTargetIdx === -1) return null // defensive — shouldn't happen

  const insertAt = position === 'before' ? remTargetIdx : remTargetIdx + 1
  // Always prefer the gap immediately BEFORE target, regardless of `position`:
  // it's guaranteed to be a genuine sibling-to-sibling separator. The gap
  // immediately after target is only a safe fallback when target isn't the
  // LAST child — when it is, that "gap" is actually the boundary before the
  // parent's closing tag (often less-indented, or absent entirely), and
  // borrowing it for a sibling separator would misplace the moved node's
  // indentation rather than match its new neighbors.
  const templateSep =
    remTargetIdx > 0 && isWhitespace(remaining[remTargetIdx - 1])
      ? remaining[remTargetIdx - 1]
      : remTargetIdx + 1 < remaining.length && isWhitespace(remaining[remTargetIdx + 1])
        ? remaining[remTargetIdx + 1]
        : null
  const sepNode = templateSep ?? sepBefore

  const raw = (n: T): string => code.slice(n.start, n.end)
  const sepText = sepNode ? raw(sepNode) : ''
  const before = remaining.slice(0, insertAt).map(raw).join('')
  const after = remaining.slice(insertAt).map(raw).join('')
  const draggedRaw = raw(dragged)
  const injected = position === 'before' ? draggedRaw + sepText : sepText + draggedRaw

  const contentStart = children[0].start
  const contentEnd = children[children.length - 1].end
  return code.slice(0, contentStart) + before + injected + after + code.slice(contentEnd)
}
