import { useEffect } from 'react'
import CodeDrawer from './CodeDrawer'
import { useCodeDrawer } from '../store'

/**
 * The code drawer popped out into its own native window (main/index.ts opens the
 * renderer bundle with ?praxisEditor=1&root=…&source=…). It renders CodeDrawer in
 * its full-window variant, driven by the drawer store so Cmd+click navigation and
 * back/forward work inside this window exactly as they do docked. A second pop-out
 * for the same project reuses this window via the `editor:navigate` event.
 */
export default function EditorWindow({
  root,
  initialSource
}: {
  root: string
  initialSource: string
}): React.JSX.Element | null {
  const source = useCodeDrawer((s) => s.source)

  // Seed the store with the file this window opened on.
  useEffect(() => {
    useCodeDrawer.getState().open(initialSource)
  }, [initialSource])

  // Retarget when a second pop-out reuses this window instead of stacking a new one.
  useEffect(() => {
    return window.api.source.onNavigate((next) => useCodeDrawer.getState().open(next))
  }, [])

  if (!source) return null
  return (
    <CodeDrawer
      variant="window"
      root={root}
      source={source}
      onClose={() => void window.api.source.closeWindow()}
    />
  )
}
