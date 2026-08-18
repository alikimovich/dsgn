# TASKS

Roadmap / next steps. Tick items as you finish them and log in PROGRESS.md.
Full narrative for shipped work lives in `docs/PROGRESS.md`.

> **The Electron tier runs on a machine with NO display** (found 2026-08-12),
> which the 2026-08-07 correction below didn't cover: after an
> `electron-vite build`, `PRAXIS_USER_DATA=$(mktemp -d) xvfb-run -a node
> test/<name>.mjs` launches a real window under a virtual X server, screenshots
> and all. So "needs a display" is no longer a reason to leave an electron-tier
> assertion unrun anywhere below.

## Default model + Main surviving reload (2026-08-18, user-requested) — SHIPPED

- [x] **New chats follow last-used, or a Settings default.** ✅ 2026-08-18 —
      Claude is no longer hardcoded as the only fallback. `preferred-model.ts`
      remembers the last picker choice (any chat) and Settings → Models can pin
      a specific model instead. Existing chats keep their own `chatSettings`.
      See PROGRESS 2026-08-18.
- [x] **Main keeps its thread across quit/relaunch.** ✅ 2026-08-18 — closing or
      quitting persists Main as `slot: 'main'` (hidden from History). The next
      `open-project` restores the transcript in place and resumes the Claude SDK
      session when it can. **Clear context** is still what archives it into
      History. `test/agent-history.mjs`, `test/restore-reload.mjs`.

## A project's favicon leads its rail row (2026-08-12, user-requested) — SHIPPED

- [x] **Show the project's own favicon instead of the folder icon.** ✅ 2026-08-12
      — new `src/main/project-icon.ts` resolves an icon from the project's source
      tree (declared `<link rel="icon">` first, then the conventional paths) and
      inlines it as a `data:` URL over a new `project:icon` IPC; a
      `useProjectIcons` store feeds `Rail.tsx`, where the `<img>` rides
      `.rail__folder` so it keeps the 16px slot and the hover-to-chevron
      cross-fade. Reads FILES, not the running page, so a cold project has an
      icon too. `test/project-icon.mjs` (unit), `test/rail-favicon.mjs`
      (electron, screenshot 19). See PROGRESS 2026-08-12.
- [ ] **Follow-up: a first favicon added mid-session needs a relaunch.** Main
      revalidates a *changed* icon by mtime, but the renderer caches a miss for
      the session, so a project that gains its first favicon while open keeps
      the folder until next launch. A `refresh()` on the store (called after a
      turn touches the project) closes it; not worth a poll.

## Editor media previews (2026-08-09, user-reported)

- [x] **Opening an image in the editor showed its bytes as text.** ✅ 2026-08-09 —
      `source:read` now classifies media/binary instead of always decoding utf8, and
      the drawer renders `MediaPreview` (image on a checkerboard, video/audio with
      controls, placeholder otherwise) served over a token-scoped, range-capable
      `praxis-media://` protocol. See PROGRESS 2026-08-09.
- [ ] **Give the file tree a type hint.** `source:tree` returns bare paths, so the
      sidebar can't show an image icon or a thumbnail until it carries per-entry
      metadata — and the editor can't warn before opening a 200 MB asset.
- [ ] **No video fixture in the suite.** `test/code-drawer.mjs` proves the protocol's
      206/`Content-Range` path with a PNG, but nothing exercises a real `<video>`
      (seeking, `video/quicktime` on a .mov). Needs a checked-in seconds-long clip.

## Main chat, child agents, and project memory (2026-08-08)

- [x] **Make Main a stable, visible project role.** ✅ 2026-08-08 — Main is pinned
      first, cannot be closed like a secondary, and History is a separate rail section.
- [x] **Show comment agents under the chat that launched them.** ✅ 2026-08-08 —
      spawn identity now carries the parent session key; rows show their inherited
      model and aggregate onto the parent/project working status.
- [x] **Durable per-project memory + clear Main context.** ✅ 2026-08-08 — curated,
      16k-bounded memory lives outside Git in Praxis userData, enters every provider,
      and survives a Main reset; the old transcript is archived into History.
- [x] **Sort the rail's per-project controls by what they act on.** ✅ 2026-08-09 —
      project memory is a brain action on the project row (× is hover-only now),
      "New chat" is a full-width button under the chat list it appends to, and
      History folds as an accordion. See PROGRESS 2026-08-09.
- [x] **Put the whole rail block on one indent grid.** ✅ 2026-08-09 — the "New chat"
      + and the History chevron moved into the same 16px glyph slot as the folder and
      the status dots (labels all at 31px); row actions became a hover overlay so
      every row's model/time ends on one trailing edge instead of Main's running 34px
      further right; History now starts folded and the memory brain is hover-revealed
      like ×. See PROGRESS 2026-08-09.
- [ ] **Suggest memory updates from conversation decisions.** Keep this reviewable:
      propose additions/removals in the memory editor instead of silently rewriting
      standing project context.
- [ ] **Enable detached background agents on Codex/gateway sessions.** Parent-model
      inheritance is already wired, but the provider capability remains Claude-only;
      unsupported comments explicitly fall back into their chat.

## Per-chat isolation (2026-08-08, user-reported)

- [x] **Merge conflict on almost every turn, listing `node_modules`.** ✅ 2026-08-08
      — a trailing-slash `node_modules/` `.gitignore` is directory-only and doesn't
      match the symlink Praxis stitches into each worktree, so `git add -A` staged
      it and the auto-merge choked (`EISDIR`) → parked every turn. Fixed by
      excluding `RUNTIME_DEPS` (node_modules/.env) from every stage explicitly
      instead of trusting `.gitignore` (`worktrees.ts`, `chat-worktrees.ts`), plus a
      slash-free scaffold `.gitignore`. Regression: `test/chat-worktrees.mjs` repo9.

## Codex turn streaming (2026-08-08, user-reported)

- [x] **A connection running DeepSeek works end-to-end.** ✅ 2026-08-08 — the user
      ran `deepseek/deepseek-v4-flash` through a gateway connection and got real
      multi-turn replies (38k in / 513 out). That closes the "Kimi/DeepSeek
      unproven" item below for DeepSeek: an open model really does drive a chat on
      the Codex harness. Its `apply_patch` reliability is still unmeasured — that
      needs a turn that actually EDITS a file.
- [x] **Assistant replies were missing their opening, mid-word.** ✅ 2026-08-08 —
      "ve reliable visibility…", "ing else?". Codex streams whole items and praxis
      emits the unsent SUFFIX, but the CLI numbers items PER TURN while the
      tracker lived for the whole SESSION — so turn 2's `item_0` inherited turn
      1's length and lost exactly that many leading characters. Longer replies
      still rendered, just beheaded, which is why it went unnoticed. New pure
      `backends/codex-stream.ts`, reset each turn. Same bug silently DROPPED tool
      steps on later turns (an id already "surfaced"). `test/codex-stream.mjs`.
- [ ] **"Model metadata for `<model>` not found" is repeated every turn.** The
      string lives in the vendored `codex` binary, so it's the CLI warning about a
      non-OpenAI model id, and it lands in the chat's step list on EVERY turn —
      pure noise after the first. Worth finding which event carries it (it renders
      as a step, not a red error) and showing it at most once per session, or
      dropping it: the user can't act on it and it isn't wrong, just loud.

## Props island + preview port (2026-08-07, five failing Electron tests)

- [x] **The island's first state push had nowhere to land.** ✅ 2026-08-07 — the
      view is created by `panel:show`, which follows the first `setState`, and
      the `did-finish-load` re-push races the island's own listener. The island
      now PULLS (`panel:request-state`) after subscribing. See PROGRESS.
- [x] **A reopened island could stay at its 160px default.** ✅ 2026-08-07 —
      `PanelHost` remounts with a fresh size state while the island page (and its
      ResizeObserver) lives on, so an unchanged card height reported nothing.
      `PanelApp` re-measures on every state push.
- [x] **`isPortFree` missed a dual-stack occupant.** ✅ 2026-08-07 — SO_REUSEADDR
      lets a 127.0.0.1 bind succeed under a wildcard listener, so praxis handed
      out an occupied port and then previewed whatever already answered there.
      Both probes now run; the wildcard one only votes on `EADDRINUSE`.
- [ ] **`custom-controls`'s burst assert is still latency-sensitive.** It needs
      three `applyLiteral` records inside edit-history's 500ms window; main-side
      apply latency is usually 15–135ms but was measured at 496ms once under
      load. If it flakes again, the honest fix is main-side (why does a
      read-splice-write occasionally take half a second?), not a bigger
      COALESCE_MS.
- [ ] **Leaked fixture dev servers survive a killed test run.** Seven `node
      server.mjs` processes from July/August runs were still holding 7777–7783 on
      this machine (`before-quit` → `stopAll` only runs on a graceful quit). The
      port fix makes praxis route around them; nothing reaps them.

## Settings "Connecting…" hang + publish guidance (2026-08-07, user-reported)

- [ ] **STILL NOT REPRODUCED — the user's Connect hangs, mine doesn't.** They see
      "Contacting ai-gateway.vercel.sh… 94s" with no error. Measured inside the
      BUILT app's main process on this machine, every case ends promptly: real
      gateway + bogus key → 401 in 0.7s, closed port → instant, blackhole IP →
      the 10s abort fires. So main is healthy here and the difference is on their
      machine or in their build. Two theories, neither confirmed: (a) they run
      `bun run dev`, where React.StrictMode double-invokes mount effects — the
      `live` ref was cleanup-only, so `live.current` would stay false forever and
      `stale()` would be permanently true, meaning the probe could never render,
      error, OR hit its own deadline. Fixed the ref regardless (it was a real
      bug), but a `--mode development` build did NOT reproduce it, so this is
      unproven. (b) something network-level (proxy/VPN/DNS) that main's own abort
      somehow doesn't cover. NEXT: ask which command they launch with, and get
      the error text now that the state-driven deadline forces one after 12s.
- [x] **Made the hang structurally impossible instead of guessing.** ✅
      2026-08-07 — the deadline is now driven by the rendered `inFlight` state,
      not by a closure gated on `stale()`. Any path that disowns a probe without
      clearing the state used to strand the button; now if `inFlight` is set it
      is cleared when the deadline passes, whatever went wrong. Plus the first
      real UI test of the dialog (`test/settings-connect.mjs`) — two rounds of
      fixing this shipped without one, which is why both missed.
- [ ] **The never-answering-IPC path isn't test-reachable.** The preload bridge is
      frozen so a test can't stub `providers.catalog` to hang, and main always
      answers within its 10s abort — so the state-driven deadline is reasoned,
      not asserted. Needs either an injectable IPC seam or a main-side switch to
      stall a probe on demand.
- [x] **Publish failure now says how to fix it.** ✅ 2026-08-07 — "this folder
      isn't the repository root" named no repo and no action. It now distinguishes
      "not a git repository at all" (→ `git init` here) from "inside the repo at
      <path>" (→ open that, or `git init` here), and `scaffold.ts` no longer
      SWALLOWS a failed `git init`/first commit — that silence is what let a new
      project look fine until publish blamed something unrelated.

## Stop / interrupt (2026-08-07, user-reported)

- [x] **Stop was a dead button on Claude, and a silent no-op on Gemini.** ✅
      2026-08-07 — the SDK's `interrupt()` control request has no timeout, so a
      wedged subprocess made Stop hang forever with the spinner still running.
      New pure `src/main/backends/interrupt.ts` (ask, then kill), claude.ts
      escalates to its abort signal and emits the missing `done`, agent.ts caps
      its wait and rebuilds the dead session. Gemini gained a real `interrupt`.
      `test/interrupt-escalation.mjs`. See PROGRESS 2026-08-07.
- [ ] **The wedge itself was never reproduced.** The fix is reasoned from the SDK
      source + event paths and its escalation logic is unit-tested, but nobody has
      seen it rescue a real hang. If it recurs: confirm Stop now returns within
      ~3s, the chat restarts, and the "force-stopped" message appears. Worth
      capturing what triggers it (large image attachment? long session? a
      particular tool?) — the user reported it as intermittent.
- [ ] **A hard stop loses the model's context.** The restarted chat is a fresh SDK
      query, so earlier turns are gone from the model's view even though praxis
      still shows them. The record captures `sdkSessionId`, and v9 resume already
      exists, so restarting via `resume` instead of fresh would keep the context —
      not attempted here because a wedged session's id may itself be unusable.
- [ ] **Codex/connection turns can't be force-stopped, only aborted locally.** Its
      `turnAbort` cancels praxis's read of the stream; whether the underlying CLI
      process actually dies wasn't verified. Worth checking a connection turn
      against a slow endpoint.

## v10 — bring-your-own-model connections (2026-08-07, user-requested)

- [x] **Connections: user-added OpenAI-compatible endpoints.** ✅ 2026-08-07 —
      harness and endpoint split apart (`AgentOptions.connectionId` beside
      `provider`); `src/main/providers-store.ts` (pure) +
      `src/main/providers.ts` (safeStorage cipher, `providers:*` IPC, `/models`
      probe, `resolveConnection`); Codex SDK aimed at the endpoint via a
      dedicated `model_providers."praxis-connection"` block.
      `test/providers-store.mjs`. See PROGRESS 2026-08-07.
- [x] **Settings dialog + model-first picker.** ✅ 2026-08-07 —
      `SettingsDialog.tsx` / `ProviderForm.tsx` / `renderer/src/providers-store.ts`;
      `ChatPanel.tsx`'s hardcoded model arrays and Backend dropdown deleted in
      favour of one grouped list from `providers.choices()`.
- [ ] **NOTHING here has hit a live third-party endpoint.** Every verification
      was a local probe server plus the real SDK/CLI. SUPERSEDED 2026-08-07 for the
      gateway — see the next item; still open for Groq and other hosts.
- [x] **The connection path works against a live AI Gateway.** ✅ 2026-08-07 —
      real key, real turn, real edit: `anthropic/claude-sonnet-4.6` through
      `https://ai-gateway.vercel.sh/v1` on the Codex harness read the file, wrote
      a correct edit, left the untargeted function alone, and finished in 15.5s
      with ZERO error events. That settles the two big unknowns: the gateway's
      `/responses` accepts Codex's request shape, and the
      `model_providers."praxis-connection"` block (websockets off) is right — no
      reconnect attempts appeared. `/models` returned 322 models including all
      eight Kimi variants and nine DeepSeek ones.
- [ ] **Kimi/DeepSeek still unproven — the test key was free-tier.** Every open
      model returns 403 "Free tier users do not have access to this model", then
      429 once the free allowance is spent; only `anthropic/*` was reachable. So
      the `apply_patch` question below is still open, and needs paid gateway
      credits to answer. (Note the irony: the first fully working connection ran
      Claude through the Codex harness.)
- [ ] **Open models may fumble Codex's `apply_patch` format.** GPT-5 was trained
      on it; Kimi/DeepSeek weren't, so edits may need retries or fail. Blocked on
      paid credits (above). If it's bad, the fix the user asked for is an appended
      system-prompt section teaching the patch format (praxis already prepends its
      rules to the first Codex turn, so there's a hook).
- [ ] **Connection runs inherit the user's global `~/.codex/config.toml` MCP
      servers.** Observed live: an unauthenticated `mcp.vercel.com` entry on the
      dev machine dumped an OAuth `AuthRequired` blob into the turn's error text.
      Praxis only overrides `model_provider`, so this is expected — but it means a
      user's unrelated MCP config can pollute a connection chat. Decide whether a
      connection run should start from a clean MCP set.
- [ ] **A chat pointing at a deleted connection.** The picker falls back to an
      option echoing the raw stored value and `AgentOptions` still carries the
      dead `connectionId`; main fails the turn soft with "re-add it in Settings".
      Deliberate (don't silently rewrite a user's chat settings) but the UX of
      that state hasn't been designed.
- [ ] **Untested UI paths:** the `unsupported: true` free-text fallback (host
      with no `/models` route) and the edit-an-existing-connection auto-probe.
      Both need a host that exhibits them.
- [x] **Both seats' model lists are discovered, not curated.** ✅ 2026-08-07 —
      `src/main/model-catalog.ts` (pure: parsers + TTL cache, injected
      clock/baseDir, persisted to `<userData>/praxis/model-catalog.json`) +
      `src/main/codex-models.ts` (runs `codex debug models` on the SDK's vendored
      binary). Claude answers `Query.supportedModels()`, handed back from
      `backends/claude.ts` since it needs a live session. `test/model-catalog.mjs`.
      See PROGRESS 2026-08-07.
- [ ] **Codex-seat parity holes** (these now matter for every connection model,
      not just ChatGPT users): praxis's in-process tools aren't available (serve
      them over a local MCP server injected via `CodexOptions.config`, whose
      `mcp_tool_call` events `backends/codex.ts` already maps); no
      `AskUserQuestion` equivalent; no resume (`resumeThread(id)` +
      `ThreadStartedEvent.thread_id` make this nearly free); `supportsSpawn` off.
      Per-tool approve/deny cards are NOT closable — the SDK event stream has no
      approval-request event; user accepted that trade-off 2026-08-07.

## Design-token naming accuracy (2026-07-30/31, user-reported)

- [x] **A token from another property family can't name a row.** ✅ 2026-07-30 —
      `--rmt-radius-none` was labelling `padding: 0`. `groupAffinity` (a coarse
      `TokenKind`) became `groupRole` (a semantic `TokenRole`). Superseded the
      next day by the proof requirement below for `css`/`tailwind` sources
      (role-based ranking is no longer how naming is decided for them — proof
      is); still load-bearing for `manifest`, which has no proof mechanism.
      `src/shared/token-match.ts`, `test/token-match.mjs`. See PROGRESS 2026-07-30.
- [x] **Naming requires PROOF a value comes from a token, not just equals one.**
      ✅ 2026-07-31 — `getComputedStyle` always resolves `var()` away, so value
      equality alone can never distinguish "IS this token" from "coincidentally
      equals it." New `src/preview/style-provenance.ts` reads the SPECIFIED
      (unresolved) declaration — inline `style=` or a matched stylesheet/scoped-
      `<style>` rule — threaded through `styles:read` as `declaredVars`.
      `resolveTokenForValue` now requires it for `css`/`tailwind` sources;
      `manifest` (no reference mechanism exists) keeps the value+role heuristic
      above. `test/token-match.mjs`, `test/style-provenance.mjs` (new, real
      headless-Chromium DOM/CSSOM test), `test/style-edit.mjs`. See PROGRESS
      2026-07-31.
- [ ] **`sameCssValue` doesn't equate bare `0` with `0px`.** Found 2026-07-30
      while writing the above. A theme declaring `--space-0: 0` (unitless —
      legal CSS, and `tokenValueKind` already accepts it as a length) can never
      match a computed `0px`, so that token is offered but never names anything.
      Fix belongs in the renderer's `css-values.ts` comparator; it shifts
      matching for every property, so it wants its own pass.
- [ ] **`test/style-edit.mjs`'s token assertions are written but unrun.**
      CORRECTED 2026-08-07: the reason recorded here ("the Electron tier can't
      launch a window on this machine") was WRONG — see the new gotcha in
      CLAUDE.md. The tier runs fine through `test/run.mjs`, which gives each test
      a fresh `PRAXIS_USER_DATA`; the `.empty__open` timeout only happens when a
      test is invoked DIRECTLY (`node test/style-edit.mjs`), because it then uses
      the real app state, and if any project is open the empty state never
      renders. `style-edit` does still fail under the runner, but on a genuine
      assertion ("inspector never showed src/Styled.tsx:5 after clicking
      #tw-box") — that's the real bug to chase. Same gap as the styles-ladder
      fix (2026-07-30); worth a real run wherever the Electron window can
      reliably take focus.

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
- [ ] **A runnable tier for the styles ladder.** CORRECTED 2026-08-07 — the
      premise ("can't launch a window on the current dev machine, dies at
      `.empty__open`, at HEAD too") was wrong: that only happens when the test is
      run directly instead of through `test/run.mjs`, which isolates
      `PRAXIS_USER_DATA` per test. The window launches fine. The S2-refusal
      assertion is still unrun because `style-edit` fails earlier on a real
      inspector assertion. Verified instead with a throwaway harness driving
      the real `applyStyleEdit` in node (PROGRESS 2026-07-30 has the details).
      Worth making permanent if the Electron tier stays unrunnable.

## Rail chat statuses + rename (2026-08-05, user-requested) — SHIPPED

- [x] **A status dot per chat row + inline rename.** ✅ 2026-08-05 — hollow ring
      = stale, filled grey and blinking = a turn in flight, filled green = a turn
      finished while you were on another chat. Dots occupy the project row's own
      16px folder-glyph slot, so they share its centre line while the chat names
      keep their indent. New `needsReview` on the chat slice (set by `finish`
      only for a chat that isn't on screen, cleared by `setActiveChat`). Rename
      goes through main, the only writer of a chat's name:
      `agent:rename-chat` for a live chat (it also blocks the auto-namer),
      `sessions:rename` for a past one. New
      `src/renderer/src/components/RailChatRow.tsx`,
      `test/rail-chat-status.mjs`. See PROGRESS 2026-08-05.

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
- [x] **Phase 5 — the sidebar became a file manager.** ✅ 2026-08-05
      (user-requested) — new file / rename / delete from the tree: a toolbar above
      it plus Finder's click-the-selected-file-again to rename. New
      `src/main/file-ops.ts` (pure) behind `source:create-file`/`rename-file`/
      `delete-file`; every renderer path is re-validated (no traversal, no
      `.git`/`.praxis`/`.dsgn`/`node_modules`), create/rename never clobber, and
      delete goes to the OS trash because the content-diff undo history can't
      represent a deleted file. `test/file-ops.mjs`. See PROGRESS 2026-08-05.
      Deliberately out of scope: directory create/rename/delete (a nested path
      makes dirs implicitly; git doesn't track empty ones anyway) and drag-to-move.
- [ ] **Follow-up:** see the sidebar's new chrome rendered. CORRECTED 2026-08-07
      — "the Electron tier can't launch a window here (`test:codedrawer` dies at
      `.empty__open`, at HEAD too)" was wrong; that's the run-it-directly trap
      (see CLAUDE.md). `code-drawer` PASSES through `test/run.mjs`, so the
      toolbar / rename field / delete confirm are unverified
      visually, as is whether the tree widget re-fires a selection change for an
      already-selected row (the `dblclick` fallback exists because it might not).

## Per-chat worktree isolation (2026-07-16, concurrent-chat safety) — SHIPPED

- [x] **Isolate concurrent chats in per-repo worktrees.** ✅ 2026-07-16 —
      Every interactive chat on a git repo root gets its own long-lived worktree,
      created before `startSession` and removed on close. A `praxis/chat-<id>`
      recovery branch is attached during a turn; successful `done` events land via
      the repo queue and delete it, while errors/interruption or conflicts park on
      the branch for review. The preview always serves live, never a worktree. The
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
- [x] **One commit per turn on the LIVE checkout.** ✅ 2026-08-05 (user-requested
      — "so that I can easily revert or follow the progress") — the merge back
      onto the live tree is now also committed there, one commit per turn, with
      the prompt as the subject. Only the turn's own files are staged and it's a
      partial (pathspec) commit, so the user's unrelated dirty/staged work is
      untouched; non-repo-root projects are skipped. `src/main/live-commit.ts`,
      wired from `chat-isolation.ts` + `agent.ts`'s spawn finalizer;
      `publishToPr`'s file list now diffs vs the default branch instead of HEAD
      (extracted to `src/main/publish-scope.ts`).
      `test/live-commit.mjs`. See PROGRESS 2026-08-05.
      Not done deliberately: no user-facing toggle (the whole point is that it's
      always on) and no UI surfacing of the commit sha — `git log` is the UI.
- [x] **One repository landing writer + ephemeral chat branches.** ✅ 2026-08-08 —
      per-chat chains did not protect the shared live index from two different chats.
      Every snapshot/landing/resolve/teardown now crosses a repo-scoped queue. A chat's
      `praxis/chat-*` branch exists only during a turn or while parked; successful
      landing/discard detaches the still-live worktree and deletes the branch, and the
      next `beforeTurn` recreates it for crash recovery. `src/main/repo-write-queue.ts`,
      `src/main/{chat-isolation,chat-worktrees,worktrees}.ts`, `test/live-commit.mjs`.
- [x] **Resolver independence + artifact/marker safety.** ✅ 2026-08-08 — the
      3-way path now uses a temporary index seeded from the live working tree, leaving
      the user's staged state untouched and eliminating `does not match index` failures.
      `.env*` secrets, `node_modules`, `*.tsbuildinfo`, and sidecars are excluded at
      snapshot/turn/live-commit boundaries; unresolved marker triplets remain parked.
      Isolation setup fails closed. `src/main/{worktrees,chat-worktrees,live-commit}.ts`,
      `test/{chat-worktrees,live-commit}.mjs`.
- [x] **Terminal outcomes are explicit and idempotent.** ✅ 2026-08-08 — only a
      clean `done` auto-lands; `error`/interruption commits partial work to the recovery
      branch and parks it. A per-turn tracker collapses Codex's `error→done` sequence so
      finalization runs once. `src/main/turn-terminal.ts`, `src/main/{agent,
      chat-isolation,chat-worktrees}.ts`, `test/{turn-terminal,live-commit}.mjs`.

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
