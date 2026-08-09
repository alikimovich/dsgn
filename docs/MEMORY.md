# Project memory and Main context

Each open project has one stable **Main** chat (`sessionKey === projectKey(root)`). Main
is pinned first in the rail and cannot be closed like a secondary chat. Its provider
thread is still finite: **Project memory → Clear context** archives the current Main
transcript into History and starts a fresh provider context under the same stable key.

Project memory is deliberately separate from chat history and repository state:

- Stored per machine under Praxis userData (`praxis/project-memories/`), keyed by a
  hash of the canonical project root.
- Never placed in `.praxis/`, a Git worktree, a commit, or a published PR.
- Bounded to 16,000 characters because it is model context, not document storage.
- Injected into every new Main, secondary-chat, and background-agent context.
- If memory changes while a chat stays live, Praxis injects that revision once on the
  chat's next turn instead of repeating it on every turn.
- A current user request outranks saved memory; the model is told to flag a likely
  stale decision rather than silently follow it.

The memory editor is intentionally curated by the user in this first version. Automatic
decision extraction should arrive as a reviewable suggestion, never silently rewrite
standing project context.

Implementation: `src/main/project-memory.ts`, `src/main/agent.ts`,
`src/main/rules.ts`, `src/renderer/src/components/ProjectMemoryDialog.tsx`.
Regression coverage: `test/project-memory.mjs`, `test/project-memory-ui.mjs`,
`test/rules.mjs`.
