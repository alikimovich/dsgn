import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  powerMonitor,
  shell,
  WebContentsView,
  webContents
} from 'electron'
import { join } from 'path'
import type {
  MoveNodeRequest,
  RecentMenuEntry,
  SelectedElement,
  StyleReadResult
} from '../shared/api'
import { registerAgentIpc } from './agent'
import { registerAnnotationsIpc } from './annotations'
import { registerControlsIpc } from './control-panels'
import { registerDevServerIpc } from './devserver'
import { registerDiagnoseIpc } from './diagnose'
import { registerFeedbackIpc } from './feedback'
import { createProjectFile, deleteProjectFile, renameProjectFile } from './file-ops'
import { listProjectFiles } from './file-tree'
import { checkoutBranch, ensureBranch, listBranches, switchBranch } from './git'
import { registerGithubIpc } from './github'
import { applyMoveNode } from './move-node'
import { registerPreviewSource } from './preview-state'
import { registerPropsIpc } from './props'
import { createProject } from './scaffold'
import { registerSetupIpc } from './setup'
import { registerSimulatorIpc } from './simulator'
import { registerStylesIpc } from './styles'
import { registerTokensIpc } from './tokens'
import { registerUpdateIpc } from './update-ipc'

// Product name — drives the macOS app menu label and the About panel. Set at
// module load (before app is ready) so the menu bar reads "Praxis", not "Electron".
app.setName('Praxis')
// The About panel otherwise reports the Electron bundle's own version string.
app.setAboutPanelOptions({
  applicationName: 'Praxis',
  applicationVersion: app.getVersion()
})

// Backstop for the post-teardown race. Around a sleep/wake cycle — especially
// after the window was closed but the app kept running (macOS) — a stray
// Electron event can still fire into an object destroyed with the window before
// its listener is torn down, throwing "Object has been destroyed". The specific
// handlers are guarded (sendToMain, powerMonitor, the closed→null cleanup), but
// this catches anything they miss (incl. Electron-internal emitters) so a benign
// teardown race can't pop the modal "A JavaScript error occurred" dialog. Real
// errors keep the default surfacing (an error box), so nothing is silently lost.
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError && /Object has been destroyed/.test(msg)) {
    console.error('Ignoring post-teardown "Object has been destroyed":', msg)
    return
  }
  console.error('Uncaught exception in main process:', err)
  try {
    dialog.showErrorBox(
      'A JavaScript error occurred in the main process',
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    )
  } catch {
    /* dialog unavailable this early — already logged above */
  }
})

// App icon (dev dock icon + Win/Linux window icon). Lives at build/icon.png,
// resolved relative to the compiled main (out/main → ../../build). Loaded up front
// so a missing file degrades to an empty image (guarded at use) instead of throwing.
const appIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))

let mainWindow: BrowserWindow | null = null

/**
 * Send an IPC message to the main renderer, defensively.
 *
 * A bare `mainWindow?.webContents.send(...)` only guards `mainWindow` being null
 * — but the window can outlive its `webContents` (the OS kills the renderer process on
 * display sleep / GPU loss). Async event sources — preview navigation events,
 * dev-server socket data — keep firing during that window and throw an uncaught
 * "Object has been destroyed" from `.send()`, surfacing the crash dialog the
 * user sees on wake. Checking `isDestroyed()` makes every send a safe no-op once
 * the renderer is gone.
 */
function sendToMain(channel: string, ...args: unknown[]): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

// Test isolation: the electron test tier (test/run.mjs) points each test at its
// own throwaway userData dir so persisted state (localStorage: workspace/recents)
// can't leak between tests — and each gets its own single-instance lock, so a
// stale app from a killed run can't block the next launch. Never set in
// production; must run before the lock request below.
if (process.env.PRAXIS_USER_DATA) {
  app.setPath('userData', process.env.PRAXIS_USER_DATA)
}

// Single-instance: re-running `praxis` (or relaunching after an update) focuses
// the running window instead of spawning a second Praxis.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

let previewView: WebContentsView | null = null
let previewUrl: string | null = null
let previewRetries = 0
// v2 select mode: tracked here so it survives preview navigations (the injected
// preload re-runs fresh on each load and must be re-armed).
let selectModeActive = false
let commentModeActive: 'comment' | 'annotate' | null = null
// Mobile viewport: draw the iPhone bezel INSIDE the preview page (pointer-events
// none) so it overlays the app's screen corners yet passes clicks/selection through.
let frameModeActive = false
// Layers panel: whether the renderer wants the preload's MutationObserver armed.
// Same lifecycle as the flags above — preload-local state that dies on every
// fresh injection, re-armed on did-finish-load below.
let layersWatchActive = false
// Channels mirrored in src/preview/preload.ts (the injected preview preload).
const PREVIEW_SET_MODE = 'praxis:preview:set-select-mode'
const PREVIEW_PICKED = 'praxis:preview:element-picked'
const PREVIEW_CANCELLED = 'praxis:preview:select-cancelled'
const PREVIEW_SET_PINS = 'praxis:preview:set-annotations'
const PREVIEW_PIN_CLICK = 'praxis:preview:pin-click'
const PREVIEW_READINESS = 'praxis:preview:readiness'
const PREVIEW_TEXT_EDIT = 'praxis:preview:text-edit'
const PREVIEW_SET_COMMENT_MODE = 'praxis:preview:set-comment-mode'
const PREVIEW_COMMENT_MODE = 'praxis:preview:comment-mode'
const PREVIEW_COMMENT = 'praxis:preview:comment'
const PREVIEW_SET_FRAME = 'praxis:preview:set-frame'
const PREVIEW_TOOLBAR_ACTION = 'praxis:preview:toolbar-action'
const PREVIEW_CLEAR_SELECTED = 'praxis:preview:clear-selected'
const PREVIEW_SET_STATUS = 'praxis:preview:set-status'
const PREVIEW_TOGGLE_SELECT = 'praxis:preview:toggle-select'
const LAYERS_READ = 'layers:read'
const LAYERS_READ_REPLY = 'layers:read-reply'
const LAYERS_CHANGED = 'layers:changed'
const LAYERS_SELECT = 'layers:select'
const LAYERS_HOVER = 'layers:hover'
const LAYERS_SET_WATCH = 'layers:set-watch'

// Launch-status pill text (shown inside the preview); re-pushed after loads.
let previewStatusText: string | null = null

// Latest annotation pins, re-pushed to the preview after each navigation.
let annotationPins: { id: string; selector: string }[] = []

// Renderer's last-reported preview slot rect. Module-scope (not local to
// registerPreviewIpc) so resetStalePreview can zero it too.
let lastPreviewBounds = { x: 0, y: 0, width: 0, height: 0, radius: 0 }

// The renderer asked the native preview hidden (split-drag, or the freeze-frame
// path under an overlay that must paint above it — dropdowns, the session-review
// modal). While set, a completing preview:load must NOT unhide the view: native
// views always paint over DOM, so it would punch straight through the open
// overlay (e.g. a project launch finishing while the user reads a past chat).
// Visibility returns when the renderer releases the hide (set-dragging false).
let previewHiddenByRenderer = false

// Chromium error codes worth retrying — the dev server is up but not yet serving.
const TRANSIENT_LOAD_ERRORS = new Set([-324, -102, -101, -105, -106, -109])

// Empty-state shown in the native preview view. Themed via prefers-color-scheme
// so it tracks the OS (matching the renderer, which also follows the OS) — and
// adapts live if the user flips the system appearance while it's showing.
const PLACEHOLDER_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <html>
    <head>
      <meta name="color-scheme" content="light dark">
      <style>
        body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
               font-family:-apple-system,system-ui,sans-serif; color:#8a8a8a; background:#fafafa; }
        .ph-title { font-size:15px; font-weight:600; color:#555; }
        .ph-sub { font-size:13px; margin-top:6px; }
        @media (prefers-color-scheme: dark) {
          body { color:#8d8d94; background:#111113; }
          .ph-title { color:#ededed; }
        }
      </style>
    </head>
    <body>
      <div style="text-align:center">
        <div class="ph-title">No project open</div>
        <div class="ph-sub">Open a folder to launch its dev server here.</div>
      </div>
    </body>
  </html>
`)}`

/** Base color painted behind the preview view — tracks the OS appearance so the
 *  empty state (and the flash before a project's page loads) isn't a white slab
 *  in dark mode. */
const previewBg = (): string => (nativeTheme.shouldUseDarkColors ? '#111113' : '#ffffff')

/**
 * The preview is a native WebContentsView layered over the renderer (not an
 * iframe) so that later we can inject a preload into the previewed app for
 * element selection. The renderer owns the layout and reports the rectangle
 * the preview should occupy via the `preview:set-bounds` IPC channel.
 */
function isLocalPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    return (u.protocol === 'http:' || u.protocol === 'https:') && local
  } catch {
    return false
  }
}

/** Open a URL in the user's browser, but only for safe web/mail schemes. */
function openExternalSafe(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      void shell.openExternal(url)
    }
  } catch {
    /* malformed URL — ignore */
  }
}

/**
 * Compare two URLs by their canonical form. Chromium canonicalizes URLs it
 * reports back (`validatedURL`, `getURL()`) — e.g. it appends a trailing slash
 * to an origin-only URL — while the URL we're handed from the renderer is not.
 * A raw `===` therefore never matches for root URLs, silently disabling the
 * did-fail-load retry and the did-finish-load overlay re-arm. Canonicalize both.
 */
function sameUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  try {
    return new URL(a).toString() === new URL(b).toString()
  } catch {
    return a === b
  }
}

/**
 * Cmd/Ctrl+R must NOT reload the praxis renderer: that wipes the chat + the open
 * project (renderer-only zustand state) while the native preview WebContentsView
 * survives, stranding the tool in a broken half-state ("no project open" but the
 * preview still showing). Intercept it on whichever webContents has focus and
 * reload the PREVIEW instead. `preventDefault()` in before-input-event also
 * suppresses the menu's reload accelerator (per Electron docs), so this fully
 * disables the keyboard reload — View → Reload (a menu click) stays as a dev
 * escape hatch if the tool itself ever needs a hard reload.
 */
// Recents shown in File → Open Recent. The renderer owns the list (localStorage)
// and pushes it over `menu:set-recents`; we cap at 8 and rebuild the menu.
let recentProjects: RecentMenuEntry[] = []

/**
 * Native app menu. A "File" menu holds New/Open Project + Open Recent (a submenu
 * of up to 8 recently opened projects); an "Actions" menu carries the preview
 * commands (Reload/Select/Publish/Stop/Viewport) that used to be titlebar
 * buttons. Because we set our OWN menu, the default View → Reload (which reloaded
 * the renderer and stranded the tool) is gone; our Cmd+R reloads the PREVIEW
 * instead. On macOS the app menu is spelled out rather than `role: 'appMenu'` so
 * it can carry Settings… (Cmd+,); other platforms get that item under File.
 * Renderer-side actions go over `menu:action`; a chosen recent goes over
 * `menu:open-recent`; reload is handled here directly.
 */
function buildAppMenu(): void {
  const send = (action: string): void => sendToMain('menu:action', action)
  const openRecent = (root: string): void => sendToMain('menu:open-recent', root)

  /**
   * Edit → Undo/Redo. NOT `role: 'editMenu'`: the role's Undo item owns the
   * Cmd+Z accelerator at the NATIVE menu level, which intercepts the keystroke
   * in the main process and routes it to text-editing undo — the renderer's
   * keydown listener (App.tsx, the praxis source-edit undo) never fires for a
   * physical keyboard. (Tests never caught this: synthetic/CDP key events
   * bypass native menu accelerators, so the renderer handler DID fire there.)
   *
   * Routing: a non-main focused webContents (the preview, the props island,
   * the pop-out editor) gets plain text-editing undo — exactly what the role
   * did, incl. CodeMirror, which maps the native historyUndo beforeinput to
   * its own history. The MAIN renderer decides for itself (menu:action):
   * a focused text field keeps native undo; anything else runs the praxis
   * source-edit undo stack.
   */
  const editCommand = (cmd: 'undo' | 'redo'): void => {
    const focused = webContents.getFocusedWebContents()
    if (focused && focused !== mainWindow?.webContents) {
      focused[cmd]()
      return
    }
    send(cmd)
  }

  const recentItems: MenuItemConstructorOptions[] = recentProjects.length
    ? [
        ...recentProjects.slice(0, 8).map((r) => ({
          label: r.name,
          sublabel: r.root,
          toolTip: r.root,
          click: () => openRecent(r.root)
        })),
        { type: 'separator' as const },
        { label: 'Clear Menu', click: () => send('clear-recents') }
      ]
    : [{ label: 'No Recent Projects', enabled: false }]

  /**
   * Settings (the v10 providers dialog). MUST be a real menu item: Cmd+, is a
   * native accelerator, so a renderer keydown for it would never fire on a
   * physical keyboard (see the Edit-menu note above). On macOS that means
   * spelling out `role: 'appMenu'`'s own template — it has no Settings slot —
   * so the item sits where the platform puts it; elsewhere it rides File.
   */
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send('settings')
  }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              settingsItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('new-project')
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('open-project')
        },
        { label: 'Open Recent', submenu: recentItems },
        ...(process.platform === 'darwin'
          ? []
          : [{ type: 'separator' as const }, settingsItem])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => editCommand('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => editCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Actions',
      submenu: [
        {
          label: 'Reload Preview',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('reload')
        },
        {
          label: 'Select Element',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('select')
        },
        {
          label: 'Toggle Logs',
          accelerator: 'CmdOrCtrl+L',
          click: () => send('logs')
        },
        {
          // Figma's "hide UI": chat + sidebar collapse, only the preview stays.
          label: 'Toggle UI',
          accelerator: 'CmdOrCtrl+.',
          click: () => send('toggle-chat')
        },
        {
          label: 'Publish',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('publish')
        },
        {
          // ⌘. went to Toggle UI (the Figma muscle-memory); Stop keeps the
          // Xcode-ish combo one modifier up.
          label: 'Stop Project',
          accelerator: 'CmdOrCtrl+Shift+.',
          click: () => send('stop')
        },
        { type: 'separator' },
        {
          label: 'Viewport',
          submenu: [
            {
              label: 'Desktop',
              accelerator: 'CmdOrCtrl+1',
              click: () => send('viewport:desktop')
            },
            {
              label: 'Mobile',
              accelerator: 'CmdOrCtrl+2',
              click: () => send('viewport:mobile')
            }
          ]
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Floating prop-panel view ─────────────────────────────────────────────────
// The floating props island must paint ON TOP of the live preview content, and
// renderer DOM never can (the preview is a native WebContentsView, which always
// draws above the page). So the island is its own WebContentsView stacked after
// (= above) the preview, running the same renderer bundle with ?praxisPanel=1 —
// that entry renders just the PropPanel and syncs state/actions over panel:*.
let panelView: WebContentsView | null = null
let panelState: unknown = null

function ensurePanelView(): WebContentsView {
  if (panelView) return panelView
  panelView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  // Transparent — the card draws its own surface + shadow inside the view rect.
  panelView.setBackgroundColor('#00000000')
  if (process.env['ELECTRON_RENDERER_URL']) {
    void panelView.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?praxisPanel=1`)
  } else {
    void panelView.webContents.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { praxisPanel: '1' }
    })
  }
  // The panel page is stateless — it pulls the latest state itself once it is
  // listening (panel:request-state below). Re-pushing here on `did-finish-load`
  // instead would race the island's own ipcRenderer registration (React commits
  // its effect after the page's load event as often as not) and the island would
  // stay blank until some unrelated selection change happened to re-push.
  mainWindow?.contentView.addChildView(panelView)
  return panelView
}

function ensurePreviewView(): WebContentsView {
  if (previewView) return previewView
  previewView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Inject the select-mode overlay into the previewed app.
      preload: join(__dirname, '../preload/preview.js')
    }
  })
  previewView.setBackgroundColor(previewBg())
  previewView.webContents.loadURL(PLACEHOLDER_HTML)
  mainWindow?.contentView.addChildView(previewView)
  // The floating props island must stay ABOVE the preview (addChildView with an
  // existing child re-appends = raises it).
  if (panelView) mainWindow?.contentView.addChildView(panelView)

  const wc = previewView.webContents

  // Chrome-style right-click → Inspect / Open Console on the PREVIEW's own
  // DevTools (so the user can inspect their web app's DOM + console). Only for a
  // real web preview, not the placeholder or the simulator's streamed frame.
  wc.on('context-menu', (_e, params) => {
    if (!previewUrl || !/^https?:/.test(previewUrl)) return
    // Always open DevTools DETACHED (its own window). The preview is a child
    // WebContentsView, so a docked panel crams itself into the view's bounds —
    // tiny and clipped, especially in the mobile (390px) viewport.
    const openDetached = (): void => {
      if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
    }
    Menu.buildFromTemplate([
      {
        label: 'Inspect element',
        click: () => {
          openDetached()
          wc.inspectElement(params.x, params.y)
        }
      },
      { label: 'Open DevTools console', click: openDetached }
    ]).popup()
  })

  // The previewed app is untrusted-ish: keep it on its own local origin, and
  // never hand it a URL scheme the OS could act on (file:/smb:/custom protocol
  // handlers). Only web + mail links escape to the user's browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (!isLocalPreviewUrl(url)) openExternalSafe(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isLocalPreviewUrl(url)) return
    // A page-initiated data:/blob: navigation would replace the preview with
    // attacker HTML that still has our preload injected — block it outright.
    e.preventDefault()
    openExternalSafe(url)
  })

  // Retry transient failures: fast while the dev server is coming up, then a
  // slow indefinite poll — a server that dies mid-session (crash, manual kill)
  // can come back minutes later, and the preview must self-heal rather than
  // park on Chromium's error page until the project is reopened. Only fires
  // for the current previewUrl, so an idle/placeholder view never polls.
  wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || !previewUrl || !sameUrl(validatedURL, previewUrl)) return
    if (!TRANSIENT_LOAD_ERRORS.has(errorCode)) return
    previewRetries++
    const delay = previewRetries > 40 ? 3000 : 400
    setTimeout(() => previewUrl && previewView?.webContents.loadURL(previewUrl), delay)
  })

  // Once the intended URL loads, reset the budget so it's per-outage not per-session.
  // The preload re-ran on this fresh page, so re-arm select mode if it was on —
  // but only on the real preview page, never the "no project" placeholder.
  wc.on('did-finish-load', () => {
    if (previewUrl && sameUrl(wc.getURL(), previewUrl)) {
      previewRetries = 0
      if (selectModeActive) wc.send(PREVIEW_SET_MODE, true)
      if (commentModeActive) wc.send(PREVIEW_SET_COMMENT_MODE, commentModeActive)
      if (frameModeActive) wc.send(PREVIEW_SET_FRAME, true)
      if (layersWatchActive) wc.send(LAYERS_SET_WATCH, true)
      // Only re-send pins when there are some — an empty push would make the
      // preload build (and inject) the overlay host for nothing.
      if (annotationPins.length) wc.send(PREVIEW_SET_PINS, annotationPins)
    }
    // The launch-status pill must survive placeholder (re)loads mid-launch.
    if (previewStatusText) wc.send(PREVIEW_SET_STATUS, previewStatusText)
  })

  // Keep the renderer's URL bar in sync with where the preview actually is
  // (link clicks, SPA route changes). Only real preview pages — never the
  // data: placeholder.
  const reportUrl = (): void => {
    const url = wc.getURL()
    if (/^https?:/.test(url)) sendToMain('preview:url-changed', url)
  }
  wc.on('did-navigate', reportUrl)
  wc.on('did-navigate-in-page', reportUrl)

  return previewView
}

/**
 * Reset the native preview to an unclaimed state after the MAIN renderer reloads
 * (crash-recovery reload, hard refresh). The preview is a separate
 * WebContentsView that survives a main-frame reload untouched — it keeps
 * painting its last frame at its last bounds, and PreviewPane's unmount cleanup
 * (which normally zeros this out) never runs across a hard navigation, so a
 * fresh renderer would otherwise boot on the Welcome screen with a stale
 * preview floating on top of it. Deliberately does NOT load the placeholder URL
 * or clear `previewUrl` — the page stays warm so a reattaching renderer's
 * `preview:load` (which already does `setVisible(true)`) comes back instantly
 * instead of a fresh navigation. Guarded with `previewView?.` so the very first
 * window load (before the preview view exists) is a no-op.
 */
function resetStalePreview(): void {
  previewView?.setVisible(false)
  previewView?.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  lastPreviewBounds = { x: 0, y: 0, width: 0, height: 0, radius: 0 }
  // The overlay that requested a hide died with the old renderer document —
  // don't let its stale intent block the reattaching renderer's preview:load.
  previewHiddenByRenderer = false
  // Same flags `preview:reset` clears (index.ts ~484-496) — keeps a stale mode
  // from silently re-arming via did-finish-load once a project reattaches.
  selectModeActive = false
  commentModeActive = null
  frameModeActive = false
  layersWatchActive = false
  annotationPins = []
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Praxis',
    // Window icon (Windows/Linux; macOS uses the dock icon set below). Omit when
    // the PNG is missing so Electron falls back to its default rather than erroring.
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    // macOS: the window base is the NSVisualEffect SIDEBAR material. The
    // renderer carves it up (styles.css `html.vibrancy` rules, stamped by
    // main.tsx): the rail shows it raw (true sidebar vibrancy), the chat +
    // preview panes paint opaque --bg over it, the Welcome screen a light
    // wash. Electron allows ONE material per window — a true multi-material
    // split would need a native NSVisualEffectView addon. An opaque
    // backgroundColor would paint over the material, so only the other
    // platforms get the solid fill.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const }
      : { backgroundColor: previewBg() }),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Tell the renderer when we enter/leave native fullscreen. In fullscreen the
  // macOS traffic lights are hidden, so the floating sidebar toggle re-aligns to
  // the window's left edge instead of clearing the (now absent) window controls.
  const sendFullscreen = (): void =>
    sendToMain('window:fullscreen', mainWindow?.isFullScreen() ?? false)
  mainWindow.on('enter-full-screen', sendFullscreen)
  mainWindow.on('leave-full-screen', sendFullscreen)
  // No material swap on these transitions: in fullscreen the renderer paints
  // every shell surface opaque (`body.is-fullscreen` in styles.css), so no
  // material is visible — and a main-side setVibrancy can't be ordered against
  // that CSS flip across the process boundary without risking a flash.

  // Keep the native surfaces' base color in step with the OS appearance (the
  // placeholder HTML re-themes itself via prefers-color-scheme; this handles the
  // solid fill behind it and the window).
  nativeTheme.on('updated', () => {
    const bg = previewBg()
    // Not on macOS — an opaque window background would paint over the
    // under-page vibrancy material (the window has none to update there).
    if (process.platform !== 'darwin') mainWindow?.setBackgroundColor(bg)
    previewView?.setBackgroundColor(bg)
  })

  // Open external links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const loadRenderer = (): void => {
    if (process.env['ELECTRON_RENDERER_URL']) {
      mainWindow?.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow?.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  // Unlike previewView (which self-heals via did-fail-load), a crashed main
  // renderer had nothing to reload it — Chromium can silently kill/reset the
  // GPU or renderer process around a long system sleep, leaving the window
  // frozen on its last (often blank) frame with no recovery. Reload it.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`Main renderer process gone (${details.reason}); reloading.`)
    loadRenderer()
  })

  // Any full navigation of the MAIN renderer (the render-process-gone reload
  // above, a hard refresh, a dev-server full reload) leaves the preview
  // WebContentsView painted at its last bounds while the fresh renderer boots
  // with no memory of it — hide it until the renderer reattaches. Covers the
  // initial load too (previewView is still null then, so this is a no-op).
  mainWindow.webContents.on('did-navigate', resetStalePreview)

  // Closing the window (traffic-light close) does NOT quit on macOS — the app
  // stays alive to own the dev server. Without this, `mainWindow` kept pointing
  // at the *destroyed* BrowserWindow, so every `mainWindow?.…` guard elsewhere
  // was defeated (non-null but dead) and background listeners that fire on wake
  // — powerMonitor 'resume', dev-server socket data, preview navigation — threw
  // an uncaught "Object has been destroyed", popping the crash dialog. Null the
  // window and its child views (destroyed with it) so those guards short-circuit
  // and a later dock re-open (app 'activate') rebuilds fresh views instead of
  // ensurePreviewView/ensurePanelView handing back a dead one.
  mainWindow.on('closed', () => {
    mainWindow = null
    previewView = null
    panelView = null
    previewUrl = null
    lastPreviewBounds = { x: 0, y: 0, width: 0, height: 0, radius: 0 }
  })

  loadRenderer()
}

// The code drawer, popped out into its own window. Runs the same renderer bundle
// with ?praxisEditor=1 (like the ?praxisPanel island), so it reuses CodeMirror, the
// source:* IPC, and the app's theming — it just renders the editor full-window
// instead of docked under the preview. Keyed by project root so a second pop-out
// for the same project re-focuses the existing window rather than stacking.
const editorWindows = new Map<string, BrowserWindow>()

function openEditorWindow(root: string, source: string): void {
  const existing = editorWindows.get(root)
  if (existing && !existing.isDestroyed()) {
    // Retarget the already-open window at the newly requested file, then focus it.
    existing.webContents.send('editor:navigate', source)
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 420,
    minHeight: 260,
    show: false,
    title: 'Praxis — Code',
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    ...(process.platform === 'darwin' ? {} : { backgroundColor: previewBg() }),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  editorWindows.set(root, win)
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (editorWindows.get(root) === win) editorWindows.delete(root)
  })
  // External links (Cmd+click into a URL, etc.) open in the browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const query = { praxisEditor: '1', root, source }
  if (process.env['ELECTRON_RENDERER_URL']) {
    const u = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    void win.loadURL(u.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

function registerEditorIpc(): void {
  ipcMain.handle('source:popout', (_e, root: string, source: string) => {
    openEditorWindow(root, source)
  })
  // The pop-out editor's file-tree sidebar: repo-relative file paths for `root`.
  ipcMain.handle('source:tree', (_e, root: string) => listProjectFiles(root))
  // …and its file-manager ops. Every path is re-validated inside file-ops.ts —
  // the renderer's is untrusted. Delete goes to the OS trash: these aren't
  // content edits, so the undo history can't take them back.
  ipcMain.handle('source:create-file', (_e, root: string, path: string) =>
    createProjectFile(root, path)
  )
  ipcMain.handle('source:rename-file', (_e, root: string, from: string, to: string) =>
    renameProjectFile(root, from, to)
  )
  ipcMain.handle('source:delete-file', (_e, root: string, path: string) =>
    deleteProjectFile(root, path, (abs) => shell.trashItem(abs))
  )
  // Close the editor window that sent this (a popped-out editor closing itself).
  ipcMain.handle('source:close-window', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
}

function registerPreviewIpc(): void {
  // Let the in-process agent tools (backends/claude.ts) observe the user's live
  // preview without importing this module (would be a cycle). getUrl reports the
  // preview's CURRENT location (SPA navigations included) but null for the
  // placeholder/empty state; capture snapshots the current frame.
  registerPreviewSource({
    getUrl: () => {
      const url = previewView?.webContents.getURL()
      return url && /^https?:/.test(url) ? url : null
    },
    capture: async () => (await previewView?.webContents.capturePage()) ?? null
  })

  // Apply the renderer's slot rect (PreviewPane already lays out around the
  // floating prop panel's strip, viewport-aware).
  const applyBounds = (): void => {
    const view = ensurePreviewView()
    view.setBounds({
      x: Math.round(lastPreviewBounds.x),
      y: Math.round(lastPreviewBounds.y),
      width: Math.max(0, Math.round(lastPreviewBounds.width)),
      height: Math.round(lastPreviewBounds.height)
    })
    // Round the native view's corners: the card's inner radius in desktop
    // viewport, the iPhone screen's in mobile (both supplied by the renderer).
    view.setBorderRadius(Math.round(lastPreviewBounds.radius || 0))
  }

  // Renderer reports where the preview rectangle is, in CSS pixels (== DIP).
  ipcMain.on(
    'preview:set-bounds',
    (
      _e,
      bounds: {
        x: number
        y: number
        width: number
        height: number
        radius?: number
      }
    ) => {
      lastPreviewBounds = { ...bounds, radius: bounds.radius ?? 0 }
      applyBounds()
    }
  )

  // Mobile viewport toggles the in-page iPhone bezel overlay (click pass-through).
  ipcMain.on('preview:set-frame', (_e, active: boolean) => {
    frameModeActive = !!active
    previewView?.webContents.send(PREVIEW_SET_FRAME, frameModeActive)
  })

  ipcMain.handle('preview:load', (_e, url: string) => {
    if (!isLocalPreviewUrl(url)) return
    previewUrl = url
    previewRetries = 0
    const view = ensurePreviewView()
    // Recover from any LEAKED hide (a renderer bug) — a fresh load should be
    // visible. But an ACTIVE hide (previewHiddenByRenderer: the review modal /
    // a dropdown's freeze-frame is up) must win, or a load completing under it
    // pops the native view over the open overlay; set-dragging(false) restores
    // visibility when the overlay closes.
    if (!previewHiddenByRenderer) view.setVisible(true)
    view.webContents.loadURL(url)
  })

  ipcMain.handle('preview:reset', () => {
    previewUrl = null
    previewRetries = 0
    // No app to select in on the placeholder — keep main's flags honest so none
    // of them silently re-arm the overlay/frame/pins on a later load (the
    // did-finish-load re-arm above reads these). PreviewPane re-reports the
    // frame on the next open, so zeroing it here is safe. (Renderer disarms too.)
    selectModeActive = false
    commentModeActive = null
    frameModeActive = false
    layersWatchActive = false
    annotationPins = []
    ensurePreviewView().webContents.loadURL(PLACEHOLDER_HTML)
  })

  // Hide the native view during a split-drag (renderer keeps mouse events) or
  // under a freeze-frame overlay; remember the intent so preview:load respects it.
  ipcMain.on('preview:set-dragging', (_e, active: boolean) => {
    previewHiddenByRenderer = active
    previewView?.setVisible(!active)
  })

  // Freeze-frame support: snapshot the live preview so renderer UI (e.g. the
  // branch dropdown) can overlay a pixel-identical <img> while the native view
  // hides beneath it — the preview appears to stay put, but the DOM wins.
  ipcMain.handle('preview:capture', async (): Promise<string | null> => {
    try {
      const img = await previewView?.webContents.capturePage()
      return img && !img.isEmpty() ? img.toDataURL() : null
    } catch {
      return null
    }
  })

  // v2 select mode: renderer → preview (arm/disarm the overlay).
  ipcMain.handle('preview:set-select-mode', (_e, active: boolean) => {
    selectModeActive = active
    if (active) commentModeActive = null // mutually exclusive with comment/annotate
    previewView?.webContents.send(PREVIEW_SET_MODE, active)
  })

  // preview → renderer relays. Only trust events from the preview's webContents.
  ipcMain.on(PREVIEW_PICKED, (e, el: SelectedElement) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('preview:element-picked', el)
  })
  ipcMain.on(PREVIEW_CANCELLED, (e) => {
    if (e.sender !== previewView?.webContents) return
    selectModeActive = false
    sendToMain('preview:select-cancelled')
  })

  // Selection-toolbar actions that need the renderer (code drawer / delete turn);
  // comment/annotate are handled entirely inside the preview's composer.
  ipcMain.on(PREVIEW_TOOLBAR_ACTION, (e, kind: string) => {
    if (e.sender !== previewView?.webContents) return
    if (kind !== 'code' && kind !== 'delete' && kind !== 'props') return
    sendToMain('preview:toolbar-action', kind)
  })
  // Renderer dropped the selection (pill ×, message sent) → hide the toolbar.
  ipcMain.on('preview:clear-selected', () => {
    previewView?.webContents.send(PREVIEW_CLEAR_SELECTED)
  })

  // S pressed while the preview has focus → the renderer runs its toggle.
  ipcMain.on(PREVIEW_TOGGLE_SELECT, (e) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('preview:toggle-select')
  })

  // Launch progress, drawn INSIDE the preview (bottom-center pill) instead of a
  // window-top banner. null clears it.
  ipcMain.on('preview:set-status', (_e, text: string | null) => {
    previewStatusText = typeof text === 'string' && text.trim() ? text.slice(0, 300) : null
    previewView?.webContents.send(PREVIEW_SET_STATUS, previewStatusText)
  })

  // ── Floating prop-panel plumbing (renderer ⇄ panel view, via main) ──────────
  const fromMainWindow = (e: Electron.IpcMainEvent): boolean => e.sender === mainWindow?.webContents
  ipcMain.on('panel:show', (e, b: { x: number; y: number; width: number; height: number }) => {
    if (!fromMainWindow(e)) return
    const v = ensurePanelView()
    v.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height))
    })
    v.setVisible(true)
  })
  ipcMain.on('panel:hide', (e) => {
    if (!fromMainWindow(e)) return
    panelView?.setVisible(false)
  })
  ipcMain.on('panel:state', (e, state: unknown) => {
    if (!fromMainWindow(e)) return
    panelState = state
    panelView?.webContents.send('panel:state', state)
  })
  // Island → "I'm listening, send me what you have". The first setState always
  // predates the view (show creates it), so without this pull the island's very
  // first render would have nothing to draw. Same channel as the pushes, so the
  // reply can never overtake a newer state.
  ipcMain.on('panel:request-state', (e) => {
    if (e.sender !== panelView?.webContents) return
    if (panelState) e.sender.send('panel:state', panelState)
  })
  // Panel → main renderer: user actions (close/dock/seed/…) and content height.
  ipcMain.on('panel:action', (e, action: unknown) => {
    if (e.sender !== panelView?.webContents) return
    sendToMain('panel:action', action)
  })
  ipcMain.on('panel:size', (e, size: { width: number; height: number }) => {
    if (e.sender !== panelView?.webContents) return
    sendToMain('panel:size', size)
  })

  // ── Styles tab: live-injection relays + computed-style reads (v10) ──────────
  // The style controls live in the island (panelView), but the main renderer may
  // also drive them — accept either sender, relay into the preview's preload.
  const fromMainOrPanel = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    e.sender === mainWindow?.webContents || e.sender === panelView?.webContents
  ipcMain.on('styles:preview', (e, p: { prop: string; value: string }) => {
    if (!fromMainOrPanel(e)) return
    previewView?.webContents.send('styles:preview', p)
  })
  ipcMain.on('styles:clear-preview', (e, p?: { prop?: string }) => {
    if (!fromMainOrPanel(e)) return
    previewView?.webContents.send('styles:clear-preview', p)
  })
  ipcMain.on('styles:replay', (e, p: { prop: string; from: string; to: string }) => {
    if (!fromMainOrPanel(e)) return
    previewView?.webContents.send('styles:replay', p)
  })

  // Fresh computed values from the selection. The preview preload is sandboxed
  // (no contextBridge; executeJavaScript can't reach its isolated world), so
  // reads are a request-id round trip over IPC: send `styles:read` {id, props},
  // await the matching `styles:read-reply` {id, values, declaredVars}. A 500ms
  // timeout guards a dead/navigating preview — null means no preview / no
  // selection / timeout. `declaredVars` is the proof half (see
  // `preview/style-provenance.ts`) that lets the panel tell a property's value
  // IS a token from it merely equalling one.
  let styleReadSeq = 0
  const pendingStyleReads = new Map<number, (result: StyleReadResult | null) => void>()
  ipcMain.on(
    'styles:read-reply',
    (
      e,
      p: {
        id?: unknown
        values?: Record<string, string> | null
        declaredVars?: Record<string, string | null> | null
        specified?: Record<string, string> | null
      }
    ) => {
      if (e.sender !== previewView?.webContents) return
      const resolve = typeof p?.id === 'number' ? pendingStyleReads.get(p.id) : undefined
      resolve?.(
        p.values
          ? { values: p.values, declaredVars: p.declaredVars ?? {}, specified: p.specified ?? {} }
          : null
      )
    }
  )
  ipcMain.handle(
    'styles:read',
    (e, props: string[]): Promise<StyleReadResult | null> | null => {
      if (!fromMainOrPanel(e) || !previewView || !Array.isArray(props)) return null
      const id = ++styleReadSeq
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingStyleReads.delete(id)
          resolve(null)
        }, 500)
        pendingStyleReads.set(id, (result) => {
          clearTimeout(timer)
          pendingStyleReads.delete(id)
          resolve(result)
        })
        previewView?.webContents.send('styles:read', { id, props })
      })
    }
  )

  // v3 annotation pins: renderer pushes the list → preview; clicks come back.
  ipcMain.on('preview:set-annotations', (_e, pins: { id: string; selector: string }[]) => {
    annotationPins = Array.isArray(pins) ? pins : []
    previewView?.webContents.send(PREVIEW_SET_PINS, annotationPins)
  })
  ipcMain.on(PREVIEW_PIN_CLICK, (e, id: string) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('annotations:pin-click', id)
  })

  // Readiness probe (stamp count) → renderer, to drive the setup offer.
  ipcMain.on(PREVIEW_READINESS, (e, info: { stamps: number }) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('preview:readiness', info)
  })

  // Inline text edit committed in the preview → renderer (which applies it).
  ipcMain.on(PREVIEW_TEXT_EDIT, (e, edit: { source: string; text: string }) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('preview:text-edit', edit)
  })

  // Inline commenting (C/Y): renderer arms the mode → preview.
  ipcMain.handle('preview:set-comment-mode', (_e, mode: 'comment' | 'annotate' | null) => {
    commentModeActive = mode
    if (mode) selectModeActive = false // mutually exclusive with select
    previewView?.webContents.send(PREVIEW_SET_COMMENT_MODE, mode)
  })
  // Preview echoes keyboard-initiated mode changes → renderer (toolbar mirror).
  ipcMain.on(PREVIEW_COMMENT_MODE, (e, mode: 'comment' | 'annotate' | null) => {
    if (e.sender !== previewView?.webContents) return
    commentModeActive = mode
    sendToMain('preview:comment-mode', mode)
  })
  // A submitted comment/annotation (element + text) → renderer (agent vs pin).
  ipcMain.on(
    PREVIEW_COMMENT,
    (
      e,
      payload: {
        kind: 'comment' | 'annotate'
        el: SelectedElement
        text: string
      }
    ) => {
      if (e.sender !== previewView?.webContents) return
      sendToMain('preview:comment', payload)
    }
  )

  // ── Layers panel ─────────────────────────────────────────────────────────
  const fromMainForLayers = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    e.sender === mainWindow?.webContents

  // Bulk DOM-tree read: request-id round trip, same shape as styles:read — the
  // preview preload is sandboxed, so a bulk read of its isolated world can only
  // ever be this kind of message-passing round trip, never executeJavaScript.
  let layersReadSeq = 0
  const pendingLayersReads = new Map<number, (snapshot: unknown) => void>()
  ipcMain.on(LAYERS_READ_REPLY, (e, p: { id?: unknown; snapshot?: unknown }) => {
    if (e.sender !== previewView?.webContents) return
    const resolve = typeof p?.id === 'number' ? pendingLayersReads.get(p.id) : undefined
    resolve?.(p?.snapshot ?? null)
  })
  ipcMain.handle('layers:read', (e): Promise<unknown> | null => {
    if (!fromMainForLayers(e) || !previewView) return null
    const id = ++layersReadSeq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingLayersReads.delete(id)
        resolve(null)
      }, 800)
      pendingLayersReads.set(id, (snapshot) => {
        clearTimeout(timer)
        pendingLayersReads.delete(id)
        resolve(snapshot)
      })
      previewView?.webContents.send(LAYERS_READ, { id })
    })
  })
  ipcMain.on('layers:select', (e, p: { path: number[]; fingerprint: unknown }) => {
    if (!fromMainForLayers(e)) return
    previewView?.webContents.send(LAYERS_SELECT, p)
  })
  ipcMain.on('layers:hover', (e, p: { path: number[]; fingerprint: unknown } | null) => {
    if (!fromMainForLayers(e)) return
    previewView?.webContents.send(LAYERS_HOVER, p)
  })
  ipcMain.on('layers:set-watch', (e, on: boolean) => {
    if (!fromMainForLayers(e)) return
    layersWatchActive = !!on
    previewView?.webContents.send(LAYERS_SET_WATCH, layersWatchActive)
  })
  // Debounced structural-change ping from the preload → renderer (the renderer
  // decides whether/when to re-`layers:read`).
  ipcMain.on(LAYERS_CHANGED, (e) => {
    if (e.sender !== previewView?.webContents) return
    sendToMain('layers:changed')
  })
  // Drag-to-reorder: writes real source for a same-parent sibling move;
  // anything ambiguous reports `needsAgent` instead (see move-node.ts).
  ipcMain.handle('layers:move', (e, root: string, req: MoveNodeRequest) => {
    if (!fromMainForLayers(e)) return null
    return applyMoveNode(root, req)
  })

  ipcMain.handle('project:pick', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open a project'
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  // New project: a save dialog picks the folder-to-create, then the scaffold
  // writes a minimal Vite+React app, git-inits it, and installs dependencies.
  ipcMain.handle('project:pick-new', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'New project',
      buttonLabel: 'Create',
      nameFieldLabel: 'Project name',
      defaultPath: 'my-app',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return res.canceled ? null : (res.filePath ?? null)
  })
  ipcMain.handle('project:create', (_e, root: string) => createProject(root))
}

// Dev-mode CDP endpoint: run `bun run dev`, then open chrome://inspect in a real
// Chrome browser to attach full DevTools to the chat window and the native preview
// WebContentsView (each shows up as its own target). Gated on the same electron-vite
// dev signal used in createWindow (loadURL vs loadFile), so a built/packaged app
// never opens the port.
if (process.env['ELECTRON_RENDERER_URL']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['PRAXIS_DEBUG_PORT'] ?? '9222')
}

app.whenReady().then(() => {
  // macOS dock icon comes from the bundle's .icns (scripts/patch-electron.mjs
  // installs ours into the dev Electron.app). Do NOT app.dock.setIcon() here:
  // runtime dock images skip the system's icon treatment on macOS 26, so they
  // render oversized next to other dock icons.
  createWindow()
  buildAppMenu()

  // A system sleep/wake cycle can reset the GPU process without the main
  // renderer ever firing 'render-process-gone' — it just goes quietly stale.
  // Nudge a repaint on resume; harmless no-op if the frame was already fine.
  powerMonitor.on('resume', () => {
    // The window may have been closed (app stays alive on macOS) or its renderer
    // killed while asleep — either way its webContents is destroyed, and a bare
    // .invalidate() would throw an uncaught "Object has been destroyed" on wake.
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.invalidate()
  })
  // File → Open Recent is driven by the renderer's recents store: it pushes the
  // current list, we cap at 8 and rebuild the menu.
  ipcMain.on('menu:set-recents', (_e, recents: RecentMenuEntry[]) => {
    recentProjects = Array.isArray(recents)
      ? recents
          .filter((r) => r && typeof r.root === 'string' && typeof r.name === 'string')
          .slice(0, 8)
      : []
    buildAppMenu()
  })
  // Edit → Undo/Redo bounced back from the main renderer: it received the
  // menu:action, saw a text field focused, and wants the NATIVE text-editing
  // command it would have gotten by default — which the custom menu item's
  // accelerator swallowed (see buildAppMenu's editCommand).
  ipcMain.on('menu:native-edit', (e, cmd: 'undo' | 'redo') => {
    if (e.sender !== mainWindow?.webContents) return
    if (cmd === 'undo') mainWindow.webContents.undo()
    else if (cmd === 'redo') mainWindow.webContents.redo()
  })
  registerPreviewIpc()
  registerEditorIpc()
  registerDevServerIpc(() => mainWindow)
  registerSimulatorIpc(() => mainWindow)
  registerAgentIpc(() => mainWindow)
  registerPropsIpc()
  registerStylesIpc()
  registerControlsIpc()
  registerAnnotationsIpc()
  registerGithubIpc()
  registerTokensIpc()
  registerSetupIpc()
  ipcMain.handle('git:ensure', (_e, root: string) => ensureBranch(root))
  ipcMain.handle('git:set', (_e, root: string, name: string) => switchBranch(root, name))
  ipcMain.handle('git:list', (_e, root: string) => listBranches(root))
  ipcMain.handle('git:checkout', (_e, root: string, branch: string) => checkoutBranch(root, branch))
  ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false)
  registerDiagnoseIpc()
  registerUpdateIpc(() => mainWindow)
  registerFeedbackIpc(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
