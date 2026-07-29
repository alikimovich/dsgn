import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import type { PropEditResult, StyleEdit, StyleEditResult } from '../shared/api'
import { classNameStringNode, commitEdit, findElementAtLine, resolveSource } from './props'
import { type ResolvedTokenRef, resolveTokenRef, tokenClassRewrite } from './style-tokens'
import { looksTailwind } from './tw-styles'
import { cssPropToJsKey, mergeStyleObjectSource } from './inline-style'
import { applyStyleEditSvelte } from './styles-svelte'

/**
 * The Styles-panel commit engine (v10). A scrub previews live via CSS injection
 * in the preview preload; on release the island sends `styles:apply` and this
 * module writes the change into source, Tailwind-first:
 *
 *  - S1 tailwind — the element's live classes look like utilities AND its
 *    `className` is a literal string → rewrite the single family-matching class
 *    (`p-4` → `p-[13px]`) and splice the new string.
 *  - S2 inline — no/ambiguous utility path → merge into the JSX `style={{…}}`
 *    literal (insert the attribute when absent).
 *  - S3 agent — anything we can't prove safe (no element at the stamp, dynamic
 *    className with no inline path, `style={expr}`, spread, existing inline
 *    `transition` shorthand when editing a `transition-*` longhand) → hand back
 *    `needsAgent` + a ready prompt, like prop editing.
 *
 * `.svelte` stamps dispatch to the Svelte adapter (styles-svelte.ts), same as
 * props.ts does. Every write goes through `commitEdit`, so HMR + undo are free;
 * the key coalesces a scrub burst into one undo step.
 */

/**
 * The fixed v1 editable property set. This is main's own copy — the renderer's
 * `css-values.ts` `STYLE_PROP_META` table mirrors it (minus its read-only
 * `font-family`/`display` chips), but main can't import renderer code, so the
 * two lists are kept in sync by hand. Anything else is rejected before any
 * file is read.
 */
export const STYLE_PROPS: ReadonlySet<string> = new Set([
  // layout
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap',
  // appearance
  'color', 'background-color', 'border-radius', 'opacity',
  // typography
  'font-size', 'font-weight', 'line-height', 'letter-spacing',
  // transition
  'transition-property', 'transition-duration', 'transition-delay',
  'transition-timing-function'
])

/**
 * A css value we're willing to splice into source: non-empty, bounded, and free
 * of `;` `}` `"` and newlines OUTSIDE function parens — those could terminate a
 * declaration, escape a style object, or break attribute quoting. Inside parens
 * (`cubic-bezier(…)`, `var(…)`) commas and dots are business as usual.
 */
export function isSafeStyleValue(value: string): boolean {
  if (!value.trim() || value.length > 200) return false
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return false
      depth--
    } else if (depth === 0 && (ch === ';' || ch === '}' || ch === '"' || ch === '\n')) {
      return false
    }
  }
  return depth === 0
}

export function styleAgentPrompt(
  edit: StyleEdit,
  element?: string,
  token?: ResolvedTokenRef | null
): string {
  const el = element ? `<${element}> element` : 'selected element'
  if (token) {
    return (
      `In ${edit.source}, set the css property \`${edit.prop}\` of the ${el} to the design ` +
      `token \`${token.name}\` (\`${token.ref}\`, currently \`${edit.value}\`). ` +
      `Use the project's token reference, not the literal value.`
    )
  }
  return `In ${edit.source}, set the css property \`${edit.prop}\` of the ${el} to \`${edit.value}\`.`
}

/** Map a commitEdit result into a StyleEditResult carrying the strategy used. */
function committed(
  res: PropEditResult,
  strategy: 'tailwind' | 'inline',
  wroteToken = false
): StyleEditResult {
  return res.applied ? { applied: true, strategy, wroteToken } : { applied: false, error: res.error }
}

/** The static key name of a style object entry (null for computed/spread/etc). */
function styleObjectKey(p: { type: string; [k: string]: unknown }): string | null {
  if (p.type !== 'ObjectProperty' || p.computed) return null
  const k = p.key as { type?: string; name?: string; value?: string } | undefined
  if (k?.type === 'Identifier') return k.name ?? null
  if (k?.type === 'StringLiteral') return k.value ?? null
  return null
}

/**
 * Apply a style edit from the island's Styles tab. Dispatches by the stamped
 * file's extension (`.svelte` → styles-svelte.ts), then walks the S1 → S2 → S3
 * strategy ladder above. Commit key `${source}:style:${prop}` keeps one undo
 * step per scrubbed property.
 */
export async function applyStyleEdit(root: string, edit: StyleEdit): Promise<StyleEditResult> {
  if (!STYLE_PROPS.has(edit.prop)) {
    return { applied: false, error: 'Unsupported style property.' }
  }
  if (typeof edit.value !== 'string' || !isSafeStyleValue(edit.value)) {
    return { applied: false, error: 'Invalid style value.' }
  }
  const loc = resolveSource(root, edit.source)
  if (!loc) return { applied: false, error: 'Could not resolve the source location.' }
  // Normalize the island-supplied fields BEFORE any dispatch — both engines
  // read them, and the IPC boundary doesn't guarantee their shape. `group` is
  // an opaque undo-batch label, so a bound + type check is all it needs.
  edit = {
    ...edit,
    classes: Array.isArray(edit.classes) ? edit.classes : [],
    group: typeof edit.group === 'string' && edit.group ? edit.group.slice(0, 120) : undefined
  }
  // Resolve a token pick BEFORE the framework dispatch, so both engines get the
  // same already-validated reference. The token's value comes from the repo's
  // own (semi-trusted) theme file, so the reference goes through the same
  // splice guard as any other value; failing it drops back to a plain edit.
  let token: ResolvedTokenRef | null = await resolveTokenRef(root, edit)
  if (token && !isSafeStyleValue(token.ref)) token = null
  if (loc.file.endsWith('.svelte')) return applyStyleEditSvelte(root, edit, loc, token)
  let code: string
  try {
    code = await readFile(loc.file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const found = await findElementAtLine(code, loc.line, loc.column)
  const toAgent = (): StyleEditResult => ({
    applied: false,
    needsAgent: true,
    agentPrompt: styleAgentPrompt(edit, found?.name, token)
  })
  if (!found) return toAgent() // stale stamp — the agent can still find it
  // An element-level spread could carry className/style at runtime — the final
  // attributes are unknowable, so neither a class rewrite nor an inserted style
  // attr is provably effective (same gate as the Svelte adapter).
  if ((found.opening.attributes ?? []).some((a) => a.type === 'JSXSpreadAttribute')) {
    return toAgent()
  }
  const key = `${edit.source}:style:${edit.prop}`
  const classes = edit.classes

  // S1 — Tailwind class rewrite: live classes look like utilities AND the
  // className is a literal string (same gate as the T2 token swap in props.ts).
  // An ambiguous rewrite (>1 family match) returns null → inline path.
  if (looksTailwind(classes)) {
    const classAttr = (found.opening.attributes ?? []).find(
      (a) => a.type === 'JSXAttribute' && (a.name as { name?: string })?.name === 'className'
    )
    const strNode = classNameStringNode(classAttr?.value ?? null)
    if (strNode) {
      const current = String((strNode as unknown as { value: string }).value)
      const rewritten = tokenClassRewrite(current, edit, token)
      if (rewritten != null) {
        const next =
          code.slice(0, strNode.start) + JSON.stringify(rewritten) + code.slice(strNode.end)
        return committed(
          await commitEdit(root, loc.file, code, next, key, edit.group),
          'tailwind',
          token != null
        )
      }
    }
  }

  // S2 — inline style splice. With a resolved token this writes the REFERENCE
  // (`var(--color-text)`) rather than the value it currently resolves to.
  const written = token?.ref ?? edit.value
  const styleAttr = (found.opening.attributes ?? []).find(
    (a) => a.type === 'JSXAttribute' && (a.name as { name?: string })?.name === 'style'
  )
  if (!styleAttr) {
    // No style attribute — insert one right after the tag name (props.ts pattern).
    const insertAt = (found.opening.name as { end: number }).end
    const attrText = ` style={{ ${cssPropToJsKey(edit.prop)}: ${JSON.stringify(written)} }}`
    const next = code.slice(0, insertAt) + attrText + code.slice(insertAt)
    return committed(
      await commitEdit(root, loc.file, code, next, key, edit.group),
      'inline',
      token != null
    )
  }
  const attrVal = styleAttr.value
  const expr = attrVal?.type === 'JSXExpressionContainer' ? attrVal.expression : undefined
  if (expr?.type === 'ObjectExpression') {
    // Editing a transition longhand while the object carries the `transition`
    // SHORTHAND: merging the longhand would silently lose to (or fight) the
    // shorthand at runtime — untangling it is the agent's job.
    const entries = (expr as { properties?: Array<{ type: string; [k: string]: unknown }> })
      .properties
    if (
      edit.prop.startsWith('transition-') &&
      (entries ?? []).some((p) => styleObjectKey(p) === 'transition')
    ) {
      return toAgent()
    }
    const merged = mergeStyleObjectSource(code.slice(expr.start, expr.end), edit.prop, written)
    if (merged != null) {
      const next = code.slice(0, expr.start) + merged + code.slice(expr.end)
      return committed(
        await commitEdit(root, loc.file, code, next, key, edit.group),
        'inline',
        token != null
      )
    }
  }

  // S3 — style={expr}, a spread/non-literal entry inside the object (merge
  // returned null), or a string-valued style attr (invalid JSX anyway).
  return toAgent()
}

export function registerStylesIpc(): void {
  // No sender check (matches props:*); path safety comes from resolveSource's
  // within-root containment + the allowlist/value validation above.
  ipcMain.handle('styles:apply', (_e, root: string, edit: StyleEdit) => applyStyleEdit(root, edit))
}
