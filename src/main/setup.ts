import { ipcMain } from 'electron'
import { access, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Frontend, SetupResult, SetupStrategy } from '../shared/api'

/**
 * Project setup — make a repo praxis-ready, FRAMEWORK-FIRST. We detect the UI
 * framework from package.json before generating anything, then emit the right
 * source-mapping instrumentation for it (never a React Babel plugin in a Svelte
 * repo). Everything lands in a namespaced `.praxis/` dir, is structurally dev-gated
 * (not just a comment), idempotent, and removable via uninstall. The agent does
 * the config wiring + prop typing with framework-correct instructions.
 */

const PRAXIS_DIR = '.praxis'
const REACT_HELPER = '.praxis/praxis-source.cjs'
const RN_HELPER = '.praxis/praxis-rn-source.cjs'
// `.mjs` pins ESM regardless of the repo's package.json `type` (plain Svelte+Vite
// repos are often `type: commonjs`, where a bare `.js` ESM file fails to import) —
// mirrors the React helper pinning CommonJS via `.cjs`.
const SVELTE_HELPER = '.praxis/praxis-svelte-stamp.mjs'
// Pre-rename (dsgn-era) files: the old root-level plugin plus the `.dsgn/`
// helpers written before the 2026-07 dsgn→praxis rename. Removed on uninstall.
const LEGACY_FILES = [
  'dsgn-source-plugin.cjs', // the old (buggy) root-level file
  '.dsgn/dsgn-source.cjs',
  '.dsgn/dsgn-rn-source.cjs',
  '.dsgn/dsgn-svelte-stamp.mjs'
]

// React/Solid: a JSX Babel plugin that stamps data-praxis-source. Structurally
// dev-gated (returns an empty visitor in production — not trust-the-comment).
const REACT_HELPER_CONTENT = `// Added by Praxis (.praxis/). Stamps data-praxis-source="path:line:col" on JSX elements
// so Praxis can map a clicked element to its source. Wire into the React Babel
// plugins for DEVELOPMENT ONLY; it also self-disables in production builds.
module.exports = function praxisSource({ types: t }) {
  if (process.env.NODE_ENV === 'production') return { name: 'praxis-source', visitor: {} }
  const path = require('path')
  return {
    name: 'praxis-source',
    visitor: {
      JSXOpeningElement(p, state) {
        const loc = p.node.loc
        if (!loc) return
        if (p.node.attributes.some((a) => a.name && a.name.name === 'data-praxis-source')) return
        const root = state.file.opts.root || process.cwd()
        const file = path.relative(root, state.file.opts.filename || '')
        const where = file + ':' + loc.start.line + ':' + loc.start.column
        // Host stamp: APPEND so the innermost host's own location wins (a forwarded
        // {...props} value is overwritten by this).
        p.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-praxis-source'), t.stringLiteral(where)))
        // v8 F3a — component-instance stamp: on COMPONENT tags (Capitalized or a
        // member like Foo.Bar), UNSHIFT (insert first) so a child's {...props}
        // spread overwrites it with the OUTER authored instance — the instance call
        // site wins over the host, letting the inspector edit per-instance props.
        const name = p.node.name
        // A component tag is any non-host (React's own test: host iff /^[a-z]/) — a
        // member like Foo.Bar, or a non-lowercase identifier. Skip Fragment (it
        // rejects unknown props) to avoid a dev-console warning.
        const isHost = name && name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name)
        const isFragment =
          name &&
          ((name.type === 'JSXIdentifier' && name.name === 'Fragment') ||
            (name.type === 'JSXMemberExpression' &&
              name.property &&
              name.property.name === 'Fragment'))
        const isComponent =
          !isHost &&
          !isFragment &&
          name &&
          (name.type === 'JSXMemberExpression' || name.type === 'JSXIdentifier')
        if (isComponent) {
          p.node.attributes.unshift(
            t.jsxAttribute(t.jsxIdentifier('data-praxis-component-source'), t.stringLiteral(where))
          )
        }
      }
    }
  }
}
`

// React Native: the data-praxis-source analog. RN host elements have no DOM, so we
// stamp `testID="praxis:path:line:col"` — which iOS surfaces as the view's
// accessibilityIdentifier, letting praxis map an idb view-hierarchy hit back to
// source. Dev-gated; only stamps elements without an existing testID.
const RN_HELPER_CONTENT = `// Added by Praxis (.praxis/). Stamps testID="praxis:path:line:col" on JSX elements so
// Praxis can map a tapped simulator element to its source via idb's accessibility
// hierarchy. Wire into the React Native Babel plugins for DEVELOPMENT ONLY; it
// also self-disables in production builds.
module.exports = function praxisRnSource({ types: t }) {
  if (process.env.NODE_ENV === 'production') return { name: 'praxis-rn-source', visitor: {} }
  const path = require('path')
  return {
    name: 'praxis-rn-source',
    visitor: {
      JSXOpeningElement(p, state) {
        const loc = p.node.loc
        if (!loc) return
        // Don't clobber an existing testID (the app may rely on it for tests).
        if (p.node.attributes.some((a) => a.name && a.name.name === 'testID')) return
        const root = state.file.opts.root || process.cwd()
        const file = path.relative(root, state.file.opts.filename || '')
        p.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier('testID'),
            t.stringLiteral('praxis:' + file + ':' + loc.start.line + ':' + loc.start.column)
          )
        )
      }
    }
  }
}
`

// Svelte: a markup preprocessor that stamps data-praxis-source on elements. The
// line/col use svelte/compiler offsets (1-based line, 0-based col) so they match
// praxis's Svelte adapter. Dev-gated; idempotent.
const SVELTE_HELPER_CONTENT = `// Added by Praxis (.praxis/). A dev-only Svelte markup preprocessor that stamps
// data-praxis-source="path:line:col" on elements so Praxis can map them to source.
// Add to svelte.config preprocess for development only.
import { parse } from 'svelte/compiler'
import path from 'node:path'

const ELEMENT_TYPES = new Set(['RegularElement', 'Component', 'SvelteComponent'])

function lineCol(code, offset) {
  let line = 1, last = 0
  for (let i = 0; i < offset; i++) if (code[i] === '\\n') { line++; last = i + 1 }
  return { line, column: offset - last }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit))
    else if (v && typeof v === 'object') walk(v, visit)
  }
}

export default function praxisStamp() {
  const noop = { name: 'praxis-stamp', markup: ({ content }) => ({ code: content }) }
  if (process.env.NODE_ENV === 'production') return noop
  return {
    name: 'praxis-stamp',
    markup({ content, filename }) {
      let ast
      try { ast = parse(content, { modern: true, filename }) } catch { return { code: content } }
      const rel = filename ? path.relative(process.cwd(), filename) : 'unknown'
      const inserts = []
      walk(ast.fragment ?? ast, (n) => {
        if (!ELEMENT_TYPES.has(n.type) || typeof n.start !== 'number' || typeof n.name !== 'string') return
        const attrs = n.attributes || []
        if (attrs.some((a) => a.name === 'data-praxis-source')) return
        const pos = n.start + 1 + n.name.length
        // Only splice when start points exactly at '<name' — bail on any misaligned
        // offset rather than corrupt markup mid-token (mirrors props-svelte.ts).
        if (content.slice(n.start + 1, pos) !== n.name) return
        const { line, column } = lineCol(content, n.start)
        inserts.push({ pos, text: ' data-praxis-source="' + rel + ':' + line + ':' + column + '"' })
      })
      inserts.sort((a, b) => b.pos - a.pos)
      let code = content
      for (const i of inserts) code = code.slice(0, i.pos) + i.text + code.slice(i.pos)
      return { code }
    }
  }
}
`

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Read package.json dependency names (deps + devDeps + peerDeps). */
async function readDeps(root: string): Promise<Set<string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {})
    ])
  } catch {
    return new Set()
  }
}

async function svelteMajorOf(root: string): Promise<number> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const v = String(pkg.devDependencies?.svelte ?? pkg.dependencies?.svelte ?? '')
    const m = /(\d+)/.exec(v.replace(/^[^\d]*/, ''))
    return m ? Number(m[1]) : 5
  } catch {
    return 5
  }
}

interface Detected {
  framework: Frontend
  strategy: SetupStrategy
  svelteMajor?: number
}

/** Detect the UI framework from deps FIRST — never assume React. */
async function detect(root: string): Promise<Detected> {
  const deps = await readDeps(root)
  const has = (n: string): boolean => deps.has(n)
  // Svelte / SvelteKit
  if (has('@sveltejs/kit') || has('svelte')) {
    return {
      framework: 'svelte',
      strategy: 'svelte-preprocess',
      svelteMajor: await svelteMajorOf(root)
    }
  }
  // React Native / Expo FIRST (they also depend on react) — stamp testID, not
  // data-praxis-source, since RN host elements have no DOM.
  if (has('react-native') || has('expo')) {
    return { framework: 'react-native', strategy: 'babel-plugin-rn' }
  }
  // React (incl. the React Vite plugins)
  if (
    has('react') ||
    has('@vitejs/plugin-react') ||
    has('@vitejs/plugin-react-swc') ||
    has('next')
  ) {
    return { framework: 'react', strategy: 'babel-plugin' }
  }
  // Solid also uses JSX, so the same Babel JSX visitor works.
  if (has('solid-js')) return { framework: 'solid', strategy: 'babel-plugin' }
  // Vue has its own inspector ecosystem — prefer that, don't emit a bespoke plugin.
  if (has('vue')) return { framework: 'vue', strategy: 'inspector' }
  return { framework: 'unknown', strategy: 'none' }
}

async function scaffold(root: string): Promise<SetupResult> {
  try {
    const d = await detect(root)
    // Nothing to write for vue (use its inspector) or an unknown framework.
    if (d.strategy === 'inspector' || d.strategy === 'none') {
      return { ok: true, framework: d.framework, strategy: d.strategy, files: [], written: false }
    }
    const helper =
      d.strategy === 'svelte-preprocess'
        ? SVELTE_HELPER
        : d.strategy === 'babel-plugin-rn'
          ? RN_HELPER
          : REACT_HELPER
    const content =
      d.strategy === 'svelte-preprocess'
        ? SVELTE_HELPER_CONTENT
        : d.strategy === 'babel-plugin-rn'
          ? RN_HELPER_CONTENT
          : REACT_HELPER_CONTENT
    await mkdir(join(root, PRAXIS_DIR), { recursive: true })
    const abs = join(root, helper)
    let written = false
    if (!(await exists(abs))) {
      await writeFile(abs, content, 'utf8')
      written = true
    }
    return {
      ok: true,
      framework: d.framework,
      strategy: d.strategy,
      files: [helper],
      written,
      ...(d.svelteMajor ? { svelteMajor: d.svelteMajor } : {})
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function uninstall(root: string): Promise<SetupResult> {
  try {
    const removed: string[] = []
    for (const f of [REACT_HELPER, RN_HELPER, SVELTE_HELPER, ...LEGACY_FILES]) {
      const abs = join(root, f)
      if (await exists(abs)) {
        await rm(abs)
        removed.push(f)
      }
    }
    return { ok: true, files: removed }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerSetupIpc(): void {
  // Read-only probe: detect the UI framework without writing, so the renderer can
  // decide whether setup is even possible (an 'unknown'/vanilla project has no
  // instrumentation strategy — never offer a dead-end "Set it up").
  ipcMain.handle('setup:detect', async (_e, root: string) => {
    const d = await detect(root)
    return { framework: d.framework, canInstrument: d.framework !== 'unknown' }
  })
  ipcMain.handle('setup:scaffold', (_e, root: string) => scaffold(root))
  ipcMain.handle('setup:uninstall', (_e, root: string) => uninstall(root))
}
