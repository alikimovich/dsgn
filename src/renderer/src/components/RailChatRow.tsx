import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * What a chat row's status dot says, left of the name:
 *  - `idle`    — hollow ring: nothing in flight, nothing new to look at (stale).
 *  - `working` — filled grey, blinking: a turn is in flight.
 *  - `done`    — filled green: a turn finished while you were elsewhere, so the
 *                result is waiting to be checked.
 */
export type ChatStatus = "idle" | "working" | "done";

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "Idle",
  working: "Working…",
  done: "Finished — not reviewed yet",
};

interface Props {
  /** The chat's display name (auto-generated or user-chosen). */
  name: string;
  status: ChatStatus;
  /** Highlight as the chat currently on screen. */
  active?: boolean;
  /** Tooltip for the row (defaults to the name). */
  title?: string;
  /** A background agent's row — a label, not a switchable chat. */
  spawn?: boolean;
  /** Open/switch to this chat. Omitted for a spawn row. */
  onOpen?: () => void;
  /** Commit a new name. Omitted for rows that can't be renamed (spawns). */
  onRename?: (name: string) => void;
  /** Close/delete this row. */
  onClose?: () => void;
  closeLabel?: string;
  closeTitle?: string;
  /** Trailing content inside the row (a "time ago", a conflict badge). */
  children?: React.ReactNode;
}

/**
 * One row in the rail's per-project chat list: a status dot in the same 16px slot
 * the project's folder icon occupies (so dots and folders share a centre line),
 * then the chat name — still flush at the project name's indent — then whatever
 * trailing meta the caller passes. The hover-revealed rename pencil and close ×
 * float OVER that meta rather than sitting in the row's flow, so every row —
 * including the ones with no actions at all (Main, "Show N more") — ends its
 * meta on the same trailing edge.
 *
 * Renaming happens in place: the pencil swaps the row for an input seeded with the
 * current name. Enter/blur commits, Escape reverts. The caller owns persistence
 * (a live chat renames through `agent.renameChat`, a past one through
 * `sessions.rename`).
 */
export default function RailChatRow({
  name,
  status,
  active,
  title,
  spawn,
  onOpen,
  onRename,
  onClose,
  closeLabel,
  closeTitle,
  children,
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter commits and then blurs; without this the blur handler would fire a
  // second (identical) rename, and Escape's blur would undo its own cancel.
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    inputRef.current?.select();
  }, [editing]);

  const settle = (next: string | null): void => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const trimmed = next?.trim() ?? "";
    // An unchanged or emptied name is a cancel — a chat always keeps a name.
    if (trimmed && trimmed !== name) onRename?.(trimmed);
  };

  const dot = (
    <span
      className={`rail__chat-status rail__chat-status--${status}`}
      title={STATUS_LABEL[status]}
      role="img"
      aria-label={STATUS_LABEL[status]}
    />
  );

  if (editing)
    return (
      <li className="rail__chat-item rail__chat-item--editing">
        <span className="rail__chat">
          {dot}
          <input
            ref={inputRef}
            className="rail__chat-input"
            defaultValue={name}
            aria-label={`Rename chat ${name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle(e.currentTarget.value);
              else if (e.key === "Escape") settle(null);
            }}
            onBlur={(e) => settle(e.currentTarget.value)}
          />
        </span>
      </li>
    );

  const hasActions = Boolean(onRename || onClose)

  return (
    <li
      className={`rail__chat-item ${hasActions ? "rail__chat-item--actions" : ""}`}
      title={spawn ? title : undefined}
    >
      {spawn ? (
        <span className="rail__chat rail__chat--spawn">
          {dot}
          <span className="rail__chat-name">{name}</span>
          {children}
        </span>
      ) : (
        <button
          className={`rail__chat ${active ? "rail__chat--active" : ""}`}
          onClick={onOpen}
          aria-current={active}
          title={title ?? name}
        >
          {dot}
          <span className="rail__chat-name">{name}</span>
          {children}
        </button>
      )}
      {hasActions && (
        <span className="rail__chat-actions">
          {onRename && (
            <button
              className="rail__chat-rename"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              aria-label={`Rename chat ${name}`}
              title="Rename chat"
            >
              <Pencil className="size-3" aria-hidden="true" />
            </button>
          )}
          {onClose && (
            <button
              className="rail__chat-x"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={closeLabel ?? `Close chat ${name}`}
              title={closeTitle ?? "Close chat"}
            >
              ×
            </button>
          )}
        </span>
      )}
    </li>
  );
}
