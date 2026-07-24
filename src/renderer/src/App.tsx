import { useEffect, useRef, useState } from 'react'
import ChatPanel from './components/ChatPanel'
import CatLoader from './components/CatLoader'
import ConsolePanel from './components/ConsolePanel'
import DiagnoseCard from './components/DiagnoseCard'
import PreviewPane from './components/PreviewPane'
import PanelHost from './components/PanelHost'
import PreviewUrl from './components/PreviewUrl'
import CodeDrawer from './components/CodeDrawer'
import SessionReview from './components/SessionReview'
import FeedbackDialog from './components/FeedbackDialog'
import ConnectDialog from './components/ConnectDialog'
import {
  describeSelectionForPrompt,
  chatAgentSettingsFor,
  isAuthError,
  messagesFromTranscript,
  oneLine,
  toAgentOptions,
  useAnnotations,
  useChat,
  useComposer,
  useDiagnosis,
  useHistory,
  useLog,
  usePermissions,
  useQuestions,
  useSelection,
  useSession,
  useSetup,
  useSpawns,
  useTokens,
  useUiActions,
  useUpdate,
  usePropsIsland,
  useViewport,
  usePreviewFreeze,
  openWithPreviewFreeze,
  usePublishMode,
  useGithub,
  useRecents,
  usePanelInset,
  useCodeDrawer,
  useWorkspace,
  usePreviewLocation,
  type ProjectEntry
} from './store'
import { projectKey } from '../../shared/projectKey'
import { controlsPrompt } from './lib/controls-prompt'
import { restoreWorkspace, type RestoreDeps } from './restore'
import { MonitorSmartphone, PanelLeft } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import Rail from './components/Rail'
import type {
  CommentMode,
  Framework,
  PreviewComment,
  PreviewKind,
  ResolvedControlPanel,
  SessionRecord
} from '../../shared/api'

const MIN_CHAT_WIDTH = 320
const MAX_CHAT_WIDTH = 760

/** A `data-praxis-source` stamp's repo-relative file ("path/File.tsx:12:3" →
 *  "path/File.tsx") — control-panel manifests are keyed by file, not line. */
const fileOf = (stamp: string): string => stamp.replace(/:\d+(?::\d+)?$/, '')

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'running'; name: string; url: string }
  | { kind: 'error'; message: string }

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [log, setLog] = useState('')
  const [chatWidth, setChatWidth] = useState(440)
  const dragging = useRef(false)
  // The project a pending diagnosis belongs to (projectRoot is cleared on failure).
  const diagRoot = useRef<string | null>(null)
  // When a launch fails we remember the folder so the user can retry with a
  // custom command (monorepos, non-standard dev scripts).
  const [retry, setRetry] = useState<{ root: string; command: string } | null>(null)
  // How to relaunch the current preview (root + resolved dev command + framework
  // + previewKind), so we can restart the right backend after a setup/config turn.
  const launchSpec = useRef<{
    root: string
    command: string
    framework?: Framework
    previewKind: PreviewKind
  } | null>(null)
  // Web dev server vs iOS Simulator — drives which affordances show (e.g. Select).
  const [previewKind, setPreviewKind] = useState<PreviewKind>('web')
  const [publishing, setPublishing] = useState(false)
  const viewport = useViewport((s) => s.viewport)
  const publishMode = usePublishMode((s) => s.mode)
  const githubStatus = useGithub((s) => s.status)
  const recents = useRecents((s) => s.recents)
  // Boot restore deps (App closures), kept current for the once-on-mount effect.
  const restoreDepsRef = useRef<RestoreDeps | null>(null)
  // Latest action handlers, for the global keydown + native-menu listeners (which
  // subscribe once but must call the current closures).
  const actionsRef = useRef<{
    toggleSelect: () => void
    stop: () => void
    openProject: () => void
    newProject: () => void
    openRecent: (root: string) => void
    reload: () => void
    publish: () => void
  }>({
    toggleSelect: () => {},
    stop: () => {},
    openProject: () => {},
    newProject: () => {},
    openRecent: () => {},
    reload: () => {},
    publish: () => {}
  })

  const { selectMode, setSelectMode, setSelected } = useSelection()
  const selected = useSelection((s) => s.selected)
  const inspection = useSelection((s) => s.inspection)
  const inspecting = useSelection((s) => s.inspecting)
  const propsIslandOpen = usePropsIsland((s) => s.open)
  const projectRoot = useSession((s) => s.projectRoot)
  const drawerSource = useCodeDrawer((s) => s.source)

  // Custom Controls (v10): the selection's AI-surfaced panels, fetched here
  // (the island is stateless — PanelHost pushes these inside panel:state).
  // Re-fetched on selection/component/project change, on controls:updated
  // (the agent's define_controls tool saved a manifest), and on agent `done`
  // (a turn's worktree auto-merge may have landed the instrumented source).
  const [islandControls, setIslandControls] = useState<ResolvedControlPanel[] | null>(null)
  // Latest fetch wins — a slow response for a previous selection must not
  // overwrite the current one's panels.
  const controlsSeqRef = useRef(0)
  const islandControlsRef = useRef<ResolvedControlPanel[] | null>(null)
  islandControlsRef.current = islandControls
  const fetchControls = async (): Promise<void> => {
    const root = useSession.getState().projectRoot
    const sel = useSelection.getState()
    const el = sel.selected
    const seq = ++controlsSeqRef.current
    // Two-stamp file match: the element's own source file OR its component
    // call site's — panels surface whether the user picked the instance or a
    // plain DOM element inside it.
    const files = el
      ? [...new Set([el.source, el.componentSource].filter((s): s is string => !!s).map(fileOf))]
      : []
    if (!root || files.length === 0) {
      setIslandControls(null)
      return
    }
    try {
      const res = await window.api.controls.get(root, {
        files,
        component: sel.inspection?.component
      })
      if (seq === controlsSeqRef.current) setIslandControls(res)
    } catch {
      if (seq === controlsSeqRef.current) setIslandControls(null)
    }
  }
  // Once-mounted subscriptions (onUpdated, agent onEvent) call through the ref
  // so they see the current closure — the actionsRef pattern.
  const fetchControlsRef = useRef(fetchControls)
  fetchControlsRef.current = fetchControls
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch keys on the selection, the inspected component, and the project — nothing else.
  useEffect(() => {
    void fetchControlsRef.current()
  }, [selected, inspection?.component, projectRoot])
  useEffect(
    () =>
      window.api.controls.onUpdated((root) => {
        if (root === useSession.getState().projectRoot) void fetchControlsRef.current()
      }),
    []
  )
  const openCount = useWorkspace((s) => s.projects.length)
  const railCollapsed = useWorkspace((s) => s.collapsed)
  const branch = useSession((s) => s.branch)
  const [editingBranch, setEditingBranch] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  // Overlay menus are CONTROLLED and wait for the preview freeze-frame to be
  // ready before opening — otherwise they render behind the native view for the
  // capture's ~80ms and then "pop" fully visible when it hides (read: flicker).
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [pubMenuOpen, setPubMenuOpen] = useState(false)
  const openWithFreeze = (setOpen: (b: boolean) => void): void =>
    openWithPreviewFreeze(() => setOpen(true))
  const closeWithFreeze = (setOpen: (b: boolean) => void): void => {
    setOpen(false)
    usePreviewFreeze.getState().setFrozen(false)
  }
  // v5-D: the past session open for review (rendered as a modal over the panes).
  const [reviewing, setReviewing] = useState<SessionRecord | null>(null)
  // The review modal is renderer DOM; the native preview WebContentsView paints
  // ABOVE it (same reason PropPanel reserves an inset strip). Freeze-frame the
  // preview while the modal is open — the snapshot <img> keeps it visually in
  // place under the modal instead of blanking the pane — and restore the live
  // view on close. Open through `openReview` (below) so the modal, like the
  // dropdowns, waits for the freeze before rendering (no behind-the-native flash).
  useEffect(() => {
    if (!reviewing) usePreviewFreeze.getState().setFrozen(false)
  }, [reviewing])
  const openReview = (record: SessionRecord): void =>
    openWithFreeze((open) => {
      if (open) setReviewing(record)
    })
  // The code drawer holds one project's source stamp — close it when the active
  // project changes so it can't read a stale path against the new root.
  useEffect(() => {
    useCodeDrawer.getState().close()
  }, [projectRoot])
  const authNeeded = useSession((s) => s.authNeeded)
  const setAuthNeeded = useSession((s) => s.setAuthNeeded)
  const logOpen = useLog((s) => s.open)

  // Rename / switch the working branch (name is coerced to praxis/<…> in main).
  const changeBranch = async (name: string): Promise<void> => {
    setEditingBranch(false)
    const root = useSession.getState().projectRoot
    if (!root || !name.trim() || name.trim() === branch) return
    const res = await window.api.git.set(root, name.trim())
    useSession.getState().setBranch(res.branch)
    // Keep the workspace entry's branch current for rail switch-back.
    useWorkspace.getState().patchEntry(projectKey(root), { branch: res.branch })
    // Tag the live session so its history record records the branch it worked on.
    if (res.branch) void window.api.agent.tagSession(root, { branch: res.branch })
    if (res.branch) {
      useLog
        .getState()
        .append(`Switched to branch ${res.branch}${res.created ? ' (created)' : ''}`, 'success')
    }
    if (res.error) useLog.getState().append(`Couldn't switch branch: ${res.error}`, 'error')
  }

  // Load the branch list for the pill's dropdown (on open).
  const loadBranches = (): void => {
    const root = useSession.getState().projectRoot
    if (root) void window.api.git.list(root).then((r) => setBranches(r.branches))
  }
  // Check out an EXISTING branch by exact name (the dropdown) — no praxis/ coercion.
  const switchToBranch = async (b: string): Promise<void> => {
    const root = useSession.getState().projectRoot
    if (!root || b === branch) return
    setSelected(null)
    const res = await window.api.git.checkout(root, b)
    if (res.error) {
      useLog.getState().append(`Couldn't switch to ${b}: ${res.error}`, 'error')
      return
    }
    useSession.getState().setBranch(res.branch)
    useWorkspace.getState().patchEntry(projectKey(root), { branch: res.branch })
    if (res.branch) void window.api.agent.tagSession(root, { branch: res.branch })
    useLog.getState().append(`Switched to branch ${res.branch ?? b}`, 'success')
  }

  useEffect(
    () =>
      window.api.devServer.onLog((line) => {
        setLog(line)
        useLog.getState().append(line, 'server')
      }),
    []
  )

  // Simulator lifecycle logs (boot / Metro / app launch) → same activity console.
  useEffect(
    () =>
      window.api.simulator.onLog((line) => {
        setLog(line)
        useLog.getState().append(line, 'server')
      }),
    []
  )

  // Self-update status (startup check, periodic, and apply progress) → the
  // update banner reads straight off the store; App just relays the pushes.
  useEffect(() => window.api.update.onStatus(useUpdate.getState().setStatus), [])

  // Capture the SDK's advertised slash commands for the "/" menu, and drive the
  // first-run onboarding banner: raise it on an auth failure, and clear it the
  // moment the agent makes progress (the user fixed auth and a turn is flowing).
  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        // v8 F1: detached comment-spawn events (tagged sessionId) must NOT touch the
        // interactive session UI — a spawn's init `commands` would overwrite the
        // active project's slash menu, and its auth-ish error would raise the
        // onboarding banner over a healthy session. ChatPanel guards its own listener;
        // this one needs the same guard since main broadcasts to both.
        if (event.sessionId) return
        const session = useSession.getState()
        if (event.type === 'commands') {
          session.setSlashCommands(event.commands)
        } else if (event.type === 'error') {
          // The worktree merges back on error too ("salvage interrupted edits",
          // agent.ts), so an errored turn can still have landed instrumented
          // source + a manifest on the live tree. Re-resolve like `done` does.
          void fetchControlsRef.current()
          if (isAuthError(event.message)) {
            // The onboarding banner is Claude-specific (setup-token / claude login);
            // Codex gets its own inline `codex login` hint. Raise whichever matches
            // the active backend — never the Claude banner for a Codex failure. (v7)
            if ((session.provider ?? 'claude') === 'claude') session.setAuthNeeded(true)
            else if (session.provider === 'codex') session.setCodexAuthNeeded(true)
          }
        } else if (event.type === 'delta' || event.type === 'done') {
          // A finished turn may have merged instrumented source + a fresh
          // control-panel manifest back to the live tree — re-resolve the
          // island's Custom tab against it. (Custom Controls, v10)
          if (event.type === 'done') void fetchControlsRef.current()
          // A turn that streamed/finished proves we're connected — clear the
          // Claude banner (its backend only emits `done` on success).
          if (session.authNeeded) session.setAuthNeeded(false)
          // Codex emits `done` after EVERY turn — including a failed auth turn,
          // right after the `error` that raised the hint — so `done` must NOT
          // clear it (that would wipe the hint the instant it appears). Only real
          // streamed output (`delta`) proves Codex actually connected.
          if (event.type === 'delta' && session.codexAuthNeeded)
            session.setCodexAuthNeeded(false)
        } else if (event.type === 'permission-request') {
          usePermissions.getState().addRequest(event.request)
        } else if (event.type === 'permission-resolved') {
          usePermissions.getState().removeRequest(event.id)
        } else if (event.type === 'question-request') {
          useQuestions.getState().addRequest(event.request)
        } else if (event.type === 'question-resolved') {
          useQuestions.getState().removeRequest(event.id)
        }
      }),
    []
  )

  // v2: receive element picks / cancellations from the preview overlay. Escape
  // cancels the mode *and* clears the pick, matching the toggle-off behaviour.
  useEffect(() => {
    const offPicked = window.api.preview.onElementPicked((el) => setSelected(el))
    const offCancel = window.api.preview.onSelectCancelled(() => {
      setSelectMode(false)
      setSelected(null)
    })
    // Phase 3: a simulator pick (idb hit-test → RN testID → source) maps to the
    // same SelectedElement seam, so the Inspector + props.inspect flow is reused.
    const offSimPicked = window.api.simulator.onElementPicked((pick) =>
      setSelected({
        tag: pick.tag,
        id: null,
        classes: [],
        selector: pick.tag,
        source: pick.source,
        componentSource: null, // RN component-instance resolution is a follow-up
        text: null,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    )
    return () => {
      offPicked()
      offCancel()
      offSimPicked()
    }
  }, [setSelected, setSelectMode])

  // Inline comment (C) / annotation (Y) modes. Mirror keyboard-initiated mode
  // changes from the preview into the toolbar, and route a submitted comment to
  // the agent (C) or to an annotation pin (Y).
  useEffect(() => {
    const offMode = window.api.preview.onCommentMode((m) =>
      useSelection.getState().setCommentMode(m)
    )
    const offComment = window.api.preview.onComment((c: PreviewComment) => {
      if (c.kind === 'comment') {
        // The element ref is page-derived (sanitized in describeSelectionForPrompt);
        // the comment is the user's own text — cap it so it can't bloat the prompt.
        const prompt = describeSelectionForPrompt(c.el) + oneLine(c.text, 2000)
        const root = useSession.getState().projectRoot
        // v8 F1: dispatch the comment as a DETACHED parallel agent (its own git
        // worktree) instead of hijacking the active chat — so the user can fire
        // several and keep working. A non-repo project can't worktree → fall back
        // to seeding the composer (the prior behavior).
        if (root) {
          void window.api.agent
            .spawnComment(root, prompt, toAgentOptions(useSession.getState()))
            .then((r) => {
              if (r.ok && r.spawnId) {
                useSpawns.getState().add(projectKey(root), {
                  id: r.spawnId,
                  branch: r.branch ?? null,
                  label: oneLine(c.text, 60),
                  status: r.queued ? 'queued' : 'running'
                })
              } else {
                useComposer.getState().setSubmit(prompt)
              }
            })
            .catch(() => useComposer.getState().setSubmit(prompt))
        } else {
          useComposer.getState().setSubmit(prompt)
        }
      } else {
        const root = useSession.getState().projectRoot
        if (!root) {
          // Near-unreachable (the preview only exists with a project), but don't
          // drop the note silently if the click lands before the session is ready.
          useLog.getState().append(`Open a project before annotating — "${oneLine(c.text, 80)}"`, 'error')
          return
        }
        void window.api.annotations
          .add(root, {
            source: c.el.source,
            selector: c.el.selector,
            tag: c.el.tag,
            text: c.text
          })
          .then((list) => useAnnotations.getState().setList(list))
      }
    })
    return () => {
      offMode()
      offComment()
    }
  }, [])

  // Global S/Escape shortcuts when focus is on the app side (the preview's own
  // preload handles them when the preview is focused). S is ignored while typing;
  // Escape turns off select mode even from the composer, so it always disarms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        // Escape disarms whichever mode is on — checked before the typing guard so
        // it still fires while the chat composer (a textarea) holds focus.
        if (useSelection.getState().commentMode) {
          e.preventDefault()
          useSelection.getState().setCommentMode(null)
          void window.api.preview.setCommentMode(null)
        } else if (useSelection.getState().selectMode) {
          e.preventDefault()
          actionsRef.current.toggleSelect()
        }
        return
      }
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return
      if ((e.key === 's' || e.key === 'S') && useSession.getState().projectRoot) {
        // S toggles element-select (when a preview is open). The native menu's
        // Cmd+Shift+S covers the case where the preview itself has focus.
        e.preventDefault()
        actionsRef.current.toggleSelect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Native "Actions" menu commands (main → renderer). Subscribed once; calls the
  // latest handlers via actionsRef. Reload is handled in main (reloads the preview).
  useEffect(
    () =>
      window.api.onMenuAction((action) => {
        if (action === 'reload') actionsRef.current.reload()
        else if (action === 'select') actionsRef.current.toggleSelect()
        else if (action === 'stop') actionsRef.current.stop()
        else if (action === 'open-project') actionsRef.current.openProject()
        else if (action === 'new-project') actionsRef.current.newProject()
        else if (action === 'clear-recents') useRecents.getState().clearRecents()
        else if (action === 'logs') useLog.getState().setOpen(!useLog.getState().open)
        else if (action === 'publish') actionsRef.current.publish()
        else if (action === 'viewport:desktop') useViewport.getState().setViewport('desktop')
        else if (action === 'viewport:mobile') useViewport.getState().setViewport('mobile')
      }),
    []
  )

  // File → Open Recent: mirror the renderer's recents into the native menu, and
  // reopen whichever one the user picks (keeping the current project warm).
  useEffect(
    () =>
      window.api.menu.onOpenRecent((root) => actionsRef.current.openRecent(root)),
    []
  )
  useEffect(() => {
    window.api.menu.setRecents(recents.slice(0, 8).map((r) => ({ root: r.root, name: r.name })))
  }, [recents])

  // v8 F3b: Cmd+Z / Cmd+Shift+Z (or Cmd+Y) undo/redo over ALL direct praxis source
  // edits (props, text, token swaps). Skipped while typing in the composer or any
  // field — there the OS/browser native undo for that input should win. After a
  // revert we re-inspect the selected element so the panel reflects the new source,
  // and surface a conflict (the file changed under us) instead of silently failing.
  useEffect(() => {
    const reinspect = (): void => {
      const sel = useSelection.getState()
      const src = sel.selected?.source
      const root = useSession.getState().projectRoot
      if (!src || !root) return
      void window.api.props.inspect(root, src).then((res) => {
        if (useSelection.getState().selected?.source === src) sel.setInspection(res)
      })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const isUndo = k === 'z' && !e.shiftKey
      const isRedo = (k === 'z' && e.shiftKey) || k === 'y'
      if (!isUndo && !isRedo) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return
      const root = useSession.getState().projectRoot
      if (!root) return
      e.preventDefault()
      void (isUndo ? window.api.edits.undo(root) : window.api.edits.redo(root)).then((r) => {
        if (r.empty) return
        if (r.conflict) {
          setStatus({
            kind: 'error',
            message: `Couldn't ${isUndo ? 'undo' : 'redo'} — ${r.file ?? 'the file'} changed on disk. Open it to reconcile.`
          })
          return
        }
        reinspect()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Inspect the selected element's props (decides panel vs prompt-only). Guarded
  // against a fast re-select racing a slow inspect.
  useEffect(() => {
    const sel = useSelection.getState()
    if (!selected?.source || !projectRoot) {
      sel.setInspection(null)
      return
    }
    let live = true
    sel.setInspecting(true)
    const src = selected.source
    // Pass the clicked text so the Svelte path can content-match the click to the
    // concrete component instance (v8 F3a-svelte) rather than a definition default.
    window.api.props
      .inspect(projectRoot, src, selected.text)
      .then((res) => {
        // Only apply if this is still the selected element.
        if (!live || useSelection.getState().selected?.source !== src) return
        // If the inspection redirected to a concrete instance (Svelte content-match),
        // adopt that source — the effect re-runs and inspects the instance directly
        // (stable: an instance returns its own source), keeping undo/redo + token
        // refresh on the instance. Otherwise show the inspection as-is.
        if (res && res.source !== src) {
          const cur = useSelection.getState().selected
          if (cur) useSelection.getState().setSelected({ ...cur, source: res.source })
          return
        }
        sel.setInspection(res)
      })
      .finally(() => live && useSelection.getState().setInspecting(false))
    return () => {
      live = false
    }
  }, [selected, projectRoot])

  // On-open readiness: if the previewed app has no source stamps, offer setup.
  // When `verifying` is armed (a setup was just applied + the preview reloaded),
  // this report is the proof the instrumentation actually fired — don't report
  // silent success: zero stamps after a setup is a hard warning (fix #4).
  useEffect(
    () =>
      window.api.preview.onReadiness(({ stamps }) => {
        const s = useSetup.getState()
        if (s.verifying) {
          if (stamps > 0) {
            s.setStatus(`Setup verified — ${stamps} element(s) now mapped to source. You're ready.`)
            s.setNeeded(false)
          } else {
            s.setStatus(
              'Setup ran but no elements got stamped — the instrumentation did not fire. ' +
                'Check that the config wiring landed (and the dev server restarted), or ask me to look.'
            )
          }
          s.setVerifying(false)
          return
        }
        if (stamps === 0 && !s.dismissed && !s.busy) s.setNeeded(true)
        else if (stamps > 0) s.setNeeded(false)
      }),
    []
  )

  // The setup turn finished → restart the dev server + reload the preview so the
  // freshly-wired config applies (one-shot: consume the signal, then restart).
  const restartRequested = useSetup((s) => s.restartRequested)
  useEffect(() => {
    if (!restartRequested) return
    useSetup.getState().setRestartRequested(false)
    void restartPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartRequested])

  // Inline text edits committed in the preview → write to source (or hand
  // expression/mixed content to the agent).
  useEffect(
    () =>
      window.api.preview.onTextEdit((edit) => {
        const root = useSession.getState().projectRoot
        if (!root) return
        const toAgent = (): void =>
          useComposer.getState().setSeed(`In ${edit.source}, set the element's text to “${edit.text}”.`)
        // A non-literal change (needsAgent) OR a write failure both route to the
        // agent so the user's edit is never silently dropped.
        void window.api.text
          .apply(root, edit)
          .then((res) => {
            if (!res.applied) toAgent()
          })
          .catch(toAgent)
      }),
    []
  )

  // v3: clicking an annotation pin in the preview focuses its note.
  useEffect(
    () => window.api.annotations.onPinClick((id) => useAnnotations.getState().setFocused(id)),
    []
  )

  // Native fullscreen hides the macOS traffic lights, so the floating sidebar
  // toggle re-aligns to the window's left edge (see `.sidebar-toggle` +
  // `body.is-fullscreen` in styles.css). Mirror the state onto <body>.
  useEffect(() => {
    const apply = (fullscreen: boolean): void => {
      document.body.classList.toggle('is-fullscreen', fullscreen)
    }
    window.api.window.isFullscreen().then(apply)
    return window.api.window.onFullscreenChange(apply)
  }, [])

  // Keep the preview's pins in sync with the notes.
  const notes = useAnnotations((s) => s.list)
  useEffect(() => {
    window.api.preview.setAnnotations(notes.map((n) => ({ id: n.id, selector: n.selector })))
  }, [notes])

  // Drag-to-resize the split. The native preview is hidden while dragging.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      // Width is measured from the CHAT PANE's left edge, not the window's —
      // the rail sits before it, so raw clientX would jump the split right by
      // exactly the rail's width on the first move.
      const left = document.querySelector('.pane--chat')?.getBoundingClientRect().left ?? 0
      // Also clamp against the window so the preview card keeps ~400px — its
      // header now holds the controls (Publish/tabs/icons), which must never be
      // clipped out of reach by dragging the chat wide (rail 168 + divider 0 +
      // card gutters ≈ 184 → 584 with the 400px floor).
      const maxChat = Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, window.innerWidth - 584))
      setChatWidth(Math.min(maxChat, Math.max(MIN_CHAT_WIDTH, e.clientX - left)))
    }
    const endDrag = (): void => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('is-resizing')
      usePreviewFreeze.getState().setFrozen(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', endDrag)
    // Recover if the terminal mouseup is lost (focus steal, cmd-tab, etc.).
    window.addEventListener('blur', endDrag)
    document.addEventListener('visibilitychange', endDrag)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', endDrag)
      window.removeEventListener('blur', endDrag)
      document.removeEventListener('visibilitychange', endDrag)
    }
  }, [])

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    document.body.classList.add('is-resizing')
    // Freeze-frame rather than blank: the live view can't track the drag (its
    // bounds lag) and would swallow mousemove once the cursor crosses into it —
    // the snapshot stretches with the slot and passes events through.
    usePreviewFreeze.getState().setFrozen(true)
  }

  // Propose-first: on a failure, recall a cached fix or ask the AI, then show a card.
  const proposeFix = (root: string, error: string, context: string): void => {
    diagRoot.current = root
    const d = useDiagnosis.getState()
    d.setCurrent(null)
    d.setBusy(true)
    void window.api.diagnose
      .run(root, error, context)
      .then((res) => d.setCurrent(res))
      .catch(() => d.setCurrent(null))
      .finally(() => d.setBusy(false))
  }

  // "Apply repo fix" hands the repo-scoped steps to the chat agent (the user
  // reviews + sends), and records the choice in the per-machine memory.
  const applyFix = (): void => {
    const diag = useDiagnosis.getState().current
    if (!diag) return
    const repo = diag.steps.filter((s) => s.scope === 'repo')
    if (repo.length) {
      useComposer
        .getState()
        .setSeed(
          `Fix this so the project runs: ${diag.summary}\n` +
            repo.map((s) => `- ${s.text}${s.command ? ` (e.g. \`${s.command}\`)` : ''}`).join('\n')
        )
    }
    if (diagRoot.current)
      void window.api.diagnose.record(diagRoot.current, diag.signature, 'applied')
    useDiagnosis.getState().setCurrent(null)
  }

  const dismissFix = (): void => {
    const diag = useDiagnosis.getState().current
    if (diag && diagRoot.current)
      void window.api.diagnose.record(diagRoot.current, diag.signature, 'dismissed')
    useDiagnosis.getState().setCurrent(null)
  }

  const attempt = async (
    root: string,
    commandOverride?: string,
    keepWarm = false
  ): Promise<void> => {
    let attemptedCommand = commandOverride ?? ''
    // The previously-open project (if any) — captured before the reset clears it.
    // Opening another project tears the previous down UNLESS keepWarm (the rail's
    // "+", which keeps it running for a fast switch). Reopening the SAME project
    // (retry) is handled by start(). The backend is multi-capable (v5-A/B).
    const prevRoot = useSession.getState().projectRoot
    const switching = !!prevRoot && projectKey(prevRoot) !== projectKey(root)
    const tearDownPrev = switching && !keepWarm
    // v9 multi-chat: capture the outgoing project's live sessionKeys BEFORE its
    // workspace entry is dropped below, so every one of its chat slices (not just
    // the default) gets cleared further down instead of leaking.
    const prevSessionKeys =
      tearDownPrev && prevRoot
        ? (useWorkspace.getState().projects.find((p) => p.key === projectKey(prevRoot))
            ?.sessionKeys ?? [projectKey(prevRoot)])
        : null
    // (Keeping the previous project warm needs no snapshot here — its entry is kept
    // current as its url/branch change: open, restart, and branch-rename all patch it.)
    // Opening (or re-opening) a project starts fresh: a pick from the previous
    // repo points at a file that may not exist in the new one. Disarm + clear,
    // and drop any permission cards left over from the previous session.
    setSelectMode(false)
    setSelected(null)
    usePermissions.getState().clearPending()
    useQuestions.getState().clearPending()
    useSession.getState().setProjectRoot(null)
    useSession.getState().setBranch(null)
    useDiagnosis.getState().setCurrent(null)
    useAnnotations.getState().setList([])
    useAnnotations.getState().setFocused(null)
    useTokens.getState().reset()
    useSetup.getState().reset()
    // Drop the previous project from the workspace unless we're keeping it warm.
    if (tearDownPrev) useWorkspace.getState().close(projectKey(prevRoot))
    void window.api.preview.setSelectMode(false)
    usePanelInset.getState().setInset(0)
    const log = useLog.getState()
    log.clear()
    log.append(`Opening ${root}`)
    // Claim this project's spot in the rail + chat RIGHT AWAY — before we even
    // know whether it'll launch. Otherwise a launch failure leaves the previous
    // project's conversation on screen (only the log/status change), which reads
    // as if the error belonged to it. A fresh chat slice + active rail entry
    // means any failure below renders in this project's own (empty) space.
    const key = projectKey(root)
    const initialName = root.split('/').filter(Boolean).pop() ?? root
    useWorkspace.getState().openOrActivate(root, { name: initialName })
    useChat.getState().clearChat(key)
    useChat.getState().setActiveChat(key)
    try {
      setLog('')
      setRetry(null)
      setStatus({
        kind: 'busy',
        label: commandOverride ? `Starting ${commandOverride}…` : 'Detecting project…'
      })
      let command = commandOverride
      let name = initialName
      let framework: Framework | undefined
      // A custom command is assumed to be a web dev command; only auto-detection
      // can route a project to the simulator path.
      let kind: PreviewKind = 'web'
      if (!command) {
        log.append('Detecting framework + package manager…')
        const project = await window.api.project.detect(root)
        command = project.devCommand
        name = project.name
        framework = project.framework
        kind = project.previewKind
        attemptedCommand = command
        log.append(
          `Detected ${project.framework} · ${project.packageManager} · ${project.previewKind} · "${command}"`
        )
        setStatus({ kind: 'busy', label: `Starting ${command}…` })
        // The rail's initial guess was the folder name — patch in the real one.
        if (name !== initialName) useWorkspace.getState().patchEntry(key, { name })
      } else {
        log.append(`Using custom command "${command}"`)
      }

      // Single-active: stop the previously-open project's dev server before
      // starting this one (multi-instance backend; the rail will keep them warm).
      if (tearDownPrev) {
        await window.api.devServer.stop(prevRoot)
        void window.api.agent.closeProject(prevRoot)
        for (const sk of prevSessionKeys ?? [projectKey(prevRoot)]) useChat.getState().clearChat(sk)
      }

      // Do praxis's work on a praxis/* branch so the user's main branch stays clean.
      try {
        const b = await window.api.git.ensure(root)
        useSession.getState().setBranch(b.branch)
        if (b.branch) void window.api.agent.tagSession(root, { branch: b.branch })
        if (b.isRepo && b.branch) {
          log.append(`Working on branch ${b.branch}${b.created ? ' (created)' : ''}`, 'success')
        } else if (!b.isRepo) {
          log.append('Not a git repo — branch management off.')
        }
        if (b.error) log.append(`Couldn't switch branch: ${b.error}`, 'error')
        // GitHub link state drives the header's Connect-vs-Publish control. Only a
        // git repo can be connected; leave it null otherwise (header keeps Publish).
        useGithub.getState().setStatus(b.isRepo ? await window.api.github.status(root) : null)
      } catch {
        /* non-fatal — keep opening */
      }

      setPreviewKind(kind)

      let url: string
      if (kind === 'simulator') {
        // iOS Simulator path (React Native / Expo). Preflight first so a non-Mac
        // or missing-Xcode host gets a clear card, not a crash.
        log.append('Checking simulator prerequisites…')
        const pf = await window.api.simulator.preflight()
        if (!pf.ok) throw new Error(pf.reason ?? 'Simulator preview is unavailable on this machine.')
        log.append(`Simulator available — ${pf.devices.length} device(s)`, 'success')
        setStatus({ kind: 'busy', label: 'Booting simulator…' })
        // Ignore the detected `expo start` for the auto path — `simulator.start`
        // defaults to `expo run:ios` (build + install + launch + serve).
        const sim = await window.api.simulator.start({ root, command: commandOverride })
        launchSpec.current = { root, command: commandOverride ?? '', framework, previewKind: kind }
        log.append(`Simulator preview at ${sim.url}`, 'success')
        url = sim.url
      } else {
        await window.api.simulator.stop() // tear down any simulator from a prior project
        // Remember how to relaunch so a post-setup restart can reuse it. Only when
        // we own the server (a fresh spawn) — never tear down a user-run one.
        const server = await window.api.devServer.start({ root, command, framework })
        launchSpec.current = server.attached
          ? null
          : { root, command, framework, previewKind: kind }
        log.append(
          server.attached
            ? `Attached to running server at ${server.url}`
            : `Dev server at ${server.url}`,
          'success'
        )
        url = server.url
      }
      await window.api.preview.load(url)
      log.append('Preview loaded')
      await window.api.agent.openProject(root, {
        ...toAgentOptions(useSession.getState()),
        permissionMode: usePermissions.getState().mode
      })
      log.append(`Agent session started (cwd ${root})`)
      useSession.getState().setProjectRoot(root)
      // v5: track the open project in the workspace + show its (per-project) chat,
      // so agent events tagged with this project route to the visible chat.
      const wsKey = useWorkspace.getState().openOrActivate(root, { name })
      // Viewport is per-project: a fresh open starts at desktop (never inherits
      // the previous project's Mobile); a re-open restores this project's own.
      useViewport
        .getState()
        .setViewport(
          useWorkspace.getState().projects.find((p) => p.key === wsKey)?.viewport ?? 'desktop'
        )
      // Remember for the empty state's "Recent" list (one-click reopen).
      useRecents.getState().addRecent(root, name)
      // Start this project's chat fresh — clear any slice a trailing event from a
      // prior session may have resurrected, then show it.
      useChat.getState().clearChat(projectKey(root))
      useChat.getState().setActiveChat(projectKey(root))
      // Detect this repo's design tokens (manifest → tailwind → CSS vars).
      // Guard against a project switch racing a slow scan — only apply if `root`
      // is still the open project when it resolves. When the repo exposes no
      // tokens at all, offer to scaffold a starter `.praxis/tokens.json`.
      void window.api.tokens.detect(root).then((t) => {
        if (useSession.getState().projectRoot !== root) return
        const tk = useTokens.getState()
        tk.setSet(t)
        if (t.source === 'none' && !tk.offerDismissed) tk.setOfferNeeded(true)
      })
      // Load this repo's existing handoff notes (renders pins via the effect above).
      useAnnotations.getState().setList(await window.api.annotations.list(root))
      // Load this project's previous agents (v5-D) for the rail's history list.
      void useHistory.getState().load(root)
      // A fresh session — clear any turn left "running" from a previous project.
      useChat.getState().finish()
      log.append(`Ready — ${name}`, 'success')
      setStatus({ kind: 'running', name, url })
      // Snapshot this project so the rail can switch back to it without a restart.
      useWorkspace.getState().patchEntry(projectKey(root), {
        name,
        url,
        previewKind: kind,
        branch: useSession.getState().branch,
        launchSpec: launchSpec.current
      })
      // Bound warm dev servers (LRU-suspend beyond the cap).
      void evictWarm()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      launchSpec.current = null
      // A later step (agent open, annotations…) can throw after the dev server
      // already started — stop it so it isn't orphaned (the renderer would lose
      // its root once projectRoot/launchSpec are cleared).
      void window.api.devServer.stop(root)
      void window.api.agent.closeProject(root)
      await window.api.preview.reset()
      // The user switched to a different rail entry while this launch was in
      // flight — that project now owns the screen; don't stomp its status.
      if (useWorkspace.getState().activeKey !== key) return
      setRetry({ root, command: attemptedCommand })
      log.append(message, 'error')
      setStatus({ kind: 'error', message })
      proposeFix(root, message, `previewKind=${previewKind}; command=${attemptedCommand}`)
    }
  }

  const openProject = async (): Promise<void> => {
    const root = await window.api.project.pick()
    if (root) await attempt(root)
  }

  // Rail "+": open another project while keeping the current one warm (its dev
  // server + agent session keep running so switching back is instant).
  const openAnother = async (): Promise<void> => {
    const root = await window.api.project.pick()
    if (root) await attempt(root, undefined, true)
  }

  // Cmd+O: open a project. If one is already running, ADD it (keep the current
  // warm) rather than replacing it — otherwise "Open another…" would tear the
  // current project down, so you could never have more than one open (and the
  // rail would flicker to empty during the swap).
  const openProjectSmart = (): void => {
    void (useSession.getState().projectRoot ? openAnother() : openProject())
  }

  // File → Open Recent: reopen a known path directly (no picker). Keep the current
  // project warm when one is already open, matching Cmd+O's "add, don't replace".
  const openRecent = (root: string): void => {
    void attempt(root, undefined, !!useSession.getState().projectRoot)
  }

  // Cmd+N: create a brand-new project — pick a folder, scaffold a minimal
  // Vite+React app (git init + install), then open it like any other project,
  // keeping whatever is already open warm.
  const createNewProject = async (): Promise<void> => {
    const dest = await window.api.project.pickNew()
    if (!dest) return
    const log = useLog.getState()
    setStatus({ kind: 'busy', label: 'creating project…' })
    log.append(`Creating ${dest} (scaffold + git init + install)…`, 'server')
    const res = await window.api.project.create(dest)
    if (!res.ok || !res.root) {
      const message = res.error ?? 'Could not create the project.'
      log.append(message, 'error')
      setStatus({ kind: 'error', message })
      return
    }
    log.append('Project created — starting its dev server…', 'success')
    await attempt(res.root, undefined, !!useSession.getState().projectRoot)
  }

  // Publish: commit everything on the current praxis/* branch, push, open a PR,
  // squash-merge it to main, pull main, delete the merged branch, and start a
  // fresh same-named branch to keep working on. Progress + result go to the log.
  // The commit/PR/merge messages summarize the user asks since the LAST publish
  // (tracked per-project via publishedMsgCount), so the GitHub history reads as
  // the actual work.
  const publish = async (): Promise<void> => {
    const root = useSession.getState().projectRoot
    if (!root || publishing) return
    setPublishing(true)
    const mode = usePublishMode.getState().mode
    const log = useLog.getState()
    log.append(
      mode === 'merge'
        ? 'Publishing — commit → push → PR → merge → new branch…'
        : 'Creating PR — commit → push → PR…',
      'server'
    )
    const key = projectKey(root)
    const msgs = useChat.getState().byKey[key]?.messages ?? []
    const since = useWorkspace.getState().projects.find((p) => p.key === key)?.publishedMsgCount ?? 0
    const asks = msgs
      .slice(since)
      .filter((m) => m.role === 'user')
      .map((m) => m.text)
    try {
      const res = await window.api.publish.ship(root, asks, mode)
      if (res.ok) {
        // PR-only keeps the branch (and its open PR) accumulating — the ask
        // summary should stay cumulative until a merge, so don't advance the
        // marker for it.
        if (mode === 'merge') useWorkspace.getState().patchEntry(key, { publishedMsgCount: msgs.length })
        if (res.branch) {
          useSession.getState().setBranch(res.branch)
          useWorkspace.getState().patchEntry(projectKey(root), { branch: res.branch })
          if (res.branch) void window.api.agent.tagSession(root, { branch: res.branch })
        }
        if (res.url) void window.api.agent.tagSession(root, { prUrl: res.url })
        log.append(
          mode === 'merge'
            ? `Published${res.url ? ` — ${res.url}` : ''}. Merged to main; now on ${res.branch}.`
            : `PR ready${res.url ? ` — ${res.url}` : ''}. Staying on ${res.branch}; publish again to update it.`,
          'success'
        )
      } else {
        log.append(`Publish failed: ${res.error}`, 'error')
        log.setOpen(true)
        // A mid-publish failure can leave git on a different branch than the
        // titlebar shows (the merge step checks out the default branch first).
        // Re-sync the displayed branch to reality so the two never disagree.
        void window.api.git.list(root).then(({ current }) => {
          if (current && current !== useSession.getState().branch) {
            useSession.getState().setBranch(current)
            useWorkspace.getState().patchEntry(key, { branch: current })
          }
        })
      }
    } finally {
      setPublishing(false)
    }
  }

  // Make `target` the active project everywhere (preview, chat, agent, toolbar) —
  // no restart, the dev server + session are already warm.
  // Guard: a re-switch (the user clicking another rail item) changed the active
  // project mid-await — stop applying the stale one.
  const stillActive = (root: string): boolean => useSession.getState().projectRoot === root

  const applyProject = async (target: ProjectEntry): Promise<void> => {
    setSelectMode(false)
    setSelected(null)
    void window.api.preview.setSelectMode(false)
    useSetup.getState().reset()
    // Clear the outgoing project's tokens + pins NOW so they don't linger over the
    // new project's preview while we re-derive.
    useTokens.getState().reset()
    useAnnotations.getState().setList([])
    useAnnotations.getState().setFocused(null)
    useWorkspace.getState().activate(target.key)
    // v9 multi-chat: restore whichever of THIS project's own sessionKeys (default,
    // or an additional/resumed chat) was last active, not always the plain default.
    useChat.getState().setActiveChat(target.activeSessionKey ?? target.key)
    useSession
      .getState()
      .setChatAgentSettings(chatAgentSettingsFor(target, target.activeSessionKey ?? target.key))
    useSession.getState().setProjectRoot(target.root)
    useSession.getState().setBranch(target.branch)
    // Each project keeps its own viewport — restore it (after activate, so the
    // write-back in setViewport lands on THIS entry, not the outgoing one).
    useViewport.getState().setViewport(target.viewport ?? 'desktop')
    // Refresh the rail's "previous agents" for the project we're switching to.
    void useHistory.getState().load(target.root)
    setPreviewKind(target.previewKind)
    launchSpec.current = target.launchSpec
    // Switching to a project that never successfully launched (e.g. its
    // detect/start failed before we ever got a URL) — nothing to relaunch or
    // show as running; go neutral rather than showing the outgoing project's
    // stale status (or a leftover error/retry that belongs to a prior attempt).
    if (!target.launchSpec && !target.url && target.previewKind !== 'simulator') {
      setStatus({ kind: 'idle' })
      setRetry(null)
    }
    // Reopen the agent session if it was LRU-suspended; else just re-activate it.
    // The reopened session starts fresh — suspending closes the SDK subprocess, so
    // its conversation context is gone (the visible transcript is kept for
    // reference). Await the reopen so a follow-up send can't race a half-created
    // session, and surface a clear note instead of failing silently.
    if (await window.api.agent.isOpen(target.root)) {
      void window.api.agent.setActive(target.root, target.activeSessionKey ?? target.key)
    } else {
      try {
        await window.api.agent.openProject(target.root, {
          ...toAgentOptions(useSession.getState()),
          permissionMode: usePermissions.getState().mode
        })
        useLog
          .getState()
          .append(`Reopened ${target.name}'s agent (was suspended — prior context cleared).`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        useLog.getState().append(`Couldn't reopen ${target.name}'s agent: ${message}`, 'error')
      }
    }
    if (!stillActive(target.root)) return

    let url = target.url
    // A warm web server can die (crash) or be LRU-suspended — relaunch it before
    // navigating the preview to its now-stale URL (else: dead/blank frame).
    if (target.previewKind !== 'simulator' && target.launchSpec) {
      const alive = await window.api.devServer.isRunning(target.root)
      if (!stillActive(target.root)) return
      if (!alive) {
        setStatus({ kind: 'busy', label: `Restarting ${target.name}…` })
        try {
          const server = await window.api.devServer.start({
            root: target.launchSpec.root,
            command: target.launchSpec.command,
            framework: target.launchSpec.framework
          })
          if (!stillActive(target.root)) return
          url = server.url
          useWorkspace.getState().patchEntry(target.key, { url })
        } catch (err) {
          if (!stillActive(target.root)) return
          setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
          return
        }
      }
    }
    if (!stillActive(target.root)) return
    if (url) {
      setStatus({ kind: 'running', name: target.name, url })
      await window.api.preview.load(url)
    }
    // Re-derive this project's tokens + annotations (guard against a fast re-switch).
    void window.api.tokens.detect(target.root).then((t) => {
      if (!stillActive(target.root)) return
      useTokens.getState().setSet(t)
      if (t.source === 'none' && !useTokens.getState().offerDismissed) {
        useTokens.getState().setOfferNeeded(true)
      }
    })
    const notes = await window.api.annotations.list(target.root)
    if (stillActive(target.root)) useAnnotations.getState().setList(notes)
  }

  // Rail: switch to an already-open (warm) project. Each project's display state
  // (url / previewKind / branch / launchSpec) is kept current in its entry as it
  // changes (open / restart / branch rename), so no snapshot is needed here.
  const switchTo = async (key: string): Promise<void> => {
    const ws = useWorkspace.getState()
    if (key === ws.activeKey) return
    const target = ws.projects.find((p) => p.key === key)
    if (target) {
      await applyProject(target)
      void evictWarm()
    }
  }

  // v9 multi-chat — Rail's "+" on an already-open project: start an ADDITIONAL
  // fresh session alongside the existing one(s) (agent:new-chat does NOT tear
  // the current session down) and switch the visible chat to it.
  const newChatForProject = async (key: string): Promise<void> => {
    const entry = useWorkspace.getState().projects.find((p) => p.key === key)
    if (!entry) return
    // An empty live chat already IS a "new chat" — switch to it instead of
    // stacking another session, so mashing "+" can't mint unlimited empty
    // chats (the rail hides message-less chats until their first prompt).
    const chats = useChat.getState().byKey
    const empty = (entry.sessionKeys ?? [key]).find(
      (sk) => (chats[sk]?.messages.length ?? 0) === 0
    )
    if (empty) {
      await switchSession(key, empty)
      return
    }
    // A new chat starts with the choices visible on the chat it was created
    // from. Later picker changes stay isolated to the new sessionKey.
    const chatSettings = chatAgentSettingsFor(entry, entry.activeSessionKey ?? entry.key)
    const res = await window.api.agent.newChat(entry.root, {
      ...toAgentOptions(chatSettings),
      permissionMode: usePermissions.getState().mode
    })
    if (!res.ok || !res.sessionKey) {
      useLog.getState().append(res.error ?? 'Could not start another chat.', 'error')
      return
    }
    const sessionKey = res.sessionKey
    useWorkspace.getState().patchEntry(key, {
      sessionKeys: [...(entry.sessionKeys ?? [key]), sessionKey],
      activeSessionKey: sessionKey,
      chatSettings: { ...entry.chatSettings, [sessionKey]: chatSettings }
    })
    // Only flip the visible chat if this project is the one on screen — a "+"
    // fired for a backgrounded project just adds the session, warm in the rail.
    if (useSession.getState().projectRoot === entry.root) {
      useChat.getState().setActiveChat(sessionKey)
    }
  }

  // v9 multi-chat switcher (Rail): activate one of a project's already-live
  // sessionKeys — both the renderer's chat store and main's per-project "which
  // session is active" bookkeeping need to move together.
  const switchSession = async (key: string, sessionKey: string): Promise<void> => {
    const entry = useWorkspace.getState().projects.find((p) => p.key === key)
    if (!entry || sessionKey === entry.activeSessionKey) return
    useWorkspace.getState().patchEntry(key, { activeSessionKey: sessionKey })
    if (useSession.getState().projectRoot === entry.root) {
      useChat.getState().setActiveChat(sessionKey)
      useSession.getState().setChatAgentSettings(chatAgentSettingsFor(entry, sessionKey))
      void window.api.agent.setActive(entry.root, sessionKey)
    }
  }

  // v9 resume — hand a past ("previous agent") session back to a live SDK query
  // (SessionReview's Resume button), then switch the active chat to it and close
  // the review panel. Only reachable for the currently-active project (the rail's
  // history list only shows the active project's past sessions).
  const resumeRecord = async (record: SessionRecord): Promise<void> => {
    const key = projectKey(record.projectRoot)
    const res = await window.api.agent.resumeSession(record.projectRoot, record.id)
    if (!res.ok || !res.sessionKey) {
      useLog.getState().append(res.error ?? 'Could not resume that session.', 'error')
      return
    }
    const sessionKey = res.sessionKey
    const entry = useWorkspace.getState().projects.find((p) => p.key === key)
    const existing = entry?.sessionKeys ?? [key]
    useWorkspace.getState().patchEntry(key, {
      sessionKeys: existing.includes(sessionKey) ? existing : [...existing, sessionKey],
      activeSessionKey: sessionKey
    })
    // Seed the (fresh) chat slice with the record's past turns so the resumed
    // thread shows its history instead of an empty tree — the agent already has
    // the context via the SDK resume id, but the UI needs the transcript. No-op
    // if the slice is somehow already populated (hydrate guards that).
    useChat.getState().hydrate(sessionKey, messagesFromTranscript(record.transcript))
    if (useSession.getState().projectRoot === record.projectRoot) {
      useChat.getState().setActiveChat(sessionKey)
    }
    setReviewing(null)
  }

  // Rail ×: fully close a project (stop its server + agent, drop it). If it was
  // active, fall through to another open project or go idle.
  const closeProjectFromRail = async (key: string): Promise<void> => {
    const ws = useWorkspace.getState()
    const entry = ws.projects.find((p) => p.key === key)
    if (!entry) return
    const wasActive = ws.activeKey === key
    // Pick the fallback BEFORE close() (which would auto-pick its own activeKey).
    const next = wasActive ? (ws.projects.filter((p) => p.key !== key).at(-1) ?? null) : null
    ws.close(key)
    if (wasActive && !next) {
      // Last project — stop() fully tears it down (server + agent + chat + preview).
      await stop()
      return
    }
    void window.api.devServer.stop(entry.root)
    // Await the close so main disposes the session before we clear its chat — a
    // trailing emit then can't resurrect the cleared slice.
    await window.api.agent.closeProject(entry.root)
    // v9 multi-chat: clear EVERY one of this project's sessionKeys' chat slices
    // (default + any additional/resumed), not just the default, so none leak.
    for (const sk of entry.sessionKeys ?? [key]) useChat.getState().clearChat(sk)
    if (next) await applyProject(next)
  }

  // Rail chat × — close ONE of a project's live chats without closing the project.
  // Closing the project's LAST chat closes the whole project (nothing left to show),
  // so it falls through to closeProjectFromRail. Otherwise main tears down just that
  // session and reports the survivor; we drop the slice + rewire the entry, switching
  // the visible chat only when the closed one was the active chat on screen.
  const closeChatForProject = async (key: string, sessionKey: string): Promise<void> => {
    const entry = useWorkspace.getState().projects.find((p) => p.key === key)
    if (!entry) return
    const sessionKeys = entry.sessionKeys ?? [key]
    if (sessionKeys.length <= 1) {
      await closeProjectFromRail(key)
      return
    }
    // Await so main disposes the session before we clear its slice — a trailing
    // emit then can't resurrect the cleared chat.
    const res = await window.api.agent.closeChat(entry.root, sessionKey)
    const remaining = sessionKeys.filter((sk) => sk !== sessionKey)
    const nextActive =
      res.activeSessionKey && remaining.includes(res.activeSessionKey)
        ? res.activeSessionKey
        : (remaining[0] ?? key)
    const wasActive = (entry.activeSessionKey ?? key) === sessionKey
    useWorkspace.getState().patchEntry(key, {
      sessionKeys: remaining,
      activeSessionKey: wasActive ? nextActive : (entry.activeSessionKey ?? key)
    })
    useChat.getState().clearChat(sessionKey)
    // Move the visible chat off the closed one only when it was on screen.
    if (wasActive && useSession.getState().projectRoot === entry.root) {
      useChat.getState().setActiveChat(nextActive)
      void window.api.agent.setActive(entry.root, nextActive)
    }
  }

  // Bound memory: keep at most N projects' dev servers warm; LRU-suspend the rest
  // (their entry/chat/agent stay — switching back relaunches the server, see
  // applyProject). Decided behavior: warm-to-N + LRU-suspend.
  const MAX_WARM = 3
  // Bound the warm footprint: beyond the N most-recent projects, suspend the
  // least-recently-used ones — stop their dev server AND close their agent
  // session (each open project otherwise holds a live CLI subprocess). Switching
  // back relaunches both (applyProject probes isRunning/isOpen and reopens). We
  // never suspend a project whose agent is mid-turn: backgrounded agents keep
  // working ("keep running, badge on return"), so the cap only reaps idle ones.
  const evictWarm = async (): Promise<void> => {
    const ws = useWorkspace.getState()
    const running = useChat.getState().isRunningFor
    const byRecency = [...ws.projects].sort((a, b) => b.touchedAt - a.touchedAt)
    for (const p of byRecency.slice(MAX_WARM)) {
      if (p.key === ws.activeKey || p.previewKind === 'simulator') continue
      if (running(p.key)) continue
      const serverUp = await window.api.devServer.isRunning(p.root)
      const sessionUp = await window.api.agent.isOpen(p.root)
      if (!serverUp && !sessionUp) continue
      // Final guard before the destructive stops: a concurrent switch-back may have
      // re-activated or reopened p while we awaited the probes above (the user
      // clicked it in the rail). Re-read live state so we never reap the project
      // that's now active or mid-turn. The stop+close below don't await between
      // them, so there's no further interleaving window.
      const live = useWorkspace.getState()
      if (p.key === live.activeKey || running(p.key)) continue
      if (serverUp) void window.api.devServer.stop(p.root)
      if (sessionUp) void window.api.agent.closeProject(p.root)
      useLog.getState().append(`Suspended ${p.name} to bound memory (LRU); reloads on return.`)
    }
  }

  const toggleSelect = (): void => {
    const next = !selectMode
    setSelectMode(next)
    // Route to the right backend: the web overlay preload, or the simulator's
    // server-side select mode (a tap then becomes an idb hit-test → RN source).
    if (previewKind === 'simulator') void window.api.simulator.setSelectMode(next)
    else void window.api.preview.setSelectMode(next)
    if (!next) setSelected(null)
  }

  // Clear selection (rects/source go stale) but leave select mode — main
  // re-arms the overlay once the reloaded page finishes loading.
  const reload = (): void => {
    if (status.kind === 'running') {
      setSelected(null)
      void window.api.preview.load(status.url)
    }
  }

  // Restart the dev server and reload the preview — used after a setup turn edits
  // the build config (Vite/SvelteKit read it only at boot, so a page reload alone
  // won't apply the new source-stamping plugin). The post-restart readiness report
  // is what verifies the stamps actually fired (see the readiness effect).
  const restartPreview = async (): Promise<void> => {
    const spec = launchSpec.current
    if (!spec) {
      // We don't own this server (attached to one the user already had running) —
      // we can't restart it, and a page reload won't apply a config change. Be
      // honest rather than emitting a false "no stamps" verdict.
      useSetup.getState().setVerifying(false)
      useSetup
        .getState()
        .setStatus(
          'Setup wired the config, but Praxis is attached to your own dev server — restart it to apply the change.'
        )
      return
    }
    const root = spec.root
    const name = root.split('/').filter(Boolean).pop() ?? root
    // If the user opened a different project, that flow owns the server + status now.
    const switched = (): boolean => useSession.getState().projectRoot !== root
    const log = useLog.getState()
    if (switched()) return
    setSelected(null)
    setStatus({ kind: 'busy', label: 'Restarting preview…' })
    try {
      let url: string
      if (spec.previewKind === 'simulator') {
        log.append('Restarting the simulator to apply the new config…')
        await window.api.simulator.stop()
        if (switched()) return
        const sim = await window.api.simulator.start({
          root: spec.root,
          command: spec.command || undefined
        })
        url = sim.url
      } else {
        log.append('Restarting dev server to apply the new config…')
        await window.api.devServer.stop(spec.root)
        if (switched()) return
        const server = await window.api.devServer.start(spec)
        url = server.url
      }
      if (switched()) return
      await window.api.preview.load(url)
      log.append(`Preview restarted at ${url}`, 'success')
      setStatus({ kind: 'running', name, url })
      // Keep the workspace entry's URL current so a rail switch-back loads the new one.
      useWorkspace.getState().patchEntry(projectKey(spec.root), { url })
    } catch (err) {
      if (switched()) return
      // A broken config edit can fail the relaunch — surface it and disarm the
      // verification so it doesn't hang waiting for a readiness that won't come.
      const message = err instanceof Error ? err.message : String(err)
      useSetup.getState().setVerifying(false)
      useSetup.getState().setStatus(`Couldn't restart the preview after setup: ${message}`)
      log.append(message, 'error')
      await window.api.preview.reset()
      setStatus({ kind: 'error', message })
    }
  }

  const stop = async (): Promise<void> => {
    setSelectMode(false)
    setSelected(null)
    const closing = useSession.getState().projectRoot
    // If other projects are open, closing the active one should FOCUS another
    // (not drop to the idle "no project" screen). closeProjectFromRail does the
    // switch and only falls back to a full teardown when this is the last one.
    if (closing) {
      const key = projectKey(closing)
      if (useWorkspace.getState().projects.some((p) => p.key !== key)) {
        await closeProjectFromRail(key)
        return
      }
    }
    // v9 multi-chat: capture the closing project's sessionKeys before its entry
    // is dropped, so every chat slice it opened gets cleared below.
    const closingSessionKeys = closing
      ? (useWorkspace.getState().projects.find((p) => p.key === projectKey(closing))
          ?.sessionKeys ?? [projectKey(closing)])
      : null
    if (closing) useWorkspace.getState().close(projectKey(closing))
    useSession.getState().setProjectRoot(null)
    useAnnotations.getState().setList([])
    useAnnotations.getState().setFocused(null)
    useTokens.getState().reset()
    useSetup.getState().reset()
    usePreviewLocation.getState().setUrl(null)
    void window.api.preview.setSelectMode(false)
    usePanelInset.getState().setInset(0)
    // Unload the previewed page FIRST — the server/agent teardown below takes
    // seconds (and can throw); the stale app must not linger over the empty
    // state meanwhile. (PreviewPane's unmount also zeroes the view's bounds.)
    await window.api.preview.reset()
    const spec = launchSpec.current
    launchSpec.current = null
    if (spec?.previewKind === 'simulator') await window.api.simulator.stop()
    else if (closing) await window.api.devServer.stop(closing)
    if (closing) {
      // Await the close so main has disposed the session before we clear its
      // chat (a trailing emit can't then resurrect the cleared slice).
      await window.api.agent.closeProject(closing)
      for (const sk of closingSessionKeys ?? [projectKey(closing)]) useChat.getState().clearChat(sk)
    }
    useChat.getState().setActiveChat('')
    setRetry(null)
    setPreviewKind('web')
    setStatus({ kind: 'idle' })
  }

  // Keep the keydown/menu listeners pointed at the current closures.
  actionsRef.current = {
    toggleSelect,
    stop: () => void stop(),
    openProject: openProjectSmart,
    newProject: () => void createNewProject(),
    openRecent,
    reload,
    publish: () => void publish()
  }

  // Boot restore reuses these App closures (reattach / auto-reopen / resume). Kept
  // on a ref so the once-on-mount effect always sees the current ones.
  restoreDepsRef.current = { attempt, applyProject, resumeRecord }

  // Let the composer's select button (ChatPanel) drive the same toggle — via the
  // ref so it always hits the current closure (previewKind routing included).
  useEffect(() => {
    useUiActions.getState().register({ toggleSelect: () => actionsRef.current.toggleSelect() })
  }, [])

  // S inside the focused preview toggles select mode — same handler as the
  // app-side shortcut/menu (via the ref, so it sees current closures).
  useEffect(() => window.api.preview.onToggleSelect(() => actionsRef.current.toggleSelect()), [])

  // Boot: reattach to surviving main-process state (renderer reload) or auto-reopen
  // the last project (real relaunch). Runs exactly once; restore.ts self-guards a
  // StrictMode double-mount. The deps ref is populated during render (above).
  useEffect(() => {
    if (restoreDepsRef.current) void restoreWorkspace(restoreDepsRef.current)
  }, [])

  // Mirror the preview's real location (link clicks, SPA routes, initial load)
  // into a global store — a single native preview view is ever live, so the
  // chat composer can always tell the agent what page it's looking at.
  useEffect(
    () => window.api.preview.onUrlChanged((url) => usePreviewLocation.getState().setUrl(url)),
    []
  )

  // Launch progress lives INSIDE the preview (bottom-center pill drawn by the
  // preview preload) instead of a window-top banner.
  useEffect(() => {
    if (status.kind === 'busy') window.api.preview.setStatus(log || status.label)
    else window.api.preview.setStatus(null)
  }, [status, log])

  // Whenever the selection is dropped (pill ×, message sent, delete, mode arm),
  // tell the preview so the in-page selection toolbar disappears with it.
  useEffect(
    () =>
      useSelection.subscribe((s, prev) => {
        if (prev.selected && !s.selected) {
          void window.api.preview.clearSelected()
          // The island belongs to a selection — no selection, no island.
          usePropsIsland.getState().setOpen(false)
        } else if (s.selected && prev.selected && s.selected !== prev.selected) {
          // Picking ANOTHER element resets its element-scoped surfaces: the new
          // selection starts with just the toolbar. (The owner-jump handler
          // re-opens the island right after — it's a continuation, not a fresh
          // pick.)
          usePropsIsland.getState().setOpen(false)
          useCodeDrawer.getState().close()
        }
      }),
    []
  )

  // Actions from the floating prop-panel island (its own webContents — relayed
  // through main). Mirrors the docked panel's inline handlers.
  useEffect(
    () =>
      window.api.panel.onAction((a) => {
        const sel = useSelection.getState()
        if (a.kind === 'close') usePropsIsland.getState().setOpen(false)
        else if (a.kind === 'seed') useComposer.getState().setSeed(a.text)
        else if (a.kind === 'setup') {
          useSetup.getState().setDismissed(false)
          useSetup.getState().setNeeded(true)
        } else if (a.kind === 'owner') {
          const cur = sel.selected
          if (cur?.componentSource) {
            sel.setSelected({ ...cur, source: cur.componentSource, componentSource: null })
            // The jump came from inside the island — keep it open (the
            // selection-change subscription just closed it).
            usePropsIsland.getState().setOpen(true)
          }
        } else if (a.kind === 'inspection') {
          sel.setInspection(a.inspection)
        } else if (a.kind === 'controls') {
          // Custom Controls (v10): build the trigger prompt from the live
          // selection + the chat's backend, and send it as a REAL agent turn
          // (setSubmit auto-sends; it downgrades to a prefill mid-turn).
          if (sel.selected) {
            // The island's Regenerate button sends the 'regenerate' sentinel
            // plus the id of the panel whose row was clicked — a selection can
            // resolve several panels (the two-stamp file match stacks them), so
            // the id, not list order, decides which manifest is embedded. Its
            // broken param ids go along so the agent corrects it in place
            // (saveManifest upserts by file+component — never duplicates).
            const resolved = islandControlsRef.current
            const existing = a.panelId
              ? resolved?.find((p) => p.manifest.id === a.panelId)
              : resolved?.[0]
            const regen =
              a.hint === 'regenerate' && existing
                ? {
                    json: JSON.stringify(existing.manifest, null, 2),
                    brokenIds: existing.params.filter((p) => !p.valid).map((p) => p.id)
                  }
                : undefined
            const prompt = controlsPrompt(
              sel.selected,
              sel.inspection,
              regen ? undefined : a.hint,
              useSession.getState().provider,
              regen
            )
            useComposer.getState().setSubmit(prompt)
          }
        }
      }),
    []
  )

  const hint =
    status.kind === 'idle'
      ? 'no project open'
      : status.kind === 'busy'
        ? status.label
        : status.kind === 'running'
          ? `${status.name} · ${status.url}`
          : 'failed to start'

  return (
    <div className="app">
      {/* No titlebar — the window is all surface (traffic lights overlay the rail's
          top). Window dragging happens via the previewbar, the rail head, and the
          empty state; the project's URL, branch, and controls live in the preview
          card's own bar. */}

      {authNeeded && (
        <div className="banner banner--auth">
          <span className="banner__text">
            Praxis couldn’t reach Claude. Each teammate authenticates with their own
            subscription — run <code>claude setup-token</code> (or <code>claude login</code>) in a
            terminal, then reopen the project.
          </span>
          <button className="banner__close" onClick={() => setAuthNeeded(false)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}



      <DiagnoseCard onApply={applyFix} onDismiss={dismissFix} />

      {openCount === 0 ? (
        // Nothing open yet: no chat/preview panes — just an Open-project call to
        // action in the middle and the cat loafing in the corner (it runs while a
        // project is starting up).
        <div className="empty">
          <div className="empty__center">
            {/* With recents: the list leads and the CTAs sit under it, left-
                aligned. Without: just the CTAs, centered. */}
            {recents.length > 0 && (
              <div className="empty__recents" role="list" aria-label="Recent projects">
                <div className="empty__recents-head">Recent</div>
                {recents.slice(0, 5).map((r) => (
                  <button
                    key={r.root}
                    className="empty__recent"
                    role="listitem"
                    onClick={() => void attempt(r.root)}
                    disabled={status.kind === 'busy'}
                    title={r.root}
                  >
                    <span className="empty__recent-name">{r.name}</span>
                    <span className="empty__recent-path">{r.root}</span>
                  </button>
                ))}
              </div>
            )}
            <div className={`empty__actions ${recents.length > 0 ? 'empty__actions--left' : ''}`}>
              <button
                className="btn empty__open"
                onClick={openProjectSmart}
                disabled={status.kind === 'busy'}
              >
                {status.kind === 'busy' ? 'Working…' : 'Open project'}
              </button>
              <button
                className="btn empty__new"
                onClick={() => void createNewProject()}
                disabled={status.kind === 'busy'}
              >
                New project
              </button>
            </div>
          </div>
          <div className="empty__cat">
            <CatLoader running={status.kind === 'busy'} />
            {/* First open has no preview surface yet — the launch progress runs
                alongside the cat instead of a window-top banner. Once panes
                exist, the same text shows as a pill inside the preview. */}
            {status.kind === 'busy' && (
              <span className="empty__status">{log || status.label}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="panes">
          <Rail
            onSwitch={(key) => void switchTo(key)}
            onClose={(key) => void closeProjectFromRail(key)}
            onOpen={() => void openAnother()}
            onCreate={() => void createNewProject()}
            onReview={openReview}
            onNewChat={(key) => void newChatForProject(key)}
            onSwitchSession={(key, sessionKey) => void switchSession(key, sessionKey)}
            onCloseChat={(key, sessionKey) => void closeChatForProject(key, sessionKey)}
          />
          <section className="pane pane--chat" style={{ width: chatWidth }}>
            {/* Window-drag strip across the chat's top edge — the one top-of-window
                region that isn't already a drag surface (the rail head and the
                previewbar are). Absolute + low z-index so it adds no layout and
                stays below the pinned ask (z 6) and the top fade (z 5). */}
            <div className="chat-drag" aria-hidden="true" />
            <ChatPanel />
          </section>
          <div
            className="divider"
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
          />
          <section className="pane pane--preview">
            {/* Window-drag strip over the pane's own top padding — the only
                top-of-window gap left once the rail and chat strips drag
                (the previewbar below it already drags on its own). */}
            <div className="preview-drag" aria-hidden="true" />
            {/* The preview lives in its own card (Cursor/claude.ai design-mode
                style): a header bar with the branch, URL, and controls, and the
                live preview inset below it. */}
            <div className="previewcard">
              <div className="previewbar">
                {branch &&
                  (editingBranch ? (
                    <input
                      className="branch__input"
                      defaultValue={branch}
                      autoFocus
                      spellCheck={false}
                      onBlur={(e) => void changeBranch(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void changeBranch(e.currentTarget.value)
                        else if (e.key === 'Escape') setEditingBranch(false)
                      }}
                    />
                  ) : (
                    <DropdownMenu
                      open={branchMenuOpen}
                      onOpenChange={(open) => {
                        // The menu drops into the card body, where the native
                        // preview paints ABOVE the DOM — open only once the
                        // freeze-frame is in place so it never renders covered.
                        if (open) {
                          loadBranches()
                          openWithFreeze(setBranchMenuOpen)
                        } else {
                          closeWithFreeze(setBranchMenuOpen)
                        }
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <button className="branch" title="Switch branch">
                          ⎇ {branch}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
                        {branches.map((b) => (
                          <DropdownMenuItem key={b} onSelect={() => void switchToBranch(b)}>
                            <Check
                              className={`size-3.5 ${b === branch ? 'opacity-100' : 'opacity-0'}`}
                            />
                            <span className="truncate">{b}</span>
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setEditingBranch(true)}>
                          New branch…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ))}
                {status.kind === 'running' ? (
                  <PreviewUrl
                    base={status.url}
                    onNavigate={(url) => void window.api.preview.load(url)}
                  />
                ) : (
                  <span className="previewbar__url">{hint}</span>
                )}
                <div className="previewbar__actions">
                  {status.kind === 'running' && (
                    <>
                      {/* Element-select moved to the chat composer (Figma Make-style);
                          comment/annotate are element-scoped actions on the selection
                          pill now. Keyboard: S select, C comment, Y annotate. */}
                      {/* Viewport toggle (Figma-style device icon; also Actions
                          menu ⌘1 / ⌘2). Active = mobile. */}
                      {previewKind !== 'simulator' && (
                        <button
                          className={`iconbtn ${viewport === 'mobile' ? 'is-active' : ''}`}
                          onClick={() =>
                            useViewport
                              .getState()
                              .setViewport(viewport === 'mobile' ? 'desktop' : 'mobile')
                          }
                          aria-pressed={viewport === 'mobile'}
                          aria-label="Toggle mobile viewport"
                          title="Toggle mobile viewport (⌘1 desktop / ⌘2 mobile)"
                        >
                          <MonitorSmartphone className="size-4" aria-hidden="true" />
                        </button>
                      )}
                      {/* Before the project has a GitHub home, Publish would only
                          dead-end on "no origin" — so swap in Connect until a repo
                          exists (main/github.ts). Once connected, Publish returns. */}
                      {githubStatus && !githubStatus.connected ? (
                        <button
                          className="btn btn--primary"
                          onClick={() => useGithub.getState().setConnectOpen(true)}
                          title="Create a GitHub repo for this project and push it"
                        >
                          Connect to GitHub
                        </button>
                      ) : (
                      <>
                      {/* Publish split button: the main segment runs the selected
                          mode (full publish vs PR-only); the caret picks it. */}
                      <div className="pubgroup">
                        <button
                          className="btn btn--primary pubgroup__main"
                          onClick={() => void publish()}
                          disabled={publishing}
                          title={
                            publishMode === 'merge'
                              ? 'Commit & push everything, open a PR, merge to main, and start a fresh branch'
                              : 'Commit & push everything and open (or update) a PR — no merge'
                          }
                        >
                          {publishing
                            ? publishMode === 'merge'
                              ? 'Publishing…'
                              : 'Creating PR…'
                            : publishMode === 'merge'
                              ? 'Publish'
                              : 'Create PR'}
                        </button>
                        <DropdownMenu
                          open={pubMenuOpen}
                          onOpenChange={(open) =>
                            open ? openWithFreeze(setPubMenuOpen) : closeWithFreeze(setPubMenuOpen)
                          }
                        >
                          <DropdownMenuTrigger asChild>
                            <button
                              className="btn btn--primary pubgroup__caret"
                              disabled={publishing}
                              aria-label="Publish settings"
                              title="Choose what Publish does"
                            >
                              <ChevronDown className="size-3.5" aria-hidden="true" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuRadioGroup
                              value={publishMode}
                              onValueChange={(v) =>
                                usePublishMode.getState().setMode(v as 'merge' | 'pr')
                              }
                            >
                              <DropdownMenuRadioItem value="merge">
                                Create PR and merge to main
                              </DropdownMenuRadioItem>
                              <DropdownMenuRadioItem value="pr">Create PR</DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      </>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className={`previewcard__body ${status.kind === 'error' ? 'previewcard__body--errored' : ''}`}>
                <PreviewPane />
                {drawerSource && projectRoot && (
                  <CodeDrawer
                    root={projectRoot}
                    source={drawerSource}
                    onClose={() => useCodeDrawer.getState().close()}
                  />
                )}
              </div>
              {status.kind === 'error' && (
                <form
                  className="previewcard__errbar"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const cmd = String(new FormData(e.currentTarget).get('cmd') ?? '').trim()
                    if (cmd && retry) void attempt(retry.root, cmd)
                  }}
                >
                  <span className="previewcard__errtext" title={status.message}>
                    {status.message}
                  </span>
                  {retry && (
                    <>
                      <input
                        name="cmd"
                        className="previewcard__errinput"
                        defaultValue={retry.command}
                        placeholder="custom command, e.g. bun run dev:web"
                        spellCheck={false}
                      />
                      <button className="btn" type="submit">
                        Run
                      </button>
                    </>
                  )}
                </form>
              )}
            </div>
          </section>
          {/* Show/hide the projects sidebar — floats by the traffic lights so it
              stays reachable once the rail is collapsed away. Rendered LAST inside
              .panes so its no-drag region is applied after the chat pane's drag
              strip (.chat-drag); otherwise, with the rail collapsed, that strip
              would win the overlap and swallow clicks on this button. */}
          <button
            className="sidebar-toggle"
            onClick={() => useWorkspace.getState().toggleCollapsed()}
            aria-label={railCollapsed ? 'Show projects sidebar' : 'Hide projects sidebar'}
            aria-pressed={!railCollapsed}
            title={railCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            <PanelLeft className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Activity console — docked full-width at the bottom of the window. */}
      {logOpen && <ConsolePanel />}

      {/* Props island — shown for EVERY selection as a floating card over the
          preview (native view above it, driven by PanelHost): editable fields
          when a schema resolved, the readiness message otherwise. Collapsible
          to a chip inside the island itself. */}
      {selected && projectRoot && propsIslandOpen && (
        <PanelHost
          root={projectRoot}
          element={selected}
          inspection={inspection}
          inspecting={inspecting}
          controls={islandControls}
        />
      )}

      {/* v5-D: review a previous agent session (transcript + branch/PR + files). */}
      {reviewing && (
        <SessionReview
          record={reviewing}
          onClose={() => setReviewing(null)}
          onResume={(rec) => resumeRecord(rec)}
        />
      )}

      {/* LKM-27: in-app feedback → a GitHub issue on the Praxis repo. */}
      <FeedbackDialog />
      <ConnectDialog />
    </div>
  )
}
