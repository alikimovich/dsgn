import type { LiveProjectSnapshot } from '../../shared/api'
import {
  type ChatAgentSettings,
  chatAgentSettingsFromOptions,
  messagesFromTranscript,
  type ProjectEntry,
  readPersistedWorkspace,
  useChat,
  useLog,
  useSession,
  useWorkspace
} from './store'

/**
 * Boot-time workspace restore (run once on App mount, before the user can
 * meaningfully interact). After a hard renderer reload (crash-recovery, sleep) the
 * MAIN process survives with its live agent sessions, dev servers, and preview —
 * but the fresh renderer has no in-memory state and would land on Welcome. This
 * reattaches the UI to whatever is still live in main, repainting chat transcripts;
 * and when main has nothing (a real relaunch), auto-reopens the last praxis-launched
 * project. Main's last thread is restored in place by `agent:open-project` (the
 * transcript plus a Claude SDK resume when one exists) — it is no longer dumped
 * into History and reopened as a secondary chat.
 *
 * Reuses App's own `attempt`/`applyProject` (passed in) rather than duplicating
 * the open/switch flows — they already handle dev-server recovery, stale-completion
 * guards, and history/token/annotation loading.
 */
export interface RestoreDeps {
  /** App.attempt — full open path (detect → dev server → preview → agent). */
  attempt: (root: string) => Promise<void>
  /** App.applyProject — no-relaunch switch onto an already-live project. */
  applyProject: (target: ProjectEntry) => Promise<void>
}

// Guard against a double invocation (React StrictMode double-mounts effects in
// dev). Module-scoped, so a real reload — which reloads this module — resets it.
let started = false

const basename = (p: string): string =>
  p
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() || p

/** A minimal entry for a project that's live in main but wasn't persisted (so its
 *  chats aren't lost) — it has no preview until the user reopens it. */
const minimalEntry = (lp: LiveProjectSnapshot): ProjectEntry => ({
  root: lp.root,
  key: lp.projectKey,
  name: basename(lp.root),
  url: null,
  previewKind: 'web',
  branch: null,
  launchSpec: null,
  touchedAt: 0,
  sessionKeys: lp.chats.map((c) => c.sessionKey),
  activeSessionKey: lp.activeSessionKey ?? lp.chats[0]?.sessionKey ?? lp.projectKey,
  chatSettings: liveChatSettings(lp)
})

/** Every live chat's REAL posture, straight from main's session options. It
 *  outranks the persisted copy: main survived the reload, the renderer's state
 *  didn't, so anything the two disagree on is stale on the renderer's side (and a
 *  stale mode is one the toolbar would then misreport for the rest of the chat). */
const liveChatSettings = (lp: LiveProjectSnapshot): Record<string, ChatAgentSettings> =>
  Object.fromEntries(lp.chats.map((c) => [c.sessionKey, chatAgentSettingsFromOptions(c.options)]))

export async function restoreWorkspace(deps: RestoreDeps): Promise<void> {
  if (started) return
  started = true

  const persisted = readPersistedWorkspace()
  if (!persisted || persisted.projects.length === 0) return // nothing to restore → Welcome

  const log = useLog.getState()
  try {
    const snapshot = await window.api.agent.workspaceSnapshot()
    const live = new Map(snapshot.projects.map((p) => [p.projectKey, p]))
    const persistedByKey = new Map(persisted.projects.map((p) => [p.key, p]))

    // 1. Restore every project still LIVE in main (renderer-only reload): seed its
    //    chat slice(s) from the live in-memory records, reconciling sessionKeys with
    //    the snapshot (the truth for which chats exist). Persisted display fields
    //    (url/branch/launchSpec/viewport) are preferred when present.
    const restored: ProjectEntry[] = []
    for (const lp of snapshot.projects) {
      const p = persistedByKey.get(lp.projectKey)
      const sessionKeys = lp.chats.map((c) => c.sessionKey)
      const activeSessionKey = lp.activeSessionKey ?? sessionKeys[0] ?? lp.projectKey
      restored.push(
        p
          ? {
              ...p,
              sessionKeys,
              activeSessionKey,
              // Main's live options win over the persisted copy for the chats it
              // still has; persisted entries for chats it no longer has are dropped.
              chatSettings: liveChatSettings(lp)
            }
          : minimalEntry(lp)
      )
      for (const c of lp.chats) {
        useChat
          .getState()
          .hydrate(c.sessionKey, messagesFromTranscript(c.record.transcript), c.isRunning)
        // Restore the chat's auto-generated name so the rail shows its subject
        // label immediately, not the opening-words fallback, after a reload.
        if (c.record.title) useChat.getState().setTitle(c.sessionKey, c.record.title)
        // Restore the isolation chip (v9) — main's chat-isolation state survives a
        // renderer-only reload, so re-seed the chip instead of defaulting to 'live'.
        if (c.isolation) useChat.getState().setIsolation(c.sessionKey, c.isolation.state)
      }
    }

    // The project to focus: the persisted active one, else the most-recently touched.
    const activePersisted =
      persisted.projects.find((p) => p.key === persisted.activeKey) ??
      [...persisted.projects].sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0))[0]
    const activeIsLive = !!activePersisted && live.has(activePersisted.key)

    // 2a. Put the live set (minus the dead, persisted-but-not-live projects) into
    //     the rail. Active is claimed only when it's live; otherwise the reopen
    //     below (attempt) claims it.
    useWorkspace.getState().hydrate(restored, activeIsLive ? activePersisted!.key : null)

    if (activePersisted && activeIsLive) {
      // Renderer reattach: point the UI at the already-live active session (no
      // relaunch). applyProject recovers the preview (running URL or restart) and
      // reloads history/tokens/annotations; the chat slice is already seeded.
      let entry = restored.find((e) => e.key === activePersisted.key)!
      // The persisted URL is normally still right (a renderer-only reload doesn't
      // move the dev server), but main is authoritative — and a live-but-never-
      // persisted project has no URL at all. Ask before repainting the preview.
      if (entry.previewKind !== 'simulator') {
        try {
          const info = await window.api.devServer.info(entry.root)
          if (info.running && info.server?.url && info.server.url !== entry.url) {
            entry = { ...entry, url: info.server.url }
            useWorkspace.getState().patchEntry(entry.key, { url: entry.url })
          }
        } catch {
          /* fall back to the persisted URL */
        }
      }
      await deps.applyProject(entry)
    } else if (activePersisted && activePersisted.launchSpec) {
      // Real relaunch (main empty) — only auto-reopen a project praxis OWNS the launch
      // of (a persisted launchSpec). Attached-server / never-launched entries can't
      // be relaunched meaningfully and are left in recents for the user to reopen.
      await deps.attempt(activePersisted.root)
      // Main is restored in place by open-project (transcript + Claude resume).
      // Ghost sessionKeys from the previous run aren't live; pin the rail on Main.
      if (useSession.getState().projectRoot === activePersisted.root) {
        const key = activePersisted.key
        useWorkspace.getState().patchEntry(key, {
          sessionKeys: [key],
          activeSessionKey: key
        })
        useChat.getState().setActiveChat(key)
      }
    }
    // else: nothing live and the last project isn't praxis-launched → stay on Welcome.
  } catch (err) {
    // Any failure falls back cleanly rather than a broken half-state.
    const message = err instanceof Error ? err.message : String(err)
    log.append(`Couldn't restore the previous workspace: ${message}`, 'error')
    try {
      useWorkspace.getState().reset()
    } catch {
      /* best effort */
    }
  }
}
