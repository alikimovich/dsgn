import type { PraxisApi } from './api'

declare global {
  interface Window {
    api: PraxisApi
    /** Injected only by `praxis serve`; absent in Electron windows. */
    __PRAXIS_WEB_CONFIG__?: {
      root: string
      rpcPath: string
      eventsPath: string
      previewToken: string
    }
  }
}

export {}
