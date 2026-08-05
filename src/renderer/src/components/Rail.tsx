import {
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
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

/**
 * v5 left rail (Cursor-style) — the open projects, each led by a folder icon
 * (open when it's the active project, closed otherwise). The active project
 * expands to a flat, left-aligned list of its chats: first its live/open chats
 * (the active one highlighted), then its **previous chats** (v5-D persisted
 * sessions, one row per chat with a trailing "time ago"). Chat names are
 * auto-generated from each chat's opening prompt. No status dots on chat rows —
 * the text sits flush-left, at the project name's level. Clicking a project
 * switches; × closes; clicking a chat opens/reviews it.
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
            // Chats show only for the active project, AND only while it isn't
            // collapsed — collapsing hides the list but leaves the project (and
            // its dev server/preview) live; it's independent of `activeKey`.
            const expanded = active && !p.chatsCollapsed;
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
                      For the active project this toggles the chat list without
                      switching away; for an inactive one it just switches. */}
                    <button
                      className="rail__glyph-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (active)
                          useWorkspace.getState().toggleChatsCollapsed(p.key);
                        else onSwitch(p.key);
                      }}
                      aria-label={
                        active
                          ? `${expanded ? "Collapse" : "Expand"} ${p.name}'s chats`
                          : `Open ${p.name}`
                      }
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
                {/* Active + expanded project: a flat, left-aligned list of its chats
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
                      const isActiveChat = sk === (p.activeSessionKey ?? p.key);
                      // Prefer the conversation-derived name (main's auto-title);
                      // fall back to the opening prompt until it's generated.
                      const name =
                        byKey[sk]?.title ??
                        chatTitle(firstUserText(byKey[sk]?.messages ?? []));
                      const parked = byKey[sk]?.isolation === "parked";
                      return (
                        <li key={sk} className="rail__chat-item">
                          <button
                            className={`rail__chat ${isActiveChat ? "rail__chat--active" : ""}`}
                            onClick={() => onSwitchSession(p.key, sk)}
                            aria-current={isActiveChat}
                            title={
                              parked
                                ? `${name} — changes couldn't be merged; open to resolve`
                                : name
                            }
                          >
                            <span className="rail__chat-name">{name}</span>
                            {parked && (
                              <span
                                className="rail__chat-badge"
                                title="Changes couldn't be merged"
                              >
                                conflict
                              </span>
                            )}
                          </button>
                          <button
                            className="rail__chat-x"
                            onClick={(e) => {
                              e.stopPropagation();
                              onCloseChat(p.key, sk);
                            }}
                            aria-label={`Close chat ${name}`}
                            title="Close chat"
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                    {/* v8 F1: comment-spawned background agents working (or queued). */}
                    {working.map((sp) => (
                      <li
                        key={sp.id}
                        className="rail__chat-item"
                        title={sp.label}
                      >
                        <span className="rail__chat rail__chat--spawn">
                          <span
                            className={`rail__sdot ${sp.status === "queued" ? "rail__sdot--queued" : "rail__sdot--working"}`}
                            aria-hidden="true"
                          />
                          <span className="rail__chat-name">
                            {sp.status === "queued"
                              ? `${sp.label} · queued`
                              : sp.label}
                          </span>
                        </span>
                        <button
                          className="rail__chat-x"
                          onClick={(e) => {
                            e.stopPropagation();
                            void window.api.agent.spawnInterrupt(sp.id);
                          }}
                          aria-label="Cancel agent"
                          title="Cancel this agent"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {/* Previous chats for this project (newest first, capped). */}
                    {pastVisible.map((rec) => {
                      const name =
                        rec.title ?? chatTitle(firstUserText(rec.transcript));
                      return (
                        <li key={rec.id} className="rail__chat-item">
                          <button
                            className="rail__chat"
                            onClick={() => onReview(rec)}
                            title={`${name} — ${rec.filesTouched.length} file(s)`}
                          >
                            <span className="rail__chat-name">{name}</span>
                            <span className="rail__chat-time">
                              {shortAgo(rec.startedAt)}
                            </span>
                          </button>
                          <button
                            className="rail__chat-x"
                            onClick={(e) => {
                              e.stopPropagation();
                              void useHistory
                                .getState()
                                .remove(rec.projectRoot, rec.id);
                            }}
                            aria-label="Delete chat"
                            title="Delete from history"
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                    {/* Overflow toggle — only when the history spills past the cap. */}
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
