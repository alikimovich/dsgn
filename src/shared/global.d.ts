import type { PraxisApi } from './api'

declare global {
  interface Window {
    api: PraxisApi
  }
}

export {}
