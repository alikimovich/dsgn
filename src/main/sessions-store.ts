import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRecord } from '../shared/api'

/**
 * On-disk store for agent-session history (v5-D "previous agents"). One JSON
 * file per record under `<baseDir>/sessions/`, so writes are incremental and a
 * corrupt record can't take the index down. Records are keyed by `id`; listing a
 * project reads the dir and filters by `projectKey`.
 *
 * `baseDir` is injected (the app passes `app.getPath('userData')`); tests point
 * it at a temp dir. Per-project records are capped — saving prunes the oldest.
 */
export interface SessionStore {
  save: (rec: SessionRecord) => void
  /** Persist this as the project's last-active chat, replacing the previous
   *  current slot so a relaunch restores one conversation rather than stacking them. */
  saveCurrent: (rec: SessionRecord) => void
  list: (projectKey: string) => SessionRecord[]
  /** Current record for a project, including the legacy `slot: 'main'` shape. */
  current: (projectKey: string) => SessionRecord | null
  get: (id: string) => SessionRecord | null
  remove: (id: string) => void
}

const MAX_PER_PROJECT = 50
// Reject absurd ids defensively — the id becomes a filename.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const isCurrent = (rec: SessionRecord): boolean => rec.slot === 'current' || rec.slot === 'main'

export function createSessionStore(baseDir: string): SessionStore {
  const dir = join(baseDir, 'sessions')
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true })
  }
  const fileFor = (id: string): string => join(dir, `${id}.json`)

  const readAll = (): SessionRecord[] => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: SessionRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionRecord
        if (rec && typeof rec.id === 'string') out.push(rec)
      } catch {
        // Skip an unreadable/partial record rather than failing the whole list.
      }
    }
    return out
  }

  const save = (rec: SessionRecord): void => {
    if (!SAFE_ID.test(rec.id)) throw new Error(`unsafe session id: ${rec.id}`)
    ensureDir()
    writeFileSync(fileFor(rec.id), JSON.stringify(rec), 'utf8')
    // Prune the oldest History records beyond the per-project cap. The current
    // slot is not History — never drop it to make room.
    const history = readAll()
      .filter((r) => r.projectKey === rec.projectKey && !isCurrent(r))
      .sort((a, b) => b.startedAt - a.startedAt)
    for (const stale of history.slice(MAX_PER_PROJECT)) remove(stale.id)
  }

  const saveCurrent = (rec: SessionRecord): void => {
    rec.slot = 'current'
    for (const old of readAll().filter(
      (r) => r.projectKey === rec.projectKey && isCurrent(r) && r.id !== rec.id
    )) {
      remove(old.id)
    }
    save(rec)
  }

  const list = (projectKey: string): SessionRecord[] =>
    readAll()
      .filter((r) => r.projectKey === projectKey)
      .sort((a, b) => b.startedAt - a.startedAt)

  const current = (projectKey: string): SessionRecord | null =>
    list(projectKey).find(isCurrent) ?? null

  const get = (id: string): SessionRecord | null => {
    if (!SAFE_ID.test(id)) return null
    try {
      return JSON.parse(readFileSync(fileFor(id), 'utf8')) as SessionRecord
    } catch {
      return null
    }
  }

  const remove = (id: string): void => {
    if (!SAFE_ID.test(id)) return
    try {
      rmSync(fileFor(id), { force: true })
    } catch {
      // already gone
    }
  }

  return { save, saveCurrent, list, current, get, remove }
}
