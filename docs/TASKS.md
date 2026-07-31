# TASKS

Roadmap / next steps. Tick items as you finish them and log in PROGRESS.md.
Full narrative for shipped work lives in `docs/PROGRESS.md`.

## Design-token naming accuracy (2026-07-30, user-reported)

- [x] **A token from another property family can't name a row.** ✅ 2026-07-30 —
      `--rmt-radius-none` was labelling `padding: 0`. `groupAffinity` (a coarse
      `TokenKind`) became `groupRole` (a semantic `TokenRole`), and naming is now
      stricter than offering: a radius token stays in the picker for padding but
      can't label it. Neutral groups and explicit picks are exempt.
      `src/shared/token-match.ts`, `test/token-match.mjs`. See PROGRESS 2026-07-30.
- [ ] **`sameCssValue` doesn't equate bare `0` with `0px`.** Found while writing
      the above. A theme declaring `--space-0: 0` (unitless — legal CSS, and
      `tokenValueKind` already accepts it as a length) can never match a computed
      `0px`, so that token is offered but never names anything. Fix belongs in
      the renderer's `css-values.ts` comparator; it shifts matching for every
      property, so it wants its own pass.

## Styles ladder — respect the project's styling convention (2026-07-30, user-requested)

- [x] **Never INTRODUCE an inline style.** ✅ 2026-07-30 — S2 now only extends a
      `style` attribute that already exists; absent → S3, whose prompt names the
      project's own approaches and forbids the agent from adding one either.
      Fixes a token pick writing `style="color: var(--color-title)"` onto a bare
      `<h1>` in a CSS-variable project. `src/main/styles.ts`,
      `styles-svelte.ts`; contrast case + `BareCard` fixture in
      `test/style-edit.mjs`. See PROGRESS 2026-07-30.
      Deliberately NOT planned (dropped 2026-07-30, user call): teaching S1 to
      CREATE a class attribute for Tailwind projects. The mirror-image gap is
      real — an unclassed element in a Tailwind project pays an agent turn it
      shouldn't — but reliable project-level Tailwind detection is the blocker
      (v4 is CSS-first and often ships no `tailwind.config.*`), and agent-routing
      it is correct, just slower.
- [ ] **A runnable tier for the styles ladder.** `style-edit.mjs` is electron-only
      and can't launch a window on the current dev machine (dies at
      `.empty__open`, at HEAD too), so the S2-refusal assertion is written but
      unrun. Verified instead with a throwaway esbuild-bundled harness driving
      the real `applyStyleEdit` in node (PROGRESS 2026-07-30 has the details).
      Worth making permanent if the Electron tier stays unrunnable.

## Layers panel (2026-07-29, user-requested) — SHIPPED

- [x] **DOM tree + click-select + drag-to-reorder.** ✅ 2026-07-29 — a tree of
      the previewed page above the chat, toggled from the composer. Selecting
      a row reuses the real in-page click path; dragging writes a real source
      edit for a same-parent sibling reorder (React/Svelte/static HTML), and
      seeds a chat prompt for anything ambiguous (list items, reparenting,
      cross-file). New `src/preview/layers.ts`, `src/main/move-node*.ts`,
      `src/main/ast-walk.ts`, `LayersPanel.tsx`/`LayersTree.tsx`.
      `test/layers-move.mjs` (unit), `test/layers-panel.mjs` (electron, new
      `test/fixtures/layers-app/`). See PROGRESS 2026-07-29.
      Deliberately NOT planned (dropped 2026-07-30, user call): reparenting /
      cross-parent / cross-file moves stay agent-routed; label live-refresh
      and tree virtualization only if real use demands them.

## Design tokens in the Styles panel (2026-07-28, user-requested) — SHIPPED

- [x] **Name the token instead of the value, and offer a picker.** ✅ 2026-07-28
      — every token-able row (colors, padding/margin/gap, radius, font-size /
      -weight, line-height, letter-spacing, opacity) shows the matching token's
      name and expands an inline `TokenPicker`; picking one writes a *reference*
      (`var(--name)` / a Tailwind token class), never the resolved value.
      New `src/shared/token-match.ts` + `src/main/style-tokens.ts`,
      `TokenSet` on `PanelState`, `.less`/`.sass` detection. `test/token-match.mjs`,
      extended `tw-styles.mjs` / `tokens.mjs` / `style-edit.mjs`. See PROGRESS 2026-07-28.
      Deliberately NOT planned (dropped 2026-07-30, user call): Svelte
      scoped-`<style>` editing (token picks there keep seeding the agent),
      "save this value as a token", and deleting the dead `props:applyToken`
      path (dead-but-harmless; only `test/prop-edit*.mjs` exercise it).

## Vanilla HTML / static sites (2026-07-09, user-requested) — SHIPPED

- [x] **Open plain HTML/CSS/JS projects.** ✅ 2026-07-09 — `detect()` falls back
      to `framework:'static'` for folders with an HTML entry and no runnable dev
      command; a new in-process `src/main/static-server.ts` serves them (with
      live-reload). Anything un-auto-launchable now errors with "Enter a command
      to launch this project", which the preview error bar already turns into a
      custom-command retry. `test/static-serve.mjs`.
- [x] **Don't offer/greypanel setup on a project that can't be instrumented.**
      ✅ 2026-07-27 — `setup:detect` read-only probe (`{ framework, canInstrument }`);
      the on-open offer gates on `canInstrument` (no dead-end "Set it up" on a
      static/vanilla repo) and the Styles tab's no-source state shows tailored
      guidance + an "Ask Praxis to restyle it" seed instead of greyed controls.
      Extended `test/setup-detect.mjs`. See PROGRESS 2026-07-27.
- [ ] **Follow-up:** driven screenshot test for the static path — offer absent +
      StylePanel read-only guidance rendered on a JS-generated (no-source) element.

## v9 — in-tool code view  ⭐ (2026-07-03, user-requested) — SHIPPED

- [x] **Phase 1 — read-only code peek + open-in-editor.** ✅ 2026-07-03 — a "Code"
      toggle on the Inspector shows the stamped file (highlight.js, line-number
      gutter, element line-span marked, auto-scrolled to the stamp) via a new
      `source:read` IPC; `source:open-in-editor` jumps to `file:line:col` in
      code/cursor/zed/subl (fallback: OS default app). `test/code-peek.mjs`.
- [x] **Phase 2 — editable code drawer.** ✅ 2026-07-02 — CodeMirror 6 in a bottom
      drawer under the preview. Save (⌘S) routes through `source:write` →
      `commitEdit`, so undo/redo + HMR are free; a stale-baseline write is refused
      as a conflict. `test/code-drawer.mjs`.
      **Known limit:** the floating PropPanel overlaps the drawer's top-right in a
      narrow window — complementary but unaware of each other's inset.
- [x] **Phase 3 — pop the drawer out into its own window.** ✅ 2026-07-14 (LKM-48)
      — a pop-out button opens the editor in a standalone, freely-resizable
      `BrowserWindow` (same renderer bundle via `?praxisEditor=1`, new `EditorWindow`
      entry + `CodeDrawer` `variant="window"`). One window per project root;
      re-focuses + retargets on a repeat pop-out. `source.popout/closeWindow/
      onNavigate` IPC. `test/code-drawer.mjs`.
- [x] **Phase 4 — file-tree sidebar in the pop-out.** ✅ 2026-07-20 — the pop-out
      window gains a left file tree (`@pierre/trees`, vanilla/shadow-DOM entry so
      it's decoupled from the renderer's React 18). Click a file → opens in the
      shared drawer store. `src/main/file-tree.ts` + `source:tree` IPC list the
      project (git ls-files, fs-walk fallback). `test/file-tree.mjs`. Also renamed
      the toolbar "Editor" button → "IDE" and dropped the pop-out's redundant
      close button (native traffic lights close it).

## Per-chat worktree isolation (2026-07-16, concurrent-chat safety) — SHIPPED

- [x] **Isolate concurrent chats in per-repo worktrees.** ✅ 2026-07-16 —
      Every interactive chat on a git repo root gets its own long-lived worktree
      on branch `praxis/chat-<id>`, created before `startSession` and removed on
      close. Turn edits commit to the worktree branch; on `done`/`error` they
      auto-merge to the live tree (the preview always serves live, never a
      worktree). Conflicts park on the branch for review via the existing
      `SessionReview` UI. `src/main/chat-worktrees.ts` (turn operations),
      `src/main/chat-isolation.ts` (lifecycle + crash recovery), extended
      `src/main/worktrees.ts` (C1 primitives), `test/chat-worktrees.mjs` (unit),
      `test/chat-isolation.mjs` (Electron).
- [x] **Parked-conflict UX — sidebar badge + AI "Resolve it".** ✅ 2026-07-16 —
      a parked live chat shows an amber "conflict" badge in the rail, and an
      in-chat `ConflictCard` explains the collision in plain language and offers
      **Resolve it** (the AI reconciles both sides — `stageResolve` re-lays the
      chat's diff onto the user's live tree, then either auto-merges cleanly with
      no turn or runs a resolution turn on the conflict markers) / **Discard
      changes**. New `agent.resolveConflict`/`discardConflict` IPC keyed by the
      active session; `src/renderer/src/components/ConflictCard.tsx`;
      `stageResolve` + `resolveParkedChat`/`discardParkedChat`; extended
      `test/chat-worktrees.mjs`.

## v10 — Styles tab + AI-surfaced control panels (2026-07-18, user-requested) — SHIPPED

- [x] **Dialkit-style Styles tab.** ✅ 2026-07-18 — the island gained a
      `Props | Styles` switch; scrub-to-adjust controls over the v1 CSS set with
      live preview injection, committing via Tailwind class rewrite → inline
      splice → agent fallback through `commitEdit`. `src/main/styles.ts`,
      `styles-svelte.ts`, `tw-styles.ts`, `inline-style.ts`,
      `src/renderer/src/lib/css-values.ts`, `components/StylePanel.tsx` +
      `components/styles/{ScrubInput,ColorControl,BezierEditor}.tsx`.
      `test/{tw-styles,inline-style,css-values}.mjs`, `test/style-edit.mjs`.
- [x] **Transitions + cubic-bezier editor.** ✅ 2026-07-18 — duration/delay/
      property plus a draggable bezier editor with preset snap and replay.
- [x] **AI-surfaced control panels.** ✅ 2026-07-18 — "Surface controls with AI"
      runs a real agent turn that instruments the source and calls a new
      `define_controls` tool; main validates and owns
      `.praxis/control-panels.json`; the Custom tab renders the manifest with the
      Styles primitives. `src/main/control-manifest.ts`, `control-panels.ts`,
      `components/CustomPanel.tsx`, `lib/controls-prompt.ts`.
      `test/control-panels.mjs` (unit), `test/custom-controls.mjs` (Electron),
      `test/controls-agent.mjs` (live).

**Follow-ups (not started):**

- [ ] **Springs / framer-motion animation params.** v1 is CSS transitions only;
      a spring config isn't a single CSS value, so it needs its own control
      shape and a library-aware apply path.
- [ ] **More style properties** — width/height, box-shadow, per-corner radius,
      borders, position/inset; each needs a family mapping + a sane control.
- [ ] **Responsive / state variants** (`hover:`, `md:`) — the rewrite currently
      treats variant-prefixed classes as neither candidates nor blockers, so
      editing them at all is unimplemented, not merely unsupported.
- [ ] **Auto re-pick after navigation.** A full navigation wipes the preview
      preload's selection; the panel asks for a manual re-click today.
- [ ] **`define_controls` for Codex/Gemini.** Those backends get no custom
      tools, so they fall back to instrument-as-props. A per-backend bridge
      (or a file-based manifest hand-off main picks up) would close the gap.

## Health / infra (from the 2026-07-07 review)

Ranked by leverage. Deferred items note *why* they're not auto-completable.

- [x] **Test runner to replace the package.json mega-chains.** ✅ 2026-07-07 —
      `test/run.mjs` (`node test/run.mjs unit|electron|live|all`): keep-going,
      exit-0=pass (incl. e2e self-SKIP), builds once before the electron tier,
      summary table, non-zero exit on any failure. `test` = `unit electron`,
      `verify` = `all`; the ~40 `test:*` aliases are unchanged. Verified: unit
      tier 15/15 green.
- [x] **CI.** ✅ 2026-07-07 — `.github/workflows/ci.yml`: checkout → setup-bun
      1.3.x → `bun install --frozen-lockfile` → `bun run typecheck` →
      `node test/run.mjs unit`. Electron/live tiers left for a macOS runner (noted
      inline).
- [x] **Lint/format tool.** ✅ 2026-07-07 — Biome 2.5.2 (dev dep) + `biome.json`
      tuned to the existing style (2-space, single quotes, no semicolons, width
      100); `lint`/`format` scripts. The repo-wide `biome check --write` reformat
      is deliberately NOT done — run it as its own commit when ready.
- [x] **Gemini backend gated.** ✅ 2026-07-07 — `pickProvider` returns Claude for
      `provider:'gemini'` unless `PRAXIS_EXPERIMENTAL_GEMINI=1`; `gemini.ts` banner
      marks it experimental/unwired; removed from the renderer picker so it can't be
      silently selected. Add the SDK dep + a self-skipping e2e test to un-gate.
- [ ] **Shared test harness.** 55 `.mjs` tests re-derive root + Playwright/Electron
      launch (~6.2k lines, much boilerplate). Add `test/lib/harness.mjs`
      (`launchApp`, `openFixture`, `shot`) and migrate opportunistically.
      *Deferred: large, migrate-when-touched, not a single-shot task.*
- [ ] **Split the god files.** `App.tsx` (1646), `styles.css` (1836), `props.ts`
      (1189), `simulator.ts` (1169), `store.ts` (981). Extract, don't append.
      *Deferred: high-risk refactor; needs the Electron UI running to verify, which
      isn't possible headless — do interactively with the app open.*
- [x] **Rename the `dsgn` internals to Praxis.** Done 2026-07-17: `data-praxis-source`,
      `PraxisApi`, `.praxis/`, `praxis/*` branches, `<userData>/praxis`. Clean break for
      stamped target repos (re-run setup); legacy shims cover uninstall, old work
      branches, and one-time sidecar/userData migration. See PROGRESS 2026-07-17.
