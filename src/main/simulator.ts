import { app, ipcMain, type BrowserWindow } from 'electron'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'http'
import { readFile, unlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { xcodeFailureReason, simBuildDestination, extractBuildError } from './xcode'
import { findFreePort, stripAnsi } from './devserver-net'
import { FRAME_DATA_URI, FRAME_INSET, FRAME_ASPECT } from '../shared/iphone-frame'
import type { RunningSimulator, SimDevice, SimPreflight } from '../shared/api'

/**
 * iOS-Simulator preview runner — the React Native / Expo counterpart to
 * `devserver.ts`. It boots a simulator, starts Metro + launches the app, and
 * stands up a tiny local "sim bridge": an HTTP server that captures the booted
 * device's screen (via `xcrun simctl io … screenshot`) and serves it as an
 * MJPEG stream behind a one-`<img>` page. The renderer then points the existing
 * preview `WebContentsView` at that page — so the simulator is "just another
 * local URL" and every geometry/load/retry seam is reused unchanged.
 *
 * macOS-only: `preflight()` gates everything and returns a human `reason` (never
 * throws) so a non-Mac host shows a clean card instead of crashing. Frame
 * capture deliberately uses only `xcrun simctl` (ships with Xcode, zero extra
 * install); `idb` is detected for the Phase-2 interaction path but not required.
 */

const execFileP = promisify(execFile)
const HOST = '127.0.0.1'
// Above the web-preview base (7777) so the bridge never contends with a dev server.
const BRIDGE_PORT_BASE = 7800
const MJPEG_BOUNDARY = 'praxisframe'

// --- the served device page -------------------------------------------------

// Flagged `?praxisSim=1` (read by src/preview/preload.ts to skip the web overlay).
// Phase 2: when `interactive`, the page captures tap/swipe/scroll/type on the
// <img>, converts to a 0..1 fraction of the device content (object-fit:contain
// aware), and POSTs to /control — which idb replays on the device.
function pageHtml(interactive: boolean, token: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Simulator</title>
    <style>
      html, body { margin: 0; height: 100%; background: #fff; }
      body { display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
      /* The device box keeps the bezel's aspect ratio and fits the viewport. */
      #device {
        position: relative;
        aspect-ratio: ${FRAME_ASPECT};
        height: 100%;
        max-width: 100%;
        margin: 0 auto;
        container-type: size; /* enables cqw for the screen corner radius */
      }
      /* The live mirror sits in the bezel's transparent screen cutout; the opaque
         bezel (on top, pointer-events:none) masks the rounded screen corners.
         The img is wrapped in a sized box — an absolutely-positioned <img> with
         width:auto renders at intrinsic size (ignoring right/bottom), so the box
         carries the cutout geometry and the img just fills it. */
      #screen-box {
        position: absolute;
        left: ${FRAME_INSET.left}%;
        top: ${FRAME_INSET.top}%;
        right: ${FRAME_INSET.right}%;
        bottom: ${FRAME_INSET.bottom}%;
        overflow: hidden;
        /* Round (circularly, via cqw) so the square corners tuck under the
           bezel's rounded cutout instead of leaking a few px past it. */
        border-radius: 9cqw;
        background: #000;
      }
      #screen {
        width: 100%; height: 100%;
        object-fit: fill;
        display: block;
        -webkit-user-select: none;
      }
      #bezel {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        -webkit-user-select: none;
      }
      #hint { position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%);
        font: 11px -apple-system, system-ui, sans-serif; color: #666; background: rgba(255,255,255,.85);
        border: 1px solid #eee; border-radius: 6px; padding: 3px 8px; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="device">
      <div id="screen-box">
        <img id="screen" src="/stream?token=${token}" alt="iOS Simulator" draggable="false" tabindex="0" />
      </div>
      <img id="bezel" src="${FRAME_DATA_URI}" alt="" draggable="false" />
    </div>
    <div id="hint"${interactive ? ' hidden' : ''}>View-only — install <code>idb</code> for tap &amp; type</div>
    <script>
      var INTERACTIVE = ${interactive ? 'true' : 'false'};
      // Per-bridge secret, baked into this server-rendered page. Required on
      // /control and /stream so a random webpage in the user's browser can't
      // drive the simulator or read its screen (it can't read this HTML
      // cross-origin, so it can't learn the token). Exposed for the test harness.
      var TOKEN = ${JSON.stringify(token)};
      window.__PRAXIS_SIM_TOKEN = TOKEN;
      var img = document.getElementById('screen');
      // Surface failed commands (e.g. idb lost the device) instead of a dead-
      // feeling preview. View-only keeps its permanent hint; no flashing there.
      var hintEl = document.getElementById('hint');
      var hintTimer = null;
      function flashHint(text) {
        if (!INTERACTIVE) return;
        hintEl.textContent = text;
        hintEl.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { hintEl.hidden = true; }, 4000);
      }
      function post(cmd) {
        if (!INTERACTIVE) return;
        fetch('/control?token=' + encodeURIComponent(TOKEN), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cmd) })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok === false) flashHint('Interaction failed: ' + (j.error || 'unknown error'));
          })
          .catch(function(){});
      }
      // Pixel position on the screen <img> → 0..1 fraction. The img box IS the
      // device screen rect (positioned to the bezel cutout, object-fit:fill), so
      // the mapping is a straight rect-relative ratio. Null when outside the box.
      function frac(clientX, clientY) {
        var r = img.getBoundingClientRect();
        var x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return { x: x, y: y };
      }
      var down = null;
      img.addEventListener('pointerdown', function (e) {
        down = frac(e.clientX, e.clientY); img.focus();
      });
      img.addEventListener('pointerup', function (e) {
        if (!down) { down = null; return; }
        var up = frac(e.clientX, e.clientY) || down;
        var dx = up.x - down.x, dy = up.y - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.03) {
          post({ type: 'swipe', x: down.x, y: down.y, x2: up.x, y2: up.y });
        } else {
          post({ type: 'tap', x: up.x, y: up.y });
        }
        down = null;
      });
      // Wheel → a short swipe in the opposite direction (natural scroll).
      img.addEventListener('wheel', function (e) {
        var f = frac(e.clientX, e.clientY); if (!f) return;
        e.preventDefault();
        var dy = Math.max(-0.4, Math.min(0.4, -e.deltaY / 600));
        var dx = Math.max(-0.4, Math.min(0.4, -e.deltaX / 600));
        post({ type: 'swipe', x: f.x, y: f.y, x2: f.x + dx, y2: f.y + dy, duration: 0.1 });
      }, { passive: false });
      // Printable keystrokes → text input on the focused field.
      img.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key && e.key.length === 1) { post({ type: 'text', text: e.key }); e.preventDefault(); }
      });
    </script>
  </body>
</html>`
}

// A 1×1 white JPEG — the stub frame for the test bridge (exercises the whole
// transport without a real simulator). Not used on the production path.
const STATIC_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
    'AAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==',
  'base64'
)

// --- frame sources ----------------------------------------------------------

/** Pushes JPEG frames to `onFrame` until `stop()`. Swappable (simctl now; idb/recordVideo later). */
interface FrameSource {
  start(onFrame: (jpeg: Buffer) => void, onError: (err: Error) => void): void
  stop(): void
}

/**
 * Poll the booted device with `simctl io … screenshot` at a modest fps. Each
 * capture is a short-lived `xcrun` process; we skip ticks while one is in flight
 * so a slow capture can't pile up.
 *
 * NOTE: older simctl streamed a screenshot to stdout via the `-` argument, but
 * Xcode 26 reinterprets `-` as a literal *filename* (writing a file named `-`
 * and leaving stdout empty), which silently starved the bridge of frames. So we
 * always capture to a per-device temp file and read it back.
 */
function simctlFrameSource(udid: string, fps = 6): FrameSource {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let inflight = false
  const file = join(tmpdir(), `praxis-sim-${udid}.jpg`)
  return {
    start(onFrame, onError) {
      const tick = (): void => {
        if (stopped || inflight) return
        inflight = true
        execFile(
          'xcrun',
          ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file],
          { timeout: 10_000 },
          (err) => {
            if (err) {
              inflight = false
              if (!stopped) onError(err instanceof Error ? err : new Error(String(err)))
              return
            }
            readFile(file)
              .then((buf) => {
                if (!stopped && buf.length) onFrame(buf)
              })
              .catch((e) => {
                if (!stopped) onError(e instanceof Error ? e : new Error(String(e)))
              })
              .finally(() => {
                inflight = false
              })
          }
        )
      }
      timer = setInterval(tick, Math.max(60, Math.round(1000 / fps)))
      tick()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      void unlink(file).catch(() => {})
    }
  }
}

/** Emits a fixed JPEG on a timer — used only by the test bridge. */
function staticFrameSource(jpeg: Buffer): FrameSource {
  let timer: NodeJS.Timeout | null = null
  return {
    start(onFrame) {
      onFrame(jpeg)
      timer = setInterval(() => onFrame(jpeg), 500)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

// --- idb resolution ---------------------------------------------------------

// idb (the Python client) and idb_companion install to locations that a
// GUI-launched Electron may not have on PATH (Homebrew on Apple Silicon, a
// miniforge env, ~/.local/bin). We resolve the `idb` binary across the usual
// spots and run it with an augmented PATH so it can also spawn idb_companion.
const HOME = process.env.HOME ?? ''
const IDB_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/Caskroom/miniforge/base/bin',
  '/usr/local/bin',
  HOME ? join(HOME, '.local/bin') : ''
].filter(Boolean)

function idbEnv(): NodeJS.ProcessEnv {
  const path = [...IDB_PATHS, process.env.PATH ?? ''].filter(Boolean).join(':')
  return { ...process.env, PATH: path }
}

let idbBin: string | null | undefined
/** Locate a working `idb` binary (cached), or null if idb isn't installed. */
async function resolveIdb(): Promise<string | null> {
  if (idbBin !== undefined) return idbBin
  const candidates = ['idb', ...IDB_PATHS.map((p) => join(p, 'idb'))]
  for (const bin of candidates) {
    try {
      await execFileP(bin, ['--help'], { timeout: 4000, env: idbEnv() })
      idbBin = bin
      return bin
    } catch {
      /* try the next candidate */
    }
  }
  idbBin = null
  return null
}

// An idb_companion that outlives the simulator boot it attached to wedges EVERY
// idb command with these messages — and idb often still exits 0, so the failure
// is invisible to exit-code checks. (Seen after a sim reboot / Simulator.app
// relaunch while a days-old companion kept running.)
const IDB_STALE_RE =
  /Mach port not connected|device may not be ready|Failed to connect to companion/i

function isStaleIdbError(e: unknown): boolean {
  const parts = [msg(e), (e as { stderr?: unknown })?.stderr, (e as { stdout?: unknown })?.stdout]
  return parts.some((p) => typeof p === 'string' && IDB_STALE_RE.test(p))
}

/** Kill any (stale) idb_companion daemons + wipe idb's state dir so the next
 * command spawns a fresh companion against the CURRENT simulator boot. */
let recovery: Promise<void> | null = null
function recoverIdb(): Promise<void> {
  recovery ??= (async () => {
    simLog('idb companion looks stale — restarting it…')
    try {
      await execFileP('pkill', ['-f', 'idb_companion'], { timeout: 4000 })
    } catch {
      /* pkill exits 1 when nothing matched */
    }
    // idb's hardcoded state dir (companion registry + domain sockets) — NOT
    // os.tmpdir(), which is /var/folders/… on macOS.
    await rm('/tmp/idb', { recursive: true, force: true }).catch(() => {})
  })().finally(() => {
    recovery = null
  })
  return recovery
}

/** Run an idb subcommand; failures that look like a stale companion are thrown
 * (even on exit 0 — see IDB_STALE_RE). No recovery: callers decide. */
async function idbExecRaw(args: string[], timeout: number): Promise<string> {
  const bin = await resolveIdb()
  if (!bin) throw new Error('idb not found')
  const { stdout, stderr } = await execFileP(bin, args, { timeout, env: idbEnv() })
  const err = stderr.toString()
  if (IDB_STALE_RE.test(err)) {
    throw new Error(err.trim().split('\n').filter(Boolean).pop() ?? 'idb companion unavailable')
  }
  return stdout.toString()
}

/** Run an idb subcommand with the resolved binary + augmented PATH; on a
 * stale-companion failure, recover once and retry. */
async function idbExec(args: string[], timeout = 10_000): Promise<string> {
  try {
    return await idbExecRaw(args, timeout)
  } catch (e) {
    if (!isStaleIdbError(e)) throw e
    await recoverIdb()
    return idbExecRaw(args, timeout)
  }
}

/** True when idb's companion actually sees the device booted. A stale companion
 * reports "Shutdown" (or errors) for a device simctl happily screenshots — so
 * frames stream but every tap dies. Probed raw: start() drives recovery. */
async function idbHealthy(udid: string): Promise<boolean> {
  try {
    const out = await idbExecRaw(['describe', '--udid', udid, '--json'], 8000)
    return (JSON.parse(out) as { state?: string }).state === 'Booted'
  } catch {
    return false
  }
}

// --- input control (Phase 2: tap / scroll / type via idb) -------------------

/** A control command from the bridge page. Coords are FRACTIONS (0..1) of the
 * device content, so the page never needs to know the device's resolution. */
export type ControlCommand =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x: number; y: number; x2: number; y2: number; duration?: number }
  | { type: 'text'; text: string }

/** Forwards control commands to the device. `idbController` uses idb; when idb is
 * absent the bridge has no controller and the device stays view-only (degraded). */
interface Controller {
  send(cmd: ControlCommand): Promise<void>
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Map a 0..1 fraction of the device content to idb point coordinates. */
export function fractionToPoints(
  fx: number,
  fy: number,
  dims: { width: number; height: number }
): { x: number; y: number } {
  return { x: Math.round(clamp01(fx) * dims.width), y: Math.round(clamp01(fy) * dims.height) }
}

/** Device point dimensions from `idb describe --json` (pixels ÷ density). */
async function idbScreenPoints(udid: string): Promise<{ width: number; height: number }> {
  const stdout = await idbExec(['describe', '--udid', udid, '--json'], 8000)
  const d = JSON.parse(stdout) as {
    screen_dimensions?: { width?: number; height?: number; density?: number }
  }
  const s = d.screen_dimensions ?? {}
  const density = s.density && s.density > 0 ? s.density : 1
  const width = Math.round((s.width ?? 390 * density) / density)
  const height = Math.round((s.height ?? 844 * density) / density)
  return { width, height }
}

/** Pure: the idb invocation for a control command. The arg ORDER is load-
 * bearing — `--udid` must follow the `ui <cmd>` subcommand; as a global flag
 * before the root command idb's argparse rejects the whole invocation. */
export function idbUiArgs(
  udid: string,
  cmd: ControlCommand,
  dims: { width: number; height: number }
): string[] {
  if (cmd.type === 'tap') {
    const p = fractionToPoints(cmd.x, cmd.y, dims)
    return ['ui', 'tap', '--udid', udid, String(p.x), String(p.y)]
  }
  if (cmd.type === 'swipe') {
    const a = fractionToPoints(cmd.x, cmd.y, dims)
    const b = fractionToPoints(cmd.x2, cmd.y2, dims)
    return [
      'ui', 'swipe', '--udid', udid,
      String(a.x), String(a.y), String(b.x), String(b.y),
      '--duration', String(cmd.duration ?? 0.25)
    ]
  }
  // Bounded so a flood of keystrokes can't spawn a huge arg.
  return ['ui', 'text', '--udid', udid, cmd.text.slice(0, 500)]
}

function idbController(udid: string): Controller {
  let dims: { width: number; height: number } | null = null
  return {
    async send(cmd) {
      if (!dims) dims = await idbScreenPoints(udid)
      await idbExec(idbUiArgs(udid, cmd, dims))
    }
  }
}

/** Validate + normalize an untrusted /control body into a ControlCommand. */
export function parseControlCommand(body: unknown): ControlCommand | null {
  const b = body as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
  if (b?.type === 'tap') {
    const x = num(b.x)
    const y = num(b.y)
    return x != null && y != null ? { type: 'tap', x, y } : null
  }
  if (b?.type === 'swipe') {
    const [x, y, x2, y2] = [b.x, b.y, b.x2, b.y2].map(num)
    if (x != null && y != null && x2 != null && y2 != null) {
      const d = num(b.duration)
      return { type: 'swipe', x, y, x2, y2, ...(d != null ? { duration: d } : {}) }
    }
    return null
  }
  if (b?.type === 'text' && typeof b.text === 'string') {
    return { type: 'text', text: b.text }
  }
  return null
}

// --- element select (Phase 3: tap → idb hit-test → RN source) ----------------

/** A `testID` stamped by the praxis RN Babel plugin → the source location it maps
 * to. `praxis:path:line:col` → `path:line:col`, else null. */
export function parseTestId(testId: unknown): { source: string } | null {
  if (typeof testId !== 'string' || !testId.startsWith('praxis:')) return null
  const source = testId.slice('praxis:'.length)
  // Shape-check: relpath:line[:col] — refuse anything that isn't a stamp.
  return /^[\w./@-]+:\d+(:\d+)?$/.test(source) ? { source } : null
}

/** Find the first praxis `testID` stamp anywhere in an idb accessibility node
 * (idb surfaces it under varying keys — AXUniqueId / AXIdentifier / identifier). */
export function findPraxisStamp(node: unknown, depth = 0): string | null {
  if (depth > 6 || node == null) return null
  if (typeof node === 'string') return node.startsWith('praxis:') ? node : null
  if (Array.isArray(node)) {
    for (const v of node) {
      const f = findPraxisStamp(v, depth + 1)
      if (f) return f
    }
    return null
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const f = findPraxisStamp(v, depth + 1)
      if (f) return f
    }
  }
  return null
}

/** A picked simulator element (the RN analog of a web SelectedElement pick).
 * `source` is null when the tapped element carries no praxis testID stamp. */
export interface SimPick {
  source: string | null
  tag: string
}

/** idb view-hierarchy hit-test: the element at a 0..1 device point, with its
 * source when praxis-stamped. Device-gated (needs idb + a booted app). */
async function idbHitTest(udid: string, fx: number, fy: number): Promise<SimPick | null> {
  const dims = await idbScreenPoints(udid)
  const p = fractionToPoints(fx, fy, dims)
  const stdout = await idbExec(
    ['ui', 'describe-point', '--udid', udid, '--json', String(p.x), String(p.y)],
    8000
  )
  const node = JSON.parse(stdout) as Record<string, unknown>
  const stamp = findPraxisStamp(node)
  const parsed = stamp ? parseTestId(stamp) : null
  const tag = typeof node.type === 'string' ? node.type : 'element'
  // No stamp → still a pick: the Inspector then shows the tag + its "project
  // isn't set up" note (with the setup offer) instead of the tap silently
  // doing nothing.
  return { source: parsed?.source ?? null, tag }
}

/**
 * The interaction surface attached to a running bridge (Phase 2 control + Phase 3
 * select). Present iff idb is installed; otherwise the device is view-only.
 */
interface Interaction {
  send: (cmd: ControlCommand) => Promise<void>
  isSelectMode: () => boolean
  /** Handle a tap while in select mode (hit-test + emit the pick to the renderer). */
  onSelectTap: (fx: number, fy: number) => void
}

// Set by the renderer's Select toggle (sim path); read by the live interaction.
let simSelectMode = false
// The window to emit picks to, set in registerSimulatorIpc.
let getWin: () => BrowserWindow | null = () => null
// Send to the renderer, guarding a destroyed webContents: the window can outlive
// its renderer process (OS kills it on display sleep), and async sources here —
// the sim launch's socket `onData`, the bridge server — keep emitting during that
// window and would throw an uncaught "Object has been destroyed" from `.send()`.
const sendToWin = (channel: string, ...args: unknown[]): void => {
  const wc = getWin()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}
// Status line into the renderer's simulator log (safe before registration: no-op).
const simLog = (line: string): void => {
  sendToWin('simulator:log', line)
}

// --- the bridge HTTP server -------------------------------------------------

interface Bridge {
  server: Server
  /** Resolves when the first real frame is captured (the readiness signal). */
  firstFrame: Promise<void>
  close(): void
}

function writeFrameTo(res: ServerResponse, jpeg: Buffer): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(
      `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
    )
    res.write(jpeg)
    res.write('\r\n')
  } catch {
    /* broken socket — the res 'error'/'close' handler will drop it */
  }
}

function startBridge(
  source: FrameSource,
  port: number,
  interaction: Interaction | null
): Promise<Bridge> {
  return new Promise<Bridge>((resolve, reject) => {
    let latest: Buffer | null = null
    let gotFrame = false
    const clients = new Set<ServerResponse>()
    // Per-bridge secret required on the privileged routes. See pageHtml.
    const token = randomBytes(16).toString('hex')
    // Cap concurrent MJPEG viewers so a misbehaving/hostile client can't open an
    // unbounded number of streams (each gets every frame).
    const MAX_STREAM_CLIENTS = 8

    // Reject anything not coming from the local bridge origin (blunts DNS
    // rebinding: the browser keeps the attacker's hostname in the Host header
    // even after the name resolves to 127.0.0.1).
    const hostOk = (req: IncomingMessage): boolean => {
      const h = req.headers.host
      return h === `${HOST}:${port}` || h === `localhost:${port}`
    }
    const tokenOk = (req: IncomingMessage): boolean => {
      try {
        return new URL(req.url || '/', `http://${HOST}:${port}`).searchParams.get('token') === token
      } catch {
        return false
      }
    }

    let resolveFirst!: () => void
    let rejectFirst!: (e: Error) => void
    const firstFrame = new Promise<void>((res, rej) => {
      resolveFirst = res
      rejectFirst = rej
    })
    const firstTimer = setTimeout(() => {
      if (!gotFrame) rejectFirst(new Error('Simulator booted, but no frame was captured.'))
    }, 30_000)

    const onFrame = (jpeg: Buffer): void => {
      latest = jpeg
      if (!gotFrame) {
        gotFrame = true
        clearTimeout(firstTimer)
        resolveFirst()
      }
      for (const res of clients) writeFrameTo(res, jpeg)
    }

    const server = createServer((req, res) => {
      // The bridge binds to 127.0.0.1, but the loopback port is still reachable
      // by any local process / webpage — so gate on the Host header (rebinding)
      // and, on the privileged routes, a per-bridge token. NO CORS headers: a
      // cross-origin page can't read this page's HTML, so it never learns the
      // token. The renderer loads `/` in the preview view (same origin) and the
      // baked-in token rides its own /control + /stream calls.
      if (!hostOk(req)) {
        res.writeHead(403)
        res.end()
        return
      }
      const path = (req.url || '/').split('?')[0]
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(pageHtml(interaction != null, token))
        return
      }
      // Phase 2: replay a tap/swipe/type on the device (bounded body). Without a
      // controller (no idb) the device is view-only → report it, don't error.
      if (path === '/control' && req.method === 'POST') {
        if (!tokenOk(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        let raw = ''
        let tooBig = false
        req.on('data', (c) => {
          raw += c
          if (raw.length > 4096) {
            tooBig = true
            res.writeHead(413)
            res.end()
            req.destroy()
          }
        })
        req.on('end', () => {
          if (tooBig) return
          const ok = (extra: object): void => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(extra))
          }
          if (!interaction) {
            ok({ degraded: true })
            return
          }
          let cmd: ControlCommand | null = null
          try {
            cmd = parseControlCommand(JSON.parse(raw))
          } catch {
            cmd = null
          }
          if (!cmd) {
            res.writeHead(400)
            res.end()
            return
          }
          // A tap in select mode is an element pick (hit-test), not a tap-through.
          if (cmd.type === 'tap' && interaction.isSelectMode()) {
            interaction.onSelectTap(cmd.x, cmd.y)
            ok({ selected: true })
            return
          }
          interaction
            .send(cmd)
            .then(() => ok({ ok: true }))
            .catch((err) => ok({ ok: false, error: msg(err) }))
        })
        return
      }
      if (path === '/stream') {
        if (!tokenOk(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        if (clients.size >= MAX_STREAM_CLIENTS) {
          res.writeHead(503)
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          Connection: 'keep-alive'
        })
        clients.add(res)
        if (latest) writeFrameTo(res, latest) // paint the current frame immediately
        // Drop the client on close OR error (a half-open socket never fires
        // 'close'); the error handler also stops an unhandled 'error' from a
        // write to a broken socket taking down the process.
        const drop = (): void => {
          clients.delete(res)
        }
        req.on('close', drop)
        res.on('close', drop)
        res.on('error', drop)
        return
      }
      res.writeHead(404)
      res.end()
    })

    server.once('error', (err) => {
      clearTimeout(firstTimer)
      reject(err)
    })
    server.listen(port, HOST, () => {
      source.start(onFrame, (err) => {
        if (!gotFrame) {
          clearTimeout(firstTimer)
          rejectFirst(err)
        }
      })
      resolve({
        server,
        firstFrame,
        close: () => {
          clearTimeout(firstTimer)
          source.stop()
          for (const c of clients) c.end()
          clients.clear()
          server.close()
        }
      })
    })
  })
}

// --- preflight --------------------------------------------------------------

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function xcrun(args: string[], timeout = 8000): Promise<string> {
  const { stdout } = await execFileP('xcrun', args, { timeout, maxBuffer: 32 * 1024 * 1024 })
  return stdout.toString()
}

interface SimctlRuntime {
  name: string
  identifier: string
  version?: string
  isAvailable?: boolean
}
interface SimctlDevice {
  udid: string
  name: string
  isAvailable?: boolean
  state?: string
}

export async function preflight(): Promise<SimPreflight> {
  const isMac = process.platform === 'darwin'
  const base: SimPreflight = {
    ok: false,
    isMac,
    hasXcode: false,
    hasIdb: false,
    runtimes: [],
    devices: []
  }
  if (!isMac) {
    return {
      ...base,
      reason:
        'Simulator preview is macOS-only — open this React Native / Expo project on a Mac with Xcode.'
    }
  }
  try {
    await xcrun(['simctl', 'help'])
    base.hasXcode = true
  } catch (err) {
    return { ...base, reason: xcodeFailureReason(err) }
  }
  // idb is optional (enables Phase-2 tap/scroll); mirroring works without it.
  base.hasIdb = (await resolveIdb()) != null
  const runtimeVersions: string[] = []
  try {
    const runtimes = (JSON.parse(await xcrun(['simctl', 'list', 'runtimes', '-j'])).runtimes ??
      []) as SimctlRuntime[]
    const ios = runtimes.filter((r) => r.isAvailable !== false && /iOS/i.test(r.name))
    base.runtimes = ios.map((r) => r.name)
    for (const r of ios) if (r.version) runtimeVersions.push(r.version)

    const devicesByRuntime = (JSON.parse(await xcrun(['simctl', 'list', 'devices', 'available', '-j']))
      .devices ?? {}) as Record<string, SimctlDevice[]>
    const devices: SimDevice[] = []
    for (const [runtime, list] of Object.entries(devicesByRuntime)) {
      if (!/iOS/i.test(runtime)) continue
      for (const d of list) {
        if (d.isAvailable !== false && /iPhone|iPad/i.test(d.name)) {
          devices.push({ udid: d.udid, name: d.name, runtime })
        }
      }
    }
    base.devices = devices
  } catch (err) {
    return { ...base, reason: `Couldn't list simulators: ${msg(err)}` }
  }
  if (base.runtimes.length === 0) {
    return { ...base, reason: 'No iOS runtimes installed. Add one in Xcode → Settings → Platforms.' }
  }
  if (base.devices.length === 0) {
    return {
      ...base,
      reason: 'No iPhone/iPad simulators found. Create one in Xcode → Settings → Platforms.'
    }
  }
  // Devices exist, but a modern Xcode SDK may still refuse them as build
  // destinations if no runtime matches its iOS version — catch that here, before
  // booting + a doomed multi-minute build. The SDK probe is best-effort: if it
  // can't be read, we don't block (simBuildDestination treats null SDK as ok).
  let sdkVersion: string | null = null
  try {
    sdkVersion = (await xcrun(['--sdk', 'iphonesimulator', '--show-sdk-version'])).trim()
  } catch {
    sdkVersion = null
  }
  const buildable = simBuildDestination(sdkVersion, runtimeVersions)
  if (!buildable.ok) {
    return { ...base, reason: buildable.reason }
  }
  return { ...base, ok: true }
}

// --- boot + launch ----------------------------------------------------------

// The device praxis boots + mirrors by default. Expo opens the app on whichever
// simulator is booted, so we boot this one most-recently to bias toward it, then
// follow the device the launch logs actually name (see start()).
const PREFERRED_DEVICE = 'iPhone 16 Pro'

async function bootedUdids(): Promise<Set<string>> {
  const set = new Set<string>()
  try {
    const byRuntime = (JSON.parse(await xcrun(['simctl', 'list', 'devices', 'booted', '-j'])).devices ??
      {}) as Record<string, SimctlDevice[]>
    for (const list of Object.values(byRuntime)) for (const d of list) set.add(d.udid)
  } catch {
    /* ignore */
  }
  return set
}

async function pickDevice(preferred?: string): Promise<SimDevice> {
  const pf = await preflight()
  if (!pf.ok) throw new Error(pf.reason ?? 'No simulator available.')
  if (preferred) {
    const exact = pf.devices.find((d) => d.udid === preferred)
    if (exact) return exact
  }
  // Prefer iPhone 16 Pro on its newest available runtime.
  const byName = pf.devices
    .filter((d) => d.name === PREFERRED_DEVICE)
    .sort((a, b) => a.runtime.localeCompare(b.runtime))
  if (byName.length) return byName[byName.length - 1]
  // Else fall back to a booted device, then the newest iPhone.
  const booted = await bootedUdids()
  const bootedDev = pf.devices.find((d) => booted.has(d.udid))
  if (bootedDev) return bootedDev
  const iphones = pf.devices.filter((d) => /iPhone/i.test(d.name))
  const pool = iphones.length ? iphones : pf.devices
  // Highest runtime identifier ≈ newest iOS version.
  return [...pool].sort((a, b) => a.runtime.localeCompare(b.runtime)).pop()!
}

async function boot(udid: string, onLog: (line: string) => void): Promise<void> {
  onLog(`Booting simulator ${udid}…`)
  try {
    await xcrun(['simctl', 'boot', udid], 60_000)
  } catch (err) {
    // "Unable to boot device in current state: Booted" just means it's already up.
    if (!/current state: Booted/i.test(msg(err))) throw err
  }
  await xcrun(['simctl', 'bootstatus', udid, '-b'], 120_000)
  // Bring the Simulator window up so the user sees it too (capture works headless).
  try {
    await execFileP('open', ['-a', 'Simulator'], { timeout: 8000 })
  } catch {
    /* non-fatal */
  }
}

async function readBundleId(root: string): Promise<string> {
  for (const file of ['app.json', 'app.config.json']) {
    try {
      const j = JSON.parse(await readFile(join(root, file), 'utf8'))
      const id = j?.expo?.ios?.bundleIdentifier ?? j?.ios?.bundleIdentifier
      if (typeof id === 'string') return id
    } catch {
      /* not this file */
    }
  }
  return ''
}

// Markers that mean Metro is up / the app is building or bundling — enough to
// proceed to frame capture (the stream then shows the build/splash progress).
const METRO_READY_RE =
  /(Bundling complete|Bundled .* in \d|Logs for your project|Waiting on|Metro waiting|exp:\/\/|› Press|Opening on)/i
const BUILD_FAIL_RE = /(error: |Build failed|Command .* failed|xcodebuild: error)/i

/** Spawn the dev command (e.g. `expo run:ios`), which builds + installs + launches + serves. */
function spawnMetro(
  opts: { root: string; command: string; udid: string },
  onLog: (line: string) => void
): Promise<{ pid: number }> {
  return new Promise<{ pid: number }>((resolve, reject) => {
    const child: ChildProcess = spawn(opts.command, {
      cwd: opts.root,
      shell: true,
      detached: true, // own process group so stop() can kill the whole tree
      env: { ...process.env, FORCE_COLOR: '0', CI: '1', EXPO_NO_TELEMETRY: '1' }
    })
    let settled = false
    let tail = ''

    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ pid: child.pid! })
    }

    const onData = (buf: Buffer): void => {
      const text = stripAnsi(buf.toString())
      tail = (tail + text).slice(-8000)
      for (const line of text.split('\n')) if (line.trim()) onLog(line.trimEnd())
      if (settled) return
      if (METRO_READY_RE.test(text)) settle()
      else if (BUILD_FAIL_RE.test(text)) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`The app failed to build/launch.\n${extractBuildError(tail)}`))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to start Metro: ${err.message}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new Error(`Dev process exited (code ${code}) before launching.\n${extractBuildError(tail)}`)
      )
    })

    // Native builds can be slow; if we never see a marker, proceed anyway so the
    // stream can show whatever's on screen rather than failing the whole launch.
    const timer = setTimeout(() => {
      if (!settled) {
        onLog('No Metro readiness marker yet — proceeding to capture the screen.')
        settle()
      }
    }, 180_000)
  })
}

// --- lifecycle --------------------------------------------------------------

interface Running {
  metroPid?: number
  bridge: Bridge
  source: FrameSource
  udid?: string
}
let current: Running | null = null

function stop(): void {
  if (!current) return
  const c = current
  current = null
  try {
    c.bridge.close()
  } catch {
    /* ignore */
  }
  if (c.metroPid) {
    try {
      process.kill(-c.metroPid, 'SIGTERM') // whole process group
    } catch {
      try {
        process.kill(c.metroPid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  // The simulator is left booted for fast re-open (cheap; user can quit it).
}

async function start(
  opts: { root: string; command?: string; udid?: string },
  onLog: (line: string) => void
): Promise<RunningSimulator> {
  stop()
  const device = await pickDevice(opts.udid)
  onLog(`Using ${device.name} · ${device.runtime}`)
  await boot(device.udid, onLog)

  const command = opts.command?.trim() || 'npx expo run:ios'
  onLog(`Launching app: ${command}`)

  // Expo opens the app on whichever simulator is booted, which may not be the one
  // we picked. Sniff the device the launch logs name so we mirror the device that
  // actually runs the app (resolved to a booted udid after launch).
  const known = (await preflight()).devices
  let launchedName: string | null = null
  const sniff = (line: string): void => {
    if (launchedName) return
    const m = line.match(/\bon (iPhone[\w .]+?)(?:\s*\(|$)/i)
    if (m) launchedName = m[1].trim()
  }
  const onLaunchLog = (line: string): void => {
    sniff(line)
    onLog(line)
  }
  const { pid } = await spawnMetro({ root: opts.root, command, udid: device.udid }, onLaunchLog)
  const bundleId = await readBundleId(opts.root)

  // Follow the launched device when Expo chose a different (booted) one.
  let captureDevice = device
  if (launchedName && launchedName !== device.name) {
    const booted = await bootedUdids()
    const hit = known.find((d) => d.name === launchedName && booted.has(d.udid))
    if (hit) {
      captureDevice = hit
      onLog(`App launched on ${hit.name} — mirroring it instead of ${device.name}.`)
    }
  }
  const udid = captureDevice.udid

  const port = await findFreePort(BRIDGE_PORT_BASE)
  const source = simctlFrameSource(udid)
  // Phase 2/3: interaction (tap/scroll/type + element-select) iff idb is installed
  // AND its companion can actually attach to this boot of the device. A stale
  // companion streams nothing but errors while screenshots keep working — the
  // preview would look alive yet ignore every tap, so recover before wiring up.
  let interaction: Interaction | null = null
  if ((await resolveIdb()) != null) {
    let healthy = await idbHealthy(udid)
    if (!healthy) {
      await recoverIdb()
      healthy = await idbHealthy(udid)
    }
    if (healthy) {
      const controller = idbController(udid)
      interaction = {
        send: (cmd) => controller.send(cmd),
        isSelectMode: () => simSelectMode,
        onSelectTap: (fx, fy) => {
          void idbHitTest(udid, fx, fy)
            .then((pick) => {
              if (pick) sendToWin('simulator:element-picked', pick)
            })
            .catch((err) => simLog(`Element select failed: ${msg(err)}`))
        }
      }
      onLog('idb detected — tap / scroll / type + element-select enabled.')
    } else {
      onLog(
        'idb is installed but cannot attach to this simulator — preview is view-only. Quit Simulator.app and reopen the project to retry.'
      )
    }
  } else {
    onLog('idb not found — preview is view-only (install idb to interact).')
  }
  const bridge = await startBridge(source, port, interaction)
  current = { metroPid: pid, bridge, source, udid }
  try {
    await bridge.firstFrame // readiness: a real frame rendered
  } catch (err) {
    stop()
    throw err
  }
  const url = `http://${HOST}:${port}/?praxisSim=1`
  onLog(`Simulator preview ready at ${url}`)
  return { url, pid, udid, bundleId, previewKind: 'simulator' }
}

// What a test bridge received (for sim-control.mjs / sim-select.mjs assertions).
let testRecorded: ControlCommand[] = []
let testPicks: SimPick[] = []
// A fixed pick the recording interaction emits for a select-mode tap (stands in
// for the device-gated idb hit-test).
const TEST_PICK: SimPick = { source: 'src/App.tsx:10:4', tag: 'View' }

/** Test-only: stand up the bridge with a static stub frame (no simulator needed).
 * `interactive` attaches a RECORDING interaction (Phase-2 transport + Phase-3
 * select routing) instead of the idb-backed one. */
async function startTestBridge(interactive = false): Promise<{ url: string }> {
  stop()
  testRecorded = []
  testPicks = []
  const port = await findFreePort(BRIDGE_PORT_BASE)
  const source = staticFrameSource(STATIC_JPEG)
  const interaction: Interaction | null = interactive
    ? {
        send: async (cmd) => {
          testRecorded.push(cmd)
        },
        isSelectMode: () => simSelectMode,
        onSelectTap: () => {
          testPicks.push(TEST_PICK)
          sendToWin('simulator:element-picked', TEST_PICK)
        }
      }
    : null
  const bridge = await startBridge(source, port, interaction)
  await bridge.firstFrame
  current = { bridge, source }
  return { url: `http://${HOST}:${port}/?praxisSim=1` }
}

export function registerSimulatorIpc(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  const log = simLog
  ipcMain.handle('simulator:preflight', () => preflight())
  ipcMain.handle('simulator:start', (_e, opts: { root: string; command?: string; udid?: string }) =>
    start(opts, log)
  )
  ipcMain.handle('simulator:stop', async () => stop())
  // Phase 3: arm/disarm element-select for the sim (a tap then becomes a pick).
  ipcMain.handle('simulator:set-select-mode', (_e, active: boolean) => {
    simSelectMode = !!active
  })

  // Test-only hooks — exercise the bridge transport + Phase-2 control + Phase-3
  // select routing off-macOS. Reached via `app.evaluate`, not the renderer API.
  const g = globalThis as {
    __praxisStartTestBridge?: (interactive?: boolean) => Promise<{ url: string }>
    __praxisTestControl?: () => ControlCommand[]
    __praxisTestPicks?: () => SimPick[]
    __praxisSimMap?: {
      fractionToPoints: typeof fractionToPoints
      parseControlCommand: typeof parseControlCommand
      parseTestId: typeof parseTestId
      findPraxisStamp: typeof findPraxisStamp
      idbUiArgs: typeof idbUiArgs
    }
  }
  g.__praxisStartTestBridge = startTestBridge
  g.__praxisTestControl = () => testRecorded
  g.__praxisTestPicks = () => testPicks
  g.__praxisSimMap = { fractionToPoints, parseControlCommand, parseTestId, findPraxisStamp, idbUiArgs }

  app.on('before-quit', stop)
}
