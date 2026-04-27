export interface HeimdallApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (event: string, callback: (...args: unknown[]) => void) => () => void
  once: (event: string, callback: (...args: unknown[]) => void) => void
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    heimdall: HeimdallApi
  }
}
