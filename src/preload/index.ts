import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  AgentOptions,
  Annotation,
  AnnotationInput,
  Bounds,
  BranchResult,
  CommentMode,
  ControlPanelManifest,
  DetectedProject,
  DevServerInfo,
  Diagnosis,
  FeedbackInput,
  FeedbackResult,
  Framework,
  GithubConnectOptions,
  GithubConnectResult,
  GithubStatus,
  ImageAttachment,
  LayerFingerprint,
  LayersSnapshot,
  MoveNodeRequest,
  MoveNodeResult,
  PanelAction,
  PanelState,
  PermissionMode,
  PraxisApi,
  PreviewComment,
  PropEdit,
  PropEditResult,
  PropInspection,
  PublishResult,
  QuestionAnswers,
  RecentMenuEntry,
  ResolvedControlPanel,
  RunningDevServer,
  RunningSimulator,
  SelectedElement,
  SessionRecord,
  SetupProbe,
  SetupResult,
  SimPreflight,
  SourceView,
  SourceWriteResult,
  StyleEdit,
  StyleEditResult,
  StyleReadResult,
  TokenEdit,
  TokenScaffoldResult,
  TokenSet,
  UndoResult,
  UpdateStatus,
  WorkspaceSnapshot
} from '../shared/api'

const api: PraxisApi = {
  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: string): void => cb(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  // Electron 43 dropped File.path; webUtils.getPathForFile recovers a
  // dropped/selected file's real on-disk path (must run in the preload — the
  // File is passed across the contextBridge). Empty string for pathless blobs.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  window: {
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, fullscreen: boolean): void => cb(fullscreen)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.removeListener('window:fullscreen', listener)
    }
  },
  menu: {
    setRecents: (recents: RecentMenuEntry[]): void =>
      ipcRenderer.send('menu:set-recents', recents),
    onOpenRecent: (cb: (root: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, root: string): void => cb(root)
      ipcRenderer.on('menu:open-recent', listener)
      return () => ipcRenderer.removeListener('menu:open-recent', listener)
    },
    nativeEdit: (cmd: 'undo' | 'redo'): void => ipcRenderer.send('menu:native-edit', cmd)
  },
  preview: {
    setBounds: (bounds: Bounds): void => ipcRenderer.send('preview:set-bounds', bounds),
    load: (url: string): Promise<void> => ipcRenderer.invoke('preview:load', url),
    reset: (): Promise<void> => ipcRenderer.invoke('preview:reset'),
    setDragging: (active: boolean): void => ipcRenderer.send('preview:set-dragging', active),
    setSelectMode: (active: boolean): Promise<void> =>
      ipcRenderer.invoke('preview:set-select-mode', active),
    onElementPicked: (cb: (el: SelectedElement) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, el: SelectedElement): void => cb(el)
      ipcRenderer.on('preview:element-picked', listener)
      return () => ipcRenderer.removeListener('preview:element-picked', listener)
    },
    onSelectCancelled: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('preview:select-cancelled', listener)
      return () => ipcRenderer.removeListener('preview:select-cancelled', listener)
    },
    setAnnotations: (pins: { id: string; selector: string }[]): void =>
      ipcRenderer.send('preview:set-annotations', pins),
    /** Toggle the in-page iPhone bezel overlay (mobile viewport). */
    setFrame: (active: boolean): void => ipcRenderer.send('preview:set-frame', active),
    /** Drop the in-preview selection toolbar (pill removed / message sent). */
    clearSelected: (): void => ipcRenderer.send('preview:clear-selected'),
    /** Launch progress shown inside the preview (bottom pill); null clears. */
    setStatus: (text: string | null): void => ipcRenderer.send('preview:set-status', text),
    /** Fires when S is pressed inside the focused preview (toggle select). */
    onToggleSelect: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('preview:toggle-select', listener)
      return () => ipcRenderer.removeListener('preview:toggle-select', listener)
    },
    /** Fires when the preview navigates (link clicks, SPA routes) — full URL. */
    onUrlChanged: (cb: (url: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, url: string): void => cb(url)
      ipcRenderer.on('preview:url-changed', listener)
      return () => ipcRenderer.removeListener('preview:url-changed', listener)
    },
    /** Selection-toolbar actions that resolve in the renderer (code / delete). */
    onToolbarAction: (cb: (kind: 'code' | 'delete' | 'props') => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, kind: 'code' | 'delete' | 'props'): void => cb(kind)
      ipcRenderer.on('preview:toolbar-action', listener)
      return () => ipcRenderer.removeListener('preview:toolbar-action', listener)
    },
    /** Snapshot the live preview (freeze-frame under overlay UI). */
    capture: (): Promise<string | null> => ipcRenderer.invoke('preview:capture'),
    /** Fires after the previewed app loads, with whether it's source-stamped. */
    onReadiness: (cb: (info: { stamps: number }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, info: { stamps: number }): void => cb(info)
      ipcRenderer.on('preview:readiness', listener)
      return () => ipcRenderer.removeListener('preview:readiness', listener)
    },
    onTextEdit: (cb: (edit: { source: string; text: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, edit: { source: string; text: string }): void =>
        cb(edit)
      ipcRenderer.on('preview:text-edit', listener)
      return () => ipcRenderer.removeListener('preview:text-edit', listener)
    },
    setCommentMode: (mode: CommentMode): Promise<void> =>
      ipcRenderer.invoke('preview:set-comment-mode', mode),
    onCommentMode: (cb: (mode: CommentMode) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, mode: CommentMode): void => cb(mode)
      ipcRenderer.on('preview:comment-mode', listener)
      return () => ipcRenderer.removeListener('preview:comment-mode', listener)
    },
    onComment: (cb: (c: PreviewComment) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, c: PreviewComment): void => cb(c)
      ipcRenderer.on('preview:comment', listener)
      return () => ipcRenderer.removeListener('preview:comment', listener)
    }
  },
  panel: {
    show: (bounds: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('panel:show', bounds),
    hide: (): void => ipcRenderer.send('panel:hide'),
    setState: (state: PanelState): void => ipcRenderer.send('panel:state', state),
    onState: (cb: (state: PanelState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: PanelState): void => cb(state)
      ipcRenderer.on('panel:state', listener)
      return () => ipcRenderer.removeListener('panel:state', listener)
    },
    action: (action: PanelAction): void => ipcRenderer.send('panel:action', action),
    onAction: (cb: (action: PanelAction) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, action: PanelAction): void => cb(action)
      ipcRenderer.on('panel:action', listener)
      return () => ipcRenderer.removeListener('panel:action', listener)
    },
    reportSize: (size: { width: number; height: number }): void =>
      ipcRenderer.send('panel:size', size),
    onSize: (cb: (size: { width: number; height: number }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, size: { width: number; height: number }): void =>
        cb(size)
      ipcRenderer.on('panel:size', listener)
      return () => ipcRenderer.removeListener('panel:size', listener)
    }
  },
  project: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
    detect: (root: string): Promise<DetectedProject> => ipcRenderer.invoke('project:detect', root),
    pickNew: (): Promise<string | null> => ipcRenderer.invoke('project:pick-new'),
    create: (root: string): Promise<{ ok: boolean; root?: string; error?: string }> =>
      ipcRenderer.invoke('project:create', root)
  },
  devServer: {
    start: (opts: {
      root: string
      command: string
      framework?: Framework
    }): Promise<RunningDevServer> => ipcRenderer.invoke('devserver:start', opts),
    stop: (root: string): Promise<void> => ipcRenderer.invoke('devserver:stop', root),
    isRunning: (root: string): Promise<boolean> => ipcRenderer.invoke('devserver:running', root),
    info: (root: string): Promise<DevServerInfo> => ipcRenderer.invoke('devserver:info', root),
    onLog: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('devserver:log', listener)
      return () => ipcRenderer.removeListener('devserver:log', listener)
    }
  },
  git: {
    ensure: (root: string): Promise<BranchResult> => ipcRenderer.invoke('git:ensure', root),
    set: (root: string, name: string): Promise<BranchResult> =>
      ipcRenderer.invoke('git:set', root, name),
    list: (root: string): Promise<{ branches: string[]; current: string | null }> =>
      ipcRenderer.invoke('git:list', root),
    checkout: (root: string, branch: string): Promise<BranchResult> =>
      ipcRenderer.invoke('git:checkout', root, branch)
  },
  diagnose: {
    run: (root: string, error: string, context?: string): Promise<Diagnosis | null> =>
      ipcRenderer.invoke('diagnose:run', root, error, context),
    record: (root: string, signature: string, status: 'applied' | 'dismissed'): Promise<void> =>
      ipcRenderer.invoke('diagnose:record', root, signature, status)
  },
  simulator: {
    preflight: (): Promise<SimPreflight> => ipcRenderer.invoke('simulator:preflight'),
    start: (opts: { root: string; command?: string; udid?: string }): Promise<RunningSimulator> =>
      ipcRenderer.invoke('simulator:start', opts),
    stop: (): Promise<void> => ipcRenderer.invoke('simulator:stop'),
    // Phase 3: arm/disarm element-select (a tap then becomes a source pick).
    setSelectMode: (active: boolean): Promise<void> =>
      ipcRenderer.invoke('simulator:set-select-mode', active),
    onLog: (cb: (line: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('simulator:log', listener)
      return () => ipcRenderer.removeListener('simulator:log', listener)
    },
    onElementPicked: (cb: (pick: { source: string; tag: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, pick: { source: string; tag: string }): void =>
        cb(pick)
      ipcRenderer.on('simulator:element-picked', listener)
      return () => ipcRenderer.removeListener('simulator:element-picked', listener)
    }
  },
  props: {
    inspect: (root: string, source: string, text?: string | null): Promise<PropInspection | null> =>
      ipcRenderer.invoke('props:inspect', root, source, text),
    apply: (root: string, edit: PropEdit): Promise<PropEditResult> =>
      ipcRenderer.invoke('props:apply', root, edit),
    applyToken: (root: string, edit: TokenEdit): Promise<PropEditResult> =>
      ipcRenderer.invoke('props:applyToken', root, edit),
    remove: (root: string, source: string, name: string): Promise<PropEditResult> =>
      ipcRenderer.invoke('props:remove', root, source, name)
  },
  text: {
    apply: (root: string, edit: { source: string; text: string }): Promise<PropEditResult> =>
      ipcRenderer.invoke('text:apply', root, edit)
  },
  styles: {
    apply: (root: string, edit: StyleEdit): Promise<StyleEditResult> =>
      ipcRenderer.invoke('styles:apply', root, edit),
    preview: (prop: string, value: string): void =>
      ipcRenderer.send('styles:preview', { prop, value }),
    clearPreview: (prop?: string): void => ipcRenderer.send('styles:clear-preview', { prop }),
    read: (props: string[]): Promise<StyleReadResult | null> =>
      ipcRenderer.invoke('styles:read', props),
    replay: (prop: string, from: string, to: string): void =>
      ipcRenderer.send('styles:replay', { prop, from, to })
  },
  layers: {
    read: (): Promise<LayersSnapshot | null> => ipcRenderer.invoke('layers:read'),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('layers:changed', listener)
      return () => ipcRenderer.removeListener('layers:changed', listener)
    },
    select: (path: number[], fingerprint: LayerFingerprint): void =>
      ipcRenderer.send('layers:select', { path, fingerprint }),
    hover: (path: number[] | null, fingerprint: LayerFingerprint | null): void =>
      ipcRenderer.send('layers:hover', path && fingerprint ? { path, fingerprint } : null),
    setWatch: (on: boolean): void => ipcRenderer.send('layers:set-watch', on),
    move: (root: string, req: MoveNodeRequest): Promise<MoveNodeResult> =>
      ipcRenderer.invoke('layers:move', root, req)
  },
  controls: {
    get: (root: string, q: { files: string[]; component?: string }): Promise<ResolvedControlPanel[]> =>
      ipcRenderer.invoke('controls:get', root, q),
    list: (root: string): Promise<ControlPanelManifest[]> =>
      ipcRenderer.invoke('controls:list', root),
    remove: (root: string, id: string): Promise<void> =>
      ipcRenderer.invoke('controls:remove', root, id),
    applyLiteral: (
      root: string,
      panelId: string,
      paramId: string,
      value: string | number | boolean
    ): Promise<StyleEditResult> =>
      ipcRenderer.invoke('controls:apply-literal', root, panelId, paramId, value),
    onUpdated: (cb: (root: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: { root: string }): void => cb(payload.root)
      ipcRenderer.on('controls:updated', listener)
      return () => ipcRenderer.removeListener('controls:updated', listener)
    }
  },
  source: {
    read: (root: string, source: string): Promise<SourceView | null> =>
      ipcRenderer.invoke('source:read', root, source),
    resolveComponent: (root: string, fromFile: string, name: string): Promise<string | null> =>
      ipcRenderer.invoke('source:resolve-component', root, fromFile, name),
    openInEditor: (root: string, source: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('source:open-in-editor', root, source),
    write: (
      root: string,
      source: string,
      baseline: string,
      content: string
    ): Promise<SourceWriteResult> =>
      ipcRenderer.invoke('source:write', root, source, baseline, content),
    popout: (root: string, source: string): Promise<void> =>
      ipcRenderer.invoke('source:popout', root, source),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('source:close-window'),
    tree: (root: string): Promise<string[]> => ipcRenderer.invoke('source:tree', root),
    onNavigate: (cb: (source: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, source: string): void => cb(source)
      ipcRenderer.on('editor:navigate', listener)
      return () => ipcRenderer.removeListener('editor:navigate', listener)
    }
  },
  edits: {
    undo: (root: string): Promise<UndoResult> => ipcRenderer.invoke('edit:undo', root),
    redo: (root: string): Promise<UndoResult> => ipcRenderer.invoke('edit:redo', root),
    can: (root: string): Promise<{ undo: boolean; redo: boolean }> =>
      ipcRenderer.invoke('edit:can', root),
    revert: (root: string, group: string): Promise<UndoResult> =>
      ipcRenderer.invoke('edit:revert', root, group),
    canRevert: (root: string, group: string): Promise<boolean> =>
      ipcRenderer.invoke('edit:can-revert', root, group)
  },
  tokens: {
    detect: (root: string): Promise<TokenSet> => ipcRenderer.invoke('tokens:detect', root),
    scaffold: (root: string): Promise<TokenScaffoldResult> =>
      ipcRenderer.invoke('tokens:scaffold', root)
  },
  annotations: {
    list: (root: string): Promise<Annotation[]> => ipcRenderer.invoke('annotations:list', root),
    add: (root: string, input: AnnotationInput): Promise<Annotation[]> =>
      ipcRenderer.invoke('annotations:add', root, input),
    remove: (root: string, id: string): Promise<Annotation[]> =>
      ipcRenderer.invoke('annotations:remove', root, id),
    onPinClick: (cb: (id: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string): void => cb(id)
      ipcRenderer.on('annotations:pin-click', listener)
      return () => ipcRenderer.removeListener('annotations:pin-click', listener)
    }
  },
  publish: {
    toPr: (root: string, opts: { title: string }): Promise<PublishResult> =>
      ipcRenderer.invoke('publish:to-pr', root, opts),
    ship: (root: string, summary?: string[], mode?: 'merge' | 'pr'): Promise<PublishResult> =>
      ipcRenderer.invoke('publish:ship', root, summary, mode)
  },
  github: {
    status: (root: string): Promise<GithubStatus> => ipcRenderer.invoke('github:status', root),
    connect: (root: string, opts: GithubConnectOptions): Promise<GithubConnectResult> =>
      ipcRenderer.invoke('github:connect', root, opts)
  },
  setup: {
    detect: (root: string): Promise<SetupProbe> => ipcRenderer.invoke('setup:detect', root),
    scaffold: (root: string): Promise<SetupResult> => ipcRenderer.invoke('setup:scaffold', root),
    uninstall: (root: string): Promise<SetupResult> => ipcRenderer.invoke('setup:uninstall', root)
  },
  agent: {
    openProject: (root: string, options?: AgentOptions): Promise<void> =>
      ipcRenderer.invoke('agent:open-project', root, options),
    closeProject: (root: string): Promise<void> =>
      ipcRenderer.invoke('agent:close-project', root),
    setActive: (root: string, sessionKey?: string): Promise<void> =>
      ipcRenderer.invoke('agent:set-active', root, sessionKey),
    isOpen: (root: string): Promise<boolean> => ipcRenderer.invoke('agent:is-open', root),
    newChat: (
      root: string,
      options?: AgentOptions
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> =>
      ipcRenderer.invoke('agent:new-chat', root, options),
    restartChat: (
      root: string,
      sessionKey: string,
      options?: AgentOptions
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:restart-chat', root, sessionKey, options),
    resumeSession: (
      root: string,
      recordId: string,
      options?: AgentOptions
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> =>
      ipcRenderer.invoke('agent:resume-session', root, recordId, options),
    closeChat: (
      root: string,
      sessionKey: string
    ): Promise<{ ok: boolean; remaining: string[]; activeSessionKey: string | null }> =>
      ipcRenderer.invoke('agent:close-chat', root, sessionKey),
    send: (text: string, images?: ImageAttachment[]): Promise<void> =>
      ipcRenderer.invoke('agent:send', text, images),
    setModel: (model: string): Promise<void> => ipcRenderer.invoke('agent:set-model', model),
    setPermissionMode: (mode: PermissionMode): Promise<void> =>
      ipcRenderer.invoke('agent:set-permission-mode', mode),
    respondPermission: (id: string, behavior: 'allow' | 'deny'): Promise<void> =>
      ipcRenderer.invoke('agent:respond-permission', id, behavior),
    respondQuestion: (id: string, answers: QuestionAnswers | null): Promise<void> =>
      ipcRenderer.invoke('agent:respond-question', id, answers),
    interrupt: (): Promise<void> => ipcRenderer.invoke('agent:interrupt'),
    tagSession: (root: string, tag: { branch?: string; prUrl?: string }): Promise<void> =>
      ipcRenderer.invoke('agent:tag-session', root, tag),
    spawnComment: (
      root: string,
      text: string,
      options?: AgentOptions
    ): Promise<{ ok: boolean; spawnId?: string; branch?: string; queued?: boolean; reason?: string }> =>
      ipcRenderer.invoke('agent:spawn-comment', root, text, options),
    spawnInterrupt: (spawnId: string): Promise<void> =>
      ipcRenderer.invoke('agent:spawn-interrupt', spawnId),
    spawnApply: (
      root: string,
      branch: string
    ): Promise<{ ok: boolean; conflict?: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:spawn-apply', root, branch),
    spawnDiscard: (root: string, branch: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('agent:spawn-discard', root, branch),
    spawnPr: (
      root: string,
      branch: string,
      title: string,
      recordId: string
    ): Promise<{ ok: boolean; prUrl?: string; error?: string }> =>
      ipcRenderer.invoke('agent:spawn-pr', root, branch, title, recordId),
    resolveConflict: (): Promise<{ ok: boolean; conflicted: string[]; prompt?: string; error?: string }> =>
      ipcRenderer.invoke('agent:resolve-conflict'),
    discardConflict: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('agent:discard-conflict'),
    onEvent: (cb: (event: AgentEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, event: AgentEvent): void => cb(event)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    },
    workspaceSnapshot: (): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke('agent:workspace-snapshot')
  },
  sessions: {
    list: (root: string): Promise<SessionRecord[]> => ipcRenderer.invoke('sessions:list', root),
    get: (id: string): Promise<SessionRecord | null> => ipcRenderer.invoke('sessions:get', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id)
  },
  feedback: {
    capture: (): Promise<string | null> => ipcRenderer.invoke('feedback:capture'),
    submit: (input: FeedbackInput): Promise<FeedbackResult> =>
      ipcRenderer.invoke('feedback:submit', input)
  },
  update: {
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.removeListener('update:status', listener)
    },
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    apply: (): Promise<void> => ipcRenderer.invoke('update:apply')
  }
}

contextBridge.exposeInMainWorld('api', api)
