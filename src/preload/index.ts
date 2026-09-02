import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  AgentOptions,
  Annotation,
  AnnotationInput,
  BackgroundSpawnOrigin,
  Bounds,
  BranchResult,
  CommentMode,
  ControlPanelManifest,
  DetectedProject,
  DevServerInfo,
  Diagnosis,
  FeedbackInput,
  FeedbackResult,
  FileOpResult,
  Framework,
  GithubConnectOptions,
  GithubConnectResult,
  GithubStatus,
  ImageAttachment,
  LayerFingerprint,
  LayersSnapshot,
  ModelCatalogInput,
  ModelCatalogResult,
  ModelChoice,
  MoveNodeRequest,
  MoveNodeResult,
  OpenProjectResult,
  PanelAction,
  PanelState,
  PermissionMode,
  PraxisApi,
  PreviewComment,
  ProjectCreateResult,
  ProjectIcon,
  ProjectMemory,
  PropEdit,
  PropEditResult,
  PropInspection,
  ProviderConnection,
  ProviderConnectionInput,
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
  SimElementPick,
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

/**
 * Subscribe to a main→renderer push channel; returns the unsubscribe. Every
 * `on…` getter on `PraxisApi` used to hand-roll this same 4-line
 * listener/removeListener pair (~24 times) — forgetting the `removeListener`
 * in the returned closure was an easy, silent leak. `on<T>(channel)` returns
 * a ready-made subscribe function so each call site below is a one-liner;
 * the optional `map` lets a channel whose raw IPC payload isn't quite the
 * shape the API promises (e.g. `controls:updated`) still be a one-liner.
 */
function on<TRaw, T = TRaw>(
  channel: string,
  map?: (raw: TRaw) => T
): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_e: IpcRendererEvent, raw: TRaw): void => cb(map ? map(raw) : (raw as unknown as T))
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: PraxisApi = {
  onMenuAction: on<string>('menu:action'),
  // Electron 43 dropped File.path; webUtils.getPathForFile recovers a
  // dropped/selected file's real on-disk path (must run in the preload — the
  // File is passed across the contextBridge). Empty string for pathless blobs.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  window: {
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChange: on<boolean>('window:fullscreen')
  },
  menu: {
    setRecents: (recents: RecentMenuEntry[]): void =>
      ipcRenderer.send('menu:set-recents', recents),
    onOpenRecent: on<string>('menu:open-recent'),
    nativeEdit: (cmd: 'undo' | 'redo'): void => ipcRenderer.send('menu:native-edit', cmd)
  },
  preview: {
    setBounds: (bounds: Bounds): void => ipcRenderer.send('preview:set-bounds', bounds),
    load: (url: string): Promise<void> => ipcRenderer.invoke('preview:load', url),
    reset: (): Promise<void> => ipcRenderer.invoke('preview:reset'),
    setDragging: (active: boolean): void => ipcRenderer.send('preview:set-dragging', active),
    setSelectMode: (active: boolean): Promise<void> =>
      ipcRenderer.invoke('preview:set-select-mode', active),
    onElementPicked: on<SelectedElement>('preview:element-picked'),
    onSelectCancelled: on<void>('preview:select-cancelled'),
    setAnnotations: (pins: { id: string; selector: string }[]): void =>
      ipcRenderer.send('preview:set-annotations', pins),
    /** Toggle the in-page iPhone bezel overlay (mobile viewport). */
    setFrame: (active: boolean): void => ipcRenderer.send('preview:set-frame', active),
    /** Drop the in-preview selection toolbar (pill removed / message sent). */
    clearSelected: (): void => ipcRenderer.send('preview:clear-selected'),
    /** Launch progress shown inside the preview (bottom pill); null clears. */
    setStatus: (text: string | null): void => ipcRenderer.send('preview:set-status', text),
    /** Fires when S is pressed inside the focused preview (toggle select). */
    onToggleSelect: on<void>('preview:toggle-select'),
    /** Fires when the preview navigates (link clicks, SPA routes) — full URL. */
    onUrlChanged: on<string>('preview:url-changed'),
    /** Selection-toolbar actions that resolve in the renderer (code / delete). */
    onToolbarAction: on<'code' | 'delete' | 'props'>('preview:toolbar-action'),
    /** Snapshot the live preview (freeze-frame under overlay UI). */
    capture: (): Promise<string | null> => ipcRenderer.invoke('preview:capture'),
    /** Fires after the previewed app loads, with whether it's source-stamped. */
    onReadiness: on<{ stamps: number }>('preview:readiness'),
    onTextEdit: on<{ source: string; text: string }>('preview:text-edit'),
    setCommentMode: (mode: CommentMode): Promise<void> =>
      ipcRenderer.invoke('preview:set-comment-mode', mode),
    onCommentMode: on<CommentMode>('preview:comment-mode'),
    onComment: on<PreviewComment>('preview:comment')
  },
  panel: {
    show: (bounds: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('panel:show', bounds),
    hide: (): void => ipcRenderer.send('panel:hide'),
    setState: (state: PanelState): void => ipcRenderer.send('panel:state', state),
    onState: on<PanelState>('panel:state'),
    requestState: (): void => ipcRenderer.send('panel:request-state'),
    action: (action: PanelAction): void => ipcRenderer.send('panel:action', action),
    onAction: on<PanelAction>('panel:action'),
    reportSize: (size: { width: number; height: number }): void =>
      ipcRenderer.send('panel:size', size),
    onSize: on<{ width: number; height: number }>('panel:size')
  },
  project: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
    detect: (root: string): Promise<DetectedProject> => ipcRenderer.invoke('project:detect', root),
    icon: (root: string): Promise<ProjectIcon | null> => ipcRenderer.invoke('project:icon', root),
    pickNew: (): Promise<string | null> => ipcRenderer.invoke('project:pick-new'),
    create: (root: string): Promise<ProjectCreateResult> => ipcRenderer.invoke('project:create', root)
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
    onLog: on<string>('devserver:log')
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
    onLog: on<string>('simulator:log'),
    onElementPicked: on<SimElementPick>('simulator:element-picked')
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
    onChanged: on<void>('layers:changed'),
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
    onUpdated: on<{ root: string }, string>('controls:updated', (payload) => payload.root)
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
    createFile: (root: string, path: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('source:create-file', root, path),
    renameFile: (root: string, from: string, to: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('source:rename-file', root, from, to),
    deleteFile: (root: string, path: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('source:delete-file', root, path),
    onNavigate: on<string>('editor:navigate')
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
    onPinClick: on<string>('annotations:pin-click')
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
    openProject: (root: string, options?: AgentOptions): Promise<OpenProjectResult> =>
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
    clearMainContext: (root: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:clear-main-context', root),
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
    renameChat: (
      sessionKey: string,
      title: string
    ): Promise<{ ok: boolean; title?: string; error?: string }> =>
      ipcRenderer.invoke('agent:rename-chat', sessionKey, title),
    send: (text: string, images?: ImageAttachment[]): Promise<void> =>
      ipcRenderer.invoke('agent:send', text, images),
    saveAttachment: (image: ImageAttachment, name?: string): Promise<string> =>
      ipcRenderer.invoke('attachments:save', image, name),
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
      parentSessionKey: string,
      options?: AgentOptions,
      origin?: BackgroundSpawnOrigin
    ): Promise<{ ok: boolean; spawnId?: string; branch?: string; queued?: boolean; reason?: string }> =>
      ipcRenderer.invoke('agent:spawn-comment', root, text, parentSessionKey, options, origin),
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
    onEvent: on<AgentEvent>('agent:event'),
    workspaceSnapshot: (): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke('agent:workspace-snapshot')
  },
  projectMemory: {
    get: (root: string): Promise<ProjectMemory> => ipcRenderer.invoke('project-memory:get', root),
    set: (root: string, content: string): Promise<ProjectMemory> =>
      ipcRenderer.invoke('project-memory:set', root, content)
  },
  providers: {
    list: (): Promise<ProviderConnection[]> => ipcRenderer.invoke('providers:list'),
    save: (
      input: ProviderConnectionInput
    ): Promise<{ ok: boolean; connection?: ProviderConnection; error?: string }> =>
      ipcRenderer.invoke('providers:save', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('providers:remove', id),
    catalog: (input: ModelCatalogInput): Promise<ModelCatalogResult> =>
      ipcRenderer.invoke('providers:catalog', input),
    choices: (): Promise<ModelChoice[]> => ipcRenderer.invoke('providers:choices')
  },
  sessions: {
    list: (root: string): Promise<SessionRecord[]> => ipcRenderer.invoke('sessions:list', root),
    get: (id: string): Promise<SessionRecord | null> => ipcRenderer.invoke('sessions:get', id),
    rename: (
      id: string,
      title: string
    ): Promise<{ ok: boolean; title?: string; error?: string }> =>
      ipcRenderer.invoke('sessions:rename', id, title),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id)
  },
  feedback: {
    capture: (): Promise<string | null> => ipcRenderer.invoke('feedback:capture'),
    submit: (input: FeedbackInput): Promise<FeedbackResult> =>
      ipcRenderer.invoke('feedback:submit', input)
  },
  update: {
    onStatus: on<UpdateStatus>('update:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    apply: (): Promise<void> => ipcRenderer.invoke('update:apply')
  }
}

contextBridge.exposeInMainWorld('api', api)
