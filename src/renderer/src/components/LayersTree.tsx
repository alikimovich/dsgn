import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { LayerNode } from '../../../shared/api'

/** A path serialized for use as a Set/Map key and a React list key. */
export function pathKey(path: number[]): string {
  return path.join('.')
}

/** A short, readable row label: tag + #id + .class(es), mirroring the preview's shortLabel. */
function rowLabel(n: LayerNode): string {
  const id = n.id ? `#${n.id}` : ''
  const cls = n.classes.length ? `.${n.classes.slice(0, 2).join('.')}` : ''
  return `${n.tag}${id}${cls}`
}

type DropPosition = 'before' | 'after' | 'inside'

export interface DropTarget {
  target: LayerNode
  position: DropPosition
}

interface Props {
  nodes: LayerNode[]
  truncated: boolean
  /** The currently selected element's source stamp, if any — used to highlight
   *  matching row(s) (a shared stamp highlights every instance, same as the
   *  preview's own persistent-outline behavior). */
  selectedSource: string | null
  onHoverRow: (node: LayerNode | null) => void
  onSelectRow: (node: LayerNode) => void
  /** A drag completed with a resolved drop target — the panel host applies it. */
  onDrop: (dragged: LayerNode, drop: DropTarget) => void
}

/**
 * Hand-rolled indent-by-depth tree (no dnd library — see the plan's reasoning:
 * @pierre/trees is path-string/file-semantic, and every existing drag
 * interaction in this codebase is already hand-rolled pointer math). Collapse
 * state lives here as a `Set<pathKey>` of COLLAPSED paths (default expanded).
 */
export default function LayersTree({
  nodes,
  truncated,
  selectedSource,
  onHoverRow,
  onSelectRow,
  onDrop
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState<LayerNode | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // A node is visible when none of its ancestors are collapsed. `nodes` is
  // flat pre-order (DOM order is implicit), so a single pass with a running
  // "collapsed ancestor" depth threshold is enough — no tree reconstruction.
  const visible = useMemo(() => {
    const out: LayerNode[] = []
    let hiddenBelowDepth: number | null = null
    for (const n of nodes) {
      if (hiddenBelowDepth !== null) {
        if (n.depth > hiddenBelowDepth) continue
        hiddenBelowDepth = null
      }
      out.push(n)
      if (n.childCount > 0 && collapsed.has(pathKey(n.path))) hiddenBelowDepth = n.depth
    }
    return out
  }, [nodes, collapsed])

  const toggleCollapsed = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Rows whose stamp is duplicated across the snapshot can't become a direct
  // source move (a `.map()`/`{#each}` body) — grey them out as a pre-flight UX
  // hint. This is never the correctness boundary (main re-checks from source),
  // just saves a round trip that would only come back needsAgent.
  const dragDisabled = (n: LayerNode): boolean => !n.source || n.dupStamp

  const beginDrag = (e: React.PointerEvent, node: LayerNode): void => {
    if (e.button !== 0 || dragDisabled(node)) return
    e.preventDefault()
    setDragging(node)

    const onMove = (ev: PointerEvent): void => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const rowEl = el?.closest<HTMLElement>('[data-layer-row]')
      const key = rowEl?.dataset.layerRow
      const overNode = key ? nodes.find((n) => pathKey(n.path) === key) : null
      if (!overNode || overNode === node || !overNode.source) {
        setDropTarget(null)
        return
      }
      const rect = rowEl?.getBoundingClientRect()
      if (!rect) {
        setDropTarget(null)
        return
      }
      const frac = (ev.clientY - rect.top) / rect.height
      // Standard v0/Figma-style row-drop convention: top third = before, middle
      // third = inside (reparent — always needsAgent in v1, still shown so the
      // gesture reads correctly), bottom third = after.
      const position: DropPosition = frac < 1 / 3 ? 'before' : frac > 2 / 3 ? 'after' : 'inside'
      setDropTarget({ target: overNode, position })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(null)
      setDropTarget((dt) => {
        if (dt) onDrop(node, dt)
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="layerstree flex flex-col">
      {visible.map((n) => {
        const key = pathKey(n.path)
        const isCollapsed = collapsed.has(key)
        const isSelected = !!n.source && n.source === selectedSource
        const isDropTarget = dropTarget?.target === n
        const disabled = dragDisabled(n)
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) rowRefs.current.set(key, el)
              else rowRefs.current.delete(key)
            }}
            data-layer-row={key}
            className={cn(
              'layerstree__row flex h-6 items-center gap-1 rounded px-1 text-[12px]',
              isSelected && 'bg-accent',
              isDropTarget && dropTarget?.position === 'inside' && 'ring-1 ring-inset ring-ring',
              dragging === n && 'opacity-40'
            )}
            style={{
              paddingLeft: 4 + n.depth * 14,
              boxShadow:
                isDropTarget && dropTarget?.position === 'before'
                  ? 'inset 0 2px 0 0 var(--ring)'
                  : isDropTarget && dropTarget?.position === 'after'
                    ? 'inset 0 -2px 0 0 var(--ring)'
                    : undefined
            }}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={n.childCount > 0 ? !isCollapsed : undefined}
            tabIndex={0}
            onPointerEnter={() => onHoverRow(n)}
            onPointerLeave={() => onHoverRow(null)}
            onClick={() => onSelectRow(n)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelectRow(n)
              }
            }}
            onPointerDown={(e) => beginDrag(e, n)}
            title={
              disabled
                ? `${rowLabel(n)} — templated (rendered more than once), reorder via chat`
                : rowLabel(n)
            }
          >
            {n.childCount > 0 ? (
              <button
                type="button"
                className="layerstree__toggle flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCollapsed(key)
                }}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3" aria-hidden="true" />
                )}
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span
              className={cn(
                'layerstree__label truncate font-mono',
                disabled ? 'text-muted-foreground/50' : 'text-foreground'
              )}
            >
              {rowLabel(n)}
            </span>
            {n.text && n.childCount === 0 && (
              <span className="layerstree__text truncate text-muted-foreground/70">{n.text}</span>
            )}
          </div>
        )
      })}
      {truncated && (
        <div className="layerstree__truncated px-2 py-1 text-[11px] text-muted-foreground">
          Showing a partial tree — this page has more elements than fit here.
        </div>
      )}
      {visible.length === 0 && (
        <div className="layerstree__empty px-2 py-3 text-[11.5px] text-muted-foreground">
          No elements to show yet.
        </div>
      )}
    </div>
  )
}
