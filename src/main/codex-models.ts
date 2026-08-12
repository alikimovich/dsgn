import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { type CatalogModel, parseCodexModels } from './model-catalog'

/**
 * "Which models does the Codex CLI actually have?" — the side-effecting half of
 * the Codex seat's entry in the model picker.
 *
 * Split out of `providers.ts` (which was over the 500-line rule with it inline)
 * and named like its siblings `codex-usage.ts` / `backends/codex-retry.ts`: the
 * small Codex-specific pieces that live next to, not inside, the backend. The
 * PURE half — parsing the payload, caching it — is `model-catalog.ts`; this file
 * is only "find the right binary and run it".
 *
 * No electron import, so it stays loadable outside the app; it is not in the bun
 * test tier only because the interesting behaviour (the parse) is next door.
 */

const execFileP = promisify(execFile)

/** `${platform}-${arch}` → [the SDK's platform package, its vendor triple]. A
 *  verbatim copy of the SDK's own `PLATFORM_PACKAGE_BY_TARGET` + target switch
 *  (@openai/codex-sdk/dist/index.js) — see `codexBinary` for why we re-derive it. */
const CODEX_TARGETS: Record<string, [pkg: string, triple: string]> = {
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc']
}

/**
 * The `codex` binary to ask for the model list.
 *
 * It has to be the SAME binary the SDK spawns for turns, or the picker would
 * advertise a different CLI's models than the one that runs them. That binary is
 * NOT the one on PATH: `@openai/codex-sdk` resolves a VENDORED executable out of
 * its `@openai/codex` platform package, so a user with an older global `codex`
 * (or none at all — the PATH probe in `backends/codex.ts` is only a "has the user
 * set Codex up" proxy) would otherwise be asked the wrong question, or none.
 *
 * The SDK keeps `findCodexPath()` private, so this re-derives it: the same triple
 * map, the same `vendor/<triple>/…` layout, both the current (`bin/codex`) and
 * legacy (`codex/codex`) shapes. Every step is best-effort and falls through to
 * plain `codex` on PATH — a wrong guess costs a failed probe and the
 * cached/last-resort list, never a broken turn.
 *
 * `PRAXIS_CODEX_BIN` wins, mirroring `backends/codex.ts` (it's how
 * test/provider-seam.mjs forces the CLI-absent path).
 */
function codexBinary(): string {
  const override = process.env.PRAXIS_CODEX_BIN
  if (override) return override
  const target = CODEX_TARGETS[`${process.platform}-${process.arch}`]
  if (target) {
    const [pkg, triple] = target
    try {
      // Resolved from the compiled main (out/main/index.js), so the walk finds
      // the app's own node_modules in dev and in an installed ~/.praxis clone.
      // `@openai/codex-sdk` can't be the anchor: its package.json is hidden
      // behind an `exports` map, so only `@openai/codex` (which has none) is
      // reachable — the same anchor the SDK itself uses.
      const fromMain = createRequire(join(__dirname, 'index.js'))
      const platformPkg = createRequire(fromMain.resolve('@openai/codex/package.json')).resolve(
        `${pkg}/package.json`
      )
      const vendor = join(dirname(platformPkg), 'vendor', triple)
      const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
      for (const candidate of [join(vendor, 'bin', exe), join(vendor, 'codex', exe)]) {
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* optional dependency missing / bundler-relocated main — fall through */
    }
  }
  return 'codex'
}

/** Long enough for a cold CLI start (~840ms measured), short enough that a
 *  wedged binary can't hold `providers.ts`'s cold-start wait open for a
 *  user-visible age. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * Ask the Codex CLI what models it has. `codex debug models` prints its whole
 * model table as JSON — no network, no auth, no side effects.
 *
 * Resolves to `[]` on ANY failure (missing binary, non-zero exit, timeout, a
 * future CLI that renamed the subcommand or stopped printing JSON): an empty
 * list is never cached, so a failed probe simply leaves the previous answer — or
 * the last-resort list — in place. The payload is ~300KB (each entry embeds its
 * full instruction preamble), hence the raised `maxBuffer` and the absolute ban
 * on logging it.
 */
export async function discoverCodexModels(): Promise<CatalogModel[]> {
  try {
    const { stdout } = await execFileP(codexBinary(), ['debug', 'models'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    return parseCodexModels(JSON.parse(stdout))
  } catch {
    return []
  }
}
