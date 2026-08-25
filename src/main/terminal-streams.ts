type ErrorStream = {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * A PTY disappearing underneath Electron is reported as EIO on macOS and
 * usually EPIPE elsewhere. These are expected once the terminal that launched
 * a development build has closed; every other stream failure remains fatal.
 */
export function isClosedTerminalError(error: NodeJS.ErrnoException): boolean {
  if (error.code !== 'EIO' && error.code !== 'EPIPE') return false
  return error.syscall === undefined || error.syscall === 'write'
}

/**
 * stdout/stderr are sockets when Electron is launched from a terminal. Without
 * an error listener, a closed PTY becomes an uncaught exception. Praxis's global
 * exception reporter then writes that exception back to the same dead stream,
 * producing an endless series of native error dialogs.
 */
export function guardTerminalStream(stream: ErrorStream): void {
  stream.on('error', (error) => {
    if (isClosedTerminalError(error)) return
    throw error
  })
}

export function installTerminalStreamGuards(): void {
  guardTerminalStream(process.stdout)
  guardTerminalStream(process.stderr)
}
