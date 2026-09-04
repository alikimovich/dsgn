# Project memory and chat continuity

Each open project has a flat set of peer chats. Every chat uses its generated or
user-edited title, renders newest-first, and can be renamed or closed. The plain
`projectKey(root)` session key still identifies the first process-level session, but
it has no product role or special rail treatment.

When Praxis stops a project's sessions (project close, LRU suspension, or quit), the
last-active chat is persisted as the current continuation and restored on the next
open (the transcript always; a Claude SDK resume when the record carries
`sdkSessionId`). Other stopped chats enter History. Starting a new chat is the way to
begin with fresh model context; closing the old one archives it. Records written by
older Praxis builds with `slot: 'main'` are accepted as the current continuation and
rewritten to `slot: 'current'` on the next save.

Project memory is deliberately separate from chat history and repository state:

- Stored per machine under Praxis userData (`praxis/project-memories/`), keyed by a
  hash of the canonical project root.
- Never placed in `.praxis/`, a Git worktree, a commit, or a published PR.
- Bounded to 16,000 characters because it is model context, not document storage.
- Injected into every new chat and background-agent context.
- If memory changes while a chat stays live, Praxis injects that revision once on the
  chat's next turn instead of repeating it on every turn.
- After every successful interactive turn, the selected provider runs a separate,
  tool-free evaluation. It merges only durable decisions, stable preferences,
  constraints, and long-lived requirements into the unified project memory.
- Evaluations are serialized per project. Each peer chat merges against the latest
  memory, and a manual editor save made during evaluation wins and forces a retry.
- Transient progress, repository-discoverable implementation detail, unaccepted
  proposals, errors, secrets, credentials, and personal data are excluded. A failed
  or malformed evaluation is a no-op and never affects the completed chat.
- A current user request outranks saved memory; the model is told to flag a likely
  stale decision rather than silently follow it.

The memory editor remains the user's direct view and final override. Automatic updates
preserve its current wording unless a completed chat establishes a material addition or
the user explicitly reverses an existing decision. Claude and Codex/connection chats
support evaluation; the experimental Gemini CLI backend currently does not.

Implementation: `src/main/project-memory.ts`, `src/main/agent.ts`,
`src/main/backends/memory.ts`, `src/main/rules.ts`,
`src/renderer/src/components/ProjectMemoryDialog.tsx`. Regression coverage:
`test/project-memory.mjs`, `test/project-memory-evaluation.mjs`,
`test/project-memory-ui.mjs`, `test/rules.mjs`.
