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
  displayMode?: "embedded"
  displayName?: string
  vncWebSocketUrl?: string
}

export type VmConnection = {
  arch: string
  disk: string
  seed?: string
  sshPort: number
  serialPort: number
  qgaSocketPath?: string
  displayMode: "embedded"
  displayName?: string
  vncWebSocketUrl?: string
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
      onBoot: (callback: (data: string) => void) => () => void
      onTerminal: (callback: (data: string) => void) => () => void
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
  private bootListeners = new Set<DataListener>()
  private terminalHistory: Uint8Array[] = []
  private bootHistory: Uint8Array[] = []
  private terminalBytes = 0
  private bootBytes = 0
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
    if (replay) this.terminalHistory.forEach(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  subscribeBoot(listener: DataListener, replay = true) {
    this.attachBridgeListeners()
    this.bootListeners.add(listener)
    if (replay) this.bootHistory.forEach(listener)
    return () => { this.bootListeners.delete(listener) }
  }

  private update(snapshot: RuntimeSnapshot) {
    this.snapshot = snapshot
    this.stateListeners.forEach((listener) => listener(snapshot))
  }

  private pushTerminal(text: string) {
    const data = this.encoder.encode(text)
    this.terminalHistory.push(data)
    this.terminalBytes += data.byteLength
    while (this.terminalBytes > 256_000 && this.terminalHistory.length > 1) this.terminalBytes -= this.terminalHistory.shift()!.byteLength
    this.dataListeners.forEach((listener) => listener(data))
  }

  private pushBoot(text: string) {
    const data = this.encoder.encode(text)
    this.bootHistory.push(data)
    this.bootBytes += data.byteLength
    while (this.bootBytes > 512_000 && this.bootHistory.length > 1) this.bootBytes -= this.bootHistory.shift()!.byteLength
    this.bootListeners.forEach((listener) => listener(data))
  }

  private attachBridgeListeners() {
    if (this.listenersAttached) return
    this.listenersAttached = true
    if (!window.worktoperVM) {
      this.update({ ...initialSnapshot, phase: "error", detail: "请使用 WorkToper Agent OS 桌面应用打开；浏览器静态页不能启动 QEMU VM。" })
      return
    }
    window.worktoperVM.onState((snapshot) => this.update(snapshot))
    if (window.worktoperVM.onBoot && window.worktoperVM.onTerminal) {
      window.worktoperVM.onBoot((data) => this.pushBoot(data))
      window.worktoperVM.onTerminal((data) => this.pushTerminal(data))
    } else {
      window.worktoperVM.onSerial((data) => this.pushBoot(data))
    }
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
      this.pushBoot(`\r\n[WorkToper] 启动失败: ${message}\r\n`)
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
