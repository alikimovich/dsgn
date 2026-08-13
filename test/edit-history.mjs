/**
 * edit-history unit test (pure — no Electron). The v8 F3b undo/redo engine that
 * wraps ALL direct praxis source edits (props, text, token swaps): record + coalesce,
 * undo writes `before` / redo writes `after`, the on-disk conflict guard (refuse to
 * clobber a file the user changed under us), per-project-root scoping (the rail
 * keeps several projects open), and the fresh-edit-invalidates-redo rule.
 *
 * Uses real temp files (the engine reads/writes them). Run with: bun run test:edithistory
 */
import {
  recordEdit,
  undo,
  redo,
  canUndo,
  canRedo,
  clearHistory,
  canRevertGroup,
  revertGroup
} from '../src/main/edit-history.ts'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'praxis-edits-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const ROOT = join(base, 'projA')
const ROOT_B = join(base, 'projB')
const file = (name) => join(base, name)
const write = (p, s) => writeFileSync(p, s, 'utf8')
const read = (p) => readFileSync(p, 'utf8')

try {
  // --- basic record → undo (writes before) → redo (writes after) ---
  const f1 = file('a.tsx')
  write(f1, 'AFTER') // on disk after an apply
  recordEdit(ROOT, f1, 'BEFORE', 'AFTER', 'src:prop')
  ok(canUndo(ROOT) && !canRedo(ROOT), 'after record: undo available, redo not')

  let r = await undo(ROOT)
  ok(r.ok && r.file === f1, `undo ok: ${JSON.stringify(r)}`)
  ok(read(f1) === 'BEFORE', 'undo wrote the before text')
  ok(!canUndo(ROOT) && canRedo(ROOT), 'after undo: redo available, undo not')

  r = await redo(ROOT)
  ok(r.ok && read(f1) === 'AFTER', 'redo restored the after text')
  ok(canUndo(ROOT) && !canRedo(ROOT), 'after redo: back to undo-only')

  // --- empty stacks report empty, not conflict ---
  clearHistory(ROOT)
  r = await undo(ROOT)
  ok(!r.ok && r.empty, `empty undo: ${JSON.stringify(r)}`)
  r = await redo(ROOT)
  ok(!r.ok && r.empty, `empty redo: ${JSON.stringify(r)}`)

  // --- coalescing: same key+file within the window = ONE undo step ---
  const f2 = file('b.tsx')
  write(f2, 'v1')
  recordEdit(ROOT, f2, 'v0', 'v1', 'src:text')
  write(f2, 'v2')
  recordEdit(ROOT, f2, 'v1', 'v2', 'src:text') // coalesces into the v0→v2 step
  r = await undo(ROOT)
  ok(r.ok && read(f2) === 'v0', `coalesced undo reverts whole burst to v0, got ${read(f2)}`)
  ok(!canUndo(ROOT), 'coalesced burst was a single undo step')

  // --- a DIFFERENT key does not coalesce (two steps) ---
  clearHistory(ROOT)
  const f3 = file('c.tsx')
  write(f3, 'B')
  recordEdit(ROOT, f3, 'A', 'B', 'src:prop')
  write(f3, 'C')
  recordEdit(ROOT, f3, 'B', 'C', 'src:token') // different key → new step
  r = await undo(ROOT)
  ok(r.ok && read(f3) === 'B', 'first undo: C→B')
  r = await undo(ROOT)
  ok(r.ok && read(f3) === 'A', 'second undo: B→A')

  // --- conflict: the file changed on disk since the edit → refuse to clobber ---
  clearHistory(ROOT)
  const f4 = file('d.tsx')
  write(f4, 'APPLIED')
  recordEdit(ROOT, f4, 'ORIG', 'APPLIED', 'src:prop')
  write(f4, 'USER-EDITED-IN-THEIR-OWN-EDITOR') // diverged
  r = await undo(ROOT)
  ok(!r.ok && r.conflict && r.file === f4, `undo refuses on conflict: ${JSON.stringify(r)}`)
  ok(read(f4) === 'USER-EDITED-IN-THEIR-OWN-EDITOR', 'conflict undo did NOT clobber the file')
  ok(canUndo(ROOT), 'conflicted entry stays on the stack (not popped)')

  // --- a fresh edit invalidates the redo branch ---
  clearHistory(ROOT)
  const f5 = file('e.tsx')
  write(f5, 'one')
  recordEdit(ROOT, f5, 'zero', 'one', 'src:prop')
  await undo(ROOT) // now redo is available
  ok(canRedo(ROOT), 'redo available after undo')
  write(f5, 'two')
  recordEdit(ROOT, f5, 'zero', 'two', 'src:prop') // a new edit — redo branch dropped
  ok(!canRedo(ROOT), 'fresh edit cleared the redo branch')

  // --- per-root scoping: project B's undo never touches project A ---
  clearHistory(ROOT)
  clearHistory(ROOT_B)
  const fa = file('scoped-a.tsx')
  const fb = file('scoped-b.tsx')
  write(fa, 'A1')
  write(fb, 'B1')
  recordEdit(ROOT, fa, 'A0', 'A1', 'src:prop')
  recordEdit(ROOT_B, fb, 'B0', 'B1', 'src:prop')
  ok(canUndo(ROOT) && canUndo(ROOT_B), 'both roots have history')
  r = await undo(ROOT_B)
  ok(r.ok && read(fb) === 'B0' && read(fa) === 'A1', 'undo(B) reverts B only, A untouched')
  ok(canUndo(ROOT) && !canUndo(ROOT_B), "A's stack intact after B's undo")

  // --- clearHistory(root) drops only that root ---
  clearHistory(ROOT)
  ok(!canUndo(ROOT), 'clearHistory dropped A')

  // --- no-op edit (before === after) is not recorded ---
  clearHistory(ROOT)
  recordEdit(ROOT, file('noop.tsx'), 'same', 'same', 'src:prop')
  ok(!canUndo(ROOT), 'no-op edit was not recorded')

  // --- atomic group: a multi-file comment spawn is ONE undo/redo step ---
  clearHistory(ROOT)
  const gA = file('group-a.tsx')
  const gB = file('group-b.tsx')
  write(gA, 'A-new')
  write(gB, 'B-new')
  recordEdit(ROOT, gA, 'A-old', 'A-new', undefined, 'comment:x1')
  recordEdit(ROOT, gB, 'B-old', 'B-new', undefined, 'comment:x1')
  r = await undo(ROOT)
  ok(r.ok && read(gA) === 'A-old' && read(gB) === 'B-old', 'one undo reverts BOTH files in the group')
  ok(!canUndo(ROOT) && canRedo(ROOT), 'the whole group was a single undo step')
  r = await redo(ROOT)
  ok(r.ok && read(gA) === 'A-new' && read(gB) === 'B-new', 'one redo re-applies the whole group')

  // --- group undo is all-or-nothing: a drifted file in the group refuses the batch ---
  clearHistory(ROOT)
  write(gA, 'A2')
  write(gB, 'B2')
  recordEdit(ROOT, gA, 'A1', 'A2', undefined, 'comment:x2')
  recordEdit(ROOT, gB, 'B1', 'B2', undefined, 'comment:x2')
  write(gB, 'USER-TOUCHED') // one file in the group drifted
  r = await undo(ROOT)
  ok(!r.ok && r.conflict, `group undo refuses when any file drifted: ${JSON.stringify(r)}`)
  ok(read(gA) === 'A2', 'all-or-nothing: the un-drifted file was NOT reverted')

  // --- addressable per-turn revert (chat "Revert changes"): a group anywhere in the
  //     stack restores its `before`, all-or-nothing, and leaves the undo stack after ---
  clearHistory(ROOT)
  const t1a = file('turn1-a.tsx')
  const t1b = file('turn1-b.tsx')
  const t2 = file('turn2.tsx')
  // Turn 1 edits two files (one group), turn 2 edits a THIRD, later file.
  write(t1a, 'T1A-new')
  write(t1b, 'T1B-new')
  recordEdit(ROOT, t1a, 'T1A-old', 'T1A-new', undefined, 'chat:wt:1')
  recordEdit(ROOT, t1b, 'T1B-old', 'T1B-new', undefined, 'chat:wt:1')
  write(t2, 'T2-new')
  recordEdit(ROOT, t2, 'T2-old', 'T2-new', undefined, 'chat:wt:2')

  ok(await canRevertGroup(ROOT, 'chat:wt:1'), 'turn 1 revertable while its files are untouched')
  ok(!(await canRevertGroup(ROOT, 'chat:wt:nope')), 'unknown group is not revertable')

  // Revert the OLDER turn 1 even though turn 2 is on top of the stack (addressable).
  r = await revertGroup(ROOT, 'chat:wt:1')
  ok(r.ok, `revert turn 1 ok: ${JSON.stringify(r)}`)
  ok(read(t1a) === 'T1A-old' && read(t1b) === 'T1B-old', 'revert restored BOTH of turn 1 files')
  ok(read(t2) === 'T2-new', 'reverting turn 1 left the later turn 2 untouched')
  ok(!(await canRevertGroup(ROOT, 'chat:wt:1')), 'turn 1 no longer revertable (left the stack)')
  ok(canUndo(ROOT), 'turn 2 still on the undo stack after reverting turn 1')

  // --- revert is refused (conflict) when a file drifted since the turn, and does not clobber ---
  clearHistory(ROOT)
  const dr = file('drift.tsx')
  write(dr, 'D-new')
  recordEdit(ROOT, dr, 'D-old', 'D-new', undefined, 'chat:wt:9')
  write(dr, 'USER-EDIT') // a later hand edit — the turn's files drifted
  ok(!(await canRevertGroup(ROOT, 'chat:wt:9')), 'drifted group reports not-revertable')
  r = await revertGroup(ROOT, 'chat:wt:9')
  ok(!r.ok && r.conflict && r.file === dr, `revert refuses on drift: ${JSON.stringify(r)}`)
  ok(read(dr) === 'USER-EDIT', 'conflicted revert did NOT clobber the drifted file')

  // --- group revert is all-or-nothing: one drifted file blocks the whole turn ---
  clearHistory(ROOT)
  const ga = file('rg-a.tsx')
  const gb = file('rg-b.tsx')
  write(ga, 'GA-new')
  write(gb, 'GB-new')
  recordEdit(ROOT, ga, 'GA-old', 'GA-new', undefined, 'chat:wt:5')
  recordEdit(ROOT, gb, 'GB-new', 'GB-new2', undefined, 'chat:wt:5') // second write in the group
  write(gb, 'GB-new2')
  write(ga, 'GA-DRIFTED') // only one file in the group drifted
  r = await revertGroup(ROOT, 'chat:wt:5')
  ok(!r.ok && r.conflict, `group revert refuses when any file drifted: ${JSON.stringify(r)}`)
  ok(read(gb) === 'GB-new2', 'all-or-nothing: the un-drifted file was NOT reverted')

  if (failed === 0) console.log('EDIT-HISTORY OK — record/coalesce/undo/redo/conflict/group/root-scope/revert')
  else console.error(`EDIT-HISTORY: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('EDIT-HISTORY FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
