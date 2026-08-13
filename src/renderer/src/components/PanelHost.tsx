import { useEffect, useState } from 'react'
import type {
  PropInspection,
  ResolvedControlPanel,
  SelectedElement,
  TokenSet
} from '../../../shared/api'
import { usePreviewFreeze } from '../store'

/** Shadow padding inside the island view (kept in sync with PanelApp). */
const PAD = { top: 16, right: 24, bottom: 32, left: 24 }
/** Visible gap between the CARD's right edge and the preview's. */
const GAP = 6

/**
 * Bridge for the floating prop-panel island: renders nothing itself — it
 * drives the native panel WebContentsView (which paints above the preview)
 * from the main renderer. Pushes state, tracks the preview card's rectangle
 * for placement, follows the island's reported size (a collapsed chip shrinks
 * the whole view — a transparent view still eats clicks), and hides it while
 * the preview is frozen (DOM overlay menus must not render under it).
 */
export default function PanelHost({
  root,
  element,
  inspection,
  inspecting,
  controls,
  canInstrument,
  tokens
}: {
  root: string
  element: SelectedElement
  inspection: PropInspection | null
  inspecting: boolean
  /** AI-surfaced control panels for the selection (Custom Controls, v10) —
   *  fetched by App via controls:get; null while unfetched. */
  controls: ResolvedControlPanel[] | null
  /** Can praxis instrument this project? Tailors the Styles tab read-only guidance. */
  canInstrument: boolean | null
  /** The project's design tokens, for the Styles tab's token chips + picker.
   *  Referentially stable between detections, so it can't cause a push storm. */
  tokens: TokenSet | null
}): null {
  const [size, setSize] = useState({ width: 268 + PAD.left + PAD.right, height: 160 })
  const [maxHeight, setMaxHeight] = useState(480)
  const frozen = usePreviewFreeze((s) => s.frozen)

  useEffect(
    () =>
      window.api.panel.onSize((s) =>
        setSize({ width: Math.max(60, s.width), height: Math.max(60, s.height) })
      ),
    []
  )

  useEffect(() => {
    window.api.panel.setState({
      root,
      element,
      inspection,
      inspecting,
      maxHeight,
      controls,
      canInstrument,
      tokens
    })
  }, [root, element, inspection, inspecting, maxHeight, controls, canInstrument, tokens])

  // Place at the top right of the preview card body, tracked live.
  useEffect(() => {
    if (frozen) {
      window.api.panel.hide()
      return
    }
    const body = document.querySelector('.previewcard__body')
    if (!body) return
    const place = (): void => {
      const r = body.getBoundingClientRect()
      // The card may grow to the preview area's height minus its shadow padding.
      setMaxHeight(Math.max(120, Math.round(r.height) - PAD.top - PAD.bottom - GAP))
      // Anchor the CARD's right edge GAP px inside the preview's right edge (the
      // view's right shadow padding bleeds over the window gutter — dead space).
      // The view sits flush with the body's top so its transparent padding can
      // never cover the previewbar's controls.
      window.api.panel.show({
        x: r.right - GAP - size.width + PAD.right,
        y: r.top,
        width: size.width,
        height: Math.min(size.height, Math.max(120, r.height))
      })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(body)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [size, frozen])

  // No island without a selection (unmount = hide).
  useEffect(() => () => window.api.panel.hide(), [])
  return null
}
