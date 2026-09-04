import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectMemoryStore,
  createProjectMemoryUpdateQueue,
  MAX_PROJECT_MEMORY_CHARS,
  projectMemoryRules,
  projectMemoryUpdate
} from '../src/main/project-memory.ts'

const base = mkdtempSync(join(tmpdir(), 'praxis-project-memory-'))
const ok = (condition, message) => {
  if (!condition) throw new Error(message)
}

try {
  const store = createProjectMemoryStore(base)
  const a = '/tmp/project-a'
  const b = '/tmp/project-b'
  ok(store.get(a).content === '', 'new projects start with empty memory')

  const saved = store.set(a, '  # Decisions\n\n- Use praxis/master.  ')
  ok(saved.content === '# Decisions\n\n- Use praxis/master.', 'save trims outer whitespace')
  ok(saved.updatedAt > 0, 'save stamps a revision')
  ok(store.get(a).content === saved.content, 'memory survives a new read')
  ok(store.get(b).content === '', 'projects remain isolated')

  const oversized = store.set(a, 'x'.repeat(MAX_PROJECT_MEMORY_CHARS + 50))
  ok(oversized.content.length === MAX_PROJECT_MEMORY_CHARS, 'memory is context-bounded')

  const rules = projectMemoryRules('Keep the rail calm.')
  ok(rules.join('\n').includes('<project-memory>'), 'memory is clearly delimited')
  ok(rules.join('\n').includes('Keep the rail calm.'), 'rules carry saved content')
  ok(projectMemoryRules('').length === 0, 'empty memory injects no noise')
  ok(
    projectMemoryUpdate('Use detached worktrees.', 'Fix the card.').endsWith('Fix the card.'),
    'one-time updates preserve the user prompt'
  )
  ok(
    projectMemoryUpdate('', 'Continue.').includes('memory is now empty'),
    'clearing memory explicitly supersedes an older live-context snapshot'
  )

  const updates = createProjectMemoryUpdateQueue(store)
  store.set(a, '- Keep existing')
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const first = updates.enqueue(a, async (current) => {
    await firstGate
    return `${current}\n- Learned from chat one`
  })
  const second = updates.enqueue(a, async (current) => `${current}\n- Learned from chat two`)
  releaseFirst()
  await Promise.all([first, second])
  ok(
    store.get(a).content.includes('chat one') && store.get(a).content.includes('chat two'),
    'peer-chat evaluations serialize and merge against the latest memory'
  )

  let releaseEvaluation
  const evaluationGate = new Promise((resolve) => {
    releaseEvaluation = resolve
  })
  let markEvaluationStarted
  const evaluationStarted = new Promise((resolve) => {
    markEvaluationStarted = resolve
  })
  let evaluations = 0
  const guarded = updates.enqueue(a, async (current) => {
    evaluations += 1
    if (evaluations === 1) {
      markEvaluationStarted()
      await evaluationGate
    }
    return `${current}\n- Automatically learned`
  })
  // A user save during the model call is authoritative and forces one re-evaluation.
  await evaluationStarted
  store.set(a, `${store.get(a).content}\n- Manually edited`)
  releaseEvaluation()
  await guarded
  ok(
    store.get(a).content.includes('Manually edited'),
    'automatic updates preserve concurrent edits'
  )
  ok(evaluations === 2, 'a concurrent edit re-evaluates once against current memory')

  console.log('PROJECT-MEMORY OK — durable, isolated, bounded, prompt-safe')
} finally {
  rmSync(base, { recursive: true, force: true })
}
