import { Minimize2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PropInspection, SelectedElement } from '../../../shared/api'
import ControlsTrigger from './styles/ControlsTrigger'

const TAB_KEY = 'praxis.island.tab'
type IslandTab = 'props' | 'styles' | 'custom'

const isIslandTab = (t: string | null): t is IslandTab =>
  t === 'props' || t === 'styles' || t === 'custom'

interface Props {
  element: SelectedElement
  /** null → no schema (the props tab shows readiness messaging instead). */
  inspection: PropInspection | null
  /** Tallest the card may grow (px) — supplied by PanelHost. */
  maxHeight?: number
  /** Shrink the island to its collapsed chip. */
  onCollapse: () => void
  onClose: () => void
  /** Body of the Props tab (PropPanel, content-only). */
  propsTab: React.ReactNode
  /** Body of the Styles tab (StylePanel). */
  stylesTab: React.ReactNode
  /** Body of the Custom tab (CustomPanel) — null when the selection has no
   *  AI-surfaced panels; the third tab only renders when it's present. */
  customTab?: React.ReactNode | null
  /** Ask the AI to surface a control panel (Custom Controls, v10). */
  onControls: (hint?: string) => void
}

/**
 * The floating island's chrome — shown for EVERY selection, always as a card
 * over the preview's top right (it renders inside the ?praxisPanel
 * WebContentsView; a docked-sidebar mode no longer exists — the header button
 * collapses it to a chip instead, see PanelApp). Owns the outer card, the
 * header row (title / collapse / close) and the segmented Props | Styles
 * switch; the tab bodies are passed in as children so this stays pure chrome.
 * The active tab is island-local and persisted (the island outlives
 * selections).
 */
export default function IslandCard({
  element,
  inspection,
  maxHeight,
  onCollapse,
  onClose,
  propsTab,
  stylesTab,
  customTab,
  onControls
}: Props): React.JSX.Element {
  const [tab, setTabRaw] = useState<IslandTab>(() => {
    const stored = localStorage.getItem(TAB_KEY)
    return isIslandTab(stored) ? stored : 'props'
  })
  const setTab = (t: string): void => {
    const next: IslandTab = isIslandTab(t) ? t : 'props'
    localStorage.setItem(TAB_KEY, next)
    setTabRaw(next)
  }
  const hasCustom = customTab != null
  // The persisted tab may be 'custom' from a selection that HAD panels — fall
  // back to Props (without rewriting the preference) while this one has none.
  const activeTab = tab === 'custom' && !hasCustom ? 'props' : tab
  const source = inspection?.source ?? element.source ?? ''
  const ident = element.id ? `#${element.id}` : element.classes[0] ? `.${element.classes[0]}` : ''

  return (
    <aside
      className="proppanel relative flex w-full flex-col overflow-hidden rounded-xl border bg-background shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
      style={{ maxHeight }}
      aria-label={`Props for ${inspection?.component ?? element.tag}`}
    >
      <header className="proppanel__head flex shrink-0 items-center gap-0.5 px-3 pb-1 pt-2.5">
        <div className="proppanel__id min-w-0 flex-1">
          <div className="proppanel__title overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold leading-5">
            {inspection?.component ?? `${element.tag}${ident}`}
          </div>
          {source && (
            <div
              className="proppanel__source overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] leading-4 text-muted-foreground"
              title={source}
            >
              {source}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="proppanel__collapse size-6 text-muted-foreground"
          onClick={onCollapse}
          aria-label="Collapse panel"
          title="Collapse to a chip"
        >
          <Minimize2 className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="proppanel__close size-6 text-muted-foreground"
          onClick={onClose}
          aria-label="Close panel"
        >
          ✕
        </Button>
      </header>
      <Tabs value={activeTab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="proppanel__tabsrow shrink-0 px-3 pb-1.5">
          <TabsList
            className={`proppanel__tabs grid h-6 w-full ${hasCustom ? 'grid-cols-3' : 'grid-cols-2'}`}
          >
            <TabsTrigger value="props" className="proppanel__tab py-0.5 text-[11.5px]">
              Props
            </TabsTrigger>
            <TabsTrigger value="styles" className="proppanel__tab py-0.5 text-[11.5px]">
              Styles
            </TabsTrigger>
            {hasCustom && (
              <TabsTrigger value="custom" className="proppanel__tab py-0.5 text-[11.5px]">
                Custom
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        <TabsContent value="props" className="flex min-h-0 flex-col">
          {propsTab}
        </TabsContent>
        <TabsContent value="styles" className="flex min-h-0 flex-col">
          {stylesTab}
        </TabsContent>
        {hasCustom && (
          <TabsContent value="custom" className="flex min-h-0 flex-col">
            {customTab}
          </TabsContent>
        )}
      </Tabs>
      {/* Footer affordance shared by both tabs: when neither the props schema
          nor the fixed style set exposes what the user wants, ask the AI to
          instrument the source and surface a custom panel. */}
      <footer className="proppanel__footer shrink-0 border-t px-3 py-1.5">
        <ControlsTrigger hasSource={!!element.source} onTrigger={onControls} />
      </footer>
    </aside>
  )
}
