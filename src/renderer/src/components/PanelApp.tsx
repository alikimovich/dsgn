import { useEffect, useRef, useState } from 'react'
import type { PanelState } from '../../../shared/api'
import { SlidersHorizontal } from 'lucide-react'
import CustomPanel from './CustomPanel'
import IslandCard from './IslandCard'
import PropPanel from './PropPanel'
import StylePanel from './StylePanel'

const COLLAPSED_KEY = 'praxis.proppanel.collapsed'

/**
 * Root of the floating prop-panel island (the ?praxisPanel=1 renderer instance —
 * a WebContentsView stacked above the native preview). Stateless w.r.t. the
 * selection: renders whatever the main renderer pushes over panel:state and
 * relays user actions back. The collapsed state is local (the island outlives
 * selections) and persisted. It reports its rendered size so the view shrinks
 * to fit — the transparent view eats clicks, so it must hug the content.
 */
export default function PanelApp(): React.JSX.Element | null {
  const [state, setState] = useState<PanelState | null>(null)
  const [collapsed, setCollapsedRaw] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const setCollapsed = (c: boolean): void => {
    localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0')
    setCollapsedRaw(c)
  }
  const ref = useRef<HTMLDivElement>(null)
  // Removed-panel tombstones: "Remove panel" deletes from the store directly
  // (like PropPanel calls props IPC), but the pushed state stays stale until
  // App's next controls re-fetch — filter removed ids locally so the panel
  // (and the Custom tab, when none remain) disappears immediately. Reset per
  // selection: a fresh pick re-fetches, so stale tombstones must not outlive it.
  const [removedPanels, setRemovedPanels] = useState<string[]>([])

  useEffect(() => window.api.panel.onState(setState), [])

  const elKey = state ? `${state.element.source ?? ''}|${state.element.selector}` : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: elKey is the selection identity — tombstones reset only on a new selection.
  useEffect(() => setRemovedPanels([]), [elKey])

  // Report rendered size (includes the shadow padding) whenever it changes.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      window.api.panel.reportSize({ width: Math.ceil(r.width), height: Math.ceil(r.height) })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [state === null, collapsed])

  if (!state) return null
  const controls = (state.controls ?? []).filter((p) => !removedPanels.includes(p.manifest.id))
  return (
    /* Padding = exactly the card shadow's extent per side (0 8px 24px → up 16,
       sides 24, down 32), so the blur never clips at the view edges and the
       transparent view stays as small as possible (it eats clicks).
       width: fit-content so a collapsed chip shrinks the reported size too.
       Mirrored in PanelHost's placement math. */
    <div
      ref={ref}
      className="panelapp"
      style={{ padding: '16px 24px 32px 24px', width: 'fit-content' }}
    >
      {collapsed ? (
        <button
          type="button"
          className="proppanel__expand flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-[12px] font-medium shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          onClick={() => setCollapsed(false)}
          title="Show props"
        >
          <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {state.inspection?.component ?? state.element.tag}
        </button>
      ) : (
        <div style={{ width: 268 }}>
          <IslandCard
            element={state.element}
            inspection={state.inspection}
            maxHeight={state.maxHeight}
            onCollapse={() => setCollapsed(true)}
            onClose={() => window.api.panel.action({ kind: 'close' })}
            onControls={(hint) => window.api.panel.action({ kind: 'controls', hint })}
            propsTab={
              <PropPanel
                root={state.root}
                element={state.element}
                inspection={state.inspection}
                inspecting={state.inspecting}
                onChange={(next) =>
                  window.api.panel.action({ kind: 'inspection', inspection: next })
                }
                onSeedPrompt={(text) => window.api.panel.action({ kind: 'seed', text })}
                onSetup={() => window.api.panel.action({ kind: 'setup' })}
                onSelectOwner={() => window.api.panel.action({ kind: 'owner' })}
                onControls={() => window.api.panel.action({ kind: 'controls' })}
              />
            }
            stylesTab={
              <StylePanel
                root={state.root}
                element={state.element}
                canInstrument={state.canInstrument}
                onSeedPrompt={(text) => window.api.panel.action({ kind: 'seed', text })}
              />
            }
            customTab={
              controls.length ? (
                <CustomPanel
                  root={state.root}
                  element={state.element}
                  inspection={state.inspection}
                  panels={controls}
                  onSeedPrompt={(text) => window.api.panel.action({ kind: 'seed', text })}
                  onRegenerate={(panelId) =>
                    window.api.panel.action({ kind: 'controls', hint: 'regenerate', panelId })
                  }
                  onRemove={(panelId) => {
                    void window.api.controls.remove(state.root, panelId)
                    setRemovedPanels((prev) => [...prev, panelId])
                  }}
                />
              ) : null
            }
          />
        </div>
      )}
    </div>
  )
}
