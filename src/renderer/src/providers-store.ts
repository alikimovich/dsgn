import { create } from 'zustand'
import type { ModelChoice, ProviderConnection } from '../../shared/api'

/**
 * v10 user-added model endpoints, renderer side. Kept OUT of `store.ts` (already
 * oversized — see docs/TASKS.md) because it's a self-contained slice: the saved
 * connections, the flat `ModelChoice[]` the chat's model picker renders, and the
 * Settings dialog's open flag (the same single-global-flag pattern as
 * `useFeedback`/`useGithub`, so the app menu, the picker's "Manage providers…"
 * row and anything else can raise the one dialog App renders).
 *
 * Nothing here ever holds an API key: main only ever hands back `hasKey`, and the
 * dialog keeps a typed key in component state for exactly as long as the form is
 * open. `choices` is built in MAIN (built-in seats first, then one group per
 * connection) so the renderer never hardcodes a model list.
 */
interface ProvidersState {
  connections: ProviderConnection[]
  /** Everything the chat's model picker offers, in main's order (groups are runs). */
  choices: ModelChoice[]
  /** True once a refresh has completed at least once (drives the picker's fallback). */
  loaded: boolean
  loading: boolean
  /** The one Settings dialog (Cmd+, / the picker's "Manage providers…" row). */
  settingsOpen: boolean
  setSettingsOpen: (settingsOpen: boolean) => void
  /**
   * Re-read both lists from main. Called after every save/remove so the picker
   * updates immediately. Best-effort: an IPC failure leaves the previous lists in
   * place rather than blanking the picker mid-session.
   */
  refresh: () => Promise<void>
  /** Fetch once, lazily — safe to call from every mount. */
  ensureLoaded: () => void
}

export const useProviders = create<ProvidersState>((set, get) => ({
  connections: [],
  choices: [],
  loaded: false,
  loading: false,
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  refresh: async () => {
    set({ loading: true })
    try {
      const [connections, choices] = await Promise.all([
        window.api.providers.list(),
        window.api.providers.choices()
      ])
      set({ connections, choices, loaded: true })
    } catch {
      // Keep whatever we had; the picker falls back to echoing the current value.
    } finally {
      set({ loading: false })
    }
  },
  ensureLoaded: () => {
    const s = get()
    if (s.loaded || s.loading) return
    void s.refresh()
  }
}))

/**
 * Which choice a chat's stored settings point at.
 *
 * A v10 pick stores `ModelChoice.value` outright. Anything persisted BEFORE v10
 * stored the bare model id ('opus', 'gpt-5-codex', 'default') alongside its
 * harness, so fall back to matching on `modelId` + harness + endpoint — otherwise
 * every pre-existing chat would open with a blank/duplicated picker. Undefined
 * when nothing matches (choices not loaded yet, or a deleted connection).
 */
export const resolveChoice = (
  choices: ModelChoice[],
  s: { model: string; provider?: string; connectionId?: string }
): ModelChoice | undefined =>
  choices.find((c) => c.value === s.model) ??
  choices.find(
    (c) =>
      (c.modelId ?? c.value) === s.model &&
      c.provider === (s.provider ?? 'claude') &&
      c.connectionId === s.connectionId
  )

/** Contiguous runs of `choices` sharing a `group` — the picker's `<optgroup>`s. */
export const groupChoices = (choices: ModelChoice[]): { group: string; items: ModelChoice[] }[] => {
  const groups: { group: string; items: ModelChoice[] }[] = []
  for (const c of choices) {
    const last = groups[groups.length - 1]
    if (last && last.group === c.group) last.items.push(c)
    else groups.push({ group: c.group, items: [c] })
  }
  return groups
}

// Exposed for the Playwright test harness (and handy for live debugging).
;(window as unknown as { __praxisProviders?: typeof useProviders }).__praxisProviders = useProviders
