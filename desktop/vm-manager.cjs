const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")

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

function getResourcesRoot(app) {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath())
}

function resolveQemuBinary(app, arch = "x64") {
  if (process.env.WORKTOPER_QEMU) return process.env.WORKTOPER_QEMU
  const exe = process.platform === "win32" ? ".exe" : ""
  const qemuName = arch === "arm64" ? `qemu-system-aarch64${exe}` : `qemu-system-x86_64${exe}`
  const resourcesRoot = getResourcesRoot(app)
  const candidates = [
    path.join(resourcesRoot, "runtime", "qemu", process.platform, qemuName),
    path.join(resourcesRoot, "runtime", "qemu", qemuName),
    path.join(app.getAppPath(), "runtime", "qemu", process.platform, qemuName),
    commandExists(qemuName),
  ].filter(Boolean)
  return candidates.find(fileExists) || ""
}

function resolveVmImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_IMAGE) return process.env.WORKTOPER_VM_IMAGE
  const userVmDir = path.join(app.getPath("userData"), "vm")
  const userDisk = path.join(userVmDir, `worktoper-agent-os-${arch}.qcow2`)
  if (fileExists(userDisk)) return userDisk

  const resourcesRoot = getResourcesRoot(app)
  const bundledDisk = path.join(resourcesRoot, "runtime", "images", `worktoper-agent-os-${arch}.qcow2`)
  if (!fileExists(bundledDisk)) return userDisk

  fs.mkdirSync(userVmDir, { recursive: true })
  fs.copyFileSync(bundledDisk, userDisk)
  return userDisk
}

function resolveSeedImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_SEED) return process.env.WORKTOPER_VM_SEED
  const resourcesRoot = getResourcesRoot(app)
  const candidates = [
    path.join(app.getPath("userData"), "vm", `seed-${arch}.iso`),
    path.join(resourcesRoot, "runtime", "images", `seed-${arch}.iso`),
    path.join(app.getAppPath(), "runtime", "images", `seed-${arch}.iso`),
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

function qemuArgs({ disk, seed, serialPort, sshPort, vncDisplay, vncWebSocketPort, memoryMb, cpus }) {
  const args = [
    ...getAccelArgs(),
    "-m", String(memoryMb),
    "-smp", String(cpus),
    "-machine", "q35",
    "-cpu", process.env.WORKTOPER_QEMU_CPU || "max",
    "-display", "none",
    "-monitor", "none",
    "-device", "virtio-vga",
    "-device", "qemu-xhci",
    "-device", "usb-tablet",
    "-device", "usb-kbd",
    "-drive", `file=${disk},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
    "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    "-device", "virtio-net-pci,netdev=net0",
    "-serial", `tcp:127.0.0.1:${serialPort},server=on,wait=off,nodelay=on`,
    "-vnc", `127.0.0.1:${vncDisplay},websocket=${vncWebSocketPort}`,
  ]
  if (seed) args.push("-drive", `file=${seed},format=raw,if=virtio,media=cdrom,readonly=on`)
  return args
}

class VmManager {
  constructor({ app, webContents }) {
    this.app = app
    this.webContents = webContents
    this.process = null
    this.serial = null
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
  }

  async start() {
    if (this.process && !this.process.killed && this.connection) return this.connection

    const arch = process.env.WORKTOPER_VM_ARCH || (process.arch === "arm64" ? "arm64" : "x64")
    const qemu = resolveQemuBinary(this.app, arch)
    const disk = resolveVmImage(this.app, arch)
    const seed = resolveSeedImage(this.app, arch)
    if (!qemu || !fileExists(qemu)) {
      throw new Error("未找到 QEMU。请安装 qemu-system-x86_64，或设置 WORKTOPER_QEMU 指向随应用打包的 QEMU 二进制。")
    }
    if (!fileExists(disk)) {
      throw new Error(`未找到 Linux VM 镜像：${disk}。请先运行 corepack pnpm@10.15.0 vm:prepare，或设置 WORKTOPER_VM_IMAGE。`)
    }

    const [serialPort, sshPort, vncWebSocketPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()])
    const vncDisplay = Number(process.env.WORKTOPER_VNC_DISPLAY || 32)
    const memoryMb = Number(process.env.WORKTOPER_VM_MEMORY || 4096)
    const cpus = Number(process.env.WORKTOPER_VM_CPUS || Math.max(2, Math.min(os.cpus().length, 4)))
    const args = qemuArgs({ disk, seed, serialPort, sshPort, vncDisplay, vncWebSocketPort, memoryMb, cpus })

    this.update({ phase: "loading", detail: "正在启动 QEMU Linux VM", bootProgress: 8, cpuActive: true, diskActive: true })
    this.process = spawn(qemu, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    this.process.stdout.on("data", (chunk) => this.send("worktoper:vm:serial", chunk.toString("utf8")))
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      this.send("worktoper:vm:serial", text)
      if (/error|failed|could not/i.test(text)) this.update({ detail: text.trim().slice(0, 180) })
    })
    this.process.once("exit", (code, signal) => {
      this.serial?.destroy()
      this.serial = null
      this.process = null
      this.connection = null
      this.update({ phase: code === 0 ? "idle" : "error", detail: `Linux VM 已退出: ${signal || code}`, cpuActive: false, diskActive: false, network: "disconnected" })
    })

    this.connection = {
      arch,
      disk,
      seed,
      sshPort,
      serialPort,
      vncWebSocketUrl: `ws://127.0.0.1:${vncWebSocketPort}/`,
    }
    this.connectSerial(serialPort)
    setTimeout(() => this.update({ phase: "ready", detail: "QEMU 已启动，正在通过 VNC 显示 Linux 桌面", bootProgress: 100, network: "connected", diskActive: false }), 1200)
    return this.connection
  }

  connectSerial(port) {
    let attempts = 0
    const connect = () => {
      if (!this.process) return
      attempts += 1
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.on("connect", () => {
        this.serial = socket
        this.send("worktoper:vm:serial", "\r\n[WorkToper] Serial console connected. Boot log is streamed from QEMU ttyS0.\r\n")
        this.update({ detail: "串口已连接，等待 Linux systemd/getty 输出", bootProgress: 40 })
      })
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        this.send("worktoper:vm:serial", text)
        if (/login:/i.test(text)) this.update({ detail: "Linux 登录提示已出现", bootProgress: 82 })
        if (/worktoper@|root@|[$#]\s*$/.test(text)) this.update({ detail: "Linux shell 可交互", bootProgress: 100, phase: "ready", cpuActive: false, diskActive: false, network: "connected" })
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

  write(data) {
    if (!this.serial || this.serial.destroyed) return false
    this.serial.write(data)
    return true
  }

  launch(appId) {
    const commands = {
      vscode: "setsid sh -lc 'DISPLAY=:0 code --no-sandbox >/tmp/worktoper-code.log 2>&1 || codium --no-sandbox >/tmp/worktoper-code.log 2>&1 || code-oss --no-sandbox >/tmp/worktoper-code.log 2>&1' &\r",
      chrome: "setsid sh -lc 'DISPLAY=:0 google-chrome --no-sandbox >/tmp/worktoper-chrome.log 2>&1 || chromium --no-sandbox >/tmp/worktoper-chrome.log 2>&1 || chromium-browser --no-sandbox >/tmp/worktoper-chrome.log 2>&1' &\r",
      terminal: "setsid sh -lc 'DISPLAY=:0 xfce4-terminal >/tmp/worktoper-terminal.log 2>&1 || xterm >/tmp/worktoper-terminal.log 2>&1' &\r",
    }
    const command = commands[appId]
    if (!command) throw new Error(`未知 Linux 应用: ${appId}`)
    if (!this.write(command)) throw new Error("串口尚未连接，Linux VM 还不能接收启动命令")
    return { ok: true }
  }

  stop() {
    this.serial?.destroy()
    this.serial = null
    if (this.process && !this.process.killed) this.process.kill("SIGTERM")
    this.process = null
    this.connection = null
    this.update({ phase: "idle", detail: "Linux VM 已停止", bootProgress: 0, cpuActive: false, diskActive: false, network: "disconnected" })
  }
}

module.exports = { VmManager }
