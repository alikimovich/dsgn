/**
 * Small common denominator shared by Electron's ipcMain and the local-browser
 * command router. Keeping this deliberately narrower than Electron's types lets
 * main-process services register the same request handlers on either transport.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors Electron's variadic ipcMain.handle contract.
export type RpcHandler = (event: unknown, ...args: any[]) => unknown

export interface RpcHandlerRegistry {
  handle: (channel: string, listener: RpcHandler) => void
}

/** The only renderer shape agent backends need: guarded event delivery. */
export interface RendererEventTarget {
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, payload: unknown) => void
  }
}
