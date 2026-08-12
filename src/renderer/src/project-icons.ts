import { create } from 'zustand'
import type { ProjectIcon } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'

/**
 * Each open project's own favicon, so the rail can lead a project row with the
 * project's real icon instead of the generic folder glyph.
 *
 * Its own store rather than a slice of `store.ts` (already well over the ~500
 * line convention), and a store rather than component state so the icons
 * survive the rail unmounting — the rail re-renders on every unrelated chat
 * tick, and re-fetching base64 payloads on each of those would be silly.
 *
 * One fetch per project per app session: a project with no favicon caches as
 * `null` (the folder fallback is the right answer, and re-asking wouldn't
 * change it). The consequence is that ADDING a favicon to an open project shows
 * up on the next launch, not immediately — main revalidates a *changed* icon
 * file by mtime, but nothing re-asks after a miss. Worth a `refresh()` if that
 * ever bites; it isn't worth a poll.
 */
interface ProjectIconState {
  /** Resolved icons by `projectKey(root)`. A present-but-null entry means
   *  "asked, this project has none" — distinct from an absent one. */
  byKey: Record<string, ProjectIcon | null>
  /** Roots with a request in flight, so concurrent callers don't double-fetch. */
  loading: Record<string, boolean>
  /** Fetch this project's icon unless it's already known or in flight. */
  load: (root: string) => Promise<void>
}

export const useProjectIcons = create<ProjectIconState>((set, get) => ({
  byKey: {},
  loading: {},
  load: async (root) => {
    const key = projectKey(root)
    const state = get()
    if (key in state.byKey || state.loading[key]) return
    set((s) => ({ loading: { ...s.loading, [key]: true } }))
    // A missing icon is the common case, not an error — never let it reject.
    const icon = await window.api.project.icon(root).catch(() => null)
    set((s) => ({
      byKey: { ...s.byKey, [key]: icon },
      loading: { ...s.loading, [key]: false }
    }))
  }
}))
