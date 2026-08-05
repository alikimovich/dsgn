# PROGRESS LOG

Newest first. Append a dated entry when you finish a chunk of work.

## 2026-08-05 — The editor's file tree became a file MANAGER (new / rename / delete)

The pop-out editor's sidebar could only ever open what already existed. It now
creates, renames and deletes files: a `＋` / pencil / trash toolbar above the
tree, and Finder's click-the-selected-file-again to rename.

`src/main/file-ops.ts` (new, pure — fs + path only, `test/file-ops.mjs`) holds
the three ops behind `source:create-file` / `source:rename-file` /
`source:delete-file`. Every path arrives from the renderer, so each op
re-validates it from scratch through one gate (`normalizeRelPath`): repo-relative
POSIX only, no `..`, no absolute/drive paths, no NUL, and nothing at any depth
inside `.git`, `.praxis`, `.dsgn` (the pre-rename sidecar the agent's write-deny
also covers) or `node_modules`. Create never clobbers (`flag: 'wx'`), rename
never overwrites, and both are file-only — directories are made implicitly by a
nested path and are never renamed or deleted.

Two details worth keeping:

- **Delete goes to the OS trash.** The undo history (`edit-history.ts`) is
  content-diff based: it reads a file, compares it to the text it last wrote, and
  writes the other side. There is no representation of "this file used to exist",
  so a delete can never be a Cmd+Z. `shell.trashItem` is the only undo there is —
  injected from `index.ts` rather than imported, so `file-ops.ts` stays pure and
  testable. If trashing throws (no desktop session, unsupported fs) it falls back
  to removing the file: the user asked for it gone.
- **A case-only rename is allowed.** On a case-insensitive filesystem
  `Foo.tsx` → `foo.tsx` reports the target as already existing, and the
  no-clobber guard would make case fixes impossible. It compares the two paths
  case-folded and lets that one through.

`FileTreePanel.tsx` keeps all the new chrome OUTSIDE the tree widget, which owns
its own shadow DOM: the toolbar and the name field are our own React above it,
and each successful op rebuilds the tree from a fresh `source:tree` listing
(there's no incremental add/remove we can lean on) then re-selects the path the
op landed on. The name field takes a whole relative path, so a rename doubles as
a move and "new file" seeded with the selected file's directory is one word of
typing. A rename follows the file if it was the one on screen; a delete closes
the drawer if it was.

**Rename-on-second-click, and why there are two triggers.** Clicking the
already-selected file is the natural gesture, but from outside the widget it's
indistinguishable from the programmatic mirror-select that Cmd+click navigation
and back/forward do — both surface as "selection changed to the file that's
already open". So the selection callback only treats it as a rename when a real
`pointerdown` landed on the tree in the last 600ms. A `dblclick` fallback covers
the case where the widget doesn't re-fire a selection change for a row that was
already selected; it ignores double-clicks while focus is in the tree's own
search box (found by descending `activeElement` through shadow roots — the
document only ever reports the host). Both paths just open the same field, so
firing both is harmless.

Verified: `test:file-ops` (44/44 unit tier green), typecheck + build green. The
Electron tier still can't launch a window on this machine — `test:codedrawer`
dies at `.empty__open` at HEAD too — so the sidebar's new chrome hasn't been
seen rendered; it wants a manual `bun run dev` pass.

## 2026-08-05 — The status line shows tokens + working time, not the tool caption

The line beside the running cat used to echo the current tool step ("Edit ·
src/components/Hero.tsx", or "Working…" before the first one). That caption is
already on screen: every step is listed in the turn's own `StepDisclosure` a few
lines above, latest step first. So the one strip that's visible for the WHOLE
turn was spending itself on a duplicate, and told the user nothing about what
the turn was costing. It now reads `↑ 12k  ↓ 830  1:23` — tokens in, tokens out,
and how long this chat has been working.

New `src/shared/run-stats.ts` (pure, `test/run-stats.mjs`) holds all of it:
`readUsage` normalizes a provider's loosely-typed usage payload, `usageDelta`
turns the repeated cumulative readings into an increment, `formatTokens` /
`formatDuration` render them. New `usage` `AgentEvent` carries the DELTA (never a
total), the store sums it per chat slice, `RunStats.tsx` renders the active
chat's.

**Two things were easy to get wrong here.** (1) *Double counting.* The Claude SDK
reports one request's usage three times — `message_start` (input side),
`message_delta` (running output total), then the complete `assistant` message —
so `claude.ts` keeps the running maximum it has already emitted per request and
sends only the difference (reset at `message_start`; a field the payload omits
reads as 0 and can't claw tokens back). (2) *The providers disagree about cached
tokens*: Anthropic reports cache reads/writes ALONGSIDE `input_tokens`, Codex
reports `cached_input_tokens` as a subset OF its `input_tokens`. `readUsage`
normalizes both to "all input tokens, of which this many were cached", so `↑`
means the same thing on either backend. Both cases are pinned by the unit test.

Codex only reports usage once, at `turn.completed`, so its counters step at the
end of a turn instead of during it; Gemini (experimental, unwired) reports none
and its counters stay at zero.

Time is WORKING time — the sum of finished turns plus the one in flight — not
wall clock since the chat opened, which would mostly measure how long the user
was at lunch. It lives on the chat slice (`workedMs` + `turnStartedAt`), so each
chat has its own. Neither the transcript nor the live snapshot records tokens or
timing, so a resumed/reloaded chat's counters start from zero and describe this
app run's work on it; a reattached in-flight turn times from the reattach.

Small knock-ons: the status row lost its `aria-live` (a clock ticking into a live
region is announced every second — the cat's own `role="img"` label already says
whether a turn is running, and the readout carries the full sentence as sr-only
text + a `title` breakdown with exact counts). The row is `pointer-events: none`,
so the readout opts back in — a native tooltip needs hover — which is safe
because the scroll-to-bottom button paints above it. `.chat__status-text` and its
pulse keyframes are gone.

## 2026-08-05 — Every turn is a commit on the user's own checkout

User request: "if things were changed, commits should be made on every turn, so
that I can easily revert or follow the progress." Until now only the chat's
`praxis/chat-*` worktree branch got commits — the merge back onto the LIVE
checkout was a plain file write (`autoApplyWorktree`), so the user's repo
accumulated one giant uncommitted diff until Publish. `git log` showed nothing;
reverting a single turn meant hand-picking hunks.

New `src/main/live-commit.ts` (pure, unit-tested): `commitLiveTurn(root, files,
{title, body})` lands the turn's files as ONE commit on whatever branch the live
checkout is on. Called from `chat-isolation.ts` on every merged turn
(`afterTurn`), on the parked-chat Apply and the AI conflict-resolve, on
`releaseChat`'s final salvage merge, and from `agent.ts`'s comment-spawn
finalizer. Commit subject = the turn's prompt (first line, whitespace-collapsed,
capped at 72); body = `Praxis turn N (praxis/chat-<id>).`

**Deliberately narrow, because this writes into the user's repo.** Only the
files that turn touched are staged — never `add -A`, so concurrent hand edits
elsewhere stay uncommitted and a `git revert` of a turn can't take them along.
It's a PATHSPEC (partial) commit, so anything the user had staged for their own
commit stays staged and out of ours (asserted in the test). `.praxis/` is
filtered like `commitWorktree` does. Non-repo-ROOT projects are skipped — for a
subdirectory project a commit would sweep the enclosing repo, the exact surprise
`isRepoRoot` exists to prevent. Identity is forced (`Praxis <praxis@local>`) and
`--no-verify` set, same reasoning as `commitWorktree`: a target repo's husky
hook must not be able to abort a turn. Any git failure returns
`committed: false` and never throws — the change is already in the working tree,
so a failed commit is exactly the old behavior, not lost work.

**Knock-on fixed in the same pass:** `publishToPr`'s `changedSince` diffed vs
`HEAD`, which now reports NOTHING for a session whose turns all committed — the
notes handoff would have said "Nothing to publish" and shipped an empty file
list in the PR body. It now diffs vs the merge base with the default branch
(two-dot, so uncommitted edits still count) and falls back to HEAD; the
"nothing staged" abort inside is now "nothing staged AND nothing ahead of base",
and the handoff commit is skipped when there's nothing to stage. `shipToMain`
needed no change (it already counted `base..branch`) and now shares the same
`defaultBase`. Those three git questions moved to a new pure
`src/main/publish-scope.ts` purely so they're testable: `annotations.ts` imports
`electron`, and a bun test can't load it (`SyntaxError: Export named 'ipcMain'
not found`) — the same reason `chat-worktrees.ts` was split from
`chat-isolation.ts`.

`test/live-commit.mjs` (unit tier) covers the helper against real temp repos —
plus a section that drives `chat-isolation.ts` itself with its window/store seam
injected (no Electron), running two real turns through a worktree and asserting
two live commits and a CLEAN live checkout between them. Fixture gotcha it cost
an hour: `createWorktree` symlinks `node_modules`/`.env` unconditionally, so a
temp repo WITHOUT a `.gitignore` gets those symlinks committed onto the branch —
`autoApplyWorktree` then can't read them, refuses the whole batch, and every
turn parks. Temp-repo fixtures must gitignore both (as `chat-worktrees.mjs`
already did).

Also told the agent about it in `rules.ts` ("commits it there as ONE commit per
turn") so a chat doesn't mistake its own turn commits for someone else's work.

## 2026-08-04 — Rail chat list capped at 5 + hide-UI button gets expand arrows

Two user requests. (1) A project's rail chat list showed EVERY previous chat
(~17 rows in the wild) — now live chats and running spawns always show, and
previous chats fill the remainder of a 5-row budget (`MAX_CHAT_ROWS`,
Rail.tsx), the rest behind a muted "Show N more" / "Show less" row.
Session-only state (a Set of project keys in the Rail component) — a long
history re-tucks on relaunch. (2) The previewbar hide-UI toggle swapped its
chat-bubble icon for diagonal expand arrows: Maximize2 when the UI is shown
(expand the preview), Minimize2 while hidden (bring the UI back); the arrow
direction carries the state, so the is-active accent is gone.
New electron-tier test `rail-chat-overflow`. Its three hard-won gotchas: an
EMPTY `.rail__chats` has zero height, so Playwright's default visibility wait
never resolves (wait `state: 'attached'`); App re-runs `useHistory.load()` on
several triggers and every resolve REPLACES the store's byKey — stub `load`
before seeding fakes or they vanish mid-test; the rail re-renders on
unrelated store ticks, so Playwright's actionability wait sees buttons
perpetually detached — JS-click them (same reason code-drawer.mjs does).

## 2026-08-04 — Hide-UI goes Figma: ⌘. hides chat AND rail

User request: match Figma's ⌘. "hide UI, leave only the preview" instead of
the ⌘\ chat-only toggle shipped earlier the same day. ⌘. was Stop Project
(the Xcode convention) — Stop moved to ⌘⇧.. The toggle (menu "Toggle UI" +
the previewbar button, same `toggle-chat` action/state underneath) now also
collapses the rail — via CSS only (`.panes--chat-hidden .rail` mirrors
`.rail--collapsed`), never touching the persisted rail preference, so
showing the UI restores the rail exactly as the user left it.
Test gotcha this surfaced: the chat pane snaps to width 0 instantly but the
rail ANIMATES width for 0.24s — a fixed post-toggle sleep reads the rail
mid-transition (or, on a busy renderer, before the transition even starts:
one live read caught 168px at +500ms). `chat-hide` now waits on the width
crossing the threshold (waitForFunction), not on a timer.

## 2026-08-04 — Zed-style editor search panel

User request: make the code editor's search look/behave like Zed's. The old
panel was CodeMirror's stock bottom bar (basicSetup ships `searchKeymap` but
no `search()` config, so the panel came from the facet default). New
`components/editor-search.ts` supplies the config: `search({ top, createPanel
})` with a plain-DOM panel (a CM Panel can't be React) — one rounded query
field with inline Aa / wd / .* toggles, ‹ › stepping, a live n/N match count
(capped at 1000, red when 0), a collapsible replace row (Replace / All,
⌘↵ = replace-all from the field), Esc closes. Styling is an
`EditorView.theme` riding the same design-token vars as `praxisTheme`, so it
follows light/dark and works in the pop-out editor window too. Only the
search input carries `main-field` (CM focuses it on open). @codemirror/search
promoted to a direct dep (was transitive via codemirror). New electron-tier
test `editor-search` (⌘F → panel shape, live count, Enter stepping, replace
toggle, Esc; screenshots 17–18).
Gotcha for future keyboard tests: Enter/findNext selects the next match AFTER
the cursor — assert "any current ≥ 1", not "1/N", when the click position
seeded the cursor mid-file.

## 2026-08-04 — Hide the chat pane (full-window preview)

User request: a way to hide the chat so the preview fills the window. Mirrors
the rail-collapse pattern: `useWorkspace.chatHidden` (persisted,
`praxis:chat-hidden`), toggled from a previewbar icon button (MessageSquare,
active = visible) and an Actions-menu item with the ⌘\ accelerator — menu, not
a renderer keydown, per the native-accelerator gotcha. The pane collapses to
width 0 but stays MOUNTED (`.pane--chat-hidden`: overflow clip + top-fade off)
so a running turn keeps streaming into the live ChatPanel; the resize divider
unmounts while hidden; the native preview follows the freed space via
PreviewPane's ResizeObserver, no extra geometry work. New electron-tier test
`chat-hide` (menu-action hide → previewbar re-show → localStorage round-trip,
screenshots 14–16).

Hazard rediscovered while verifying: the `test:<name>` package.json aliases
run tests DIRECTLY (no `PRAXIS_USER_DATA` isolation — only `test/run.mjs`
provides it), so a direct run persists the fixture project into the real
userData workspace and later direct runs fail `.empty__open` on boot-restore.
Run one-offs as `PRAXIS_USER_DATA=$(mktemp -d) node test/<name>.mjs`.

## 2026-08-04 — Publish self-heals when the checkout is on the base branch

User-reported: a brand-new repo opened in Praxis stayed on `main`, and Publish
hard-refused with "You're on main — publish runs from a Praxis work branch."
The open-time `git:ensure` (App.tsx) is supposed to move the checkout onto
`praxis/<base>`, but a project can still be on base at publish time (ensure
failed or was skipped at open, the titlebar switcher went back, a previous
publish's recovery stranded them). Refusing was pointless: the fix the error
demands is exactly what `ensureBranch` does, and `checkout -b` carries the
uncommitted work along. `shipToMain` now self-heals — on-base → run
`ensureBranch`, continue on the new work branch; the renderer already syncs
the titlebar from `res.branch`. Non-root checkouts (a subdir of a larger
repo, where `ensureBranch` refuses by design) stay a hard error, now with a
message that says to open the repo's top-level folder.
## 2026-08-03 — The composer's mode picker told the truth only by luck

Field report: an "Allow Edit?" card while the composer read **Auto**. It wasn't
the classifier flagging a risky edit — the session genuinely wasn't in Auto.
The posture lives in two places (the renderer's `usePermissions` + main's
per-session `options.permissionMode`), and several paths moved only one:

- `agent:resume-session` started with a hardcoded `{}` — no mode, no model. So
  the resumed chat ran `'default'` (ask for every gated tool) while the toolbar
  showed the UI default, Auto. Boot restore resumes the newest chat on *every*
  relaunch (`restore.ts` → `resumeMostRecent`), so this was the common path,
  not an edge case.
- `attempt` (fresh open) and the LRU-reopen in `applyProject` sent the mode but
  never recorded it on the project entry, so the next switch back re-seeded the
  toolbar from `defaultChatAgentSettings()` (Auto) regardless of what main got.
- Reattach after a renderer reload trusted the renderer's persisted copy even
  though main — the process that survived — held the real one.

Fixes: `resume-session` now takes `AgentOptions` (backend pinned to Claude, since
`sdkSessionId` is the resume marker); `LiveChatSnapshot` carries each session's
live `options` and `restore.ts` rebuilds `chatSettings` from them (main wins);
and every session-creating call site goes through one new `agentOptionsFor()`
that can't omit the mode. The per-chat settings + their mappings moved out of
`store.ts` into a pure `renderer/src/chat-settings.ts` (unit-tested in
`test/chat-settings.mjs`; `restore-reload.mjs` now asserts a reload repoints the
picker at main's real mode). The inverse mapping deliberately reads an absent
`permissionMode` as `'default'` — main's fallback, not the UI's — so a session
started without one is never *reported* as Auto.

## 2026-08-03 — Fable in the model picker

The Claude model picker still listed only Opus / Sonnet / Haiku, so there was
no way to run a chat on Fable short of leaving it on "Default" and hoping the
account default was right. Added `{ value: 'fable', label: 'Fable' }` at the
top of `CLAUDE_MODELS` in `ChatPanel.tsx` (above Opus). The value is passed
through untouched to the SDK's `model` option, and `claude --help` documents
`fable` as a first-class latest-model alias alongside `opus`/`sonnet`, so no
main-side change was needed.

## 2026-08-03 — Three field reports: agent fights the worktree machinery, stale Codex CLI, interrupt noise

Three user-reported issues from a real my-story session, fixed together:

**Rules v10 — "Git is Praxis-managed."** The chat agent spent a whole session
fighting the per-chat isolation machinery: it manually committed in its
`praxis/chat-*` worktree, pointed `praxis/main` at its own commits to force
the preview to update, then watched `commitWorktree`'s turn-end squash rewrite
the branch tip to a different hash every turn → permanent "divergence" it
diagnosed as a merge conflict, culminating in a `git reset --hard` habit on
the live checkout and a `sync-preview.sh` workaround script committed INTO the
user's repo. Root cause: `rules.ts` never mentioned git — the agent had no way
to know Praxis owns git state, that the squash rewrites hashes by design, or
that mid-turn edits reaching the preview only at turn end is intentional. New
unconditional rules section spells all of that out (no git mutations, no hard
resets on the live checkout, no DIY sync pipelines; read-only git fine).
`PRAXIS_RULES_VERSION` 9→10, assertions in `test/rules.mjs`.

**Codex SDK 0.142.3 → 0.146.0.** A "Default"-model Codex turn failed with a
400: `gpt-5.6-sol` (the account's new default) "requires a newer version of
Codex", preceded by "model metadata not found" fallback warnings. The SDK
bundles its own `codex` CLI shim, so the pinned old SDK = old CLI. Bump +
`bun install`; typecheck passes unchanged (no API break).

**`agent:interrupt` no longer throws after the turn is over.** Stopping a turn
that had already finished/aborted made the Claude SDK's `interrupt()` throw
"Operation aborted" out of the IPC handler (logged twice per click in the
main-process console). A late stop is a no-op, not an error — both interrupt
handlers (`agent:interrupt`, `agent:spawn-interrupt`) now swallow it.

## 2026-08-01 — The panel reads back the project's units (24px → 1.5rem)

Reported from lkmv.ch: the paragraph's `margin-bottom` showed `24px` while
`styles.less` says `1.5rem`. Not a bug in the provenance work — a boundary of
it: `getComputedStyle` serializes every length as USED px, so the authored
unit is destroyed before Praxis ever sees the value. But `specifiedValues()`
(style-provenance.ts) was already walking the matched rules and finding the
authored declaration — then keeping only the `var()` name and discarding the
text. The authored `1.5rem` was being read and thrown away.

Now the one stylesheet walk yields both halves: `declaredVars` (token proof)
and `specified` (authored css text), through `styles:read` →
`StyleReadResult.specified` → StylePanel state → `RowCtx.authoredFor`. The
scrub readout precedence is: proven token name → authored text (`1.5rem`) →
default px. Either custom readout only holds while the track shows the
COMMITTED value — mid-scrub it flips to live px text, since mid-drag the row
is no longer that declaration. On commit the authored entry is cleared (it
just went stale; showing the old `1.5rem` against a new number would lie) and
the reconcile re-read repopulates it.

The write path got the matching half: `StyleEdit.authored` rides along
(bounded + `isSafeStyleValue`-gated in main, prompt-context only, never
spliced) so the S3 agent prompt now says "currently authored as `1.5rem` —
keep the project's unit and idiom." Without that, a scrub on a rem-authored
declaration seeds "set margin-bottom to `25px`" and the agent clobbers the
unit — the same convention-respect failure as the inline-style gate, one
layer down. The authored text doubles as a greppable needle for finding the
declaration (often a global stylesheet, as on lkmv.ch — the Svelte prompt now
says "or a global stylesheet" too, since a `.svelte` stamp says nothing about
where the styles live).

Verified in the real browser (`test/style-provenance.mjs`): the exact
reported CSS (`p { margin: 0; margin-bottom: 1.5rem }`) asserting both the
premise (computed really says `24px`) and the fix (specified says `1.5rem`).
The browser corrected one expectation: CSSOM re-serializes expanded shorthand
longhands (`margin: 0` → margin-top `0px`, not `0`) — pinned in the test.
Panel-side rendering is reasoned + typechecked only (same unrunnable
Electron-tier caveat as the rest of this feature).

Known limit, accepted: scrubbing still COMMITS in px (the scrub model is
numeric-px throughout). Display and the agent prompt are honest now; a
direct-splice engine (S2 inline) still writes px. Rem-authored declarations
never reach S2 today (they live in stylesheets → S3 agent, which is told to
preserve units), so the gap is theoretical until someone scrubs a rem-authored
INLINE style.

## 2026-07-31 — Token naming requires PROOF, not value coincidence

"I really don't want this panel to hallucinate variables and tokens if the
element doesn't use them." Yesterday's radius/spacing fix turned out to be a
mitigation, not the fix: it made the GUESS more disciplined, but the whole
naming mechanism was still a guess. `readStyles()` (`preview/preload.ts`) gets
every value from `getComputedStyle`, which always fully resolves `var()` —
there was never a way to tell "this element's color IS `var(--color-text)`"
apart from "happens to equal it." Confirmed against a real project: every
token was named `--rmt-<category>-<value>`, so `cssGroupOf`'s first-segment
grouping bucketed all of them under one meaningless group (`rmt`, the vendor
prefix) — an unrecognized group is unconstrained by design, so yesterday's fix
didn't even apply, and padding/margin/font-size/line-height/opacity all showed
whichever same-valued `--rmt-*` token was detected first.

The real fix: prove usage from the SPECIFIED (unresolved) declaration instead
of the resolved one. New `src/preview/style-provenance.ts` (pure, DOM-only, no
`ipcRenderer` — same split as `layers.ts`) reads `el.style.getPropertyValue`
(inline preserves `var()` literally) and walks `document.styleSheets` for a
matching rule's own declaration (covers external stylesheets AND Svelte's
compiled scoped `<style>` — both are just real CSS rules at runtime). Threaded
through: `readStyles` → `styles:read-reply` → main's `pendingStyleReads` →
`window.api.styles.read()` now returns `{ values, declaredVars }`
(`shared/api.ts`'s new `StyleReadResult`) → `StylePanel` stores `declaredVars`
→ `resolveTokenForValue` gets a new `source`/`provenVar` pair.

`resolveTokenForValue` now branches by `TokenSet.source`, since each has a
different (or no) proof mechanism:
- `css` — `provenVar` must name one of the value-matching candidates. No var()
  in the specified declaration, no name — full stop, regardless of role/rank.
  Deliberately: if the source genuinely says `padding: var(--radius-none)`,
  that's true however odd, and proof beats a role plausibility check.
- `tailwind` — no `var()` exists to check; a class naming the token directly
  IS the proof (Tailwind encodes its theme key in the class itself).
- `manifest` — no reference mechanism exists at all (a hand-picked literal,
  not a live variable) — keeps yesterday's value+role heuristic. A disclosed,
  accepted gap, not a silent regression.

One real wrinkle: the live preview injects the RESOLVED value on a scrub/pick
(`el.style.setProperty(prop, value)`, never a reference), so for a few hundred
ms after an explicit pick — before the write lands and HMR reconciles —
`provenVar` looks unproven even for a pick that WILL land as `var()`. `sticky`
(already existed, previously a guessing tie-break) is repurposed as the bridge:
we know the pick happened, that's evidence too, just not source-level evidence.
It's retired the moment reconcile confirms the real write (`scheduleReconcile`
now also refreshes `declaredVars` and clears `stickyRef` for that prop) — so a
pick main couldn't validate as a token (silently falls back to a plain value)
doesn't go on claiming a token name forever.

Verification, in order of how much I trust it:
1. `test/token-match.mjs` — pure logic, rewritten around the new `source`/
   `provenVar` contract for all three sources, plus the exact reported bug
   reproduced against the OLD code (confirmed 6 assertions fail there) and
   fixed against the new.
2. `test/style-provenance.mjs` (new) — the DOM/CSSOM walk is NOT reasoned
   about from afar: bundled with esbuild to a browser global and driven
   against a REAL headless Chromium page (inline var(), a matched stylesheet
   rule, a declaration inside `@media`, a var() with a fallback, inline
   overriding a matched rule, an unrelated prop on the same element).
   Confirmed it catches a real regression (disabled the `@media`/`@supports`
   recursion by hand, the test failed correctly, restored). LIVE tier, not
   unit — needs `npx playwright install chromium`, a real environment
   dependency CI doesn't provision; SKIPs (exit 0) when that binary is
   missing, same convention as agent-e2e/sim-e2e for missing creds/display.
3. `test/style-edit.mjs` — updated the fixture and assertions (the ORIGINAL
   `TokenCard` literal-hex case now asserts the OPPOSITE of what it used to:
   raw hex shown, no chip; new `ProvenTokenCard` with a real
   `style={{ color: 'var(--color-text)' }}` asserts the chip DOES show).
   Written and typechecked, but unrun — the Electron tier can't launch a
   window on this machine (`.empty__open` timeout, confirmed identical at
   HEAD before any of this).

Mid-session process note: this branch got checked out to `main` outside this
session (reflog: a manual `checkout: moving from candidate to main`) partway
through the work — `main` predates the entire design-tokens feature, so if
`bun run dev` was running at the time, its file watcher would have hot-reloaded
the OLDER code straight into the running app. That's almost certainly why the
reported screenshot still showed the pre-fix names after the previous fix had
already shipped. Switched back to `candidate` before starting this fix; nothing
was lost (`origin/candidate` was already up to date).

Not done, deliberately: `manifest`-sourced tokens keep the old heuristic —
there's no reference mechanism to prove usage against at all, since a manifest
token is main re-rendering a hand-picked literal, not a live variable.

Post-review hardening (same day, before the main merge): (1) `@import`-ed
sheets were silently skipped — a `CSSImportRule`'s nested sheet hangs off
`.styleSheet`, not `.cssRules`, so the grouping-rule walk never descended;
fixed + a real routed-origin @import case in the provenance test
(mutation-checked). (2) One `styles.read` consumer was missed in the envelope
migration — `style-edit.mjs`'s live-override read-back still indexed the old
flat map; would have failed on the first real Electron-tier run. (3) The
declared var NAMES now get the same IPC boundary cap as every other
page-controlled string (128 chars; an absurd name just fails the proof match,
which fails safe to the raw value).

## 2026-07-30 — A radius token no longer labels `padding: 0`

Reported from a real theme: the Styles panel showed `--rmt-radius-none` on the
`padding` row and three `margin` sides. The VALUE was right — padding really was
`0` — but the name was a different property family's token.

Cause: `groupAffinity` returned a `TokenKind`, and `radius` and `spacing` both
map to `length` (as do `fontSize` and `letterSpacing`). So for a `padding-*`
row, whose rule accepts `length`, a radius token ranked `preferred` — exactly as
preferred as a spacing token. `resolveTokenForValue` then picked by value
equality, and with ranks tied it fell through to detection order. Worse,
`matches.length === 1` short-circuits before rank is consulted at all, so when a
theme has no zero-valued spacing token the radius one wins unopposed. `0` is the
value that collides hardest: every "none" token in a system is `0`.

The rank machinery was the right idea, just blind. Replaced `groupAffinity` with
`groupRole` returning a semantic `TokenRole` (`spacing` | `radius` | `font-size`
| `tracking` | …) — a notion the coarse value kind structurally cannot express —
and gave each `PROP_TOKEN_RULES` entry the roles that may NAME it.

The real split is offering vs naming, and they now have different strictness.
Offering stays permissive per the file's founding rule: group names are
unconstrained across the three detection sources, so they must never remove a
token from the picker — a radius token IS a length and remains offerable for
padding, just ranked last. Naming is strict: a token whose group marks a
different family can't label the row, so an unopposed `--radius-none` yields to
an honest `0px`. Two escape hatches keep that from over-reaching: an
unrecognized group (`brand`, `rmt`) constrains nothing and can still name, and
an explicit user pick (via `sticky`, set on pick at `StylePanel.tsx:306`) beats
a guess made from a group's name — otherwise picking a radius token for padding
would leave the row refusing to show what the user just chose.

One deliberate non-change: `line-height` keeps `spacing` as an accepted role.
An existing test asserts that, with a reasoned comment — it's the one property
taking both lengths and unitless numbers, and systems really do drive leading
off the spacing scale. Overturning it would have been scope creep hiding inside
a refactor.

Only `StylePanel` consumes `tokensForProp`/`resolveTokenForValue`, so this is
display-side only; `main/style-tokens.ts` re-validates picks by name+group and
is untouched, meaning no pick can start being rejected.

Found in passing, NOT fixed (logged in TASKS): `sameCssValue` does not treat a
bare `0` as `0px`, so a `--space-0: 0` token can never match a computed `0px`.
The reported theme wrote `0px`, which is why it matched at all. Separate
concern — it's the comparator, and changing it moves matching for every
property.

`test/token-match.mjs` covers the bug directly: both tokens offered with radius
ranked `other`, spacing names the row, radius names nothing when unopposed, a
neutral group still names, an explicit pick still names, and the mirror case
(spacing must not name `border-radius`).

## 2026-07-30 — The Styles ladder stops inventing inline styles (user feedback)

"I'm not sure if I'm fine with creating inline style unless it's project's
approach." The user picked a color token on a bare `<h1>` and got:

```
-<h1>{greeting}, I'm Andrei</h1>
+<h1 style="color: var(--color-title)">{greeting}, I'm Andrei</h1>
```

Two gaps conspired. S1 (Tailwind) can only REWRITE an existing class string —
neither adapter can create a `class`/`className` attribute (`styles.ts`'s
`classNameStringNode` gate, `styles-svelte.ts`'s `classAttr?.literal != null`) —
so an unclassed element skips it outright. And `tokenClassRewrite` returns null
for any token whose source isn't Tailwind, so a CSS-variable token can never
take the class path regardless. That dropped straight into S2, which had **no
gate at all**: inline was the unconditional fallback, its only checks being
splice-correctness (spreads, `style={expr}`). Nothing anywhere in main had any
notion of a project's styling convention.

S2 now only ever EXTENDS a `style` attribute that already exists. Absent → S3.
Praxis writing `style="…"` into a file that never had one is Praxis choosing a
convention on the project's behalf — the one thing a design tool editing
someone else's repo must not do. It's worse in Svelte, where the component
almost certainly styles from its own scoped `<style>` block: the inserted
attribute both imposes the convention and outranks that block on specificity
forever after. (The Svelte S3 prompt already said "may live in this component's
own `<style>` block" — but S2 ran first, so that sentence was unreachable.)

The agent prompt change is load-bearing, not cosmetic. Most of what now lands
in S3 is "this element has nowhere obvious to put a declaration," and left to
itself the agent reaches for the inline prop — re-introducing exactly what the
ladder just declined to write. Both prompts now name the project's own
approaches and explicitly forbid adding an inline `style` where there is none.
The JSX prompt also picked up the token/literal split the Svelte one had.

Cost, accepted knowingly: an element with no class and no `style` is now an
agent turn instead of an instant edit. That includes CSS-module/BEM projects
(`class="hero-title"` isn't Tailwind-shaped, so S1 declines it too).

Verification is the uncomfortable part. `test/style-edit.mjs` gained the
contrast case — a bare `<div>` fixture (`BareCard`, appended LAST so it can't
shift the line numbers the other stamps pin to) asserting needsAgent + a
byte-identical file + the prompt's forbidding sentence. But the Electron tier
cannot launch a window on this machine: `style-edit` dies at `.empty__open`,
and it dies identically at HEAD with these changes stashed, so that assertion
is written but unrun. What actually proved the change was a throwaway harness
that esbuild-bundled `styles.ts` with electron marked external (the only
electron use is `registerStylesIpc`, never called) and drove the real
`applyStyleEdit` in plain node across both engines. At HEAD it reproduced the
reported bug exactly (`applied: true, strategy: 'inline'` on a bare element);
with the fix all 14 checks pass, and the 8 non-bare checks — inline merge and
Tailwind rewrite, both frameworks — pass in BOTH, so the working paths are
untouched. The harness was deleted rather than kept: it duplicates assertions
already encoded in `style-edit.mjs`, and making bundle-based tests a permanent
tier is a bigger call than this fix warrants. Worth revisiting if the Electron
tier stays unrunnable.

Not done, deliberately: teaching S1 to CREATE a class attribute for Tailwind
projects. Detecting "is this a Tailwind project" is genuinely unreliable now
that v4 is CSS-first and often ships no `tailwind.config.*` for `tokens.ts`'s
existing probe to find, and it wouldn't have helped this user (CSS-variable
tokens). Left in TASKS.

## 2026-07-30 — Token chevron moves inside the value field (user feedback)

"I find the way we now invoke tokens confusing. I would expect the chevron
down being directed down and being placed within input field, on the right of
it, instead of to the left from label." Fair: the v1 affordance was a
`ChevronRight`/`ChevronDown` button sitting OUTSIDE the row, left of the
property label — it read as an unrelated expander (and sat right next to
SideRows' own expand-sides chevron, a different action entirely) rather than
as "this field is a picker."

Now the chevron lives inside the value field at its right edge, always
pointing down and rotating 180° when open — i.e. the shape of the native
`<select>` the transition-property row already uses a few rows below, so the
panel reads consistently.

`TokenRow` no longer wraps the row with its own chevron. It still owns the
open/close state and renders the picker underneath, but hands the toggle to
`children` as a NODE via a render prop, so each control places it inside its
own field. A render prop (not context, not cloneElement) because there are
exactly three call sites and each needs a visibly different placement —
explicit beats clever. `ScrubInput` and `ColorControl` gained an optional
`trailing` slot; both are also used by `CustomPanel`, which passes nothing
and is unaffected.

Three details the move forced:
- The toggle now sits inside fields that own pointer/key behavior, so it
  stops propagation on pointerdown/click/keydown — otherwise clicking it
  would also start `ScrubInput`'s pointer-lock scrub, and Enter would also
  open its exact-value editor.
- `ScrubInput`'s readout is wrapped in `min-w-0 truncate` so a long token
  name shrinks instead of shoving the chevron out of the fixed-width track.
- Color fields went 96px → 112px (`w-28`). The trailing icon eats ~16px and
  real design-system token names are long — at 96px `--color-text` truncated
  to `--color…`. `ColorControl`'s hex box and `ColorRow`'s `TokenChip` stay
  the same width as each other so the row doesn't jump when a value flips
  between token and raw hex. `ColorControl`'s hex `<Input>` became a
  borderless `<input>` inside a bordered flex wrapper (with a `focus-within`
  ring), since the chevron has to sit inside that border.

Verified with a driven probe: all six token-able rows reported the chevron
geometrically inside its field (`insideField: true`, 5px from the right edge)
and a captured island screenshot confirmed it visually. The final 96→112px
nudge was NOT re-confirmed visually — the island `WebContentsView` stopped
rendering partway through (the known environment flakiness; an untouched
`prop-edit` fails identically right now), and it's a pure width constant with
no logic. `bun run typecheck` clean, unit tier 40/40.

## 2026-07-29 — Real Cmd+Z was dead: the editMenu role was eating it

User: "Cmd+Z / Cmd+Shift+Z didn't work for me" — right after the previous
entry claimed a live Cmd+Z check passed. Both are true, and the gap between
them IS the bug: the menu template had `{ role: 'editMenu' }`, whose built-in
Undo/Redo items own the Cmd+Z / Shift+Cmd+Z accelerators at the NATIVE menu
level. A physical keystroke is intercepted in the main process and routed to
`webContents.undo()` (text-editing undo) — the renderer's keydown listener
(App.tsx, the v8 F3b source-edit undo) never fires. Synthetic/CDP key events
(what every test uses, including the previous entry's probe) BYPASS menu
accelerators, so the keydown handler fired in tests and the feature looked
alive. Real-keyboard source undo has therefore been broken since the role was
added — for props/text/token edits too, not just layer moves.

Fix, three routing layers (menu template + App.tsx + a new tiny IPC):
- `role: 'editMenu'` → explicit Edit submenu. Undo/Redo are custom items
  whose click handlers route: a non-main focused webContents (preview, props
  island, pop-out editor) gets plain `webContents.undo()`/`redo()` — exactly
  what the role did, incl. CodeMirror, which maps the native historyUndo
  beforeinput to its own history — while the MAIN renderer gets a
  `menu:action 'undo'/'redo'` and decides for itself. Clipboard items stay
  roles.
- App.tsx: the undo logic is shared between the (kept, now mostly-backup)
  keydown listener and the new menu-action branch. Focused text field → ask
  main to replay the NATIVE editing command (`menu:native-edit` →
  `mainWindow.webContents.undo()`), because the custom accelerator swallowed
  the keystroke the field would have received; anything else → the source-edit
  stack.
- LayersTree: the drag's `preventDefault()` on pointerdown also suppressed the
  default focus move, stranding focus in the composer textarea — so even with
  the menu fixed, Cmd+Z after a drag would have hit the field's native undo.
  `beginDrag` now focuses the row explicitly (rows are tabIndex=0).

`test/layers-panel.mjs` now drives undo through the REAL path — main sending
`menu:action 'undo'` (which is precisely what a physical Cmd+Z produces) —
and pins BOTH routing branches: row-focused → the move reverts; composer-
focused → source files must NOT change, and after blur the same action
reverts. New CLAUDE.md gotcha: menu accelerators beat renderer keydown, and
synthetic test events bypass menu accelerators — a keydown-handler test can
stay green while every real keyboard is broken.

## 2026-07-29 — Pinned-ask fade fix + confirmed Cmd+Z covers Layers drags

User report: "when I scroll and one message starts pushing another one, the
top message goes over, not behind gradient line on the top." Root cause,
confirmed by two independent code investigations: `.msg--user-pinned`
(styles.css, the collapsed/sticky user-ask bubble) had `z-index: 6`, a
DELIBERATE prior choice ("so the pinned ask stays crisp over it") — but it's
applied to every collapsed ask for the whole time it's collapsed, not only
while genuinely stuck at `top: 44px`, so during the sticky hand-off between
two turns the outgoing bubble also rendered above `.pane--chat::before`'s
`z-index: 5` top fade instead of dissolving under it. No intervening
stacking context exists anywhere in the chain (`.pane--chat` → `.chat__messages`
→ `.chat__scroll` → `.turn` → `.msg`), so the two z-indexes compete directly —
confirmed live via computed-style check (`getComputedStyle` reported the
bubble's z-index as the raw `6`/`5` numbers, no scoping).

User confirmed they want it to fade like everything else. Fixed:
`z-index: 6` → `z-index: 1` on `.msg--user-pinned` — low enough to sit below
the gradient (5), but still an explicit positive value so the pinned bubble
keeps winning over its own turn's z-index:auto content scrolling beneath it
(removing the z-index entirely would have silently broken the sticky visual
effect itself, not just its relationship to the fade). Verified live:
`getComputedStyle` now reports `1` for the bubble vs `5` for the gradient.

Also verified, no code needed: dragging a Layers-panel row and pressing a
REAL Cmd+Z keystroke (not just calling `window.api.edits.undo()` directly)
correctly reverts the move. Layer-panel moves already go through the same
`commitEdit`/`edit-history.ts` stack as every other direct source edit, and
`App.tsx`'s global Cmd+Z handler already operates over that same per-root
stack — so this "just worked" once the move engine (2026-07-29, Layers panel)
landed.

## 2026-07-29 — Rules v9: trigger-first line_height section (found by a new live test)

New live-tier test `test/tool-invocation.mjs` asks the opposite question from
every other tool test: not "does the tool work when called" but "do the rules
make the agent CALL it at all", from natural design prompts that never name a
tool. First run caught a real miss: `check_contrast` fired spontaneously,
`line_height` never did — the agent hand-wrote the CSS instead.

The difference was rule *shape*, not tool quality: `check_contrast` opens its
own section with a trigger condition ("Whenever you pick, change, or review a
text/UI color pair…"), while `line_height` was the fourth bullet in the shared
calculators list, phrased as value substitution ("not a hardcoded 1.5").
Adding body copy doesn't pattern-match "exact math you should not eyeball", so
the push never landed — even though the SDK tool description already said
"Call this WHENEVER you set a font-size or line-height". Lesson: the always-on
rules steer tool *reach*; descriptions only matter once the model is already
looking. Fix (v9): `line_height` got its own "Type metrics" section with the
same trigger-first phrasing, covering new text content (headings/body/captions)
explicitly. Both probes now pass live; `test/rules.mjs` pins the new section.

A v0.app-style Layers panel — a tree of the previewed page's DOM at the top of
the chat column, click a row to select, drag a row to reorder in real source.

**The decisive constraint, found before writing anything:** a
`data-praxis-source` stamp identifies a JSX/element node in *source*, not a
rendered *instance*. A `.map()` over N items puts the identical stamp on N DOM
nodes — there is no way to tell "move rendered item 3 before item 1" apart from
the reverse, because in source there's only one node. So drag-to-reorder is a
real code edit for distinct siblings, and an inherently agent-routed judgment
call for list items/reparenting/cross-file — the same `needsAgent` fallback
every other direct-edit engine in this app already uses.

**Tree read** (`src/preview/layers.ts`, new preload sibling module) walks from
`document.body` — not `documentElement`, which is where all of Praxis's own
overlay chrome lives, so it's excluded for free. Node identity is a DOM
child-index path (`[0,2,1]`), recomputed fresh on every read and never
trusted across snapshots: `data-praxis-source` isn't unique and `cssPath` is
too lossy to serve as a handle. A bulk read is a request-id round trip
(`layers:read`/`layers:read-reply`), the same shape as the Styles tab's
`styles:read` — the preview preload is sandboxed, so any bulk read of its
isolated world can only ever be message-passing, never `executeJavaScript`.

**Selection reuses the real click path.** A Layers row click sends
`layers:select {path, fingerprint}`; the preload re-resolves the path
(re-validating a `{tag, source}` fingerprint — the same self-healing
discipline `resolveStyleTarget()` uses), then calls the *exact* functions the
real in-page click handler calls (`describe`/`showToolbar`/
`setSelectionHighlight`). Zero new renderer-side selection logic, a real
in-page outline, and it works independent of Select-mode by construction —
none of those functions gate on it.

**Freshness** is a debounced, `childList`-only `MutationObserver`, armed only
while the panel is open (`layers:set-watch`, mirroring `SET_FRAME`'s exact
on/off shape) plus explicit reads on open/`preview:url-changed`/after a
successful move. Deliberately not wired to every prop/style edit elsewhere —
the observer already catches anything that changes the tree's *shape*, and a
same-shape edit (recoloring, retyping) has nothing here to go stale.

**The panel** (`LayersPanel.tsx` host + `LayersTree.tsx` pure render/drag) sits
as a `flex-none` sibling above `ChatPanel`'s `<Conversation>`, with the same
`pt-11` top padding `ConversationContent` already uses to clear the
`.chat-drag` window-drag strip and the top gradient fade. Hand-rolled, not
`@pierre/trees` (already a dep, used in the pop-out code editor): its model is
alphabetically-sorted path strings with `directory|file` semantics, the wrong
shape for a DOM tree where duplicate-tag siblings must stay in exact DOM order
and the drop gesture is "between these two specific siblings," not "into a
folder." Every existing drag interaction in this codebase (resize handles,
ScrubInput, BezierEditor) is already hand-rolled pointer math with no dnd
library anywhere.

**The move engine** ships for React, Svelte, and static HTML in v1 — mirroring
the codebase's existing per-framework pairing (`props.ts`/`props-svelte.ts`).
React Native and Vue are out, not deferred: RN's preview is an iOS-simulator
MJPEG bridge with no live DOM, and Vue uses its own devtools inspector instead
of a stamp — neither has anything for a mover to hook into yet.

v1 scope is deliberately narrow: **same-file, same-immediate-parent
`before`/`after` only.** `inside` (reparenting) is always `needsAgent` — same
parent is the one case where scope-safety (does the moved node reference
locals only valid at its old position?) is trivially guaranteed, and it's also
an indentation win: identical nesting depth means the target's own leading
whitespace is already the right template for the moved node's new position.
The gates, in order: same stamp on both sides → `needsAgent` (cheapest,
decisive — the case a `.map()`/`{#each}` produces); different files →
`needsAgent`; not true siblings under one parent → `needsAgent`; either side
statically inside a `.map()`/`.filter().map()` call, a `{cond && <X/>}`/
ternary container (React), or an `{#each}`/`{#if}` block (Svelte) →
`needsAgent` (catches the case where the *current* render shows one instance
but the template isn't safe to hand-splice). None of this trusts the renderer
for correctness — the Layers tree's own `dupStamp` flag (computed client-side
during the walk) is only a pre-flight UX hint that disables dragging on rows
already known to be templated; the actual gate is main re-deriving everything
from source.

**The splice** (`src/main/move-node-splice.ts`, new, deliberately dependency-
free) rebuilds the parent's entire content span from an ordered list of
original child text runs, rather than incremental substring surgery — every
untouched sibling's text is copied byte-for-byte, and only the separator
immediately around the moved node is recomputed. One real bug caught by its
own unit test before it ever reached the Electron tier: the first version
borrowed the separator gap *after* the target when inserting `after`, which
is a sibling gap for every target except the *last* child, where it's
actually the boundary gap before the parent's closing tag (usually
less-indented or absent) — fixed by always preferring the gap *before* target
regardless of `position`, falling back to the one after only when target is
first. `test/layers-move.mjs` pins this with hand-built `{start,end}` node
stand-ins over literal strings — no real parser needed, since the algorithm
only ever touches spans + a whitespace predicate.

**A parent-tracking primitive didn't exist anywhere in this codebase** — every
existing AST walker (`props.ts`'s `collectNodes`, `props-svelte.ts`'s
`collectElements`, `html-source.ts`'s `walkElements`) only collects nodes
matching a type, never tracking parent/children. New shared, framework-
agnostic `src/main/ast-walk.ts` (`findContainer`/`ancestorChain`, duck-typed
over `.type`) is used by both the React and Svelte movers; static HTML gets
its own smaller version instead, because parse5's tree carries `parentNode`
back-references that a naive generic key-walk would loop on — descending via
`childNodes` only sidesteps that risk entirely rather than special-casing it.

**Two `props.ts`/`props-svelte.ts` refactors, additive only, zero behavior
change:** `findElementAtLine` split into `locateJsxOpening(ast, line, col)` +
a thin parse wrapper, so the movers can parse a file ONCE and locate both the
dragged and target elements against the identical ast (their JSX node objects
must be reference-equal for the container lookup to work at all); and
`parseFile`/`collectNodes`/`BabelNode`, `parseSvelte`/`Node`, all promoted
from module-private to exported, mirroring what was already exported.

**Why the splice algorithm lives in its own file, and why the unit test only
covers it:** `move-node.ts` imports `commitEdit`/`resolveSource` from
`props.ts`, which imports `electron` at module scope — so the whole file (and
anything that imports it) can't load under plain bun. `control-manifest.ts`/
`control-panels.ts` already established the fix for exactly this shape:
factor the pure part into its own electron-free module. The AST-aware gating
(same-source, same-parent, templated-container detection) still can't be
unit-tested this way — it's covered end-to-end in `test/layers-panel.mjs`
instead, against a new fixture (`test/fixtures/layers-app/`) with a real
`src/Layers.tsx` backing a served `index.html`: a `<ul>` of three distinctly-
stamped `<li>`s (the direct-move path) and a second `<ul>` whose three
rendered `<li>`s all carry the *identical* stamp (the `.map()`/needsAgent
path). The drag itself is dispatched as real `PointerEvent`s at the rows' own
on-screen coordinates, driving `LayersTree`'s actual pointer-gesture code —
not a direct engine call standing in for the UI.

**One environment-driven test fix, not a product bug:** `win.click()`
(Playwright's real actionability-checked click) stalled for its full 30s
default timeout on this machine for reasons unrelated to the feature — the
same class of environment quirk that affects the props island elsewhere in
this suite (documented in the 2026-07-28 entry). Dispatching the click via
`element.click()` inside `page.evaluate()` instead — the same event the
button's `onClick` receives either way — resolved it instantly. Confirmed via
a throwaway probe script that the feature itself (preview load, panel open,
10 tree rows, click-select, and the drag reordering `Alpha/Beta/Gamma` →
`Gamma/Alpha/Beta` in `src/Layers.tsx` with exactly the right indentation)
all worked correctly the whole time — this was purely a test-harness fix.

Tests: `test/layers-move.mjs` (new, unit tier) and `test/layers-panel.mjs`
(new, electron tier) both green; `node test/run.mjs unit` 40/40. Follow-ups
(reparenting, a "save as token"-style promotion, whether `inside` is ever
worth mechanizing) are in `docs/TASKS.md`.

## 2026-07-28 — Design tokens in the Styles panel (user-requested)

The Styles tab was token-blind: it read computed CSS and showed the raw value —
`color: #6c6c6c` — for a project that calls that `--color-text`. Tokens were
already detected (`tokens.ts`) and parked in `useTokens`, but the only consumers
were the chat's scaffold offer and a `props:applyToken` IPC **no renderer code
calls** (dead since `TokenPalette.tsx` was removed). Now the panel names the
token, offers a picker on every token-able row, and commits a *reference*.

**Matching lives in `src/shared/token-match.ts`** (new, pure) because both sides
need it — the island to render, main to re-validate. Its load-bearing rule: a
token's **value shape gates** what it may be offered for; its **group name only
ranks**. Group names are unconstrained (a manifest may name a group `brand`, a
CSS-var scan derives them from the first name segment, Tailwind uses
`colors`/`spacing`/…), so ranking on them is fine and excluding on them is not.
That's what keeps `--z-modal: 100` out of the padding picker while still
surfacing a spacing scale someone filed under `brand`.

**Resolution is based on the LIVE custom property, not the token file.** The
motivating repo (lkmv.ch) redefines every color under
`@media (prefers-color-scheme: dark)`, and `fromCss` keeps the first occurrence
— so a static value comparison silently fails in dark mode. Instead the panel
asks `styles.read` for the token names themselves: `readStyles` already forwards
whatever strings it gets to `getPropertyValue`, so custom properties worked
**with no new IPC** (only the 64-prop cap needed raising). The recorded value is
the fallback when a name doesn't resolve. Ties are real — a theme with
`--color-title` and `--color-link` both `#212121` — so one winner is always
chosen deterministically (class-list corroboration → group affinity → the
sticky previous pick → detection order) rather than showing "2 tokens".

**Commits write a reference.** `StyleEdit.token` carries only a name + group;
`main/style-tokens.ts` re-detects the project's tokens, re-runs the same
value-shape gate, and produces the text to splice — so nothing the island claims
is written verbatim. A Tailwind-sourced token becomes a class
(`rewriteClassListToken` → `text-brand-500`); a CSS-var token deliberately
*skips* S1 and falls to S2, because taking the class path would write
`text-[#6c6c6c]` — hard-coding the very value the user asked to stop hard-coding.
`edit.value` still carries the resolved css text, so live preview, the
post-commit reconcile and Replay all keep working against something concrete.
An unresolvable token is dropped **silently** and the edit lands as a plain
value edit: the value is still right, only the reference is unavailable.

**UI: inline expansion, never a popover.** The island is a transparent
WebContentsView sized to hug the card, so a portal dropdown clips at the view
edge. A chevron expands `TokenPicker` under the row (what SideRows and
BezierEditor already do; PanelApp's ResizeObserver grows the view). Colors get a
swatch grid, lengths a name/value list; hovering previews live. A row with no
offerable token renders byte-identical to before — token-less projects see no
layout change at all. `ScrubInput.formatValue` shows the token name on numeric
rows, and reverts to plain css text the moment a scrub moves off the committed
value (freezing the name mid-drag would misreport what's about to commit).

**Detection gaps closed:** `findCssFiles` now scans `.less`/`.sass`/`.styl`/
`.pcss` (custom properties pass through preprocessors untouched — lkmv.ch keeps
its whole theme in `src/routes/styles.less` and was invisible), the walk reaches
depth 6 / 120 files (a monorepo's `packages/ui/src/styles/tokens.css` is depth
5), and the emitted set is capped at 400 since a `TokenSet` now rides in every
`PanelState` push. Preprocessor *variables* (`@brand:`, `$brand:`) are
deliberately still ignored — they have no runtime form, so they could never be
committed back as a reference.

**Groundwork, no behavior change:** `StylePanel.tsx` (839 lines, guideline ~500)
split into `components/styles/rows/*`; `sameCssValue`/`numericValue`/`toCssText`/
`parseColorLike` moved to `lib/css-values.ts`, which meant first moving
`TW_EASE_EQUIV` + `displayBezierPreset` down out of `BezierEditor.tsx`
(`sameCssValue` depends on them, and a lib can't import a component).

**Two things the plan got wrong, found while building:**
- The reviewed plan claimed a live duplicate-class bug from `element.classes`
  being a pick-time snapshot, and proposed widening `styles.read` to return
  fresh classes. It isn't a bug: `applyStyleEdit` reads the class list from the
  **source file** (`styles.ts:146`); `edit.classes` only gates `looksTailwind`.
  The widening was dropped — the class list is consulted only as a tie-break,
  where staleness degrades gracefully.
- `--z-modal: 100` **is** a legal `font-weight`, so no value-shape rule can
  exclude it. `test/token-match.mjs` asserts the honest behavior: offered, but
  ranked `neutral` so it sits below any real weight scale.

Tests: new `test/token-match.mjs` (unit tier — value kinds, affinity, the
per-prop gate incl. both negative cases, reference forms per source, and the
tie-break); `tw-styles.mjs` extended for `tailwindTokenClassFor` /
`rewriteClassListToken`; `tokens.mjs` extended with a depth-5 `.less` fixture
that also pins first-definition-wins and proves a LESS variable never becomes a
token; `style-edit.mjs` drives the real island — the chip names `--color-text`,
the picker offers *only* the color tokens, clicking `--color-title` writes
`var(--color-title)` (never `#212121`), and one undo restores it. The fixture
`propedit-app` gained `src/theme.css` + a `TokenCard`, making it a css-source
project. Writing that test caught a real bug in the test itself: a
document-wide `.stylepanel__token-toggle` grabs the *padding* row's toggle,
since every token-able row now has one.

**Verification status, honestly:** unit tier 39/39 (incl. the new
`token-match`), plus `tokens` / `tokens-scaffold` / `prop-edit-svelte` /
`text-edit` / `setup-detect` green. The island-DOM-driven Electron tests
(`style-edit`, `select-element`, `custom-controls`, `ready-gating`, and
eventually `prop-edit`) could NOT be verified on the machine this was written
on: the island `WebContentsView` renders an empty document there, so every
`.proppanel__*` / `.stylepanel__*` wait times out. That is **pre-existing** —
all four fail identically with this entire change stashed at HEAD, so it's the
environment (the Electron window never taking focus), not the feature. Inside
`style-edit`, the token-source header and the `--color-text` chip assertions
did pass on the one run that got that far; the picker/commit assertions written
after the selector fix are unverified. Re-run `node test/run.mjs electron`
somewhere the window can actually take focus before trusting them.

## 2026-07-27 — Don't offer/greypanel setup a project can't do (user feedback)

Feedback from a vanilla single-HTML project (whole DOM assembled at runtime from
JS string-templating, so nothing is source-mapped): the "Set this project up for
visual editing?" card still appeared and dead-ended on *"Couldn't detect a
supported framework"*, and the Styles tab showed a full set of greyed-out,
fake-editable controls under a terse "Ask Praxis below." Two real gaps:

1. **The offer was gated only on stamp count** (`stamps === 0`, `App.tsx`),
   never on whether setup was *possible* — so a static/vanilla/unsupported repo
   got a live "Set it up" button whose only outcome was the error message.
2. **The Styles panel's read-only state didn't say what to do** — and looked
   like a broken editor rather than an intentional read-only view.

Fix — a read-only "can we instrument this?" probe threaded to both surfaces:
- **`setup.ts` `setup:detect` IPC** — runs the existing deps-based `detect()`
  WITHOUT writing, returns `{ framework, canInstrument }` (`canInstrument =
  framework !== 'unknown'`, i.e. react/rn/svelte/solid/vue → true, vanilla →
  false). New `SetupProbe` type + `PraxisApi.setup.detect` + preload bridge.
- **The offer now gates on `canInstrument`** (`useSetup.canInstrument`, probed on
  open next to `tokens.detect`; the readiness handler lazily probes + caches if
  it fires first). A static/vanilla project never gets the dead-end card. A
  supported framework is unchanged (React scaffold still offers — that's correct,
  per the user: "for projects created in praxis it's definitely how it should
  work").
- **`StylePanel` read-only state reworked** — when the picked element has no
  source stamp it no longer renders the greyed control list; it shows *why* it's
  read-only + *what to do*, tailored by `canInstrument` (threaded through
  `PanelState`): `false` → "built at runtime, ask Praxis in chat and it'll edit
  the code"; `true` → "set up visual editing (offer in chat)"; plus an **"Ask
  Praxis to restyle it"** button that seeds the composer.

Verified: `typecheck` + full unit tier (38/38) + `build`; extended
`setup-detect.mjs` with the probe (react/rn/svelte/solid/vue → canInstrument
true, unknown + a real no-package.json vanilla dir → false, writes no `.praxis`);
`ready-gating` (React offer still shows) + `style-edit` (editable path intact)
green. The two new UI states are best eyeballed live (the user is running the
app) — a driven screenshot test for the static path is a good follow-up.

## 2026-07-25 — Fix two stale code-drawer UI tests

`code-peek` and `code-drawer` failed on the electron tier — and, crucially, on
the pre-work baseline too, so not a regression: the drawer UI evolved but the
tests didn't follow.
- `code-peek` waited for `.codedrawer__expand`, an explicit expand toggle that
  no longer exists (replaced by dragging the drawer's top edge, `__resize`).
  Now asserts open-in-editor + the drag-resize handle.
- `code-drawer` clicked `.codedrawer__close` in the popped-out editor *window*,
  which intentionally has no in-editor close (it uses the native traffic lights,
  `!isWindow` guard in CodeDrawer.tsx). Now closes via `editorWin.close()`.

Both deterministic green after the fix (2/2 each). The other four electron-tier
failures that turned up (`rail`, `rail-collapse`, `style-edit`, `custom-controls`)
are timing flakes — each passes in isolation / on retry — not addressed here.

## 2026-07-24 — Vanilla-JS editing, Tier 2: click-to-code + inline text edit

Tier 2 of the vanilla-JS editing plan (Tier 1 added the header code-editor
door). The key move: a static site's served bytes ARE the on-disk file, so the
DOM→source map framework projects manufacture with a build-time plugin is nearly
free — compute it at serve time.

- **`src/main/html-source.ts`** (new, over parse5 via dynamic import):
  `stampHtml(html, relpath)` injects `data-praxis-source="relpath:line:col"`
  into each stampable element's start tag (attribute-only, idempotent, skips
  head/script/style, degrades to the input on parse failure);
  `spliceHtmlText(html, line, col, text)` rewrites a stamped text leaf back into
  the file (null → agent fallback for element/comment children or void tags).
  Pure, unit-tested (`test/html-source.mjs`).
- **`static-server.ts`** stamps every served HTML response before the live-reload
  snippet. So clicking an element in a vanilla preview now yields a `source`,
  which lights up the existing machinery for free: the element "code" button
  opens the drawer at the right line, and `isTextEditable` (stamp + text-leaf,
  already framework-agnostic) enables double-click text editing — no preview
  changes needed.
- **`props.ts`** `applyTextEdit` gains an `.html` branch → `spliceHtmlText` →
  `commitEdit` (undo/redo, conflict detection, live-reload), mirroring the
  JSX/Svelte paths. JS-generated DOM (no source location) falls back to chat, as
  decided.
- Adds parse5. Tests: `html-source` (unit), `html-text-edit` (integration, real
  `text:apply` IPC), and a stamp assertion in `static-serve`.

Verified: typecheck + unit tier (38/38) + build + `static-serve` and
`html-text-edit` electron tests (with isolated `PRAXIS_USER_DATA`). Note: run
electron tests via `node test/run.mjs electron` (or with `PRAXIS_USER_DATA` set)
— running the files directly reuses real userData and the app auto-restores a
stale project instead of the empty state.

## 2026-07-24 — Vanilla-JS editing, Tier 1: a door into the code editor

Discovery turned up a sharp gap: a vanilla-JS / static project **can't open the
code editor at all** from the UI. The drawer is fully capable (edit + save any
file, conflict detection, undo/redo, live-reload, IDE hand-off) and its file
tree works for any project — but the only two ways *in* are the element
toolbar's "code" action (hidden unless the element has a `data-praxis-source`
stamp) and the file tree (which lives *inside* the drawer). A static project has
no build step to inject the stamp, so both dead-end.

Tier 1 (of a two-tier plan — decided: Tier 1 now, Tier 2 next):
- **A stamp-independent door.** New `Code2` icon button in the preview header
  (`.previewbar__actions`, shown while the preview runs) toggles the code drawer
  for *any* project. `toggleCodeDrawer` picks a sensible starting file (the HTML
  entry when there is one, else the first file) via `source.tree`, then the
  drawer's file tree takes over. `App.tsx`.
- Universal, not framework-gated — it's additive next to the element→code path.

Tier 2 (follow-up): serve-time `data-praxis-source` stamping in
`static-server.ts` (the served bytes ARE the on-disk file, so the DOM→source map
is nearly free) + an HTML text-splice engine, to light up click-element-to-code
and inline text editing that writes back to the HTML. Decided: JS-generated DOM
(no source location) falls back to chat, like framework projects do today.

Verified: typecheck (node/web/preview) + build. UI test (Code button opens the
drawer + tree) is a follow-up.

## 2026-07-24 — "Connect to GitHub": the first-publish bridge

A first-time user scaffolds a project, builds it locally (delightful, zero-
config), then hits **Publish** — and dead-ends on `No "origin" remote — add
one, then publish.` (`annotations.ts`). Everything up to that point needs no
git/GitHub knowledge; Publish suddenly assumes a repo already exists, an
`origin` is set, and `gh` is installed + authed. The one-click promise broke
exactly at the moment of pride.

New distinct step (product decisions: **separate** action, **private** default,
lean on **gh**, **guide** don't automate, repo reflects the built work — Option B):

- **`src/main/github.ts`** — `githubStatus(root)` (link state + gh readiness,
  prefills the sheet) and `connectToGitHub(root, {name, owner, private})`:
  preflight gh install+auth → fast-forward the clean base up to the work branch
  when it's an ancestor (so the repo's default branch shows what the user built,
  not the bare scaffold) → `gh repo create --private --source . --remote origin`
  → push default + work branch → set default branch + `origin/HEAD`. Defensive:
  every failure returns `{ ok, error }`.
- **`src/shared/github.ts`** — pure, testable helpers: `sanitizeRepoName` and
  `resolveConnectPlan` (the Option-B branch logic). `test/github-connect.mjs`.
- **Renderer** — `useGithub` store holds the opened project's status (null for
  non-repos → header keeps Publish). The header swaps Publish for **"Connect to
  GitHub"** until an `origin` exists (`App.tsx`); once connected, Publish returns
  and works unchanged. New `ConnectDialog` (mirrors FeedbackDialog's preview-
  freeze): name (live-sanitized), owner (login + orgs), Private default; gh
  missing/unauthed shows the exact step + a Retry that re-probes.
- Publish (`shipToMain`) is untouched — it just works once a remote is present.

Verified: `bun run typecheck` + full unit tier (37/37, incl. github-connect) +
`bun run build`. NOT yet driven in the Electron UI (no existing harness for the
no-remote fresh-project state) — a tier-2 screenshot test is a good follow-up.

## 2026-07-24 — "/" menu shows all skills (drop the 8-item cap)

The composer's slash menu silently truncated at 8 matches
(`ChatPanel.tsx` did `[...project, ...other].slice(0, 8)`), so anyone with more
than a handful of project skills + backend commands only ever saw a fraction of
them — the rest were unreachable unless you typed enough letters to filter down.

- **Extracted the ranking to `src/shared/slash-menu.ts` (`rankSlashMatches`)** —
  pure (renderer can't import `main/skills.ts`; it pulls in `node:fs`), so it's
  unit-testable and shared. Same behavior as before *minus the cap*: case-
  insensitive substring filter, project skills first, same-named non-project
  command shadowed by its project skill.
- **No cap.** The `.slash` popup already has `max-height: 240px; overflow-y:
  auto`, so overflow was always meant to scroll — the slice just hid it. Project
  skills stay at the front of the list, so they're never the ones scrolled past.
- **Keyboard nav follows the scroll:** an effect calls
  `activeItemRef.scrollIntoView({ block: 'nearest' })` on `menuActive` change, so
  arrowing down past the fold keeps the selected row visible.
- Tests: extended `test/skills-discovery.mjs` with `rankSlashMatches` cases
  (empty query returns all, case-insensitive filter, project-first, shadowing,
  and a >8-match no-truncation regression).

## 2026-07-23 — Stop the "Object has been destroyed" crash dialog on wake

Closing the window (traffic-light close, NOT quit — the app stays alive to own
the dev server) and then sleeping/waking the Mac popped a *series* of Electron
`Uncaught Exception: TypeError: Object has been destroyed` dialogs — from
`powerMonitor` 'resume', a dev-server `Socket.onData`, `WebContents.reportUrl`,
and IPC forwarders.

**The real root cause:** `createWindow()` never nulled `mainWindow` on
`'closed'`. So after the window closed, `mainWindow` (and the child
`previewView`/`panelView`) kept pointing at the *destroyed* objects — every
`mainWindow?.…` guard in the codebase was defeated (non-null but dead). Any
background listener that survives the window and fires on wake then threw.

Fixes, defense-in-depth:
- **`index.ts` — the primary fix:** `mainWindow.on('closed', …)` now nulls
  `mainWindow`, `previewView`, `panelView`, `previewUrl`, `lastPreviewBounds`.
  This makes every `?.` guard short-circuit AND fixes a latent reopen bug
  (`ensurePreviewView`/`ensurePanelView` would otherwise hand back a dead view
  on the next dock re-open).
- **`index.ts` — powerMonitor 'resume':** guards `webContents.isDestroyed()`
  before `.invalidate()`.
- **`index.ts` — top-level backstop:** a `process.on('uncaughtException')` that
  swallows (logs) only `TypeError: Object has been destroyed` — the benign
  post-teardown race — and re-surfaces everything else via `dialog.showErrorBox`,
  so real bugs aren't hidden but a teardown race can't pop the modal.
- **Async-send guards (isDestroyed) for every event-driven `.send()`:**
  `index.ts` `sendToMain()` (all 15 sites, covers `reportUrl` + IPC forwarders),
  `devserver.ts` (`devserver:log`), `backends/tools.ts` `sendToRenderer()` used
  by `claude.ts`/`codex.ts`/`gemini.ts`, `agent.ts` (`safeSend`), `simulator.ts`
  (`sendToWin`), `update-ipc.ts`, `chat-isolation.ts`, `control-panels.ts`.

No behavior change while the renderer is alive; typecheck + unit tier green,
smoke launches clean. NOTE: the fix only takes effect after a rebuild + relaunch
— a running old binary keeps crashing (its stack line numbers are the tell).
(pre-existing `apca` unit skip: `apca-w3` not installed locally.)

## 2026-07-23 — Resumed chats keep their transcript across a window close+reopen

Surfaced once the crash fix above let close+reopen actually complete: after
closing the window (app stays alive on macOS) and reopening, the chat repainted
EMPTY while the preview came back. Not a regression from the crash fix — a
pre-existing gap the crashes had been masking.

Root cause (found via temporary `[restore-debug]` traces in the workspace
snapshot): a chat resumed from disk (`agent:resume-session`) starts a fresh
session with the SDK's `resumeSessionId` and shows the user the past messages
from the on-disk record — but never copied that history into the live
`session.record.transcript`, which only accrues NEW turns. So the reattach source
of truth (`agent:workspace-snapshot`, read on the next boot) saw an empty
transcript and `restore.ts` hydrated a blank chat. The first launch masks it
(it resumes from disk directly); only the SECOND reopen, which reattaches to the
still-live-but-empty record, shows blank.

Fix (`agent.ts` `agent:resume-session`): seed the fresh live record with
`rec.transcript` (entries copied, so a later finalize/push can't mutate the disk
record) right after `adoptSession`, guarded on the live transcript being empty.
Now the live record faithfully mirrors the resumed history, so a reattach
repaints the full chat. Verified live: `transcriptLens` is non-zero on the
second reopen and the chat comes back.

## 2026-07-21 — Per-turn "Revert changes" in the chat

Each completed chat turn's file edits can now be rolled back from a discoverable
per-message button, next to Copy — not just via the invisible, strictly-LIFO
global Cmd+Z. It reuses the existing in-memory edit-history substrate: every
merged turn on a git-repo-root chat is already recorded as one atomic group
`chat:<wtId>:<turnNo>` with full `{before, after}` snapshots, so this is a
surfacing job, not new persistence.

- **`edit-history.ts`** gains two addressable-group functions beside undo/redo:
  `revertGroup(root, group)` restores every file's `before` for ONE group
  anywhere in the stack (not just the top), all-or-nothing, refusing (conflict)
  if any file drifted from the `after` that turn wrote — the same "is this safe?"
  guard `undo` uses. On success the group leaves the undo stack; nothing is
  pushed to redo (revert is a one-way action outside the linear undo/redo model).
  `canRevertGroup` is the cheap drift-aware pre-check for greying the button.
- **IPC trio** (`props.ts` `edit:revert`/`edit:can-revert` → `shared/api.ts`
  `edits.revert`/`canRevert` → `preload`), kept in sync per the usual rule.
- **`chat-isolation.ts`** tags the merged turn: `emitIsolation` now carries the
  `group` id and a `revertable` flag on the `isolation` event. `revertable` is
  `false` once the chat's work is pushed & merged — gated on the session record's
  `prUrl` (held by reference from `adoptSession`, so a later `tag-session` shows
  through). The renderer hides Revert when `revertable === false`.
- **Renderer**: `ChatMessage.revertGroup` + a `tagRevert` store action stamp the
  latest assistant turn from the merged event (before the "Merged into your
  branch" note, so the real turn gets tagged). `RevertAction` sits by `CopyAction`
  in a shared `msg__actions` row; a refused revert shows an inline "Can't revert —
  files changed since this turn" hint. The dev server HMRs the restored files.

**Limitations (by design):** only git-repo-root chats get per-turn groups (subdir
/ non-git projects run on the live tree with no `recordEdit`, so no button, same
as today's undo); history is in-memory (cleared on close/quit); reverting an older
turn no-ops with the conflict hint if a later turn or hand edit touched its files.

Verification: `test/edit-history.mjs` extended (addressable revert, drift conflict,
all-or-nothing group) — unit tier green. New `test/revert-action.mjs` (electron
tier) drives a finished turn, asserts Revert renders only once tagged and sits by
Copy, and clicks it to exercise the full renderer→preload→main round-trip (the
conflict hint). `bun run typecheck` green across node/web/preview.

## 2026-07-20 — Pop-out editor gets a file-tree sidebar; IDE button + close cleanup

The popped-out code editor (`?praxisEditor=1` window) now has a left file-tree
sidebar. Clicking a file opens it in the shared `useCodeDrawer` store, so
Cmd+click navigation and back/forward keep working; the tree mirrors the open
file's selection.

- Tree = **`@pierre/trees`** (trees.software), used via its **vanilla (non-React)**
  entry on purpose: the package's `/react` entry peer-requires React 19 but the
  renderer is React 18. The vanilla `FileTree` class renders into its own shadow
  root via Preact — fully decoupled from our React — so `FileTreePanel.tsx` just
  mounts it imperatively in a `useEffect` and bridges selection ↔ the drawer.
- New `src/main/file-tree.ts` + `source:tree` IPC lists the project's files:
  `git ls-files` (tracked + untracked-not-ignored) for repos, bounded fs-walk
  fallback (skips node_modules/dist/etc.) for non-git folders. POSIX paths,
  sorted, capped at 20k. Unit-tested in `test/file-tree.mjs` (unit tier).
- CodeDrawer window variant relaid out as a row (tree aside + editor column); the
  macOS traffic lights now float over the sidebar, so a draggable spacer clears
  them and the header dropped its `pl-20` inset.
- Toolbar: the **"Editor"** button is now **"IDE"** (icon dropped); the top-right
  **close** button is hidden in the pop-out (its native traffic lights close it)
  and kept only on the docked drawer.

Typecheck + build green; `test:file-tree` green. The Electron UI tiers couldn't
run in this headless session (no display — even unmodified UI tests fail to
launch); the tree render itself needs a manual `bun run dev` check.
## 2026-07-22 — `praxis --update` no longer aborts on install-generated lockfile drift

`praxis --update` was failing at its first step with `git pull --ff-only`:
> error: Your local changes to the following files would be overwritten by merge: bun.lock

Root cause: `bun install` (run by the updater itself, and by every `dev`/`build`)
rewrites the tracked `bun.lock` as a side effect, so a checkout that's been built
once always carries a dirty, machine-authored lockfile. `--ff-only` refuses to
run over it. This bites every user on their second update.

Fix (`bin/praxis.mjs`): before pulling, discard dirty tracked lockfiles back to
HEAD — safe because the very next step (`install`) regenerates the lockfile
against the pulled `package.json`. Only the machine-generated lockfiles are
touched (`bun.lock`/`bun.lockb`/`package-lock.json`/`npm-shrinkwrap.json`/
`yarn.lock`/`pnpm-lock.yaml`); real source edits still hit the existing
"commit or stash" error. The decision is a pure exported helper
`lockfilesToRestore(porcelain)`, unit-tested in `test/praxis-cli.mjs` (added to
the `unit` tier + a `test:praxis-cli` alias). To make the module importable by
the test, the bottom-of-file `main()` call is now guarded by `invokedAsScript()`
(realpath-compares `argv[1]` to the module, so the PATH symlink install.sh
creates still runs the CLI). Verified end-to-end against a temp repo: the
original failure reproduces, and after the restore the fast-forward pulls both
upstream's `bun.lock` and a new file cleanly. Unit tier 28/28 green.

## 2026-07-19 — Merged origin/candidate (Styles/Custom-controls) into the rename branch

Integrated the 14-commit Styles-panel + Custom-controls feature that landed on
`origin/candidate` while the dsgn→praxis rename was in flight. 11 conflicts, all
the same shape (upstream's new feature code vs the rename's naming) — resolved by
taking upstream's side, then re-running the mechanical `dsgn→praxis` sweep over
the merged tree (excluding the deliberate legacy shims + PROGRESS history). This
also caught the `dsgn` references in the newly-added Styles files (they predated
the rename): `data-praxis-source`, `.praxis/control-panels.json`, `PRAXIS_RULES_VERSION`,
`praxisRules`, `praxis:preview:*` channels, etc.

Watch-outs handled:
- `git checkout --theirs` on `api.ts` dropped the WIP conflict-UX API members
  (`agent.resolveConflict`/`discardConflict`) since it takes the whole file — re-added them.
- `test/rules.mjs`'s stale-header assertion got over-swept again (it intentionally
  names the OLD header): reset to guard `dsgn operating rules`, header is `Praxis`.
- New sidecar `.praxis/control-panels.json` added to `sidecar-migrate.ts`'s move list
  (same class as annotations/tokens); the agent write-deny already covers it via SIDECAR_RE.
- `RULES_VERSION` is now 4 (upstream bumped it for `define_controls`).

Typecheck + unit + electron tiers green.

## 2026-07-18 — Send feedback moved from the entry screen to the sidebar

The empty state's "Send feedback" button is gone (per user call); the rail now
pins one at its bottom-left (below any update banner, outside `rail__inner`'s
scroll), opening the same FeedbackDialog. `styles.css` already carried the
`.rail__feedback` block — this wired up the markup it was written for. The
feedback-dialog test seeds a fake workspace entry (rail only renders with a
project open) and clicks the pinned button.

## 2026-07-17 — Renamed the `dsgn` internals to Praxis (clean break + legacy shims)

Swept the pre-rename `dsgn` name out of the code (~900 occurrences, 111 files):
`data-praxis-source` / `data-praxis-component-source` stamps (RN testID prefix
`praxis:`), `.praxis/` sidecar, `PraxisApi`, `praxis/*` work branches,
`<userData>/praxis` data dir, `PRAXIS_DEBUG_PORT`, `__praxis*` test hooks,
`mcp__praxis__*` tools. Entries in THIS file keep their historical wording.

**Clean break for stamped target repos** (per user call): the old
`data-dsgn-source` attribute is NOT read anymore — old instrumented repos get
the setup offer again. Deliberate legacy shims, and only these:

- `setup.ts` uninstall also removes the old `.dsgn/` helpers + root plugin.
- `git.ts` `isWorkBranch` — a repo already on a `dsgn/*` branch keeps it
  (never nests `praxis/dsgn/…`); publish keeps working from it.
- `sidecar-migrate.ts` (new, pure; hooked into `project:detect`) — one-time move
  of `.dsgn/{annotations,tokens}.json` into `.praxis/`; helpers stay put because
  the target repo's build config may still reference them. Unit-tested
  (`test/sidecar-migrate.mjs`).
- `agent.ts` `dataDir()` — one-time `<userData>/dsgn` → `<userData>/praxis`
  rename + `git worktree repair` per chat worktree (their `.git` back-pointers
  hold absolute paths).
- The agent sidecar write-deny (`tools.ts` SIDECAR_RE) covers `.praxis` AND
  `.dsgn`.

Also fixed sed-self-defeats in tests (`rules.mjs` stale-header check,
`setup-detect.mjs` legacy filenames), the `bun.lock` workspace name, and the
fixture dir `test/fixtures/tokens-priority/.dsgn` → `.praxis`. lkmv.ch (the one
instrumented repo) re-instrumented by hand in the same sweep.

Piggybacked (same file was rename-touched anyway): `test/chat-isolation.mjs`
part B still asserted the composer "Isolated"/"Parked" chips that the
2026-07-16 conflict-UX chunk deliberately removed — updated it to the new
contract (merged → store state + note, no card; parked → ConflictCard pinned
with the affected files + history reload). Full unit + electron tiers green.

## 2026-07-16 — Parked-chat conflict UX: sidebar badge + AI "Resolve it" card

Made the per-chat isolation "parked" state (a turn whose changes couldn't auto-merge because the user edited the same files) legible and actionable, instead of a cryptic note pointing at the sidebar.

- **Sidebar badge** — a live chat whose `isolation === 'parked'` shows an amber **"conflict"** pill on its rail row (`Rail.tsx`, `.rail__chat-badge` in `styles.css`). While a project has a parked live chat, its redundant `chatpark-*` history row is hidden from "previous chats" (the badge + card own that state now).
- **In-chat ConflictCard** (`src/renderer/src/components/ConflictCard.tsx`, mirrors `SetupCard`) — pinned above the composer while parked. Plain-language explanation ("This chat edited files that also changed in your project…"), the affected file chips, and two actions: **Resolve it** and **Discard changes**. Replaces the old `appendNote` warning; the small composer "Parked" chip was removed.
- **"Resolve it" = AI reconciles** (per user steer — most users won't touch git markers). New `stageResolve` (`chat-worktrees.ts`) resets the chat's worktree onto the user's live tree and 3-way re-applies the chat's diff, so the worktree holds BOTH sides. If they don't overlap it merges cleanly and `resolveParkedChat` (`chat-isolation.ts`) commits + merges + unparks with no agent turn. If they overlap, it leaves conflict markers and returns the files; `agent:resolve-conflict` hands back a resolution prompt the renderer runs as a normal turn, whose `afterTurn` merges + unparks. **Discard changes** → `agent:discard-conflict` → `discardParkedChat` (resets the worktree, unparks).
- **IPC:** `agent.resolveConflict()` / `agent.discardConflict()` (api + preload + handlers), keyed by the active session so the renderer never needs the branch name. Store: `ChatSlice.isolationFiles` carries the parked files to the card; `setIsolation(key, state, files)`.

**Known limits:** if the AI resolution turn leaves markers unresolved (or errors), `afterTurn`'s auto-apply can write them to the live tree — the prompt strongly instructs removing all markers. On reload the card shows without its file list (the snapshot doesn't carry files; resolve still works — main recomputes).

**Tests:** extended `test/chat-worktrees.mjs` with `stageResolve` cases (non-overlapping drift → clean auto-merge + landed on live; overlapping drift → conflict markers carrying both sides). Typecheck + build green.
## 2026-07-18 — Styles tab (Dialkit-style controls) + AI-surfaced custom controls

The island panel is now tabbed: **Props | Styles | Custom**. Styles gives direct,
scrub-to-adjust control over the v1 CSS set (padding/margin/gap, colors, radius,
opacity, the type properties, and transitions incl. a draggable cubic-bezier
editor). Custom appears when a component has an AI-generated control panel —
the user asks Praxis to "surface controls" for something the automatic paths
can't see, and the agent instruments the source and registers a manifest.

**Why a hybrid commit path.** A scrub has to end up in source, and there are
three honest outcomes: the element uses utility classes → rewrite the class
(`p-4` → `p-[13px]`, named-scale snap where one exists); it doesn't → splice an
inline style; the site is dynamic (spread, `style={expr}`, ambiguous class
family) → hand it to the agent, the same `needsAgent` escape prop editing
already uses. Everything commits through `commitEdit`, so HMR and undo come
free, and edit-history's 500ms coalescing means one scrub burst is one Cmd+Z by
construction rather than by bookkeeping. Live feedback while dragging is CSS
injected into the preview (`styles:preview`), reverted from a stash bound to the
element it was taken from; after a commit the panel lifts its own override
before re-reading, so the reconcile compares against real source output instead
of reading back its own injection.

**Why manifests store no values.** A control panel is metadata: which parameter,
how to reach it, what range. Values are re-resolved on every lookup — literals
by lexing the literal that follows a unique anchor string, props from the live
inspection, styles from computed styles. Staleness then handles itself: moving a
constant is invisible, renaming one marks that param stale with a reason and a
Regenerate button, and no cache can drift from the file. Anchor uniqueness is
re-checked at save and again at every apply, so a manifest can never splice the
wrong site; main renders every literal it writes (clamped, quoted, markup
rejected) because the manifest is agent-authored and therefore untrusted.

**The worktree trap.** `define_controls` runs in the chat's worktree, so the
naive `saveManifest(root, …)` would have written the manifest somewhere that
merges back later — or not at all. `SpawnContext.liveRoot` now carries the true
project root; the callback validates anchors against the worktree file the agent
just wrote and persists to the live tree. Mid-turn the manifest may reference a
constant that only exists in the worktree, so it resolves as stale until the
merge lands and the Custom tab flips live on the turn's `done` (and `error` —
the worktree merges back there too, to salvage interrupted edits).

**Non-Claude backends** get no custom tools, so the trigger prompt branches: the
agent exposes typed props with literal defaults and the Props tab picks them up
on re-inspect. The prompt does the instrumenting either way — steering constants
into the component's own file, which is also what keeps a literal scrub on a
fast react-refresh boundary instead of a full page reload.

**Notable calls:** literal params have no live-preview channel (an arbitrary
constant can drive anything), so they commit at a 250ms trailing cadence and the
file write through HMR *is* the preview; the transition-property select is a
native `<select>` because a portal dropdown would clip at the island view's
edge; ScrubInput uses pointer *lock*, not capture, since capture dies at that
same edge, and exiting the lock commits rather than reverts.

**Tests:** `tw-styles`, `inline-style`, `css-values`, `control-panels` (unit);
`style-edit` and `custom-controls` (Electron, driving the real island UI and
asserting on disk, with island screenshots in `test/artifacts/`);
`controls-agent` (live tier, self-skipping) runs a real turn and asserts a valid
manifest lands in the live tree — it passed end to end, which is what proves the
`liveRoot` path.

**Known limits:** computed px is accepted where source authored rem (named-scale
snapping recovers it in the Tailwind case); a `cn(...)` element falls to the
inline path and leaves the old utility in place; no springs/framer-motion, no
width/height or box-shadow, no responsive/state variants; navigation wipes the
preload's selection state and the panel asks for a re-pick rather than
re-resolving.

## 2026-07-16 — Per-chat worktree isolation with merge-back

Multiple concurrent chats on the same project can now run in isolation without clobbering each other's edits. Every interactive chat (default, new-chat, resumed) on a git repo root gets its own long-lived git worktree on branch `dsgn/chat-<id>`; edits from each turn are committed to that branch, then merged back to the live tree at turn end (on `done` and `error` events). The preview always serves the live checkout and reflects merged edits between turns.

**Design:** the core git machinery (`createWorktree`, `commitWorktree`, `autoApplyWorktree`, `removeWorktree`, `pruneOrphans`) already existed from v8's comment-spawn feature and is reused without modification. Two new pure modules coordinate the per-chat lifecycle:

- **`src/main/chat-worktrees.ts`** (~185 lines, unit-tested): state-free turn operations — `syncFromLive` (drift sync at turn start), `completeTurn` (commit + merge decision), `applyParked` / `discardParked` (conflict-park review actions).
- **`src/main/chat-isolation.ts`** (~280 lines, Electron-coupled): per-chat lifecycle and state — `initChatIsolation`, `isolatedCwd` (route new sessions through their worktree), `adoptSession` (stamp record back to live values for reload reattach), `beforeTurn` / `afterTurn` (turn chain serialization), `releaseChat`, `liveChatWorktreeIds`, `handleReclaimed` (crash recovery).

**Turn flow:** on `agent:send`, await `beforeTurn` to serialize drift-sync and drain any in-flight post-`done` merge from the prior turn. On turn end (`done` / `error`), fire `afterTurn` (queued on the per-chat chain) to commit + attempt auto-apply. If applied, edits are recorded as one undo group per turn and the base is advanced so the next turn sees only new drift. If refused (conflict / binary / write failure), the work parks on the branch as a persistent commit; the chat gets a warning note and the branch surfaces in the sidebar for review — `SessionReview.tsx` gates Apply/Discard/PR on `kind === 'comment' && !!branch`, reusing the spawn review UI. Parked chats re-attempt auto-apply on every `done` (self-heals when drift resolves).

**Lifecycle & crash recovery:** worktrees created on session start (`agent:new-chat`, `agent:resume-session`, `agent:open-project`); removed on session close after a final completeTurn. Restart (model picker) reuses the existing worktree. `open-project`'s `pruneOrphans` crash-recovery skips live chat worktree ids (one global `liveChatWorktreeIds()` call covers all open projects), recovers dirty orphaned `dsgn/chat-*` branches as park records, and deletes clean unrecorded branches only if all files already match the live tree (closing a commit-before-merge crash data-loss window).

**IPC:** new `isolation` event type in `AgentEvent` (no new channels); lives in the chat's `LiveChatSnapshot` for reload reattach. `agent.ts` spawn projectKey fix lands here too: `startSpawn` now stamps `s.record.projectKey = q.parentKey`, fixing spawn records' invisibility to `sessions:list`.

**Known limits:** resumed sessions get a fresh worktree; agent writes via absolute live-root paths escape the worktree (mitigated by a rules.ts note); heavy mid-turn live editing (prop panel during long turns) parks often.

**Tests:** `test/chat-worktrees.mjs` (unit, pure git repos), `test/chat-isolation.mjs` (Electron, real app), existing fixtures on the live-cwd path unchanged.
## 2026-07-16 — User-visible "dsgn" mentions replaced with "Praxis" (LKM-57)

The old product name still leaked into user-facing copy (setup card, prop-panel
hints, diagnose card, auth banner, preview context menu, dev-server conflict
error, publish/PR titles + bodies, scaffolded template, worktree git author).
All of it now says **Praxis**; the comment-agent PR body also pointed at the
old `alikimovich/dsgn` repo URL — fixed to `alikimovich/praxis`.

Deliberately **kept** (protocol/identifiers, per CLAUDE.md): `data-dsgn-source`
stamps, the `.dsgn/` dir + helper file names, the `dsgn/*` branch prefix (the
publish-from-base error now reads "a Praxis work branch (dsgn/*)"),
`?dsgnPanel`/`?dsgnSim` flags, storage keys, and `Dsgn*`/`dsgn*` type and
function names. The scaffolded `.dsgn/` helpers' prose comments say Praxis but
their plugin names/exports are unchanged. Tests updated:
`test/publish-message.mjs`, `test/ready-gating.mjs`.

## 2026-07-16 — Empty chats get no rail row until their first message (LKM-55)

Mashing the rail's "+" minted a new live session every click, filling the rail
with identical "New chat" rows — unlimited empty chats.

- **Rail** now skips live chats whose slice has no messages: a chat's row
  appears only once its first message is sent (Cursor-style). An empty chat has
  nothing to name or return to; past/spawn rows are unaffected.
- **App's `newChatForProject`** reuses an existing empty live chat (switches to
  it) instead of stacking another session — an empty chat already IS a "new
  chat", so "+" is idempotent until you actually type something.
- Tests: `test/chat-render.mjs` asserts empty chats render no rows, "+" with an
  empty chat live doesn't grow `sessionKeys`, and rows appear per-chat as each
  first message lands.

## 2026-07-16 — Project skills first in the "/" menu, with descriptions (LKM-54)

The composer's "/" menu listed the SDK's advertised command names flat, so the
opened repo's own skills (`.claude/skills/**/SKILL.md`) drowned among built-ins
and had no descriptions.

- **`AgentEvent` `commands` now carries structured items** —
  `SlashCommandItem { name, description?, source: 'project' | 'other' }`
  (`shared/api.ts`) instead of bare strings.
- **New `src/main/skills.ts`** (main-process — the renderer stays free of fs
  reads): `discoverProjectSkills(root)` scans `.claude/skills` (nested dirs
  tolerated) and pulls `description` from each SKILL.md's YAML frontmatter with
  a defensive no-dependency parser (plain/quoted/block scalars; malformed input
  degrades to an undescribed item, never breaks the menu);
  `mergeSlashCommands(project, sdkNames)` ranks project skills first and lets a
  project skill shadow a same-named SDK command.
- **`backends/claude.ts`** discovers once per session and re-emits the merged
  list whenever either side (project scan, `supportedCommands()`, the init
  message's `slash_commands`) arrives.
- **`ChatPanel`** filters by name, keeps project-first ranking + dedupe on the
  render side too (guards store seeds/other backends), and renders two-line
  items: `/name` plus the description truncated to one visual line (`truncate`).
  Filtering, keyboard nav, click-to-insert, and the 8-item cap are unchanged.
- Tests: `test/skills-discovery.mjs` (unit tier — parse/scan/merge);
  `test/chat-render.mjs` now asserts priority order, duplicate collapse,
  description fallback, one-line ellipsis truncation, and Enter/click insertion.

## 2026-07-15 — Attach arbitrary files (not just images) to the chat

The composer only accepted images (read into base64, sent as vision blocks).
You can now drop **any** file into the message area: non-image files are handed
to the agent **by absolute path** (it reads them with its own tools) and shown
as a filename card next to the image thumbnails.

- Images are unchanged (still base64 vision blocks). Only non-image drops/pastes
  take the new by-path route, split in a shared `addDroppedFiles` helper.
- A new preload bridge `pathForFile` wraps `webUtils.getPathForFile` — Electron
  43 removed `File.path`, so the real on-disk path must be recovered in the
  (sandboxed) preload. Pathless blobs (e.g. an in-memory clipboard file) yield
  '' and are skipped.
- No IPC contract change: file paths are folded into the existing `agent.send`
  text argument (a `[Attached files]` block prepended like the selection `ctx`),
  so `ImageAttachment`/`agent:send` stay as they were.
- `test/chat-render.mjs` now drops a real file via a hidden `<input type=file>`
  (so `getPathForFile` resolves a true path — a synthetic `File` has none),
  asserting the filename card renders and removes. It also fixes a stale
  assertion there that still expected the permission-mode selector to be absent
  after a612f83 restored it.

## 2026-07-15 — Keep agent model choices with their individual chats

The model/backend picker lived in the renderer-wide session store, so selecting
a model in a newly created chat made an older chat *display* that new model when
the user returned to it. Live chats now retain their own model, provider, and
reasoning-effort settings in their workspace entry; the picker mirrors only the
currently selected chat and restores that chat's saved settings on every rail
switch.

- A new chat inherits the choices of the chat it was created from, then diverges
  independently. Older workspace data without settings safely uses defaults.
- Codex must choose its model when it starts. A new `agent:restart-chat` IPC
  therefore replaces only the selected Codex chat when its model or provider
  changes — it no longer reopens the project's default chat and accidentally
  affects a sibling.
- `test/chat-render.mjs` now covers new-chat model selection followed by switches
  back and forth between two chats, asserting that each picker is restored.
## 2026-07-15 — Keep images + selection visible in sent chat bubbles (LKM-53)

Attached images and the selected-element pill were shown in the composer but
disappeared the instant you sent the turn — the message bubble only rendered
text, so the transcript lost the visual context of what the ask was about.

- **`ChatMessage` carries the extras.** Two new optional fields (`store.ts`):
  `attachments` (image thumbnails — `{id, mediaType, url}`) and `selection` (a
  display-only `{tag, ident, source}` snapshot). `appendUser` gained an `extras`
  arg to attach them; `selectionForBubble(el)` builds the snapshot, mirroring the
  Inspector pill's `#id`/`.class` identifier logic so live pill and sent pill match.
- **`send()` passes them through.** `ChatPanel.send` maps the composer's
  `attachments` + current `selected` onto the appended user message. The model
  still gets the selection as hidden prompt context (`describeSelectionForPrompt`
  prefix), unchanged — only the bubble is new. Dropped the old
  `🖼 N image(s)` placeholder text; the thumbnails stand in for it now.
- **Render.** User bubbles now show the selection pill + image thumbnails above
  their text (right-aligned to match `.msg--user`).
- **Known limit:** images aren't persisted to the on-disk transcript, so a
  reloaded/resumed chat won't re-show them (the selection still survives as the
  prompt-prefix text it always did). In-scope fix is the live send experience.
- `test/chat-render.mjs`: a sent user turn keeps its thumbnail + pill.

## 2026-07-14 — Pop the code drawer out into its own window (LKM-48)

The v9 code drawer was locked to the strip under the preview. You can now pop it
into a standalone, freely-resizable native window.

- **New window = same bundle, new entry.** `main/index.ts` `openEditorWindow`
  opens a `BrowserWindow` running the renderer with `?dsgnEditor=1&root=…&source=…`
  — the same trick the `?dsgnPanel` prop-island uses. `main.tsx` routes that query
  to a new `EditorWindow` component (renderer/src/components/EditorWindow.tsx),
  which renders the editor full-window instead of `<App>`. Reuses CodeMirror, all
  `source:*` IPC (same preload), and the app theming for free.
- **One window per project root.** `editorWindows` is keyed by root: a second
  pop-out for the same project re-focuses the open window and retargets it at the
  new file via an `editor:navigate` push (`source.onNavigate` in the preload)
  rather than stacking duplicates. The rail keeps several projects open, so
  different roots each get their own window.
- **`CodeDrawer` grew a `variant` prop.** `'drawer'` (default) is unchanged;
  `'window'` fills `h-screen`, reserves **no** preview inset (`usePanelInset`
  early-returns), and drops the drawer-only chrome (resize handle, expand toggle).
  The header doubles as the macOS `hiddenInset` title bar — left-padded past the
  traffic lights, with the file-name span as the drag region so the buttons stay
  clickable. Cmd+click nav + back/forward still work: `EditorWindow` drives the
  drawer off the store, so jumps navigate within the popped-out window.
- **New IPC** (`src/shared/api.ts` + preload + `registerEditorIpc`):
  `source.popout(root, source)`, `source.closeWindow()` (a popped editor closing
  itself), `source.onNavigate(cb)`. A new **pop-out** button sits in the docked
  drawer's header; clicking it opens the window and closes the docked strip.
- `test/code-drawer.mjs` extended: the pop-out button opens a second window
  running the `.codedrawer--window` variant (no resize handle), releases the
  drawer inset, and its close button closes the window. (Electron UI tier —
  needs a display; can't run on a headless runner.)

## 2026-07-12 — Auto-name chats by subject, not opening words (LKM-45)

The rail named a chat by truncating its first user message (`chatTitle` +
`firstUserText`), so a chat that opened "Hey, can you help me…" got that literal
string as its name instead of what it turned out to be about. Now the backend
**summarises the conversation into a short title** once a chat's first turn
finishes.

- **Backend seam.** New optional `ModelProvider.generateTitle(transcript,
  options)` — a one-shot, tool-less `query()` (Claude backend). It runs with
  `settingSources: []` (no repo CLAUDE.md/skills) and denies every tool via
  `canUseTool`, so it can't touch the repo or drift into work; a 20s abort +
  catch-all makes it strictly best-effort (any failure → null). The pure
  transcript-digest / output-sanitiser helpers live in `backends/title.ts` (kept
  Electron-free so they unit-test in bun — `test/chat-title.mjs`).
- **Trigger.** `agent.ts` fires `maybeGenerateTitle` off each interactive
  session's `done` event (new `interactiveEvents` hook wraps `trackRunning`).
  Runs **once per chat** (guarded by `record.title`), only when both sides have
  spoken, sets `record.title`, and emits a new `{ type: 'title' }` AgentEvent.
  A resumed chat carries its prior `record.title` forward so it keeps its name.
- **Renderer.** ChatPanel routes the `title` event to `useChat.setTitle`; the
  rail prefers `slice.title` / `rec.title` and falls back to the old
  first-message heuristic until a title exists. `restore.ts` re-seeds the title
  on reload from the persisted record. Backends without `generateTitle`
  (Codex/Gemini) simply keep the heuristic name.

## 2026-07-11 — Codex: don't nag on switch, and give it its own model picker (LKM-42)

Two Codex UX bugs. **(1) The `codex login` hint showed on *every* switch to the
Codex backend**, even for an already-connected user — the render guard was just
`if (!p?.login)`. Gated it on a new `codexAuthNeeded` store flag that's raised
only when a Codex turn actually reports an auth/"not connected" error (mirrors
`authNeeded` for Claude, kept separate so the Claude onboarding banner never
fires for a Codex failure). `isAuthError` now also matches Codex's `sign in` /
`codex login` phrasings. **(2) The model picker always listed Claude's models**
(opus/sonnet/haiku), so on Codex you couldn't pick a real model and selecting one
handed a Claude name to Codex → the turn failed. The picker now switches per
backend via `modelsFor(provider)` (Codex → Default / GPT-5 Codex / GPT-5), and
because Codex fixes its model at `startThread`, `onModelChange` reopens the
session on the new model instead of a no-op live `setModel`. Switching backend
resets the model to Default (names don't cross providers).

- **Gotcha fixed in the same pass:** Codex's backend emits `done` after *every*
  turn — including the failed auth turn, right after the `error` that raises the
  hint. Clearing `codexAuthNeeded` on `done` (as the first cut did, copying the
  Claude path) would wipe the hint the instant it appeared, so it's now cleared
  only on a real `delta` (streamed output = genuinely connected). Claude keeps
  clearing on `done` because its backend only emits `done` on success.
- `test/chat-render.mjs` extended: hint stays hidden on switch, the model picker
  lists Codex models (not `opus`), and the hint appears once `codexAuthNeeded` is
  raised. (Electron UI tier — needs a display; can't run on a headless runner.)

## 2026-07-11 — Regression-test the mid-message "/" menu trigger (LKM-37)

The "/" skills menu already opened mid-message (it reads the "/" token the caret
sits in via `/(?:^|\s)\/(\S*)$/`, so it fires at the start or after whitespace but
not when a non-whitespace char precedes "/"), but the parsing lived inline in
`ChatPanel` with no coverage. Extracted it to a pure, string-only
`src/shared/slash-token.ts` (`parseSlashToken`) and added `test/slash-token.mjs`
(unit tier) locking the behavior: opens at start and after space/newline/tab,
stays closed for `foo/bar`, `a/`, `http://x`, and once a trailing space ends the
token. `ChatPanel` now calls the shared helper — no behavior change, just testable.

## 2026-07-10 — Discoverable "Edit text" in the preview toolbar (LKM-38)

Inline text editing already existed (double-click a stamped, text-only element in
Select mode → contentEditable → source splice; see 2026-06-24), but it was a
hidden gesture with no on-screen affordance, so it read as "gone". Re-surfaced it
as an explicit **Edit text** button on the in-preview selection toolbar.

- **`edit` icon button** (pencil) added to the toolbar pill in `preview/preload.ts`,
  in DOM order `comment, annotate, [input], edit, props, code | delete`. It shares
  the *exact* edit engine as the double-click: `onDblClick` and the button both
  call a new `startTextEdit(el)` (extracted from the old `onDblClick` body).
- **"When it's possible"** — `isTextEditable(el)` gates the button: a directly-
  stamped element with no child elements and not a void/replaced tag
  (`img`/`input`/`svg`/…). `setEditAction()` shows the button only for such a
  selection (mirrors `onDblClick`'s guard), and `setTrailingActions` hides it
  while the comment/annotate input is open. Non-text or expression content still
  falls back to the agent on commit, unchanged.
- `test/select-element.mjs`: toolbar order assertion now expects the `edit` kind
  and that it renders visible for the plain-text `#hero-title`; a new step clicks
  the Edit button and asserts it arms `contenteditable="plaintext-only"`, then
  Escapes to cancel. (UI tier — needs a display; typecheck green.)
## 2026-07-10 — Agent knows it's in Praxis; preview becomes a pair of tools

Rules v3 (`main/rules.ts`, `dsgnRules(opts?)`): the product is named **Praxis**
in the agent-facing text (identifiers unchanged), the opening context tightened
(designer pointing at UI, `data-dsgn-source` file:line selections, instant
HMR), and a new `previewTools` flag gates a "Seeing the user's preview" section
so Codex/Gemini never hear about tools they don't have.

The silent per-message "The preview is currently showing <path>." prefix is
GONE (ChatPanel no longer prepends it; `describePreviewLocationForPrompt`
removed; `usePreviewLocation` stays for UI). Instead the Claude backend now
registers Praxis's first in-process SDK tools via `createSdkMcpServer`:

- `mcp__praxis__preview_location` — the agent asks where the user is when the
  page actually matters (live SPA URL from the preview webContents; "No project
  preview is open." on the placeholder).
- `mcp__praxis__preview_screenshot` — exactly what the user sees (their route,
  viewport, simulator): `capturePage()` downscaled to ≤1200px JPEG, returned as
  an MCP image block.

Both are read-only and never raise a permission card (`allowedTools` + a
`canUseTool` early-allow). A new `main/preview-state.ts` registry hands the
preview URL/capture to the backends without an index.ts↔backends import cycle.
A bundled plugin (`agent-plugin/` at the repo root, wired via the SDK `plugins`
option when present) ships a `praxis-preview` skill teaching the workflow:
observe with the tools, interact via `agent-browser`, verify visual changes
with a screenshot. `test/rules.mjs` pins v3 + the gating;
`test/preview-location.mjs` now asserts the composer does NOT prepend.

## 2026-07-10 — Drag-resize the code drawer (LKM-35)

The bottom code drawer (`CodeDrawer.tsx`) can now be resized by dragging its top
edge, not just toggled between the fixed 300px height and expanded.

- **A `.codedrawer__resize` handle** straddling the top border (`absolute -top-1
  h-2`, `cursor-ns-resize`, `role="separator"`). `onPointerDown` captures the
  start Y + current height and installs window `pointermove`/`pointerup`
  listeners (so the drag survives the pointer leaving the thin strip); each move
  sets an explicit `dragHeight` from the vertical delta (up = taller). Arrow
  Up/Down on the focused handle nudges it 24px for keyboard users.
- **Height precedence:** `dragHeight` (if set) → `expanded` → default `DRAWER_H`.
  All pass through `clampHeight` to `[MIN_DRAWER_H (120), maxHeight]`.
  `maxHeight` = `min(80% of the window height, containerH − MIN_PREVIEW)`, so the
  drawer never exceeds 80% of the viewport and never fully hides the preview. A
  window `resize` listener tracks `viewportH` so the ceiling stays live; the
  render-time clamp keeps a stored `dragHeight` from stranding out of range.
  The expand toggle clears `dragHeight` so it reclaims precedence.
- `test/code-drawer.mjs` extended: drag the handle to the top of the window and
  assert the reserved inset grows but stays ≤ 80% of `window.innerHeight`.

## 2026-07-10 — Close individual live chats from the rail (LKM-34)

Each live chat row in the rail now carries the same hover-revealed × the past
chats and spawns already had — so a user can close ONE of a project's open chats
without closing the whole project.

- **New `agent:close-chat` IPC** (`root`, `sessionKey`): tears down just that
  session via the existing `closeSession` (so a closed chat persists to history
  and becomes a resumable "previous agent", exactly like project close), then
  re-points the project's active chat to a survivor (prefers the default `key`).
  Returns `{ remaining, activeSessionKey }`; `activeSessionKey` is null when no
  chat remains. If the closed chat was the globally active one, `activeKey`
  follows the survivor (only while the project is still intended-active — never
  resurrects a backgrounded session into a chat the renderer isn't showing).
- **Renderer `closeChatForProject(key, sessionKey)`** (App): closing a project's
  LAST live chat falls through to `closeProjectFromRail` (nothing left to show);
  otherwise it awaits the IPC (so main disposes before the slice is cleared —
  a trailing emit can't resurrect it), drops the `useChat` slice, rewires the
  entry's `sessionKeys`/`activeSessionKey`, and switches the visible chat only
  when the closed one was the active chat on screen.
- Wired through `shared/api.ts` + the preload bridge + a new `onCloseChat` Rail
  prop; the × reuses the existing `.rail__chat-x` styling (hover-to-reveal).
  `test/agent-multi.mjs` extended: open a 2nd chat, close only it, assert the
  project stays live and the closed key is gone from `remaining`.

## 2026-07-09 — macOS: sidebar vibrancy behind the rail

The main window's base is now the NSVisualEffect *sidebar* material instead of
a solid white/dark fill (macOS only; Windows/Linux keep the theme color).
Electron allows ONE vibrancy material per window (a true multi-material split
needs a native NSVisualEffectView addon — the old `electron-vibrancy` package
is dead, NAN-era, won't build on Electron 43), so the split is CSS zones over
the material:

- rail → fully transparent (raw sidebar material),
- chat + preview panes → opaque `--bg` (tried translucent washes first; the
  content areas read better solid),
- Welcome screen (`.empty`) → light `--vib-main` `--bg` wash so an empty
  window still shows the material.

`createWindow` skips the opaque `backgroundColor` on darwin (it would paint
over the material — the nativeTheme re-apply skips the window there too);
`main.tsx` stamps `html.vibrancy` (main window only, never the prop-panel
island). Component fills (cards, modals, buttons, inputs) stay opaque. Theme
always follows the OS, so the material and the token palette can't disagree.

## 2026-07-09 — Rail: folder-icon projects + Cursor-style chat list (LKM-28)

Reworked the left rail's per-project display to match Cursor. Each project now
leads with a **folder icon** (`FolderOpen` when it's the active project,
`Folder` otherwise) in place of the old status dot. The active project expands
to a single **flat, left-aligned chat list** whose text lines up under the
project name (row left-padding = glyph + gap), replacing the two separate,
indented, dot-prefixed sub-lists (live-chat switcher + "previous agents").

- **One list, no dots.** Live/open chats come first (the active one gets a
  full-width highlight pill), then previous chats (persisted `SessionRecord`s),
  then any comment-spawn rows. The only remaining dot is the spawn status dot;
  chat rows carry no status badge (per the request).
- **Auto-named chats.** `chatTitle()` (store) derives a short name from a chat's
  opening user message — live chats read `useChat`'s first user message, past
  chats read `rec.transcript`'s. Empty chats fall back to "New chat".
- **Compact time.** `shortAgo()` (store) gives Cursor-style trailing labels
  ("3m", "2h", "5d", "4mo", "1y") on past-chat rows; live chats show none.
- Dropped the full active-item background (only the active chat is highlighted
  now) and the orphaned `.rail__dot` / `.rail__session*` / `.rail__spawn*` CSS.
  `test/history-ui.mjs` updated to the new `.rail__chat*` DOM.
## 2026-07-09 — Session-review modal: freeze-frame the preview; loads can't punch through
## 2026-07-09 — Modals freeze-frame the preview; loads can't punch through

Three sightings of the same seam (session-review modal ×2, feedback dialog).
(1) Opening a past chat while a project launch was still in flight: the modal
hid the native preview (drag-hide path), then the launch settled and
`preview:load`'s unconditional "recover from any leaked hide"
`setVisible(true)` painted the preview straight over the open modal — native
views always win over DOM. (2) Even without the race, reviewing a past chat
blanked the preview pane for as long as the modal was open. (3) The feedback
dialog (LKM-27) rendered partially under the preview.

- Main now tracks `previewHiddenByRenderer` (set by `preview:set-dragging`):
  `preview:load` still loads the URL but only unhides when NO renderer hide is
  active — the leaked-hide recovery survives for actual leaks. The flag clears
  in `resetStalePreview` (the overlay died with the old renderer document).
- The dropdowns' open-after-freeze logic moved to `store.ts` as
  `openWithPreviewFreeze`; the review modal AND the feedback dialog now use it:
  the preview stays visually in place as a snapshot `<img>` under the overlay
  instead of disappearing (or being covered), and the live view returns on
  close. Bonus: the feedback screenshot is captured after the freeze, so it now
  INCLUDES the preview (the native view is a separate target `capturePage`
  never saw — screenshots used to have a hole there).
- `test/history-ui.mjs` now asserts the contract from the main side (native view
  hidden under the modal, still hidden after a mid-modal `preview:load`,
  restored on close). Standalone tip: with the app open, standalone test runs
  need `DSGN_USER_DATA=$(mktemp -d)` — the running app holds the shared
  single-instance lock (the runner already isolates).

## 2026-07-09 — Survive sleep/crash: renderer recovery + full workspace/chat restore

Closing the laptop could kill the main renderer (Chromium reaps it around a
long sleep); the app either froze or — once reloaded — booted to the Welcome
screen with the OLD project's native preview still painted on top and every
chat apparently gone, even though main was still running the agent sessions
and dev server. Three layers of fix, in three commits:

1. **Main renderer recovery** (`main/index.ts`): reload on
   `render-process-gone`, repaint on `powerMonitor` resume, and hide/zero the
   preview `WebContentsView` on every main-frame `did-navigate` — PreviewPane's
   unmount cleanup never runs across a hard reload, so main must reset the
   stale view itself (page kept warm; `preview:load` re-claims it instantly).
2. **Reattach APIs** (`devserver.ts`, `agent.ts`, backends): `devserver:info`
   returns a running server's `RunningDevServer` (covers in-process static
   servers too) so a reattaching renderer recovers the URL instead of
   respawning on a new port; `agent:workspace-snapshot` returns every live
   project/chat with its in-memory record (a live session has no on-disk
   record — those are written only on close). Per-chat `isRunning` rides the
   ProviderSession contract's own terminal `done`/`error` event via
   `ctx.onEvent`, now wired in all three backends for every interactive session.
3. **Renderer restore** (`renderer/src/restore.ts`, store, App): `useWorkspace`
   `{projects, activeKey}` persists to localStorage (`dsgn:workspace`; the
   `?dsgnPanel=1` window never writes it). On boot, `restoreWorkspace` reattaches
   to whatever the snapshot says is live — rail rehydrated, each live chat
   seeded via `messagesFromTranscript` + `useChat.hydrate` (extended with an
   `isRunning` mode that opens a fresh streaming tail: the pre-reload buffered
   text only reaches the transcript on flush, so continuing deltas can't
   double-render), active project re-applied through `applyProject` with the
   preview URL from `devserver:info`. When main has nothing (real relaunch),
   the last dsgn-launched project reopens via `attempt()` and its newest
   resumable record is resumed with history seeded. Any failure falls back to
   Welcome.

Tests: `test/restore-reload.mjs` (electron tier — real reattach across a hard
`webContents.reload()`, seed/no-clobber/streaming-tail guards, dead-workspace
no-wedge). Because persisted workspace state now changes BOOT behavior, the
electron tier leaked state between tests (a prior test's project auto-reopened
in the next test's launch): `test/run.mjs` now gives each test its own
throwaway userData dir via the new `DSGN_USER_DATA` env override in
`main/index.ts` (also isolates the single-instance lock, so a killed run can't
block the next). Note: tests invoked directly (`node test/x.mjs`) still share
the real userData; the runner is the isolation boundary.

Also fixed in passing: `preview-location.mjs` was failing at HEAD~ already —
its renderer-side `window.api.agent.send = spy` silently no-ops because the
contextBridge freezes `window.api`; it now spies in MAIN by swapping the
`agent:send` handler via `app.evaluate` (and asserts on the last *user*
message, since submit opens an empty streaming-assistant placeholder).

## 2026-07-09 — Resume shows the past chat, not an empty tree — LKM-25

Resuming a "previous agent" (SessionReview's Resume) handed the SDK the
resumable session id so the model kept its context, but the renderer switched to
a brand-new, empty chat slice and never populated it from the record's
transcript — so the thread looked blank even though the agent "remembered."

The persisted `SessionRecord` already carries the full `transcript`
(`user`/`assistant`/`status` lines) and `resumeRecord` in `App.tsx` already has
the record in hand, so the fix is renderer-only (no IPC change):

- **store.ts:** new `messagesFromTranscript(transcript)` rebuilds `ChatMessage[]`
  from the flat transcript, regrouping each turn's assistant text + tool
  `status` lines into one assistant message with interleaved `segments` — the
  same shape the live stream builds via `startAssistant`/`appendDelta`/
  `appendStatus`. New `hydrate(key, messages)` action seeds a chat slice, but
  **only when it's empty** so it can never clobber a live chat.
- **App.tsx:** `resumeRecord` calls
  `hydrate(sessionKey, messagesFromTranscript(record.transcript))` before
  `setActiveChat`, so the resumed thread renders its history; new turns then
  append after it as usual.
- **Test:** `test/chat-render.mjs` gained a block that hydrates a slice from a
  sample transcript, asserts the grouping (2 user + 1 grouped assistant turn
  with text→tools→text segments and 2 statuses), renders it, and confirms
  re-hydration is a no-op on a populated slice. `messagesFromTranscript` is
  exposed as `window.__dsgnMessagesFromTranscript` for the harness.

## 2026-07-09 — In-app feedback button (files a GitHub issue) — LKM-27

A "Send feedback" affordance now files a GitHub issue on Praxis's OWN repo (the
app's git checkout, `app.getAppPath()` — same seam the self-updater uses), with
an optional screenshot and conversation transcript, each behind its own toggle.

- **Main:** `feedback.ts` registers `feedback:capture` (downscales a
  `webContents.capturePage()` of the app window to a ≤900px JPEG data URI) and
  `feedback:submit` (preflight git repo / origin / `gh`, then `gh issue create`).
  Wired in `index.ts` via `registerFeedbackIpc(() => mainWindow)`.
- **Body builder:** `src/shared/feedback-body.ts` (pure, unit-tested) assembles
  the issue title + body. GitHub gives no API to *attach* an image and caps issue
  bodies at 65536 chars, so an opted-in screenshot rides along as a base64
  data-URI inside a collapsed `<details>` (copy into a browser to view); any
  optional section that would blow the cap is dropped with a visible note while
  the feedback text always survives.
- **Renderer:** `FeedbackDialog.tsx` (shadcn Dialog) — textarea + two toggles;
  the screenshot is captured on open and previewed. Opened from a new previewbar
  icon button (always visible) and an empty-state "Send feedback" button via a
  tiny `useFeedback` store. Transcript comes from `formatConversation(messages)`.
- **Tests:** `test/feedback-body.mjs` (unit — title/body/limits) and
  `test/feedback-dialog.mjs` (electron — opens the dialog, asserts the toggles +
  send-button gating; never posts). Both registered in `test/run.mjs`.
## 2026-07-09 — Open vanilla HTML / static-site projects

Praxis previously refused any folder without a package.json (`detect()` threw
"No package.json found") and any package.json without a `dev`/`start` script.
Plain HTML/CSS/JS projects — the kind with no build tooling — were unopenable.

`detect()` now falls back to a new `framework: 'static'` when a folder has an
HTML entry (`index.html`, else the first `*.html`): either with no package.json
at all, or with a package.json whose framework is unrecognized *and* has no
dev/start script. A **recognized** framework (vite/next/…) without a dev script
still errors — its `index.html` is a build template that won't serve raw — so
the user is asked for a launch command. Both error messages now say "Enter a
command to launch this project", which the preview's existing error bar already
turns into a custom-command retry — so anything we can't auto-launch prompts for
the command (the second half of the task, already wired via `attempt(root, cmd)`).

Static sites are served by a new in-process `src/main/static-server.ts` (Node
`http.Server`, not a spawned child) so no external tool (`serve`, `python -m
http.server`) needs to be on PATH and we own the exact port. It resolves the
directory index, sets content-types, blocks path traversal, and injects a tiny
SSE live-reload snippet into served HTML + watches the tree — so agent edits
reflect in the preview the way a real dev server's HMR would (vanilla sites have
none). `devserver.ts` routes `framework:'static'` (with no command override) to
it, tracks the servers in a parallel `staticServers` map, and teaches
`stop`/`stopAll`/`isRunning` about them. New `test/static-serve.mjs` (electron
tier) covers detect→serve→assets→live-reload→traversal-block→stop.

## 2026-07-08 — Agent now knows the preview's current page

The preview's real location (link clicks, SPA route changes, initial load)
only ever lived in `PreviewUrl.tsx`'s local component state — it drove the
address bar but never reached the chat, so the agent had no idea what page it
was looking at. Added a global `usePreviewLocation` store (store.ts), wired
once in App.tsx to main's `preview:url-changed` (already emitted on every
`did-navigate`/`did-navigate-in-page`, one native preview view live at a
time). `ChatPanel`'s composer now prepends "The preview is currently showing
&lt;path&gt;." as hidden context on every send — same pattern as the selected-
element pill (`describeSelectionForPrompt`): the visible transcript still
shows only the user's own words. New test `test/preview-location.mjs`
(electron tier) covers the store plumbing and the composer's hidden prefix by
spying on `window.api.agent.send` (not frozen by contextBridge).

## 2026-07-08 — Preview body back to rounded (card border shows through)

Re-rounded the native preview view (DESKTOP_CORNER_RADIUS 0 → 15). Its corners
are genuinely transparent, so the card (a DOM rounded-rect with a 1px border)
shows through them as a clean rounded frame — the native view fills the body,
already 1px inside the card's border, at radius 15 (16px card − 1px). One real
DOM border, no masks/painting, so no doubling. App UI keeps its
-electron-corner-smoothing squircle; the native preview stays plain-round (CSS
smoothing can't reach a WebContentsView).

## 2026-07-08 — Revert corner experiments; square the preview body

Reverted the -electron-corner-smoothing + divider-removal + distinct-header
experiments (styles.css back to the standard border-bottom divider + all-rounded
corner-shape state). Then, per request, squared the preview's native view
(DESKTOP_CORNER_RADIUS 15 → 0): setBorderRadius is uniform, so a rounded body
also rounded the top under the header and revealed the card bg at the corners on
dark pages — square keeps it flush, with the header divider + card frame as the
container.

## 2026-07-08 — Electron corner smoothing (squircle); preview header divider

- Swapped the CSS `corner-shape: squircle` app-wide rule for Electron's native
  `-electron-corner-smoothing: system-ui` (iOS-style smoothing, nicer + cheaper;
  Chromium 150). Circles/pills are excluded (`-electron-corner-smoothing: 0%`)
  so the send button, spinner, status dots, and Tailwind rounded-full elements
  stay perfectly round. Verified: composer/card = system-ui, send button = 0%
  (renders a true circle).
- Preview header: dropped the previewbar's hard `border-bottom` divider. The
  header and body share the card surface (same var(--bg-subtle)); the preview
  content's rounded top edge is the visual separator now — no line, no notch.

## 2026-07-08 — Revert preview corners to all-rounded (drop the masks again)

The square-top + in-page bottom-mask approach reintroduced the doubled-corner
border it caused before, so it's reverted: the native view is rounded on all
four corners via setBorderRadius (uniform, clean border, no masks) as it was.
Electron's single-radius API means square-top/round-bottom isn't achievable
without the mask hack, and the doubling makes that not worth it. The toolbar
constant-height fix from the same commit is kept.

## 2026-07-08 — Preview: square top / rounded bottom; steady toolbar height

- The preview body's TOP corners are square (flush under the URL bar) again,
  bottom stays rounded to match the card: the native WebContentsView is square
  (setBorderRadius rounds all-or-none) and two in-page bottom-corner masks fake
  the rounding — restored from the earlier 3300c3c approach (color-only radial
  gradient, no border ring → no doubled-corner). DESKTOP_CORNER_RADIUS = 15
  (16px card − 1px border); masks track the OS theme via main's gutter color.
- Selection toolbar keeps a constant height (36px) when it morphs to the
  comment/annotate input: the submit button is 26px (was 28, matching the icon
  buttons) and the single-line input row is pinned to 18px line + 8px padding.

## 2026-07-08 — Electron 43 + squircle corners; toolbar refinements

- Electron 33 → 43.1.0 (Chromium 150, Node 24 main). patch-electron.mjs
  re-runs on install (note: the binary downloads lazily, so a first `bun add`
  may need one manual `node scripts/patch-electron.mjs`). Full UI suite green on
  43 after fixing one stale expectation (chat-render expected a gemini backend
  in the UI list; gemini is now a flag-gated main-only backend).
- corner-shape: squircle app-wide: a blanket `*,*::before,*::after` rule in
  styles.css (inert without a border-radius, so it only reshapes already-rounded
  elements) plus a `:host *` rule in the preview overlay's injected shadow style.
  Verified squircle renders (Chromium 150; CSS.supports true).
- Toolbar: props/delete hidden while the inline comment/annotate input is open;
  the divider now isolates Delete from the rest.

## 2026-07-08 — Toolbar morphs into the comment field (Figma Make-style)

- The selection toolbar is now a DARK pill (Figma-like) whose content MORPHS in
  place: comment/annotate are leading toggles; activating one expands an inline
  input + round submit inside the same pill (animated width), with
  props/code/delete persisting as trailing icons. Escape/toggle collapses back;
  a whole-page C/Y-mode click shows the same pill in input state at the clicked
  element. The old floating white composer bubble is deleted. IPC and test
  hooks unchanged (COMMENT payload, data-dsgn-composer on the pill,
  aria-label=Submit). Built by an Opus subagent from a frame-by-frame spec of
  the reference recording; verified independently (typecheck/build,
  select-element, comment-mode, smoke, code-drawer, before/after captures in
  test/artifacts/toolbar-state-{a,b}.png).

## 2026-07-07 — Public-repo doc cleanup

Prepping the repo to go public: removed personal-machine details from the
front-facing docs. README naming note no longer mentions the local clone dir
(just that `dsgn` is the original name living on in the code); clone URL now
points at the public `praxis` repo over https; "teammate" → "you"; fixed a
dangling "see the review doc" reference. CLAUDE.md header dropped "(repo:
dsgn)" and the repo/remote naming caveat. TASKS.md dropped the branch-cleanup
item (local git housekeeping referencing `~/.agent-runner/`) and reframed the
naming item as an optional rename. A `~/.git` setup aside in the log was
genericized. Grep-verified no `/Users/…`, agent-runner, or personal-infra
references remain in tracked docs (the leftover `~/.bun`/`~/.local` hits are
generic tool paths in code).

## 2026-07-07 — Cut CONTEXT.md; add a docs-drift guard

- Deleted `docs/CONTEXT.md`. Its three sections each duplicated something else
  (what-it-is → README/CLAUDE; rationale → PROGRESS; module map → CLAUDE's
  architecture block). Folded the genuinely-unique parts — the **Gotchas** and
  the non-obvious **why-it's-built-this-way** rationale — into CLAUDE.md, and
  retargeted the session-start ritual (was "read CONTEXT.md first") to
  PROGRESS + TASKS. docs/ is now DESIGN + PROGRESS + TASKS.
- **Anti-drift guard:** `test/docs-links.mjs` (new, unit tier → runs in CI)
  parses every anchored repo path referenced in CLAUDE.md + README.md and fails
  if any no longer exists. This is the check that would have caught the stale
  `PropEditor.tsx`/`TokenPalette.tsx` references. A reminder-hook was considered
  and rejected — a deterministic CI check has zero noise vs. a nag agents tune
  out. Verified: catches a bad path, 16/16 unit green.

## 2026-07-07 — Health/infra tasks: test runner, CI, Biome, gemini gate

Implemented the four safe/verifiable items from the review (the rest — harness
migration, god-file splits, naming decision — stay deferred in TASKS.md with
their reasons; branch cleanup needs a human call, see TASKS.md).

- **`test/run.mjs`** replaces the ~50-command `test`/`verify` `&&` chains:
  `node test/run.mjs unit|electron|live|all`, keep-going, exit-0=pass (incl.
  e2e self-SKIP), one build before the electron tier, summary table, non-zero
  on any failure. `test`=`unit electron`, `verify`=`all`; `test:*` aliases kept.
  Verified: `node test/run.mjs unit` → 15/15 green.
- **CI** — `.github/workflows/ci.yml` (typecheck + unit tier on push/PR; bun
  1.3.x). Electron/live tiers deferred to a macOS runner (noted inline).
- **Biome 2.5.2** dev dep + `biome.json` matched to the existing style; `lint`/
  `format` scripts. Repo-wide reformat intentionally deferred to its own commit.
- **Gemini gated** — `pickProvider` falls back to Claude unless
  `DSGN_EXPERIMENTAL_GEMINI=1`; banner in `gemini.ts`; removed from the renderer
  picker (was silently falling back to Claude when selected). Claude/Codex
  paths byte-identical. typecheck green; `provider-seam` now sets the flag.
- Docs: CLAUDE.md commands/test-convention updated to the runner + `lint`;
  fixed README + CLAUDE.md pointers to the (now-deleted) review doc.

## 2026-07-07 — Docs folder pruned to the live set

- Removed `TASKS-archive.md` (history git already holds), `PLAN-proactive-checks.md`
  (shipped as diag-rules.ts; reworded the one code comment that cited it), and
  `REVIEW-2026-07-07.md` (folded its live items into `TASKS.md`). docs/ is now
  CONTEXT + DESIGN + PROGRESS + TASKS.
- `TASKS.md` now carries the health/infra backlog with deferred items annotated
  (why each isn't safely auto-completable headless).

## 2026-07-07 — Repo health review + CLAUDE.md refresh

- Full review written to `docs/REVIEW-2026-07-07.md`: 9 ranked improvement
  items (finish the Praxis/dsgn naming decision, replace the package.json
  test mega-chains with a `test/run.mjs` runner, shared test harness, CI,
  lint/format tool, god-file splits, doc staleness fixes, gemini backend has
  no SDK dep, branch cleanup) plus a keep-doing-it list.
- CLAUDE.md rewritten: it still claimed "Plain CSS, no Tailwind" (inverted
  since 2026-06-26), listed 3 of ~27 main modules, and omitted the
  `src/preview/preload.ts` process boundary and the three test tiers. Now
  matches reality; typecheck + all 15 pure-bun tests were green at review time.
- Docs cleanup: removed two fully-shipped, code-unreferenced docs —
  `PLAN-direct-editing.md` (R1/F1/F3 all landed: rules.ts, worktrees.ts,
  edit-history.ts, spawn-comment/comment-mode tests) and
  `v7-multi-provider-design.md` (backends/ + provider-seam shipped). Kept
  `PLAN-proactive-checks.md` (diag-rules.ts still cites it) and
  `TASKS-archive.md` (active TASKS.md links it). Fixed CONTEXT.md staleness:
  header date, `PropEditor.tsx`→`PropPanel.tsx`, `TokenPalette.tsx`→
  `TokenOfferCard.tsx`.
- README rewritten: was "dsgn / working v1 + v2 first slice / Claude-powered";
  now Praxis, v9 state, multi-provider, four process boundaries, iOS sim,
  Tailwind+shadcn, three test tiers.

## 2026-07-04 — Preview self-heals when its dev server dies and comes back

- A dev server that dies mid-session (crash, external kill) left the preview
  permanently on Chromium's error page (black in dark mode): the HMR client
  reloads when its websocket drops, the load fails with CONNECTION_REFUSED, and
  the old retry budget (40 × 400ms ≈ 16s) ran out long before any restart —
  nothing ever re-navigated the view. Discovered the hard way: a session's
  lkmv.ch server was killed out from under a live preview (mistaken for a test
  leak), and the pane stayed black even after the server came back.
- Fix: `did-fail-load` no longer gives up after the budget — past 40 fast
  retries it settles into a slow 3s poll for as long as a previewUrl is set.
  Idle/placeholder views never poll (the handler only fires for the current
  previewUrl). Budget still resets on successful load.
- Verified with a live scenario: open fixture → kill its server + reload →
  error page for 25s (budget exhausted) → start replacement server on the same
  port → preview recovers within ~3s, no project reopen. Smoke, open-preview,
  ready-gating green.

## 2026-07-06 — Prop panel always-on (floating ⇄ docked); strip cleanup

- The PropPanel opens for EVERY selection now, not just schema-backed ones: a
  resolved schema shows the editable fields as before; otherwise the panel
  hosts the readiness message that used to sit in the composer strip (setup
  link for unstamped elements — .proppanel__link; owner jump —
  .proppanel__owner; prompt-only hint). Default layout is a FLOATING card at
  the preview's top right (auto height, max 65vh); a header toggle docks it as
  the full-height right sidebar. Mode persists (usePropPanelMode →
  localStorage). Both modes reserve the same native-preview inset strip — the
  native view always paints above DOM, floating "over" it is impossible.
- Composer strip: now a single aligned row (pill + source), the "No editable
  props…" hint removed (it lives in the panel).
- Composer placeholder: "Ask Praxis  (/ for skills)".
- Mobile viewport: scrollbars hidden inside the bezel (injected style with the
  frame) — phones don't show persistent scrollbars.
- Tests: ready-gating asserts the panel's readiness classes (the old "panel
  must NOT open for no-schema" flipped by design); select-element owner jump →
  .proppanel__owner.

## 2026-07-06 — In-preview selection toolbar; editable URL bar; device toggle

- The element actions moved from the composer strip into a floating toolbar
  ADJACENT to the selection inside the preview (preload-drawn, in the overlay's
  shadow tree): comment/annotate open the in-page composer directly on the
  element (composeKind now decouples an open composer from the armed mode);
  code/delete relay to the renderer over `dsgn:preview:toolbar-action`. The
  toolbar tracks scroll/resize, hides on HMR-detach, mode arming, select-off,
  and on the new `preview:clear-selected` (renderer drops selection → pill ×,
  send, delete). The composer strip keeps pill + source + readiness hint only.
- Preview bar: the URL is now shown in full and the part after the origin is
  editable in place (Enter navigates via preview.load — still guarded to
  localhost; Escape reverts). New `preview:url-changed` relay (did-navigate +
  did-navigate-in-page) keeps it tracking SPA routes/link clicks. Desktop/Mobile
  segmented control replaced with a single Figma-style MonitorSmartphone icon
  toggle (⌘1/⌘2 + Actions menu unchanged).
- Composer bottom row: select button sized to match the backend/model selects
  (`.iconbtn--sm`).
- Tests: select-element asserts the toolbar (all four actions) inside the
  preview page and that it hides when the pill clears; annotations drives the
  engine directly (UI path covered by comment-mode); code-drawer/code-peek open
  the drawer via its store; viewport-per-project is PORT-AGNOSTIC now (a live
  app session on 7777 must not fail the suite — reads the URL from the bar).

## 2026-07-07 — macOS materials; drawer navigation; assorted UX

- macOS vibrancy: the window is an NSVisualEffectView 'sidebar' material
  surface (vibrancy + transparent bg, darwin only). The rail is fully
  transparent (most vibrant); content surfaces (.pane--chat/.pane--preview/
  .empty, console) tint at 82% of var(--bg) via color-mix so the material
  reads subtly everywhere; elevated cards stay opaque. GOTCHA: the rail sits
  INSIDE .panes — painting .panes covers the material under the rail. On
  darwin the nativeTheme repaint must skip the window's background.
- Code drawer: Cmd+click a capitalized tag resolves through the file's imports
  ($lib/@/~ aliases + one barrel hop; works for .svelte/.vue via a text scan —
  the AST resolver is TSX-only) and opens that component; Cmd-hover underlines
  once a name is KNOWN to resolve (cached per file). Browser-style back/forward
  over a history stack in useCodeDrawer.
- Selection flow: S relays from the focused preview (preload → renderer, same
  toggle); a new pick resets island/drawer/in-page composer to just the
  toolbar; the toolbar gained an 'Edit props' action — the island opens
  explicitly now, never auto (usePropsIsland; owner-jump keeps it open).
- Launch status: window-top banner removed — a bottom-center pill INSIDE the
  preview (preload-drawn, re-armed across placeholder loads) when panes exist,
  or beside the corner cat on first open (no preview surface exists yet).
- Fixed: cat loader shrunk by a blanket 26px→20px replace meant for the
  sidebar toggle (which is now 20×20 with a 14px icon).

## 2026-07-06 — Island-only props (docked sidebar removed); hover un-sticks

- The docked-sidebar mode is GONE by decision: the props island is the only
  form. The header button now COLLAPSES it to a small chip (component name +
  sliders icon) instead of docking; collapse state lives in the island itself
  (it outlives selections) and persists via localStorage. The island reports
  width+height now (panel:size) and PanelHost hugs the view to the content —
  a transparent native view eats clicks, so a collapsed chip must shrink the
  whole view. usePropPanelMode / PanelAction 'dock' / the inset reservation
  are deleted; PropPanel is single-variant again.
- Tests that asserted panel DOM in the main renderer now query the ISLAND's
  webContents (panelEval/waitPanel helpers + expandPanel guard against a
  persisted collapsed state).
- Select mode: moving the cursor OUT of the preview clears the hover highlight
  (mouseout with relatedTarget null) — it used to stick on the last hovered
  element; selection outlines are unaffected.

## 2026-07-06 — Floating props island above the preview; persistent selection

- The floating prop panel now paints ON TOP of the live preview content. DOM
  can't do that (the native view always wins), so the island is a second
  WebContentsView stacked above the preview, booting the same renderer bundle
  with ?dsgnPanel=1 (renders just PropPanel on a transparent background). The
  main renderer (PanelHost) drives bounds/state over panel:* IPC, handles its
  actions, resizes to reported content height, and hides it under freeze
  overlays. Docked mode is unchanged: in-DOM sidebar + reserved preview inset.
  PropPanel gained variant='overlay'|'docked' + onToggleDock; the mode persists
  (usePropPanelMode). Tests asserting panel DOM dock it first
  (__dsgnPropPanelMode).
- Selection stays highlighted while hovering other elements: the preload keeps
  a dedicated selection layer — outlines on every element sharing the picked
  element's data-dsgn-source (loop/component instances) with an "h3 × 4" badge,
  independent of the hover box. Cleared with the toolbar (pill ×, send, mode
  arm, select-off); tracks scroll/resize/HMR relayout on the pin cadence.

## 2026-07-06 — Selection UX: composer pill + element actions (Figma Make-style)

- Preview bar's three mode buttons (select/comment/annotate) are gone. Element
  select now lives in the composer's bottom row (like Figma Make's Edit) — the
  button drives App's toggle through a new `useUiActions` registry store, so the
  simulator-vs-web routing stays in one place. S/C/Y shortcuts + the native menu
  item unchanged.
- Selecting an element puts a removable PILL in the composer (tag + ident + ×)
  with element-scoped actions beside it: Comment (detached parallel agent, same
  spawn flow as preview C-mode), Annotate (pin a note, no agent), Show code
  (editor drawer), Delete (agent turn). Comment/annotate share one inline
  textarea in the strip.
- The "Ask dsgn…" button and its visible "In the preview I selected the <p…>
  element (selector: …)" seeding are REMOVED: the element reference now rides
  along invisibly — ChatPanel's send() prepends `describeSelectionForPrompt` to
  the prompt for the model while the transcript shows only the user's words.
  The pill is consumed on send. Delete shows a short "Delete the <tag> element"
  user message with the same hidden context.
- Inspector.tsx rewritten as the strip (kept class names tests rely on:
  inspector__tag/__source/__ready/__link/__owner/__noteinput/__notesave/
  __codebtn). Tests updated: select-element (pill + clean composer instead of
  seeded text), annotations (Annotate icon instead of "Note" text button),
  comment-mode (arms via store — the same path as the C/Y shortcuts).

## 2026-07-04 — Preview corners: native setBorderRadius, corner-mask hack removed

- The desktop preview's bottom corners looked DOUBLED: the in-page corner masks
  (injected divs painting arcs over the previewed app) keyed their colors off
  `nativeTheme` (the OS appearance), but the app UI renders light regardless —
  on a dark-mode OS the masks painted `#111113`/`#2a2a2e` next to the card's
  light corner, drawing a second corner. Any color/geometry disagreement in
  that scheme doubles the corner by construction.
- Fix: deleted the whole mask path (main's `cornerRadius`/`cornerOpts`/
  `preview:set-corners` IPC + theme repaint, preload's `setCorners` injector,
  `api.setCorners`) and instead pass `radius: DESKTOP_CORNER_RADIUS` through
  `preview:set-bounds` → the existing native `view.setBorderRadius()` (the same
  path mobile's iPhone-screen rounding already used). All four corners round;
  the top ones show as a subtle inset under the card header — content-in-a-
  rounded-panel look, consistent with the bottom. Captures are square content
  now (no baked-in masks), and the freeze `<img>` radius matches.
- PR #63 was reverted wholesale first (its corner decisions were suspect), then
  its two still-valid fixes were re-applied on top of the new scheme: buildPins
  skips materializing the overlay host when there are no pins, and
  `preview:reset` zeroes frame/pins state (cornerRadius no longer exists).
- Verified: repro harness captured the composited window (screencapture of the
  window rect — the native view never shows in renderer screenshots) before/
  after; before shows the dark mask arc + square corner, after a single clean
  rounding. typecheck + smoke, open-preview, mobile-frame, viewport-per-project,
  select-element, annotations, comment-mode, ready-gating all green.
- Gotcha hit while testing: a leaked `vite dev --port 7777` from a previous app
  session made viewport-per-project time out (fixture landed on 7778). Check
  `lsof -iTCP:7777` before blaming a test.

## 2026-07-03 — LKM-20: Code opens the editor drawer; unified code colors

- **"Code" now opens the editor drawer directly** (right, under the preview) instead
  of an inline read-only peek in the left inspector. The Inspector's Code button
  toggles `useCodeDrawer` on the selected element's source; `CodePeek.tsx` is deleted
  (its `source:read` / `source:open-in-editor` engine in `props.ts` is unchanged and now
  drives the drawer).
- **Drawer gains the peek's affordances:** an **Editor** button (`source:open-in-editor`
  → the user's own editor) and an **Expand** toggle that grows the drawer while keeping a
  ~160px live-preview strip (measures its `.previewcard__body` container via
  ResizeObserver; grows the `usePanelInset.bottom` it reserves).
- **Unified colors:** the CodeMirror drawer is themed from the app's `--background`/
  `--foreground`/`--muted` tokens (so it matches the surrounding surfaces and flips with
  light/dark) with a `HighlightStyle` matched 1:1 to the styles.css highlight.js palette
  the markdown code blocks use. Previously the drawer used CodeMirror's default theme,
  which didn't match the (light) peek — the reported mismatch.
- Tests: `test/code-peek.mjs` UI section now asserts the Code button opens the drawer
  (no `.codepeek`) with Editor + Expand controls; `test/code-drawer.mjs` opens via the
  Code button (dropped the peek→Edit two-step). Both green; typecheck green.

## 2026-07-03 — Dock icon size fix: ship the layered (Assets.car) icon

- The dock icon rendered ~10% larger than neighboring apps. Cause: the iOS
  Icon Composer export is full-bleed (opaque edge-to-edge, no margins), and a
  legacy flat .icns is drawn at its canvas scale, while macOS 26 gives native
  layered icons the standard sizing treatment.
- Fix, two parts:
  - Compiled `dsgn.icon` (Icon Composer source in ~/Downloads/app-icon) with
    `xcrun actool --app-icon dsgn --platform macosx` → `build/Assets.car` +
    small-size renditions. `scripts/patch-electron.mjs` now also installs
    Assets.car into the dev Electron.app and sets `CFBundleIconName=dsgn`, so
    Tahoe renders the true layered icon (with dark/tinted variants).
  - Rebuilt `build/icon.png`/`icon.icns` on the macOS grid: plate scaled to
    204/256 of the canvas + transparent margins + soft shadow (geometry measured
    from actool's own 256px render; 512/1024 synthesized from the 1024 iOS
    export with sharp, small sizes taken from actool's output).
- Removed `app.dock.setIcon()` — runtime dock images skip the system icon
  treatment; the bundle's icon (patched in by postinstall) is the right path.
- Verified via `NSRunningApplication.icon` (what the Dock shows for a running
  app): our plate is 206×206@(25,25) in 256 — pixel-identical geometry to
  Music.app. Typecheck + smoke green.

## 2026-07-03 — Real app icon + dev Electron.app rebrand

- **Real icon artwork**: replaced the placeholder `build/icon.png` with the
  pixel-cat icon from the design's Icon Composer exports
  (`Icon-iOS-Default-1024x1024@1x.png`); generated `build/icon.icns` from it
  (sips + iconutil, all sizes). Deleted `scripts/make-placeholder-icon.mjs`.
- **Dev menu bar said "Electron"**: on macOS the app-menu title, Cmd-Tab entry,
  and Activity Monitor name come from Electron.app's own Info.plist —
  `app.setName()` cannot change them in dev. Since dsgn ships as source and runs
  via `bun run dev`, added `scripts/patch-electron.mjs` (postinstall): sets
  CFBundleName/CFBundleDisplayName to Praxis in
  `node_modules/electron/dist/Electron.app`, swaps `electron.icns` for ours, and
  ad-hoc re-signs the bundle (editing a signed bundle breaks its seal; unsigned
  apps get killed on arm64). Idempotent; darwin-only; re-runs on every install
  since `bun install` restores stock Electron. Bundle id stays
  `com.github.Electron` on purpose — changing it would reset TCC permission
  grants (screen recording etc.) for the dev app.
- Verified: typecheck + smoke green after the re-sign; live launch shows
  LSDisplayName "Praxis" and a menu-bar screenshot confirms the app menu reads
  Praxis.

## 2026-07-03 — Branding + File menu (Praxis)

- Renamed the app Electron → **Praxis**: `app.setName('Praxis')` at main module
  load (drives the macOS app-menu label + About panel), window `title`, renderer
  `<title>`, and `productName` in package.json (for eventual packaging).
- **App icon**: `build/icon.png` loaded via `nativeImage`; set as the dev dock
  icon (`app.dock.setIcon`, macOS) and the `BrowserWindow` `icon` (Win/Linux),
  both guarded on `!isEmpty()` so a missing file degrades gracefully. NOTE: the
  committed PNG is a generated placeholder (`scripts/make-placeholder-icon.mjs`) —
  the real artwork from the design's app-icon.zip couldn't be fetched in the
  sandboxed runner (no network); drop it in at `build/icon.png` to replace it.
- **File menu**: new top-level File menu with New Project (Cmd+N) / Open Project
  (Cmd+O) — moved out of the Actions menu — plus **Open Recent**, a submenu of up
  to 8 recents + Clear Menu. Recents live in the renderer store (localStorage); it
  pushes them to main over `menu:set-recents`, main rebuilds the native submenu,
  and a chosen recent comes back over `menu:open-recent` (reopens keeping the
  current project warm). `test/menu-recents.mjs` asserts the rename + menu.
  (Playwright's Electron launch can't complete its handshake in this worktree
  runner — the pre-existing smoke test times out identically — but the built main
  boots and runs without crashing; typecheck + build are green.)

## 2026-07-03 — Dev-mode Chrome DevTools (CDP endpoint)

`bun run dev` now passes `--remote-debugging-port` (9222; `DSGN_DEBUG_PORT`
overrides), gated on `ELECTRON_RENDERER_URL` so a built/packaged app never opens
it. Real Chrome attaches full DevTools (Elements/Console/Network/Sources/
Performance) to both the chat window and the preview `WebContentsView` via
`chrome://inspect`. Verified live: dev app answers `:9222/json` (~5s after
launch); built app booted and the port stayed closed across 10s of retries;
full `bun run verify` green. Nuance: the preview target only appears after a
project is open (`ensurePreviewView` is lazy — first `preview:set-bounds`).
Gotcha + Chrome 111+ `remote-allow-origins` note added to CONTEXT.md.

## 2026-07-02 — v9 Phase 2: editable code drawer (user-requested)

Finished the in-tool code view — Phase 1 let you *look* at the inspected element's
source; Phase 2 lets you *edit* it without leaving dsgn. A CodeMirror 6 drawer
docks under the preview; saving routes through the same `commitEdit` seam as every
other direct edit, so undo/redo, on-disk conflict detection, and HMR all come free.

Also **cleaned up `docs/TASKS.md`** first (user request): shipped milestones (v2–v8)
moved to a new `docs/TASKS-archive.md`; the open v7 (multi-provider), v6 leftovers,
deferred Svelte, and blocked polish items were **dropped** and recorded in the
archive's "Dropped" section so they aren't silently forgotten. TASKS.md is now just v9.

- **Geometry** (`PreviewPane.tsx` + `usePanelInset`): a DOM panel can't float over
  the native `WebContentsView`, so the drawer reserves space instead. `usePanelInset`
  gained a `bottom` value alongside the existing right-edge `inset` (PropPanel); the
  pane now shrinks the native view's HEIGHT by `bottom` (`availH`), and the drawer —
  absolutely positioned at the bottom of `previewcard__body` — fills the freed strip.
  Both desktop and mobile (bezel) paths honor it.
- **Save seam** (`props.ts`): `source:write(root, source, baseline, content)` →
  refuses if the on-disk content drifted from the `baseline` the drawer loaded
  (conflict, same contract as undo/redo), else `commitEdit` (write + history entry).
  `SourceWriteResult` in `shared/api.ts`; preload + IPC wired.
- **UI**: `CodeDrawer.tsx` — CM6 built imperatively (`basicSetup` + lang-javascript/
  html/css, light default highlight to match the app), the stamp's line span marked
  via a mapped `StateField` decoration (`.cm-stamp-line`), scrolled to the element,
  `⌘S`/Save (dirty-gated) → `source:write`, conflict banner with Reload, close
  releases the inset. Opened from a new "Edit" ⤢ button in the `CodePeek` header;
  `useCodeDrawer` store holds the open source; closes on project switch (stale-root
  guard).
- **Dep**: added `codemirror` + `@codemirror/lang-{javascript,html,css}` (renderer is
  ESM). Trialed `@codemirror/theme-one-dark` but removed it — basicSetup's light
  default highlight fits the light app better.
- **Test**: `test/code-drawer.mjs` — engine (conflict guard, whole-file save writes +
  records undo, second stale save re-conflicts, `edits.undo` reverts) + UI (peek
  "Edit" → CM mounts, stamp highlighted, bottom inset reserved, close releases it);
  mutates the fixture then restores it. In `test`/`verify` as `test:codedrawer`;
  screenshot `13-code-drawer.png`. Full `verify` green (one unrelated flake: a stale
  node process holding port 7777 failed `viewport-per-project` until killed).
- **Known limit**: with the floating PropPanel (right strip) also open, it overlaps
  the drawer's top-right in a narrow window — the two insets are mutually unaware.

## 2026-07-03 — Inspector code peek + "open in editor" (user-requested)

The user kept alt-tabbing to an editor just to *look at* the code of the element
they were inspecting. Phase 1 of the in-tool code view: a read-only, syntax-
highlighted peek of the stamped source file right in the Inspector, plus a
one-click jump to the user's real editor. (Phase 2 — an editable CodeMirror
drawer under the preview with saves routed through `commitEdit` — is on TASKS.)

- **Engine** (`props.ts`): `source:read` IPC → `SourceView` (`shared/api.ts`):
  the whole file (context stays visible) + the stamp line + the element's full
  open→close **line span**, resolved by the same `findElementAtLine` +
  enclosing-`JSXElement` walk `applyTextEdit` uses. Svelte/unparsable files fall
  back to the stamp line alone. `resolveSource` keeps root-escape stamps out.
- **Open in editor** (`source:open-in-editor`): tries `code -g`/`cursor -g`/
  `zed`/`subl` with a `file:line:col` jump target (a missing CLI ENOENTs fast →
  next), then falls back to `shell.openPath` (OS default app, no jump). Fails
  soft with a message — never throws at the renderer.
- **UI**: `CodePeek.tsx` — a "Code" toggle in the Inspector's action row reveals
  the file: highlight.js (new direct dep; already in the tree via
  rehype-highlight, and it reuses the existing `.hljs-*` theme in styles.css),
  a line-number gutter, the element's span marked with a bar, auto-scrolled so
  the stamp sits a third down the viewport. Header shows `path:line` + an
  "Editor" jump button. Fixed 18px line height keeps the gutter/mark/scroll
  math honest; the whole-file render is one `<code>` block (no per-line hljs
  splitting, which breaks on multi-line tokens) with the span drawn as an
  absolutely-positioned bar behind the text.
- **Test**: `test/code-peek.mjs` — engine (file + spans incl. a new multi-line
  fixture element, root-escape refused, openInEditor soft-fail) + UI (toggle →
  highlighted peek, gutter, `data-stamp-line`, auto-scroll) + screenshot
  `12-code-peek.png`. In `test`/`verify` chains as `test:codepeek`.
- **Caveat**: developed in a sandboxed environment where the Electron binary
  can't download (GitHub releases blocked) — `typecheck`, `build`, and all pure
  bun tests are green here; run `bun run verify` locally to exercise the
  Electron suite including the new test.
## 2026-07-02 — provider-seam: don't depend on real CLIs being absent

`test/provider-seam.mjs` asserted the codex/gemini backends fail soft "when the
CLI is absent" — but on dev machines the CLIs can resolve: a user-installed
`gemini` (~/.bun/bin), and the `codex` shim that `bun run` puts on PATH via the
repo's `node_modules/.bin` (from `@openai/codex-sdk`). Then the probe/spawn
succeeds, a real (unauthenticated) turn spins on 401 retries, and the test —
and `bun run verify` — fails. (Standalone `node test/provider-seam.mjs` passed
because plain `node` doesn't prepend `node_modules/.bin`, which made it look flaky.)

- `backends/codex.ts` / `backends/gemini.ts`: CLI binary is overridable via
  `DSGN_CODEX_BIN` / `DSGN_GEMINI_BIN` (default unchanged: `codex` / `gemini`).
- `test/provider-seam.mjs`: launches Electron with both vars pointed at
  nonexistent paths, so the fail-soft assertions hold regardless of what's
  installed; codex `done` assertion now dumps the event stream on failure.

## 2026-07-02 — Viewport (Desktop/Mobile) is now per-project

User report: pick Mobile on one project, open/switch to another → it's Mobile
too. `useViewport` was a single global store, so the toggle leaked across
projects.

- `ProjectEntry.viewport` added to the workspace snapshot (like url/branch):
  `setViewport` writes through to the ACTIVE entry; `applyProject` (rail
  switch) restores the target's own viewport right after `activate` (ordering
  matters — the write-back must land on the incoming entry, not the outgoing);
  `attempt()` sets it after `openOrActivate`, so a fresh open starts at
  desktop and a re-open keeps that project's choice.
- New test `viewport-per-project.mjs` (in `verify`): A→mobile, open B (must be
  desktop), switch A (mobile restored), switch B (desktop kept).

## 2026-07-02 — Fix: doubled/misaligned iPhone bezel in mobile preview

User report: open a project in mobile viewport, open a NEXT project → two
iPhone frames, misaligned. The switch was a red herring — the trigger is the
second project's own CSS. The bezel is an `<img>` injected INTO the previewed
page (so its opaque edge can mask the app's screen corners), which means the
page's stylesheets apply to it: a standard reset like Tailwind preflight's
`img { max-width: 100% }` clamped the upscaled frame (383px) back to the
viewport width (348px), pulling the whole bezel into view as a second squeezed
phone over the app, offset from the renderer's DOM bezel behind it. Projects
without such a reset (like the first one opened) never showed it.

- Fix in `src/preview/preload.ts`: pin the injected frame's geometry against
  page CSS — `max/min-width/height`, `margin/padding/border/transform` locked
  inline with `!important` (an inline `width` alone loses to a stylesheet
  `max-width`), and `positionFrame()` now sets its metrics via
  `setProperty(..., 'important')`. Same hardening for the desktop bottom-corner
  masks (same injected-overlay-vs-page-CSS class of bug).
- New regression test `test/mobile-frame.mjs` (in `verify`): serves a fixture
  WITH the img reset, switches to mobile, and asserts the injected frame
  overflows the viewport on all sides (verified it fails on the pre-fix build).
- Diagnosis harness insight: renderer screenshots can't show this (the native
  view isn't in the DOM) — measure the injected img's rect inside the preview's
  webContents via `executeJavaScript` instead.

User report: an RN/Expo project previews fine, but taps/scrolls do nothing and
Select never picks anything. Two independent bugs, both invisible because every
error on the interaction path was swallowed:

- **`--udid` arg order (the primary bug):** `idbController` invoked
  `idb --udid <udid> ui tap x y` — idb's argparse rejects `--udid` before the
  root command, so **every tap/swipe/text had always failed** with a usage error
  (which only sim-e2e-style live runs could catch; the recording test bridge
  never exercises real idb). The flag must FOLLOW the subcommand:
  `ui tap --udid <udid> x y` (the hit-test path already did this — that's why
  `describe-point` worked while taps didn't). Extracted a pure exported
  `idbUiArgs()` builder and locked the order in `sim-control.mjs`.
- **Stale idb_companion wedges idb (env + resilience):** an `idb_companion`
  that outlives the simulator boot it attached to fails every command with
  "Mach port not connected" — and idb often still **exits 0**, printing the
  error to stderr, so exit-code checks miss it. Meanwhile `simctl` screenshots
  keep streaming → the preview looks alive but ignores input. New: stale-marker
  detection in `idbExec` (stderr scan, `IDB_STALE_RE`), auto-recovery
  (`recoverIdb`: pkill companions + wipe `/tmp/idb`, idb's hardcoded state dir)
  with one retry, and an `idbHealthy()` gate at `start()` (a stale companion
  reports `state: "Shutdown"` for a booted device) so interaction is only
  enabled when idb can actually drive the device — with a clear view-only log
  line when it can't.
- **Feedback instead of silence:** a failed `/control` command now flashes a
  hint on the bridge page (was: ignored response); a select-tap hit-test error
  logs to the simulator log (was: `.catch(() => {})`); and an **unstamped**
  element pick now still surfaces in the Inspector as `source: null` → the
  "project isn't set up" note + setup offer (was: tap did nothing), so a
  third-party Expo app without the RN Babel stamp gets a signposted path
  instead of a dead click. `SimPick.source` is `string | null` now
  (`shared/api.ts` updated to match).

**Verified end-to-end on a real Expo app** (`expo-animations-gallery`) via a live
boot: "idb detected" log → `/control` tap `{ok:true}` → select-mode tap routed as
pick → renderer received `{source:null, tag:"Button"}`. Suite: typecheck + all
sim/select/smoke tests green. Known-unrelated failure: `provider-seam.mjs` now
fails on this machine because a real `gemini` CLI is installed (the test assumes
it absent) — spun off as a separate task.

## 2026-07-01 — Chat: interface for agent questions (AskUserQuestion)

The agent could edit and ask for tool permission, but it had no way to ask the
*user* a clarifying question ("which layout?", "which sections?"). Wired the Claude
Agent SDK's built-in **AskUserQuestion** tool through to an interactive
multiple-choice card in the chat.

- **New event contract** (`shared/api.ts`): `QuestionSpec`/`QuestionOption`/
  `QuestionRequest` + `QuestionAnswers`; `AgentEvent` gains `question-request` and
  `question-resolved` (mirroring the permission pair); `DsgnApi.agent.respondQuestion`.
- **Backend interception** (`backends/claude.ts`): `canUseTool` catches
  `AskUserQuestion` **before** the permission machinery (so it never shows an
  approve/deny card), parses the loosely-typed input into `QuestionSpec[]`, emits
  `question-request`, and awaits the user's picks in a per-session `pendingQuestions`
  map (added to the `ProviderSession` seam, optional so non-Claude backends can skip
  it). The answer is fed back as the tool result by **denying with the answer as the
  message** — in headless SDK mode there's no built-in interactive prompt to run, so
  intercepting here keeps the whole exchange under dsgn's control; the message is
  phrased as an answer so the model continues with the choice in hand. Aborts/teardown
  release open questions (dismiss) so the SDK callback always unblocks.
- **IPC** (`agent.ts`): `agent:respond-question` settles the awaiting callback;
  `interrupt` + `closeSession` release any unanswered questions.
- **Renderer**: `useQuestions` store (pending queue, deduped by id, cleared on project
  switch — like `usePermissions`); `QuestionCards.tsx` renders each question with a
  header chip, the question, option buttons (label + description), an always-available
  free-text **Other…**, and **Skip**/**Send**. Single single-select questions submit on
  click; multi-select / multi-question requests collect picks then Send. App routes the
  question events (alongside the permission events); ChatPanel renders the cards above
  the composer.
- **Test**: `test/questions.mjs` (store-driven, no creds) — single-select auto-submit,
  multi-select + Send, Skip, and a `question-resolved` event clearing an open card. Added
  to `verify`. Full credential-independent suite green (`10-question-card.png`). The live
  canUseTool round-trip rides `agent-e2e` (gated on `claude login`).

## 2026-06-27 — v7: Codex backend made real (solo prep; live verify gated on `codex login`)

Took `backends/codex.ts` from a speculative stub (shape-guessing against docs, non-literal
import so it built without the package) to a real adapter against the installed SDK.

- **`@openai/codex-sdk@0.142.3`** added as a real dependency. ESM-only, so loaded via a
  dynamic `import()` and externalized by electron-vite (verified `import("@openai/codex-sdk")`
  survives in the CJS main bundle) — same pattern as the Claude SDK.
- **Rewrote against the REAL typed API** (read `dist/index.d.ts`): `new Codex().startThread(
  ThreadOptions)` → `Thread.runStreamed(input, { signal }) → { events: AsyncGenerator<ThreadEvent> }`.
  Mapping: `item.{started,updated,completed}` with `agent_message` → streaming deltas (per-item
  suffix diff); `file_change` → status + `cap.noteTool('Edit', {file_path})` (→ filesTouched);
  `command_execution`/`web_search`/`mcp_tool_call`/`reasoning` → status lines; `turn.failed`/
  `error` → error. `interrupt` wired via a per-turn AbortController; `shutdown` aborts + flags.
  `model`/`effort` honored via ThreadOptions; headless `approvalPolicy:'never'` + `sandboxMode:
  'workspace-write'`.
- **Fast preflight**: `codex --version` up front → a missing/unauthed CLI fails soft instantly
  with an "install + `codex login`" message, instead of a slow mid-turn spawn ENOENT.
- **Fixed a real multi-provider UX bug**: a non-Claude auth error used to render "⚠️ Not connected
  to Claude" and raise the Claude-specific onboarding banner (setup-token). Now the Claude note +
  banner are gated to `provider === 'claude'`; Codex/Gemini show their own descriptive error.
- **Tests**: `test/codex-e2e.mjs` (mirrors agent-e2e on the codex backend; SKIPs cleanly until
  the user runs `codex login`, then proves the live event mapping). `provider-seam.mjs` hardened
  to poll for `done` (the preflight subprocess made the old fixed-sleep flaky under load). Full
  verify green: 43 OK, codex-e2e + sim-e2e SKIP (gated).
- **Remaining (needs the user):** `codex login`, then codex-e2e verifies live; Codex tool-approval
  → permission-card mapping (deferred — no approval-request event in the SDK stream).

## 2026-06-27 — v6 stretch: collapsible tool-step disclosure (AI Elements Task pattern)

A long agent turn used to render its tool-use statuses as a flat list that pushed the
actual answer down the panel. Now each assistant message's steps collapse into a
`StepDisclosure` — the AI-Elements Task/Reasoning pattern, built on the **already-vendored
shadcn `Collapsible`** (no new Radix dep): collapsed shows the latest step + a count
(`› Edit · src/components/Hero.tsx · 2 steps`), expandable to the full list. It auto-opens
while the turn is live (watch progress), auto-collapses when it finishes, and respects a
manual toggle in between. Tests only read `statuses` from the store (not the status DOM),
so the restructure was safe; `chat-render.mjs` gains a collapse→expand assertion. Picked
this over the shadcn-Select picker conversion (which would need a new Radix dep + flaky
portal-based test interaction for modest polish). Full verify green.

## 2026-06-27 — v8 F1 Phase 3: per-repo cap + FIFO queue + interrupt (F1 complete)

The "N parallel agents never wedge or leak" hardening — completes F1 and v8.

- **Cap + queue** (`agent.ts`): `MAX_SPAWNS_PER_REPO = 3`. A spawn over the cap is pushed
  to a FIFO `spawnQueue` (returns `{queued:true}`); `pumpQueue(parentKey)` runs on each
  `finalizeSpawn` and starts the next queued spawn as a slot frees. The spawn id is
  assigned UP FRONT so the rail row is stable across the queued→running flip; a
  `spawn-started` event carries the branch when a queued spawn actually starts.
  `startSpawn` is the shared create-worktree-+-start path (immediate and dequeued),
  reclaiming the worktree + pumping the queue on any failure.
- **Interrupt** (`agent:spawn-interrupt`): cancels a running spawn (`session.interrupt()` →
  done → finalize commits whatever it did) or drops a still-queued one. Surfaced as a ×
  on each rail working/queued row.
- **Already landed in the F1 review fixes:** startup orphan-prune (open-project) and
  before-quit-leave-for-prune (no work lost), so Phase 3's leak/recovery items were done.
- Renderer: `useSpawns` gains `queued` status + a `start()` transition; ChatPanel handles
  `spawn-started`; App sets the initial status from `queued`; Rail shows a grey queued dot
  + the interrupt ×. `spawn-comment.mjs` covers the queued→running→removed lifecycle.
- **v8 is now complete:** R1, F3a, F3b, F2, F1 (all 4 phases) shipped. Deferred niceties:
  per-spawn Bash allowlist, a rich ConflictPanel, non-Claude spawn backends.

## 2026-06-27 — v8 F1 Phase 2: Apply / PR / Discard a finished comment spawn

Closes the loop — a spawn's work, previously stranded on its `dsgn/comment-<id>` branch,
now reaches the preview.

- `worktrees.ts`: `branchPatch(repoRoot, branch)` = `<branch>^..<branch>` (the spawn's
  single commit — exactly its edits, not the WIP base), plus `deleteBranch` / `branchExists`.
- `agent.ts`: `agent:spawn-apply` (patch the branch diff onto the LIVE tree via the same
  `applyToWorkingTree` — plain apply, `--3way` fallback, conflict reported), `agent:
  spawn-discard` (delete the branch), `agent:spawn-pr` (push + `gh pr create --head <branch>`
  with origin/gh preflight; persists prUrl onto the history record).
- `SessionReview` gains an action bar for `kind:'comment'` records: **Apply** (preview HMRs
  the change), **Open PR**, **Discard** (deletes branch + drops the record). Conflicts/errors
  surface as a colored note. (Rich ConflictPanel deferred — a status note for now.)
- `spawn-comment.mjs` adds a deterministic Apply/Discard round-trip (hand-built branch, no
  model): apply lands the edit on the live tree, discard deletes the branch. Full verify green.

## 2026-06-27 — v8 F1 (phases 0+1): comment → parallel agent in its own git worktree

**Contention decided by a design judge-panel** (3 models architected against the real
seam, scored on correctness/effort/UX): **worktree-per-spawn** won (7.33) over advisory
conflict-detection (7.0) and a serialized write-lock (5.33). Each comment-spawned agent
runs in its OWN `git worktree` on a `dsgn/comment-<id>` branch — a private checkout
sharing the object store — so N comments edit the repo in true parallel with zero
cross-writes. The judges' correctness flag (merging a spawn branch back fails against the
main agent's uncommitted WIP) is fixed by patch-applying the spawn's diff onto the live
tree (`git apply`/`--3way`), not `git merge`.

- **Phase 0 — `src/main/worktrees.ts`** (pure git, the de-risking crux): createWorktree
  forks off the live tree's CURRENT state including WIP (via `git stash create`, no side
  effects); commitWorktree returns git's authoritative file list; diffWorktree
  (`--full-index --binary`); applyToWorkingTree (plain apply, `--3way` fallback, conflict
  detection — NOT `git merge`); removeWorktree + pruneOrphans (crash recovery), never
  throw. `test/worktrees.mjs` proves isolation, WIP-preserving fork, apply-onto-dirty-tree.
- **Phase 1 — the spawn slice.** `SpawnContext` added to the backend seam (claude.ts
  threads `emitKey`/`sessionId`/`onEvent`); a spawn files its events + history under the
  PARENT project key but stamps `sessionId`. `agent.ts` gets a separate `spawns` map
  (never touches `activeKey`), `agent:spawn-comment` (bypassPermissions — headless, no
  card UI; creates a worktree, starts a detached session), and `finalizeSpawn` (closeSession
  → persist under parent → commitWorktree → save git file-list → removeWorktree keeping the
  branch → emit `spawn-finished`). Renderer: `useSpawns` store, `App.onComment` dispatches
  a spawn (falls back to seeding chat for non-repos), `ChatPanel.onEvent` drops any
  `sessionId` event before the chat router (the byte-clean-main-stream guarantee) and on
  `spawn-finished` reloads history, `Rail` shows a pulsing working row that becomes a
  previous-agent on finish.
- **Tests:** `test/spawn-comment.mjs` — deterministic (non-repo fallback; a `sessionId`
  delta proven NOT to enter the active chat; row add→spawn-finished→remove) PLUS a LIVE
  spawn that had a real Claude agent edit a temp git repo in its own worktree and commit to
  a `dsgn/comment-<id>` branch with main untouched. Full `verify` green (live spawn +
  AGENT-E2E both ran).
- **Adversarial review (4-dimension workflow, each finding verified) → 10 confirmed,
  all fixed before merge:**
  - `git stash create` silently drops UNTRACKED files — a spawn would fork from a base
    missing brand-new files the interactive agent just created. Replaced with a
    throwaway-index `captureBase` (read-tree HEAD → add -A → write-tree → commit-tree)
    that snapshots tracked + untracked WIP.
  - `App.tsx`'s second `onEvent` listener lacked the `sessionId` guard → a spawn's init
    `commands` overwrote the active slash menu and its auth error raised the onboarding
    banner. Guarded (main broadcasts to both listeners).
  - A spawn whose `startSession` threw (SDK load / not logged in) leaked its worktree
    (created before the `spawns.set`) → now reclaimed in a catch.
  - `pruneOrphans` was written + tested but never CALLED → wired at open-project (skips
    ids of spawns live this session so it can't reap an active checkout).
  - `before-quit` did `removeWorktree` fire-and-forget → discarded uncommitted work and
    raced exit. Now just stops the subprocess; next launch's pruneOrphans commits the
    dirty leftover to its branch and reclaims it.
  - bypassPermissions skips the `canUseTool` sidecar deny, and `.dsgn/` isn't gitignored
    → a spawn could land sidecar writes on the live tree via Apply. `commitWorktree` now
    unstages `.dsgn` so it never reaches the branch/patch. (Bash allowlist still deferred.)
  - `git worktree add` races on shared admin state → `createWorktree` serialized behind
    an in-process chain.
- **Deferred to F1 phases 2–3:** Apply/PR/Discard on a finished row (+ ConflictPanel),
  per-repo cap + queue, before-quit finalize hardening, per-spawn Bash allowlist,
  non-Claude backends. The spawn's edits currently live on the branch (reviewable via the
  existing transcript path); reaching the live preview is Phase 2.

## 2026-06-27 — v8 F2: broaden direct editing (schema defaults + reset-to-default)

- **Scoped first** (Explore agent): the literal-recognition set in `props.ts` is already
  broad — expression-container literals (`count={3}`, `active={true}`), TS casts, no-sub
  template literals, unary minus all read as clean literals; genuine expressions (handlers,
  member/array/object) correctly route to chat. So F2 wasn't "recognize more literals" —
  the gaps were **no schema defaults** and **no removal/reset**.
- **Schema defaults**: `docgenPropToField` now parses react-docgen's `defaultValue` source
  string into a typed `PropField.default` (handles `'brand'` / `3` / `false`, drops
  computed/ill-typed). The panel shows `default: X` per field. (react-docgen does extract
  destructuring defaults like `{ tone = 'brand' }` for function components — confirmed live.)
- **Reset-to-default**: new `props.remove(root, source, name)` IPC → `removeProp` (React) /
  `removeSvelteProp` (Svelte) deletes the attribute from source, collapsing one run of
  adjacent whitespace so nothing dangles. Routes through `commitEdit`, so a reset is
  reversible with Cmd+Z (F3b). An already-absent prop is a no-op success.
- **UI**: PropPanel shows a `reset` link only for props actually present on the element and
  **not required** (removing a required prop would break the component) — verified in the
  10-prop-editor.png artifact (variant*/label* have no reset; count/rounded do).
- Tests: `prop-edit.mjs` gains a `Chip` destructuring-default fixture (default extraction +
  reset→remove→undo + absent-prop no-op); `prop-edit-svelte.mjs` gains a `.svelte`
  reset→remove→undo. Full `verify` green (live AGENT-E2E passed).

## 2026-06-27 — v8 F3b: undo/redo for ALL direct dsgn source edits

- New `src/main/edit-history.ts` — the reversible-edit engine. Every direct apply path
  now routes through a shared `commitEdit(root, file, before, after, key)` (in props.ts,
  imported by props-svelte.ts): it writes, then `recordEdit`s the before/after. Covers
  React + Svelte props, inline text, and token swaps (T1/T2/T3) — not just the new panel.
- **Coalescing**: rapid edits of the same target (`source:prop` / `:text` / `:token`)
  within 500ms collapse to one undo step (a slider drag isn't 30 Cmd+Zs), keeping the
  original `before` so one undo reverts the whole burst.
- **Conflict guard**: undo/redo read the file's CURRENT content and refuse to write if it
  diverged from what we last wrote (the user edited it in their own editor) — surfaced in
  the renderer as a status error, never a silent clobber.
- **Per-project-root stacks**: the v5-C rail keeps several projects open, so history is
  keyed by root — Cmd+Z in project B never reverts a file in project A. Cleared on
  `agent:close-project`.
- IPC `edit:undo/redo/can` (root-scoped) → preload `window.api.edits` → renderer global
  keydown (Cmd+Z / Cmd+Shift+Z / Cmd+Y), skipped while typing in a field; re-inspects the
  selected element after a revert so the panel reflects the new source.
- Tests: `test/edit-history.mjs` (unit — record/coalesce/undo/redo/conflict/root-scope) +
  an apply→undo→redo→conflict round-trip appended to `test/prop-edit.mjs`. Full `verify`
  green (live AGENT-E2E passed; SIM-E2E skipped, no Xcode).

## 2026-06-27 — three stacked features: v5-D history UI, inspector→shadcn, direct prop/token edit

Built as stacked PRs off main (#28 → #31 → #32); each its own full `verify` + a
multi-agent adversarial review with fixes applied. Designed via a parallel design
workflow; reviewed via per-PR review workflows.

- **PR #28 — v5-D previous-agents history**, re-homed onto the v7 seam. Capture moved
  into a shared `backends/record.ts` (reused by claude + codex; `ProviderSession` gained
  `record`+`finalize`); persist on teardown in `agent.ts`. Renderer: `useHistory`, the
  rail previous-sessions sub-list, and the `SessionReview` modal. Review caught two real
  HIGH bugs (rail sub-list clipped horizontally → stack vertically; the modal was occluded
  by the native preview → hide it while open).
- **PR #31 — inspector surfaces → shadcn**: Inspector/Notes/Tokens/PropPanel migrated,
  every test hook preserved, dead CSS removed. The whole chat panel is now Tailwind+shadcn.
- **PR #32 — direct (agent-free) prop+token editing**: broadened literals (TS casts +
  no-sub template literals) and a new `applyToken` IPC (T1 schema-enum swap + T3 inline-
  style swap), agent fallback otherwise. Review caught a real correctness bug — T3 matched
  on value-family only, so a color token could land in `fontWeight`; fixed by gating on the
  CSS property name (+ a re-inspect race guard).

**Learnings:**
- **Stacked PRs** are the clean way to ship interdependent work when you can't auto-merge:
  #2 and #3 both touch `Inspector.tsx`; branching #3 off #2 (off #1) means each PR's diff
  is just its own change and there are zero conflicts — merge bottom-up, GitHub retargets.
- **Re-homing across a refactor** (v5-D capture built against the pre-v7 monolith) is a
  *manual* re-apply, never a cherry-pick — the old `agent.ts` would clobber the seam. A
  shared helper (`record.ts`) kept each provider's change to ~4 lines.
- **Tailwind v4's CSS parser chokes on an apostrophe even inside a `/* */` comment**
  ("Unterminated string") — keep comments apostrophe-free.
- **Renderer-DOM modals are occluded by the native `WebContentsView` preview** — hide the
  preview (reuse the drag `setVisible` path) while any centered overlay is open. The
  PropPanel inset-strip pattern only works for edge-docked panels.
- **Direct edits from semi-trusted token files** are injection-safe via `JSON.stringify`
  into the JS string literal, but **family checks must gate on the CSS property name**, not
  just the value shape, or you write a valid-but-wrong value silently.

## 2026-06-26 — v7: ModelProvider seam + Codex backend scaffold

Started multi-provider backends. **User decision: subscription login, not BYO API
key** — so we wrap each vendor's subscription-auth coding-agent SDK/CLI (Codex SDK,
Gemini CLI, Grok Build CLI), not the Vercel AI SDK. Each brings its own tools, so
the spike's ~6–8 day tool-suite rebuild evaporates. See `docs/v7-multi-provider-design.md`.

**Shipped (commit 8f2bd71):** the seam under `src/main/backends/` —
- `types.ts` — `ModelProvider`/`ProviderSession`/`PendingPrompt`. `agent.ts` is now
  backend-agnostic (session map / activeKey / teardown / permission settle-loop /
  `agent:*` IPC, all in terms of `ProviderSession` + `AgentEvent`).
- `claude.ts` — the incumbent Claude Agent SDK session extracted **verbatim** behind
  the seam (`InputStream`, `canUseTool`, streaming loop). `tools.ts` holds the shared
  tool policy (moved out of `agent.ts` to avoid an import cycle).
- `codex.ts` — EXPERIMENTAL OpenAI Codex via `@openai/codex-sdk` (sign-in-with-ChatGPT).
- `index.ts` — `pickProvider(options.provider)`, default Claude.
- `AgentOptions.provider`; `test/provider-seam.mjs`.

**The big safety property:** the Claude path is **byte-identical** — full `verify`
incl. the real AGENT-E2E turn passes through the new indirection. Non-Claude is
reachable only when the renderer sets `provider`, so default runtime is unchanged.

**Learnings:**
- Extracting the load-bearing `agent.ts` was a clean "pure move" precisely because
  the IPC layer already optional-chained the live controls (`query.setModel?.` etc.)
  — those became `ProviderSession.setModel?` with zero handler changes.
- **Lazy non-literal dynamic import** (`const PKG: string = '@openai/codex-sdk';
  await import(PKG)`) lets an optional backend compile + ship WITHOUT its package
  installed (TS types it `any`, no module resolution) — it fails soft at runtime
  (error + done) so a missing SDK / not-logged-in routes to the login banner instead
  of crashing. Same trick the Claude SDK uses for ESM-in-CJS, applied to optionality.
- Codex/Gemini/Grok each **bring their own hardened toolset** — we don't define one;
  the provider just maps their event stream to dsgn's `delta`/`status`/`done`/`error`.
- Still gated on a real `codex login` to verify the live event mapping (can't be
  tested without the user's subscription session).

## 2026-06-26 — v6: chat panel → Tailwind v4 + shadcn/ui + AI Elements

Migrated the chat panel off plain CSS onto Tailwind + shadcn (branch
`dsgn/v6-chat-shadcn`). Decision rule applied per feature: shadcn primitive →
AI Elements → custom. Full `verify` green (all ~30 tests incl. AGENT-E2E).

**Shipped (3 commits):**
- **Scaffold** — Tailwind v4 via `@tailwindcss/vite`, `@` alias, hand-written
  `components.json`, shadcn neutral/new-york tokens in `styles.css` (renamed
  `--accent/--border/--radius` → `--*-shadcn`/`--shadcn-radius` to avoid colliding
  with our legacy vars), `@layer base` border default, `lib/utils.ts` (cn). shadcn
  primitives under `components/ui/*`; AI Elements `conversation` under
  `components/ai-elements/`. Additive — existing plain-CSS UI visually unchanged.
- **Chat core** — message list → AI Elements `<Conversation>` (stick-to-bottom,
  replaces the manual scroll effect); user messages → shadcn muted bubble;
  assistant kept on our `react-markdown`. Composer → shadcn `<InputGroup>` +
  `<InputGroupAddon block-end>` + native textarea (`data-slot=input-group-control`
  for the focus ring); send/stop → shadcn `<Button>` (lucide ArrowUp). Pickers stay
  native `<select>`; slash menu stays custom (textarea-driven).
- **Cards** — PermissionCards / SetupCard / TokenOfferCard → shadcn `<Button>` +
  Tailwind alert surfaces; legacy `.perm*/.setup*` CSS removed (classes kept as
  test hooks). Dense element-inspector surfaces backlogged.

**Learnings (the non-obvious bits):**
- **shadcn CLI alias resolution reads the ROOT `tsconfig.json`, not per-project
  tsconfigs.** With our project-references root (no `paths`), `shadcn add` couldn't
  resolve `@` and wrote to a literal `@/` dir + `src/components/`. Fix: add
  `baseUrl`+`paths @/*` to the root tsconfig; for the already-scattered run we
  relocated files under `src/renderer/src/` + hand-wrote `lib/utils.ts` (the CLI
  skipped it) + appended the CSS tokens manually.
- **The new "shadcn chat primitives" (message/bubble/marker/message-scroller) are
  NOT in the public registry** under those names (`new-york-v4/message.json` 404).
  The research over-trusted a docs-page scrape. Reality: use `input-group` (real) +
  AI Elements `conversation` (real, lightweight — only `use-stick-to-bottom`, no
  `ai`/streamdown). AI Elements `message` pulls `ai`+`streamdown`, so the message
  row is custom + our Markdown. **Always validate registry names by running the CLI.**
- **Tailwind v4 preflight is safe next to legacy CSS** because v4 emits into
  `@layer` and our legacy rules are unlayered (always win). The flip side: a
  migrated element's Tailwind utilities LOSE to any leftover unlayered legacy rule,
  so each migrated block needs its conflicting *properties* stripped (we kept the
  class as a bare hook). Did this for `.chat__messages`, `.composer__input`,
  `.perm*`, `.setup*`.
- **React 18 + shadcn new-york:** components are React-19-style (no `forwardRef`).
  Don't pass a ref into a shadcn leaf (Textarea/Input/Button) — it won't attach.
  The composer keeps a NATIVE textarea for its `inputRef` (seeding/cursor). Radix
  (`radix-ui@1.6`) works on React 18.
- **Test contract held with ZERO test edits** by preserving every selector
  (`.composer__input` is the readiness gate for ~20 tests) + keeping pickers native
  (the permission-mode test reads `<option>`s via `$$eval`).

## 2026-06-26 — v5-C2: LRU-cap warm agent sessions

- Closes the resource gap left after v5-C: the dev-server LRU cap (N=3) was in,
  but each open project still held a live agent SDK CLI subprocess unbounded. Now
  the same eviction bounds **both**.
- **`agent.ts`** — new `agent:is-open` IPC (`sessions.has(projectKey(root))`) so the
  renderer can tell a suspended session from a live one.
- **`App.tsx` `evictWarm`** (was `evictWarmServers`) — beyond the N most-recent
  projects, suspend the LRU ones by stopping the dev server **and** closing the
  agent session. Never reaps the active project, a simulator, or a project whose
  agent is mid-turn (`useChat.isRunningFor` — sticky from submit until `done`, so it
  protects backgrounded in-flight turns too). Re-reads live `activeKey`/running
  right before the destructive stops to dodge a switch-back TOCTOU.
- **`App.tsx` `applyProject`** — on switch-back, if `agent.isOpen` is false the
  session was LRU-suspended, so it's reopened via `agent.openProject` (awaited +
  try/catch, with a clear "prior context cleared" log note — the reopened session
  starts fresh; the visible transcript is kept for reference). Otherwise just
  `setActive`. Mirrors the dead/suspended dev-server relaunch path.
- Tradeoff (documented): suspending closes the SDK subprocess, so an evicted
  project's *agent context* is lost (its chat transcript is preserved for display).
  Real resume lands with v5-D (session persistence).
- Test: `test/agent-cap.mjs` — is-open liveness, LRU suspend leaves peers open,
  reopen re-activates. Full `bun run verify` green (31 OK, agent-e2e/sim-e2e SKIP
  without creds/Xcode).

## 2026-06-26 — proactive checks C1/C3: error extraction + rule-based diagnosis

- Real-world driver: an Expo build failed and dsgn surfaced the xcodebuild
  *dependency-graph* dump, not the actual cause — a stale Homebrew node keg pinned
  in `ios/.xcode.env.local` (`dyld: Library not loaded … Abort trap: 6`). Fixed the
  project (repoint NODE_BINARY) and hardened dsgn so it catches this class itself.
- **`extractBuildError(log)`** in `src/main/xcode.ts` (pure): pulls high-signal
  lines (dyld / Abort trap / PhaseScriptExecution / `error:` / linker) out of a
  build log and drops the "Explicit dependency on target …" graph noise. Wired into
  both `spawnMetro` reject paths (build-fail + early-exit); tail buffer 4k→8k.
- **`src/main/diag-rules.ts`** — layer 2 of the proactive-checks plan: pure
  `matchKnownError(text)` maps known signatures → known fixes (instant, offline)
  *before* the AI. First rule: broken NODE_BINARY → repo-scoped fix (rewrite
  `.xcode.env.local`) + optional host `brew cleanup node`. Wired into `diagnose:run`
  between the recall-cache and `aiDiagnose`; renders through the same DiagnoseCard.
- Tests: `extractBuildError` cases in `test/xcode.mjs`; new bun `test/diag-rules.mjs`
  (matches the node failure, no false positives on unrelated dyld/unknown errors).
  Added to the test/verify chains. Full verify green; `SIM-PREFLIGHT ok=true` now
  that the 26.5 runtime is installed.

## 2026-06-26 — v5-C rail: multiple open projects + switching (the payoff)

- **dsgn is now multi-project.** A left sidebar (`Rail.tsx`, Cursor-style) lists
  the open repos with an active highlight, a per-project "working" dot (green when
  that project's agent turn is in flight — incl. backgrounded ones), an × to close,
  and "+ New project" which opens another **keeping the current one warm** (its dev
  server + agent session keep running for an instant switch). The rail only shows
  once a project is open (single-project keeps the old layout).
- `ProjectEntry` now carries a per-project display snapshot (url / previewKind /
  branch / launchSpec); `patchEntry` updates it. `attempt(root, cmd?, keepWarm)`
  skips the single-active teardown when keeping warm and snapshots the project it
  leaves. `switchTo`/`applyProject` swap the preview (navigate the one
  WebContentsView to the target URL), the active agent session (`agent:setActive`),
  the per-project chat (`useChat.setActiveChat`), tokens, annotations, branch,
  status — no restart. `closeProjectFromRail` stops the server + session and falls
  through to another open project (or idle).
- New `test/rail.mjs`: open two fixtures (second keeps the first warm), assert both
  servers stay reachable, switching swaps the preview port + the per-project chat
  slice. Screenshot `10-rail.png`. Full verify green.
- Adversarial review (10 findings) hardened it: switching a warm project whose dev
  server **died/was suspended** now probes (`devServer.isRunning`) and relaunches it
  before navigating (no dead frame); `applyProject` clears the outgoing tokens/pins
  up front and guards the annotations write against a rapid re-switch (+ a
  `stillActive` re-check after every await); **LRU-suspend** caps warm dev servers at
  3 (the decided behavior — beyond that the least-recently-used are stopped and
  relaunch on return); project entries are kept current (open/restart/branch-rename
  patch them) so switching needs no stale-closure snapshot; `closeProjectFromRail`
  awaits the session close before clearing chat and avoids a double-stop on the last
  project; test isolation assertion strengthened (content, not counts).

## 2026-06-26 — v5-C core: per-project chat + event routing (keep-running)

- The machinery behind the chosen "backgrounded agents keep running, badge on
  return" behavior. `agent.ts` `emit` now tags every event with its session's
  `projectKey` and emits for ALL live sessions (dropped the active-only guard);
  new `agent:set-active(root)` switches a warm session without recreating it.
- `useChat` is now per-project: `byKey[projectKey]` slices (messages + isRunning +
  the streaming message id moved into the slice), with the active slice mirrored
  into the top-level `messages`/`isRunning` so ChatPanel + the Playwright store
  harness read it **unchanged**. Chat actions take an optional key (default =
  active); ChatPanel's `agent:event` handler routes by `event.projectKey` — the
  active project streams live, a backgrounded project accumulates into its own
  slice (the rail's "working" dot) and its output is there on switch-back.
- App sets the active chat to the open project, clears a project's slice on
  close/switch-away. New `test/chat-route.mjs` injects `agent:event`s from main
  (no creds) and proves routing + background accumulation + switch-reveal. Full
  verify green; `chat-render`/`comment-mode`/`agent-multi` unchanged. Rail UI next.
- Review fixes: `patch` uses `?? activeKey` (an explicit `''` is its own slice, not
  collapsed into the active project); open clears the project's chat slice first
  (so a trailing event from a disposed session can't surface stale content on
  reopen) and `stop` awaits `closeProject` before clearing.

## 2026-06-25 — v5-B: one agent session per project (S8)

- `src/main/agent.ts`: replaced the single `session` + monotonic `currentEpoch`
  with a `Map<projectKey, Session>` plus an `activeKey`. Each open project keeps
  its own persistent `query()` session (cwd = its repo); only the **active**
  project's session streams to the renderer (`emit` guards on
  `!disposed && key === activeKey`), so a backgrounded session kept warm for a
  fast switch can't leak into the visible chat. `permCounter` moved per-session and
  its fallback ids are namespaced by project key (no cross-session collisions).
- `agent:open-project` creates/replaces+activates a session for its key;
  `send`/`setModel`/`setPermissionMode`/`respond-permission`/`interrupt` route to
  the active session; `before-quit` closes all. New `agent:close-project` (+
  `DsgnApi.agent.closeProject`) tears a project's session down; the renderer calls
  it in the single-active teardown (switching), the failed-open cleanup, and stop.
- New `test/agent-multi.mjs` proves the lifecycle without Claude creds — it probes
  the synchronous "no active session" error to verify per-project sessions, active
  routing, and close semantics (open A,B → active; close the active → cleared, NOT
  auto-promoted; reopen re-activates; close last → none). Full verify green;
  single-project agent path unchanged.
- Review fix: closing the active project clears `activeKey` (it never auto-promotes
  a backgrounded session — which would start emitting into a chat the renderer
  isn't showing once the rail keeps sessions warm); the renderer re-activates
  explicitly via open-project.

## 2026-06-25 — v5-A: multi-instance dev servers (S7)

- `src/main/devserver.ts`: replaced the single `current` ChildProcess with a
  `Map<projectKey, ChildProcess>` — several projects' dev servers run at once.
  `start(opts.root)` pre-empts only that project's prior server (restart) and
  leaves others; `stop(root)` kills one process group + deletes its entry;
  `stopAll()` on `before-quit`; the spawn registers an `exit` handler that prunes
  the map if a server dies on its own. The timeout targets only the timed-out root.
- Contract: `devserver:stop` + `DsgnApi.devServer.stop` gain a `root`; preload +
  the three App callers thread it. Single-active behavior is preserved at the
  renderer (opening another project stops the previous one and drops it from the
  workspace; the rail will skip that to keep projects warm). Running servers hold
  their ports, so `findFreePort` hands out distinct ones naturally.
- New `test/devserver-multi.mjs`: two fixtures' servers run concurrently on
  distinct ports, both reachable, and `stop(rootA)` leaves B running. Full verify
  green (open-preview / setup-restart single-project paths unchanged).
- Adversarial review caught a real **free-port race** (concurrent starts both
  probed 7777 → same port): added a serialized `allocatePort` + reserved-port set
  so concurrent starts get distinct ports (released on exit). Also: the 90s
  timeout now kills the *captured* child (identity-guarded), not whatever's in the
  map for that key (a restart could otherwise kill the newer server); a failed
  `attempt` stops the dev server it started (no orphan); the test was strengthened
  (both fixtures honor `PORT` so the allocator is actually under test) and polls
  until-down instead of a fixed sleep.

## 2026-06-25 — iOS simulator build-destination preflight (the 26.5 gap)

- Root cause of "iOS 26.5 is not installed" after a multi-minute build: modern
  Xcode couples a simulator *build* to a runtime ≥ its active SDK version. The old
  preflight only counted `simctl` devices, which still listed 26.0/26.1 devices,
  so it went green while the build was already doomed.
- **`simBuildDestination(sdkVersion, runtimeVersions)`** in `src/main/xcode.ts`
  (pure, with `parseVersion`/`cmpVersion`): fails when no installed runtime ≥ the
  SDK, handing back the one-line fix (`xcodebuild -downloadPlatform iOS`). Unknown/
  unparseable SDK never blocks (degrade safe). Unit-tested in `test/xcode.mjs`.
- `preflight()` now probes `xcrun --sdk iphonesimulator --show-sdk-version` and the
  runtime versions, and returns this reason *before* booting + building.
- Kicked off the 8.52 GB `xcodebuild -downloadPlatform iOS` for this machine's
  missing 26.5 runtime (consented).
- **`docs/PLAN-proactive-checks.md`** — the layered "preflight rules" design this
  generalizes into: proactive checks → rule-based failure matching → AI diagnose
  fallback, all feeding the existing propose-first card + per-machine memory.

## 2026-06-25 — v5 foundation: projectKey + workspace store (S0/S2)

- First, non-collision slices of the v5 multi-project roadmap (a planning workflow
  mapped the single-instance machinery and ordered the slices to avoid the parallel
  session's main-process edits — see `docs/TASKS.md` v5).
- **S0** — `src/shared/projectKey.ts`: a pure, string-only canonical key for an open
  project (separator/trailing-slash normalized, idempotent). Every later
  `Map<root,*>` (dev servers, agent sessions, preview state, the renderer
  workspace) keys on this so main and renderer dedupe the same repo. Pure bun test
  `test/project-key.mjs`.
- **S2** — `useWorkspace` store (renderer): the future source of truth for
  multi-project — `projects[]` + `activeKey`, with `openOrActivate/activate/close`
  keyed by `projectKey`. Wired live for the single open project (App populates it on
  open, clears on stop) but otherwise additive/dormant until the rail + multi-instance
  backends land. Exercised in `test/chat-render.mjs` (`__dsgnWorkspace`).
- Deferred + why: the multi-instance **main** refactors (dev servers S7, agent
  sessions S8, preview state S9) are HIGH-collision with the parallel session's
  active `main/index.ts`/`agent.ts`/`devserver.ts` work and gated on lifecycle
  decisions (warm vs suspend, caps) — left for coordination. The per-project store
  fan-out (S3–S6) is a large dormant renderer refactor better done with the user in
  the loop. See the session's blocking questions.

## 2026-06-25 — Figma-style inline comment (C) + annotation (Y) modes

- Press **C** → comment mode, **Y** → annotation mode (also toolbar buttons). Click
  an element in the preview and an inline composer (a pill in the overlay's shadow
  root) anchors to it. Submitting a **comment** sends it straight to the agent
  (element ref + your text); an **annotation** pins a note (no agent), reusing the
  existing `.dsgn/annotations.json` engine + pins.
- Layered onto the existing select overlay in `src/preview/preload.ts` (select
  stays byte-identical): a `commentMode` state, the shadow-DOM composer, capture-
  phase C/Y/Esc keys (guarded against the page's own text fields + modifiers), and
  click→`openComposer`→submit. Modes are mutually exclusive with select. New
  channels: `set-comment-mode` (renderer→preload), `comment-mode` (keyboard echo),
  `comment` (submit) — all sender-gated in main and cached across preview reloads.
- Renderer: `useSelection.commentMode` mirrors the preview (toolbar reflects
  keyboard arming); a submitted comment routes via a new one-shot `useComposer.submit`
  (auto-sends, or prefills if a turn is running so it's never dropped); an
  annotation calls `annotations.add`. Comment text is capped/sanitized into the
  prompt. New `test/comment-mode.mjs` drives the full path end to end (arm → click
  → shadow composer → send → agent turn / annotation pin) through real IPC.
- Adversarial review fixes: the composer self-heals if its frozen element is
  removed by HMR (`isConnected` guard in `onMove`, mirroring the text-edit path);
  `preview:reset` clears `commentModeActive` for parity with `selectModeActive` (no
  stale re-arm on project switch); and an annotation submitted before the session
  is ready logs feedback instead of dropping silently.

## 2026-06-25 — AI diagnose-on-failure → propose-first fix card + per-machine memory

- When opening/launching a project fails (web or simulator — both throw into the
  one `attempt` catch), dsgn now asks the agent to **diagnose** it and shows a
  **propose-first** card: a one-line root cause + numbered steps, each tagged
  **repo** (a fix dsgn can apply) or **host** (sudo / global / download — the user
  runs it), with the exact shell command + a Copy button. Nothing runs
  automatically (user-chosen). "Apply repo fix" seeds the chat with the repo steps
  for the agent to execute (reviewed + sent); host steps are copy-only.
- **Per-machine memory** (user-chosen scope): `src/main/diag-cache.ts` (pure, fs)
  caches each diagnosis in the app's userData (NOT the repo), keyed by project path
  + a normalized error **signature** (paths/ids/numbers stripped, so the same error
  class recalls instantly across runs). A repeat error is recalled with "seen before"
  — no model call. `diagnose:record` stores applied/dismissed.
- **One-shot, tool-less SDK turn** (`src/main/diagnose.ts`): cwd=repo, no tools, no
  settings, asks for a strict JSON plan; degrades to null without auth (the raw
  error still shows). Recall happens before any model call.
- Tests: `test/diag-cache.mjs` (signature normalization incl. the module-name-vs-path
  fix, recall/remember, per-project, status) + `test/diagnose-card.mjs` (renders
  repo/host steps, Apply seeds the composer + clears, Dismiss clears). `bun run
  verify` green (25 checks).

## 2026-06-25 — Svelte component prop schema reachable via selection (option D)

- Bug: selecting a rendered Svelte component never showed its prop schema. A
  Svelte component instance compiles to **no DOM node**, so the usage-site
  `data-dsgn-source` stamp on `<Accordion>` is dropped (no `...rest` forwarding) —
  the only stamps reaching the page are the plain host elements *inside each
  component's definition*, which took the host-element (no-schema) path.
- Fix (**option D — same-file definition schema**): when a clicked host element
  resolves into a `.svelte` file that declares props, `inspectSvelteProps` now
  surfaces **that file's own** props (`extractProps` on the same instance script).
  Works for **every component shape** (block-`{#if}`-root, multi-root, etc.) with
  **zero source mutation** — chosen over rest-forwarding (A/B), which can't reach
  the ~46% of a real library that has no single host root. Per-instance editing
  (option C, runtime instance→usage mapping) is the planned follow-up.
- Edits to a definition-scoped prop route to the agent as a prop-default change
  (the instance has no node to splice). The panel surfaces the schema only — no
  misleading live value — and the note is honest ("no per-instance value; editing
  changes the default, affecting only instances that don't set it"). SvelteKit
  route files (`+page`/`+layout`) are excluded (their `data`/`form`/`params` are
  framework-injected, not props). New `test/prop-svelte-self.mjs` (the brief's
  smoke check): definition host → `hasSchema:true` with the right fields, edit →
  agent, plus propless-host and route-file negatives; cross-file path intact.

## 2026-06-25 — Work on a `dsgn/*` branch per project

- Opening a project now puts dsgn's work on a **`dsgn/*` branch** so the user's main
  branch stays clean. `src/main/git.ts` (pure, child_process only): `ensureBranch`
  keeps an existing `dsgn/*` branch or creates `dsgn/<current-branch>` off HEAD
  (`dsgn/work` when detached); `switchBranch` switches/creates a named one
  (coerced to a git-ref-safe `dsgn/<…>`). `checkout -b` carries uncommitted changes
  (nothing lost); a conflicting switch surfaces the error instead of forcing.
- **Only manages the repo TOP LEVEL** (`isRepoRoot`, realpath-compared) — opening a
  subdirectory of a larger repo (a monorepo package, or a fixture inside this repo)
  is a no-op, so the test suite never switches dsgn's own branch.
- The branch shows as a **clickable pill in the titlebar** (`⎇ dsgn/main`); clicking
  opens an inline editor to rename/switch (Enter applies, Esc cancels). The open flow
  logs `Working on branch … (created)` to the activity console.
- `git:ensure`/`git:set` IPC; `useSession.branch`; `BranchResult` contract. Unit test
  `test/git.mjs` (real temp repo: normalize, non-repo no-op, ensure create/keep,
  switch create/existing); chat-render covers the pill + inline editor. `bun run
  verify` green (22 checks); confirmed the suite leaves dsgn on `main`.

## 2026-06-25 — React Native / iOS-Simulator preview (Phase 1: live mirror)

- New preview mode: a booted **iOS Simulator** running an Expo/React Native app
  shown in the right pane instead of a web browser (macOS-only). Phase 1 of a
  phased plan (mirror → interact → element-select); user-chosen scope: RN/Expo
  first, macOS-only, start with a view-only mirror.
- **Frame transport — reuse over reinvention.** Rather than a new renderer canvas
  fed frames over IPC, `src/main/simulator.ts` stands up a tiny local **"sim
  bridge"**: an HTTP server that captures the booted device (`xcrun simctl io …
  screenshot`, JPEG) and serves it as an **MJPEG** behind a one-`<img>` page. The
  renderer points the **existing** preview `WebContentsView` at that URL — so the
  simulator is "just another local URL" and every geometry/load/retry seam
  (`preview:set-bounds`, `preview:load`, the `did-fail-load` retry loop) is reused
  unchanged. Modeled on `serve-sim` (Evan Bacon) and Maestro Studio.
- **Detection** (`devserver.ts`): `detectFramework` recognizes `expo` /
  `react-native` (checked first — Expo repos also list `react-native`); `detect()`
  sets `previewKind: 'web' | 'simulator'` on `DetectedProject`. Frame capture uses
  only `xcrun simctl` (ships with Xcode, zero extra install); `idb` is detected for
  the Phase-2 interaction path but not required.
- **Preflight** (`simulator.preflight()`): all read-only `execFile` probes, never
  throws; returns a human `reason` per failure class (not-macOS / no-Xcode /
  no-runtime / no-device). `App.attempt()` branches on `previewKind`, preflights
  first, and surfaces a clean banner+console card off the happy path instead of
  crashing. Backend teardown is cross-routed (opening a web project stops any
  simulator and vice-versa); `stop()`/`restartPreview()` route by `previewKind`.
- **Lifecycle** (`simulator.start`): boot a device (prefer already-booted, else
  newest iPhone) → `bootstatus` wait → spawn the dev command (default `expo
  run:ios`: build+install+launch+serve) in its own process group → stand up the
  bridge → readiness = first captured frame. `stop()` SIGTERMs the Metro group and
  closes the bridge (sim left booted for fast re-open); `before-quit` cleanup.
- **Preload routing**: the bridge page is flagged `?dsgnSim=1`; `src/preview/
  preload.ts` early-returns its whole web overlay there (no previewed-app DOM to
  stamp/inspect). The "Select" toggle is hidden in sim mode until Phase 3.
- **Contract** (`src/shared/api.ts`): `Framework` += `expo`/`react-native`;
  `PreviewKind`; `DetectedProject.previewKind`; `RunningSimulator`; `SimPreflight`;
  `SetupStrategy` += `babel-plugin-rn` (Phase 3); `DsgnApi.simulator.{preflight,
  start,stop,onLog}` mirrored in the preload.
- **Tests (degrade off-macOS, like agent-e2e):** `sim-detect` (expo/RN→simulator,
  vite→web), `sim-preflight` (non-mac → ok:false + reason), `sim-frame` (exercises
  the whole bridge→MJPEG→WebContentsView transport with a stub frame source via a
  main-process test hook — **no simulator needed**), `sim-e2e` (boots a real sim;
  SKIPs unless macOS + `DSGN_SIM_E2E=1` + `DSGN_SIM_FIXTURE`). `bun run verify`
  green (19 checks; agent-e2e + sim-e2e SKIP here).
- **Not yet verified on-device:** the simctl/expo orchestration in `start()` is
  macOS-only and could not run in this Linux CI env — it needs a Mac with Xcode to
  confirm boot/build/launch end-to-end (the bridge/transport itself IS verified by
  `sim-frame`).

## 2026-06-24 — First-run offer to scaffold `.dsgn/tokens.json`

- When a project opens with **no** design tokens (`tokens.detect` → `source:'none'`
  — no manifest, Tailwind theme, or CSS custom properties), dsgn now offers a
  starter `.dsgn/tokens.json` (colors/spacing/radius/fontSize). Accepting is a
  deterministic file write (no agent turn); the manifest then becomes the
  editable, canonical source the palette reads.
- `scaffoldManifest` (tokens.ts, `tokens:scaffold`) only writes when the project
  has **zero** tokens — it never shadows a live Tailwind/CSS source or clobbers an
  existing manifest (guarded on `detectTokens(...).source === 'none'`, idempotent).
- New `TokenOfferCard`; the offer yields to the setup offer (one card at a time).
  Offer state lives on `useTokens` (`offerNeeded`/`offerDismissed`/`scaffolding`,
  cleared on project switch via `reset()`). New `test/tokens-scaffold.mjs` covers
  the write, idempotency, no-shadow/no-clobber, and the card's accept + dismiss.
- Adversarial review fix: `acceptTokenScaffold` re-checks `projectRoot` after the
  async write resolves (mirrors the detect handler) so switching projects mid-write
  can't stamp the old project's starter palette into the new project's state.

## 2026-06-24 — Svelte inline text-splice in source

- Inline text editing rewrote JSX text directly but punted `.svelte` to the agent.
  Now `applySvelteTextEdit` (props-svelte.ts) splices Svelte text content via
  svelte/compiler — the `.svelte` counterpart of the JSX path, same contract:
  plain-`Text` children + splice-safe new text apply directly; empty / expression
  (`{...}`) / mixed / element children fall back to the agent.
- Mirrors the JSX engine's whitespace handling (lead/trail from the raw source,
  zeroed for all-whitespace) and splice-safety regex (`^[^<>{}]*$`, so the new
  text can't open a tag or mustache). Reuses the shared `findElement` /
  `makeLocator` so line/col match the stamps.
- `props.ts` dispatches `.svelte` to it (was a hard agent-fallback). New
  `test/text-edit-svelte.mjs`: plain `<h1>` text rewritten to `.svelte` source;
  a mixed `<p>Label <Badge/></p>` correctly needs the agent.

## 2026-06-24 — Auto-restart the preview after setup

- A setup turn edits the build config (vite.config / svelte.config), which
  Vite/SvelteKit only read at boot — a page reload alone never applied the new
  source-stamping plugin, so the user had to manually restart. Now dsgn does it.
- `useSetup.busy` already uniquely marks "the setup turn is in progress" (only
  `acceptSetup` sets it), so verification is now armed when that turn **finishes**
  (the `done` handler), not when it's dispatched — closing a race where a
  mid-turn dev-server auto-restart could be mistaken for the verdict.
- On setup `done`: arm `verifying` + raise a one-shot `restartRequested`. App
  consumes it and `restartPreview()` does `devServer.stop()` → `start()` (reusing
  the captured launch spec: root + resolved dev command + framework) →
  `preview.load(newUrl)`. The post-restart readiness report is the verdict. Only
  restarts servers dsgn owns (skips attached). On relaunch failure (a broken
  config edit) it disarms verification and surfaces the error instead of hanging.
- New `test/setup-restart.mjs`: opens a fixture, drives the finished-setup signal,
  asserts the server relaunches, the preview reloads, and the zero-stamp verdict
  fires (no silent success). Also backfilled `verify` to run the setup tests.
- Adversarial review (3 dimensions, independently verified) caught and fixed:
  cancelling a setup turn no longer restarts (an interrupt arrives as `done` with
  `busy` still set — `stop()` now clears it); a project switch mid-restart is
  guarded (re-checks `projectRoot` after each await so it won't relaunch the old
  project over the new one); and an attached (user-owned) server now reports
  "restart it yourself" instead of a false zero-stamp verdict.

## 2026-06-24 — Framework-aware setup (detect before generating)

- Fixed the core setup bug: dsgn assumed React and wrote a Babel JSX plugin
  (`dsgn-source-plugin.cjs`) to the repo **root** of any project — useless in a
  SvelteKit repo (no Babel pass, no JSX) and it would have reported success
  anyway. Setup is now **framework-first**.
- `src/main/setup.ts` `detect()` reads `package.json` deps **first** and branches:
  `@sveltejs/kit`/`svelte` → Svelte (markup-preprocessor strategy, with
  `svelteMajor`), `react`/`@vitejs/plugin-react(-swc)`/`next` → React (Babel
  plugin), `solid-js` → Solid (Babel — also JSX), `vue` → Vue (inspector
  strategy, **no bespoke file** — reuse its ecosystem), else `unknown` → none.
- Artifacts are **scoped to `.dsgn/`** (not the repo root): `.dsgn/dsgn-source.cjs`
  (React/Solid) or `.dsgn/dsgn-svelte-stamp.mjs` (Svelte preprocessor using
  `svelte/compiler`, 1-based line / 0-based col to match `props-svelte.ts`). Both
  are **structurally dev-gated** (`NODE_ENV === 'production'` → empty visitor /
  no-op), idempotent, and removable via a new `setup:uninstall` (also sweeps the
  legacy root plugin).
- `acceptSetup` now builds **framework-correct** agent instructions (React
  `interface Props`, Svelte 5 `$props()` vs Svelte 4 `export let`, Vue
  `defineProps<Props>()`) and **stops with a clear message** for unknown/Vue
  rather than handing React steps to a non-React repo.
- **Verification (no silent success):** `acceptSetup` arms `verifying`; the next
  readiness report confirms stamps fired — `>0` → "Setup verified", `0` → a hard
  warning that the instrumentation didn't fire.
- New `test/setup-detect.mjs`: per-framework detect/scaffold/uninstall, idempotency,
  dev-gating, legacy-cleanup — through real IPC. `ready-gating.mjs` updated to the
  `.dsgn/` path. `SetupResult` reshaped (`framework: Frontend`, `strategy`,
  `svelteMajor`, `files[]`; dropped `pluginFile`).

## 2026-06-24 — Preview runs on its own free port (7777+), bound to 127.0.0.1

- dsgn now **always spawns the dev server on a free port it picks** (first free at/above
  7777) **bound to 127.0.0.1**, via `--port/--host` flags (vite/sveltekit/next) or
  `PORT`/`HOST` env (CRA/unknown). This kills the framework-default collisions
  (5173/3000), the IPv4/IPv6 `localhost` mismatch, and the attach-to-a-stale-server
  confusion in one move — the attach-on-open probe is dropped (always a fresh,
  isolated server).
- **Not 6666:** the IRC ports (6665-6669, 6679, 6697) are on the browser/WHATWG-fetch
  blocked-ports list, so Chromium AND the Node `fetch` readiness probe refuse them —
  a preview there can't load even though the server binds (curl works, which masked it).
  `findFreePort` skips the whole blocked-ports list; base is 7777.
- Readiness now probes the assigned port directly (primary) with the printed-URL parse
  as fallback. `findFreePort`/`isPortFree`/`BLOCKED_PORTS` unit-tested; open-preview
  asserts the preview lands on a port ≥ 7777. `bun run verify` green (13 tests).

## 2026-06-24 — Stop the in-flight agent turn + setup streams progress

- A **Stop** affordance interrupts the running agent turn (`agent.interrupt()` → the
  SDK emits `result`→`done`, clearing `isRunning` and any setup `busy`).
- The on-open **Setup** card now streams its agent turn into the chat (so you can
  watch and stop it) and is guarded: `busy` stays true until the turn finishes
  (cleared by the `done`/`error` handler), a scaffold failure clears `busy`, and
  it won't re-trigger while a turn is running. `verify` green (13 tests).

## 2026-06-24 — Inline text editing

- **Double-click a stamped, text-only element in the preview** (in Select mode) to edit its
  text in place; Enter/blur writes the new text straight to source, Escape cancels.
- Engine (`applyTextEdit` in `props.ts`): finds the JSX element at the stamp, and when its
  children are plain text (a single JSXText, or empty) and the new text is splice-safe
  (`/^[^<>{}]*$/`), rewrites the text child in source preserving leading/trailing whitespace.
  Expression/mixed content (`{title}`, nested elements), self-closing elements, or `.svelte`
  files fall back to the agent (`needsAgent`).
- Wiring: the preview preload drives the inline `contentEditable` edit and emits the commit;
  main relays it (sender-checked) to the renderer, which applies via `text:apply` with the
  current project root (agent-seeds on `needsAgent`).
- `test/text-edit.mjs`: a plain-text `<h1>` is rewritten in source; an expression child
  (`{props.label}`) → agent. ✅ `bun run verify` green.
- **Adversarial review (5 findings, all fixed):** the `editing` flag could strand select mode —
  now `setActive(false)` and `pagehide` end the edit, and a detached node self-heals on the next
  mouse move (HMR mid-edit); a write failure now routes the edit to the agent instead of being
  silently dropped; surrounding whitespace is derived from the raw source (so `&nbsp;` etc. aren't
  rewritten as literal bytes) with the all-whitespace overlap zeroed.

## 2026-06-24 — Activity console (visibility into the open-project flow)

- A collapsible **Activity console** (titlebar "Logs" toggle) shows the whole open
  sequence with timestamps: detect result, attach-vs-spawn decision, raw dev-server
  output, readiness, preview load, agent session start, Ready — and any error
  (errors auto-open it). Docked full-width above the panes; the native preview
  reflows via its ResizeObserver. `useLog` store (capped at 500 lines) +
  `ConsolePanel.tsx`; `App.attempt` emits the step lines, `devserver:log` feeds the
  raw output. Also strips the ANSI codes (so the URL line reads cleanly). This is
  the trail that would've made the lkmv.ch hang obvious at a glance.
- Gave the "Open project" button a `btn--open` class — adding the "Logs" `btn` made
  `.btn` ambiguous and broke the tests' open-click. open-preview now also asserts the
  console captured Detected/Dev server/Preview loaded/Ready. `bun run verify` green (12 tests).

## 2026-06-23 — Readiness gating, floating prop panel, on-open setup

A project that isn't dsgn-ready no longer pretends to be editable — and dsgn offers to fix it.

- **Gating**: prop editing is now gated on a resolved react-docgen schema (`PropInspection.hasSchema`).
  Selecting an element auto-inspects (App effect, race-guarded by source); a schema-backed
  component opens the editor, an unready one (host element / untyped / unstamped) shows a
  prompt-only hint with a "set up the project" link.
- **Floating prop panel** (`PropPanel.tsx`): the editor moved out of the chat to a panel on the
  preview's right edge — component name, source, and every prop with a typed control + its
  description. Because the preview is a *native* view (DOM can't float above it), the panel
  reserves a right-edge strip via `preview.setPanelInset` and the native bounds shrink while
  it's open.
- **On-open setup** (`SetupCard` + `src/main/setup.ts`): the preview preload reports whether
  the app is source-stamped; if not, dsgn posts a chat offer to set it up. Accept → dsgn writes
  the dev-only stamping Babel plugin deterministically, then asks the agent to wire it in and
  type the components (the hybrid).
- New `test/ready-gating.mjs`: scaffold writes the plugin (idempotent), a no-schema element is
  prompt-only (no panel), a schema-backed one opens the panel, and the offer renders.
  ✅ `bun run verify` green (10 tests).
- **Adversarial review (4 findings, all fixed):** dismissing the offer no longer blanks the
  chat (dismiss clears `needed`); the readiness probe re-samples (600/1500/3000ms) so a slow
  SPA isn't falsely flagged; `acceptSetup` is try/finally so busy can't stick; the gating test
  now also asserts the positive panel case. No safety issues in the scaffold or preview-bounds.

## 2026-06-23 — Dev-server: attach-to-running + IPv4/IPv6-safe preview

Fixes "opening a project I already run doesn't work" (hit on lkmv.ch):

- **Attach instead of duplicate.** If the project's dev server is already serving
  (probe the known framework's default port — Vite/SvelteKit 5173, Next/CRA 3000 —
  on both 127.0.0.1 and [::1], require status < 400), dsgn previews THAT instead of
  spawning a competitor. Two dev servers on one project clash (e.g. SvelteKit's
  `.svelte-kit/`) and the duplicate 500s. Only known frameworks attach; 'unknown'
  always spawns (so it never grabs an unrelated app on 5173/3000). Attached servers
  aren't owned, so Stop/quit won't kill them.
- **IPv4/IPv6-safe URLs.** A spawned `vite dev` often binds IPv6-only (`[::1]`) while
  the preview resolves `localhost` to IPv4 (`127.0.0.1`) → blank preview. The runner
  now resolves the printed URL to whichever concrete loopback actually answers and
  loads that.
- **Moved dsgn's own renderer off 5173** (→ 5180) so it stops colliding with every
  Vite/SvelteKit project's default port.
- Extracted pure helpers to `src/main/devserver-net.ts` with a unit test
  (`test/devserver-net.mjs`): host variants, attach policy (unknown → no probe,
  500 → don't attach, IPv6 fallback). `bun run verify` green (11 tests; open-preview
  now serves over 127.0.0.1). Updated tests that hardcoded `localhost`.

## 2026-06-23 — Svelte / SvelteKit support (prop editing → framework-agnostic)

- Prop editing is now **framework-agnostic by dispatch**: `props.ts` routes by
  source extension — `.svelte` → new `src/main/props-svelte.ts`, everything else →
  the unchanged React/JSX engine. Both share helpers (resolveSource, mergeFields,
  withinRoot, isValidAttrName) and return identical PropInspection/PropEditResult.
- `props-svelte.ts` parses with `svelte/compiler` (ESM, dynamic-imported): finds
  the element at line:col, reads literal attributes, resolves a component schema
  cross-file from `export let` (Svelte 4) or `$props()` + `interface Props` (Svelte 5),
  and applies literal edits by splicing the `.svelte` source.
- Added a **Svelte stamping recipe** to `docs/DESIGN.md`. Test
  `test/prop-edit-svelte.mjs` (svelte-app fixture) covers the cross-file `$props` schema,
  literal apply, host attrs, and same-line/column disambiguation.
- **Adversarial review (1 real bug, fixed):** `resolveSource`'s greedy regex parsed
  `"path:line:col"` as `file="path:line", line=col` — a latent bug on the shared path.
  Now non-greedy; plus a defense-in-depth attr-name re-validation in `applySvelteEdit`.

## 2026-06-23 — Design-token detection + palette

- `src/main/tokens.ts` auto-detects a project's design tokens, probing three sources in
  priority order so the right one is chosen per repo: **`.dsgn/tokens.json`** manifest →
  **`tailwind.config.*`** (parsed *statically* with babel — literal theme values only, the
  config is never executed) → **CSS custom properties** (a depth/file-bounded scan of the
  repo's CSS, grouped by name prefix). First source with tokens wins.
- Renderer: tokens load on project open into `useTokens`; the inspector gains a "Tokens"
  toggle showing the detected palette (swatches for colors, the source labeled). Clicking a
  token seeds the chat to apply it to the selected element — reusing the agent path rather
  than a fragile per-framework style editor.
- `test/tokens.mjs` proves the priority (manifest wins over a present Tailwind config) and
  each parser (nested Tailwind colors flatten, CSS `var()` aliases skipped) through real IPC,
  plus the palette UI. ✅ `bun run verify` green (8 tests).
- **Adversarial review (7 verified findings, all fixed):**
  - **Tailwind parser correctness** (the two that justified gating the merge): `theme.extend`
    tokens were dropped whenever a base category also existed (the most common Tailwind
    pattern), and the theme search matched *any* nested `theme:` (a plugin/preset could leak
    bogus tokens). Now scoped to the config's actual export and merges base + extend (extend
    wins). Both locked with fixture regression tests.
  - **Prompt-injection regression**: the token-apply path interpolated raw page-derived
    element fields, bypassing the `oneLine` sanitizer used everywhere else — now routed
    through it (+ bounded token name/value); tested with an injected-newline id.
  - Token detect is guarded against a project-switch race; `isColor` covers named colors /
    gradients (via `CSS.supports`); the palette caps tokens per group; tests cover the
    `source: 'none'` state and the seeded-prompt contract.

## 2026-06-23 — Cross-file prop-schema resolution

- The prop editor now resolves a component's schema even when it's imported from another
  file: if there's no same-file react-docgen match, `props.ts` finds the component's relative
  import in the usage file, resolves the module path (tries `.tsx/.ts/.jsx/.js` + `/index`,
  refusing anything outside the project root), and runs react-docgen on the definition file.
- Matches on the **exported** name from the import (`{ Button as B }` → `Button`), so a
  re-export barrel that also defines another component can't mis-attach its schema
  (flagged + fixed in review). Edits still target the usage site, never the definition.
- `test/prop-edit.mjs` extended: `<Button>` used in `Card.tsx` but defined in `Button.tsx`
  resolves Button's enum/string schema with the live usage value. ✅ `bun run verify` green.

## 2026-06-23 — v3 engineer handoff: annotations + Publish→PR

- **Annotations sidecar** (`src/main/annotations.ts`): reviewer notes pinned to elements,
  stored in `<repo>/.dsgn/annotations.json` (list/add/remove via IPC). The agent is denied
  writes anywhere under `.dsgn/` (a guard in `agent.ts` `canUseTool`), so it can't clobber
  the handoff.
- **Pins**: the preview preload draws numbered pins over annotated elements (located by
  selector, repositioned on scroll/resize/HMR); clicking a pin focuses its note in the panel.
- **Renderer**: `useAnnotations` store; an "Add note" composer in the inspector; a
  `NotesPanel` listing notes (with delete) and a **Publish PR** button. Notes load on open,
  pins stay in sync, both clear on project switch/stop.
- **Publish** (`publishToPr`): creates a branch, commits the working changes + notes, pushes,
  and `gh pr create`s with a generated body (notes as a checklist + changed files). Args go
  through `execFile` (no shell). Common failures (no gh / no remote / nothing to publish) are
  surfaced.
- Test `test/annotations.mjs` drives the flow through real IPC: a note saved via the inspector
  persists to the `.dsgn` sidecar, shows in the panel, and removes cleanly. ✅ `bun run verify`
  green (7 tests).
- **Adversarial review (14 verified findings, all fixed):**
  - **Publish was unsafe** — `git add -A` swept the whole working tree (unrelated WIP /
    untracked secrets) into the PR. Now: pre-flight gates (is-repo, not detached, has origin,
    gh present) before any mutation; stage only tracked changes + the `.dsgn` sidecar
    (`add -u`, no untracked sweep); roll back to the original branch on failure (and report
    where the work landed if already committed); clean changed-file list via
    `diff --name-only HEAD` (no porcelain rename-arrow / quoting bugs).
  - The `.dsgn` guard now also blocks **Bash** commands touching the sidecar (was edit-tools
    only; noted that Auto/bypass mode skips `canUseTool` entirely).
  - Annotation writes are serialized (promise-chain mutex) + atomic (tmp + rename), so
    concurrent add/remove can't lose a note and a crash can't truncate the file.
  - `buildPrBody` extracted to a pure `src/shared/pr-body.ts` with a unit test (escapes
    backticks, caps the file list, flattens newlines).
  - Renderer: a failed note save keeps the text (no silent loss); pin-focus scrolls the note
    into view; publish state resets on project switch; pins build once and only reposition
    (no per-scroll churn); the pin interval is cleared on pagehide.

## 2026-06-23 — Prop/token editor (react-docgen + hybrid apply)

- `src/main/props.ts`: given an element's `data-dsgn-source` ("relpath:line"), parse the
  source file with `@babel/parser`, find the JSX element on that line, read its current
  literal attributes, and run **react-docgen** (FindAllDefinitions resolver) for the
  component's prop schema (types, enums, required, descriptions). Both deps are ESM-only,
  so they're dynamic-`import()`ed like the Agent SDK.
- **Hybrid apply**: simple literal props (string/number/boolean/enum) are written straight
  to source via a targeted string splice (formatting-preserving, no codegen dep) → the dev
  server hot-reloads; non-literal/`other` values return `needsAgent` and the renderer seeds
  the agent instead. Path is hardened: `resolveSource` rejects absolute paths and anything
  resolving outside the project root.
- Renderer: an "Edit props" toggle in the inspector reveals `PropEditor`, which renders
  typed controls (text/number/checkbox/enum-select) from the inspection and applies on
  change/blur; `useSession.projectRoot` carries the root needed to resolve sources.
- Test `test/prop-edit.mjs` drives the engine through real IPC (no dev server/auth):
  inspect resolves the schema + live values, apply writes `variant="warn"` to the fixture,
  and the UI renders the typed rows. ✅ `bun run verify` green; also hardened the
  select-element test's retry budget against load-induced flake.
- **Adversarial review (5 verified findings, all fixed):**
  - **Same-line elements** (`<Badge>` inline in an `<li>`/`<p>`) resolved to the *wrong*
    element — the exact-line match returned the first/outermost. Now column-aware (the stamp
    plugin emits `line:col`) and, without a column, picks the innermost element on the line.
    Regression-tested.
  - **Prop-name injection**: an unvalidated name was spliced raw into source. Names are now
    validated against an attribute-name allowlist at every layer (schema, current attrs, and
    the apply IPC boundary).
  - **Wrong schema** attached to imported child components (the `docs[0]` fallback) — now only
    falls back for an anonymous single component, else shows the "no schema" note.
  - Failed applies are **surfaced** in the editor (and the control resets to the file value)
    instead of silently dropping. `projectRoot` is cleared on project (re)open.

## 2026-06-23 — Permission approve/deny cards + Auto mode (SDK)

- `canUseTool` (main) now drives a real approval flow: for any tool the SDK gates, it emits
  a `permission-request` and awaits the user's decision via a per-session pending map,
  resolving the SDK callback on allow/deny — and denying cleanly on abort / epoch change /
  session replace / quit so a torn-down turn never leaves the SDK blocked. Read-only tools
  (Read/Glob/Grep/LS/NotebookRead) are auto-allowed so "Ask" mode stays usable.
- **Permission-mode selector** in the toolbar → `query.setPermissionMode` live, mode also
  passed at project-open so it sticks: **Ask** (`default`), **Auto-accept edits**
  (`acceptEdits`), **Auto: approve all** (`bypassPermissions`). "Auto" is genuine SDK
  bypass — under it the SDK never calls `canUseTool`, so no cards appear.
- Renderer: `usePermissions` store (mode + pending queue, deduped by id); `PermissionCards`
  renders approve/deny cards above the composer; App routes `permission-request`/`-resolved`
  events. `chat-render` test seeds a card, approves it, and asserts the three modes incl.
  `bypassPermissions`. ✅ `bun run verify` green.
- **Adversarial review (8 verified findings, all fixed):**
  - **`bypassPermissions` needs `allowDangerouslySkipPermissions: true`** in the query options
    or the CLI refuses to bypass — so "Auto" silently still prompted. Added the ack flag
    (only takes effect when the user picks Auto; default stays Ask). `agent-e2e` now opens in
    Auto, which both unblocks the unattended edit and live-verifies real bypass.
  - Switching to a more-permissive mode now **releases prompts already on screen** (drains
    `pending` as allow + emits `permission-resolved`); opening another project clears stale
    cards; `set-permission-mode` awaits the SDK before committing, and the toolbar reverts if
    the SDK refuses. `interrupt` drains pending so cards can't orphan. Status line emits only
    after the abort/epoch gate. Each pending now tracks its tool name (for acceptEdits).

## 2026-06-23 — v2 adversarial review + hardening

- Ran a multi-agent review workflow over the v2 diff (security/IPC, lifecycle, renderer/UX,
  test integrity); 11 verified findings, all fixed:
  - **Untrusted page input**: the previewed page controls every picked-element field.
    `describeSelectionForPrompt` now strips control chars/newlines (an injected
    `data-dsgn-source` can't open a new instruction paragraph), validates `source` to a
    `path:line` shape, and caps lengths (code-point/surrogate-safe); the preload also caps
    every field at capture. Full tool-approval gating is still the tracked roadmap item
    (permission cards) — the auto-approving agent is the real backstop to add next.
  - **Forged picks**: the preload now ignores non-`isTrusted` events, so a hostile page
    can't synthesize a click to inject a pick. The test correspondingly switched to a
    *trusted* `webContents.sendInputEvent` click (more faithful than synthetic dispatch).
  - **Stale selection**: opening another project now disarms select mode + clears the pick
    (was leaking a previous repo's source path into the composer); Escape-cancel clears the
    pick too.
  - **Auth banner** now auto-clears once the agent makes progress (was stuck until manually
    dismissed even after the user fixed auth).
  - **Lifecycle**: overlay re-arm is URL-gated (no crosshair on the "no project" placeholder)
    and `preview:reset` clears `selectModeActive` so main/renderer can't desync.
  - **Dead CSS**: `.btn--active` was shadowed by the later base `.btn` rule (equal
    specificity, source order) — the active toggle never rendered blue. Fixed via
    `.btn.btn--active`; the select test now asserts the active background is blue so it
    can't silently regress.

## 2026-06-23 — v2 first slice: click-to-select → source → chat

- **Select overlay** (`src/preview/preload.ts`): a sandboxed preload injected into the
  preview `WebContentsView`. Shadow-DOM hover highlight + click pick; captures tag,
  short CSS path, `data-dsgn-source` stamp (nearest-ancestor), text, rect, and a curated
  set of computed styles. Escape exits select mode. Built as a second preload entry
  (`electron.vite.config.ts` rollup input → `out/preload/preview.js`).
- **IPC**: renderer → main → preview `preview:set-select-mode`; preview → main → renderer
  `preview:element-picked` / `select-cancelled`, with a sender check so only the preview
  view can emit picks. Select mode is re-armed after each preview navigation.
- **UI**: a "Select" toggle in the titlebar (running only), an `Inspector` card above the
  composer (tag, resolved source or "no stamp" note, style chips), and a one-click
  "Ask dsgn to change this…" that seeds the composer with the element + source reference
  so the agent edits the right place. New `useSelection` store.
- **Convention**: `docs/DESIGN.md` documents the `data-dsgn-source` stamp + a reference
  Vite/Babel plugin (dev-only). Shared `SelectedElement` type so preload + renderer can't
  drift; added `tsconfig.preview.json` so the preview preload is type-checked.
- **Polish — first-run auth onboarding**: `isAuthError` heuristic flips an amber banner
  pointing at `claude setup-token` instead of burying a raw 401 in chat.
- **Tests**: `test/select-element.mjs` drives the full path (open fixture → enable select →
  dispatch a click in the preview webContents → assert inspector + source → assert composer
  hand-off) against a new `selectable-app` fixture; `chat-render` now also asserts the auth
  banner. ✅ `bun run verify` green (smoke, open-preview, chat-render, select-element);
  agent-e2e SKIPs cleanly without creds. Artifacts `06`/`07`/`08`.

## 2026-06-23 — Logging, cross-machine handoff, self-testing

- Added `CLAUDE.md` + `docs/{CONTEXT,PROGRESS,TASKS}.md` so progress/context/tasks
  live in-repo and travel via git (continue on any machine after `git pull`).
- Added `test/agent-e2e.mjs`: a REAL Claude turn that opens an editable fixture,
  asks the agent to change a heading, and asserts the file changed. SKIPs without
  auth, FAILs if the turn ran but didn't edit. Added `bun run verify`.
- ✅ Ran `bun run verify` with credentials present: **AGENT-E2E OK** — the agent
  edited the fixture via a live turn. Confirms end-to-end agent works and the SDK
  CLI subprocess spawns correctly inside Electron (prior runtime risk resolved).

## 2026-06-23 — Adversarial review fixes

- Ran a multi-agent review workflow (15 verified findings); fixed: session
  epoch-guard (no stale events across project switches), composer-stuck-on-switch,
  `sandbox:true` on main + preview windows, preview hardening (window-open handler +
  will-navigate origin pin + validate `preview:load` is local http(s)), per-outage
  retry reset, resize-drag release on blur/visibilitychange, `/` menu Escape re-arm,
  CSP `object-src`/`base-uri`.

## 2026-06-22/23 — Chat upgrade + controls + UX

- Markdown rendering (react-markdown + remark-gfm + rehype-highlight, hand-written
  hljs theme, plain CSS).
- Composer toolbar: model picker (live `setModel`), thinking/effort selector,
  `/` skill menu from the SDK init `slash_commands`.
- Drag-to-resize split (hides native preview during drag). Custom dev-command
  escape hatch on launch failure; Reload/Stop controls.

## 2026-06-22 — Real Agent SDK chat

- Wired `@anthropic-ai/claude-agent-sdk` (ESM, dynamic import): persistent
  multi-turn `query()`, cwd=repo, `settingSources` + `claude_code` preset,
  streaming deltas + tool status over IPC, `canUseTool` auto-approve.
- Fixed ESM-in-CJS crash; preview readiness polling + retry for `ERR_EMPTY_RESPONSE`;
  dev-server ownership + cleanup-on-quit + conflict errors.

## 2026-06-22 — Scaffold + preview + tests

- electron-vite + React + TS shell; two-pane layout; native `WebContentsView`
  preview with IPC geometry sync; typed `window.api`; dev-server runner
  (detect/spawn/parse/readiness). Playwright+Electron smoke + open→preview tests.
- Made dsgn its own standalone git repo.
