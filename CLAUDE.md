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
    index.ts        window + native WebContentsView preview (IPC geometry sync)
    devserver.ts    detect framework/PM, spawn dev server, parse URL, readiness
    static-server.ts in-process static file server for vanilla HTML/JS projects
                    (framework 'static': no package.json/dev command; live-reload)
    file-tree.ts    list a project's files (git ls-files / fs-walk) for the
                    pop-out editor's @pierre/trees sidecar (source:tree IPC)
    agent.ts        persistent multi-turn agent session (streams over agent:* IPC)
    backends/       provider seam: claude.ts, codex.ts, gemini.ts behind pickProvider
                    (gemini currently has NO SDK dep — treat as experimental)
    simulator.ts    iOS Simulator preview (Metro/Expo detect, MJPEG sim bridge)
    props.ts / props-svelte.ts   prop editing engines (React via react-docgen /
                    Svelte 5); they mirror each other's splice/apply contract
    styles.ts / styles-svelte.ts  CSS editing for the island's Styles tab: one
                    edit → Tailwind class rewrite, else inline-style splice,
                    else hand to the agent; tw-styles.ts + inline-style.ts are
                    the pure mapping/splicing halves
    style-tokens.ts re-resolves a design-token pick from the island (name+group
                    only) against the project's own tokens and decides what to
                    write — a `var(--name)` reference or a Tailwind token class
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
    setup.ts, scaffold.ts, xcode.ts
    diagnose.ts, diag-cache.ts, diag-rules.ts         sessions-store.ts, edit-history.ts
    update.ts       self-update detection (pure: fetch + rev-list behind-count)
    update-ipc.ts   update:* IPC + relaunch; "apply" shells out to bin/praxis.mjs
  preload/index.ts  contextBridge → window.api (contextIsolation on, sandboxed)
  preview/preload.ts  SECOND preload, injected into the PREVIEWED app's
                    WebContentsView: element select/hover, comments, annotations.
                    Own tsconfig (tsconfig.preview.json)
  shared/api.ts     the IPC contract — single source of truth for cross-process types
  shared/token-match.ts  which design tokens may be offered for a css property
                    and which one a computed value IS. Pure + used by BOTH main
                    (re-validating a pick) and the island (chips + picker)
  renderer/src/     React 18 UI: App.tsx, components/ (ChatPanel, PreviewPane,
                    PropPanel, CodeDrawer, Rail, …), zustand store.ts, shadcn ui/
                    components/styles/  the Styles tab's rows + controls
                    (ScrubInput, ColorControl, BezierEditor, TokenPicker)
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
- Commit in small, focused commits with the Co-Authored-By trailer.

## Gotchas (hard-won — read before debugging these areas)

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
