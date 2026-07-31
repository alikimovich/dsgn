import { useEffect, useRef, useState } from 'react'
import type { LayerNode, LayersSnapshot } from '../../../shared/api'
import { useComposer, useLayersPanel, useSelection, useSession } from '../store'
import LayersTree, { type DropTarget } from './LayersTree'

/**
 * The Layers panel host: IPC wiring, freshness, resize, drag→move dispatch.
 * `LayersTree` stays pure render + drag-gesture detection; this file owns
 * everything that talks to `window.api`.
 *
 * Freshness: an explicit read on open, on `preview:url-changed`, and on the
 * preload's debounced `layers:changed` ping (armed only while this panel is
 * open, via `setWatch`). A successful move triggers its own re-read. Edits
 * made elsewhere (Styles/Props tabs) aren't explicitly hooked — the
 * MutationObserver already catches anything that changes the tree SHAPE
 * (adding/removing elements); a same-shape edit (recoloring, retyping text)
 * has nothing here to go stale.
 */
export default function LayersPanel(): React.JSX.Element | null {
  const open = useLayersPanel((s) => s.open)
  const height = useLayersPanel((s) => s.height)
  const setHeight = useLayersPanel((s) => s.setHeight)
  const projectRoot = useSession((s) => s.projectRoot)
  const selected = useSelection((s) => s.selected)

  const [snapshot, setSnapshot] = useState<LayersSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const readSeq = useRef(0)

  const refresh = async (): Promise<void> => {
    const seq = ++readSeq.current
    const res = await window.api.layers.read()
    if (seq !== readSeq.current) return // a newer read superseded this one
    if (res) {
      setSnapshot(res)
      setError(null)
    } else {
      setError('Could not read the preview — is a project open?')
    }
  }

  // Arm the watch + do an initial read whenever the panel opens (and whenever
  // the project changes while it's open); disarm on close/unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable enough for this effect's purpose
  useEffect(() => {
    if (!open) return
    window.api.layers.setWatch(true)
    void refresh()
    return () => window.api.layers.setWatch(false)
  }, [open, projectRoot])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable enough for this effect's purpose
  useEffect(() => {
    if (!open) return
    return window.api.layers.onChanged(() => void refresh())
  }, [open])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable enough for this effect's purpose
  useEffect(() => {
    if (!open) return
    return window.api.preview.onUrlChanged(() => void refresh())
  }, [open])

  const handleHover = (node: LayerNode | null): void => {
    window.api.layers.hover(
      node?.path ?? null,
      node ? { tag: node.tag, source: node.source } : null
    )
  }

  const handleSelect = (node: LayerNode): void => {
    window.api.layers.select(node.path, { tag: node.tag, source: node.source })
  }

  const handleDrop = async (dragged: LayerNode, drop: DropTarget): Promise<void> => {
    if (!projectRoot || !dragged.source || !drop.target.source) return
    const res = await window.api.layers.move(projectRoot, {
      dragged: { source: dragged.source },
      target: { source: drop.target.source },
      position: drop.position,
      sessionId: crypto.randomUUID()
    })
    if (res.applied) {
      void refresh()
    } else if (res.needsAgent) {
      useComposer.getState().setSeed(res.agentPrompt ?? null)
    } else if (res.error) {
      setError(res.error)
    }
  }

  // Resize handle at the panel's bottom edge — same hand-rolled pointer-math
  // idiom as the chat/preview split (App.tsx startResize) and the code drawer.
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const onMove = (ev: PointerEvent): void => setHeight(startHeight + (ev.clientY - startY))
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!open) return null

  return (
    <div
      className="layerspanel flex shrink-0 flex-col border-b bg-background pt-11"
      style={{ height }}
    >
      <div className="layerspanel__header flex h-7 shrink-0 items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Layers
        </span>
        {snapshot && (
          <span className="text-[10.5px] text-muted-foreground/70">{snapshot.totalSeen}</span>
        )}
      </div>
      <div className="layerspanel__body min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {error ? (
          <div className="px-2 py-3 text-[11.5px] text-muted-foreground">{error}</div>
        ) : (
          <LayersTree
            nodes={snapshot?.nodes ?? []}
            truncated={snapshot?.truncated ?? false}
            selectedSource={selected?.source ?? null}
            onHoverRow={handleHover}
            onSelectRow={handleSelect}
            onDrop={(dragged, drop) => void handleDrop(dragged, drop)}
          />
        )}
      </div>
      <div
        className="layerspanel__resize h-1 shrink-0 cursor-ns-resize hover:bg-ring/40"
        onPointerDown={startResize}
      />
    </div>
  )
}
