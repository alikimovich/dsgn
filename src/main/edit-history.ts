import { readFile, writeFile } from 'fs/promises'

/**
 * Undo/redo for ALL praxis source edits (v8 F3b) — props, inline text, token swaps,
 * React + Svelte. Every apply path calls `recordEdit(root, file, before, after)`
 * after a successful write; `undo(root)`/`redo(root)` revert/re-apply against the
 * file's CURRENT content, refusing to clobber if the user changed it in their own
 * editor since.
 *
 * History is scoped per project root — praxis keeps several projects open in the rail
 * (v5-C), so Cmd+Z in project B must never revert a file in project A. The edits
 * write straight to source, so the dev server's HMR refreshes the preview on undo
 * just like apply.
 */

interface EditEntry {
  file: string
  before: string
  after: string
  /** Coalesce key (e.g. "source:prop") — rapid edits of the same target merge. */
  key?: string
  /**
   * Atomic group (e.g. "comment:<id>"). Entries sharing a group at the top of the
   * stack undo/redo together in ONE step — so a multi-file comment spawn is a
   * single Cmd+Z, not one per file.
   */
  group?: string
  at: number
}

interface Stacks {
  undo: EditEntry[]
  redo: EditEntry[]
}

// Rapid edits of the same target within this window become one undo step (a
// slider drag / fast retyping shouldn't need many Cmd+Z). Date.now is fine in main.
const COALESCE_MS = 500
const MAX_HISTORY = 200

// One pair of stacks per project root.
const byRoot = new Map<string, Stacks>()
const stacksFor = (root: string): Stacks => {
  let s = byRoot.get(root)
  if (!s) byRoot.set(root, (s = { undo: [], redo: [] }))
  return s
}

/** Record a successful source edit. A no-op write (before === after) is ignored. */
export function recordEdit(
  root: string,
  file: string,
  before: string,
  after: string,
  key?: string,
  group?: string
): void {
  if (before === after) return
  const { undo: undoStack, redo: redoStack } = stacksFor(root)
  redoStack.length = 0 // a fresh edit invalidates the redo branch
  const last = undoStack[undoStack.length - 1]
  if (last && key && last.key === key && last.file === file && Date.now() - last.at < COALESCE_MS) {
    // Coalesce: keep the ORIGINAL before (so one undo reverts the whole burst),
    // advance to the latest after.
    last.after = after
    last.at = Date.now()
    return
  }
  undoStack.push({ file, before, after, key, group, at: Date.now() })
  if (undoStack.length > MAX_HISTORY) undoStack.shift()
}

export interface UndoResult {
  ok: boolean
  /** The file reverted/re-applied (relative or absolute as recorded). */
  file?: string
  /** The stack was empty. */
  empty?: boolean
  /** The file changed on disk since the edit — refused to clobber. */
  conflict?: boolean
}

async function move(from: EditEntry[], to: EditEntry[], expect: 'after' | 'before'): Promise<UndoResult> {
  const top = from[from.length - 1]
  if (!top) return { ok: false, empty: true }
  // The batch reverted/re-applied in this one step: the contiguous run of top
  // entries sharing `top.group` (a single entry when there's no group). This makes
  // a multi-file comment spawn one atomic Cmd+Z.
  const batch: EditEntry[] = []
  for (let i = from.length - 1; i >= 0; i--) {
    if (top.group ? from[i].group === top.group : i === from.length - 1) batch.push(from[i])
    else break
  }
  // Validate the WHOLE batch first — every file must still hold the text we last
  // wrote (else the user edited it in their own editor). All-or-nothing: refuse
  // without writing anything if any file drifted.
  const writes: { entry: EditEntry; text: string }[] = []
  for (const entry of batch) {
    let current: string
    try {
      current = await readFile(entry.file, 'utf8')
    } catch {
      return { ok: false, conflict: true, file: entry.file }
    }
    if (current !== entry[expect]) return { ok: false, conflict: true, file: entry.file }
    writes.push({ entry, text: expect === 'after' ? entry.before : entry.after })
  }
  for (const w of writes) {
    try {
      await writeFile(w.entry.file, w.text, 'utf8')
    } catch {
      return { ok: false, conflict: true, file: w.entry.file }
    }
  }
  for (let k = 0; k < batch.length; k++) to.push(from.pop()!)
  return { ok: true, file: top.file }
}

/** Revert the last edit in `root` (writes its `before`), unless it changed on disk. */
export const undo = (root: string): Promise<UndoResult> => {
  const s = stacksFor(root)
  return move(s.undo, s.redo, 'after')
}
/** Re-apply the last undone edit in `root` (writes its `after`), unless it changed. */
export const redo = (root: string): Promise<UndoResult> => {
  const s = stacksFor(root)
  return move(s.redo, s.undo, 'before')
}

export const canUndo = (root: string): boolean => (byRoot.get(root)?.undo.length ?? 0) > 0
export const canRedo = (root: string): boolean => (byRoot.get(root)?.redo.length ?? 0) > 0

/**
 * Can the turn recorded under `group` be reverted right now? True iff its entries are
 * still on `root`'s undo stack AND every file it touched still holds exactly the text
 * that turn last wrote — i.e. nothing later (another chat turn or a hand edit) has
 * changed them since. A cheap pre-check so the UI can grey out a Revert button that
 * would only conflict; `revertGroup` re-validates the same guard before it writes.
 */
export async function canRevertGroup(root: string, group: string): Promise<boolean> {
  const batch = byRoot.get(root)?.undo.filter((e) => e.group === group) ?? []
  if (!batch.length) return false
  for (const e of batch) {
    let current: string
    try {
      current = await readFile(e.file, 'utf8')
    } catch {
      return false
    }
    if (current !== e.after) return false
  }
  return true
}

/**
 * Addressable revert of ONE recorded group (a chat turn: `chat:<wtId>:<turnNo>`),
 * not necessarily the top of the undo stack. Restores every file's `before`,
 * all-or-nothing: it validates the whole batch first and refuses (conflict) if any
 * file drifted from the `after` that turn wrote — so a turn a LATER turn (or the user)
 * touched can't be silently clobbered. On success the group's entries leave the undo
 * stack; unlike `undo`, revert is a one-way addressable action outside the linear
 * undo/redo model, so nothing is pushed onto the redo stack.
 */
export async function revertGroup(root: string, group: string): Promise<UndoResult> {
  const s = byRoot.get(root)
  const batch = s?.undo.filter((e) => e.group === group) ?? []
  if (!s || !batch.length) return { ok: false, empty: true }
  for (const e of batch) {
    let current: string
    try {
      current = await readFile(e.file, 'utf8')
    } catch {
      return { ok: false, conflict: true, file: e.file }
    }
    if (current !== e.after) return { ok: false, conflict: true, file: e.file }
  }
  for (const e of batch) {
    try {
      await writeFile(e.file, e.before, 'utf8')
    } catch {
      return { ok: false, conflict: true, file: e.file }
    }
  }
  s.undo = s.undo.filter((e) => e.group !== group)
  return { ok: true, file: batch[batch.length - 1].file }
}
/** Drop a project's history (e.g. when it's closed in the rail). */
export const clearHistory = (root: string): void => {
  byRoot.delete(root)
}
