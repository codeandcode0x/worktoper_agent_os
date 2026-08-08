"use client"

export type RuntimePhase = "idle" | "loading" | "ready" | "error"
export type RuntimeSnapshot = {
  phase: RuntimePhase
  detail: string
  cpuActive: boolean
  diskActive: boolean
  network: "disconnected" | "connecting" | "connected"
  ip?: string
  bootProgress?: number
}

export type VmConnection = {
  arch: string
  disk: string
  seed?: string
  sshPort: number
  serialPort: number
  vncWebSocketUrl: string
}

type StateListener = (snapshot: RuntimeSnapshot) => void
type DataListener = (data: Uint8Array) => void

declare global {
  interface Window {
    worktoperVM?: {
      start: () => Promise<VmConnection>
      stop: () => Promise<{ ok: boolean }>
      write: (data: string) => Promise<{ ok: boolean }>
      launch: (appId: string) => Promise<{ ok: boolean }>
      onState: (callback: (snapshot: RuntimeSnapshot) => void) => () => void
      onSerial: (callback: (data: string) => void) => () => void
    }
  }
}

const initialSnapshot: RuntimeSnapshot = {
  phase: "idle",
  detail: "Linux VM 尚未启动",
  cpuActive: false,
  diskActive: false,
  network: "disconnected",
  bootProgress: 0,
}

class DesktopLinuxRuntime {
  private bootPromise: Promise<VmConnection> | null = null
  private connection: VmConnection | null = null
  private snapshot = initialSnapshot
  private stateListeners = new Set<StateListener>()
  private dataListeners = new Set<DataListener>()
  private outputHistory: Uint8Array[] = []
  private outputBytes = 0
  private encoder = new TextEncoder()
  private listenersAttached = false

  getConnection() {
    return this.connection
  }

  getSnapshot() {
    return this.snapshot
  }

  subscribeState(listener: StateListener) {
    this.attachBridgeListeners()
    this.stateListeners.add(listener)
    listener(this.snapshot)
    return () => { this.stateListeners.delete(listener) }
  }

  subscribeData(listener: DataListener, replay = true) {
    this.attachBridgeListeners()
    this.dataListeners.add(listener)
    if (replay) this.outputHistory.forEach(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  private update(snapshot: RuntimeSnapshot) {
    this.snapshot = snapshot
    this.stateListeners.forEach((listener) => listener(snapshot))
  }

  private pushSerial(text: string) {
    const data = this.encoder.encode(text)
    this.outputHistory.push(data)
    this.outputBytes += data.byteLength
    while (this.outputBytes > 256_000 && this.outputHistory.length > 1) this.outputBytes -= this.outputHistory.shift()!.byteLength
    this.dataListeners.forEach((listener) => listener(data))
  }

  private attachBridgeListeners() {
    if (this.listenersAttached) return
    this.listenersAttached = true
    if (!window.worktoperVM) {
      this.update({ ...initialSnapshot, phase: "error", detail: "请使用 WorkToper Agent OS 桌面应用打开；浏览器静态页不能启动 QEMU VM。" })
      return
    }
    window.worktoperVM.onState((snapshot) => this.update(snapshot))
    window.worktoperVM.onSerial((data) => this.pushSerial(data))
  }

  async boot() {
    this.attachBridgeListeners()
    if (!window.worktoperVM) throw new Error("WorkToper VM bridge is unavailable")
    if (this.bootPromise) return this.bootPromise
    this.bootPromise = window.worktoperVM.start().then((connection) => {
      this.connection = connection
      return connection
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.update({ ...initialSnapshot, phase: "error", detail: message })
      this.pushSerial(`\r\n[WorkToper] 启动失败: ${message}\r\n`)
      this.bootPromise = null
      throw error
    })
    return this.bootPromise
  }

  async stop() {
    this.bootPromise = null
    this.connection = null
    await window.worktoperVM?.stop()
  }

  async write(data: string) {
    if (!window.worktoperVM) return
    await window.worktoperVM.write(data)
  }

  async launch(appId: "vscode" | "chrome" | "terminal") {
    await this.boot()
    if (!window.worktoperVM) throw new Error("WorkToper VM bridge is unavailable")
    return window.worktoperVM.launch(appId)
  }
}

export const desktopLinux = new DesktopLinuxRuntime()
