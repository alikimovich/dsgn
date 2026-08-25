import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  agentModelId,
  agentOptionsFor,
  type ChatAgentSettings,
  chatAgentSettingsFromSession,
  describeSelectionForPrompt,
  type ModelSelection,
  selectionForBubble,
  isAuthError,
  oneLine,
  useAnnotations,
  useChat,
  useComposer,
  useHistory,
  useLayersPanel,
  usePermissions,
  useQuestions,
  useCodeDrawer,
  useSelection,
  useSession,
  useSetup,
  useSpawns,
  useTokens,
  useUiActions,
  useWorkspace,
  usePropsIsland,
} from "../store";
import { recordLastUsedSettings } from "../preferred-model";
import {
  defaultChoiceFor,
  providerOptions,
  resolveSelection,
  useProviders,
} from "../providers-store";
import {
  type Attachment,
  draftAttachments,
  draftText,
  useComposerDrafts,
} from "../composer-drafts";
import { projectKey } from "../../../shared/projectKey";
import { parseSlashToken } from "../../../shared/slash-token";
import type {
  PermissionMode,
  QuestionAnswers,
  SetupResult,
} from "../../../shared/api";
import { rankSlashMatches } from "../../../shared/slash-menu";
import ConflictCard from "./ConflictCard";
import Inspector from "./Inspector";
import LayersPanel from "./LayersPanel";
import Markdown from "./Markdown";
import NotesPanel from "./NotesPanel";
import PermissionCards from "./PermissionCards";
import QuestionCards from "./QuestionCards";
import SetupCard from "./SetupCard";
import TokenOfferCard from "./TokenOfferCard";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { splitUrls } from "@/lib/elide-url";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Layers,
  MousePointer2,
  Undo2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import CatLoader from "./CatLoader";
import RunStats from "./RunStats";

// The picker is TWO dropdowns (the pre-v10 shape): a provider — Claude, Codex,
// then every saved connection — and that provider's models. Both are derived from
// the ONE flat list main hands over (`providers.choices()`); nothing about models
// or endpoints is hardcoded here any more. A sentinel row at the bottom of the
// provider list opens Settings instead of selecting a provider.
const MANAGE_PROVIDERS = "__manage-providers__";

// `bypassPermissions` is intentionally omitted — see its "unused" doc note on
// PermissionMode (shared/api.ts): skips praxis's own canUseTool guards too, not
// just the SDK's, so it isn't offered as a user-facing choice.
const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Allow edits" },
  { value: "default", label: "Ask always" },
];

// The one-time CLI sign-in for a harness that authenticates with the user's own
// subscription (v7). Keyed by HARNESS, not by picker row, and only consulted when
// the chat is on that harness's OWN account: a saved connection is its own row in
// the provider dropdown but runs on the Codex harness with its stored API key, so
// telling that user to run `codex login` would send them the wrong way.
const HARNESS_LOGIN: Record<string, { login: string; blurb: string }> = {
  codex: {
    login: "codex login",
    blurb: "OpenAI Codex runs on your ChatGPT subscription",
  },
};

/**
 * Framework-correct setup instructions for the agent. Returns null when the
 * framework isn't one praxis can instrument — never hand React instructions to a
 * non-React repo.
 */
/**
 * A collapsible disclosure for an assistant turn's tool-use steps (v6 — the AI
 * Elements Task/Reasoning pattern, built on the already-vendored shadcn Collapsible,
 * no new deps). A long tool run used to bury the answer under a flat status list;
 * now the steps collapse to a one-line summary (latest step + count) the user can
 * expand. Collapsed by default (the cat loader signals progress); a manual toggle
 * is respected, and it re-collapses once the turn finishes.
 */
function StepDisclosure({
  statuses,
  active,
}: {
  statuses: string[];
  active: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => {
    // Tidy up if the user expanded a live turn: collapse when it finishes.
    if (wasActive.current && !active) setOpen(false);
    wasActive.current = active;
  }, [active]);
  const last = statuses[statuses.length - 1] ?? "";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="msg__steps">
      <CollapsibleTrigger className="msg__steps-trigger group flex w-fit max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 max-w-[240px] truncate font-mono">
          {open ? "Steps" : last}
        </span>
        <span className="shrink-0 opacity-60">
          · {statuses.length} step{statuses.length === 1 ? "" : "s"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2.5">
        {statuses.map((s, i) => (
          <div
            key={i}
            className="msg__status font-mono text-xs text-muted-foreground"
          >
            › {s}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A user ask's text bubble, capped to a handful of lines with a bottom fade
 * when it's long enough to overflow — clicking expands it to full height and
 * scrolls it to the top of the conversation scroller (assistant text is
 * unaffected; it already renders through `<Markdown>` with no cap). Clicking
 * only ever expands: collapsing back down is scroll-driven (see the
 * wheel/touchmove handler in ChatPanel), not another click — so once
 * expanded, the bubble is inert (no cursor, no handlers) rather than
 * toggling. The overflow check is measured against the DOM (`scrollHeight`
 * vs `clientHeight`) rather than a line/character count, so it only ever
 * kicks in when the bubble truly exceeds the cap — short messages get no
 * fade, no pointer cursor, no click handler.
 *
 * That cap is vertical only, so long URLs got their own treatment (LKM-64):
 * a pasted link is one unbreakable token, and the bubble is sized to its
 * content, so a link wider than the pane used to drag the whole bubble off
 * the left edge. Links now render elided (`splitUrls`) with the full URL on
 * the tooltip, and `.msg__text` breaks anything still too long to fit.
 */
function ClampedUserText({
  text,
  expanded,
  onExpand,
}: {
  text: string;
  expanded: boolean;
  onExpand: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const wasExpanded = useRef(expanded);
  // ClampedUserText renders inside <Conversation>, so it can reach the
  // stick-to-bottom context directly — no prop plumbing needed.
  const { stopScroll } = useStickToBottomContext();
  const runs = useMemo(() => splitUrls(text), [text]);

  // Only measurable while collapsed (the clamp's max-height is what makes
  // scrollHeight > clientHeight meaningful); once we've learned a bubble
  // overflows, that fact doesn't change, so skip re-measuring once expanded.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = (): void =>
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  // Scroll the bubble to where it was actually posted only on the
  // collapsed→expanded transition (not on every render, and not when
  // re-collapsing). Expanding grows the content a lot, and if the
  // conversation was scrolled to the bottom, `<Conversation>`'s own
  // resize-triggered auto-scroll fights our scroll right back down to the
  // bottom the moment it fires — `stopScroll()` (escapes its stick-to-bottom
  // lock) before scrolling so ours actually wins.
  useEffect(() => {
    if (!wasExpanded.current && expanded) {
      stopScroll();
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    wasExpanded.current = expanded;
  }, [expanded, stopScroll]);

  const clickable = overflows && !expanded;

  return (
    <div
      ref={ref}
      className={cn(
        "msg__text w-fit max-w-full rounded-lg border border-[var(--border-prominent)] bg-muted px-3 py-2 text-sm",
        !expanded && "msg__text--clamp",
        clickable && "cursor-pointer",
      )}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onExpand : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onExpand();
              }
            }
          : undefined
      }
    >
      {runs.map((run, i) =>
        run.kind === "link" ? (
          // Elided to host + last segment; the full URL stays in the tooltip.
          // Not an anchor — a user's ask is plain text, not a link surface.
          <span key={i} className="msg__link" title={run.href}>
            {run.label}
          </span>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
      {!expanded && overflows && (
        <div className="msg__text-fade" aria-hidden="true" />
      )}
    </div>
  );
}

/** Copy-to-clipboard button for a finished assistant message. Renders bare (no row
 *  wrapper) so it sits alongside Revert in the shared `msg__actions` row. */
function CopyAction({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="msg__action"
      aria-label="Copy message"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Per-turn "Revert changes" button (v-next): rolls back the file edits one merged
 * chat turn made, via its edit-history group. Only rendered when the turn carries a
 * `revertGroup` (a merged, not-yet-pushed turn on a repo-root chat). A revert is
 * refused with an inline hint when a later turn or a hand edit touched the same files
 * since — the "safe" semantics. The dev server HMRs the restored files automatically.
 */
function RevertAction({
  root,
  group,
}: {
  root: string;
  group: string;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "conflict">("idle");
  return (
    <>
      <button
        className="msg__action"
        aria-label="Revert changes"
        title="Revert this turn's changes"
        onClick={() => {
          void window.api.edits.revert(root, group).then((r) => {
            setState(r.ok ? "done" : "conflict");
            setTimeout(() => setState("idle"), r.ok ? 1500 : 3000);
          });
        }}
      >
        {state === "done" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Undo2 className="size-3.5" aria-hidden="true" />
        )}
      </button>
      {state === "conflict" && (
        <span className="msg__action-hint">
          Can't revert — files changed since this turn
        </span>
      )}
    </>
  );
}

function setupPrompt(res: SetupResult): string | null {
  const file = res.files?.[0];
  switch (res.framework) {
    case "react":
      return (
        `Praxis detected a React project and added a dev-only Babel plugin at \`${file}\`. Please: ` +
        `(1) read the actual vite.config and wire ${file} into the React plugin's Babel config ` +
        `(\`react({ babel: { plugins: [...] } })\`) FOR DEVELOPMENT ONLY — gate it on the serve/dev ` +
        `command; if the config shape differs, adapt to the real file or tell me what's blocking ` +
        `rather than guessing. (2) Add an explicit \`interface Props\` to the components so their ` +
        `props are editable. Then I'll reload the preview.`
      );
    case "react-native":
      return (
        `Praxis detected a React Native / Expo project and added a dev-only Babel plugin at ` +
        `\`${file}\` that stamps \`testID="praxis:path:line:col"\` on elements (the RN analog of ` +
        `data-praxis-source — iOS surfaces testID as the accessibility id, which Praxis reads from ` +
        `the simulator's view hierarchy). Please: (1) read babel.config.js (or .babelrc) and add ` +
        `${file} to the \`plugins\` array FOR DEVELOPMENT ONLY (gate on a dev env check; adapt to ` +
        `the real config, don't guess its shape). (2) Add an explicit \`interface Props\` to your ` +
        `components so their props are editable. Then I'll reload the preview.`
      );
    case "solid":
      return (
        `Praxis detected a Solid project and added a dev-only Babel JSX plugin at \`${file}\`. Please ` +
        `wire ${file} into the Solid Vite plugin's Babel config for development only (adapt to the ` +
        `real config), and type each component's props with an explicit \`Props\` type. Then I'll ` +
        `reload the preview.`
      );
    case "svelte": {
      const typing =
        res.svelteMajor && res.svelteMajor < 5
          ? "Type props with typed `export let` declarations (Svelte 4)"
          : "Type props with `interface Props` + `let { ... }: Props = $props()` (Svelte 5)";
      return (
        `Praxis detected a Svelte project and added a dev-only markup preprocessor at \`${file}\`. ` +
        `Please: (1) read svelte.config.* and add ${file}'s default export to the \`preprocess\` ` +
        `array FOR DEVELOPMENT ONLY (gate on dev; adapt to the real config, don't guess its shape). ` +
        `(2) ${typing} so props are editable. Then I'll reload the preview.`
      );
    }
    case "vue":
      return (
        `Praxis detected a Vue project. Please add a DEV-ONLY way to map elements to their source as a ` +
        `\`data-praxis-source="path:line:col"\` attribute (e.g. vite-plugin-vue-inspector, or a small ` +
        `template transform), and type props with \`defineProps<Props>()\`. Then I'll reload the preview.`
      );
    default:
      return null;
  }
}

export default function ChatPanel(): React.JSX.Element {
  const {
    messages,
    isRunning,
    isolation,
    isolationFiles,
    appendUser,
    appendNote,
    startAssistant,
    appendDelta,
    appendStatus,
    addUsage,
    finish,
  } = useChat();
  const { model, modelId, provider, connectionId, slashCommands, projectRoot, setModelSelection } =
    useSession();
  const codexAuthNeeded = useSession((s) => s.codexAuthNeeded);
  // v10 model picker contents (main is the single source of truth). Fetched once,
  // and re-fetched by the settings dialog after every save/remove.
  const choices = useProviders((s) => s.choices);
  useEffect(() => {
    useProviders.getState().ensureLoaded();
  }, []);
  const { selected, setSelected } = useSelection();
  const selectMode = useSelection((s) => s.selectMode);
  const layersOpen = useLayersPanel((s) => s.open);
  const setLayersOpen = useLayersPanel((s) => s.setOpen);
  const inspection = useSelection((s) => s.inspection);
  const inspecting = useSelection((s) => s.inspecting);
  const { mode: permissionMode, pending: allPending, removeRequest, setMode } = usePermissions();
  const allQuestions = useQuestions((s) => s.pending);
  const removeQuestion = useQuestions((s) => s.removeRequest);
  const { list: notes, focusedId, setList: setNotes } = useAnnotations();
  const tokens = useTokens();
  const setup = useSetup();
  const composerSeed = useComposer((s) => s.seed);
  const composerSubmit = useComposer((s) => s.submit);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  // A half-written message belongs to the chat it was written in, so the
  // composer's content is keyed by chat rather than held in component state:
  // ChatPanel is mounted once for the whole app, so plain local state would just
  // follow the user into whichever chat they switch to. Switching away parks the
  // text; switching back finds it again; a chat never typed in opens blank.
  const activeChatKey = useChat((s) => s.activeKey);
  // Permission/question cards are keyed by the session that raised them (see
  // `PermissionRequest.sessionKey` / `QuestionRequest.sessionKey`) — a backgrounded
  // chat's turn can still hit a gated tool call or AskUserQuestion while another
  // chat is on screen, and its card must stay attached to ITS chat rather than
  // rendering wherever the user happens to be looking. ChatPanel is mounted once
  // for the whole app, so this filter is what keeps the two from crossing.
  const pending = useMemo(
    () => allPending.filter((p) => p.sessionKey === activeChatKey),
    [allPending, activeChatKey],
  );
  const questions = useMemo(
    () => allQuestions.filter((q) => q.sessionKey === activeChatKey),
    [allQuestions, activeChatKey],
  );
  const input = useComposerDrafts((s) => draftText(s, activeChatKey));
  const attachments = useComposerDrafts((s) => draftAttachments(s, activeChatKey));
  // `useState`-shaped setters (value or updater) so every call site below reads
  // as it did when these were `useState`.
  const setInput = (value: React.SetStateAction<string>): void =>
    useComposerDrafts.getState().update(activeChatKey, (d) => ({
      ...d,
      text: typeof value === "function" ? value(d.text) : value,
    }));
  const setAttachments = (value: React.SetStateAction<Attachment[]>): void =>
    useComposerDrafts.getState().update(activeChatKey, (d) => ({
      ...d,
      attachments: typeof value === "function" ? value(d.attachments) : value,
    }));
  // Caret position in the composer — drives which "/" token the slash menu reads
  // (the menu can open mid-message, not just at the start).
  const [caret, setCaret] = useState(0);
  const [menuActive, setMenuActive] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The "/" menu is uncapped and scrolls (see rankSlashMatches); keep the
  // keyboard-selected row inside the viewport as you arrow past the fold.
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Which conflict-card action is in flight (drives its spinners); null when idle.
  const [conflictBusy, setConflictBusy] = useState<null | "resolve" | "discard">(
    null,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Long user asks are clamped by default (item 2) — ids in this set render
  // full-height instead. Clicking only ever EXPANDS (never collapses): the
  // user asked for scroll, not another click, to collapse it again — see the
  // wheel/touchmove effect below.
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<Set<string>>(
    new Set(),
  );
  const expandUserMsg = (id: string): void => {
    setExpandedUserMsgs((prev) =>
      prev.has(id) ? prev : new Set(prev).add(id),
    );
  };
  const chatRootRef = useRef<HTMLDivElement>(null);
  // A real DOWNWARD scroll gesture (wheel/touch — not our own programmatic
  // scrollIntoView, which fires neither) collapses whatever's expanded, so it
  // goes back to being a compact, sticky reminder instead of hanging around as
  // a wall of text once the user moves on. Scrolling UP (re-reading something
  // above) leaves it expanded — only forward progress should collapse it.
  useEffect(() => {
    const el = chatRootRef.current;
    if (!el) return;
    const collapseExpanded = (): void => {
      setExpandedUserMsgs((prev) => (prev.size ? new Set() : prev));
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY > 0) collapseExpanded();
    };
    // Touch has no delta — infer direction from consecutive touch positions:
    // the finger moving UP the screen drags content UP (i.e. scrolls down).
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent): void => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY;
      if (y == null) return;
      if (lastTouchY != null && lastTouchY - y > 0) collapseExpanded();
      lastTouchY = y;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  // The restored draft comes back with the cursor at its end — the caret is
  // per-composer, not per-chat, so without this the slash menu would keep
  // reading the outgoing chat's caret against the incoming chat's text.
  useEffect(() => {
    setCaret(useComposerDrafts.getState().byKey[activeChatKey]?.text.length ?? 0);
  }, [activeChatKey]);

  // Auto-grow the composer with the text — from 2 lines up to 6, then scroll.
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const min = lh * 2 + padY;
    const max = lh * 6 + padY;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(min, Math.min(ta.scrollHeight, max))}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  // Don't carry a publish result across projects (it'd show under the new repo).
  useEffect(() => {
    setPublishMsg(null);
    setPublishing(false);
  }, [projectRoot]);

  // App-level components (prop panel, setup) seed the composer via the store.
  useEffect(() => {
    if (composerSeed == null) return;
    setInput((cur) => (cur.trim() ? `${composerSeed} ${cur}` : composerSeed));
    useComposer.getState().setSeed(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  }, [composerSeed]);

  // Inline comment-mode (C) sends straight to the agent. If a turn is already
  // running, prefill instead so the comment is never dropped.
  useEffect(() => {
    if (composerSubmit == null) return;
    useComposer.getState().setSubmit(null);
    if (isRunning) seedPrompt(composerSubmit);
    else send(composerSubmit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSubmit]);

  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      // v8 F1: a detached comment spawn's events carry a `sessionId` — they NEVER
      // enter the main chat stream. We only react to the terminal `spawn-finished`
      // (drop the working rail row; the finished run reappears in history). This
      // guard is what guarantees the active chat stays byte-clean under parallel spawns.
      if (event.sessionId) {
        const pkey = event.projectKey ?? "";
        if (event.type === "spawn-started") {
          useSpawns.getState().start(pkey, event.sessionId, event.branch);
        } else if (event.type === "spawn-finished") {
          useSpawns.getState().remove(pkey, event.sessionId);
          // Notify in the parent project's chat so the user can follow up on it. A
          // null branch means it auto-applied onto the working tree; a branch means
          // it couldn't (conflict) and is waiting in the rail for review.
          const files = event.files?.length
            ? ` · ${event.files.join(", ")}`
            : "";
          const head = event.branch
            ? `💬 Comment finished — couldn't auto-apply, review it in the sidebar${files}`
            : `💬 Comment applied${files}`;
          useChat
            .getState()
            .appendNote(
              event.summary ? `${head}\n\n${event.summary}` : head,
              pkey,
            );
          // `pkey` is the PARENT SESSION key now, not the bare project key — a
          // spawn from a secondary chat reads `<projectKey>#<uuid>`. Match on the
          // project prefix so the finished agent still refreshes its history.
          const root = useSession.getState().projectRoot;
          const pk = root ? projectKey(root) : null;
          if (root && pk && (pkey === pk || pkey.startsWith(`${pk}#`)))
            void useHistory.getState().load(root);
        }
        return;
      }
      // Route to the emitting project's chat slice (main tags every event). The
      // active project's slice is what's shown; a backgrounded project keeps
      // streaming into its own (a "working" dot in the rail).
      const key = event.projectKey ?? "";
      const isActive = key === useChat.getState().activeKey;
      if (event.type === "delta") {
        appendDelta(event.text, key);
      } else if (event.type === "title") {
        // Auto-generated chat name (main summarised the conversation) — the rail
        // shows it in place of the opening-words heuristic.
        useChat.getState().setTitle(key, event.title);
      } else if (event.type === "status") {
        appendStatus(event.text, key);
      } else if (event.type === "usage") {
        // Token deltas from the backend (already deduped in main) — they sum into
        // the chat's totals for the status line.
        addUsage(
          { input: event.input, output: event.output, cached: event.cached },
          key,
        );
      } else if (event.type === "error") {
        // A Claude auth failure gets a short line pointing at the (Claude-specific)
        // onboarding banner. Non-Claude backends (Codex/Gemini) have no such banner
        // and emit a descriptive "install the CLI + log in" message — show that as-is
        // rather than a misleading "not connected to Claude". (v7)
        const isClaude =
          (useSession.getState().provider ?? "claude") === "claude";
        const note =
          isAuthError(event.message) && isClaude
            ? "⚠️ Not connected to Claude — see the notice above."
            : `⚠️ ${event.message}`;
        appendDelta(`\n\n${note}`, key);
        finish(key);
        // The setup turn failed before wiring — disarm verification so the next
        // unrelated readiness report isn't mistaken for a verdict. Setup state is
        // the active project's, so only its failed turn touches it.
        if (isActive) {
          useSetup.getState().setBusy(false);
          useSetup.getState().setVerifying(false);
        }
      } else if (event.type === "done") {
        finish(key);
        if (isActive) {
          const s = useSetup.getState();
          // `busy` set ⟺ this was the setup turn: it edited the build config, which
          // the dev server only picks up on a full restart. Arm verification and ask
          // App to restart + reload the preview. Normal chat turns leave it alone.
          if (s.busy) {
            s.setVerifying(true);
            s.setRestartRequested(true);
          }
          s.setBusy(false);
        }
      } else if (event.type === "isolation") {
        // v9: this chat's per-turn worktree merge — drives the header chip.
        // 'merged' folds back to the resting 'isolated' state (the chip already
        // reads "Isolated"; a per-turn merge is the expected happy path, so it
        // gets a subtle status line rather than a full note).
        useChat
          .getState()
          .setIsolation(
            key,
            event.state === "parked" ? "parked" : "isolated",
            event.files,
          );
        if (event.state === "merged") {
          // No active streaming message exists post-`done` (appendStatus needs
          // one) — a plain note is the subtle line instead. Append it FIRST so the
          // revert group below lands on this note (now the last assistant message).
          useChat.getState().appendNote("Merged into your branch", key);
          // Tag the note — the very last thing in the turn — with the revert group so
          // the Revert button sits at the END of the AI output; tagging the response
          // bubble above the note leaves the button buried where it's easy to miss.
          // Skipped when main marks it non-revertable (pushed via PR).
          if (event.group && event.revertable !== false)
            useChat.getState().tagRevert(key, event.group);
        } else if (event.state === "parked") {
          // The in-chat ConflictCard (driven by `isolation === 'parked'`) now explains
          // this and offers Resolve/Discard — no text note needed. Still refresh the
          // sidebar so the parked chat's badge/record reflects it if it's showing.
          const root = useSession.getState().projectRoot;
          if (root && projectKey(root) === key.split("#")[0])
            void useHistory.getState().load(root);
        }
      }
    });
  }, [appendDelta, appendStatus, addUsage, finish]);

  // "/" slash-command menu state. The menu reads the "/" token containing the
  // caret, so it triggers anywhere in the message — at the very start or after a
  // space — but NOT when a non-whitespace character sits right before the "/".
  const slashToken = useMemo(
    () => parseSlashToken(input, caret),
    [input, caret],
  );
  const slashQuery = slashToken?.query ?? null;
  const matches = useMemo(() => {
    if (slashQuery === null) return [];
    // Project skills rank first, same-named non-project commands are shadowed,
    // and there's no cap — the .slash scroll container handles overflow so every
    // match stays reachable. See src/shared/slash-menu.ts.
    return rankSlashMatches(slashCommands, slashQuery);
  }, [slashQuery, slashCommands]);
  const menuOpen = slashQuery !== null && matches.length > 0 && !menuDismissed;

  useEffect(() => {
    // Re-arm the menu for each distinct "/" query (Escape only hides the current one).
    setMenuActive(0);
    setMenuDismissed(false);
  }, [slashQuery]);

  useEffect(() => {
    // Keep the arrow-selected row visible as it moves past the scroll fold.
    if (menuOpen) activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [menuActive, menuOpen]);

  const onInputChange = (value: string, pos: number): void => {
    setInput(value);
    setCaret(pos);
  };

  const pickCommand = (cmd: string): void => {
    if (!slashToken) return;
    const { start } = slashToken;
    const insert = `/${cmd} `;
    const next = input.slice(0, start) + insert + input.slice(caret);
    const nextCaret = start + insert.length;
    setInput(next);
    setCaret(nextCaret);
    setMenuDismissed(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  };

  // Seed the composer with `text` and drop the cursor at the end.
  const seedPrompt = (text: string): void => {
    setInput((cur) => (cur.trim() ? `${text} ${cur}` : text));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  };

  // Accept the setup offer: write the stamping plugin (deterministic), then hand
  // the wiring + component typing to the agent.
  const acceptSetup = async (): Promise<void> => {
    if (!projectRoot || setup.busy || isRunning) return;
    setup.setBusy(true);
    setup.setStatus("Detecting framework + adding source-mapping…");
    try {
      const res = await window.api.setup.scaffold(projectRoot);
      if (!res.ok) {
        setup.setStatus(`Setup failed: ${res.error ?? "unknown error"}`);
        setup.setBusy(false);
        return;
      }
      const prompt = setupPrompt(res);
      if (!prompt) {
        // Unsupported / undetected framework — stop and say so, never send a
        // React prompt into a repo we couldn't classify.
        setup.setStatus(
          res.framework && res.framework !== "unknown"
            ? `Detected ${res.framework}, which Praxis can't auto-instrument yet. Ask me directly to add element→source mapping.`
            : `Couldn't detect a supported framework (React/Svelte/Vue/Solid). Open one of those, or ask me directly.`,
        );
        setup.setBusy(false);
        return;
      }
      // Stream the agent turn into the chat (and flip `isRunning`) so the user can
      // watch progress and stop it. `busy` stays true until the turn finishes —
      // cleared by the `done`/`error` handler — so the card can't be re-triggered.
      // `busy` also marks "this is the setup turn"; verification is armed only when
      // it finishes (see the `done` handler), so a mid-turn dev-server auto-restart
      // can't be mistaken for the verdict.
      startAssistant();
      void window.api.agent.send(prompt);
      setup.setStatus(
        `Detected ${res.framework}. Asked Praxis to wire it in and type your components — I'll restart the preview and verify automatically when it finishes.`,
      );
    } catch {
      setup.setStatus("Setup could not be started.");
      setup.setBusy(false);
    }
  };

  // Write a starter `.praxis/tokens.json` (deterministic — no agent turn) and show
  // the new tokens in the palette. Idempotent on the main side.
  const acceptTokenScaffold = async (): Promise<void> => {
    if (!projectRoot || tokens.scaffolding) return;
    const root = projectRoot;
    tokens.setScaffolding(true);
    try {
      const res = await window.api.tokens.scaffold(root);
      // If the user switched projects while the write was in flight, the new
      // project owns the token state now — don't stamp this project's tokens over
      // it (mirrors the detect handler's guard in App).
      if (useSession.getState().projectRoot !== root) return;
      if (!res.ok) return;
      if (res.set) tokens.setSet(res.set);
      tokens.setOfferNeeded(false);
    } catch {
      /* leave the offer up so the user can retry */
    } finally {
      if (useSession.getState().projectRoot === root)
        tokens.setScaffolding(false);
    }
  };

  // Ask the agent to remove the selected element. The transcript shows a short
  // human-readable request; the element reference travels hidden (like send()).
  const deleteSelection = (): void => {
    if (!selected || isRunning) return;
    const ident = selected.id
      ? `#${selected.id}`
      : selected.classes[0]
        ? `.${selected.classes[0]}`
        : "";
    appendUser(`Delete the <${selected.tag}${ident}> element`);
    startAssistant();
    void window.api.agent.send(
      describeSelectionForPrompt(selected) +
        "Delete this element from the source. Remove it cleanly — including any wrappers, imports, or styles that exist only for it.",
    );
    setSelected(null);
  };
  // Conflict card — "Resolve it". Main stages the parked chat's worktree with both
  // sides 3-way merged; if they overlap it returns a resolution prompt we run as a
  // normal turn (whose merge-back unparks the chat), and if they merged cleanly it has
  // already applied them (no turn to run). The user's request bubble is short and
  // human-readable; the detailed prompt travels hidden, like `deleteSelection`.
  const resolveConflict = async (): Promise<void> => {
    if (conflictBusy || isRunning) return;
    setConflictBusy("resolve");
    try {
      const r = await window.api.agent.resolveConflict();
      if (!r.ok) {
        appendNote(
          `I couldn't start resolving those changes${r.error ? ` (${r.error})` : ""}. You can try again or discard them.`,
        );
        return;
      }
      if (r.conflicted.length && r.prompt) {
        appendUser("Resolve the conflict with my recent edits");
        startAssistant();
        void window.api.agent.send(r.prompt);
      }
      // Otherwise the two sides merged cleanly — the 'merged' isolation event already
      // flipped the chat back and dropped a note; nothing to send.
    } finally {
      setConflictBusy(null);
    }
  };
  // Conflict card — "Discard changes". Drop the parked chat's unmerged work; main emits
  // an 'isolated' event that unmounts the card.
  const discardConflict = async (): Promise<void> => {
    if (conflictBusy || isRunning) return;
    setConflictBusy("discard");
    try {
      await window.api.agent.discardConflict();
    } finally {
      setConflictBusy(null);
    }
  };

  // The in-preview selection toolbar routes its code/delete actions here (its
  // comment/annotate open the preview's own composer). Ref-indirected so the
  // one-time listener always runs the current closure.
  const deleteSelectionRef = useRef<() => void>(() => {});
  deleteSelectionRef.current = deleteSelection;
  useEffect(
    () =>
      window.api.preview.onToolbarAction((kind) => {
        const sel = useSelection.getState().selected;
        if (!sel) return;
        if (kind === "code" && sel.source) {
          const drawer = useCodeDrawer.getState();
          if (drawer.source === sel.source) drawer.close();
          else drawer.open(sel.source);
        } else if (kind === "delete") {
          deleteSelectionRef.current();
        } else if (kind === "props") {
          usePropsIsland.getState().setOpen(!usePropsIsland.getState().open);
        }
      }),
    [],
  );

  // Read image files (paste/drop) into base64 attachments + a preview URL. A
  // dropped image also keeps its on-disk path (recovered in the preload); a
  // pasted one has none, and gets one written for it at send time.
  const addImageFiles = (files: File[]): void => {
    let nextId = Date.now();
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const path = window.api.pathForFile(file);
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result); // data:<mime>;base64,<data>
        const data = url.slice(url.indexOf(",") + 1);
        setAttachments((a) => [
          ...a,
          {
            id: `att${nextId++}`,
            kind: "image",
            mediaType: file.type,
            data,
            url,
            name: file.name,
            path,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  // Non-image files ride along by absolute path (recovered in the preload — the
  // renderer's File has no .path on Electron 43), which the agent reads itself.
  // Pathless blobs (e.g. an in-memory clipboard file) have nothing to hand over,
  // so they're skipped.
  const addFiles = (files: File[]): number => {
    let nextId = Date.now();
    const added: Attachment[] = [];
    for (const file of files) {
      const path = window.api.pathForFile(file);
      if (!path) continue;
      added.push({ id: `file${nextId++}`, kind: "file", name: file.name, path });
    }
    if (added.length) setAttachments((a) => [...a, ...added]);
    return added.length;
  };

  // Split a dropped/pasted FileList into the image bucket (base64 vision blocks)
  // and everything else (by-path file cards). Returns whether anything attached.
  const addDroppedFiles = (files: File[]): boolean => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (images.length) addImageFiles(images);
    const filesAdded = others.length ? addFiles(others) : 0;
    return images.length > 0 || filesAdded > 0;
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.files);
    if (files.length && addDroppedFiles(files)) {
      e.preventDefault(); // don't also paste the file's path/text
    }
  };

  const onDrop = (e: React.DragEvent): void => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length && addDroppedFiles(files)) e.preventDefault();
    setDragOver(false);
  };

  const send = (raw: string = input): void => {
    const text = raw.trim();
    if ((!text && attachments.length === 0) || isRunning) return;
    const imageAtts = attachments.flatMap((a) =>
      a.kind === "image" ? [a] : [],
    );
    const images = imageAtts.map((a) => ({
      mediaType: a.mediaType,
      data: a.data,
    }));
    const files = attachments.filter((a) => a.kind === "file");
    // File attachments ride as hidden context (like the selection pill below):
    // the agent gets each absolute path prepended so it can read the file with
    // its own tools; the transcript keeps the user's own words.
    const fileCtx = files.length
      ? `[Attached files]\n${files.map((f) => f.path).join("\n")}\n\n`
      : "";
    // The selection pill rides along as hidden context: the transcript shows
    // the user's own words; the model gets the element reference prepended so
    // it knows what it's looking at. (The preview's current page is no longer
    // silently prepended — the agent has a `preview_location` tool and asks
    // when the page actually matters.)
    const ctx = selected ? describeSelectionForPrompt(selected) : "";
    // Carry the images + selection onto the sent bubble so they stay visible in
    // the transcript (not just the composer) — the image thumbnails the user
    // dropped in and the element pill they picked. Files have no thumbnail, so
    // when the user typed nothing, name them in the bubble text instead.
    const fileSummary = files.length
      ? `📎 ${files.map((f) => f.name).join(", ")}`
      : "";
    appendUser(text || fileSummary, undefined, {
      attachments: imageAtts.map((a) => ({
        id: a.id,
        mediaType: a.mediaType,
        url: a.url,
      })),
      selection: selected ? selectionForBubble(selected) : undefined,
    });
    startAssistant();
    setInput("");
    setCaret(0);
    setAttachments([]);
    // A newly-sent ask becomes the pinned message — any previously-expanded
    // ask should collapse back to its clamp instead of hanging around full-height.
    setExpandedUserMsgs(new Set());
    // Images ride as vision blocks, but the agent also needs to know WHERE each
    // one is: without a path it can see a screenshot and still have to ask the
    // user to find it before it can copy it into the repo. Dropped images
    // already have their real path; pasted ones are only clipboard bytes, so
    // main writes them out first (at send, not at paste — an attachment the user
    // removes again should never hit the disk). A save that fails just yields no
    // path, leaving that image vision-only as before.
    void (async () => {
      const paths = await Promise.all(
        imageAtts.map((a) =>
          a.path
            ? Promise.resolve(a.path)
            : window.api.agent
                .saveAttachment({ mediaType: a.mediaType, data: a.data }, a.name)
                .catch(() => ""),
        ),
      );
      const imageCtx = paths.some(Boolean)
        ? `[Attached images — the image(s) in this message are on disk at]\n${paths
            .filter(Boolean)
            .join("\n")}\n\n`
        : "";
      await window.api.agent.send(
        fileCtx + imageCtx + ctx + text,
        images.length ? images : undefined,
      );
    })();
    if (selected) setSelected(null);
  };

  // Interrupt the in-flight turn. The SDK emits a `result` → `done`, which clears
  // `isRunning` via the agent-event handler. An interrupt is indistinguishable
  // from a clean completion at the `done` handler, so if this is a *setup* turn
  // being cancelled, drop `busy` now: that's what marks "the setup turn finished
  // successfully", so clearing it stops the incoming `done` from restarting the
  // dev server + arming a (bogus) verdict against half-written config.
  const stop = (): void => {
    const s = useSetup.getState();
    if (s.busy) {
      s.setBusy(false);
      s.setStatus("Setup cancelled.");
    }
    void window.api.agent.interrupt();
  };

  // The toolbar IS this chat's settings: every picker change persists the whole
  // set for the active sessionKey (so switching away and back restores it) and
  // returns it, so whatever we then hand main matches what's on screen — mode
  // included. Returns null when there's no open project to attribute it to.
  const persistChatSettings = (
    partial: Partial<ChatAgentSettings>,
  ): { sessionKey: string; settings: ChatAgentSettings } | null => {
    const entry = useWorkspace
      .getState()
      .projects.find((p) => p.root === projectRoot);
    if (!entry) return null;
    const sessionKey = entry.activeSessionKey ?? entry.key;
    const settings = {
      ...chatAgentSettingsFromSession(useSession.getState()),
      ...partial,
    };
    useWorkspace.getState().patchEntry(entry.key, {
      chatSettings: { ...entry.chatSettings, [sessionKey]: settings },
    });
    recordLastUsedSettings(settings);
    return { sessionKey, settings };
  };

  // The two dropdowns' contents, derived from main's one flat choice list: the
  // providers (Claude, Codex, then each saved connection) and — via
  // `resolveSelection` — which provider row and which of ITS models this chat's
  // stored settings should show. Model ids are discovered now, so a chat
  // persisted against one the harness has since retired (or against a deleted
  // connection) resolves to that provider's Default instead of a dead row; the
  // stored settings themselves are left alone until the user actually picks.
  const providers = useMemo(() => providerOptions(choices), [choices]);
  const selection = useMemo(
    () => resolveSelection(providers, { model, provider, connectionId }),
    [providers, model, provider, connectionId],
  );

  /**
   * Apply one picker choice — whichever dropdown produced it. The whole tuple
   * moves together (and the undefined members are SET, not omitted, so moving to
   * a plain Claude model clears a previous choice's `modelId`/`connectionId`
   * instead of inheriting them).
   *
   * Restart rules, unchanged since the pre-v10 pair of dropdowns: Claude alone
   * can swap models mid-thread. Codex fixes its model when the thread starts (a
   * live `setModel` is a no-op there — see backends/codex.ts), and a connection
   * rides the SAME Codex harness with a different endpoint, so any move onto, off
   * of, or between Codex/connection models restarts just THIS chat. Reopening the
   * whole project would replace its default chat even while the user is looking
   * at an additional one.
   */
  const applySelection = (next: ModelSelection): void => {
    const liveSwap =
      next.provider === "claude" &&
      provider === "claude" &&
      !next.connectionId &&
      !connectionId;
    setModelSelection(next);
    const chat = persistChatSettings(next);
    if (!liveSwap) {
      if (!projectRoot || !chat) return;
      void window.api.agent.restartChat(
        projectRoot,
        chat.sessionKey,
        agentOptionsFor(chat.settings),
      );
      useChat.getState().finish();
      return;
    }
    // "Default" means "no model" — there's nothing to hand the live session.
    const id = agentModelId(next);
    if (id) void window.api.agent.setModel(id);
  };

  // Switching provider lands on that provider's Default (a connection has no
  // Default sentinel, so its first model) — a model id never carries across
  // providers, and the chat's stored one may not even exist on the new one.
  const onProviderChange = (key: string): void => {
    const option = providers.find((o) => o.key === key);
    const choice = option && defaultChoiceFor(option);
    if (!option || !choice) return;
    applySelection({
      model: choice.value,
      modelId: choice.modelId,
      provider: option.provider,
      connectionId: option.connectionId,
    });
  };

  // Only the selected provider's models are offered, so the choice is looked up
  // within it — the same id can appear under several providers.
  const onModelChange = (value: string): void => {
    const choice = selection.option?.models.find((c) => c.value === value);
    if (!choice) return;
    applySelection({
      model: choice.value,
      modelId: choice.modelId,
      provider: choice.provider,
      connectionId: choice.connectionId,
    });
  };

  const onPermissionModeChange = (value: string): void => {
    const mode = value as PermissionMode;
    setMode(mode);
    // Persist per-chat (mirrors onModelChange) so switching away and back restores
    // THIS chat's mode instead of the toolbar drifting from the session's real mode.
    persistChatSettings({ permissionMode: mode });
    void window.api.agent.setPermissionMode(mode);
  };

  const respondPermission = (id: string, behavior: "allow" | "deny"): void => {
    removeRequest(id);
    void window.api.agent.respondPermission(id, behavior);
  };

  const respondQuestion = (
    id: string,
    answers: QuestionAnswers | null,
  ): void => {
    removeQuestion(id);
    void window.api.agent.respondQuestion(id, answers);
  };

  const removeNote = async (id: string): Promise<void> => {
    if (!projectRoot) return;
    setNotes(await window.api.annotations.remove(projectRoot, id));
  };

  const publish = async (): Promise<void> => {
    if (!projectRoot || publishing) return;
    setPublishing(true);
    setPublishMsg(null);
    try {
      const res = await window.api.publish.toPr(projectRoot, {
        title: "praxis: design handoff",
      });
      // Tag the session's history record with the PR it produced (v5-D).
      if (res.ok && res.url)
        void window.api.agent.tagSession(projectRoot, { prUrl: res.url });
      setPublishMsg(
        res.ok
          ? { ok: true, text: res.url ? `Opened ${res.url}` : "PR opened." }
          : { ok: false, text: res.error ?? "Publish failed." },
      );
    } finally {
      setPublishing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuActive((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(matches[menuActive].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Reusable Tailwind for the three quiet inline picker <select>s. Native (not
  // shadcn Select) on purpose: tiny controls, and the permission-mode test reads
  // native <option> values via $$eval — a Radix portal would break it.
  const selectCls =
    "h-6 cursor-pointer appearance-none rounded-md border-0 bg-transparent px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  // Before main's choices land, `selection` resolves to nothing at all — a
  // placeholder <option> in each control keeps them from rendering blank for that
  // beat (and covers a `provider` no group claims).
  const providerFallback = connectionId
    ? "Connection"
    : provider === "codex"
      ? "Codex"
      : "Claude";

  // Group the flat message list into "turns" — a user ask plus everything
  // that follows until the next ask — each wrapped in its own container so
  // the ask can be `position: sticky` WITHIN just that turn (Cursor-style: a
  // sticky element can't stick past its own containing block, so once you
  // scroll past a turn's own content, its ask releases and the NEXT turn's
  // ask takes over). Without this per-turn boundary every ask would stick at
  // once with nothing to make them hand off. A message that's expanded (full
  // height, not a compact reminder) isn't pinned — see `msg--user-pinned`
  // below and the wheel/touchmove collapse effect above.
  const turns: (typeof messages)[number][][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  const lastMessageId = messages[messages.length - 1]?.id;

  return (
    <div className="chat flex h-full flex-col" ref={chatRootRef}>
      {/* A tree of the previewed page's DOM, toggled from the composer. A
          flex-none sibling ABOVE Conversation — its own bounded/resizable
          height, so Conversation keeps flex-1 and use-stick-to-bottom's own
          scroll logic (which only cares about its own container) is untouched. */}
      {projectRoot && <LayersPanel />}
      {/* AI Elements Conversation = stick-to-bottom scroller (auto-follows the
          stream, with a scroll-to-bottom affordance). Replaces the old manual
          listRef scroll effect. */}
      <Conversation className="chat__messages min-h-0 flex-1">
        {/* pb-9 (36px, up from p-4's 16px): extra breathing room after the
            last message, so it doesn't sit flush against the status/fade area. */}
        <ConversationContent
          className="gap-3.5 p-4 pt-11 pb-9"
          scrollClassName="chat__scroll"
        >
          {setup.needed && !setup.dismissed && (
            <SetupCard
              busy={setup.busy}
              status={setup.status}
              onAccept={() => void acceptSetup()}
              onStop={stop}
              onDismiss={() => {
                setup.setDismissed(true);
                setup.setNeeded(false);
              }}
            />
          )}
          {/* Token offer yields to the setup offer — only one card at a time. */}
          {!setup.needed && tokens.offerNeeded && !tokens.offerDismissed && (
            <TokenOfferCard
              scaffolding={tokens.scaffolding}
              status={null}
              onAccept={() => void acceptTokenScaffold()}
              onDismiss={() => {
                tokens.setOfferDismissed(true);
                tokens.setOfferNeeded(false);
              }}
            />
          )}
          {messages.length === 0 && !setup.needed && !tokens.offerNeeded && (
            <div className="chat__empty">
              Ask for a change, or open a project to preview it on the right.
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn[0].id} className="turn flex flex-col gap-3.5">
              {turn.map((m) => {
                const isLast = m.id === lastMessageId;
                return (
                  // No role labels — the user's bubble vs the assistant's plain
                  // markdown is distinction enough (m.role still drives styling).
                  <div
                    key={m.id}
                    className={cn(
                      "msg flex flex-col gap-1",
                      `msg--${m.role}`,
                      m.role === "user" &&
                        !expandedUserMsgs.has(m.id) &&
                        "msg--user-pinned",
                    )}
                  >
                    {m.role === "user" && m.selection && (
                      <span className="msg__selection inline-flex w-fit max-w-full items-center gap-1 self-end rounded-md bg-indigo-50 px-1.5 py-1 text-indigo-700">
                        <span className="truncate font-mono text-[12px] font-semibold leading-none">
                          {m.selection.tag}
                          {m.selection.ident}
                        </span>
                        {m.selection.source && (
                          <span
                            className="min-w-0 truncate font-mono text-[10px] font-normal text-indigo-400"
                            title={m.selection.source}
                          >
                            {m.selection.source}
                          </span>
                        )}
                      </span>
                    )}
                    {m.role === "user" &&
                      m.attachments &&
                      m.attachments.length > 0 && (
                        <div className="msg__attachments flex flex-wrap justify-end gap-1.5">
                          {m.attachments.map((a) => (
                            <img
                              key={a.id}
                              src={a.url}
                              alt="attachment"
                              className="h-16 w-16 rounded-md border border-border object-cover"
                            />
                          ))}
                        </div>
                      )}
                    {m.segments.map((seg, segIdx) => {
                      if (seg.kind === "tools") {
                        const active =
                          isRunning &&
                          isLast &&
                          segIdx === m.segments.length - 1 &&
                          m.role === "assistant";
                        return (
                          <StepDisclosure
                            key={segIdx}
                            statuses={seg.statuses}
                            active={active}
                          />
                        );
                      }
                      return m.role === "assistant" ? (
                        <Markdown key={segIdx}>{seg.text}</Markdown>
                      ) : (
                        <ClampedUserText
                          key={segIdx}
                          text={seg.text}
                          expanded={expandedUserMsgs.has(m.id)}
                          onExpand={() => expandUserMsg(m.id)}
                        />
                      );
                    })}
                    {m.role === "assistant" &&
                      m.text &&
                      !(isRunning && isLast) && (
                        <div className="msg__actions">
                          <CopyAction text={m.text} />
                          {m.revertGroup && projectRoot && (
                            <RevertAction
                              root={projectRoot}
                              group={m.revertGroup}
                            />
                          )}
                        </div>
                      )}
                  </div>
                );
              })}
            </div>
          ))}
        </ConversationContent>
        {/* z-20: above the pinned ask (z-index 6) and the status fade (z-index 5) — the
            arrow must stay clickable even when it visually falls under the pinned bubble. */}
        <ConversationScrollButton
          aria-label="Scroll to bottom"
          className="z-20"
        />
      </Conversation>

      {/* Live status line — a cat that runs while a turn is in flight and settles
          on the idle sprite while waiting for input, alongside what the chat has
          spent (tokens in/out) and how long it has been working. No aria-live: the
          clock ticks every second, and announcing that on a loop is noise — the
          cat's own role="img" label already says whether a turn is running. */}
      <div className="chat__status">
        <CatLoader running={isRunning} />
        <RunStats />
      </div>

      <div className="composer">
        {/* Per-chat isolation conflict (v9): the chat's edits collided with the user's
            own changes, so its work is parked. Explain + offer Resolve (AI reconciles)
            / Discard. Pinned above the input so it's always visible while parked. */}
        {isolation === "parked" && (
          <ConflictCard
            files={isolationFiles ?? []}
            resolving={isRunning || conflictBusy === "resolve"}
            discarding={conflictBusy === "discard"}
            onResolve={() => void resolveConflict()}
            onDiscard={() => void discardConflict()}
          />
        )}
        <QuestionCards requests={questions} onRespond={respondQuestion} />
        <PermissionCards requests={pending} onRespond={respondPermission} />
        <NotesPanel
          notes={notes}
          focusedId={focusedId}
          publishing={publishing}
          publishMsg={publishMsg}
          onRemove={(id) => void removeNote(id)}
          onPublish={() => void publish()}
        />
        {/* v7: a non-Claude backend authenticates with its own subscription
            login (no API keys). Only surface the hint once a turn has actually
            failed to connect (codexAuthNeeded) — an already-logged-in user
            shouldn't be nagged every time they switch to the backend. v10: a
            connection-backed model runs on the same harness but authenticates
            with its own stored key, so it never gets the CLI-login hint. */}
        {(() => {
          const p = connectionId ? undefined : HARNESS_LOGIN[provider];
          if (!p?.login || !codexAuthNeeded) return null;
          return (
            <div
              className="provider-hint rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11.5px] text-blue-900"
              role="note"
            >
              {p.blurb} — run{" "}
              <code className="rounded bg-blue-100 px-1 font-mono text-[11px]">
                {p.login}
              </code>{" "}
              once to connect, then try again.
            </div>
          );
        })()}
        {/* shadcn InputGroup = the rounded, focus-ringed composer frame. The
            textarea carries data-slot="input-group-control" so the group lights
            up on focus. Native textarea (not InputGroupTextarea) to keep the ref
            for seeding/cursor control on React 18. */}
        <InputGroup
          className={`relative rounded-2xl border-[var(--border-prominent)] bg-card ${dragOver ? "ring-2 ring-blue-400" : ""}`}
          onDrop={onDrop}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
        >
          {selected && (
            <Inspector element={selected} onClear={() => setSelected(null)} />
          )}
          {attachments.length > 0 && (
            /* w-full: the InputGroup is a flex COLUMN with `items-center`, so a
               shrink-to-fit row would sit centered above the textarea. Full
               width + the textarea's own 14px left padding lines the chips up
               with the prompt text (same trick as Inspector's pill row). */
            <div className="composer__attachments flex w-full flex-wrap gap-1.5 pl-[14px] pr-3 pt-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  title={a.path || undefined}
                  className={
                    a.kind === "image"
                      ? "relative h-12 w-12 overflow-hidden rounded-md border border-border"
                      : "relative flex h-12 max-w-40 items-center gap-1.5 overflow-hidden rounded-md border border-border bg-muted/40 pl-2 pr-5"
                  }
                >
                  {a.kind === "image" ? (
                    <img
                      src={a.url}
                      alt="attachment"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <>
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs text-muted-foreground">
                        {a.name}
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((list) =>
                        list.filter((x) => x.id !== a.id),
                      )
                    }
                    aria-label={
                      a.kind === "image" ? "Remove image" : `Remove ${a.name}`
                    }
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] leading-none text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {menuOpen && (
            <div className="slash" role="listbox">
              <div className="slash__hint">Skills & commands</div>
              {matches.map((cmd, i) => (
                <button
                  key={cmd.name}
                  ref={i === menuActive ? activeItemRef : undefined}
                  className={`slash__item ${i === menuActive ? "is-active" : ""}`}
                  onMouseEnter={() => setMenuActive(i)}
                  onClick={() => pickCommand(cmd.name)}
                >
                  <span className="slash__name block">/{cmd.name}</span>
                  {cmd.description && (
                    <span className="slash__desc block truncate font-sans text-[11px] text-[var(--text-muted)]">
                      {cmd.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            data-slot="input-group-control"
            className="composer__input"
            placeholder="Ask Praxis  (/ for skills)"
            value={input}
            rows={2}
            onChange={(e) => onInputChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={onPaste}
          />
          <InputGroupAddon align="block-end" className="gap-1">
            {/* The selectors shrink + wrap when the chat pane is narrow so the send
                button (shrink-0, below) is never pushed off the edge. */}
            <div className="mr-auto flex min-w-0 flex-wrap items-center gap-1">
              {/* Per-chat worktree isolation (v9) runs silently; a parked (unmergeable)
                  chat surfaces the full ConflictCard above the composer instead of a
                  chip here. */}
              {/* Element-select toggle — lives here (Figma Make-style), not in the
                preview bar. Routing to web/simulator select mode is App's. */}
              {projectRoot && (
                <button
                  type="button"
                  className={`iconbtn iconbtn--sm ${selectMode ? "is-active" : ""}`}
                  onClick={() => useUiActions.getState().toggleSelect()}
                  aria-pressed={selectMode}
                  aria-label="Select"
                  title="Select an element to edit (S)"
                >
                  <MousePointer2 className="size-3.5" aria-hidden="true" />
                </button>
              )}
              {projectRoot && (
                <button
                  type="button"
                  className={`iconbtn iconbtn--sm ${layersOpen ? "is-active" : ""}`}
                  onClick={() => setLayersOpen(!layersOpen)}
                  aria-pressed={layersOpen}
                  aria-label="Layers"
                  title="Show the page's layer tree"
                >
                  <Layers className="size-3.5" aria-hidden="true" />
                </button>
              )}
              {/* Provider: the two built-in seats, then every saved connection
                  (main's own order), then the row that opens Settings. */}
              <select
                className={selectCls}
                value={selection.providerKey}
                onChange={(e) => {
                  const key = e.target.value;
                  if (key === MANAGE_PROVIDERS) {
                    // Not a provider — bounce the control back and open Settings.
                    e.currentTarget.value = selection.providerKey;
                    useProviders.getState().setSettingsOpen(true);
                    return;
                  }
                  onProviderChange(key);
                }}
                aria-label="Provider"
                title="Which harness (or saved connection) runs this chat"
              >
                {!selection.option && (
                  <option value={selection.providerKey}>
                    {providerFallback}
                  </option>
                )}
                {providers.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
                <option value={MANAGE_PROVIDERS}>Add new…</option>
              </select>
              {/* Model: only the selected provider's. */}
              <select
                className={selectCls}
                value={selection.choice?.value ?? model}
                onChange={(e) => onModelChange(e.target.value)}
                aria-label="Model"
              >
                {/* The placeholder must render a human label, never the raw picker
                    value: since v10 `model` holds a namespaced `ModelChoice.value`
                    (`claude:opus`, `codex:8f3a…:moonshotai/kimi-k2`), so printing it
                    flashed `claude:opus` in the toolbar on every mount before
                    `providers.choices()` resolved. `agentModelId` unwraps the tuple
                    to the real model id, or undefined for the Default sentinel. */}
                {!selection.choice && (
                  <option value={model}>
                    {agentModelId({ model, modelId }) ?? "Default"}
                  </option>
                )}
                {selection.option?.models.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={permissionMode}
                onChange={(e) => onPermissionModeChange(e.target.value)}
                aria-label="Permission mode"
                title="How much the agent can do without asking"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {isRunning ? (
              <Button
                type="button"
                size="icon"
                className="composer__send composer__send--stop shrink-0"
                onClick={stop}
                aria-label="Stop"
                title="Stop"
              >
                <span className="composer__spinner" aria-hidden="true" />
                <span className="composer__stop-icon" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="composer__send shrink-0"
                onClick={() => send()}
                disabled={!input.trim() && attachments.length === 0}
                aria-label="Send message"
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </Button>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}
