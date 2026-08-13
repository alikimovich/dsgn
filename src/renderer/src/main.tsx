import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import PanelApp from './components/PanelApp'
import EditorWindow from './components/EditorWindow'
import './styles.css'

const params = new URLSearchParams(location.search)

// ?praxisPanel=1 → this instance is the floating prop-panel island (a separate
// WebContentsView stacked above the native preview). It renders ONLY the panel.
const isPanel = params.has('praxisPanel')
if (isPanel) document.documentElement.classList.add('panel-host')

// ?praxisEditor=1 → this instance is the code drawer popped out into its own window
// (main/index.ts openEditorWindow). It renders ONLY the full-window editor.
const editorRoot = params.get('praxisEditor') ? params.get('root') : null
const editorSource = params.get('source')

// macOS: the main window is created with under-page vibrancy (main/index.ts) —
// stamp <html> so styles.css clears the shell backgrounds and the material
// shows through. The prop-panel island and the pop-out editor window have no
// vibrancy material behind them, so they keep opaque backgrounds.
if (!isPanel && !editorRoot && navigator.platform.startsWith('Mac')) {
  document.documentElement.classList.add('vibrancy')
}

const root = createRoot(document.getElementById('root')!)
if (editorRoot && editorSource) {
  root.render(
    <React.StrictMode>
      <EditorWindow root={editorRoot} initialSource={editorSource} />
    </React.StrictMode>
  )
} else {
  root.render(<React.StrictMode>{isPanel ? <PanelApp /> : <App />}</React.StrictMode>)
}
