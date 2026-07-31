/**
 * Generic parent/ancestor lookup over any duck-typed tree of plain nested
 * objects keyed by `.type` — babel's JSX ast, svelte/compiler's ast, and
 * parse5's document tree are all this shape. Shared by the Layers panel's
 * three move engines (React/Svelte/static-HTML) so this walk exists once
 * instead of three times: none of `props.ts`'s `collectNodes`, `props-svelte.ts`'s
 * `collectElements`, or `html-source.ts`'s `walkElements` track parent/children,
 * which a move needs (find the two siblings' shared container, and detect
 * whether either sits inside something that makes reordering unsafe).
 *
 * Both functions are object-identity based: `target` must be the exact node
 * reference reachable from `root`'s own tree (i.e. found via a walk over that
 * SAME parsed tree) — never a structurally-equal node from a different parse.
 */

export interface AstNode {
  type?: string
  [k: string]: unknown
}

const SKIP_KEYS = new Set(['loc', 'leadingComments', 'trailingComments', 'parent'])

/** Visit every direct child value of `n` (array entries and object properties). */
function walkChildren(n: AstNode, visit: (child: unknown) => boolean): boolean {
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue
    const v = n[key]
    if (Array.isArray(v)) {
      for (const c of v) if (visit(c)) return true
    } else if (v && typeof v === 'object') {
      if (visit(v)) return true
    }
  }
  return false
}

/**
 * The ancestor chain from `root` down to (EXCLUDING) `target` — outermost
 * first. Null if `target` isn't reachable from `root`. Used to detect whether
 * a node is rendered from a loop/conditional: the chain contains every
 * enclosing call/block, not just the immediate parent.
 */
export function ancestorChain(root: unknown, target: unknown): AstNode[] | null {
  const stack: AstNode[] = []
  let result: AstNode[] | null = null
  const visit = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return false
    if (n === target) {
      result = [...stack]
      return true
    }
    const node = n as AstNode
    stack.push(node)
    const found = walkChildren(node, visit)
    if (!found) stack.pop()
    return found
  }
  visit(root)
  return result
}

export interface AstContainer {
  parent: AstNode
  children: unknown[]
}

/**
 * The first node (searching down from `root`) whose `childrenOf(node)` array
 * contains `target` by reference, along with that array — i.e. `target`'s
 * immediate container and its ordered sibling list.
 */
export function findContainer(
  root: unknown,
  target: unknown,
  childrenOf: (node: AstNode) => unknown[] | undefined
): AstContainer | null {
  let found: AstContainer | null = null
  const visit = (n: unknown): boolean => {
    if (found || !n || typeof n !== 'object') return false
    const node = n as AstNode
    const children = childrenOf(node)
    if (children?.includes(target)) {
      found = { parent: node, children }
      return true
    }
    return walkChildren(node, visit)
  }
  visit(root)
  return found
}
