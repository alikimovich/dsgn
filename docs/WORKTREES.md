# Worktrees and concurrent chats

Praxis gives every interactive chat on a Git repository root its own linked worktree.
Models edit there; the preview and the user's editor remain on the live checkout. The
isolation boundary is the worktree, while convergence is owned by one repository-scoped
landing queue.

All chats are peers in the rail and in the isolation model: each crosses the same
landing queue. Chat identity and worktree identity are independent; closing a
conversation does not justify retaining a stale branch.

## State model

```text
idle (detached worktree, no chat branch)
  → turn starts: attach praxis/chat-<id>
  → model edits privately
  → repository landing queue
      → success: validate, write + commit live, detach, delete chat branch
      → failure/interruption: commit partial work only on chat branch, park
      → live drift/conflict: keep cumulative work on chat branch, park

parked
  → Resolve (UI or agent tool): rebase both sides into the worktree; AI resolves markers
  → Discard: reset worktree, detach, delete chat branch
  → successful resolution: land once, detach, delete chat branch
```

The branch is a recovery reference, not the session's permanent identity. It exists
only while a turn can lose work or while a conflict awaits a decision. An idle chat
retains its worktree/session cwd but no branch, preventing stale `praxis/chat-*` refs
from growing with every chat.

## Invariants

- One live checkout has one writer. Every snapshot, landing, apply, resolve, discard,
  and teardown crosses the repository queue.
- Only a successful provider terminal outcome may auto-land. Failed or interrupted
  work stays parked and recoverable.
- A provider's duplicate terminal events finalize a turn once. In particular, Codex's
  `error` followed by `done` is one failed turn.
- A batch is validated before live writes. Complete Git conflict-marker triplets never
  cross into the live checkout.
- Three-way resolution uses a temporary index seeded from the working tree. The user's
  real staged state is not a resolver input and is never mutated.
- `.env` and non-template `.env.*`, `node_modules`, `*.tsbuildinfo`, `.praxis/`, and
  legacy `.dsgn/` are excluded from snapshots, worktree commits, and live commits.
- Parked work keeps a durable branch. Successfully landed or discarded work does not.
- Comment-created and automatic text-edit background agents are attributed to their
  exact parent chat in the rail, but still count against the repository-wide concurrency
  cap and land through the same repository writer. Closing a parent chat does not stop
  its agent, so an agent left without a live parent re-parents onto the project's first
  chat rather than disappearing from the rail with its cancel control. Automatic edit
  completion is recorded in the activity log, not the chat transcript.

## What “conflict” means in Praxis

A park does not necessarily mean Git found overlapping `<<<<<<<` markers. It means the
chat's result could not be proven safe to land as one batch. Typical causes are another
chat or the user changing the same file during the turn, deletion/binary changes that
need the explicit resolver, or a failed/interrupted provider turn with partial edits.

The conflict card must therefore reflect the harness's authoritative landing state—not
the model's opinion about whether its private worktree is clean. A clean worktree can
still be parked because publication to the live checkout failed.

Codex/gateway chats can query that same authority with the session-scoped
`workspace_state` MCP tool. When it reports `parked`, `prepare_conflict_resolution`
invokes the same queued resolver as the conflict card, leaving marker-bearing files in
the chat's current worktree for the model to reconcile. The tool is idempotent after
staging, refuses to reset a worktree already edited in the current turn, and exposes no
raw Git/reset/discard escape hatch.

## Recovery and limits

On restart, dirty or unmerged orphan worktrees are folded into recovery records; work
already present live is removed. Praxis also sweeps branch-only `praxis/chat-*`
leftovers whose checkout was removed by an older or interrupted teardown. Because a
landed turn is usually a different commit on the live branch, cleanup accepts either
commit ancestry or patch equivalence against live `HEAD`; it never deletes a checked-
out branch, a persisted park, or a tip carrying a unique patch. Other namespaces such
as `backup/*`, normal work branches, and comment-agent branches are outside this sweep.

The preview currently serves the live checkout, so mid-turn worktree edits are not
visible there until landing. Isolation currently applies only when the opened folder is
the Git repository root; non-Git folders and Git subdirectories use the live path and do
not receive this concurrency guarantee.

Implementation: `src/main/repo-write-queue.ts`, `src/main/chat-isolation.ts`,
`src/main/chat-worktrees.ts`, `src/main/worktrees.ts`, `src/main/live-commit.ts`.
Regression coverage: `test/chat-worktrees.mjs`, `test/live-commit.mjs`,
`test/chat-isolation.mjs`, `test/turn-terminal.mjs`.

## Publishing a shared work branch

Publish is a second repository-wide landing boundary after chat work reaches the live
checkout. The entire commit → reconcile → push → PR → merge → cleanup sequence holds a
per-repository publish lock. Before pushing an existing `praxis/*` branch, Praxis
fetches/prunes origin and records both tips below `refs/praxis/recovery/`.

The reconciliation is ancestry-driven: a remote ancestor needs only a normal push; a
local ancestor fast-forwards; true divergence gets an explicit merge commit. A push
rejected because the remote moved repeats fetch/reconciliation, with three total
attempts. Content conflicts remain in the live checkout with both recovery refs and
are surfaced as an exact file list. Publish never force-pushes, rebases, resets, or
chooses ours/theirs across the repository.

Implementation: `src/main/publish-reconcile.ts`, integrated by
`src/main/annotations.ts`. Regression coverage: `test/publish-reconcile.mjs`.
