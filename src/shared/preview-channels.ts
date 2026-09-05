/**
 * Channel names for the main ⇄ preview-preload conversation.
 *
 * These are the ONLY IPC channels that don't go through `shared/api.ts`'s typed
 * `PraxisApi` bridge: the preview preload is sandboxed (bare `ipcRenderer`, no
 * contextBridge), so main and `src/preview/preload.ts` talk in raw channel
 * strings. Both sides used to hand-declare their own copy of every string —
 * twenty-odd literals mirrored by eye, where a single typo silently disables a
 * feature rather than failing anything. Declare them once, here, so a rename is
 * a compile-time concern on both sides.
 *
 * Direction is noted per constant: "→ preload" = main sends, "→ main" = the
 * preload sends (and main re-checks `e.sender` before trusting it — the
 * previewed page is untrusted content).
 */

// ── Element selection / overlay ────────────────────────────────────────────
export const PREVIEW_SET_MODE = 'praxis:preview:set-select-mode' // → preload (boolean)
export const PREVIEW_PICKED = 'praxis:preview:element-picked' // → main (SelectedElement)
export const PREVIEW_CANCELLED = 'praxis:preview:select-cancelled' // → main
export const PREVIEW_TOGGLE_SELECT = 'praxis:preview:toggle-select' // → main (S pressed)
export const PREVIEW_TOOLBAR_ACTION = 'praxis:preview:toolbar-action' // → main (code/delete/props)
export const PREVIEW_CLEAR_SELECTED = 'praxis:preview:clear-selected' // → preload (pill ×, send)
export const PREVIEW_READINESS = 'praxis:preview:readiness' // → main ({stamps})
export const PREVIEW_TEXT_EDIT = 'praxis:preview:text-edit' // → main ({source, text})

// ── Annotation pins ────────────────────────────────────────────────────────
export const PREVIEW_SET_PINS = 'praxis:preview:set-annotations' // → preload (pin list)
export const PREVIEW_PIN_CLICK = 'praxis:preview:pin-click' // → main (pin id)

// ── Inline commenting (C / Y) ──────────────────────────────────────────────
export const PREVIEW_SET_COMMENT_MODE = 'praxis:preview:set-comment-mode' // → preload
export const PREVIEW_COMMENT_MODE = 'praxis:preview:comment-mode' // → main (keyboard-initiated)
export const PREVIEW_COMMENT = 'praxis:preview:comment' // → main (submitted)

// ── Chrome drawn inside the preview ────────────────────────────────────────
export const PREVIEW_SET_FRAME = 'praxis:preview:set-frame' // → preload (mobile bezel)
export const PREVIEW_SET_STATUS = 'praxis:preview:set-status' // → preload (launch pill)

// ── Styles tab ─────────────────────────────────────────────────────────────
export const STYLES_PREVIEW = 'styles:preview' // → preload ({prop, value})
export const STYLES_CLEAR_PREVIEW = 'styles:clear-preview' // → preload ({prop?})
export const STYLES_REPLAY = 'styles:replay' // → preload ({prop, from, to})
export const STYLES_READ = 'styles:read' // → preload ({id, props})
export const STYLES_READ_REPLY = 'styles:read-reply' // → main ({id, values|null, …})

// ── Layers panel ───────────────────────────────────────────────────────────
export const LAYERS_READ = 'layers:read' // → preload ({id})
export const LAYERS_READ_REPLY = 'layers:read-reply' // → main ({id, snapshot})
export const LAYERS_CHANGED = 'layers:changed' // → main (debounced mutation ping)
export const LAYERS_SELECT = 'layers:select' // → preload ({path, fingerprint})
export const LAYERS_HOVER = 'layers:hover' // → preload ({path, fingerprint} | null)
export const LAYERS_SET_WATCH = 'layers:set-watch' // → preload (boolean)

export const PREVIEW_MOVE_NODE = 'praxis:preview:move-node' // → main (MoveNodeRequest)
