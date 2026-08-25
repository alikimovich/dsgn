# CLAUDE.md — working guide for Praxis

Praxis is an Electron app: an AI chat on the left that edits a user's repo, with
that repo's dev server live-previewed on the right. Distributed as source
(clone + `bun install` + `bun run dev`); each user authenticates with their own
provider subscription (`claude setup-token` / `claude login`; Codex and Gemini
backends exist behind the same seam).

The project's original name was **dsgn**. A repo-wide rename (2026-07) swept it
out of the code — the stamp is `data-praxis-source`, the sidecar is `.praxis/`,
work branches are `praxis/*`. The old name survives only in deliberate legacy
shims: setup uninstall removes old `.dsgn/` helpers, `git.ts` recognizes
`dsgn/*` work branches, `sidecar-migrate.ts` moves old sidecar data, `agent.ts`
migrates the old `<userData>/dsgn` dir, and the agent sidecar write-deny covers
both dir names. Don't "fix" those dsgn strings — and keep `docs/PROGRESS.md`
history as written.

## Start here every session

1. Read the top of `docs/PROGRESS.md` (newest-first log — recent state + the
   *why* behind decisions) and `docs/TASKS.md` (the roadmap / what's next).
2. When you finish a chunk, append to `docs/PROGRESS.md` and tick `docs/TASKS.md`.
3. **If your change contradicts something in this file or `README.md`, fix that
   doc in the same commit** — this file is auto-loaded into every session, so a
   stale claim here misleads every future agent. `test/docs-links.mjs` fails CI
   if a `src/…` path referenced here or in the README no longer exists.

## Commands

| Command | What |
| --- | --- |
| `bun run dev` | Launch the app (electron-vite, HMR) |
| `bun run build` | Build main/preload/preview/renderer to `out/` |
| `bun run typecheck` | Type-check all three tsconfig projects (node, web, preview). Run after every change |
| `bun run test:<name>` | One test (see package.json for ~40 aliases) |
| `bun run test` | Unit + Electron UI tiers (via `test/run.mjs`) |
| `bun run verify` | Everything incl. live-agent e2e (needs display + creds) |
| `bun run lint` | Biome lint over `src` + `test` |

Use **bun**, not npm/yarn. Node 22 (`.nvmrc`). `postinstall` runs
`scripts/patch-electron.mjs` (macOS-only, idempotent): it rebrands the dev
Electron.app bundle to Praxis — the dev bundle IS the product.

## Verify your own work WITHOUT asking the user

Tests come in three tiers, defined by the arrays in `test/run.mjs`
(`node test/run.mjs unit|electron|live|all`) — pick the cheapest that proves
your change:

1. **Pure-bun logic tests** (`bun test/pr-body.mjs` etc., ~15 files, the `unit`
   tier) — no build, no display, run in seconds. Always run the relevant ones.
2. **Playwright/Electron UI tests** (`node test/<name>.mjs` after
   `electron-vite build`, or `bun run test:<name>` which builds first) — drive
   the built app, screenshot to `test/artifacts/`. **Read the PNGs** to see
   the actual UI; that's how you confirm work visually without a human.
3. **Live e2e** (`test:agent`, `test:codex`, `test:sim-e2e`) — run a REAL
   provider turn / iOS simulator. They self-SKIP (exit 0) without credentials
   or a sim; they FAIL if the turn ran but didn't produce the edit.

While iterating, run targeted `test:<name>` scripts; before declaring a chunk
done, run `bun run typecheck && bun run test` (and `verify` when agent/sim
behavior changed). Note: the preview is a native `WebContentsView` — a
separate CDP target that does NOT appear in renderer screenshots; capture it
with `capturePage()` or read its URL via
`electronApp.evaluate(({webContents}) => ...)`.

## Architecture — four process boundaries

```
src/
  main/           Electron main (CJS, Node)
    index.ts        window + native WebContentsView preview (IPC geometry sync).
                    Owns the VIEWS: creates/raises/hides them, and owns the
                    untrusted preview's guards — its own session partition with
                    every permission denied, and a will-navigate/will-redirect
                    policy pinned to the origin main itself loaded
    preview-ipc.ts  every ipcMain handler that talks to (or about) that preview:
                    bounds/load/reset/capture, the select + comment relays, the
                    prop-panel island's plumbing, Styles reads, Layers. Owns no
                    view — index.ts hands it a `PreviewIpcHost` (accessors +
                    the shared `PreviewState`, which index.ts's did-finish-load
                    re-arm reads). The sandboxed preload can only be READ by a
                    request/reply round trip; `requestReply` is that pattern
                    once, shared by styles:read and layers:read
    devserver.ts    detect framework/PM, spawn dev server, parse URL, readiness
    static-server.ts in-process static file server for vanilla HTML/JS projects
                    (framework 'static': no package.json/dev command; live-reload)
    file-tree.ts    list a project's files (git ls-files / fs-walk) for the
                    pop-out editor's @pierre/trees sidecar (source:tree IPC)
    project-icon.ts the project's own favicon for its rail row (project:icon) —
                    a declared <link rel="icon"> first, else the conventional
                    paths; inlined as a data: URL, mtime-revalidated. Reads the
                    FILES, not the running page, so an un-run project has one too
    file-ops.ts     the same sidebar's file MANAGER — create/rename/delete
                    (source:create-file/rename-file/delete-file). Pure; every
                    renderer-supplied path is re-validated (no traversal, no
                    .git/.praxis/.dsgn/node_modules), delete goes to the OS trash
    media.ts / media-types.ts   the editor's media viewer: opening a .png/.mp4 must
                    SHOW it, not decode its bytes as utf8. media-types is the pure
                    half (ext→kind/MIME, binary sniff, HTTP Range parsing); media.ts
                    owns the `praxis-media://` protocol — main hands the renderer an
                    opaque per-file token, so the scheme can never be aimed at a path
                    the renderer chose. Streamed + range-servable (a <video> can't
                    seek otherwise, and a big one must not cross IPC as base64)
    agent.ts        persistent multi-turn agent session (streams over agent:* IPC)
    attachments.ts  gives a PASTED composer image a path (attachments:save writes
                    the clipboard bytes under <userData>/praxis/attachments so the
                    turn can tell the agent where the image it can see lives; a
                    DROPPED image needs no call — the renderer already has its
                    path). Pure fs+path; sanitizes the renderer-supplied name
    backends/       provider seam: claude.ts, codex.ts, gemini.ts behind pickProvider
                    (gemini currently has NO SDK dep — treat as experimental). A set
                    AgentOptions.connectionId routes to codex.ts whatever `provider` says.
                    codex-retry.ts is codex.ts's pure half (the CLI emits all five of its
                    retry attempts as separate `error` events; this collapses them into
                    one line that keeps the actual cause). interrupt.ts is the shared
                    "Stop must always work" helper — ask the backend nicely, then kill
                    (see the Gotcha on the SDK's untimed interrupt)
    codex-usage.ts  live token counts for a Codex turn: the SDK's event stream
                    reports usage only at `turn.completed`, so this tails the
                    CLI's own session rollout (`$CODEX_HOME/sessions/…jsonl`) for
                    its `token_count` records. Every reading is a running THREAD
                    total, so codex.ts DIFFS them (`usageDelta`), never sums
    providers-store.ts / providers.ts   v10 "connections" — user-added OpenAI-compatible
                    endpoints (AI Gateway, Groq, custom) so open models like Kimi/DeepSeek
                    can drive a chat. Same pure/main split as control-manifest vs
                    control-panels: the store takes an injected baseDir + SecretCipher (so
                    it unit-tests without electron), while providers.ts owns the
                    safeStorage cipher, the providers:* IPC, the /models catalog probe,
                    the picker's ModelChoice list, and resolveConnection() — the seam
                    backends/codex.ts aims the Codex SDK at
    model-catalog.ts / codex-models.ts   what the two BUILT-IN seats offer, discovered
                    instead of curated. model-catalog is the pure half (parsers + a TTL
                    cache with injected clock/baseDir, persisted under userData);
                    codex-models runs `codex debug models` on the SDK's OWN vendored
                    binary, not PATH. Claude needs a live session (Query.supportedModels()),
                    so backends/claude.ts hands its answer back via recordClaudeModels;
                    providers.ts only schedules the refresh, never on the render path
    simulator.ts    iOS Simulator preview (Metro/Expo detect, MJPEG sim bridge)
    props.ts / props-svelte.ts   prop editing engines (React via react-docgen /
                    Svelte 5); they mirror each other's splice/apply contract
    styles.ts / styles-svelte.ts  CSS editing for the island's Styles tab: one
                    edit → Tailwind class rewrite, else merge into an EXISTING
                    inline style, else hand to the agent; tw-styles.ts +
                    inline-style.ts are the pure mapping/splicing halves
    style-tokens.ts re-resolves a design-token pick from the island (name+group
                    only) against the project's own tokens and decides what to
                    write — a `var(--name)` reference or a Tailwind token class
    move-node.ts / move-node-svelte.ts / move-node-html.ts   the Layers panel's
                    drag-to-reorder engines (React/Svelte/static HTML): same-
                    parent sibling reorder writes real source; anything
                    ambiguous (shared stamp, cross-file, templated by a
                    .map()/{#each}) → needsAgent. move-node-splice.ts is the
                    shared, dependency-free rebuild-from-scratch splice all
                    three call; ast-walk.ts is the shared parent/ancestor walk
                    (React + Svelte; static HTML uses its own, to dodge parse5's
                    parentNode back-references)
    control-manifest.ts / control-panels.ts   AI-surfaced control panels:
                    validate + anchor-lex + render literals (pure) and the
                    main-owned .dsgn/control-panels.json store + controls:* IPC
    tokens.ts       design-token detection/scaffold   annotations.ts  comments → PR
    spring.ts       pure spring→CSS linear() engine (vendored from ~/dev/spring2css);
                    powers the spring_to_css agent tool in backends/claude.ts
    apca.ts         APCA (Lc) contrast checker + accessible-color suggester
                    (adapted from ~/dev/apca-cli; apca-w3 + colorparsley loaded via
                    dynamic import — ESM-only); powers the check_contrast agent tool
    fluid.ts / oklch.ts / shadows.ts   pure design-system calculators powering the
                    fluid_clamp (Utopia clamp() math), color_scale (OKLCH tonal ramp
                    + gamut map) and layered_shadow (multi-layer box-shadow) agent tools
    type-metrics.ts pure line-height + letter-spacing recommender (size-aware,
                    WCAG-floored leading; Material-3 tracking); powers the line_height agent tool
    skill-packs.ts / skills-install.ts   curated allowlist catalog of external "taste"
                    skills + the `npx skills add --copy` runner; power the
                    list_recommended_skills (pure) and install_skills (side-effecting) agent tools
    git.ts, worktrees.ts, chat-worktrees.ts, chat-isolation.ts
                    git/worktree primitives; worktrees: per-chat isolation + sync/merge/recovery;
                    chat-worktrees: turn-scoped ops (sync, commit, apply); chat-isolation: lifecycle
    live-commit.ts  one commit per turn on the LIVE checkout (pure): stages only the
                    files that turn changed, partial-commits so the user's own staged
                    work is untouched, skips non-repo-root projects, never throws
    publish-scope.ts  what a session changed / is there anything to publish (pure) —
                    measured against the default branch, since committed turns leave
                    nothing to see in a HEAD-relative diff. Used by annotations.ts
    setup.ts, scaffold.ts, xcode.ts
    diagnose.ts, diag-cache.ts, diag-rules.ts         sessions-store.ts, edit-history.ts
    update.ts       self-update detection (pure: fetch + rev-list behind-count)
    update-ipc.ts   update:* IPC + relaunch; "apply" shells out to bin/praxis.mjs
  preload/index.ts  contextBridge → window.api (contextIsolation on, sandboxed)
  preview/preload.ts  SECOND preload, injected into the PREVIEWED app's
                    WebContentsView: element select/hover, comments, annotations.
                    Own tsconfig (tsconfig.preview.json)
  preview/layers.ts DOM tree walk + child-index-path node resolution for the
                    Layers panel (bulk read, panel-driven select/hover, the
                    structural MutationObserver watch) — split out of preload.ts,
                    which only wires the IPC into it
  preview/style-provenance.ts  proves a style property's value comes from a
                    design token instead of merely equalling one: reads the
                    SPECIFIED (unresolved) declaration — inline `style=` or a
                    matched stylesheet/scoped-`<style>` rule — since
                    `getComputedStyle` always resolves `var()` away and so can
                    never tell "is" from "coincidentally equals". Threaded
                    through `styles:read` as `declaredVars`
  shared/api.ts     the IPC contract — single source of truth for cross-process types
  shared/preview-channels.ts  the raw channel NAMES for the one IPC surface api.ts
                    can't type: main ⇄ the sandboxed preview preload (no
                    contextBridge there, so it's bare `ipcRenderer` strings).
                    Imported by BOTH ends (src/main/preview-ipc.ts + index.ts,
                    and src/preview/preload.ts) — never re-declare one locally
  shared/token-match.ts  which design tokens may be offered for a css property
                    and which one a computed value IS. Pure + used by BOTH main
                    (re-validating a pick) and the island (chips + picker)
  shared/run-stats.ts  the chat status line's numbers: main normalizes each
                    provider's usage payload + dedupes its repeated cumulative
                    readings into `usage` event deltas, the renderer sums and
                    formats them (RunStats.tsx, next to the cat)
  shared/style-props.ts  the Styles panel's v1 editable CSS-property allowlist
                    (the `StyleProp` union). main/styles.ts derives its
                    `STYLE_PROPS` from it (the actual write-time boundary);
                    renderer/src/lib/css-values.ts's `STYLE_PROP_META` is
                    `satisfies`-checked against it, so the two can't drift
                    apart by hand again
  renderer/src/     React 18 UI: App.tsx, components/ (ChatPanel, PreviewPane,
                    PropPanel, CodeDrawer, Rail, LayersPanel + LayersTree, …),
                    zustand store.ts, shadcn ui/
                    components/styles/  the Styles tab's rows + controls
                    (ScrubInput, ColorControl, BezierEditor, TokenPicker)
                    SettingsDialog.tsx + ProviderForm.tsx  the v10 Settings dialog
                    (Models & Providers): default model (last-used or a fixed pick),
                    add a connection, probe its catalog, tick models.
                    preferred-model.ts is the pure last-used/fixed resolver (kept
                    OUT of store.ts). providers-store.ts is the connections slice.
                    composer-drafts.ts  the composer's unsent text + attachments,
                    keyed by chat (ChatPanel is mounted once for the whole app, so
                    component state would follow the user into the next chat)
  ../bin/praxis.mjs the `praxis` CLI (launch + `--update`); owns the update
                    sequence (git pull + bun install + build). ../install.sh boots it.
test/             hand-rolled .mjs tests + fixtures/ + artifacts/ (PNGs, gitignored)
docs/             TASKS (next) / PROGRESS (log + rationale) / DESIGN (stamp spec)
```

- **Lifecycle:** `install.sh` (curl one-liner) clones to `~/.praxis`, builds, and
  puts `praxis` on PATH. `praxis` launches the built app; `praxis --update` pulls
  + rebuilds. The app checks its git remote in the background (`update-ipc.ts`)
  and offers an in-app "Update & Restart" that runs `praxis --update` and relaunches.

- The chat runs in `main` via provider SDKs; output streams over `agent:*` IPC
  into the zustand store. The store is the seam between transport and UI.
- Praxis **owns** the dev-server lifecycle of the target repo (never run the
  target's `dev` manually); it's killed on app quit.

**Why it's built this way (non-obvious choices):**
- **Agent core = SDK in-process** (not ACP/subprocess): the product's custom
  tools (select element → edit props → annotate → PR) are wired to the renderer
  and need in-process SDK tools.
- **Preview = native `WebContentsView`, not an iframe**: so a preload can be
  injected into the previewed app for element selection (a cross-origin iframe
  couldn't).
- **Prop editing is hybrid**: simple literals splice straight into source (instant
  HMR); complex/expression values fall back to the agent. React and Svelte have
  separate engines because their ASTs differ; selection/tokens are framework-
  agnostic (they only need the `data-praxis-source` stamp — see `docs/DESIGN.md`).

## Conventions

- **Tailwind CSS v4 + shadcn/ui** in the renderer (decision reversed from
  plain-CSS on 2026-06-26). Legacy custom-property CSS still lives in
  `renderer/src/styles.css`; prefer Tailwind utilities + shadcn primitives for
  new UI, and migrate legacy rules out of styles.css when you touch them.
- **Never invent a new font-size or line-height** — reuse one already in use,
  unless the user explicitly asks for a new one. There's no formal type-scale
  token (no `--text-sm`/`--text-base` CSS vars); the de facto scale is
  whichever `text-[Npx]` values already recur across `components/` — as of
  this writing: `9px, 10px, 10.5px, 11px, 11.5px, 12px, 12.5px, 13px` (plus
  the standard Tailwind `text-sm`/`text-base`/etc. for normal body text).
  Before adding a small/muted label, grep for the closest existing sibling
  (e.g. `.proppanel__source`, `.notes__where`) and match its exact class
  string rather than picking a new number. Line-height is simpler: always
  Tailwind's named scale (`leading-none`, `leading-snug`, `leading-5`, …),
  never an arbitrary `leading-[Npx]` — grep confirms no component uses one.
- The Claude Agent SDK is **ESM-only** — `main` is CJS, so it's loaded via
  dynamic `import()` in `agent.ts`/`backends/` (never static/`require`).
- All cross-process types go in `src/shared/api.ts`; keep `PraxisApi`, the
  preload bridge, and the ipcMain handlers in sync — a change to one is a
  change to all three.
- New test = new `.mjs` in `test/` **plus** its name in the right tier array in
  `test/run.mjs` (`unit` / `electron` / `live`). `bun run test` and `verify`
  dispatch through the runner — don't hand-edit `&&` chains.
- Keep files under ~500 lines; extract instead of appending to `App.tsx`,
  `store.ts`, or `styles.css` (already oversized — see `docs/TASKS.md`).
- Auth is per-user at runtime; never commit secrets. Nothing sensitive in-repo.
  The two built-in seats use subscription login (Claude `setup-token` / Codex
  sign-in-with-ChatGPT). A v10 *connection* is the one path that uses an API key —
  the user's own, encrypted with `safeStorage` under userData and confined to main.
  It must never reach the renderer, argv, a log line, or an error string; the
  renderer only ever observes `hasKey`.
- Commit in small, focused commits with the Co-Authored-By trailer.

## Gotchas (hard-won — read before debugging these areas)

- **Native menu accelerators beat renderer keydown — and tests can't see it.**
  A menu item's accelerator (incl. every `role:` item's built-in one)
  intercepts the PHYSICAL keystroke in the main process; a renderer
  `window.addEventListener('keydown')` for the same combo never fires. But
  synthetic/CDP-injected key events (Playwright, `sendInputEvent`) BYPASS menu
  accelerators, so a test of that keydown handler passes while a real keyboard
  is broken. This shipped a dead Cmd+Z source-undo behind `role: 'editMenu'`
  for weeks. Rule: any app shortcut that a menu (or a role) also claims must be
  handled via the menu item's `click` → `menu:action`, not a renderer keydown;
  and Edit→Undo/Redo route by focus (`buildAppMenu`'s `editCommand` +
  App.tsx's menu-action handler + `menu:native-edit` for focused text fields).
- **The Agent SDK's `interrupt()` can never return, so Stop must not just await it.**
  It's a CONTROL REQUEST: the SDK resolves it only when the CLI subprocess sends a
  matching `control_response`, and there is no timeout anywhere in that path. A
  wedged subprocess (symptom: turn running for minutes, `↑0 ↓0`) therefore made
  Stop a dead button — the IPC never resolved, and since `done` is only emitted
  from a `result` message, the spinner ran forever. The kill switch was present
  the whole time (`shutdown()`'s `abort.abort()`) but only teardown reached it.
  Any future backend cancel must bound itself the same way — go through
  `backends/interrupt.ts`, and report `hardStopped` so agent.ts rebuilds the dead
  session. Codex was always safe here (its cancel is a local AbortController);
  Gemini had no `interrupt` at all, so Stop silently did nothing.
- **Never run an Electron test directly — it uses your REAL app state.**
  `node test/chat-render.mjs` launches against the live `userData`, so if any
  project is currently open there the empty state (`openCount === 0`) never
  renders and the test dies on `waitForSelector('.empty__open')` after 15s.
  `test/run.mjs` gives every test a fresh `PRAXIS_USER_DATA` temp dir, which is
  why the same test passes through `bun run test:<name>` / `bun run test`. This
  trap cost real time twice: it produced three separate TASKS notes claiming
  "the Electron tier can't launch a window on this machine, confirmed at HEAD"
  (all wrong, all corrected 2026-08-07) and it makes stash-and-compare baselines
  meaningless, since both sides fail for the same bogus reason. If you must run
  one by hand: `PRAXIS_USER_DATA=$(mktemp -d) node test/<name>.mjs`. Note the
  runner also spawns bare `electron-vite`, so it needs `node_modules/.bin` on
  PATH — invoke it via `bun run test`, not `node test/run.mjs`.
- **ESM/CJS**: the Agent SDK is ESM-only, `main` is CJS → dynamic `import()`
  only, never static/`require`.
- **The preview `WebContentsView` is a separate CDP target** — not in renderer
  page screenshots (use `capturePage()`), and it eats mouse events (hidden
  during resize drag). Drive it from a test via the main process
  (`webContents.executeJavaScript`), as `test/select-element.mjs` does.
- **A renderer DOM panel can't float *above* the native preview** (native views
  render over the page). Panels reserve a strip instead, shrinking the native
  bounds via `usePanelInset`: the prop panel takes the **right** edge, the v9
  code drawer the **bottom**.
- **The preview overlay preload is sandboxed** — only `ipcRenderer` (no Node, no
  contextBridge), shares the page DOM via a `pointer-events:none` shadow root,
  and re-runs on every navigation, so `main` re-sends the current select-mode on
  `did-finish-load`.
- **Prop editing is gated** on `PropInspection.hasSchema` (a resolved
  react-docgen/svelte schema). Unready components are prompt-only; the on-open
  setup offer instruments them.
- **The Styles ladder never INTRODUCES a styling convention.** S2 merges into a
  `style` attribute that already exists; it will not create one, and the S3
  prompt explicitly forbids the agent from creating one either. Re-adding an
  insert-when-absent branch to make edits feel snappier would push inline styles
  into projects that style from a stylesheet or a Svelte scoped `<style>` block
  — where the inserted attribute also silently outranks that block forever after.
  An element with no class and no `style` is SUPPOSED to cost an agent turn.
  (Note S1 has the mirror-image gap: it can only rewrite an existing class
  string, never add one, so Tailwind projects pay that turn too.)
- **Dev CDP**: `bun run dev` opens `--remote-debugging-port` 9222 (override
  `PRAXIS_DEBUG_PORT`; dev-only). Inspect either target via Chrome
  `chrome://inspect#devices`; Playwright's `_electron` still can't reach the
  preview as a page target. On Chrome 111+ attach failures, add
  `app.commandLine.appendSwitch('remote-allow-origins', 'devtools://devtools')`.
- **bun blocks postinstall for untrusted deps** — `electron`/`esbuild` are in
  `package.json#trustedDependencies` so their binaries install.
- **The agent is denied writes under a target repo's `.praxis/` (and legacy `.dsgn/`)** (annotations,
  scaffolded instrumentation, and control-panel manifests live there). The
  `define_controls` tool exists precisely because of this: the agent hands main
  a manifest and main is the only writer.
- **A control-panel manifest stores no values.** Every value is re-resolved from
  source on lookup (literal → lex the literal after the anchor; prop → the live
  inspection; style → computed styles), so an edit that moves a constant is
  harmless and one that renames it just marks the param stale. Anchors must
  occur exactly once — re-checked at save AND at every apply, so a drifted
  anchor can never splice the wrong site. Only main renders spliced literals;
  agent- and renderer-supplied strings are never written verbatim.
- **A tool callback's `root` is the chat's WORKTREE, not the live tree.**
  Anything persisting app state must use `SpawnContext.liveRoot` (threaded from
  every `agent.ts` startSession call site) — `define_controls` validates anchors
  against the worktree file the agent just wrote, but saves to the live root.
- **Chats run in per-chat worktrees (praxis/chat-<id>), auto-merged back to the
  live tree on each turn's done/error.** The preview ALWAYS serves the live
  checkout, never a worktree. Non-repo-root projects (subdirs, non-git) run on
  the live tree as today (`isRepoRoot` gate in git.ts). Resumed sessions get a
  fresh worktree; the model picker (agent:restart-chat) reuses the existing one.
  Drift from concurrent live edits syncs at turn start; conflicts park on the
  branch for review. One worktree per open chat costs disk (~node_modules are
  symlinked); worktree directories live under `<userData>/praxis/worktrees`.
- **A worktree's symlinked node_modules/.env must be excluded by NAME, never via
  the target's `.gitignore`.** They're symlinked into every worktree so it can
  build, but a `.gitignore` pattern with a trailing slash (`node_modules/`, the
  Next.js/CRA/Vite default) is *directory-only* and git never treats a symlink as
  a directory — so it fails to match the symlink. Left to `.gitignore`, the
  symlink is staged by `git add -A`, the turn-end auto-merge chokes reading it
  (`EISDIR` → the whole batch is refused), and EVERY turn parks with `node_modules`
  in the conflict card (this shipped, user-reported 2026-08-08). `worktrees.ts`
  exports `RUNTIME_DEPS` and unstages it in `captureBase`/`commitWorktree`;
  `chat-worktrees.ts` spares it from `git clean` with `-e` (`cleanArgs`). Never
  re-route these through `.gitignore`, and keep any scaffolded `.gitignore`
  slash-free. `.env` (rule has no slash) hides the bug — it DOES match the symlink,
  so only `node_modules` leaks; don't let that asymmetry mislead the diagnosis.
- **The merge onto the live tree is also COMMITTED there — one commit per turn**
  (`live-commit.ts`, called from `chat-isolation.ts` + the comment-spawn
  finalizer). Only the files that turn changed are staged, and it's a pathspec
  (partial) commit, so a user's unrelated dirty/staged work is never swept in.
  Consequence for anything that asks "what did this session change?": a diff vs
  `HEAD` now returns nothing — compare against the merge base with the default
  branch instead (`src/main/publish-scope.ts` does, for the publish paths).
- **Never hardcode a built-in seat's model list.** It rots invisibly: the picker
  offered "GPT-5 Codex"/"GPT-5" for months after the Codex CLI moved to the
  GPT-5.6 family, so a user's first act was to pick a model that no longer
  existed. Both harnesses can be ASKED (`src/main/model-catalog.ts`), and the
  arrays left in `providers.ts` are a last resort for "we could not ask", not
  curation. Two traps if you touch this: the Codex binary to ask is the SDK's
  VENDORED one (`@openai/codex-<plat>/vendor/…/bin/codex`), never the `codex` on
  PATH — a global CLI of a different version would answer for a binary that
  never runs the turns; and `Query.supportedModels()` leads with its own
  `{value:'default'}`, which collides with praxis's "Default" sentinel, so a
  discovered `default` is dropped in favour of ours (`agentModelId` maps that
  exact string to "send no model").
