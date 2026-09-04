import type { PraxisApi } from '../../shared/api'

type WebConfig = {
  root: string
  rpcPath: string
  eventsPath: string
  previewToken: string
}

type EventListener = (payload: unknown) => void

const listeners = new Map<string, Set<EventListener>>()

function emit(channel: string, payload?: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}

function on<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener: EventListener = (payload) => cb(payload as T)
    const set = listeners.get(channel) ?? new Set<EventListener>()
    set.add(listener)
    listeners.set(channel, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(channel)
    }
  }
}

function previewFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('#praxis-web-preview')
}

/** Install the HTTP/WebSocket implementation before the shared React entry renders. */
export function installWebApi(config: WebConfig): void {
  let nextRequest = 1
  let previewOrigin: string | null = null

  const postPreview = (type: string, payload?: unknown): void => {
    if (!previewOrigin) return
    previewFrame()?.contentWindow?.postMessage(
      { source: 'praxis-control', token: config.previewToken, type, payload },
      previewOrigin
    )
  }

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await fetch(config.rpcPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: nextRequest++, channel, args })
    })
    const body = (await response.json()) as { ok: boolean; result?: T; error?: string }
    if (!response.ok || !body.ok) throw new Error(body.error || `Praxis command failed: ${channel}`)
    return body.result as T
  }

  const send = (channel: string, ...args: unknown[]): void => {
    void invoke(channel, ...args).catch((error) => {
      emit('web:error', error instanceof Error ? error.message : String(error))
    })
  }

  const connectEvents = (): void => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}${config.eventsPath}`)
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { channel?: string; payload?: unknown }
        if (typeof message.channel === 'string') emit(message.channel, message.payload)
      } catch {
        // A malformed event is isolated to this frame; reconnect remains healthy.
      }
    })
    socket.addEventListener('close', () => setTimeout(connectEvents, 1000))
  }
  connectEvents()

  window.addEventListener('message', (event) => {
    const frame = previewFrame()
    if (
      !frame ||
      !previewOrigin ||
      event.source !== frame.contentWindow ||
      event.origin !== previewOrigin
    ) {
      return
    }
    const message = event.data as {
      source?: string
      token?: string
      type?: string
      payload?: unknown
    }
    if (message?.source !== 'praxis-preview' || message.token !== config.previewToken) return
    switch (message.type) {
      case 'ready':
        emit('preview:readiness', message.payload)
        break
      case 'element-picked':
        emit('preview:element-picked', message.payload)
        break
      case 'select-cancelled':
        emit('preview:select-cancelled')
        break
      case 'toggle-select':
        emit('preview:toggle-select')
        break
      case 'url-changed':
        emit('preview:url-changed', message.payload)
        break
    }
  })

  const unavailable = async <T>(name: string): Promise<T> => {
    throw new Error(`${name} is not available in the first browser preview.`)
  }

  const api: PraxisApi = {
    onMenuAction: on('menu:action'),
    pathForFile: () => '',
    window: {
      isFullscreen: async () => false,
      onFullscreenChange: on('window:fullscreen')
    },
    menu: {
      setRecents: (recents) => send('menu:set-recents', recents),
      onOpenRecent: on('menu:open-recent'),
      nativeEdit: () => {}
    },
    preview: {
      setBounds: () => {},
      load: async (url) => {
        const result = await invoke<{ gatewayUrl: string }>('preview:load', url)
        previewOrigin = new URL(result.gatewayUrl).origin
        window.dispatchEvent(
          new CustomEvent('praxis:web-preview', { detail: { url: result.gatewayUrl } })
        )
      },
      reset: async () => {
        await invoke('preview:reset')
        previewOrigin = null
        window.dispatchEvent(new CustomEvent('praxis:web-preview', { detail: { url: null } }))
      },
      setDragging: (active) => {
        const frame = previewFrame()
        if (frame) frame.style.visibility = active ? 'hidden' : 'visible'
      },
      setSelectMode: async (active) => postPreview('set-select-mode', active),
      onElementPicked: on('preview:element-picked'),
      onSelectCancelled: on('preview:select-cancelled'),
      setAnnotations: (pins) => postPreview('set-annotations', pins),
      setFrame: (active) => postPreview('set-frame', active),
      clearSelected: () => postPreview('clear-selected'),
      setStatus: (text) => postPreview('set-status', text),
      onToggleSelect: on('preview:toggle-select'),
      onUrlChanged: on('preview:url-changed'),
      onToolbarAction: on('preview:toolbar-action'),
      capture: async () => null,
      onReadiness: on('preview:readiness'),
      onTextEdit: on('preview:text-edit'),
      setCommentMode: async (mode) => postPreview('set-comment-mode', mode),
      onCommentMode: on('preview:comment-mode'),
      onComment: on('preview:comment')
    },
    panel: {
      show: () => {},
      hide: () => {},
      setState: () => {},
      onState: on('panel:state'),
      requestState: () => {},
      action: (action) => emit('panel:action', action),
      onAction: on('panel:action'),
      reportSize: (size) => emit('panel:size', size),
      onSize: on('panel:size')
    },
    project: {
      pick: async () => config.root,
      detect: (root) => invoke('project:detect', root),
      icon: (root) => invoke('project:icon', root),
      pickNew: async () => null,
      create: async () => ({ ok: false, error: 'Create projects from the host machine for now.' })
    },
    devServer: {
      start: (opts) => invoke('devserver:start', opts),
      stop: (root) => invoke('devserver:stop', root),
      isRunning: (root) => invoke('devserver:running', root),
      info: (root) => invoke('devserver:info', root),
      onLog: on('devserver:log')
    },
    git: {
      ensure: (root) => invoke('git:ensure', root),
      set: (root, name) => invoke('git:set', root, name),
      list: (root) => invoke('git:list', root),
      checkout: (root, branch) => invoke('git:checkout', root, branch)
    },
    diagnose: {
      run: async () => null,
      record: async () => {}
    },
    simulator: {
      preflight: () => invoke('simulator:preflight'),
      start: () => unavailable('iOS Simulator'),
      stop: async () => {},
      setSelectMode: async () => {},
      onLog: on('simulator:log'),
      onElementPicked: on('simulator:element-picked')
    },
    props: {
      inspect: (root, source, text) => invoke('props:inspect', root, source, text),
      apply: (root, edit) => invoke('props:apply', root, edit),
      applyToken: (root, edit) => invoke('props:applyToken', root, edit),
      remove: (root, source, name) => invoke('props:remove', root, source, name)
    },
    text: {
      apply: (root, edit) => invoke('text:apply', root, edit)
    },
    styles: {
      apply: (root, edit) => invoke('styles:apply', root, edit),
      preview: (prop, value) => postPreview('styles-preview', { prop, value }),
      clearPreview: (prop) => postPreview('styles-clear-preview', { prop }),
      read: () => unavailable('Computed style inspection'),
      replay: (prop, from, to) => postPreview('styles-replay', { prop, from, to })
    },
    layers: {
      read: () => unavailable('Layers'),
      onChanged: on('layers:changed'),
      select: (path, fingerprint) => postPreview('layers-select', { path, fingerprint }),
      hover: (path, fingerprint) => postPreview('layers-hover', { path, fingerprint }),
      setWatch: (watch) => postPreview('layers-watch', watch),
      move: (root, request) => invoke('layers:move', root, request)
    },
    controls: {
      get: async () => [],
      list: async () => [],
      remove: async () => {},
      applyLiteral: (root, panelId, paramId, value) =>
        invoke('controls:apply-literal', root, panelId, paramId, value),
      onUpdated: on<{ root: string }>(
        'controls:updated'
      ) as unknown as PraxisApi['controls']['onUpdated']
    },
    source: {
      read: (root, source) => invoke('source:read', root, source),
      resolveComponent: (root, fromFile, name) =>
        invoke('source:resolve-component', root, fromFile, name),
      openInEditor: async () => ({ ok: false, error: 'Open the file on the host machine.' }),
      write: (root, source, baseline, content) =>
        invoke('source:write', root, source, baseline, content),
      popout: async () => {},
      closeWindow: async () => {},
      tree: (root) => invoke('source:tree', root),
      createFile: (root, path) => invoke('source:create-file', root, path),
      renameFile: (root, from, to) => invoke('source:rename-file', root, from, to),
      deleteFile: (root, path) => invoke('source:delete-file', root, path),
      onNavigate: on('editor:navigate')
    },
    edits: {
      undo: (root) => invoke('edit:undo', root),
      redo: (root) => invoke('edit:redo', root),
      can: async () => ({ undo: false, redo: false }),
      revert: (root, group) => invoke('edit:revert', root, group),
      canRevert: (root, group) => invoke('edit:can-revert', root, group)
    },
    tokens: {
      detect: () => Promise.resolve({ source: 'none', groups: [] }),
      scaffold: (root) => invoke('tokens:scaffold', root)
    },
    annotations: {
      list: async () => [],
      add: (root, input) => invoke('annotations:add', root, input),
      remove: (root, id) => invoke('annotations:remove', root, id),
      onPinClick: on('annotations:pin-click')
    },
    publish: {
      toPr: (root, options) => invoke('publish:to-pr', root, options),
      ship: (root, summary, mode) => invoke('publish:ship', root, summary, mode)
    },
    github: {
      status: (root) => invoke('github:status', root),
      connect: (root, options) => invoke('github:connect', root, options)
    },
    setup: {
      detect: async () => ({ framework: 'unknown', canInstrument: false }),
      scaffold: (root) => invoke('setup:scaffold', root),
      uninstall: (root) => invoke('setup:uninstall', root)
    },
    agent: {
      openProject: (root, options) => invoke('agent:open-project', root, options),
      closeProject: (root) => invoke('agent:close-project', root),
      setActive: (root, sessionKey) => invoke('agent:set-active', root, sessionKey),
      isOpen: (root) => invoke('agent:is-open', root),
      newChat: (root, options) => invoke('agent:new-chat', root, options),
      restartChat: (root, sessionKey, options) =>
        invoke('agent:restart-chat', root, sessionKey, options),
      clearMainContext: (root) => invoke('agent:clear-main-context', root),
      resumeSession: (root, recordId, options) =>
        invoke('agent:resume-session', root, recordId, options),
      closeChat: (root, sessionKey) => invoke('agent:close-chat', root, sessionKey),
      renameChat: (sessionKey, title) => invoke('agent:rename-chat', sessionKey, title),
      send: (text, images) => invoke('agent:send', text, images),
      saveAttachment: (image, name) => invoke('attachments:save', image, name),
      setModel: (model) => invoke('agent:set-model', model),
      setPermissionMode: (mode) => invoke('agent:set-permission-mode', mode),
      respondPermission: (id, behavior) => invoke('agent:respond-permission', id, behavior),
      respondQuestion: (id, answers) => invoke('agent:respond-question', id, answers),
      interrupt: () => invoke('agent:interrupt'),
      tagSession: (root, tag) => invoke('agent:tag-session', root, tag),
      spawnComment: (root, text, parent, options, origin) =>
        invoke('agent:spawn-comment', root, text, parent, options, origin),
      spawnInterrupt: (id) => invoke('agent:spawn-interrupt', id),
      spawnApply: (root, branch) => invoke('agent:spawn-apply', root, branch),
      spawnDiscard: (root, branch) => invoke('agent:spawn-discard', root, branch),
      spawnPr: (root, branch, title, recordId) =>
        invoke('agent:spawn-pr', root, branch, title, recordId),
      resolveConflict: () => invoke('agent:resolve-conflict'),
      discardConflict: () => invoke('agent:discard-conflict'),
      onEvent: on('agent:event'),
      workspaceSnapshot: () => invoke('agent:workspace-snapshot')
    },
    projectMemory: {
      get: (root) => invoke('project-memory:get', root),
      set: (root, content) => invoke('project-memory:set', root, content)
    },
    providers: {
      list: () => invoke('providers:list'),
      save: (input) => invoke('providers:save', input),
      remove: (id) => invoke('providers:remove', id),
      catalog: (input) => invoke('providers:catalog', input),
      choices: () => invoke('providers:choices')
    },
    sessions: {
      list: (root) => invoke('sessions:list', root),
      get: (id) => invoke('sessions:get', id),
      rename: (id, title) => invoke('sessions:rename', id, title),
      remove: (id) => invoke('sessions:remove', id)
    },
    feedback: {
      capture: async () => null,
      submit: () => unavailable('Feedback submission')
    },
    update: {
      onStatus: on('update:status'),
      check: async () => ({ status: 'idle', behind: 0 }),
      apply: () => unavailable('Self-update')
    }
  }

  window.api = api
}

export type { WebConfig }
