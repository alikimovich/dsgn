/**
 * Ranking for the composer's "/" menu — pure, so both the renderer (which must
 * not touch the filesystem) and unit tests can share it.
 *
 * A query is matched case-insensitively as a substring of the command name.
 * Project skills (`source: 'project'`, discovered in the opened repo) rank ahead
 * of everything the backend advertises, and a same-named non-project command is
 * shadowed by its project skill (main already dedupes cross-source; this guards
 * store seeds / other backends too).
 *
 * There is deliberately NO result cap: the menu's own scroll container
 * (`.slash { max-height; overflow-y: auto }`) handles overflow, so every match
 * stays reachable instead of the list silently truncating at N.
 */
import type { SlashCommandItem } from './api'

export function rankSlashMatches(commands: SlashCommandItem[], query: string): SlashCommandItem[] {
  const q = query.toLowerCase()
  const hits = commands.filter((c) => c.name.toLowerCase().includes(q))
  const project = hits.filter((c) => c.source === 'project')
  const shadowed = new Set(project.map((c) => c.name))
  const other = hits.filter((c) => c.source !== 'project' && !shadowed.has(c.name))
  return [...project, ...other]
}
