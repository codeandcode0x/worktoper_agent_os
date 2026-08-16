"use client"

import {
  Activity, AppWindow, Box, ChevronDown, ChevronRight, CircleUserRound, Code2, Command, Cpu,
  FolderOpen, Gauge, Globe2, Grid2X2, HardDrive, Info, LockKeyhole, Maximize2, MemoryStick,
  Minus, Network, Package, PanelTop, Power, RefreshCw, Search, Server, Settings,
  ShieldCheck, Terminal, Wifi, X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { desktopLinux, type RuntimeSnapshot, type VmConnection, type VmSettings } from "@/lib/desktop-linux"

type AppId = "desktop" | "terminal" | "store" | "kernel" | "about" | "vscode" | "chrome"
type WindowState = { id: AppId; minimized: boolean; z: number }
type AppDefinition = { id: AppId; name: string; subtitle: string; icon: LucideIcon }

const apps: AppDefinition[] = [
  { id: "store", name: "APT", subtitle: "Debian packages", icon: Package },
  { id: "kernel", name: "运行时", subtitle: "QEMU VM", icon: Cpu },
  { id: "vscode", name: "VS Code", subtitle: "Linux GUI 应用", icon: Code2 },
  { id: "chrome", name: "Chrome", subtitle: "Linux GUI 应用", icon: Globe2 },
  { id: "about", name: "关于", subtitle: "系统信息", icon: Info },
]

const dockApps = apps
const autoLockIdleMs = 10 * 60 * 1000

const packageCatalog = [
  { name: "code", description: "Microsoft VS Code 图形编辑器", size: "GUI" },
  { name: "chromium", description: "开源 Chrome 兼容浏览器", size: "GUI" },
  { name: "xfce4-terminal", description: "Linux 桌面终端", size: "GUI" },
  { name: "git", description: "版本控制工具", size: "CLI" },
  { name: "curl", description: "命令行数据传输工具", size: "CLI" },
  { name: "build-essential", description: "gcc、make、libc 开发工具链", size: "CLI" },
  { name: "python3-pip", description: "Python 包管理器", size: "CLI" },
  { name: "nodejs npm", description: "Node.js 和 npm", size: "CLI" },
]

const initialRuntime: RuntimeSnapshot = {
  phase: "idle", detail: "Linux VM 尚未启动", cpuActive: false, diskActive: false, network: "disconnected", bootProgress: 0,
}

function useRuntime() {
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(initialRuntime)
  useEffect(() => desktopLinux.subscribeState(setRuntime), [])
  return runtime
}

function AppIcon({ app, active = false }: { app: AppDefinition; active?: boolean }) {
  const Icon = app.icon
  return <span className={`app-symbol ${active ? "app-symbol-active" : ""}`}><Icon aria-hidden="true" /></span>
}

function TopBar({ openApp, runtime }: { openApp: (id: AppId) => void; runtime: RuntimeSnapshot }) {
  const [time, setTime] = useState("")
  const [message, setMessage] = useState("")
  useEffect(() => {
    const update = () => setTime(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()))
    update()
    const timer = window.setInterval(update, 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const boot = async () => {
    try {
      await desktopLinux.boot()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Linux VM 启动失败")
    }
  }
  return <header className="topbar">
    <div className="topbar-group">
      <button className="brand-mark" onClick={() => openApp("about")} aria-label="打开 WorkToper Agent OS 信息"><Grid2X2 /></button>
      <span className="brand-name">WORKTOPER</span>
      <button className="workspace-pill" onClick={boot} title={message || "启动 Linux VM"}><span className={`status-dot ${runtime.phase === "error" ? "status-error" : ""}`} />{runtime.phase === "ready" ? "QEMU Linux" : "启动 Linux"}</button>
    </div>
    <div className="topbar-center" aria-label="运行状态"><ShieldCheck /><span>QEMU GPLv2</span><span className="divider-dot">·</span><span>Debian APT VM</span></div>
    <div className="topbar-group topbar-actions">
      <button onClick={boot} title={message || runtime.detail} aria-label="启动 Linux VM"><Wifi className={runtime.network === "connected" ? "network-online" : ""} /></button>
      <Activity aria-label={runtime.cpuActive ? "CPU 忙" : "CPU 空闲"} />
      <button onClick={() => openApp("kernel")} aria-label="打开运行时监视器"><Settings /></button>
      <time>{time}</time><CircleUserRound aria-label="WorkToper 用户" />
    </div>
  </header>
}

function WindowFrame({ title, subtitle, icon: Icon, active, onFocus, onMinimize, onClose, className = "", children }: {
  title: string; subtitle: string; icon: LucideIcon; active: boolean; onFocus: () => void; onMinimize: () => void; onClose: () => void; className?: string; children: React.ReactNode
}) {
  const [maximized, setMaximized] = useState(false)
  return <section className={`os-window ${active ? "is-focused" : ""} ${maximized ? "is-maximized" : ""} ${className}`} onMouseDown={onFocus} aria-label={`${title}窗口`}>
    <div className="window-titlebar"><div className="window-title"><Icon /><div><strong>{title}</strong><span>{subtitle}</span></div></div>
      <div className="window-controls"><button onClick={(event) => { event.stopPropagation(); onMinimize() }} aria-label={`最小化${title}`}><Minus /></button><button onClick={(event) => { event.stopPropagation(); setMaximized((value) => !value) }} aria-label={`${maximized ? "还原" : "最大化"}${title}`}><Maximize2 /></button><button onClick={(event) => { event.stopPropagation(); onClose() }} aria-label={`关闭${title}`}><X /></button></div>
    </div>{children}
  </section>
}

function TerminalWindow({ active, onFocus, onMinimize, onClose, runtime }: { active: boolean; onFocus: () => void; onMinimize: () => void; onClose: () => void; runtime: RuntimeSnapshot }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    void (async () => {
      const boot = desktopLinux.boot()
      const [{ Terminal: XTerm }, { FitAddon }, { WebLinksAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-web-links")])
      if (!hostRef.current || disposed) return
      const terminal = new XTerm({ cursorBlink: true, convertEol: true, scrollback: 6000, fontSize: 12, lineHeight: 1.3, fontFamily: '"Geist Mono", "SFMono-Regular", Consolas, monospace', theme: { background: "#111317", foreground: "#edf0e8", cursor: "#d4a854", selectionBackground: "#d4a85455", green: "#7fc29b", yellow: "#d4a854", blue: "#72a7c7", red: "#d87979" } })
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new WebLinksAddon()); terminal.open(hostRef.current); fit.fit(); terminal.focus()
      const unsubscribe = desktopLinux.subscribeData((data) => terminal.write(data))
      const input = terminal.onData((data) => void desktopLinux.write(data))
      const observer = new ResizeObserver(() => { try { fit.fit() } catch {} }); observer.observe(hostRef.current)
      terminal.writeln("\x1b[38;5;214mWorkToper Agent OS\x1b[0m - Linux shell")
      terminal.writeln("等待 Debian VM shell 就绪。启动日志显示在 Linux 桌面开机画面中。")
      void boot.catch((error) => terminal.writeln(`\r\n\x1b[31m启动失败: ${error instanceof Error ? error.message : String(error)}\x1b[0m`))
      cleanup = () => { observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose() }
    })()
    return () => { disposed = true; cleanup() }
  }, [])
  return <WindowFrame title="Linux 终端" subtitle="root shell · Debian VM" icon={Terminal} active={active} onFocus={onFocus} onMinimize={onMinimize} onClose={onClose} className="terminal-window">
    <div className="terminal-tabs"><span className="terminal-tab"><Terminal />root shell</span><span className="terminal-mode"><span className="status-dot" />{runtime.phase === "ready" ? "DEBIAN LINUX" : runtime.phase.toUpperCase()}</span></div>
    <div className="xterm-host" ref={hostRef} />
    <footer className="terminal-status"><span><PanelTop />shell</span><span><Network />QEMU VM</span><span>{runtime.bootProgress || 0}%</span><span>{runtime.detail}</span></footer>
  </WindowFrame>
}

function BootScreen({ runtime, error, fullscreen = false }: { runtime: RuntimeSnapshot; error: string; fullscreen?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      if (!hostRef.current || disposed) return
      const terminal = new XTerm({ cursorBlink: false, convertEol: true, disableStdin: true, scrollback: 3000, fontSize: 11, lineHeight: 1.25, fontFamily: '"Geist Mono", "SFMono-Regular", Consolas, monospace', theme: { background: "#050607", foreground: "#d9ded8", cursor: "#d4a854", selectionBackground: "#d4a85455", green: "#7fc29b", yellow: "#d4a854", blue: "#72a7c7", red: "#d87979" } })
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(hostRef.current); fit.fit()
      terminal.writeln("\x1b[38;5;214mWorkToper Agent OS\x1b[0m")
      terminal.writeln("QEMU BIOS、Linux kernel、systemd 启动日志会显示在这里。")
      const unsubscribe = desktopLinux.subscribeBoot((data) => terminal.write(data, () => terminal.scrollToBottom()))
      const observer = new ResizeObserver(() => { try { fit.fit() } catch {} }); observer.observe(hostRef.current)
      cleanup = () => { observer.disconnect(); unsubscribe(); terminal.dispose() }
    })()
    return () => { disposed = true; cleanup() }
  }, [])
  return <div className={`boot-screen ${fullscreen ? "boot-screen-fullscreen" : ""}`}>
    <div className="boot-screen-head"><span><span className="status-dot" />{runtime.phase === "error" ? "BOOT ERROR" : runtime.phase === "ready" ? "DESKTOP READY" : "BOOTING"}</span><strong>{runtime.bootProgress || 0}%</strong></div>
    <div className="boot-terminal" ref={hostRef} />
    <div className="boot-screen-status">{error || runtime.detail}</div>
  </div>
}

type RfbHandle = {
  disconnect: () => void
  focus?: (options?: FocusOptions) => void
  clipboardPasteFrom?: (text: string) => void
  scaleViewport?: boolean
  resizeSession?: boolean
  clipViewport?: boolean
  dragViewport?: boolean
  focusOnClick?: boolean
  showDotCursor?: boolean
  viewOnly?: boolean
  qualityLevel?: number
  compressionLevel?: number
  addEventListener?: (name: string, listener: (event?: Event) => void) => void
}

type RfbClipboardEvent = Event & { detail?: { text?: string }; text?: string }

function EmbeddedDesktopSurface({ runtime, onConnectedChange }: { runtime: RuntimeSnapshot; onConnectedChange?: (connected: boolean, error?: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RfbHandle | null>(null)
  const lastResizeRef = useRef("")
  const lastHostClipboardRef = useRef("")
  const lastRemoteClipboardRef = useRef("")
  const [connection, setConnection] = useState<VmConnection | null>(() => desktopLinux.getConnection())
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState("")
  const [retryTick, setRetryTick] = useState(0)
  const focusDesktop = () => {
    hostRef.current?.focus({ preventScroll: true })
    rfbRef.current?.focus?.({ preventScroll: true })
  }
  const syncClipboardToRemote = async () => {
    const rfb = rfbRef.current
    if (!rfb?.clipboardPasteFrom) return
    try {
      const text = await desktopLinux.readClipboardText()
      if (!text || text === lastHostClipboardRef.current) return
      lastHostClipboardRef.current = text
      rfb.clipboardPasteFrom(text)
    } catch {}
  }

  useEffect(() => {
    let disposed = false
    const syncConnection = () => {
      const current = desktopLinux.getConnection()
      if (current?.vncWebSocketUrl) setConnection(current)
      if (!current && (runtime.phase === "idle" || runtime.phase === "error")) setConnection(null)
    }
    syncConnection()
    if (runtime.phase === "idle") {
      void desktopLinux.boot().then((next) => {
        if (!disposed) setConnection(next)
      }).catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Linux VM 启动失败")
      })
    }
    const timer = window.setInterval(() => {
      if (!disposed) syncConnection()
    }, 800)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [runtime.phase])

  const vncWebSocketUrl = runtime.phase === "idle" || runtime.phase === "error" ? "" : runtime.vncWebSocketUrl || connection?.vncWebSocketUrl || ""

  useEffect(() => {
    if (!hostRef.current || !vncWebSocketUrl || rfbRef.current) return
    let disposed = false
    let retryTimer: number | undefined
    void (async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc")
        if (!hostRef.current || disposed) return
        const rfb = new RFB(hostRef.current, vncWebSocketUrl, { shared: true }) as RfbHandle
        rfb.viewOnly = false
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.clipViewport = false
        rfb.dragViewport = false
        rfb.focusOnClick = true
        rfb.showDotCursor = true
        rfb.qualityLevel = 7
        rfb.compressionLevel = 2
        rfb.addEventListener?.("connect", () => {
          setConnected(true)
          onConnectedChange?.(true)
          setError("")
          const refreshDesktop = () => {
            window.dispatchEvent(new Event("resize"))
            focusDesktop()
          }
          window.requestAnimationFrame(refreshDesktop)
          window.setTimeout(refreshDesktop, 250)
          window.setTimeout(refreshDesktop, 1000)
          window.setTimeout(() => void syncClipboardToRemote(), 350)
        })
        rfb.addEventListener?.("clipboard", (event?: Event) => {
          const clipboardEvent = event as RfbClipboardEvent | undefined
          const text = clipboardEvent?.detail?.text ?? clipboardEvent?.text ?? ""
          if (!text || text === lastRemoteClipboardRef.current) return
          lastRemoteClipboardRef.current = text
          lastHostClipboardRef.current = text
          void desktopLinux.writeClipboardText(text)
        })
        rfb.addEventListener?.("disconnect", () => {
          rfbRef.current = null
          setConnected(false)
          onConnectedChange?.(false)
          if (!disposed && runtime.phase !== "idle" && runtime.phase !== "error") retryTimer = window.setTimeout(() => setRetryTick((value) => value + 1), 900)
        })
        rfb.addEventListener?.("securityfailure", () => {
          setError("Linux 桌面显示安全握手失败")
          onConnectedChange?.(false, "Linux 桌面显示安全握手失败")
        })
        rfbRef.current = rfb
        window.requestAnimationFrame(focusDesktop)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "无法连接 Linux 桌面显示"
        setError(message)
        onConnectedChange?.(false, message)
        if (!disposed) retryTimer = window.setTimeout(() => setRetryTick((value) => value + 1), 1200)
      }
    })()
    return () => {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      setConnected(false)
      onConnectedChange?.(false)
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [vncWebSocketUrl, retryTick])

  useEffect(() => {
    if (!hostRef.current) return
    let timer: number | undefined
    const syncSize = () => {
      window.dispatchEvent(new Event("resize"))
      const key = "1920x1080"
      if (lastResizeRef.current === key) return
      lastResizeRef.current = key
      void desktopLinux.resizeDesktop(1920, 1080)
      window.setTimeout(() => window.dispatchEvent(new Event("resize")), 350)
      window.setTimeout(() => window.dispatchEvent(new Event("resize")), 900)
    }
    const observer = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => window.requestAnimationFrame(syncSize), 180)
    })
    observer.observe(hostRef.current)
    syncSize()
    return () => {
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [connected, runtime.phase])

  useEffect(() => {
    if (!connected || runtime.phase !== "ready") return
    const keepAlive = window.setInterval(() => {
      window.dispatchEvent(new Event("resize"))
      void desktopLinux.resizeDesktop(1920, 1080)
      rfbRef.current?.focus?.({ preventScroll: true })
      void syncClipboardToRemote()
    }, 30_000)
    return () => window.clearInterval(keepAlive)
  }, [connected, runtime.phase])

  useEffect(() => {
    if (runtime.phase !== "ready") return
    const refreshDesktop = () => {
      window.dispatchEvent(new Event("resize"))
      rfbRef.current?.focus?.({ preventScroll: true })
    }
    window.requestAnimationFrame(refreshDesktop)
    const timers = [
      window.setTimeout(refreshDesktop, 450),
      window.setTimeout(refreshDesktop, 1200),
    ]
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [runtime.phase])

  useEffect(() => {
    if (!connected || runtime.phase !== "ready") return
    const sync = () => void syncClipboardToRemote()
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") sync()
    }
    window.addEventListener("focus", sync)
    window.addEventListener("copy", sync)
    window.addEventListener("cut", sync)
    window.addEventListener("paste", sync)
    window.addEventListener("keydown", onKeyDown, true)
    const timer = window.setInterval(sync, 1200)
    sync()
    return () => {
      window.removeEventListener("focus", sync)
      window.removeEventListener("copy", sync)
      window.removeEventListener("cut", sync)
      window.removeEventListener("paste", sync)
      window.removeEventListener("keydown", onKeyDown, true)
      window.clearInterval(timer)
    }
  }, [connected, runtime.phase])

  return <section className="embedded-desktop-surface" aria-label="Linux 图形桌面">
    <div
      className="embedded-vnc-host"
      ref={hostRef}
      tabIndex={0}
      onPointerDown={focusDesktop}
      onMouseDown={() => { focusDesktop(); void syncClipboardToRemote() }}
      onTouchStart={() => { focusDesktop(); void syncClipboardToRemote() }}
      onWheel={focusDesktop}
      onKeyDown={focusDesktop}
      onContextMenu={(event) => event.preventDefault()}
    />
    {error && !connected && <div className="desktop-connect-error" aria-live="polite"><AppWindow /><strong>{error}</strong><span>{runtime.detail}</span></div>}
  </section>
}

function StoreWindow({ active, onFocus, onMinimize, onClose }: { active: boolean; onFocus: () => void; onMinimize: () => void; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [message, setMessage] = useState("选择软件包后会把 apt-get install 命令发送到 Linux VM。")
  const list = useMemo(() => packageCatalog.filter((pkg) => `${pkg.name} ${pkg.description}`.toLowerCase().includes(query.toLowerCase())), [query])
  const install = async (name: string) => {
    setMessage(`正在发送 apt-get install ${name}`)
    try {
      await desktopLinux.boot()
      await desktopLinux.write(`sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${name}\r`)
      setMessage(`${name} 的安装命令已发送到 Linux VM。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发送安装命令失败")
    }
  }
  return <WindowFrame title="APT 应用中心" subtitle="Debian package manager" icon={Package} active={active} onFocus={onFocus} onMinimize={onMinimize} onClose={onClose} className="store-window">
    <div className="store-hero"><div><span className="eyebrow">DEBIAN APT</span><h2>Linux 软件安装</h2><p>安装命令在 QEMU VM 内执行，软件会出现在 Linux 桌面环境中。</p></div><ShieldCheck /></div>
    <label className="search-box"><Search /><span className="sr-only">搜索软件包</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 code、chromium、git、nodejs…" /><button onClick={() => setQuery("")} aria-label="清空搜索"><RefreshCw /></button></label>
    <div className="package-list">{list.map((pkg) => <div className="package-row" key={pkg.name}><span className="package-icon"><Command /></span><div><strong>{pkg.name}</strong><p>{pkg.description}</p></div><span className="package-size">{pkg.size}</span><button onClick={() => install(pkg.name)}>安装</button></div>)}</div>
    <div className="demo-notice"><Info /><span><strong>APT</strong>{message}</span></div>
  </WindowFrame>
}

function KernelWindow({ active, onFocus, onMinimize, onClose, runtime }: { active: boolean; onFocus: () => void; onMinimize: () => void; onClose: () => void; runtime: RuntimeSnapshot }) {
  const connection = desktopLinux.getConnection()
  return <WindowFrame title="运行时监视器" subtitle="QEMU Linux VM" icon={Cpu} active={active} onFocus={onFocus} onMinimize={onMinimize} onClose={onClose} className="kernel-window"><div className="kernel-grid"><div className="kernel-main"><span className="eyebrow">DESKTOP VM RUNTIME</span><h2>真实 Linux 执行链</h2><div className="architecture-flow"><ArchitectureNode icon={AppWindow} title="Electron Shell" text="窗口与 IPC 控制" state="ready" /><ChevronRight /><ArchitectureNode icon={Cpu} title="QEMU VM" text="HVF/KVM/WHPX/TCG" state={runtime.cpuActive ? "busy" : "idle"} /><ChevronRight /><ArchitectureNode icon={Server} title="Debian Linux" text="APT + XFCE GUI" state={runtime.phase} /></div><div className="kernel-table"><div><span>资源</span><span>后端</span><span>状态</span><span>位置</span></div><div><span>CPU</span><span>QEMU 加速</span><span className="process-state">{runtime.cpuActive ? "运行" : "空闲"}</span><span>本机</span></div><div><span>磁盘</span><span>qcow2</span><span className="process-state">{runtime.diskActive ? "读写" : "空闲"}</span><span>{connection?.arch || "VM"}</span></div><div><span>显示</span><span>{connection?.displayMode || "embedded"}</span><span className="process-state">{runtime.phase === "ready" ? "就绪" : "等待"}</span><span>{connection?.displayName || "QEMU"}</span></div><div><span>网络</span><span>QEMU user net</span><span className="process-state">{runtime.network}</span><span>{connection ? `ssh:${connection.sshPort}` : "等待"}</span></div></div></div><aside className="kernel-side"><h3>启动链</h3><div className="mount-list"><span><strong>QEMU</strong><small>开源机器虚拟化器</small></span><span><strong>Debian qcow2</strong><small>APT 软件源和持久磁盘</small></span><span><strong>内嵌图形桌面</strong><small>同一应用窗口接收键盘鼠标</small></span></div><h3>执行边界</h3><ul className="policy-list"><li><ShieldCheck />不使用 Docker</li><li><ShieldCheck />不依赖本机 Ubuntu 镜像</li><li><ShieldCheck />Linux 应用在 VM 内运行</li><li><ShieldCheck />QEMU / Debian 开源方案</li></ul></aside></div></WindowFrame>
}

function ArchitectureNode({ icon: Icon, title, text, state }: { icon: LucideIcon; title: string; text: string; state: string }) { return <div className="architecture-node"><Icon /><strong>{title}</strong><span>{text}</span><small>{state}</small></div> }

function AboutWindow({ active, onFocus, onMinimize, onClose }: { active: boolean; onFocus: () => void; onMinimize: () => void; onClose: () => void }) {
  return <WindowFrame title="关于 WorkToper Agent OS" subtitle="Desktop Linux VM Edition" icon={Info} active={active} onFocus={onFocus} onMinimize={onMinimize} onClose={onClose} className="about-window"><div className="about-content"><div className="about-intro"><span className="eyebrow">WORKTOPER AGENT OS</span><h2>完整 Linux 桌面 VM</h2><p>系统由 Electron 启动 QEMU 虚拟机，VM 内运行 Debian、APT、XFCE 桌面和 Linux GUI 应用。应用启动时全屏显示 BIOS、kernel、systemd 启动过程，进入桌面后在同一个应用窗口内交互。</p></div><div className="architecture-lanes"><Lane index="01" title="桌面应用" text="Windows、macOS、Linux 上通过 Electron 打开同一个 WorkToper Agent OS 应用。" meta="Electron" /><Lane index="02" title="虚拟机" text="QEMU 启动用户数据目录中的 qcow2 Linux 磁盘，优先使用 HVF/KVM/WHPX。" meta="QEMU" /><Lane index="03" title="Linux 系统" text="Debian VM 提供 apt-get、systemd、XFCE、终端和图形应用运行环境。" meta="Debian" /><Lane index="04" title="桌面显示" text="QEMU 通过内嵌显示通道把桌面渲染到应用窗口。" meta="Embedded" /><Lane index="05" title="轻量策略" text="应用包不携带 qcow2 镜像；镜像保存在应用默认数据目录，应用更新不会膨胀。" meta="qcow2" /></div><div className="boundary-note"><Info /><div><strong>软件许可</strong><p>镜像默认安装 Microsoft VS Code 与 Google Chrome；Chrome 安装失败时会用 Chromium 兜底打开。</p></div></div></div></WindowFrame>
}

function Lane({ index, title, text, meta }: { index: string; title: string; text: string; meta: string }) { return <div className="lane"><span>{index}</span><div><strong>{title}</strong><p>{text}</p></div><small>{meta}</small></div> }

function SystemOverview({ openApp, runtime }: { openApp: (id: AppId) => void; runtime: RuntimeSnapshot }) {
  return <aside className="system-overview"><div className="overview-heading"><div><span>系统概览</span><strong>{runtime.phase === "ready" ? "Linux 已就绪" : runtime.phase === "error" ? "启动失败" : "正在启动"}</strong></div><span className="status-chip">{runtime.phase}</span></div><div className="boot-metric"><div><Gauge /><span>启动进度</span></div><strong>{runtime.bootProgress || 0}<small>%</small></strong><p>{runtime.detail}</p></div><div className="resource-list"><Resource label="CPU" value={runtime.cpuActive ? "执行中" : "空闲"} width={runtime.cpuActive ? "72%" : "8%"} icon={Cpu} /><Resource label="磁盘 I/O" value={runtime.diskActive ? "读写中" : "空闲"} width={runtime.diskActive ? "62%" : "4%"} icon={MemoryStick} /><Resource label="引擎" value="QEMU VM" width="68%" icon={HardDrive} /></div><div className="runtime-card"><div className="runtime-card-top"><Server /><div><strong>Debian Desktop VM</strong><span>QEMU · qcow2 · APT</span></div><span className="live-pulse" /></div><div className="runtime-stats"><span>状态<strong>{runtime.phase}</strong></span><span>网络<strong>{runtime.network}</strong></span><span>许可<strong>GPLv2</strong></span></div></div><button className="architecture-button" onClick={() => openApp("kernel")}><Box /><span><strong>查看运行时</strong><small>QEMU、显示、磁盘状态</small></span><ChevronRight /></button></aside>
}

function Resource({ label, value, width, icon: Icon }: { label: string; value: string; width: string; icon: LucideIcon }) { return <div className="resource-row"><div className="resource-meta"><span><Icon />{label}</span><strong>{value}</strong></div><div className="meter"><span style={{ width }} /></div></div> }

function Dock({ windows, openApp }: { windows: WindowState[]; openApp: (id: AppId) => void }) { return <nav className="dock" aria-label="应用 Dock">{dockApps.map((app) => { const running = windows.some((window) => window.id === app.id); return <button key={app.id} onClick={() => openApp(app.id)} aria-label={`打开${app.name}`} title={`${app.name} · ${app.subtitle}`}><AppIcon app={app} active={running} /><span className="dock-tooltip">{app.name}</span>{running && <span className="running-dot" />}</button> })}<span className="dock-separator" /><button onClick={() => void desktopLinux.stop()} aria-label="关闭 Linux VM" title="关闭 Linux VM"><span className="app-symbol power-symbol"><Power /></span></button></nav> }

const fallbackSettings: VmSettings = { cpus: 4, memoryMb: 4096, sharedDirectory: "", lockPassword: "worktoper" }

function DesktopControlOverlay({ runtime, locked, onLock }: { runtime: RuntimeSnapshot; locked: boolean; onLock: (password: string) => void }) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<VmSettings>(fallbackSettings)
  const [savedSettings, setSavedSettings] = useState<VmSettings>(fallbackSettings)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!open) return
    void desktopLinux.getSettings().then((nextSettings) => {
      setSettings(nextSettings)
      setSavedSettings(nextSettings)
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "读取设置失败")
    })
  }, [open])
  useEffect(() => {
    if (!locked) return
    setOpen(false)
    setSettingsOpen(false)
    setMessage("")
  }, [locked])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      setSettingsOpen(false)
      setMessage("")
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open])

  const updateSettings = (patch: Partial<VmSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
    setMessage("")
  }
  const chooseDirectory = async () => {
    try {
      const result = await desktopLinux.chooseSharedDirectory()
      if (!result.canceled) updateSettings({ sharedDirectory: result.path })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "选择目录失败")
    }
  }
  const saveSettings = async () => {
    if (saving) return
    setSaving(true)
    try {
      const saved = await desktopLinux.setSettings(settings)
      setSettings(saved)
      const vmConfigChanged = saved.cpus !== savedSettings.cpus || saved.memoryMb !== savedSettings.memoryMb || saved.sharedDirectory !== savedSettings.sharedDirectory
      setSavedSettings(saved)
      if (vmConfigChanged && runtime.phase !== "idle") {
        setMessage("已保存，正在重启 Linux VM 以应用设置")
        await desktopLinux.restartVm()
        setMessage(saved.sharedDirectory ? "共享目录已挂载到 /home/worktoper/Shared" : "已保存，共享目录已关闭")
      } else {
        setMessage("已保存")
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存设置失败")
    } finally {
      setSaving(false)
    }
  }
  const lockScreen = async () => {
    setOpen(false)
    setSettingsOpen(false)
    onLock(settings.lockPassword || fallbackSettings.lockPassword)
  }

  return <>
    <button className="desktop-control-trigger" onClick={() => setOpen(true)} aria-label="打开系统控制">
      <ChevronDown />
    </button>
    {open && <div className="desktop-control-overlay" role="dialog" aria-modal="true" aria-label="系统控制">
      <button className="desktop-control-close" onClick={() => { setOpen(false); setSettingsOpen(false); setMessage("") }} aria-label="关闭系统控制"><X /></button>
      <div className="desktop-control-actions">
        <button onClick={() => setSettingsOpen((value) => !value)} aria-label="设置" title="设置"><Settings /></button>
        <button onClick={() => void lockScreen()} aria-label="锁屏" title="锁屏"><LockKeyhole /></button>
        <button onClick={() => void desktopLinux.restartApp()} aria-label="重启" title="重启"><RefreshCw /></button>
        <button onClick={() => void desktopLinux.closeApp()} aria-label="关闭" title="关闭"><Power /></button>
      </div>
      {settingsOpen && <section className="desktop-settings-panel" aria-label="Linux 桌面运行设置">
        <label><span>CPU</span><input type="number" min="1" max="32" value={settings.cpus} onChange={(event) => updateSettings({ cpus: Number(event.target.value) })} /></label>
        <label><span>内存 MB</span><input type="number" min="1024" max="32768" step="512" value={settings.memoryMb} onChange={(event) => updateSettings({ memoryMb: Number(event.target.value) })} /></label>
        <label><span>锁屏密码</span><input type="password" value={settings.lockPassword} onChange={(event) => updateSettings({ lockPassword: event.target.value })} placeholder="worktoper" /></label>
        <label className="desktop-share-field"><span>共享目录</span><div><input value={settings.sharedDirectory} onChange={(event) => updateSettings({ sharedDirectory: event.target.value })} placeholder="未设置" /><button onClick={chooseDirectory} aria-label="选择共享目录"><FolderOpen /></button></div></label>
        <footer><span>{message || `状态：${runtime.detail}`}</span><button onClick={saveSettings} disabled={saving}>{saving ? "保存中" : "保存"}</button></footer>
      </section>}
    </div>}
  </>
}

function AppLockOverlay({ password, onUnlock }: { password: string; onUnlock: () => void }) {
  const [formVisible, setFormVisible] = useState(false)
  const [value, setValue] = useState("")
  const [message, setMessage] = useState("")
  const [clock, setClock] = useState(() => new Date())
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const timeText = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(clock)
  const dateText = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(clock)
  const unlock = () => {
    if (value === password) {
      setValue("")
      setMessage("")
      onUnlock()
      return
    }
    setMessage("密码错误")
    setValue("")
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }
  const showForm = () => {
    setFormVisible(true)
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }
  return <div className="app-lock-overlay" role="dialog" aria-modal="true" aria-label="锁屏">
    <div className="app-lock-clock" aria-label="当前时间"><strong>{timeText}</strong><span>{dateText}</span></div>
    {!formVisible && <button className="app-lock-primary" onClick={showForm} aria-label="解锁" title="解锁"><LockKeyhole /></button>}
    {formVisible && <form className="app-lock-form" onSubmit={(event) => { event.preventDefault(); unlock() }}>
      <input ref={inputRef} type="password" value={value} onChange={(event) => { setValue(event.target.value); setMessage("") }} placeholder="输入密码" />
      <button type="submit">解锁</button>
      <span>{message || "默认密码 worktoper"}</span>
    </form>}
  </div>
}

export function WebDesktop() {
  const [windows, setWindows] = useState<WindowState[]>([])
  const [bootOverlayVisible, setBootOverlayVisible] = useState(true)
  const [desktopConnected, setDesktopConnected] = useState(false)
  const [desktopConnectionError, setDesktopConnectionError] = useState("")
  const [lockPassword, setLockPassword] = useState("")
  const activityTimerRef = useRef<number | undefined>(undefined)
  const runtime = useRuntime()
  const lockWithStoredPassword = async () => {
    try {
      const settings = await desktopLinux.getSettings()
      setLockPassword(settings.lockPassword || fallbackSettings.lockPassword)
    } catch {
      setLockPassword(fallbackSettings.lockPassword)
    }
  }
  useEffect(() => {
    void desktopLinux.boot().catch(() => undefined)
  }, [])
  useEffect(() => {
    if (runtime.phase === "ready") {
      const timer = window.setTimeout(() => setBootOverlayVisible(false), desktopConnected ? 900 : 2200)
      return () => window.clearTimeout(timer)
    }
    setBootOverlayVisible(true)
  }, [runtime.phase, desktopConnected])
  useEffect(() => {
    if (runtime.phase !== "ready") {
      setDesktopConnected(false)
      setDesktopConnectionError("")
    }
  }, [runtime.phase])
  useEffect(() => {
    if (runtime.phase !== "ready" || lockPassword) return
    const armTimer = () => {
      if (activityTimerRef.current) window.clearTimeout(activityTimerRef.current)
      activityTimerRef.current = window.setTimeout(() => {
        void lockWithStoredPassword()
      }, autoLockIdleMs)
    }
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]
    events.forEach((eventName) => window.addEventListener(eventName, armTimer, { passive: true }))
    armTimer()
    return () => {
      if (activityTimerRef.current) window.clearTimeout(activityTimerRef.current)
      activityTimerRef.current = undefined
      events.forEach((eventName) => window.removeEventListener(eventName, armTimer))
    }
  }, [runtime.phase, lockPassword])
  const topZ = Math.max(2, ...windows.map((window) => window.z))
  const openApp = (id: AppId) => setWindows((current) => {
    if (id === "desktop" || id === "vscode" || id === "chrome") return current
    const exists = current.find((window) => window.id === id)
    const nextZ = Math.max(2, ...current.map((window) => window.z)) + 1
    if (exists) return current.map((window) => window.id === id ? { ...window, minimized: false, z: nextZ } : window)
    return [...current, { id, minimized: false, z: nextZ }]
  })
  const focus = (id: AppId) => setWindows((current) => current.map((window) => window.id === id && window.z !== topZ ? { ...window, z: topZ + 1 } : window))
  const minimize = (id: AppId) => setWindows((current) => current.map((window) => window.id === id ? { ...window, minimized: true } : window))
  const close = (id: AppId) => setWindows((current) => current.filter((window) => window.id !== id))
  const launchApp = (id: AppId) => {
    if (id === "desktop") {
      void desktopLinux.boot()
      return
    }
    if (id === "vscode" || id === "chrome") {
      void desktopLinux.launch(id)
      return
    }
    openApp(id)
  }
  const embeddedReady = runtime.phase === "ready"
  return <main className={`web-os-shell ${embeddedReady ? "linux-desktop-interactive" : ""}`}>
    <TopBar openApp={launchApp} runtime={runtime} />
    <section className="desktop" aria-label="WorkToper Agent OS 桌面">
      <EmbeddedDesktopSurface
        runtime={runtime}
        onConnectedChange={(nextConnected, nextError) => {
          setDesktopConnected(nextConnected)
          setDesktopConnectionError(nextError || "")
        }}
      />
      <div className="desktop-shortcuts">{apps.map((app) => <button key={app.id} onDoubleClick={() => launchApp(app.id)} onClick={() => launchApp(app.id)}><AppIcon app={app} /><span>{app.name}</span></button>)}</div>
      <div className="workspace-layout"><div className="window-stage">
        {windows.map((window) => !window.minimized && <div key={window.id} className={`window-position window-${window.id}`} style={{ zIndex: window.z }}>
          {window.id === "terminal" && <TerminalWindow active={window.z === topZ} onFocus={() => focus(window.id)} onMinimize={() => minimize(window.id)} onClose={() => close(window.id)} runtime={runtime} />}
          {window.id === "store" && <StoreWindow active={window.z === topZ} onFocus={() => focus(window.id)} onMinimize={() => minimize(window.id)} onClose={() => close(window.id)} />}
          {window.id === "kernel" && <KernelWindow active={window.z === topZ} onFocus={() => focus(window.id)} onMinimize={() => minimize(window.id)} onClose={() => close(window.id)} runtime={runtime} />}
          {window.id === "about" && <AboutWindow active={window.z === topZ} onFocus={() => focus(window.id)} onMinimize={() => minimize(window.id)} onClose={() => close(window.id)} />}
        </div>)}
      </div><SystemOverview openApp={launchApp} runtime={runtime} /></div>
    </section>
    {embeddedReady && <DesktopControlOverlay runtime={runtime} locked={Boolean(lockPassword)} onLock={(password) => setLockPassword(password || fallbackSettings.lockPassword)} />}
    {lockPassword && <AppLockOverlay password={lockPassword} onUnlock={() => setLockPassword("")} />}
    {bootOverlayVisible && <BootScreen runtime={runtime} error={runtime.phase === "error" ? runtime.detail : desktopConnectionError} fullscreen />}
    <Dock windows={windows} openApp={launchApp} />
  </main>
}
