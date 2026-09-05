# Praxis

An AI design & prototyping tool for your own repos. Open a project, Praxis
launches its dev server in a live preview on the right, and an AI chat on the
left edits the running app using the selected provider's native harness.

Unlike a sandbox (Figma Make, Claude Code's scratch dir), Praxis edits *your
real repository* with live hot-reload, and hands the result off as a branch +
GitHub PR.

## What it does

- **Live preview of your repo.** Open a folder → Praxis detects the framework
  and package manager, boots that repo's dev server, and previews it in a
  native `WebContentsView`. It self-heals if the dev server dies and restarts.
  Plain HTML/CSS/JS folders (no package.json or build step) are served by a
  built-in static server with live-reload; anything Praxis can't auto-launch
  prompts for a custom command.
- **Local browser mode.** `praxis serve /path/to/repo` runs the same workspace
  engine and React UI on loopback without opening a desktop window. The preview
  is isolated behind a browser gateway and supports source-aware element selection;
  native editing-tool parity is still in progress. See
  [`docs/BROWSER.md`](docs/BROWSER.md).
- **Secure access from another machine.** Add `--remote` to publish the loopback-only
  control UI and isolated preview through Tailscale Serve. Praxis prints a single-use
  pairing URL for a browser on the same tailnet and removes its routes on shutdown.
- **AI chat that edits the running app.** A persistent multi-turn agent session
  streams over IPC and edits source with hot-reload. Backends are pluggable —
  Claude (via the Agent SDK), Codex, and Gemini behind one provider seam
  (Gemini is experimental, gated behind `PRAXIS_EXPERIMENTAL_GEMINI`). Their
  capabilities differ; see [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Peer chats and project memory.** Every project has a flat set of isolated,
  independently named chats, with background agents nested under the chat that
  launched them. After successful turns, Praxis conservatively learns durable
  decisions into unified project memory shared by every chat; it lives outside Git
  and remains directly editable. See [`docs/MEMORY.md`](docs/MEMORY.md).
- **Bring your own model.** Beyond the two subscription seats, Settings →
  Models & Providers connects any OpenAI-compatible endpoint serving the
  `/responses` API — Vercel AI Gateway, Groq, or a custom host — so open models
  like Kimi or DeepSeek can drive a chat. Paste a key, Praxis fetches that
  endpoint's model catalog, and you tick which models to offer in the picker.
  Connections run on the Codex harness; the key is encrypted with the OS
  keychain and never leaves the main process.
- **Drag to reorder in the desktop preview.** Select an element, then hold
  Command (Control on Windows/Linux) and drag it among its siblings. An insertion
  line shows the drop position for columns, rows, and grids; nesting stays fixed.
  Escape or releasing the modifier cancels. Moves write source and support undo;
  ambiguous template/data moves prepare a chat prompt.
- **Click-to-edit.** A **Select** mode maps a clicked element to its source
  location (via the `data-praxis-source` stamp — see
  [`docs/DESIGN.md`](docs/DESIGN.md)), then edits its **props** with typed
  controls (react-docgen for React, `svelte/compiler` for Svelte 5), applies
  the repo's **design tokens** (auto-detected from a manifest, Tailwind, or CSS
  vars), and edits text inline. Non-literal text cases run as detached background
  agents without entering the visible chat.
- **Review → handoff.** Pin comments/notes to elements and **Publish** a branch
  + GitHub PR. Comments and complex inline text edits can spawn parallel background
  agent sessions (each in its own git worktree).
- **Concurrent-chat isolation.** Git-root projects give each chat a private
  worktree and serialize publication through one live-checkout writer. Recovery
  branches exist only during active or parked work and are deleted after a
  successful landing; see [`docs/WORKTREES.md`](docs/WORKTREES.md).
- **iOS Simulator preview** for Expo/React Native projects (Metro detect + an
  MJPEG bridge into the preview pane).
- Tool calls run behind approve/deny cards, or an Auto mode. Edits are
  undoable (`Cmd+Z`) via an edit-history stack.

## Requirements

- **Node 22** (`.nvmrc`) and **Bun** (`bun@1.3.x`). Distributed as source, run
  locally — you need Node + Bun installed.
- A provider subscription for the agent (e.g. Claude Pro/Max), authorized
  per-user (below) — or your own API key for a third-party endpoint, added in
  Settings. Either way it is per-user; there is no shared secret.
- macOS is the primary target (the postinstall step rebrands the dev Electron
  bundle to Praxis and is macOS-only; it no-ops elsewhere).

## Install

One line — clones to `~/.praxis` (override with `PRAXIS_HOME`), installs, builds,
and puts a `praxis` command on your `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/alikimovich/praxis/main/install.sh | bash
```

Then authorize the agent once and launch:

```bash
claude setup-token   # one-time: authorize the agent with your own subscription
praxis               # launch the app (builds on first run)
praxis serve ./my-app # or run the local-browser UI for one repo
praxis serve ./my-app --remote # open it from another device on your Tailscale network
```

In the app, click **Open project…**, pick a repo with a `dev`/`start` script,
and chat on the left. Praxis **owns the dev server** — don't also run `dev`
manually for a project you open here, or you'll hit a port/lock conflict (the
error banner offers a custom-command retry for monorepos / odd setups).

## Updating

```bash
praxis --update      # git pull + bun install + rebuild
```

The app also checks its git remote in the background and shows an
"Update available" banner with an **Update & Restart** button that runs the same
sequence and relaunches. There's no signed app or auto-download — updates are
always a git pull of your checkout.

## Develop on Praxis itself

Contributors work in the checkout directly instead of the installed copy:

```bash
git clone https://github.com/alikimovich/praxis.git
cd praxis
bun install          # runs scripts/patch-electron.mjs (macOS: brands the dev app)
bun run dev          # electron-vite, HMR
bun link             # optional: expose the `praxis` command from this checkout
```

## Architecture

Four process boundaries (details in [`CLAUDE.md`](CLAUDE.md)):

```
Electron
├─ main            agent session · dev-server runner · provider backends · iOS sim
│                  · prop/text/token edit engines · annotations→PR · git/worktrees
├─ preload         typed contextBridge → window.api      (types in src/shared/api.ts)
├─ preview/preload injected into the PREVIEWED app: element select, comments, tokens
└─ renderer        React 18 + Tailwind v4 + shadcn/ui: chat (left) + preview (right)
```

Local browser mode keeps the same main-process services but swaps preload IPC for
scoped HTTP commands and WebSocket events. Its project preview runs in a sandboxed
iframe on a separate loopback origin; see [`docs/BROWSER.md`](docs/BROWSER.md).

- **Preview** is a native `WebContentsView`, not an iframe, so a second preload
  is injected into the previewed app for element selection.
- **Chat** streams over `agent:*` IPC into a zustand store (the seam between
  transport and UI). Claude loads the opened repo's `CLAUDE.md` + skills via
  `settingSources`; other backends keep their own instruction/tool behavior.
- **Conventions travel with the opened repo** — its `CLAUDE.md`, skills, and
  `DESIGN.md` describe how Praxis should edit it.

## Testing

Tests are hand-rolled `.mjs` scripts in three tiers:

- **Unit** (pure Bun, no display): `bun test/<name>.mjs` — fast, always run the
  relevant ones.
- **UI** (Playwright + Electron against the built app): `bun run test:<name>` —
  drives the app and screenshots to `test/artifacts/`; **read the PNGs** to
  confirm UI visually.
- **Live e2e** (`test:agent`, `test:codex`, `test:sim-e2e`): run a real provider
  turn / simulator; self-SKIP without credentials.

`bun run test` runs unit + UI; `bun run verify` adds the live e2e tier.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Launch the app with HMR |
| `bun run build` | Build main/preload/preview/renderer to `out/` |
| `bun run typecheck` | Type-check all three tsconfig projects |
| `bun run test` | Build + run unit and Electron UI tests |
| `bun run verify` | `test` + live-agent/simulator e2e (needs creds + display) |
