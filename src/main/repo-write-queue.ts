import { projectKey } from '../shared/projectKey'

/**
 * One live checkout has one git index and one HEAD, even when many Praxis chats have
 * private worktrees. All operations that snapshot or mutate that live checkout must
 * therefore pass through one repository-scoped queue. Per-chat queues are not enough:
 * two different chats can otherwise both stage/commit through the same live index.
 */

const tails = new Map<string, Promise<void>>()

export function enqueueRepoWrite<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = projectKey(repoRoot)
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(operation)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  tails.set(key, tail)
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}

/** Test/app re-initialization seam. Never interrupts an operation already running. */
export function resetRepoWriteQueues(): void {
  tails.clear()
}
