/**
 * Closing the terminal that launched Praxis must not feed EIO/EPIPE into the
 * global uncaught-exception reporter. That reporter logs to the same closed
 * stream, which used to produce an endless series of native error dialogs.
 *
 * Run with: bun run test:terminal-streams
 */
import { EventEmitter } from 'node:events'
import { guardTerminalStream, isClosedTerminalError } from '../src/main/terminal-streams.ts'

let failed = 0
const ok = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failed++
  }
}

const error = (code, syscall = 'write') =>
  Object.assign(new Error(`${syscall} ${code}`), {
    code,
    syscall
  })

ok(isClosedTerminalError(error('EIO')), 'macOS PTY EIO is a closed-terminal error')
ok(isClosedTerminalError(error('EPIPE')), 'Unix EPIPE is a closed-terminal error')
ok(!isClosedTerminalError(error('EIO', 'read')), 'an unrelated read EIO is not swallowed')
ok(!isClosedTerminalError(error('ENOSPC')), 'other write failures are not swallowed')

const stream = new EventEmitter()
guardTerminalStream(stream)

try {
  stream.emit('error', error('EIO'))
  stream.emit('error', error('EPIPE'))
  ok(true, 'closed-terminal errors are absorbed by the stream guard')
} catch {
  ok(false, 'closed-terminal errors are absorbed by the stream guard')
}

let rethrown
try {
  stream.emit('error', error('ENOSPC'))
} catch (caught) {
  rethrown = caught
}
ok(rethrown?.code === 'ENOSPC', 'unexpected stream errors still surface')

if (failed) {
  console.error(`TERMINAL-STREAMS FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log('TERMINAL-STREAMS OK — closed PTYs are quiet; real stream failures still surface')
