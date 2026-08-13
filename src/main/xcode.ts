/**
 * Turn an opaque `xcrun simctl …` failure into actionable guidance. The raw
 * rejection is unhelpful ("Command failed: xcrun …"), so we sniff stderr + the
 * error code to tell the distinct cases apart instead of always blaming a
 * missing toolchain. Pure (no electron) so it's unit-testable.
 */
export function xcodeFailureReason(err: unknown): string {
  const e = (err ?? {}) as { stderr?: string; message?: string; code?: string | number }
  const text = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase()

  // Xcode IS installed — the license just hasn't been accepted (exit 69).
  if (text.includes('license')) {
    return 'Xcode is installed, but its license has not been accepted. Run `sudo xcodebuild -license accept` in a terminal, then reopen the project.'
  }
  // simctl needs full Xcode; this fires when only the CLT are selected, the
  // developer dir is wrong, or xcrun isn't on PATH.
  if (
    e.code === 'ENOENT' ||
    text.includes('xcode-select') ||
    text.includes('unable to find utility') ||
    text.includes('no developer tools') ||
    text.includes('cannot be located') ||
    text.includes('command line tools')
  ) {
    return 'Xcode is not installed or not selected. Install the full Xcode app, then run `sudo xcode-select -s /Applications/Xcode.app` and `xcodebuild -runFirstLaunch`.'
  }
  return `Could not run the iOS simulator tools: ${e.message ?? String(err)}`
}

/**
 * Pull the *meaningful* failure out of an xcodebuild / Metro log. xcodebuild
 * prints a large "Explicit dependency on target …" graph both before and after
 * the real error, so naively tailing the log surfaces that graph instead of the
 * cause (which is exactly what praxis showed for the broken-node build). Prefer
 * high-signal lines — script-phase aborts, dyld load failures, compiler/linker
 * errors — and carry a couple of trailing lines for context. Falls back to the
 * raw tail when nothing high-signal is present. Pure / unit-testable.
 */
const BUILD_SIGNAL_RE =
  /(dyld\[|Library not loaded|Reason: tried:|Abort trap|PhaseScriptExecution failed|Node found at:|fatal error:|\berror:|^ld: |Undefined symbol|The following build commands failed|Command .* failed with|No such file or directory|EADDRINUSE|command not found)/im

/** Lines that are pure dependency-graph noise — never the root cause. */
const BUILD_NOISE_RE = /(Explicit dependency on target|Target dependency graph|Prepare packages)/i

export function extractBuildError(log: string, max = 1400): string {
  if (!log) return ''
  const lines = log.split('\n')
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (BUILD_NOISE_RE.test(lines[i])) continue
    if (BUILD_SIGNAL_RE.test(lines[i])) {
      keep.add(i)
      for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
        if (!BUILD_NOISE_RE.test(lines[j])) keep.add(j)
      }
    }
  }
  if (keep.size === 0) return log.slice(-max).trim()
  let out = [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i].trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .trim()
  if (out.length > max) out = `…\n${out.slice(-max).trim()}` // keep the lines closest to the failure
  return out
}

/** Parse "26.5" / "18.4.1" → [26,5] / [18,4,1]; null if it isn't a version. */
export function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null
  const m = v.trim().match(/\d+(?:\.\d+)*/)
  if (!m) return null
  return m[0].split('.').map(Number)
}

/** Numeric segment-wise compare. Returns >0 if a>b, <0 if a<b, 0 if equal. */
export function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Modern Xcode couples simulator *builds* to its active iOS SDK: building for a
 * simulator needs an installed runtime whose version is >= the SDK's iOS version.
 * (Observed first-hand: Xcode 26.5's SDK refuses installed 26.0/26.1 runtimes —
 * `xcodebuild -showdestinations` then lists ZERO simulator destinations and the
 * build dies with "iOS 26.5 is not installed".) The catch: `simctl list devices
 * available` still shows those older devices, so a device-count preflight passes
 * while the build is already doomed. This detects the gap up front and hands back
 * the one-line fix instead of waiting for a multi-minute build to fail.
 *
 * Pure: feed it the SDK version (from `xcrun --sdk iphonesimulator
 * --show-sdk-version`) and the installed iOS runtime versions. `null`/unknown SDK
 * never blocks — we only fail when we're sure no runtime can satisfy the SDK.
 */
export function simBuildDestination(
  sdkVersion: string | null | undefined,
  runtimeVersions: string[]
): { ok: boolean; reason?: string } {
  const sdk = parseVersion(sdkVersion)
  if (!sdk) return { ok: true }
  const parsed = runtimeVersions.map(parseVersion).filter((v): v is number[] => v !== null)
  if (parsed.some((v) => cmpVersion(v, sdk) >= 0)) return { ok: true }
  const sdkStr = sdk.join('.')
  const newest = parsed.length
    ? [...parsed].sort(cmpVersion).pop()!.join('.')
    : null
  const have = newest ? ` (newest installed is iOS ${newest})` : ' (none installed)'
  return {
    ok: false,
    reason:
      `Xcode's iOS SDK is ${sdkStr}, but no matching simulator runtime is installed${have}. ` +
      'Builds need a runtime ≥ the SDK version. Download it with `xcodebuild -downloadPlatform iOS` ' +
      '(or Xcode → Settings → Components → Get the iOS simulator), then reopen the project.'
  }
}
