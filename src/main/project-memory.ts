import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectKey } from '../shared/projectKey'

/** Project memory is intentionally small: it is injected into model context. */
export const MAX_PROJECT_MEMORY_CHARS = 16_000

export interface ProjectMemory {
  content: string
  updatedAt: number
}

export interface ProjectMemoryStore {
  get: (root: string) => ProjectMemory
  set: (root: string, content: string) => ProjectMemory
}

const EMPTY: ProjectMemory = { content: '', updatedAt: 0 }

/**
 * Durable, per-machine project memory. It lives under Praxis userData rather than
 * `<repo>/.praxis`: memories are model context, not project source, and must never
 * sneak into a commit/publish or participate in worktree merges.
 */
export function createProjectMemoryStore(baseDir: string): ProjectMemoryStore {
  const dir = join(baseDir, 'project-memories')
  const fileFor = (root: string): string => {
    const id = createHash('sha256').update(projectKey(root)).digest('hex')
    return join(dir, `${id}.json`)
  }

  const get = (root: string): ProjectMemory => {
    try {
      const raw = JSON.parse(readFileSync(fileFor(root), 'utf8')) as Partial<ProjectMemory>
      if (typeof raw.content !== 'string' || typeof raw.updatedAt !== 'number') return EMPTY
      return {
        content: raw.content.slice(0, MAX_PROJECT_MEMORY_CHARS),
        updatedAt: raw.updatedAt
      }
    } catch {
      return EMPTY
    }
  }

  const set = (root: string, content: string): ProjectMemory => {
    const record = {
      content: content.trim().slice(0, MAX_PROJECT_MEMORY_CHARS),
      updatedAt: Date.now()
    }
    mkdirSync(dir, { recursive: true })
    const target = fileFor(root)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(record), 'utf8')
    renameSync(tmp, target)
    return record
  }

  return { get, set }
}

/** A bounded, clearly-delimited rules section shared by every provider. */
export function projectMemoryRules(content: string): string[] {
  const memory = content.trim().slice(0, MAX_PROJECT_MEMORY_CHARS)
  if (!memory) return []
  return [
    '',
    '## Project memory',
    'Praxis stores the following durable project decisions separately from this chat.',
    'Treat them as standing context. If a current user request contradicts them, follow',
    'the current request and call out that the saved memory may need updating.',
    '',
    '<project-memory>',
    memory,
    '</project-memory>'
  ]
}

/** One-time update injected when memory changed after a live session started. */
export function projectMemoryUpdate(content: string, prompt: string): string {
  const lines = projectMemoryRules(content)
  const update = lines.length
    ? lines.join('\n')
    : [
        '## Project memory update',
        'Praxis project memory is now empty. Do not treat earlier saved memory as standing context.'
      ].join('\n')
  return `${update}\n\n---\n\n${prompt}`
}
