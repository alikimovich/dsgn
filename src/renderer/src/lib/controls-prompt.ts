import type { PropInspection, SelectedElement } from '../../../shared/api'
import { describeSelectionForPrompt, oneLine } from '../store'

/**
 * The "Surface controls with AI" trigger prompt (Custom Controls, v10) — a real
 * auto-sent agent turn, like the setup offer's second half. The instrument-first
 * workflow is spelled out here because only the Claude backend carries the
 * `define_controls` tool (whose schema documents the manifest shape); the other
 * backends get the props-based fallback the Props tab can pick up. Element-
 * derived fields are page-sourced (semi-trusted) → collapsed through oneLine,
 * same as every other selection-seeded prompt.
 */
export function controlsPrompt(
  element: SelectedElement,
  inspection: PropInspection | null,
  hint: string | undefined,
  provider: string,
  oldManifest?: { json: string; brokenIds: string[] }
): string {
  const lines: string[] = [describeSelectionForPrompt(element).trim()]
  if (element.componentSource && element.componentSource !== element.source) {
    lines.push(`Its owning component instance is at ${oneLine(element.componentSource, 200)}.`)
  }
  if (inspection?.component) {
    lines.push(`The inspected component is \`${oneLine(inspection.component, 64)}\`.`)
  }
  lines.push(
    hint
      ? `I want a live control panel for this element. What I want to control: "${oneLine(hint, 500)}".`
      : `I want a live control panel for the design parameters that drive this element (timings, sizes, counts, colors — whatever it exposes).`,
    ``,
    `1. Read the element's source and find the values behind those parameters, including ones buried in magic numbers, config objects, or hooks.`,
    `2. If a value isn't already a tweakable target, instrument it first: extract it to a named top-level constant in the component's OWN file (e.g. \`const STAGGER_MS = 120\`), or expose it as a typed prop with a literal default. Keep runtime behavior identical.`
  )
  if (provider === 'claude') {
    lines.push(
      `3. Then call the \`define_controls\` tool ONCE with every parameter. For a 'literal' param, the anchor must occur exactly once in the file and end immediately before the value (ideal shape: \`const STAGGER_MS = \`). Pick strategies: \`prop\` for per-instance values, \`literal\` for module constants, \`style\` for pure CSS properties. For number params, give a sensible min/max/step and unit (those fields are only valid on kind 'number').`
    )
  } else {
    lines.push(
      `3. Expose each parameter as a typed prop with a literal default — the Props panel picks them up when I re-inspect the element.`
    )
  }
  lines.push(`Never create or edit files under \`.praxis/\`.`)
  if (oldManifest) {
    lines.push(
      ``,
      `This panel already exists but some of its controls no longer resolve (broken param ids: ${oldManifest.brokenIds.join(', ') || 'none'}). The current manifest:`,
      '```json',
      oldManifest.json,
      '```',
      `Re-instrument the source as needed and register a corrected panel — it replaces the existing one for the same file and component.`
    )
  }
  return lines.join('\n')
}
