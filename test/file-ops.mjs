/**
 * file-ops.ts unit test (pure — no Electron). The editor sidebar's file manager:
 * create / rename / delete, over real temp dirs.
 *
 * The paths these take come straight from the renderer, so the guards matter as
 * much as the happy paths: no traversal, no absolute paths, nothing inside
 * .git/.praxis/.dsgn/node_modules, no silent clobber of an existing file. Also
 * asserts the case-only rename (Foo.tsx → foo.tsx) that a case-insensitive
 * filesystem would otherwise report as "already exists", and that delete prefers
 * the injected trash hook (main passes shell.trashItem) but still removes the
 * file when trashing throws.
 *
 * Run with: bun run test:file-ops
 */
import {
  createProjectFile,
  deleteProjectFile,
  normalizeRelPath,
  renameProjectFile
} from '../src/main/file-ops.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'file-ops-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) (failed++, console.error('  ✗', msg))
}

try {
  // --- normalizeRelPath: the one gate every op goes through ---
  ok(normalizeRelPath('src/a.ts') === 'src/a.ts', 'plain relative path passes')
  ok(normalizeRelPath('src\\a.ts') === 'src/a.ts', 'backslashes normalize to POSIX')
  ok(normalizeRelPath('  src//a.ts ') === 'src/a.ts', 'trims and collapses empty segments')
  ok(normalizeRelPath('../escape.ts') === null, 'traversal rejected')
  ok(normalizeRelPath('src/../../escape.ts') === null, 'mid-path traversal rejected')
  ok(normalizeRelPath('/etc/passwd') === null, 'absolute path rejected')
  ok(normalizeRelPath('C:/win.ts') === null, 'windows drive path rejected')
  ok(normalizeRelPath('') === null, 'empty path rejected')
  ok(normalizeRelPath('a\0b.ts') === null, 'NUL byte rejected')
  ok(normalizeRelPath('.git/config') === null, '.git rejected')
  ok(normalizeRelPath('.praxis/annotations.json') === null, '.praxis sidecar rejected')
  ok(normalizeRelPath('sub/.dsgn/x.json') === null, 'legacy .dsgn sidecar rejected at depth')
  ok(normalizeRelPath('node_modules/x/index.js') === null, 'node_modules rejected')

  // --- create ---
  let res = await createProjectFile(root, 'src/new/Thing.tsx')
  ok(res.ok && res.path === 'src/new/Thing.tsx', 'create returns the normalized path')
  ok(existsSync(join(root, 'src/new/Thing.tsx')), 'create makes missing parent dirs')
  ok(readFileSync(join(root, 'src/new/Thing.tsx'), 'utf8') === '', 'created file is empty')

  writeFileSync(join(root, 'taken.ts'), 'keep me')
  res = await createProjectFile(root, 'taken.ts')
  ok(!res.ok, 'create refuses an existing path')
  ok(readFileSync(join(root, 'taken.ts'), 'utf8') === 'keep me', 'refused create left it intact')

  res = await createProjectFile(root, '../outside.ts')
  ok(!res.ok, 'create refuses traversal')
  ok(!existsSync(join(root, '..', 'outside.ts')), 'nothing written outside the root')

  mkdirSync(join(root, '.git'), { recursive: true })
  res = await createProjectFile(root, '.git/hooks/pre-commit')
  ok(!res.ok && !existsSync(join(root, '.git/hooks')), 'create refuses .git')

  // --- rename (and move) ---
  writeFileSync(join(root, 'src/old.ts'), 'body')
  res = await renameProjectFile(root, 'src/old.ts', 'src/renamed.ts')
  ok(res.ok && res.path === 'src/renamed.ts', 'rename reports the new path')
  ok(!existsSync(join(root, 'src/old.ts')), 'old path gone')
  ok(readFileSync(join(root, 'src/renamed.ts'), 'utf8') === 'body', 'content preserved')

  res = await renameProjectFile(root, 'src/renamed.ts', 'moved/deep/renamed.ts')
  ok(res.ok && existsSync(join(root, 'moved/deep/renamed.ts')), 'rename can move + make dirs')

  writeFileSync(join(root, 'a.ts'), 'a')
  writeFileSync(join(root, 'b.ts'), 'b')
  res = await renameProjectFile(root, 'a.ts', 'b.ts')
  ok(!res.ok, 'rename refuses to clobber an existing file')
  ok(readFileSync(join(root, 'b.ts'), 'utf8') === 'b', 'clobber target untouched')
  ok(existsSync(join(root, 'a.ts')), 'source still there after a refused rename')

  // Case-only rename must work even where the filesystem says the target exists.
  res = await renameProjectFile(root, 'a.ts', 'A.ts')
  ok(res.ok && res.path === 'A.ts', 'case-only rename allowed')

  res = await renameProjectFile(root, 'A.ts', '../escaped.ts')
  ok(!res.ok && existsSync(join(root, 'A.ts')), 'rename refuses to move outside the root')

  res = await renameProjectFile(root, 'nope.ts', 'other.ts')
  ok(!res.ok, 'rename of a missing file fails')

  mkdirSync(join(root, 'adir'), { recursive: true })
  res = await renameProjectFile(root, 'adir', 'bdir')
  ok(!res.ok && existsSync(join(root, 'adir')), 'directories are not renamed')

  // --- delete ---
  const trashed = []
  res = await deleteProjectFile(root, 'b.ts', async (abs) => {
    trashed.push(abs)
  })
  ok(res.ok && res.path === 'b.ts', 'delete reports the path')
  ok(trashed.length === 1 && trashed[0] === join(root, 'b.ts'), 'delete used the trash hook')
  ok(existsSync(join(root, 'b.ts')), 'the trash hook owns removal — file-ops did not unlink')

  res = await deleteProjectFile(root, 'A.ts', async () => {
    throw new Error('no desktop session')
  })
  ok(res.ok, 'delete falls back to a plain remove when trashing fails')
  ok(!existsSync(join(root, 'A.ts')), 'fallback actually removed the file')

  res = await deleteProjectFile(root, 'taken.ts')
  ok(res.ok && !existsSync(join(root, 'taken.ts')), 'delete without a trash hook removes')

  res = await deleteProjectFile(root, '../../etc/hosts')
  ok(!res.ok, 'delete refuses traversal')
  res = await deleteProjectFile(root, '.git')
  ok(!res.ok && existsSync(join(root, '.git')), 'delete refuses .git')
  res = await deleteProjectFile(root, 'adir')
  ok(!res.ok && existsSync(join(root, 'adir')), 'delete refuses a directory')
  res = await deleteProjectFile(root, 'gone.ts')
  ok(!res.ok, 'delete of a missing file fails')

  if (failed === 0) console.log('FILE-OPS OK — create/rename/delete, path guards, trash fallback')
  else console.error(`FILE-OPS: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('FILE-OPS FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
