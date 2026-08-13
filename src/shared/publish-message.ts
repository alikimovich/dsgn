/**
 * Build the Publish commit/PR title + body from what the user actually asked
 * praxis to do this session (pure — unit-tested via bun, no electron).
 *
 * The squash-merge commit on the default branch inherits these, so the GitHub
 * history reads as real work ("Remove the tooltip from the PLUS8 entry (+2
 * more)") instead of "praxis: publish praxis/main".
 */

/** Strip praxis's own element-reference preamble from a seeded selection ask. */
const cleanAsk = (t: string): string =>
  t
    .replace(/^In the preview I selected [\s\S]*?\.\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

const truncate = (t: string, max: number): string =>
  t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`

export interface PublishMessage {
  title: string
  body: string
}

export function buildPublishMessage(
  branch: string,
  asks: string[],
  diffstat?: string
): PublishMessage {
  const cleaned = asks.map(cleanAsk).filter(Boolean)
  const first = cleaned[0] ?? ''

  let title = first ? truncate(first, 64) : `Praxis: publish ${branch}`
  if (cleaned.length > 1) title += ` (+${cleaned.length - 1} more)`

  const lines: string[] = []
  if (cleaned.length > 0) {
    lines.push('Changes requested in Praxis:')
    for (const ask of cleaned.slice(0, 20)) lines.push(`- ${truncate(ask, 200)}`)
    if (cleaned.length > 20) lines.push(`- …and ${cleaned.length - 20} more`)
  }
  const stat = diffstat?.trim()
  if (stat) {
    if (lines.length) lines.push('')
    lines.push('```', ...stat.split('\n').slice(0, 16), '```')
  }
  if (!lines.length) lines.push('Published from Praxis.')

  return { title, body: lines.join('\n') }
}
