import { access, mkdir, rename } from 'fs/promises'
import { join } from 'path'

/**
 * One-time move of the pre-rename `.dsgn/` DATA files into `.praxis/` so
 * annotations/tokens made before the 2026-07 dsgn→praxis rename survive. Only
 * files Praxis owns move; the old stamping helpers stay put because the repo's
 * own build config may still reference them (setup uninstall removes them).
 * Called on every project open (project:detect) — a no-op once migrated.
 * Pure (fs only, no electron) so it's unit-testable.
 */

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  )

export async function migrateLegacySidecar(root: string): Promise<void> {
  for (const f of ['annotations.json', 'tokens.json', 'control-panels.json']) {
    const from = join(root, '.dsgn', f)
    const to = join(root, '.praxis', f)
    try {
      if (!(await exists(from)) || (await exists(to))) continue
      await mkdir(join(root, '.praxis'), { recursive: true })
      await rename(from, to)
    } catch {
      /* best-effort — an unreadable legacy dir must not block opening */
    }
  }
}
