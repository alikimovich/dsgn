import {
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionRecord } from "../../../shared/api";
import {
  chatTitle,
  shortAgo,
  useChat,
  useFeedback,
  useHistory,
  useSpawns,
  useUpdate,
  useWorkspace,
} from "../store";
import RailChatRow, { type ChatStatus } from "./RailChatRow";

interface Props {
  /** Switch to an already-open project. */
  onSwitch: (key: string) => void;
  /** Close (fully stop) a project. */
  onClose: (key: string) => void;
  /** Open another project, keeping the current one warm. */
  onOpen: () => void;
  /** Create a brand-new project (scaffold), keeping the current one warm. */
  onCreate: () => void;
  /** Open a past session for review (v5-D). */
  onReview: (rec: SessionRecord) => void;
  /** v9 multi-chat — start an ADDITIONAL live chat for this (already-open) project. */
  onNewChat: (key: string) => void;
  /** v9 multi-chat — switch to one of this project's already-live sessionKeys. */
  onSwitchSession: (key: string, sessionKey: string) => void;
  /** v9 multi-chat — close one of this project's live chats (leaving the project open). */
  onCloseChat: (key: string, sessionKey: string) => void;
}

/** First user-typed line of a transcript/chat — the seed for a chat's auto-name. */
const firstUserText = (
  entries: { role: string; text: string }[],
): string | undefined =>
  entries.find((e) => e.role === "user" && e.text.trim())?.text;

/** Cap on visible chat rows per project. Live chats + running agents always
 *  show (they're actionable); previous chats fill the remaining slots, the
 *  rest sit behind a "Show N more" row. */
const MAX_CHAT_ROWS = 5;

/** Rename a LIVE chat: main owns the name (it persists it onto the session record
 *  and re-broadcasts it as a `title` event), but paint it immediately so the row
 *  doesn't lag a round-trip behind the input. */
const renameLiveChat = (sessionKey: string, name: string): void => {
  useChat.getState().setTitle(sessionKey, name);
  void window.api.agent.renameChat(sessionKey, name).then((res) => {
    if (res?.ok && res.title) useChat.getState().setTitle(sessionKey, res.title);
  });
};

/**
 * v5 left rail (Cursor-style) — the open projects, each led by a folder icon
 * (open while the project is expanded, closed otherwise). Every project owns its
 * OWN expanded/collapsed state (`chatsCollapsed`, persisted with the entry), so
 * switching projects leaves the others exactly as the user left them — the
 * chevron is the only thing that folds a project away. An expanded project shows
 * a flat, left-aligned list of its chats: first its live/open chats (the one on
 * screen highlighted — only the active project can have one), then its
 * **previous chats** (v5-D persisted sessions, one row per chat with a trailing
 * "time ago"). Clicking any chat of a non-active project switches to that
 * project as well. Chat names are
 * auto-generated from each chat's opening prompt and renameable in place (the
 * hover pencil — see RailChatRow). Each chat row leads with a status dot that
 * sits in the same 16px slot the project's folder icon occupies, so dots and
 * folders share a centre line; the names stay flush-left at the project name's
 * level. Clicking a project switches; × closes; clicking a chat opens/reviews it.
 *
 * The collapse/expand toggle no longer lives here — it floats by the traffic lights
 * (see App's `.sidebar-toggle`) so it stays reachable once the rail is gone. When
 * collapsed the rail stays mounted but slides out to the left (width → 0); the
 * floating toggle slides it back. Keeping it mounted is what lets the collapse
 * animate instead of popping in and out.
 */
export default function Rail({
  onSwitch,
  onClose,
  onOpen,
  onCreate,
  onReview,
  onNewChat,
  onSwitchSession,
  onCloseChat,
}: Props): React.JSX.Element | null {
  const projects = useWorkspace((s) => s.projects);
  const activeKey = useWorkspace((s) => s.activeKey);
  const collapsed = useWorkspace((s) => s.collapsed);
  // Re-render on any chat change so the per-project "working" dots stay live.
  const byKey = useChat((s) => s.byKey);
  // Past sessions per project (loaded by App on open/switch/close).
  const history = useHistory((s) => s.byKey);
  // v8 F1: comment-spawned background agents currently running, per project.
  const spawns = useSpawns((s) => s.byKey);
  const updateStatus = useUpdate((s) => s.status);
  const updateSubject = useUpdate((s) => s.subject);
  const updateProgress = useUpdate((s) => s.progress);
  const updateError = useUpdate((s) => s.error);
  const updateDismissedSubject = useUpdate((s) => s.dismissedSubject);
  // Projects whose FULL previous-chats list is shown (session-only, resets on
  // relaunch — a long history should re-tuck itself, like Cursor's sidebar).
  const [moreShown, setMoreShown] = useState<Set<string>>(new Set());

  // Every EXPANDED project lists its previous chats, not just the active one, so
  // pull the history of any that hasn't been fetched yet. App only loads it for
  // the project it opens/switches to, which leaves a boot-restored (or never
  // visited) sibling showing its live chats and nothing else.
  useEffect(() => {
    const hist = useHistory.getState();
    for (const p of projects) {
      if (p.chatsCollapsed) continue;
      if (hist.byKey[p.key] || hist.loading[p.key]) continue;
      void hist.load(p.root);
    }
  }, [projects, history]);

  if (projects.length === 0) return null;

  return (
    <nav
      className={`rail ${collapsed ? "rail--collapsed" : ""}`}
      aria-label="Open projects"
      aria-hidden={collapsed}
    >
      {/* Window-drag strip over the rail's reserved top clearance (traffic
          lights) — rail__inner's own padding-top leaves this empty, so
          nothing here made it draggable. Sits below rail__inner's own
          buttons in the DOM/paint order, so it never blocks a click. */}
      <div className="rail-drag" aria-hidden="true" />
      <div className="rail__inner">
        {/* Project actions — quiet list items (no dashed CTA borders) — lead the
          rail so opening/creating is always reachable. The "Projects" heading
          sits below them, directly labelling the open-projects list. */}
        <button
          className="rail__action"
          onClick={onOpen}
          title="Open an existing folder (⌘O)"
        >
          <Folder className="size-4" aria-hidden="true" />
          <span>Open project</span>
        </button>
        <button
          className="rail__action"
          onClick={onCreate}
          title="Create a brand-new project (⌘N)"
        >
          <Plus className="size-4" aria-hidden="true" />
          <span>New project</span>
        </button>
        <div className="rail__head">
          <span>Projects</span>
        </div>
        <ul className="rail__list">
          {projects.map((p) => {
            const active = p.key === activeKey;
            // Expansion is the project's OWN state, not a side effect of being
            // active: switching projects must not fold the outgoing one away.
            // Collapsing only hides the list — the project (and its dev server/
            // preview) stays live either way.
            const expanded = !p.chatsCollapsed;
            const sessionKeys = p.sessionKeys ?? [p.key];
            // A live chat whose changes couldn't auto-merge is "parked" (v9). While one
            // is, its `chatpark-*` history record is redundant with the live row's badge
            // + in-chat card, so hide it from the "previous chats" list below.
            const anyParked = expanded
              ? sessionKeys.some((sk) => byKey[sk]?.isolation === "parked")
              : false;
            const past = expanded
              ? (history[p.key] ?? []).filter(
                  (r) => !(anyParked && r.id.startsWith("chatpark-")),
                )
              : [];
            const working = expanded ? (spawns[p.key] ?? []) : [];
            const live = expanded
              ? [...sessionKeys]
                  .reverse()
                  .filter((sk) => (byKey[sk]?.messages.length ?? 0) > 0)
              : [];
            // Live + working rows always show; previous chats fill what's left
            // of the row budget, the rest behind "Show N more".
            const pastCapacity = Math.max(
              0,
              MAX_CHAT_ROWS - live.length - working.length,
            );
            const showAllPast = moreShown.has(p.key);
            const pastVisible = showAllPast ? past : past.slice(0, pastCapacity);
            const hiddenPast = past.length - pastVisible.length;
            const FolderIcon = expanded ? FolderOpen : Folder;
            return (
              <li
                key={p.key}
                className={`rail__item ${active ? "rail__item--active" : ""}`}
              >
                <div className="rail__row">
                  <div className="rail__open" title={p.root}>
                    {/* Cursor-style glyph: a subdued folder (open when expanded,
                      closed otherwise) that, on hover, gives way to a chevron —
                      pointing down while expanded, right while collapsed.
                      It only ever folds THIS project's chat list, active or not
                      — switching projects is the name button's job, so a fold
                      never drags the preview along with it. */}
                    <button
                      className="rail__glyph-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        useWorkspace.getState().toggleChatsCollapsed(p.key);
                      }}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${p.name}'s chats`}
                    >
                      <span className="rail__glyph" aria-hidden="true">
                        <FolderIcon className="rail__folder size-4" />
                        <ChevronRight
                          className={`rail__chevron size-4 ${expanded ? "rail__chevron--open" : ""}`}
                        />
                      </span>
                    </button>
                    <button
                      className="rail__name-btn"
                      onClick={() => onSwitch(p.key)}
                      aria-current={active}
                    >
                      <span className="rail__name">{p.name}</span>
                    </button>
                  </div>
                  {active && (
                    <button
                      className="rail__new-chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewChat(p.key);
                      }}
                      aria-label={`Start another chat for ${p.name}`}
                      title="Start another chat for this project"
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    className="rail__close"
                    onClick={() => onClose(p.key)}
                    aria-label={`Close ${p.name}`}
                    title="Close project"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                {/* Expanded project: a flat, left-aligned list of its chats
                  — live chats newest-first (the active one highlighted), then
                  previous chats. `sessionKeys` grows by append, so we render a
                  reversed copy to float freshly-started chats to the top. No
                  status dots; names are auto-generated from each chat's first
                  prompt, mirroring Cursor's sidebar. A chat with no messages yet
                  has nothing to name or return to — it gets its row only once
                  its first message is sent (Cursor-style; keeps "+" from
                  filling the rail with "New chat" rows). */}
                {expanded && (
                  <ul className="rail__chats" aria-label={`${p.name}'s chats`}>
                    {live.map((sk) => {
                      // Only the project on screen has a chat on screen — an
                      // expanded background project must not paint a second
                      // "active" row alongside it.
                      const isActiveChat =
                        active && sk === (p.activeSessionKey ?? p.key);
                      // Prefer the conversation-derived name (main's auto-title);
                      // fall back to the opening prompt until it's generated.
                      const name =
                        byKey[sk]?.title ??
                        chatTitle(firstUserText(byKey[sk]?.messages ?? []));
                      const parked = byKey[sk]?.isolation === "parked";
                      const status: ChatStatus = byKey[sk]?.isRunning
                        ? "working"
                        : byKey[sk]?.needsReview
                          ? "done"
                          : "idle";
                      return (
                        <RailChatRow
                          key={sk}
                          name={name}
                          status={status}
                          active={isActiveChat}
                          title={
                            parked
                              ? `${name} — changes couldn't be merged; open to resolve`
                              : name
                          }
                          onOpen={() => onSwitchSession(p.key, sk)}
                          onRename={(next) => renameLiveChat(sk, next)}
                          onClose={() => onCloseChat(p.key, sk)}
                        >
                          {parked && (
                            <span
                              className="rail__chat-badge"
                              title="Changes couldn't be merged"
                            >
                              conflict
                            </span>
                          )}
                        </RailChatRow>
                      );
                    })}
                    {/* v8 F1: comment-spawned background agents working (or queued).
                      A queued one isn't thinking yet, so it rests on the idle dot. */}
                    {working.map((sp) => (
                      <RailChatRow
                        key={sp.id}
                        spawn
                        name={
                          sp.status === "queued"
                            ? `${sp.label} · queued`
                            : sp.label
                        }
                        status={sp.status === "queued" ? "idle" : "working"}
                        title={sp.label}
                        onClose={() =>
                          void window.api.agent.spawnInterrupt(sp.id)
                        }
                        closeLabel="Cancel agent"
                        closeTitle="Cancel this agent"
                      />
                    ))}
                    {/* Previous chats for this project (newest first, capped). A
                      finished chat is by definition stale — the idle dot. */}
                    {pastVisible.map((rec) => {
                      const name =
                        rec.title ?? chatTitle(firstUserText(rec.transcript));
                      return (
                        <RailChatRow
                          key={rec.id}
                          name={name}
                          status="idle"
                          title={`${name} — ${rec.filesTouched.length} file(s)`}
                          onOpen={() => onReview(rec)}
                          onRename={(next) =>
                            void useHistory
                              .getState()
                              .rename(rec.projectRoot, rec.id, next)
                          }
                          onClose={() =>
                            void useHistory
                              .getState()
                              .remove(rec.projectRoot, rec.id)
                          }
                          closeLabel="Delete chat"
                          closeTitle="Delete from history"
                        >
                          <span className="rail__chat-time">
                            {shortAgo(rec.startedAt)}
                          </span>
                        </RailChatRow>
                      );
                    })}
                    {/* Overflow toggle — only when the history spills past the cap.
                      The empty status slot keeps its label on the chats' indent. */}
                    {past.length > pastCapacity && (
                      <li className="rail__chat-item">
                        <button
                          className="rail__chat rail__chat--more"
                          onClick={() =>
                            setMoreShown((prev) => {
                              const next = new Set(prev);
                              if (showAllPast) next.delete(p.key);
                              else next.add(p.key);
                              return next;
                            })
                          }
                        >
                          <span className="rail__chat-status" aria-hidden="true" />
                          <span className="rail__chat-name">
                            {showAllPast ? "Show less" : `Show ${hiddenPast} more`}
                          </span>
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {/* Pinned outside rail__inner's scroll area (a sibling, not its last
          child) so a long project/chat list can't scroll it out of view. */}
      {updateStatus === "available" && updateSubject !== updateDismissedSubject && (
        <div className="rail__update">
          <span className="rail__update-text">
            Update available{updateSubject ? `: ${updateSubject}` : ""}
          </span>
          <div className="rail__update-actions">
            <button
              className="btn rail__update-btn"
              onClick={() => void window.api.update.apply()}
            >
              Update &amp; Restart
            </button>
            <button
              className="rail__update-dismiss"
              onClick={() => useUpdate.getState().dismiss()}
              aria-label="Dismiss"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      {updateStatus === "updating" && (
        <div className="rail__update">
          <span className="rail__update-text">
            Updating… {updateProgress ?? ""}
          </span>
          <button className="btn rail__update-btn" disabled>
            Updating…
          </button>
        </div>
      )}
      {updateStatus === "error" && (
        <div className="rail__update">
          <span className="rail__update-text">Update failed: {updateError}</span>
          <button
            className="rail__update-dismiss"
            onClick={() => useUpdate.getState().dismiss()}
            aria-label="Dismiss"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {/* Pinned last (below any update banner) so it's always in the same spot,
          and — like rail__update — a sibling of rail__inner, out of its scroll. */}
      <button
        className="rail__feedback"
        onClick={() => useFeedback.getState().setOpen(true)}
        title="Report a problem or suggest an improvement"
      >
        <MessageSquare className="size-4" aria-hidden="true" />
        <span>Send feedback</span>
      </button>
    </nav>
  );
}
