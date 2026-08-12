const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

function commandExists(command) {
  const paths = (process.env.PATH || "").split(path.delimiter)
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]
  for (const directory of paths) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      if (fileExists(candidate)) return candidate
    }
  }
  return ""
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\\''")}'`
}

function platformExecutableCandidates(command) {
  if (process.platform === "darwin") {
    return [
      path.join("/opt/homebrew/bin", command),
      path.join("/usr/local/bin", command),
      path.join("/opt/local/bin", command),
    ]
  }
  if (process.platform === "linux") {
    return [
      path.join("/usr/local/bin", command),
      path.join("/usr/bin", command),
      path.join("/snap/bin", command),
    ]
  }
  if (process.platform === "win32") {
    return [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "qemu", command),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "qemu", command),
    ]
  }
  return []
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate localhost port"))
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function getFreeVncDisplay() {
  if (process.env.WORKTOPER_VNC_DISPLAY) return Number(process.env.WORKTOPER_VNC_DISPLAY)
  for (let display = 1; display < 100; display += 1) {
    if (await portAvailable(5900 + display)) return display
  }
  throw new Error("Unable to allocate QEMU VNC display")
}

function getQgaSocketPath(app) {
  if (process.platform === "win32") return ""
  const name = `worktoper-qga-${process.pid}.sock`
  return path.join(app.getPath("temp") || os.tmpdir(), name)
}

class GuestAgent {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.socket = null
    this.buffer = ""
    this.queue = []
    this.pending = null
  }

  connect() {
    if (!this.socketPath || this.socket) return
    this.socket = net.createConnection(this.socketPath)
    this.socket.on("data", (chunk) => this.onData(chunk))
    this.socket.on("error", () => this.close())
    this.socket.on("close", () => this.close())
  }

  close() {
    this.socket?.destroy()
    this.socket = null
    this.buffer = ""
    if (this.pending) {
      this.pending.reject(new Error("QEMU guest agent disconnected"))
      this.pending = null
    }
    const queued = this.queue.splice(0)
    queued.forEach((item) => item.reject(new Error("QEMU guest agent disconnected")))
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8")
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.resolveLine(line)
      newline = this.buffer.indexOf("\n")
    }
  }

  resolveLine(line) {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    try {
      const message = JSON.parse(line)
      if (message.error) {
        pending.reject(new Error(message.error.desc || message.error.class || "QEMU guest agent error"))
      } else {
        pending.resolve(message.return)
      }
    } catch (error) {
      pending.reject(error)
    }
    this.flush()
  }

  execute(command) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject })
      this.flush()
    })
  }

  flush() {
    if (this.pending || !this.socket || this.socket.destroyed) return
    const next = this.queue.shift()
    if (!next) return
    this.pending = next
    this.socket.write(`${JSON.stringify(next.command)}\n`)
  }

  async guestExec(command) {
    const result = await this.execute({
      execute: "guest-exec",
      arguments: {
        path: "/usr/sbin/runuser",
        arg: ["-u", "worktoper", "--", "/bin/sh", "-lc", command],
        "capture-output": false,
      },
    })
    return result
  }

  async guestShell(command, { user = "", captureOutput = true } = {}) {
    const args = user ? ["-u", user, "--", "/bin/sh", "-lc", command] : ["-lc", command]
    const result = await this.execute({
      execute: "guest-exec",
      arguments: {
        path: user ? "/usr/sbin/runuser" : "/bin/sh",
        arg: args,
        "capture-output": captureOutput,
      },
    })
    const pid = result?.pid
    if (!pid) return { exitcode: 1 }
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const status = await this.execute({ execute: "guest-exec-status", arguments: { pid } })
      if (status?.exited) {
        return {
          ...status,
          stdout: decodeGuestData(status["out-data"]),
          stderr: decodeGuestData(status["err-data"]),
        }
      }
    }
    return { exitcode: 124 }
  }
}

function getResourcesRoot(app) {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath())
}

function getRuntimeRoots(app) {
  const resourcesRoot = getResourcesRoot(app)
  return [
    path.join(resourcesRoot, "runtime"),
    path.join(resourcesRoot, "app.asar.unpacked", "runtime"),
    path.join(app.getAppPath(), "runtime"),
  ]
}

function getQemuName(arch = "x64") {
  const exe = process.platform === "win32" ? ".exe" : ""
  return arch === "arm64" ? `qemu-system-aarch64${exe}` : `qemu-system-x86_64${exe}`
}

function qemuCandidates(app, arch = "x64") {
  if (process.env.WORKTOPER_QEMU) return [process.env.WORKTOPER_QEMU]
  const qemuName = getQemuName(arch)
  const runtimeCandidates = getRuntimeRoots(app).flatMap((runtimeRoot) => [
    path.join(runtimeRoot, "qemu", process.platform, qemuName),
    path.join(runtimeRoot, "qemu", qemuName),
  ])
  return [
    ...runtimeCandidates,
    ...platformExecutableCandidates(qemuName),
    commandExists(qemuName),
  ].filter(Boolean)
}

function resolveQemuBinary(app, arch = "x64") {
  return qemuCandidates(app, arch).find(fileExists) || ""
}

function resolveVmImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_IMAGE) return process.env.WORKTOPER_VM_IMAGE
  const userVmDir = path.join(app.getPath("userData"), "vm")
  const userDisk = path.join(userVmDir, `worktoper-agent-os-${arch}.qcow2`)
  return userDisk
}

function resolveSeedImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_SEED) return process.env.WORKTOPER_VM_SEED
  const candidates = [
    path.join(app.getPath("userData"), "vm", `seed-${arch}.iso`),
    ...getRuntimeRoots(app).map((runtimeRoot) => path.join(runtimeRoot, "images", `seed-${arch}.iso`)),
  ]
  return candidates.find(fileExists) || ""
}

function getAccelArgs() {
  if (process.env.WORKTOPER_QEMU_ACCEL) {
    return ["-accel", process.env.WORKTOPER_QEMU_ACCEL]
  }
  if (process.platform === "darwin") return ["-accel", "hvf", "-accel", "tcg"]
  if (process.platform === "linux") return ["-accel", "kvm", "-accel", "tcg"]
  if (process.platform === "win32") return ["-accel", "whpx", "-accel", "tcg"]
  return ["-accel", "tcg"]
}

function getVideoArgs(arch = "x64") {
  const video = (process.env.WORKTOPER_QEMU_VIDEO || (arch === "arm64" ? "virtio" : "std")).toLowerCase()
  if (video === "none") return []
  if (video === "virtio") return ["-device", arch === "arm64" ? "virtio-gpu-pci" : "virtio-vga"]
  if (video === "qxl") return ["-device", "qxl-vga"]
  return ["-vga", "std"]
}

function getDisplayMode() {
  return "embedded"
}

function createVncWebSocketProxy({ listenPort, targetPort, onLog }) {
  const server = net.createServer((socket) => {
    let upgraded = false
    let buffer = Buffer.alloc(0)
    let target = null

    const close = () => {
      socket.destroy()
      target?.destroy()
    }
    const sendFrame = (payload, opcode = 2) => {
      if (socket.destroyed) return
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      let header
      if (data.length < 126) {
        header = Buffer.from([0x80 | opcode, data.length])
      } else if (data.length <= 0xffff) {
        header = Buffer.alloc(4)
        header[0] = 0x80 | opcode
        header[1] = 126
        header.writeUInt16BE(data.length, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = 0x80 | opcode
        header[1] = 127
        header.writeBigUInt64BE(BigInt(data.length), 2)
      }
      socket.write(Buffer.concat([header, data]))
    }
    const parseFrames = () => {
      while (buffer.length >= 2) {
        const first = buffer[0]
        const second = buffer[1]
        const opcode = first & 0x0f
        const masked = Boolean(second & 0x80)
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < offset + 2) return
          length = buffer.readUInt16BE(offset)
          offset += 2
        } else if (length === 127) {
          if (buffer.length < offset + 8) return
          const wideLength = buffer.readBigUInt64BE(offset)
          if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) return close()
          length = Number(wideLength)
          offset += 8
        }
        if (!masked || buffer.length < offset + 4) return
        const mask = buffer.subarray(offset, offset + 4)
        offset += 4
        if (buffer.length < offset + length) return
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        buffer = buffer.subarray(offset + length)
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        if (opcode === 0x8) return close()
        if (opcode === 0x9) {
          sendFrame(payload, 0xA)
          continue
        }
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) target?.write(payload)
      }
    }
    socket.on("data", (chunk) => {
      if (!upgraded) {
        buffer = Buffer.concat([buffer, chunk])
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd < 0) return
        const request = buffer.subarray(0, headerEnd).toString("latin1")
        const key = request.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim()
        if (!key) return close()
        const protocol = request.match(/^Sec-WebSocket-Protocol:\s*(.+)$/im)?.[1]?.split(",")[0]?.trim()
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
        target = net.createConnection({ host: "127.0.0.1", port: targetPort })
        target.on("connect", () => {
          upgraded = true
          const response = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
          ]
          if (protocol) response.push(`Sec-WebSocket-Protocol: ${protocol}`)
          socket.write(`${response.join("\r\n")}\r\n\r\n`)
          buffer = buffer.subarray(headerEnd + 4)
          if (buffer.length) parseFrames()
        })
        target.on("data", (data) => sendFrame(data))
        target.on("error", (error) => {
          onLog?.(`[WorkToper] VNC websocket proxy target error: ${error.message}`)
          close()
        })
        target.on("close", close)
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      parseFrames()
    })
    socket.on("error", close)
    socket.on("close", close)
  })
  server.listen(listenPort, "127.0.0.1")
  return server
}

function getDisplayConfig({ vncTcpPort, vncWebSocketPort }) {
  const mode = getDisplayMode()
  return {
    mode,
    name: "x11vnc-websocket",
    args: ["-display", "none"],
    vncTcpPort,
    vncWebSocketPort,
    vncWebSocketUrl: `ws://127.0.0.1:${vncWebSocketPort}/`,
  }
}

function qemuArgs({ arch, disk, seed, serialPort, sshPort, vncTcpPort, memoryMb, cpus, qgaSocketPath, displayArgs, sharedDirectory }) {
  const hostForwards = [
    `hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    `hostfwd=tcp:127.0.0.1:${vncTcpPort}-:5900`,
  ].join(",")
  const args = [
    ...getAccelArgs(),
    "-name", "WorkToper Agent OS Linux Desktop",
    "-m", String(memoryMb),
    "-smp", String(cpus),
    "-machine", "q35",
    "-cpu", process.env.WORKTOPER_QEMU_CPU || "max",
    "-monitor", "none",
    ...displayArgs,
    ...getVideoArgs(arch),
    "-device", "qemu-xhci",
    "-device", "usb-tablet",
    "-device", "usb-kbd",
    "-device", "virtio-rng-pci",
    "-drive", `file=${disk},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
    "-netdev", `user,id=net0,${hostForwards}`,
    "-device", "virtio-net-pci,netdev=net0",
    "-serial", `tcp:127.0.0.1:${serialPort},server=on,wait=off,nodelay=on`,
  ]
  if (qgaSocketPath) {
    args.push(
      "-chardev", `socket,path=${qgaSocketPath},server=on,wait=off,id=qga0`,
      "-device", "virtio-serial",
      "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    )
  }
  if (sharedDirectory && fileExists(sharedDirectory)) {
    args.push("-virtfs", `local,path=${sharedDirectory},mount_tag=worktoper_share,security_model=mapped-xattr,id=worktoper_share`)
  }
  if (seed) args.push("-drive", `file=${seed},format=raw,if=virtio,media=cdrom,readonly=on`)
  return args
}

function qemuCommandLine(qemu, args) {
  return [qemu, ...args].map(shellQuote).join(" ")
}

function decodeGuestData(value) {
  return value ? Buffer.from(value, "base64").toString("utf8") : ""
}

function findDiskUserHint(disk) {
  if (process.platform === "win32" || !commandExists("pgrep")) return ""
  const result = spawnSync("pgrep", ["-fl", `qemu-system.*${path.basename(disk)}`], { encoding: "utf8" })
  if (result.status !== 0) return ""
  return result.stdout.split(/\r?\n/).filter(Boolean).join("\n")
}

class VmManager {
  constructor({ app, webContents, onState, getSettings }) {
    this.app = app
    this.webContents = webContents
    this.onState = onState
    this.getSettings = getSettings
    this.process = null
    this.serial = null
    this.guestAgent = null
    this.shellReady = false
    this.pendingShellWrites = []
    this.lastErrorDetail = ""
    this.desktopReady = false
    this.lastDesktopLog = ""
    this.desktopRepairAttempted = false
    this.pendingLaunches = []
    this.vncProxyServer = null
    this.vncTcpPort = 0
    this.sharedDirectory = ""
    this.pendingDesktopSize = null
    this.resizeTimer = null
    this.lastAppliedDesktopSize = ""
    this.state = {
      phase: "idle",
      detail: "Linux VM 尚未启动",
      bootProgress: 0,
      cpuActive: false,
      diskActive: false,
      network: "disconnected",
    }
    this.connection = null
  }

  send(channel, payload) {
    if (!this.webContents || this.webContents.isDestroyed()) return
    this.webContents.send(channel, payload)
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    this.send("worktoper:vm:state", this.state)
    this.onState?.(this.state)
  }

  async start() {
    if (this.process && !this.process.killed && this.connection) return this.connection

    const arch = process.env.WORKTOPER_VM_ARCH || (process.arch === "arm64" ? "arm64" : "x64")
    const qemu = resolveQemuBinary(this.app, arch)
    const disk = resolveVmImage(this.app, arch)
    const seed = resolveSeedImage(this.app, arch)
    if (!qemu || !fileExists(qemu)) {
      const searched = qemuCandidates(this.app, arch).join(", ")
      throw new Error(`未找到 QEMU ${getQemuName(arch)}。请安装 QEMU，或设置 WORKTOPER_QEMU 指向随应用打包的 QEMU 二进制。已查找：${searched || "无"}`)
    }
    if (!fileExists(disk)) {
      throw new Error(`未找到 Linux VM 镜像：${disk}。请先运行 corepack pnpm@10.15.0 vm:prepare，或设置 WORKTOPER_VM_IMAGE。`)
    }
    const diskUserHint = findDiskUserHint(disk)
    if (diskUserHint) {
      throw new Error(`VM 镜像正在被另一个 QEMU 进程使用，不能重复启动：${disk}\n${diskUserHint}\n请先退出旧的 WorkToper Agent OS 或停止旧 QEMU 后再启动。`)
    }

    const [serialPort, sshPort, vncTcpPort, vncWebSocketPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort(), getFreePort()])
    const display = getDisplayConfig({ vncTcpPort, vncWebSocketPort })
    this.vncTcpPort = vncTcpPort
    this.vncProxyServer?.close()
    this.vncProxyServer = createVncWebSocketProxy({
      listenPort: vncWebSocketPort,
      targetPort: vncTcpPort,
      onLog: (line) => this.send("worktoper:vm:boot", `${line}\r\n`),
    })
    const qgaSocketPath = getQgaSocketPath(this.app)
    if (qgaSocketPath) fs.rmSync(qgaSocketPath, { force: true })
    const settings = this.getSettings?.() || {}
    const memoryMb = Number(process.env.WORKTOPER_VM_MEMORY || settings.memoryMb || 4096)
    const cpus = Number(process.env.WORKTOPER_VM_CPUS || settings.cpus || Math.max(2, Math.min(os.cpus().length, 4)))
    const sharedDirectory = typeof settings.sharedDirectory === "string" && fileExists(settings.sharedDirectory) ? settings.sharedDirectory : ""
    this.sharedDirectory = sharedDirectory
    const args = qemuArgs({ arch, disk, seed, serialPort, sshPort, vncTcpPort, memoryMb, cpus, qgaSocketPath, displayArgs: display.args, sharedDirectory })

    this.update({ phase: "loading", detail: "正在启动 QEMU Linux VM", bootProgress: 8, cpuActive: true, diskActive: true })
    this.lastErrorDetail = ""
    this.send("worktoper:vm:boot", [
      "\r\n[WorkToper] Preparing Linux VM",
      `[WorkToper] QEMU: ${qemu}`,
      `[WorkToper] Disk: ${disk}`,
      `[WorkToper] Seed: ${seed || "none"}`,
      `[WorkToper] Display: ${display.mode} (${display.name})`,
      `[WorkToper] VNC TCP: 127.0.0.1:${display.vncTcpPort} -> guest:5900`,
      display.vncWebSocketUrl ? `[WorkToper] VNC websocket: ${display.vncWebSocketUrl}` : "",
      `[WorkToper] CPU: ${cpus}`,
      `[WorkToper] Memory: ${memoryMb} MB`,
      `[WorkToper] Shared directory: ${sharedDirectory || "none"}`,
      `[WorkToper] Launch command: ${qemuCommandLine(qemu, args)}`,
      "",
    ].filter((line) => line !== "").join("\r\n"))
    this.process = spawn(qemu, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    this.shellReady = false
    this.pendingShellWrites = []
    this.desktopReady = false
    this.lastDesktopLog = ""
    this.desktopRepairAttempted = false
    this.process.stdout.on("data", (chunk) => this.send("worktoper:vm:boot", chunk.toString("utf8")))
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      this.send("worktoper:vm:boot", text)
      if (/Failed to get "write" lock|Is another process using the image/i.test(text)) {
        this.lastErrorDetail = `VM 镜像正在被另一个 QEMU 进程使用：${disk}。请先退出旧的 WorkToper Agent OS 或停止旧 QEMU。`
        this.update({ phase: "error", detail: this.lastErrorDetail, cpuActive: false, diskActive: false, network: "disconnected" })
        return
      }
      if (/error|failed|could not/i.test(text)) this.update({ detail: text.trim().slice(0, 180) })
    })
    this.process.once("exit", (code, signal) => {
      this.serial?.destroy()
      this.serial = null
      this.guestAgent?.close()
      this.guestAgent = null
      this.process = null
      this.connection = null
      this.shellReady = false
      this.pendingShellWrites = []
      this.desktopReady = false
      this.desktopRepairAttempted = false
      this.pendingLaunches = []
      this.vncProxyServer?.close()
      this.vncProxyServer = null
      this.vncTcpPort = 0
      this.update({ phase: code === 0 ? "idle" : "error", detail: this.lastErrorDetail || `Linux VM 已退出: ${signal || code}`, cpuActive: false, diskActive: false, network: "disconnected" })
    })

    this.connection = {
      arch,
      disk,
      seed,
      sshPort,
      serialPort,
      qgaSocketPath,
      displayMode: display.mode,
      displayName: display.name,
      vncWebSocketUrl: display.vncWebSocketUrl,
    }
    this.update({
      displayMode: display.mode,
      displayName: display.name,
      vncWebSocketUrl: display.vncWebSocketUrl,
    })
    this.connectSerial(serialPort)
    this.connectGuestAgent(qgaSocketPath)
    setTimeout(() => {
      if (this.process && this.state.phase !== "ready") this.update({ phase: "loading", detail: "QEMU 已启动，正在等待 Linux 桌面完成启动", bootProgress: Math.max(this.state.bootProgress, 68), network: "connecting", diskActive: true })
    }, 1200)
    return this.connection
  }

  connectGuestAgent(socketPath) {
    if (!socketPath) return
    let attempts = 0
    const connect = () => {
      if (!this.process || this.guestAgent) return
      attempts += 1
      const agent = new GuestAgent(socketPath)
      agent.connect()
      const timer = setTimeout(() => {
        if (this.guestAgent !== agent) agent.close()
        if (!this.guestAgent && attempts < 120) setTimeout(connect, 500)
      }, 800)
      agent.execute({ execute: "guest-ping" }).then(() => {
        clearTimeout(timer)
        this.guestAgent = agent
        this.update({ detail: "QEMU Guest Agent 已连接，正在检测 Linux 桌面", bootProgress: Math.max(this.state.bootProgress, 72), network: "connected" })
        this.waitForDesktopReady()
      }).catch(() => {
        clearTimeout(timer)
        agent.close()
        if (attempts < 120) setTimeout(connect, 500)
      })
    }
    setTimeout(connect, 1200)
  }

  waitForDesktopReady() {
    let attempts = 0
    const check = async () => {
      if (!this.process || !this.guestAgent || this.desktopReady) return
      attempts += 1
      try {
        const status = await this.guestAgent.guestShell("(systemctl is-active --quiet lightdm || systemctl is-active --quiet display-manager) && pgrep -u worktoper -x xfce4-session >/dev/null && pgrep -u worktoper -x xfce4-panel >/dev/null && pgrep -u worktoper -x xfdesktop >/dev/null && pgrep -u worktoper -x xfwm4 >/dev/null && pgrep -f 'Xorg|Xwayland' >/dev/null", { captureOutput: true })
        if (status.exitcode === 0) {
          const vncReady = await this.ensureEmbeddedVnc()
          if (vncReady) {
            this.markDesktopReady("lightdm / XFCE / x11vnc readiness check")
            return
          }
          this.update({ phase: "loading", detail: "XFCE 已启动，正在准备内嵌桌面画面", bootProgress: Math.max(this.state.bootProgress, 96), network: "connected" })
        } else if (attempts <= 6 || attempts % 8 === 0) {
          if (attempts === 1) await this.repairDesktopRuntime()
          await this.ensureDesktopSession()
        }
        if (attempts <= 6 || attempts % 8 === 0) await this.logDesktopStartup(attempts)
      } catch (error) {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Desktop readiness check failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
      }
      if (attempts < 240) {
        const progress = Math.min(98, 72 + Math.floor(attempts / 4))
        this.update({ phase: "loading", detail: "Linux 桌面仍在启动，等待 lightdm / XFCE", bootProgress: Math.max(this.state.bootProgress, progress), network: "connected" })
        setTimeout(check, 1000)
      } else {
        this.update({ phase: "error", detail: "Linux 桌面启动超时：未检测到 lightdm / XFCE 会话", cpuActive: false, diskActive: false, network: "connected" })
      }
    }
    void check()
  }

  async repairDesktopRuntime() {
    if (!this.guestAgent || this.desktopRepairAttempted) return
    this.desktopRepairAttempted = true
    const command = [
      "set -u",
      "echo '$ set default Linux passwords'",
      "printf 'root:root\\nworktoper:worktoper\\n' | chpasswd || true",
      "passwd -u root >/dev/null 2>&1 || true",
      "echo '$ enable root/password ssh login'",
      "mkdir -p /etc/ssh/sshd_config.d",
      "printf '%s\\n' 'PermitRootLogin yes' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication yes' > /etc/ssh/sshd_config.d/99-worktoper-password-login.conf",
      "systemctl restart ssh || systemctl restart sshd || true",
      "echo '$ ensure lightdm autologin config'",
      "mkdir -p /etc/lightdm/lightdm.conf.d",
      "printf '%s\\n' '[Seat:*]' 'autologin-user=worktoper' 'autologin-user-timeout=0' 'user-session=xfce' > /etc/lightdm/lightdm.conf.d/50-worktoper-autologin.conf",
      "echo '$ mkdir -p /var/lib/lightdm/data /run/lightdm /var/log/lightdm'",
      "mkdir -p /var/lib/lightdm/data /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local/share /run/lightdm /var/log/lightdm",
      "echo '$ chown/chmod lightdm runtime directories'",
      "if id lightdm >/dev/null 2>&1; then chown -R lightdm:lightdm /var/lib/lightdm /run/lightdm /var/log/lightdm; fi",
      "chmod 0755 /var/lib/lightdm /run/lightdm /var/log/lightdm",
      "chmod 0700 /var/lib/lightdm/data /var/lib/lightdm/.cache /var/lib/lightdm/.cache/lightdm /var/lib/lightdm/.config /var/lib/lightdm/.local /var/lib/lightdm/.local/share 2>/dev/null || true",
      "echo '$ systemctl reset-failed lightdm display-manager'",
      "systemctl reset-failed lightdm display-manager || true",
      "echo '$ systemctl restart lightdm || systemctl restart display-manager'",
      "systemctl restart lightdm || systemctl restart display-manager || true",
    ].join("; ")
    this.send("worktoper:vm:boot", "\r\n[WorkToper] Repairing Linux desktop runtime before readiness check\r\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `${text}\r\n`)
  }

  async ensureDesktopSession() {
    if (!this.guestAgent) return
    const sharedDirectoryCommands = this.sharedDirectory ? [
      "install -d -m 0755 -o worktoper -g worktoper /home/worktoper/Shared",
      "if ! mountpoint -q /home/worktoper/Shared >/dev/null 2>&1; then",
      "  echo '$ mount shared directory at /home/worktoper/Shared'",
      "  mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144 worktoper_share /home/worktoper/Shared || mount -t 9p -o trans=virtio,version=9p2000.L worktoper_share /home/worktoper/Shared || true",
      "fi",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=Shared' 'Exec=exo-open --launch FileManager /home/worktoper/Shared' 'Icon=folder' 'Terminal=false' 'Categories=Utility;' > /home/worktoper/Desktop/Shared.desktop",
    ] : [
      "rm -f /home/worktoper/Desktop/Shared.desktop 2>/dev/null || true",
    ]
    const command = [
      "set -u",
      "export DISPLAY=:0",
      "export XAUTHORITY=/home/worktoper/.Xauthority",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "mkdir -p /run/user/1000",
      "chown worktoper:worktoper /run/user/1000 2>/dev/null || true",
      "chmod 0700 /run/user/1000 2>/dev/null || true",
      "install -d -m 0755 -o worktoper -g worktoper /home/worktoper/Desktop /home/worktoper/Projects",
      "install -d -m 0700 -o worktoper -g worktoper /home/worktoper/.config /home/worktoper/.config/autostart /home/worktoper/.config/xfce4 /home/worktoper/.config/xfce4/xfconf /home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml",
      ...sharedDirectoryCommands,
      "cat >/usr/local/sbin/worktoper-install-vscode <<'WORKTOPER_INSTALL_VSCODE'",
      "#!/bin/sh",
      "set -eu",
      "if command -v code >/dev/null 2>&1; then exit 0; fi",
      "arch=$(dpkg --print-architecture)",
      "install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d",
      "curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor >/tmp/worktoper-packages-microsoft.gpg",
      "install -m 0644 /tmp/worktoper-packages-microsoft.gpg /usr/share/keyrings/packages.microsoft.gpg",
      "printf 'deb [arch=%s signed-by=/usr/share/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main\\n' \"$arch\" >/etc/apt/sources.list.d/vscode.list",
      "DEBIAN_FRONTEND=noninteractive apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y code",
      "WORKTOPER_INSTALL_VSCODE",
      "chmod 0755 /usr/local/sbin/worktoper-install-vscode",
      "cat >/usr/local/sbin/worktoper-install-chrome <<'WORKTOPER_INSTALL_CHROME'",
      "#!/bin/sh",
      "set -eu",
      "if command -v google-chrome >/dev/null 2>&1; then exit 0; fi",
      "arch=$(dpkg --print-architecture)",
      "[ \"$arch\" = amd64 ] || exit 1",
      "install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d",
      "curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor >/tmp/worktoper-google-linux.gpg",
      "install -m 0644 /tmp/worktoper-google-linux.gpg /usr/share/keyrings/google-linux-keyring.gpg",
      "printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main\\n' >/etc/apt/sources.list.d/google-chrome.list",
      "DEBIAN_FRONTEND=noninteractive apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable",
      "WORKTOPER_INSTALL_CHROME",
      "chmod 0755 /usr/local/sbin/worktoper-install-chrome",
      "cat >/usr/local/sbin/worktoper-install-layan-theme <<'WORKTOPER_INSTALL_LAYAN'",
      "#!/bin/sh",
      "set -eu",
      "theme_dir=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*' | head -n 1 2>/dev/null || true)",
      "if [ -n \"$theme_dir\" ]; then exit 0; fi",
      "DEBIAN_FRONTEND=noninteractive apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y git ca-certificates gtk2-engines-murrine gtk2-engines-pixbuf sassc",
      "install -d -m 0755 /opt/worktoper",
      "if [ -d /opt/worktoper/Layan-gtk-theme/.git ]; then",
      "  git -C /opt/worktoper/Layan-gtk-theme pull --ff-only",
      "else",
      "  rm -rf /opt/worktoper/Layan-gtk-theme",
      "  git clone --depth 1 https://github.com/vinceliuice/Layan-gtk-theme.git /opt/worktoper/Layan-gtk-theme",
      "fi",
      "cd /opt/worktoper/Layan-gtk-theme",
      "bash ./install.sh -d /usr/share/themes -c dark -s solid || bash ./install.sh -d /usr/share/themes -c dark || bash ./install.sh -d /usr/share/themes",
      "WORKTOPER_INSTALL_LAYAN",
      "cat >/usr/local/bin/worktoper-apply-layan-theme <<'WORKTOPER_APPLY_LAYAN'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*' -printf '%f\\n' | head -n 1 2>/dev/null || true)",
      "[ -n \"$theme_name\" ] || theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' -printf '%f\\n' | head -n 1 2>/dev/null || true)",
      "if [ -z \"$theme_name\" ]; then",
      "  exit 1",
      "fi",
      "theme_path=/usr/share/themes/$theme_name",
      "mkdir -p /home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml",
      "cat >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml <<EOF",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "",
      "<channel name=\"xsettings\" version=\"1.0\">",
      "  <property name=\"Net\" type=\"empty\">",
      "    <property name=\"ThemeName\" type=\"string\" value=\"$theme_name\"/>",
      "    <property name=\"IconThemeName\" type=\"string\" value=\"Adwaita\"/>",
      "  </property>",
      "</channel>",
      "EOF",
      "cat >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml <<EOF",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "",
      "<channel name=\"xfwm4\" version=\"1.0\">",
      "  <property name=\"general\" type=\"empty\">",
      "    <property name=\"theme\" type=\"string\" value=\"$theme_name\"/>",
      "  </property>",
      "</channel>",
      "EOF",
      "xfconf-query -c xsettings -p /Net/ThemeName -r >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/theme -r >/dev/null 2>&1 || true",
      "xfconf-query -c xsettings -p /Net/ThemeName -n -t string -s \"$theme_name\" >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/theme -n -t string -s \"$theme_name\" >/dev/null 2>&1 || true",
      "xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s Adwaita >/dev/null 2>&1 || true",
      "mkdir -p /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0",
      "printf '%s\\n' '[Settings]' \"gtk-theme-name=$theme_name\" 'gtk-application-prefer-dark-theme=true' >/home/worktoper/.config/gtk-3.0/settings.ini",
      "ln -sfn \"$theme_path/gtk-4.0/assets\" /home/worktoper/.config/gtk-4.0/assets 2>/dev/null || true",
      "ln -sfn \"$theme_path/gtk-4.0/gtk.css\" /home/worktoper/.config/gtk-4.0/gtk.css 2>/dev/null || true",
      "ln -sfn \"$theme_path/gtk-4.0/gtk-dark.css\" /home/worktoper/.config/gtk-4.0/gtk-dark.css 2>/dev/null || true",
      "chown -R worktoper:worktoper /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0 /home/worktoper/.config/xfce4 2>/dev/null || true",
      "pkill -u worktoper -x xfsettingsd >/dev/null 2>&1 || true",
      "nohup xfsettingsd --replace >/tmp/worktoper-xfsettingsd.log 2>&1 &",
      "xfwm4 --replace >/tmp/worktoper-xfwm4-theme.log 2>&1 &",
      "WORKTOPER_APPLY_LAYAN",
      "chmod 0755 /usr/local/sbin/worktoper-install-layan-theme /usr/local/bin/worktoper-apply-layan-theme",
      "cat >/usr/local/bin/worktoper-open-browser <<'WORKTOPER_BROWSER'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "cd /home/worktoper",
      "if ! command -v google-chrome >/dev/null 2>&1; then",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-chrome-install.pid ] && install_pid=$(cat /tmp/worktoper-chrome-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    nohup /usr/local/sbin/worktoper-install-chrome >/tmp/worktoper-install-chrome.log 2>&1 & echo $! >/tmp/worktoper-chrome-install.pid",
      "  fi",
      "  if command -v xterm >/dev/null 2>&1; then",
      "    exec xterm -T 'Installing Chrome' -e sh -lc 'install_pid=$(cat /tmp/worktoper-chrome-install.pid 2>/dev/null || true); while ! command -v google-chrome >/dev/null 2>&1; do clear; echo \"正在安装 Google Chrome，请稍候...\"; echo; tail -n 22 /tmp/worktoper-install-chrome.log 2>/dev/null || true; if [ -n \"$install_pid\" ] && ! kill -0 \"$install_pid\" >/dev/null 2>&1; then break; fi; sleep 3; done; if command -v google-chrome >/dev/null 2>&1; then exec google-chrome --no-sandbox; fi; exec chromium --no-sandbox || exec chromium-browser --no-sandbox'",
      "  fi",
      "fi",
      "exec google-chrome --no-sandbox \"$@\" 2>/tmp/worktoper-chrome.log || exec chromium --no-sandbox \"$@\" 2>/tmp/worktoper-chromium.log || exec chromium-browser --no-sandbox \"$@\" 2>/tmp/worktoper-chromium-browser.log",
      "WORKTOPER_BROWSER",
      "cat >/usr/local/bin/worktoper-open-code <<'WORKTOPER_CODE'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "cd /home/worktoper",
      "if ! command -v code >/dev/null 2>&1; then",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-vscode-install.pid ] && install_pid=$(cat /tmp/worktoper-vscode-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    nohup /usr/local/sbin/worktoper-install-vscode >/tmp/worktoper-install-vscode.log 2>&1 & echo $! >/tmp/worktoper-vscode-install.pid",
      "  fi",
      "  if command -v xterm >/dev/null 2>&1; then",
      "    exec xterm -T 'Installing VS Code' -e sh -lc 'while ! command -v code >/dev/null 2>&1; do clear; echo \"正在安装 Microsoft VS Code，请稍候...\"; echo; tail -n 22 /tmp/worktoper-install-vscode.log 2>/dev/null || true; sleep 3; done; exec code --no-sandbox'",
      "  fi",
      "  while ! command -v code >/dev/null 2>&1; do sleep 3; done",
      "fi",
      "exec code --no-sandbox \"$@\" 2>/tmp/worktoper-code.log",
      "WORKTOPER_CODE",
      "chmod 0755 /usr/local/bin/worktoper-open-browser /usr/local/bin/worktoper-open-code",
      "rm -f /home/worktoper/Desktop/Chrome.desktop /home/worktoper/Desktop/VSCode.desktop /home/worktoper/Desktop/Code.desktop /home/worktoper/Desktop/Codium.desktop /home/worktoper/Desktop/VSCodium.desktop /usr/share/applications/codium.desktop /usr/share/applications/com.vscodium.codium.desktop 2>/dev/null || true",
      "if dpkg-query -W -f='${Status}' codium vscodium code-oss 2>/dev/null | grep -q 'install ok installed'; then",
      "  nohup sh -lc 'DEBIAN_FRONTEND=noninteractive apt-get purge -y codium vscodium code-oss' >/tmp/worktoper-remove-vscodium.log 2>&1 &",
      "fi",
      "if ! command -v code >/dev/null 2>&1; then",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-vscode-install.pid ] && install_pid=$(cat /tmp/worktoper-vscode-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    echo '$ install Microsoft VS Code in background'",
      "    nohup /usr/local/sbin/worktoper-install-vscode >/tmp/worktoper-install-vscode.log 2>&1 & echo $! >/tmp/worktoper-vscode-install.pid",
      "  fi",
      "fi",
      "if ! command -v google-chrome >/dev/null 2>&1; then",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-chrome-install.pid ] && install_pid=$(cat /tmp/worktoper-chrome-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    echo '$ install Google Chrome in background'",
      "    nohup /usr/local/sbin/worktoper-install-chrome >/tmp/worktoper-install-chrome.log 2>&1 & echo $! >/tmp/worktoper-chrome-install.pid",
      "  fi",
      "fi",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=Terminal' 'Exec=xfce4-terminal' 'Icon=utilities-terminal' 'Terminal=false' 'Categories=System;TerminalEmulator;' > /home/worktoper/Desktop/Terminal.desktop",
      "cat >/usr/local/bin/worktoper-trust-desktop-launchers <<'WORKTOPER_TRUST_DESKTOP'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "for file in /home/worktoper/Desktop/*.desktop; do",
      "  [ -f \"$file\" ] || continue",
      "  chmod +x \"$file\" 2>/dev/null || true",
      "  gio set \"$file\" metadata::trusted true >/dev/null 2>&1 || true",
      "  checksum=$(sha256sum \"$file\" 2>/dev/null | awk '{print $1}')",
      "  [ -n \"$checksum\" ] && gio set -t string \"$file\" metadata::xfce-exe-checksum \"$checksum\" >/dev/null 2>&1 || true",
      "done",
      "xfdesktop --reload >/dev/null 2>&1 || true",
      "WORKTOPER_TRUST_DESKTOP",
      "chmod 0755 /usr/local/bin/worktoper-trust-desktop-launchers",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=WorkToper Desktop Trust' 'Exec=/usr/local/bin/worktoper-trust-desktop-launchers' 'OnlyShowIn=XFCE;' 'Terminal=false' 'X-GNOME-Autostart-enabled=true' > /home/worktoper/.config/autostart/worktoper-desktop-trust.desktop",
      "cat >/usr/local/bin/worktoper-keep-display-awake <<'WORKTOPER_KEEP_AWAKE'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "xset s off >/dev/null 2>&1 || true",
      "xset s noblank >/dev/null 2>&1 || true",
      "xset -dpms >/dev/null 2>&1 || true",
      "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/blank-on-ac -n -t int -s 0 >/dev/null 2>&1 || true",
      "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false >/dev/null 2>&1 || true",
      "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/lock-screen-suspend-hibernate -n -t bool -s false >/dev/null 2>&1 || true",
      "WORKTOPER_KEEP_AWAKE",
      "chmod 0755 /usr/local/bin/worktoper-keep-display-awake",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=WorkToper Keep Display Awake' 'Exec=/usr/local/bin/worktoper-keep-display-awake' 'OnlyShowIn=XFCE;' 'Terminal=false' 'X-GNOME-Autostart-enabled=true' > /home/worktoper/.config/autostart/worktoper-keep-display-awake.desktop",
      "nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-keep-display-awake' >/tmp/worktoper-keep-display-awake.log 2>&1 &",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=WorkToper Layan Theme' 'Exec=/usr/local/bin/worktoper-apply-layan-theme' 'OnlyShowIn=XFCE;' 'Terminal=false' 'X-GNOME-Autostart-enabled=true' > /home/worktoper/.config/autostart/worktoper-layan-theme.desktop",
      "if find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' | grep -q .; then",
      "  nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-apply-layan-theme' >/tmp/worktoper-apply-layan-theme.log 2>&1 &",
      "else",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-layan-theme-install.pid ] && install_pid=$(cat /tmp/worktoper-layan-theme-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    echo '$ install Layan GTK theme in background'",
      "    nohup sh -lc '/usr/local/sbin/worktoper-install-layan-theme && runuser -u worktoper -- /usr/local/bin/worktoper-apply-layan-theme' >/tmp/worktoper-install-layan-theme.log 2>&1 & echo $! >/tmp/worktoper-layan-theme-install.pid",
      "  fi",
      "fi",
      "chmod +x /home/worktoper/Desktop/*.desktop 2>/dev/null || true",
      "chown -R worktoper:worktoper /home/worktoper/Desktop /home/worktoper/.config",
      "nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-trust-desktop-launchers' >/tmp/worktoper-desktop-trust.log 2>&1 &",
      "if ! pgrep -u worktoper -x xfce4-session >/dev/null 2>&1; then",
      "  echo '$ startxfce4 (fallback desktop session)'",
      "  runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup dbus-run-session -- startxfce4 >/tmp/worktoper-xfce.log 2>&1 &'",
      "fi",
      "pgrep -u worktoper -x xfce4-panel >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfce4-panel >/tmp/worktoper-xfce-panel.log 2>&1 &'",
      "pgrep -u worktoper -x xfdesktop >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfdesktop >/tmp/worktoper-xfdesktop.log 2>&1 &'",
      "pgrep -u worktoper -x xfwm4 >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfwm4 --replace >/tmp/worktoper-xfwm4.log 2>&1 &'",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `${text}\r\n`)
  }

  async ensureEmbeddedVnc() {
    if (!this.guestAgent || !this.vncTcpPort) return false
    const command = [
      "set -u",
      "if ! command -v x11vnc >/dev/null 2>&1; then",
      "  install_pid=''",
      "  [ -f /tmp/worktoper-x11vnc-install.pid ] && install_pid=$(cat /tmp/worktoper-x11vnc-install.pid 2>/dev/null || true)",
      "  if [ -z \"$install_pid\" ] || ! kill -0 \"$install_pid\" >/dev/null 2>&1; then",
      "    echo '$ install x11vnc in background'",
      "    nohup sh -lc 'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y x11vnc' >/tmp/worktoper-apt-x11vnc.log 2>&1 & echo $! >/tmp/worktoper-x11vnc-install.pid",
      "  else",
      "    echo '$ x11vnc install already running'",
      "  fi",
      "  tail -n 40 /tmp/worktoper-apt-x11vnc.log 2>/dev/null || true",
      "  exit 1",
      "fi",
      "if ! pgrep -a -x x11vnc | grep -F -- '-rfbport 5900' >/dev/null 2>&1; then",
      "  echo '$ x11vnc -display :0 -rfbport 5900'",
      "  pkill -x x11vnc >/dev/null 2>&1 || true",
      "  nohup x11vnc -display :0 -auth /var/run/lightdm/root/:0 -rfbport 5900 -forever -shared -nopw -noxdamage -repeat -cursor arrow -o /tmp/worktoper-x11vnc.log >/tmp/worktoper-x11vnc-start.log 2>&1 &",
      "fi",
      "sleep 1",
      "vnc_ready=0",
      "pgrep -a -x x11vnc | grep -F -- '-rfbport 5900' || vnc_ready=1",
      "tail -n 30 /tmp/worktoper-x11vnc-start.log /tmp/worktoper-x11vnc.log 2>/dev/null || true",
      "exit $vnc_ready",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `${text}\r\n`)
    return status.exitcode === 0
  }

  async logDesktopStartup(attempt) {
    if (!this.guestAgent) return
    const command = [
      `echo '[desktop-check] attempt ${attempt}'`,
      "echo '$ date'",
      "date '+%F %T %Z' || true",
      "echo '$ systemctl is-active lightdm display-manager graphical.target'",
      "systemctl is-active lightdm display-manager graphical.target || true",
      "echo '$ systemctl status lightdm display-manager'",
      "systemctl --no-pager --full status lightdm display-manager 2>/dev/null || true",
      "echo '$ loginctl sessions'",
      "loginctl list-sessions --no-legend 2>/dev/null || true",
      "echo '$ pgrep desktop processes'",
      "pgrep -a -f 'lightdm|xfce4-session|xfdesktop|xfwm4|xfsettingsd|Xorg|Xwayland' || true",
      "echo '$ journalctl lightdm/display-manager/user-session tail'",
      "journalctl -b --no-pager -n 80 -u lightdm -u display-manager -u user@1000.service 2>/dev/null || true",
      "echo '$ lightdm logs'",
      "find /var/log/lightdm -maxdepth 1 -type f -print -exec tail -n 80 {} \\; 2>/dev/null || true",
      "echo '$ Xorg logs'",
      "tail -n 120 /var/log/Xorg.0.log 2>/dev/null || true",
      "echo '$ xsession errors'",
      "tail -n 80 /home/worktoper/.xsession-errors 2>/dev/null || true",
      "echo '$ cloud-init status'",
      "cloud-init status --long 2>/dev/null || true",
    ].join("; ")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (!text || text === this.lastDesktopLog) return
    this.lastDesktopLog = text
    this.send("worktoper:vm:boot", `\r\n[WorkToper] Linux desktop startup status\r\n${text}\r\n`)
  }

  markDesktopReady(source = "desktop ready") {
    if (this.desktopReady) return
    this.desktopReady = true
    this.send("worktoper:vm:boot", `\r\n[WorkToper] Boot 100% - Linux desktop is ready (${source}). Embedded display is active.\r\n`)
    this.update({ phase: "ready", detail: "Linux 桌面已就绪", bootProgress: 100, cpuActive: false, diskActive: false, network: "connected" })
    this.flushPendingLaunches()
    this.resizeDesktop(1920, 1080)
  }

  connectSerial(port) {
    let attempts = 0
    const connect = () => {
      if (!this.process) return
      attempts += 1
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.on("connect", () => {
        this.serial = socket
        this.send("worktoper:vm:boot", "\r\n[WorkToper] Boot console connected. QEMU ttyS0 output is shown here.\r\n")
        this.update({ detail: "串口已连接，等待 Linux systemd/getty 输出", bootProgress: 40 })
      })
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        if (this.shellReady) {
          this.send("worktoper:vm:terminal", text)
        } else {
          this.send("worktoper:vm:boot", text)
        }
        if (/login:/i.test(text)) this.update({ detail: "Linux 登录提示已出现", bootProgress: 82 })
        if (/worktoper@|root@|[$#]\s*$/.test(text)) this.markShellReady(text)
      })
      socket.on("error", () => {
        socket.destroy()
        if (attempts < 80) setTimeout(connect, 250)
      })
      socket.on("close", () => {
        if (this.serial === socket) this.serial = null
      })
    }
    connect()
  }

  markShellReady(promptText = "") {
    if (this.shellReady) {
      this.update({ detail: this.state.phase === "ready" ? "Linux 桌面已就绪" : "Linux shell 可交互，等待图形桌面", bootProgress: Math.max(this.state.bootProgress, 84), cpuActive: this.state.phase !== "ready", diskActive: this.state.phase !== "ready", network: "connected" })
      return
    }
    this.shellReady = true
    this.update({ phase: this.state.phase === "ready" ? "ready" : "loading", detail: "Linux shell 可交互，等待图形桌面", bootProgress: Math.max(this.state.bootProgress, 84), cpuActive: true, diskActive: true, network: "connected" })
    this.send("worktoper:vm:terminal", "\r\n[WorkToper] Linux shell ready. Commands run inside the Debian VM.\r\n")
    if (promptText) this.send("worktoper:vm:terminal", promptText)
    const queued = this.pendingShellWrites.splice(0)
    queued.forEach((data) => this.write(data))
  }

  write(data) {
    if (!this.serial || this.serial.destroyed) return false
    if (!this.shellReady) {
      this.pendingShellWrites.push(data)
      return true
    }
    this.serial.write(data)
    return true
  }

  runLaunchCommand(command) {
    if (this.guestAgent) {
      void this.guestAgent.guestShell(`nohup sh -lc '${command.replaceAll("'", "'\\''")}' >/tmp/worktoper-launch.log 2>&1 &`, { user: "worktoper", captureOutput: false }).catch((error) => {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Linux app launch failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
      })
      return { ok: true }
    }
    if (!this.write(`setsid runuser -u worktoper -- sh -lc '${command.replaceAll("'", "'\\''")}' &\r`)) throw new Error("Linux VM 还不能接收启动命令")
    return { ok: true }
  }

  flushPendingLaunches() {
    if (!this.pendingLaunches.length) return
    const queued = this.pendingLaunches.splice(0)
    queued.forEach((appId) => {
      try {
        this.launch(appId)
      } catch (error) {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Launch ${appId} failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
      }
    })
  }

  launch(appId) {
    const desktopEnv = "export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/1000; [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority; "
    const commands = {
      vscode: `${desktopEnv}worktoper-open-code >/tmp/worktoper-code.log 2>&1`,
      chrome: `${desktopEnv}worktoper-open-browser >/tmp/worktoper-chrome.log 2>&1 || google-chrome --no-sandbox >/tmp/worktoper-chrome.log 2>&1 || chromium --no-sandbox >/tmp/worktoper-chrome.log 2>&1 || chromium-browser --no-sandbox >/tmp/worktoper-chrome.log 2>&1`,
      terminal: `${desktopEnv}xfce4-terminal >/tmp/worktoper-terminal.log 2>&1 || xterm >/tmp/worktoper-terminal.log 2>&1`,
    }
    const command = commands[appId]
    if (!command) throw new Error(`未知 Linux 应用: ${appId}`)
    if (!this.desktopReady) {
      if (!this.pendingLaunches.includes(appId)) this.pendingLaunches.push(appId)
      this.update({ detail: `${appId} 已加入启动队列，等待 Linux 桌面就绪` })
      return { ok: true, queued: true }
    }
    return this.runLaunchCommand(command)
  }

  resizeDesktop(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: false }
    this.pendingDesktopSize = { width: 1920, height: 1080 }
    if (this.desktopReady) this.scheduleDesktopResize()
    return { ok: true }
  }

  scheduleDesktopResize() {
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      void this.applyDesktopResize().catch((error) => {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Resize Linux desktop failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
      })
    }, 300)
  }

  async applyDesktopResize() {
    if (!this.guestAgent || !this.pendingDesktopSize) return
    const { width, height } = this.pendingDesktopSize
    const sizeKey = `${width}x${height}`
    if (this.lastAppliedDesktopSize === sizeKey) return
    const command = [
      "set -u",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "if ! command -v xrandr >/dev/null 2>&1; then exit 0; fi",
      "output=$(xrandr --query | awk '/ connected/{print $1; exit}')",
      "[ -n \"$output\" ] || exit 0",
      `width=${width}`,
      `height=${height}`,
      "target=\"${width}x${height}\"",
      "if xrandr --query | awk '{print $1}' | grep -Fx \"$target\" >/dev/null 2>&1; then",
      "  xrandr --output \"$output\" --mode \"$target\" || xrandr --fb \"$target\" || true",
      "  exit 0",
      "fi",
      "mode=\"${width}x${height}_60.00\"",
      "if ! xrandr --query | awk '{print $1}' | grep -Fx \"$mode\" >/dev/null 2>&1; then",
      "  if command -v cvt >/dev/null 2>&1; then",
      "    modeline=$(cvt \"$width\" \"$height\" 60 | sed -n 's/^Modeline //p' | head -n 1)",
      "    [ -n \"$modeline\" ] && xrandr --newmode $modeline >/dev/null 2>&1 || true",
      "  elif command -v gtf >/dev/null 2>&1; then",
      "    modeline=$(gtf \"$width\" \"$height\" 60 | sed -n 's/^  Modeline //p' | head -n 1)",
      "    [ -n \"$modeline\" ] && xrandr --newmode $modeline >/dev/null 2>&1 || true",
      "  fi",
      "fi",
      "xrandr --addmode \"$output\" \"$mode\" >/dev/null 2>&1 || true",
      "xrandr --output \"$output\" --mode \"$mode\" || xrandr --fb \"$target\" || true",
      "xfdesktop --reload >/dev/null 2>&1 || true",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { user: "worktoper", captureOutput: true })
    if (status.exitcode === 0) this.lastAppliedDesktopSize = sizeKey
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text && status.exitcode !== 0) this.send("worktoper:vm:boot", `\r\n[WorkToper] Resize Linux desktop\r\n${text}\r\n`)
  }

  async lock() {
    if (!this.guestAgent) throw new Error("Linux VM 还没有就绪，无法锁屏")
    const command = [
      "set -u",
      "printf 'worktoper:worktoper\\n' | chpasswd || true",
      "if ! command -v xflock4 >/dev/null 2>&1 && ! command -v xfce4-screensaver-command >/dev/null 2>&1 && ! command -v light-locker-command >/dev/null 2>&1; then",
      "  DEBIAN_FRONTEND=noninteractive apt-get update >/tmp/worktoper-locker-apt.log 2>&1 || true",
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4-screensaver light-locker >>/tmp/worktoper-locker-apt.log 2>&1 || true",
      "fi",
      "runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/1000; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority; xflock4 || xfce4-screensaver-command --lock || light-locker-command -l || dm-tool lock'",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `\r\n[WorkToper] Lock screen\r\n${text}\r\n`)
    if (status.exitcode !== 0) throw new Error("Linux 锁屏失败，请确认 XFCE 会话已启动")
    return { ok: true }
  }

  stop() {
    this.serial?.destroy()
    this.serial = null
    this.guestAgent?.close()
    this.guestAgent = null
    this.vncProxyServer?.close()
    this.vncProxyServer = null
    this.vncTcpPort = 0
    this.sharedDirectory = ""
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = null
    this.pendingDesktopSize = null
    this.lastAppliedDesktopSize = ""
    if (this.process && !this.process.killed) this.process.kill("SIGTERM")
    this.process = null
    this.connection = null
    this.pendingLaunches = []
    this.update({ phase: "idle", detail: "Linux VM 已停止", bootProgress: 0, cpuActive: false, diskActive: false, network: "disconnected" })
  }
}

module.exports = { VmManager }
