declare module "@novnc/novnc" {
  export default class RFB {
    scaleViewport: boolean
    resizeSession: boolean
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    disconnect(): void
  }
}
