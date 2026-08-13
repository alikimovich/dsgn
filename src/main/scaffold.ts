import { execFile } from 'child_process'
import { mkdir, readdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { promisify } from 'util'

/**
 * Create a brand-new project from praxis: a minimal Vite + React + TS app written
 * directly (no network templates, deterministic), then `git init` + first commit
 * and a dependency install (bun if available, else npm). Pure node (no electron)
 * so it's unit-testable against a temp dir.
 */

const execFileP = promisify(execFile)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface CreateProjectResult {
  ok: boolean
  root?: string
  error?: string
  /**
   * The project was created, but something non-fatal went wrong that the user
   * needs to know about NOW rather than discover later. Today that means the
   * `git init` + first commit didn't work: everything still runs, but praxis's
   * branch and publish flow both need a repository, so publish would otherwise
   * fail much later with a message that never mentions git (see
   * `annotations.ts`'s "isn't the repository root").
   */
  warning?: string
}

/** Folder basename → a valid npm package name. */
export function packageName(root: string): string {
  const name = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return name || 'my-app'
}

const templateFiles = (name: string): Record<string, string> => ({
  'package.json': `${JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' },
      devDependencies: {
        '@types/react': '^19.1.0',
        '@types/react-dom': '^19.1.0',
        '@vitejs/plugin-react': '^5.0.0',
        typescript: '^5.8.0',
        vite: '^7.0.0'
      }
    },
    null,
    2
  )}\n`,
  // Patterns are intentionally slash-free (`node_modules`, not `node_modules/`): a
  // trailing-slash pattern is directory-only and won't match the node_modules SYMLINK
  // Praxis stitches into each chat worktree (see worktrees.ts's RUNTIME_DEPS note).
  '.gitignore':
    'node_modules\ndist\ndist-ssr\n.DS_Store\n*.local\n.env\n.env.*\n!.env.example\nnpm-debug.log*\nyarn-error.log*\n',
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()]
})
`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        isolatedModules: true,
        skipLibCheck: true
      },
      include: ['src']
    },
    null,
    2
  )}\n`,
  'src/main.tsx': `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
`,
  'src/App.tsx': `export default function App() {
  return (
    <main className="hero">
      <h1>${name}</h1>
      <p>Fresh project, created with Praxis. Ask the chat to make it yours.</p>
    </main>
  )
}
`,
  'src/styles.css': `:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  color: #1a1a1a;
  background: #ffffff;
}

body {
  margin: 0;
}

.hero {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.hero p {
  color: #6b6b6b;
}
`
})

async function hasBun(): Promise<boolean> {
  try {
    await execFileP('bun', ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export async function createProject(
  root: string,
  opts: { install?: boolean } = {}
): Promise<CreateProjectResult> {
  // Never scaffold into a folder that already has content.
  try {
    const entries = await readdir(root)
    if (entries.filter((e) => e !== '.DS_Store').length > 0) {
      return { ok: false, error: `${root} already exists and isn't empty.` }
    }
  } catch {
    /* doesn't exist yet — good */
  }

  const name = packageName(root)
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    for (const [file, content] of Object.entries(templateFiles(name))) {
      await writeFile(join(root, file), content, 'utf8')
    }
  } catch (e) {
    return { ok: false, error: `Could not write the project files: ${msg(e)}` }
  }

  // Git first (fast, and the initial commit captures the clean template even if
  // the install below fails). Still non-fatal — the project runs either way — but
  // NOT silent any more. A swallowed failure here is invisible until the user
  // hits Publish, which then reports "this folder isn't the repository root"
  // (annotations.ts) without ever mentioning git: if the new folder sits inside
  // some other repo, that parent is what git resolves to, so praxis looks like it
  // is refusing for a reason the user can't act on. Say it here, while they're
  // looking at the thing that just failed.
  let warning: string | undefined
  try {
    await execFileP('git', ['init', '-b', 'main'], { cwd: root, timeout: 10000 })
  } catch (e) {
    warning =
      `Project created, but \`git init\` failed: ${msg(e)}. Praxis needs a repository ` +
      `to create work branches and to publish, so run \`git init\` in ${root} before publishing.`
  }
  if (!warning) {
    try {
      await execFileP('git', ['add', '-A'], { cwd: root, timeout: 10000 })
      await execFileP('git', ['commit', '-m', 'Initial commit from Praxis'], {
        cwd: root,
        timeout: 10000
      })
    } catch (e) {
      // The repo exists, so branching and publishing work — only the first commit
      // is missing, and the usual cause is a machine with no git identity set.
      warning =
        `Project created and \`git init\` succeeded, but the first commit failed: ${msg(e)}. ` +
        `If git has no identity here, set one with \`git config --global user.email "you@example.com"\` ` +
        `and \`git config --global user.name "Your Name"\`, then commit.`
    }
  }

  if (opts.install !== false) {
    const pm = (await hasBun()) ? 'bun' : 'npm'
    try {
      await execFileP(pm, ['install'], {
        cwd: root,
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024
      })
    } catch (e) {
      return { ok: false, error: `Project created, but ${pm} install failed: ${msg(e)}` }
    }
  }

  return { ok: true, root, ...(warning ? { warning } : {}) }
}
