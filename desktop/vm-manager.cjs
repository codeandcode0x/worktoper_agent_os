const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")

const DEFAULT_VM_DOWNLOAD_KEY = "28112458e7b236b33bf95e8d14999f736a16fac665c9bbffc5ea38fb7574e284"
const DEFAULT_VM_ARCHIVE_VERSION = "v1.0"
const DEFAULT_AGENT_ROBOT_PORT = 8088
const X11VNC_COMMAND = "x11vnc -display :0 -auth /var/run/lightdm/root/:0 -rfbport 5900 -forever -shared -nopw -noxdamage -repeat -cursor arrow -quiet -o /tmp/worktoper-x11vnc.log"

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

function executableExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    if (process.platform === "win32") return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
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

function executableName(command) {
  if (process.platform !== "win32") return command
  return /\.(exe|cmd|bat)$/i.test(command) ? command : `${command}.exe`
}

function qemuOptionValue(value) {
  return String(value).replaceAll(",", ",,")
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
  if (process.platform !== "darwin") return ""
  const name = `worktoper-qga-${process.pid}.sock`
  return path.join(app.getPath("temp") || os.tmpdir(), name)
}

function hasVncHandshake(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(false)
      return
    }
    const socket = net.createConnection({ host: "127.0.0.1", port })
    let settled = false
    let buffer = ""
    const finish = (ready) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on("data", (chunk) => {
      buffer += chunk.toString("ascii")
      if (/^RFB \d{3}\.\d{3}\n/.test(buffer)) finish(true)
    })
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
  })
}

class GuestAgent {
  constructor(socketPath, port = 0) {
    this.socketPath = socketPath
    this.port = port
    this.socket = null
    this.buffer = ""
    this.queue = []
    this.pending = null
  }

  connect() {
    if ((!this.socketPath && !this.port) || this.socket) return
    this.socket = this.port
      ? net.createConnection({ host: "127.0.0.1", port: this.port })
      : net.createConnection(this.socketPath)
    this.socket.on("data", (chunk) => this.onData(chunk))
    this.socket.on("error", () => this.close())
    this.socket.on("close", () => this.close())
  }

  close() {
    const socket = this.socket
    this.socket = null
    socket?.destroy()
    this.buffer = ""
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(new Error("QEMU guest agent disconnected"))
      this.pending = null
    }
    const queued = this.queue.splice(0)
    queued.forEach((item) => {
      clearTimeout(item.timer)
      item.reject(new Error("QEMU guest agent disconnected"))
    })
  }

  isConnected() {
    return Boolean(this.socket && !this.socket.destroyed && this.socket.readyState === "open")
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
    clearTimeout(pending.timer)
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

  execute(command, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("QEMU guest agent is not connected"))
        return
      }
      const item = { command, resolve, reject, timer: null }
      item.timer = setTimeout(() => {
        if (this.pending === item) {
          this.pending = null
          reject(new Error("QEMU guest agent command timed out"))
          this.close()
          return
        }
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new Error("QEMU guest agent command timed out"))
      }, timeoutMs)
      this.queue.push(item)
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

  async guestShell(command, { user = "", captureOutput = true, timeoutMs = 60000 } = {}) {
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
    const attempts = Math.max(1, Math.ceil(timeoutMs / 250))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
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

function runtimeExecutableCandidates(app, group, command) {
  const name = executableName(command)
  const platformArch = `${process.platform}-${process.arch}`
  return getRuntimeRoots(app).flatMap((runtimeRoot) => [
    path.join(runtimeRoot, group, platformArch, name),
    path.join(runtimeRoot, group, process.platform, process.arch, name),
    path.join(runtimeRoot, group, process.platform, name),
    path.join(runtimeRoot, group, name),
  ])
}

function toolCandidates(app, commands, envVar = "") {
  const commandList = Array.isArray(commands) ? commands : [commands]
  const bundledCandidates = commandList.flatMap((command) => runtimeExecutableCandidates(app, "tools", command))
  if (app.isPackaged) return bundledCandidates
  const envCandidate = envVar ? process.env[envVar] : ""
  return [
    envCandidate,
    ...bundledCandidates,
    ...commandList.map((command) => commandExists(executableName(command))),
    ...commandList.map((command) => commandExists(command)),
  ].filter(Boolean)
}

function resolveToolBinary(app, commands, envVar = "") {
  return toolCandidates(app, commands, envVar).find(executableExists) || ""
}

function getQemuName(arch = "x64") {
  const exe = process.platform === "win32" ? ".exe" : ""
  return arch === "arm64" ? `qemu-system-aarch64${exe}` : `qemu-system-x86_64${exe}`
}

function qemuCandidates(app, arch = "x64") {
  const qemuName = getQemuName(arch)
  const bundledCandidates = runtimeExecutableCandidates(app, "qemu", qemuName)
  if (app.isPackaged) return bundledCandidates
  return [
    process.env.WORKTOPER_QEMU,
    ...bundledCandidates,
    ...platformExecutableCandidates(qemuName),
    commandExists(qemuName),
  ].filter(Boolean)
}

function resolveQemuBinary(app, arch = "x64") {
  return qemuCandidates(app, arch).find(executableExists) || ""
}

function resolveQemuDataDirectory(qemu) {
  const directory = path.join(path.dirname(qemu), "share", "qemu")
  return fileExists(directory) ? directory : ""
}

function resolveVmImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_IMAGE) return process.env.WORKTOPER_VM_IMAGE
  const userVmDir = path.join(app.getPath("userData"), "vm")
  const userDisk = path.join(userVmDir, `worktoper-agent-os-${arch}.qcow2`)
  return userDisk
}

function downloadArch(arch = "x64") {
  if (arch === "x64") return "amd64"
  if (arch === "arm64") return "arm64"
  return arch
}

function getVmArchiveVersion() {
  return process.env.WORKTOPER_VM_ARCHIVE_VERSION || DEFAULT_VM_ARCHIVE_VERSION
}

function getVmArchiveBaseName(arch = "x64") {
  return `worktoper_agent_os_${arch}_vm_${getVmArchiveVersion()}`
}

function getLegacyVmArchiveBaseName(arch = "x64") {
  return `worktoper-agent-os-${arch}-vm-${getVmArchiveVersion()}`
}

function getVmArchiveName(arch = "x64") {
  return process.env.WORKTOPER_VM_ARCHIVE_NAME || `${getVmArchiveBaseName(arch)}.tar.xz`
}

function getVmArchiveNameAliases(arch = "x64") {
  const archiveName = getVmArchiveName(arch)
  const aliases = [
    archiveName,
    `${getVmArchiveBaseName(arch)}.tar.xz`,
    `${getLegacyVmArchiveBaseName(arch)}.tar.xz`,
  ]
  return [...new Set(aliases)]
}

function getVmExtractedDirectoryCandidates(extractedDirectory, arch = "x64") {
  return [
    path.join(extractedDirectory, getVmArchiveBaseName(arch)),
    path.join(extractedDirectory, getLegacyVmArchiveBaseName(arch)),
    extractedDirectory,
  ].filter((candidate, index, list) => list.indexOf(candidate) === index)
}

function getVmDownloadUrl(arch = "x64") {
  return process.env.WORKTOPER_VM_DOWNLOAD_URL || `https://www.worktoper.com/worktoper/agent/os/images?arch=${downloadArch(arch)}`
}

function getVmDownloadKey() {
  return process.env.WORKTOPER_VM_DOWNLOAD_KEY || DEFAULT_VM_DOWNLOAD_KEY
}

function findExistingVmArchive(app, arch = "x64") {
  const archiveNames = getVmArchiveNameAliases(arch)
  const userVmDir = path.join(app.getPath("userData"), "vm")
  const candidates = [
    process.env.WORKTOPER_VM_ARCHIVE,
    ...archiveNames.flatMap((archiveName) => [
      path.join(userVmDir, archiveName),
      path.join(process.cwd(), archiveName),
      path.join(getResourcesRoot(app), archiveName),
      path.join(getResourcesRoot(app), "images", archiveName),
    ]),
  ].filter(Boolean)
  return candidates.find(fileExists) || ""
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function downloadFile(url, target, { headers = {}, onProgress } = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Too many VM image download redirects: ${url}`))
      return
    }
    const parsed = new URL(url)
    const client = parsed.protocol === "http:" ? http : https
    const request = client.get(parsed, { headers }, (response) => {
      const statusCode = response.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume()
        downloadFile(new URL(response.headers.location, url).toString(), target, { headers, onProgress }, redirectCount + 1).then(resolve, reject)
        return
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new Error(`VM image download failed: HTTP ${statusCode}`))
        return
      }
      const total = Number(response.headers["content-length"] || 0)
      let received = 0
      let lastProgress = 0
      const output = fs.createWriteStream(target)
      response.on("data", (chunk) => {
        received += chunk.length
        if (!total || received - lastProgress >= 16 * 1024 * 1024 || received === total) {
          lastProgress = received
          onProgress?.({ received, total })
        }
      })
      response.pipe(output)
      output.on("finish", () => output.close(resolve))
      output.on("error", reject)
    })
    request.setTimeout(30000, () => request.destroy(new Error("VM image download timed out")))
    request.on("error", reject)
  })
}

function extractVmArchive(app, archive, targetDirectory, onLog) {
  fs.mkdirSync(targetDirectory, { recursive: true })
  const tar = resolveToolBinary(app, ["tar", "bsdtar"], "WORKTOPER_TAR")
  if (!tar) {
    const searched = toolCandidates(app, ["tar", "bsdtar"], "WORKTOPER_TAR").join(", ")
    throw new Error(`The bundled VM archive tool is missing or not executable. Reinstall the complete WorkToper Agent OS package. Searched: ${searched || "none"}`)
  }
  onLog?.(`[WorkToper] Archive tool: ${tar}`)
  const result = spawnSync(tar, ["-xJf", archive, "-C", targetDirectory], { encoding: "utf8" })
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  if (output) onLog?.(output)
  if (result.status !== 0) {
    throw new Error(`VM image extraction failed. Confirm that tar.xz is supported: ${output || result.error?.message || `exit ${result.status}`}`)
  }
}

function findExtractedFile(root, matcher) {
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (matcher(fullPath, entry.name)) {
        return fullPath
      }
    }
  }
  return ""
}

function findExtractedFileInCandidates(candidates, matcher) {
  for (const candidate of candidates) {
    if (!fileExists(candidate)) continue
    const file = findExtractedFile(candidate, matcher)
    if (file) return file
  }
  return ""
}

function installExtractedVmImage({ extractedDirectory, disk, arch }) {
  const candidates = getVmExtractedDirectoryCandidates(extractedDirectory, arch)
  const expectedName = path.basename(disk)
  const exactDisk = findExtractedFileInCandidates(candidates, (_file, name) => name === expectedName)
  const fallbackDisk = exactDisk || findExtractedFileInCandidates(candidates, (_file, name) => name.endsWith(".qcow2"))
  if (!fallbackDisk) throw new Error("No qcow2 file was found in the VM image archive")
  fs.mkdirSync(path.dirname(disk), { recursive: true })
  fs.renameSync(fallbackDisk, disk)

  const markerName = `worktoper-agent-os-${arch}.initialized`
  const extractedMarker = findExtractedFileInCandidates(candidates, (_file, name) => name === markerName)
  const targetMarker = path.join(path.dirname(disk), markerName)
  if (extractedMarker) {
    fs.renameSync(extractedMarker, targetMarker)
  } else if (!fileExists(targetMarker)) {
    fs.writeFileSync(targetMarker, `downloaded ${new Date().toISOString()}\n`)
  }

  const seedName = `seed-${arch}.iso`
  const extractedSeed = findExtractedFileInCandidates(candidates, (_file, name) => name === seedName)
  if (extractedSeed) fs.renameSync(extractedSeed, path.join(path.dirname(disk), seedName))
}

function resolveSeedImage(app, arch = "x64") {
  if (process.env.WORKTOPER_VM_SEED) return process.env.WORKTOPER_VM_SEED
  const userVmDir = path.join(app.getPath("userData"), "vm")
  const initializedMarker = path.join(userVmDir, `worktoper-agent-os-${arch}.initialized`)
  if (fileExists(initializedMarker)) return ""
  const candidates = [
    path.join(userVmDir, `seed-${arch}.iso`),
    ...getRuntimeRoots(app).map((runtimeRoot) => path.join(runtimeRoot, "images", `seed-${arch}.iso`)),
  ]
  return candidates.find(fileExists) || ""
}

function resolveBackgroundDirectory(app) {
  const candidates = [
    path.join(getResourcesRoot(app), "bg"),
    path.join(getResourcesRoot(app), "images", "bg"),
    path.join(app.getAppPath(), "bg"),
    path.join(app.getAppPath(), "images", "bg"),
  ]
  return candidates.find((candidate) => {
    try {
      if (candidate.includes(".asar")) return false
      if (!fs.statSync(candidate).isDirectory()) return false
      return fs.readdirSync(candidate).some((name) => name.toLowerCase() === "alchemy-5.png")
    } catch {
      return false
    }
  }) || ""
}

function preferredAccelerator() {
  if (process.env.WORKTOPER_QEMU_ACCEL) return process.env.WORKTOPER_QEMU_ACCEL
  if (process.platform === "darwin") return "hvf"
  if (process.platform === "linux") return "kvm"
  if (process.platform === "win32") return "whpx"
  return "tcg"
}

function probeQemuAccelerator(qemu, accelerator, qemuDataDirectory) {
  if (accelerator === "tcg") return { available: true, detail: "" }
  const acceleratorName = accelerator.split(",", 1)[0]
  if (process.platform === "darwin" && acceleratorName === "hvf") {
    const support = spawnSync("/usr/sbin/sysctl", ["-n", "kern.hv_support"], { encoding: "utf8", windowsHide: true })
    if (support.status !== 0 || support.stdout.trim() !== "1") {
      return { available: false, detail: "macOS Hypervisor Framework is unavailable on this host" }
    }
    const signature = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", qemu], { encoding: "utf8", windowsHide: true })
    const entitlements = [signature.stdout, signature.stderr].filter(Boolean).join("\n")
    if (signature.status !== 0 || !/com\.apple\.security\.hypervisor[\s\S]{0,120}(?:true|<true)/i.test(entitlements)) {
      return { available: false, detail: "bundled QEMU is missing com.apple.security.hypervisor entitlement" }
    }
    return { available: true, detail: "" }
  }
  if (process.platform === "linux" && acceleratorName === "kvm") {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK)
      return { available: true, detail: "" }
    } catch {
      return { available: false, detail: "/dev/kvm is unavailable or inaccessible" }
    }
  }
  const args = [
    ...(qemuDataDirectory ? ["-L", qemuDataDirectory] : []),
    "-accel", accelerator,
    "-machine", "q35",
    "-nodefaults",
    "-display", "none",
    "-monitor", "none",
    "-serial", "none",
    "-parallel", "none",
    "-qmp", "stdio",
    "-S",
  ]
  const input = [
    JSON.stringify({ execute: "qmp_capabilities" }),
    JSON.stringify({ execute: "quit" }),
    "",
  ].join("\n")
  const result = spawnSync(qemu, args, {
    encoding: "utf8",
    input,
    timeout: 5000,
    windowsHide: true,
  })
  if (!result.error && result.status === 0) return { available: true, detail: "" }
  const detail = [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /error|failed|could not|not available|permission|entitlement|access/i.test(line))
  return {
    available: false,
    detail: detail || `QEMU exited with status ${result.status ?? "unknown"}`,
  }
}

function resolveQemuAcceleration(qemu, qemuDataDirectory) {
  const preferred = preferredAccelerator()
  const probe = probeQemuAccelerator(qemu, preferred, qemuDataDirectory)
  if (probe.available) {
    return { args: ["-accel", preferred], name: preferred, fallbackReason: "" }
  }
  return { args: ["-accel", "tcg"], name: "tcg", fallbackReason: probe.detail }
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

function getSharedSecurityModel() {
  return process.env.WORKTOPER_SHARED_SECURITY_MODEL || (process.platform === "darwin" ? "mapped-xattr" : process.platform === "win32" ? "none" : "mapped-file")
}

function qemuArgs({ arch, disk, seed, serialPort, sshPort, vncTcpPort, agentRobotPort, memoryMb, cpus, cpuModel, qgaSocketPath, qgaPort, displayArgs, sharedDirectory, backgroundDirectory, qemuDataDirectory, accelArgs }) {
  const hostForwards = [
    `hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    `hostfwd=tcp:127.0.0.1:${vncTcpPort}-:5900`,
    `hostfwd=tcp:127.0.0.1:${agentRobotPort}-:8088`,
  ].join(",")
  const args = [
    ...(qemuDataDirectory ? ["-L", qemuDataDirectory] : []),
    ...accelArgs,
    "-name", "WorkToper Agent OS Linux Desktop",
    "-m", String(memoryMb),
    "-smp", String(cpus),
    "-machine", "q35",
    "-cpu", cpuModel,
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
  } else if (qgaPort) {
    args.push(
      "-chardev", `socket,host=127.0.0.1,port=${qgaPort},server=on,wait=off,id=qga0`,
      "-device", "virtio-serial",
      "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    )
  }
  if (sharedDirectory && fileExists(sharedDirectory)) {
    args.push("-virtfs", `local,path=${qemuOptionValue(sharedDirectory)},mount_tag=worktoper_share,security_model=${getSharedSecurityModel()},id=worktoper_share,multidevs=remap`)
  }
  if (backgroundDirectory) {
    args.push("-virtfs", `local,path=${backgroundDirectory},mount_tag=worktoper_bg,security_model=mapped-xattr,readonly=on,id=worktoper_bg`)
  }
  if (seed) args.push("-drive", `file=${seed},format=raw,if=virtio,media=cdrom,readonly=on`)
  return args
}

function decodeGuestData(value) {
  return value ? Buffer.from(value, "base64").toString("utf8") : ""
}

function waitForProcessExit(child, timeoutMs = 7000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("exit", onExit)
      child.off("close", onExit)
      resolve(value)
    }
    const onExit = () => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    child.once("exit", onExit)
    child.once("close", onExit)
  })
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
    this.desktopStartupTimer = null
    this.vncProbeTimer = null
    this.serialDesktopFallbackTimer = null
    this.serialDesktopFallbackAttempts = 0
    this.guestAgentRetryTimer = null
    this.guestAgentConnecting = null
    this.guestAgentConnectAttempts = 0
    this.guestIntegrationPromise = null
    this.displayRecoveryPromise = null
    this.pendingLaunches = []
    this.vncProxyServer = null
    this.vncTcpPort = 0
    this.sshPort = 0
    this.agentRobotPort = 0
    this.qgaPort = 0
    this.sharedDirectory = ""
    this.pendingDesktopSize = null
    this.resizeTimer = null
    this.lastAppliedDesktopSize = ""
    this.prepareImagePromise = null
    this.state = {
      phase: "idle",
      detail: this.message("Linux VM has not started", "Linux VM 尚未启动"),
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

  message(english, chinese) {
    return this.getSettings?.().language === "zh" ? chinese : english
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    this.send("worktoper:vm:state", this.state)
    this.onState?.(this.state)
  }

  async ensureVmImageAvailable({ arch, disk }) {
    if (fileExists(disk)) return
    if (this.prepareImagePromise) {
      await this.prepareImagePromise
      return
    }

    this.prepareImagePromise = this.downloadAndInstallVmImage({ arch, disk }).finally(() => {
      this.prepareImagePromise = null
    })
    await this.prepareImagePromise
  }

  async downloadAndInstallVmImage({ arch, disk }) {
    const userVmDir = path.dirname(disk)
    const archiveName = getVmArchiveName(arch)
    const cachedArchive = path.join(userVmDir, archiveName)
    const tempArchive = `${cachedArchive}.download`
    const extractDirectory = path.join(userVmDir, `.extract-${process.pid}-${Date.now()}`)
    const existingArchive = findExistingVmArchive(this.app, arch)
    const downloadUrl = getVmDownloadUrl(arch)
    const headers = { "X-WorkToper-Download-Key": getVmDownloadKey() }

    fs.mkdirSync(userVmDir, { recursive: true })
    this.update({ phase: "loading", detail: this.message("Preparing Linux image files", "正在准备 Linux 镜像文件"), bootProgress: 2, diskActive: true, network: "connecting" })
    this.send("worktoper:vm:boot", [
      "\r\n[WorkToper] Linux VM image is missing",
      `[WorkToper] Expected disk: ${disk}`,
      existingArchive ? `[WorkToper] Using local archive: ${existingArchive}` : `[WorkToper] Download: ${downloadUrl}`,
      "",
    ].join("\r\n"))

    try {
      const archive = existingArchive || cachedArchive
      if (!existingArchive) {
        if (fileExists(tempArchive)) fs.rmSync(tempArchive, { force: true })
        let lastPercent = -1
        await downloadFile(downloadUrl, tempArchive, {
          headers,
          onProgress: ({ received, total }) => {
            const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : 0
            if (percent !== lastPercent && (!total || percent % 3 === 0 || percent === 100)) {
              lastPercent = percent
              const detail = total ? this.message(`Downloading Linux image ${percent}% (${formatBytes(received)} / ${formatBytes(total)})`, `正在下载 Linux 镜像 ${percent}% (${formatBytes(received)} / ${formatBytes(total)})`) : this.message(`Downloading Linux image ${formatBytes(received)}`, `正在下载 Linux 镜像 ${formatBytes(received)}`)
              this.update({ phase: "loading", detail, bootProgress: Math.max(3, Math.min(34, Math.floor(percent * 0.32))), diskActive: true, network: "connected" })
              this.send("worktoper:vm:boot", `[WorkToper] ${detail}\r\n`)
            }
          },
        })
        fs.renameSync(tempArchive, cachedArchive)
        this.send("worktoper:vm:boot", `[WorkToper] Downloaded VM archive: ${cachedArchive}\r\n`)
      }

      this.update({ phase: "loading", detail: this.message("Extracting Linux image", "正在解压 Linux 镜像"), bootProgress: 36, diskActive: true, network: "connected" })
      this.send("worktoper:vm:boot", `[WorkToper] Extracting VM archive: ${archive}\r\n`)
      if (fileExists(extractDirectory)) fs.rmSync(extractDirectory, { recursive: true, force: true })
      extractVmArchive(this.app, archive, extractDirectory, (line) => this.send("worktoper:vm:boot", `${line}\r\n`))

      this.update({ phase: "loading", detail: this.message("Installing Linux image", "正在安装 Linux 镜像"), bootProgress: 54, diskActive: true, network: "connected" })
      installExtractedVmImage({ extractedDirectory: extractDirectory, disk, arch })
      if (!fileExists(disk)) throw new Error(this.message(`Linux VM image installation failed: ${disk}`, `Linux VM 镜像安装失败：${disk}`))
      this.send("worktoper:vm:boot", `[WorkToper] Installed VM disk: ${disk}\r\n`)
      this.update({ phase: "loading", detail: this.message("Linux image is ready", "Linux 镜像准备完成"), bootProgress: 62, diskActive: true, network: "connected" })
    } catch (error) {
      try {
        if (fileExists(tempArchive)) fs.rmSync(tempArchive, { force: true })
      } catch {}
      throw error
    } finally {
      try {
        if (fileExists(extractDirectory)) fs.rmSync(extractDirectory, { recursive: true, force: true })
      } catch {}
    }
  }

  async start() {
    if (this.process && !this.process.killed && this.connection) return this.connection

    const arch = process.env.WORKTOPER_VM_ARCH || (process.arch === "arm64" ? "arm64" : "x64")
    const qemu = resolveQemuBinary(this.app, arch)
    const disk = resolveVmImage(this.app, arch)
    if (!qemu || !fileExists(qemu)) {
      const searched = qemuCandidates(this.app, arch).join(", ")
      throw new Error(this.message(`The bundled QEMU ${getQemuName(arch)} is missing or not executable. Reinstall the complete WorkToper Agent OS package. Searched: ${searched || "none"}`, `应用内置 QEMU ${getQemuName(arch)} 缺失或不可执行，请重新安装完整的 WorkToper Agent OS 安装包。已查找：${searched || "无"}`))
    }
    await this.ensureVmImageAvailable({ arch, disk })
    const seed = resolveSeedImage(this.app, arch)
    const diskUserHint = findDiskUserHint(disk)
    if (diskUserHint) {
      throw new Error(this.message(`The VM image is already in use by another QEMU process and cannot be started twice: ${disk}\n${diskUserHint}\nQuit the existing WorkToper Agent OS instance or stop the old QEMU process, then try again.`, `VM 镜像正在被另一个 QEMU 进程使用，不能重复启动：${disk}\n${diskUserHint}\n请先退出旧的 WorkToper Agent OS 或停止旧 QEMU 后再启动。`))
    }

    const agentRobotPort = Number(process.env.WORKTOPER_AGENT_ROBOT_PORT || DEFAULT_AGENT_ROBOT_PORT)
    if (!Number.isInteger(agentRobotPort) || agentRobotPort < 1 || agentRobotPort > 65535) {
      throw new Error(this.message(`Invalid Agent Robot port: ${agentRobotPort}`, `Agent Robot 端口无效：${agentRobotPort}`))
    }
    if (!await portAvailable(agentRobotPort)) {
      throw new Error(this.message(`Agent Robot port ${agentRobotPort} is already in use. Close the application using it and try again.`, `Agent Robot 端口 ${agentRobotPort} 已被占用，请关闭占用该端口的程序后重试。`))
    }
    const [serialPort, sshPort, vncTcpPort, vncWebSocketPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort(), getFreePort()])
    const display = getDisplayConfig({ vncTcpPort, vncWebSocketPort })
    this.vncTcpPort = vncTcpPort
    this.sshPort = sshPort
    this.agentRobotPort = agentRobotPort
    this.vncProxyServer?.close()
    this.vncProxyServer = createVncWebSocketProxy({
      listenPort: vncWebSocketPort,
      targetPort: vncTcpPort,
      onLog: (line) => this.send("worktoper:vm:boot", `${line}\r\n`),
    })
    const qgaSocketPath = getQgaSocketPath(this.app)
    if (qgaSocketPath) fs.rmSync(qgaSocketPath, { force: true })
    const qgaPort = process.platform === "darwin" ? 0 : await getFreePort()
    const settings = this.getSettings?.() || {}
    const memoryMb = Number(process.env.WORKTOPER_VM_MEMORY || settings.memoryMb || 4096)
    const cpus = Number(process.env.WORKTOPER_VM_CPUS || settings.cpus || Math.max(2, Math.min(os.cpus().length, 4)))
    const sharedDirectory = typeof settings.sharedDirectory === "string" && fileExists(settings.sharedDirectory) ? settings.sharedDirectory : ""
    const backgroundDirectory = resolveBackgroundDirectory(this.app)
    const qemuDataDirectory = resolveQemuDataDirectory(qemu)
    const acceleration = resolveQemuAcceleration(qemu, qemuDataDirectory)
    const cpuModel = process.env.WORKTOPER_QEMU_CPU || (acceleration.name === "tcg" ? "max" : "host")
    this.sharedDirectory = sharedDirectory
    const args = qemuArgs({ arch, disk, seed, serialPort, sshPort, vncTcpPort, agentRobotPort, memoryMb, cpus, cpuModel, qgaSocketPath, qgaPort, displayArgs: display.args, sharedDirectory, backgroundDirectory, qemuDataDirectory, accelArgs: acceleration.args })

    this.update({ phase: "loading", detail: this.message("Starting the Linux system", "正在启动 Linux 系统"), bootProgress: 8, cpuActive: true, diskActive: true })
    this.lastErrorDetail = ""
    this.send("worktoper:vm:boot", `${[
      `\r\n[WorkToper] ${this.message("Preparing Smart Desktop", "正在准备 Smart Desktop")}`,
      `[WorkToper] ${this.message("Loading the system environment", "正在载入系统环境")}`,
      `[WorkToper] ${this.message("Initializing desktop services", "正在初始化桌面服务")}`,
    ].join("\r\n")}\r\n`)
    this.process = spawn(qemu, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const qemuProcess = this.process
    this.shellReady = false
    this.pendingShellWrites = []
    this.desktopReady = false
    this.lastDesktopLog = ""
    this.desktopRepairAttempted = false
    this.serialDesktopFallbackAttempts = 0
    this.guestAgentConnectAttempts = 0
    this.guestIntegrationPromise = null
    this.clearDesktopStartupTimers()
    this.clearGuestAgentRetry()
    qemuProcess.stdout.on("data", (chunk) => this.send("worktoper:vm:boot", chunk.toString("utf8")))
    qemuProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      if (/Failed to get "write" lock|Is another process using the image/i.test(text)) {
        this.lastErrorDetail = this.message(`The VM image is already in use by another QEMU process: ${disk}. Quit the existing WorkToper Agent OS instance or stop the old QEMU process.`, `VM 镜像正在被另一个 QEMU 进程使用：${disk}。请先退出旧的 WorkToper Agent OS 或停止旧 QEMU。`)
        this.update({ phase: "error", detail: this.lastErrorDetail, cpuActive: false, diskActive: false, network: "disconnected" })
        return
      }
      if (/error|failed|could not/i.test(text)) this.update({ detail: text.trim().slice(0, 180) })
    })
    qemuProcess.once("exit", (code, signal) => {
      if (this.process !== qemuProcess) return
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
      this.serialDesktopFallbackAttempts = 0
      this.guestIntegrationPromise = null
      this.clearDesktopStartupTimers()
      this.clearGuestAgentRetry()
      this.pendingLaunches = []
      this.vncProxyServer?.close()
      this.vncProxyServer = null
      this.vncTcpPort = 0
      this.sshPort = 0
      this.agentRobotPort = 0
      this.qgaPort = 0
      this.update({ phase: code === 0 ? "idle" : "error", detail: this.lastErrorDetail || this.message(`Linux VM exited: ${signal || code}`, `Linux VM 已退出: ${signal || code}`), cpuActive: false, diskActive: false, network: "disconnected" })
    })

    this.connection = {
      arch,
      disk,
      seed,
      sshPort,
      serialPort,
      agentRobotPort,
      agentRobotUrl: `http://127.0.0.1:${agentRobotPort}`,
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
    this.qgaPort = qgaPort
    this.connectGuestAgent(qgaSocketPath, qgaPort)
    this.waitForHostDesktopReady()
    setTimeout(() => {
      if (this.process && this.state.phase !== "ready") this.update({ phase: "loading", detail: this.message("QEMU started. Waiting for the Linux desktop.", "QEMU 已启动，正在等待 Linux 桌面完成启动"), bootProgress: Math.max(this.state.bootProgress, 68), network: "connecting", diskActive: true })
    }, 1200)
    return this.connection
  }

  connectGuestAgent(socketPath, port = 0, delayMs = 1200) {
    if ((!socketPath && !port) || !this.process || this.state.phase === "error" || this.guestAgent || this.guestAgentConnecting || this.guestAgentRetryTimer) return
    this.guestAgentRetryTimer = setTimeout(async () => {
      this.guestAgentRetryTimer = null
      if (!this.process || this.guestAgent || this.guestAgentConnecting) return
      this.guestAgentConnectAttempts += 1
      const agent = new GuestAgent(socketPath, port)
      this.guestAgentConnecting = agent
      agent.connect()
      try {
        await agent.execute({ execute: "guest-ping" }, 2000)
        if (!this.process || this.guestAgentConnecting !== agent) {
          agent.close()
          return
        }
        this.guestAgentConnecting = null
        this.guestAgentConnectAttempts = 0
        this.guestAgent = agent
        this.update({ detail: this.message("QEMU Guest Agent connected. Detecting the Linux desktop.", "QEMU Guest Agent 已连接，正在检测 Linux 桌面"), bootProgress: Math.max(this.state.bootProgress, 72), network: "connected" })
        if (this.desktopReady) {
          void this.finishGuestIntegration()
        } else {
          this.waitForDesktopReady()
        }
      } catch {
        if (this.guestAgentConnecting === agent) this.guestAgentConnecting = null
        agent.close()
        if (!this.process || this.state.phase === "error" || this.guestAgent) return
        if (this.guestAgentConnectAttempts === 120) {
          this.send("worktoper:vm:boot", `\r\n[WorkToper] ${this.message("Guest Agent did not connect; continuing with the Linux display fallback.", "Guest Agent 未连接，继续使用 Linux 显示兜底通道。")}\r\n`)
        }
        const retryDelay = this.guestAgentConnectAttempts < 120 ? 500 : 5000
        this.connectGuestAgent(socketPath, port, retryDelay)
      }
    }, delayMs)
  }

  clearGuestAgentRetry() {
    if (this.guestAgentRetryTimer) clearTimeout(this.guestAgentRetryTimer)
    this.guestAgentRetryTimer = null
    this.guestAgentConnecting?.close()
    this.guestAgentConnecting = null
  }

  clearDesktopStartupTimers() {
    if (this.desktopStartupTimer) clearTimeout(this.desktopStartupTimer)
    if (this.vncProbeTimer) clearTimeout(this.vncProbeTimer)
    if (this.serialDesktopFallbackTimer) clearTimeout(this.serialDesktopFallbackTimer)
    this.desktopStartupTimer = null
    this.vncProbeTimer = null
    this.serialDesktopFallbackTimer = null
  }

  waitForHostDesktopReady() {
    const configuredTimeoutMs = Number(process.env.WORKTOPER_DESKTOP_START_TIMEOUT_MS || 180000)
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 180000
    const startedAt = Date.now()
    const qemuProcess = this.process
    const vncTcpPort = this.vncTcpPort
    const check = async () => {
      if (!this.process || this.process !== qemuProcess || this.desktopReady) return
      if (this.state.phase === "error") return
      if (await hasVncHandshake(vncTcpPort)) {
        if (this.process !== qemuProcess || this.desktopReady || this.state.phase === "error") return
        this.markDesktopReady("host VNC readiness probe")
        if (this.guestAgent) void this.finishGuestIntegration()
        return
      }
      if (this.process !== qemuProcess || this.desktopReady || this.state.phase === "error") return
      if (Date.now() - startedAt >= timeoutMs) {
        this.clearDesktopStartupTimers()
        this.clearGuestAgentRetry()
        this.update({
          phase: "error",
          detail: this.message("Linux desktop startup timed out. Check the boot log for Guest Agent, LightDM, or x11vnc errors.", "Linux 桌面启动超时，请在启动日志中检查 Guest Agent、LightDM 或 x11vnc 错误。"),
          cpuActive: false,
          diskActive: false,
          network: this.shellReady ? "connected" : "connecting",
        })
        return
      }
      this.vncProbeTimer = setTimeout(check, 1000)
    }
    this.desktopStartupTimer = setTimeout(() => {
      if (!this.process || this.process !== qemuProcess || this.desktopReady) return
      this.send("worktoper:vm:boot", `\r\n[WorkToper] ${this.message("Desktop startup is taking longer than expected; recovery checks are still running.", "桌面启动时间较长，恢复检查仍在继续。")}\r\n`)
    }, Math.min(60000, Math.max(15000, Math.floor(timeoutMs / 2))))
    void check()
  }

  startSerialDesktopFallback() {
    if (!this.process || !this.serial || this.serial.destroyed || this.desktopReady || this.guestAgent?.isConnected()) return
    this.serialDesktopFallbackAttempts += 1
    const command = `if command -v x11vnc >/dev/null 2>&1 && ! pgrep -a -x x11vnc | grep -F -- '-rfbport 5900' >/dev/null 2>&1 && [ ! -e /tmp/worktoper-x11vnc-fallback.pending ]; then touch /tmp/worktoper-x11vnc-fallback.pending; nohup sh -lc 'trap "rm -f /tmp/worktoper-x11vnc-fallback.pending" EXIT; for attempt in $(seq 1 45); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 1; done; [ -S /tmp/.X11-unix/X0 ] || exit 1; ${X11VNC_COMMAND}' >/tmp/worktoper-x11vnc-start.log 2>&1 & fi`
    this.serial.write(`${command}\r`)
    if (this.serialDesktopFallbackAttempts < 24) {
      this.serialDesktopFallbackTimer = setTimeout(() => this.startSerialDesktopFallback(), 5000)
    }
  }

  finishGuestIntegration() {
    if (!this.guestAgent) return Promise.resolve(false)
    if (this.guestIntegrationPromise) return this.guestIntegrationPromise
    const agent = this.guestAgent
    const integration = (async () => {
      try {
        await this.ensureDisplayAwake()
        const sharedDirectoryReady = await this.ensureSharedDirectory()
        if (!sharedDirectoryReady && this.sharedDirectory) return false
        this.resizeDesktop(1920, 1080)
        return true
      } catch (error) {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Guest integration failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (this.guestAgent === agent && !agent.isConnected()) {
          this.guestAgent = null
          agent.close()
          this.startSerialDesktopFallback()
          this.connectGuestAgent(this.connection?.qgaSocketPath || "", this.qgaPort, 250)
        }
        return false
      } finally {
        this.guestIntegrationPromise = null
      }
    })()
    this.guestIntegrationPromise = integration
    return integration
  }

  waitForDesktopReady() {
    let attempts = 0
    const check = async () => {
      if (!this.process || !this.guestAgent || this.desktopReady || this.state.phase === "error") return
      attempts += 1
      try {
        const status = await this.guestAgent.guestShell("(systemctl is-active --quiet lightdm || systemctl is-active --quiet display-manager) && pgrep -u worktoper -x xfce4-session >/dev/null && pgrep -u worktoper -x xfce4-panel >/dev/null && pgrep -u worktoper -x xfdesktop >/dev/null && pgrep -u worktoper -x xfwm4 >/dev/null && pgrep -f 'Xorg|Xwayland' >/dev/null", { captureOutput: true })
        if (status.exitcode === 0) {
          const vncReady = await this.ensureEmbeddedVnc()
          if (vncReady) {
            await this.ensureDisplayAwake()
            await this.ensureSharedDirectory()
            this.markDesktopReady("lightdm / XFCE / x11vnc readiness check")
            return
          }
          this.update({ phase: "loading", detail: this.message("XFCE started. Preparing the embedded desktop display.", "XFCE 已启动，正在准备内嵌桌面画面"), bootProgress: Math.max(this.state.bootProgress, 96), network: "connected" })
        } else if (attempts <= 6 || attempts % 8 === 0) {
          if (attempts === 1) await this.repairDesktopRuntime()
          await this.ensureDesktopSession()
        }
        if (attempts <= 6 || attempts % 8 === 0) await this.logDesktopStartup(attempts)
      } catch (error) {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Desktop readiness check failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (this.guestAgent && !this.guestAgent.isConnected()) {
          const agent = this.guestAgent
          this.guestAgent = null
          agent.close()
          this.startSerialDesktopFallback()
          this.connectGuestAgent(this.connection?.qgaSocketPath || "", this.qgaPort, 250)
          return
        }
      }
      if (attempts < 240) {
        const progress = Math.min(98, 72 + Math.floor(attempts / 4))
        this.update({ phase: "loading", detail: this.message("Linux desktop is still starting. Waiting for lightdm / XFCE.", "Linux 桌面仍在启动，等待 lightdm / XFCE"), bootProgress: Math.max(this.state.bootProgress, progress), network: "connected" })
        setTimeout(check, 1000)
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

  sharedDirectoryGuestCommands() {
    if (this.sharedDirectory) {
      return [
      "install -d -m 0755 -o worktoper -g worktoper /home/worktoper/Shared",
      "install -d -m 0755 -o worktoper -g worktoper /home/worktoper/Desktop",
      "if ! modprobe 9pnet_virtio >/dev/null 2>&1 || ! modprobe 9p >/dev/null 2>&1; then",
      "  echo '[WorkToper] Guest kernel does not support virtio 9p shared directories' >&2",
      "  echo \"[WorkToper] Guest kernel: $(uname -r)\" >&2",
      "  grep -E 'CONFIG_(NET_9P|NET_9P_VIRTIO|9P_FS)=' /boot/config-\"$(uname -r)\" 2>/dev/null >&2 || true",
      "  exit 32",
      "fi",
      "if mountpoint -q /home/worktoper/Shared >/dev/null 2>&1 && ! findmnt -n -o SOURCE /home/worktoper/Shared 2>/dev/null | grep -Fx worktoper_share >/dev/null 2>&1; then",
      "  umount /home/worktoper/Shared >/dev/null 2>&1 || true",
      "fi",
      "if mountpoint -q /home/worktoper/Shared >/dev/null 2>&1 && findmnt -n -o OPTIONS /home/worktoper/Shared 2>/dev/null | grep -Eq '(^|,)loose(,|$)|(^|,)cache=loose(,|$)'; then",
      "  echo '$ remount shared directory without loose cache'",
      "  umount /home/worktoper/Shared >/dev/null 2>&1 || true",
      "fi",
      "if ! mountpoint -q /home/worktoper/Shared >/dev/null 2>&1; then",
      "  echo '$ mount shared directory at /home/worktoper/Shared'",
      "  mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144,cache=none,access=any,dfltuid=1000,dfltgid=1000 worktoper_share /home/worktoper/Shared || mount -t 9p -o trans=virtio,version=9p2000.L,cache=none,access=any,dfltuid=1000,dfltgid=1000 worktoper_share /home/worktoper/Shared || mount -t 9p -o trans=virtio,version=9p2000.L,access=client worktoper_share /home/worktoper/Shared || { echo '[WorkToper] Shared directory mount failed'; dmesg | tail -n 30 || true; exit 1; }",
      "fi",
      "if mountpoint -q /home/worktoper/Shared >/dev/null 2>&1; then",
      "  echo '[WorkToper] Shared directory mounted at /home/worktoper/Shared'",
      "  findmnt -n -o SOURCE,TARGET,FSTYPE,OPTIONS /home/worktoper/Shared || true",
      "  chown worktoper:worktoper /home/worktoper/Shared >/dev/null 2>&1 || true",
      "  chmod 0775 /home/worktoper/Shared >/dev/null 2>&1 || true",
      "  if runuser -u worktoper -- sh -lc 'test_file=/home/worktoper/Shared/.worktoper-write-test-$$; printf ok >\"$test_file\" && rm -f \"$test_file\"'; then",
      "    echo '[WorkToper] Shared directory write test passed'",
      "  else",
      "    echo '[WorkToper] Shared directory is mounted but not writable by worktoper user' >&2",
      "    exit 33",
      "  fi",
      "fi",
      "cat >/usr/local/bin/worktoper-share-permissions <<'WORKTOPER_SHARE_PERMISSIONS'",
      "#!/bin/sh",
      "set -u",
      "share=/home/worktoper/Shared",
      "while mountpoint -q \"$share\" >/dev/null 2>&1; do",
      "  find \"$share\" -xdev \\( ! -user worktoper -o ! -group worktoper \\) -exec chown worktoper:worktoper {} + >/dev/null 2>&1 || true",
      "  find \"$share\" -xdev -type d ! -perm -0775 -exec chmod u+rwx,g+rwx {} + >/dev/null 2>&1 || true",
      "  find \"$share\" -xdev -type f ! -perm -0664 -exec chmod u+rw,g+rw {} + >/dev/null 2>&1 || true",
      "  sleep 1",
      "done",
      "WORKTOPER_SHARE_PERMISSIONS",
      "chmod 0755 /usr/local/bin/worktoper-share-permissions",
      "if ! pgrep -f '/usr/local/bin/worktoper-share-permissions' >/dev/null 2>&1; then nohup /usr/local/bin/worktoper-share-permissions >/tmp/worktoper-share-permissions.log 2>&1 & fi",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=Shared' 'Exec=exo-open --launch FileManager /home/worktoper/Shared' 'Icon=folder' 'Terminal=false' 'Categories=Utility;' > /home/worktoper/Desktop/Shared.desktop",
      "chmod 0755 /home/worktoper/Desktop/Shared.desktop",
      "chown worktoper:worktoper /home/worktoper/Desktop/Shared.desktop",
      "if [ -e /home/worktoper/Desktop/Share ] && [ ! -L /home/worktoper/Desktop/Share ]; then rm -rf /home/worktoper/Desktop/Share; fi",
      "if [ -e /home/worktoper/Desktop/Shared ] && [ ! -L /home/worktoper/Desktop/Shared ]; then rm -rf /home/worktoper/Desktop/Shared; fi",
      "ln -sfn /home/worktoper/Shared /home/worktoper/Desktop/Shared",
      "chown -h worktoper:worktoper /home/worktoper/Desktop/Shared 2>/dev/null || true",
      "install -d -m 0700 -o worktoper -g worktoper /home/worktoper/.config/gtk-3.0",
      "grep -Fx 'file:///home/worktoper/Shared Shared' /home/worktoper/.config/gtk-3.0/bookmarks >/dev/null 2>&1 || printf '%s\\n' 'file:///home/worktoper/Shared Shared' >>/home/worktoper/.config/gtk-3.0/bookmarks",
      "chown worktoper:worktoper /home/worktoper/.config/gtk-3.0/bookmarks 2>/dev/null || true",
    ]
    }
    return [
      "if mountpoint -q /home/worktoper/Shared >/dev/null 2>&1; then umount /home/worktoper/Shared >/dev/null 2>&1 || true; fi",
      "rm -f /home/worktoper/Desktop/Shared.desktop 2>/dev/null || true",
      "rm -rf /home/worktoper/Desktop/Shared /home/worktoper/Desktop/Share 2>/dev/null || true",
      "if [ -f /home/worktoper/.config/gtk-3.0/bookmarks ]; then grep -Fxv 'file:///home/worktoper/Shared Shared' /home/worktoper/.config/gtk-3.0/bookmarks >/tmp/worktoper-bookmarks && cat /tmp/worktoper-bookmarks >/home/worktoper/.config/gtk-3.0/bookmarks; fi",
    ]
  }

  async ensureSharedDirectory() {
    if (!this.guestAgent) return false
    const command = [
      "set -u",
      "export DISPLAY=:0",
      "export XAUTHORITY=/home/worktoper/.Xauthority",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "mkdir -p /run/user/1000",
      "chown worktoper:worktoper /run/user/1000 2>/dev/null || true",
      "chmod 0700 /run/user/1000 2>/dev/null || true",
      ...this.sharedDirectoryGuestCommands(),
      "runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; xfdesktop --reload >/dev/null 2>&1 || true'",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `\r\n[WorkToper] Shared directory setup\r\n${text}\r\n`)
    if (this.sharedDirectory && status.exitcode !== 0) {
      const unsupportedKernel = /Guest kernel does not support virtio 9p shared directories/i.test(text)
      const notWritable = /Shared directory is mounted but not writable by worktoper user/i.test(text)
      this.update({
        detail: unsupportedKernel
          ? this.message("The current VM image kernel does not support directory sharing. Update or download the VM image again.", "当前 VM 镜像内核不支持目录共享，请更新或重新下载 VM 镜像")
          : notWritable
            ? this.message("The shared directory is mounted, but the host directory is not writable. Check its permissions.", "共享目录已挂载，但当前宿主机目录不可写，请检查目录权限")
            : this.message("Failed to mount the shared directory. Check host directory permissions and boot logs.", "共享目录挂载失败，请检查宿主机目录权限和启动日志"),
        diskActive: false,
      })
      return false
    }
    return true
  }

  displayAwakeGuestCommands() {
    return [
      "cat >/usr/local/bin/worktoper-keep-display-awake <<'WORKTOPER_KEEP_AWAKE'",
      "#!/bin/sh",
      "set -u",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "set_xfconf() {",
      "  channel=$1",
      "  property=$2",
      "  type=$3",
      "  value=$4",
      "  xfconf-query -c \"$channel\" -p \"$property\" -s \"$value\" >/dev/null 2>&1 || xfconf-query -c \"$channel\" -p \"$property\" -n -t \"$type\" -s \"$value\" >/dev/null 2>&1 || true",
      "}",
      "apply_display_policy() {",
      "  xset dpms force on >/dev/null 2>&1 || true",
      "  xset s reset >/dev/null 2>&1 || true",
      "  xset s 0 0 >/dev/null 2>&1 || true",
      "  xset s off >/dev/null 2>&1 || true",
      "  xset s noblank >/dev/null 2>&1 || true",
      "  xset -dpms >/dev/null 2>&1 || true",
      "  set_xfconf xfce4-power-manager /xfce4-power-manager/blank-on-ac int 0",
      "  set_xfconf xfce4-power-manager /xfce4-power-manager/inactivity-on-ac int 0",
      "  set_xfconf xfce4-power-manager /xfce4-power-manager/dpms-enabled bool false",
      "  set_xfconf xfce4-power-manager /xfce4-power-manager/lock-screen-suspend-hibernate bool false",
      "  set_xfconf xfce4-screensaver /saver/enabled bool false",
      "  set_xfconf xfce4-screensaver /saver/idle-activation/enabled bool false",
      "  set_xfconf xfce4-screensaver /lock/enabled bool false",
      "  xfce4-screensaver-command --deactivate >/dev/null 2>&1 || true",
      "  light-locker-command -d >/dev/null 2>&1 || true",
      "}",
      "if [ \"${1:-}\" = --once ]; then",
      "  apply_display_policy",
      "  exit 0",
      "fi",
      "pidfile=$XDG_RUNTIME_DIR/worktoper-keep-display-awake.pid",
      "if [ -s \"$pidfile\" ]; then",
      "  old_pid=$(cat \"$pidfile\" 2>/dev/null || true)",
      "  [ -z \"$old_pid\" ] || ! kill -0 \"$old_pid\" >/dev/null 2>&1 || exit 0",
      "fi",
      "printf '%s\\n' \"$$\" >\"$pidfile\"",
      "trap 'rm -f \"$pidfile\"' EXIT INT TERM",
      "while :; do",
      "  apply_display_policy",
      "  sleep 45",
      "done",
      "WORKTOPER_KEEP_AWAKE",
      "chmod 0755 /usr/local/bin/worktoper-keep-display-awake",
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=WorkToper Keep Display Awake' 'Exec=/usr/local/bin/worktoper-keep-display-awake' 'OnlyShowIn=XFCE;' 'Terminal=false' 'X-GNOME-Autostart-enabled=true' > /home/worktoper/.config/autostart/worktoper-keep-display-awake.desktop",
      "chown -R worktoper:worktoper /home/worktoper/.config/autostart",
      "runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-keep-display-awake --once'",
      "nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-keep-display-awake' >/tmp/worktoper-keep-display-awake.log 2>&1 &",
    ]
  }

  async ensureDisplayAwake() {
    if (!this.guestAgent) return false
    const command = [
      "set -u",
      "install -d -m 0700 -o worktoper -g worktoper /run/user/1000",
      "install -d -m 0700 -o worktoper -g worktoper /home/worktoper/.config/autostart",
      ...this.displayAwakeGuestCommands(),
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text && status.exitcode !== 0) this.send("worktoper:vm:boot", `\r\n[WorkToper] Display wake recovery\r\n${text}\r\n`)
    return status.exitcode === 0
  }

  async waitForVncHandshake(timeoutMs = 10000) {
    const startedAt = Date.now()
    while (this.process && Date.now() - startedAt < timeoutMs) {
      if (await hasVncHandshake(this.vncTcpPort, 800)) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  wakeDisplay(forceRestart = false) {
    if (this.displayRecoveryPromise) return this.displayRecoveryPromise
    this.displayRecoveryPromise = this.recoverDisplay(forceRestart).finally(() => {
      this.displayRecoveryPromise = null
    })
    return this.displayRecoveryPromise
  }

  async recoverDisplay(forceRestart = false) {
    if (!this.process) return { ok: false }
    let recovered = false
    if (this.guestAgent?.isConnected()) {
      try {
        await this.ensureDisplayAwake()
        if (!forceRestart) return { ok: true }
        if (forceRestart) {
          recovered = await this.ensureEmbeddedVnc({ restart: true })
          if (recovered) recovered = await this.waitForVncHandshake(8000)
        }
      } catch (error) {
        this.send("worktoper:vm:boot", `\r\n[WorkToper] Display recovery through Guest Agent failed: ${error instanceof Error ? error.message : String(error)}\r\n`)
        if (this.guestAgent && !this.guestAgent.isConnected()) {
          const agent = this.guestAgent
          this.guestAgent = null
          agent.close()
          this.connectGuestAgent(this.connection?.qgaSocketPath || "", this.qgaPort, 250)
        }
      }
    }
    if (!recovered && this.serial && !this.serial.destroyed && this.shellReady) {
      const desktopEnvironment = "export DISPLAY=:0 XAUTHORITY=/home/worktoper/.Xauthority XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"
      const restartVnc = forceRestart ? `pkill -x x11vnc >/dev/null 2>&1 || true; for attempt in $(seq 1 20); do ! pgrep -x x11vnc >/dev/null 2>&1 && break; sleep 0.1; done; pgrep -x x11vnc >/dev/null 2>&1 && pkill -KILL -x x11vnc >/dev/null 2>&1 || true; nohup ${X11VNC_COMMAND} >/tmp/worktoper-x11vnc-start.log 2>&1 &` : ""
      this.write(`runuser -u worktoper -- sh -lc '${desktopEnvironment}; xset dpms force on >/dev/null 2>&1 || true; xset s reset >/dev/null 2>&1 || true; xset -dpms >/dev/null 2>&1 || true'; ${restartVnc}\r`)
      if (!forceRestart) return { ok: true }
      recovered = await this.waitForVncHandshake(10000)
    }
    return { ok: recovered }
  }

  async ensureDesktopSession() {
    if (!this.guestAgent) return
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
      ...this.sharedDirectoryGuestCommands(),
      "mkdir -p /usr/share/backgrounds/worktoper /usr/share/xfce4/backdrops /mnt/worktoper-bg",
      "mountpoint -q /mnt/worktoper-bg || mount -t 9p -o trans=virtio,version=9p2000.L,ro worktoper_bg /mnt/worktoper-bg >/dev/null 2>&1 || true",
      "for file in /mnt/worktoper-bg/* /var/lib/cloud/seed/nocloud/backgrounds/* /var/lib/cloud/seed/nocloud-net/backgrounds/* /media/cidata/backgrounds/*; do [ -f \"$file\" ] || continue; case \"$file\" in *.jpg|*.jpeg|*.png|*.webp|*.JPG|*.JPEG|*.PNG|*.WEBP) cp -f \"$file\" /usr/share/backgrounds/worktoper/ ;; esac; done",
      "for file in /usr/share/backgrounds/worktoper/*; do [ -f \"$file\" ] || continue; chmod 0644 \"$file\" 2>/dev/null || true; ln -sfn \"$file\" \"/usr/share/xfce4/backdrops/$(basename \"$file\")\" 2>/dev/null || true; done",
      "cat >/usr/local/bin/worktoper-configure-xfce-panel <<'WORKTOPER_XFCE_PANEL'",
      "#!/bin/sh",
      "set -eu",
      "target=/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml",
      "mkdir -p \"$target\"",
      "cat >\"$target/xfce4-panel.xml\" <<'EOF'",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "",
      "<channel name=\"xfce4-panel\" version=\"1.0\">",
      "  <property name=\"configver\" type=\"int\" value=\"2\"/>",
      "  <property name=\"panels\" type=\"array\">",
      "    <value type=\"int\" value=\"1\"/>",
      "    <property name=\"panel-1\" type=\"empty\">",
      "      <property name=\"position\" type=\"string\" value=\"p=10;x=0;y=0\"/>",
      "      <property name=\"length\" type=\"uint\" value=\"100\"/>",
      "      <property name=\"position-locked\" type=\"bool\" value=\"true\"/>",
      "      <property name=\"size\" type=\"uint\" value=\"32\"/>",
      "      <property name=\"plugin-ids\" type=\"array\">",
      "        <value type=\"int\" value=\"1\"/>",
      "        <value type=\"int\" value=\"2\"/>",
      "        <value type=\"int\" value=\"3\"/>",
      "        <value type=\"int\" value=\"4\"/>",
      "        <value type=\"int\" value=\"5\"/>",
      "        <value type=\"int\" value=\"6\"/>",
      "      </property>",
      "    </property>",
      "  </property>",
      "  <property name=\"plugins\" type=\"empty\">",
      "    <property name=\"plugin-1\" type=\"string\" value=\"applicationsmenu\"/>",
      "    <property name=\"plugin-2\" type=\"string\" value=\"tasklist\"/>",
      "    <property name=\"plugin-3\" type=\"string\" value=\"separator\">",
      "      <property name=\"expand\" type=\"bool\" value=\"true\"/>",
      "      <property name=\"style\" type=\"uint\" value=\"0\"/>",
      "    </property>",
      "    <property name=\"plugin-4\" type=\"string\" value=\"pager\"/>",
      "    <property name=\"plugin-5\" type=\"string\" value=\"clock\"/>",
      "    <property name=\"plugin-6\" type=\"string\" value=\"actions\"/>",
      "  </property>",
      "</channel>",
      "EOF",
      "chown -R worktoper:worktoper /home/worktoper/.config/xfce4 2>/dev/null || true",
      "WORKTOPER_XFCE_PANEL",
      "chmod 0755 /usr/local/bin/worktoper-configure-xfce-panel",
      "/usr/local/bin/worktoper-configure-xfce-panel || true",
      "panel_marker=/home/worktoper/.cache/worktoper-panel-nosystray-applied",
      "if pgrep -u worktoper -x xfce4-panel >/dev/null 2>&1 && [ ! -f \"$panel_marker\" ]; then install -d -m 0700 -o worktoper -g worktoper /home/worktoper/.cache; touch \"$panel_marker\"; chown worktoper:worktoper \"$panel_marker\"; runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; xfce4-panel --restart >/tmp/worktoper-xfce-panel-nosystray.log 2>&1 || true'; fi",
      "cat >/usr/local/sbin/worktoper-install-vscode <<'WORKTOPER_INSTALL_VSCODE'",
      "#!/bin/sh",
      "set -eu",
      "if command -v code >/dev/null 2>&1; then exit 0; fi",
      "echo 'Microsoft VS Code is missing from the WorkToper VM image.' >&2",
      "exit 1",
      "WORKTOPER_INSTALL_VSCODE",
      "chmod 0755 /usr/local/sbin/worktoper-install-vscode",
      "cat >/usr/local/sbin/worktoper-install-chrome <<'WORKTOPER_INSTALL_CHROME'",
      "#!/bin/sh",
      "set -eu",
      "if command -v google-chrome >/dev/null 2>&1; then exit 0; fi",
      "echo 'Google Chrome is missing from the WorkToper VM image.' >&2",
      "exit 1",
      "WORKTOPER_INSTALL_CHROME",
      "chmod 0755 /usr/local/sbin/worktoper-install-chrome",
      "cat >/usr/local/sbin/worktoper-install-layan-theme <<'WORKTOPER_INSTALL_LAYAN'",
      "#!/bin/sh",
      "set -eu",
      "find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' | grep -q . && exit 0",
      "echo 'Layan GTK theme is missing from the WorkToper VM image.' >&2",
      "exit 1",
      "WORKTOPER_INSTALL_LAYAN",
      "cat >/usr/local/bin/worktoper-apply-layan-theme <<'WORKTOPER_APPLY_LAYAN'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*Solid*' -printf '%f\\n' | head -n 1 2>/dev/null || true)",
      "[ -n \"$theme_name\" ] || theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*Dark*' -printf '%f\\n' | head -n 1 2>/dev/null || true)",
      "[ -n \"$theme_name\" ] || theme_name=$(find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' -printf '%f\\n' | head -n 1 2>/dev/null || true)",
      "icon_theme=Papirus-Dark",
      "[ -d /usr/share/icons/$icon_theme ] || icon_theme=Adwaita",
      "if [ -z \"$theme_name\" ]; then",
      "  exit 1",
      "fi",
      "theme_path=/usr/share/themes/$theme_name",
      "wallpaper=$(find /usr/share/backgrounds/worktoper -maxdepth 1 -iname 'alchemy-5.png' | head -n 1 2>/dev/null || true)",
      "[ -n \"$wallpaper\" ] || wallpaper=/usr/share/backgrounds/worktoper/Alchemy-5.png",
      "mkdir -p /home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml",
      "if [ ! -f \"$wallpaper\" ]; then",
      "  echo \"WorkToper background missing: $wallpaper\" >&2",
      "fi",
      "cat >/home/worktoper/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml <<EOF",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "",
      "<channel name=\"xsettings\" version=\"1.0\">",
      "  <property name=\"Net\" type=\"empty\">",
      "    <property name=\"ThemeName\" type=\"string\" value=\"$theme_name\"/>",
      "    <property name=\"IconThemeName\" type=\"string\" value=\"$icon_theme\"/>",
      "  </property>",
      "  <property name=\"Gtk\" type=\"empty\">",
      "    <property name=\"FontName\" type=\"string\" value=\"Noto Sans 10\"/>",
      "    <property name=\"MonospaceFontName\" type=\"string\" value=\"Noto Sans Mono 10\"/>",
      "    <property name=\"DecorationLayout\" type=\"string\" value=\"menu:minimize,maximize,close\"/>",
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
      "xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s \"$icon_theme\" >/dev/null 2>&1 || true",
      "xfconf-query -c xsettings -p /Gtk/DecorationLayout -n -t string -s 'menu:minimize,maximize,close' >/dev/null 2>&1 || true",
      "xfconf-query -c xsettings -p /Gtk/FontName -n -t string -s 'Noto Sans 10' >/dev/null 2>&1 || true",
      "xfconf-query -c xsettings -p /Gtk/MonospaceFontName -n -t string -s 'Noto Sans Mono 10' >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/use_compositing -n -t bool -s true >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/frame_opacity -n -t int -s 100 >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/inactive_opacity -n -t int -s 94 >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/show_frame_shadow -n -t bool -s true >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/show_popup_shadow -n -t bool -s true >/dev/null 2>&1 || true",
      "xfconf-query -c xfwm4 -p /general/button_layout -n -t string -s 'O|HMC' >/dev/null 2>&1 || true",
      "for monitor in monitor0 monitorVirtual-1 monitorVirtual1 monitorVNC-0 monitorDefault; do",
      "  base=/backdrop/screen0/$monitor/workspace0",
      "  xfconf-query -c xfce4-desktop -p $base/last-image -n -t string -s \"$wallpaper\" >/dev/null 2>&1 || true",
      "  xfconf-query -c xfce4-desktop -p $base/image-path -n -t string -s \"$wallpaper\" >/dev/null 2>&1 || true",
      "  xfconf-query -c xfce4-desktop -p $base/image-style -n -t int -s 5 >/dev/null 2>&1 || true",
      "done",
      "for property in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/last-image$|/image-path$' || true); do xfconf-query -c xfce4-desktop -p \"$property\" -s \"$wallpaper\" >/dev/null 2>&1 || true; done",
      "for property in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/image-style$' || true); do xfconf-query -c xfce4-desktop -p \"$property\" -s 5 >/dev/null 2>&1 || true; done",
      "mkdir -p /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0",
      "printf '%s\\n' '[Settings]' \"gtk-theme-name=$theme_name\" \"gtk-icon-theme-name=$icon_theme\" 'gtk-font-name=Noto Sans 10' 'gtk-application-prefer-dark-theme=true' >/home/worktoper/.config/gtk-3.0/settings.ini",
      "/usr/local/bin/worktoper-configure-xfce-panel >/dev/null 2>&1 || true",
      "ln -sfn \"$theme_path/gtk-4.0/assets\" /home/worktoper/.config/gtk-4.0/assets 2>/dev/null || true",
      "ln -sfn \"$theme_path/gtk-4.0/gtk.css\" /home/worktoper/.config/gtk-4.0/gtk.css 2>/dev/null || true",
      "ln -sfn \"$theme_path/gtk-4.0/gtk-dark.css\" /home/worktoper/.config/gtk-4.0/gtk-dark.css 2>/dev/null || true",
      "chown -R worktoper:worktoper /home/worktoper/.config/gtk-3.0 /home/worktoper/.config/gtk-4.0 /home/worktoper/.config/xfce4 2>/dev/null || true",
      "xfdesktop --reload >/dev/null 2>&1 || true",
      "WORKTOPER_APPLY_LAYAN",
      "chmod 0755 /usr/local/sbin/worktoper-install-layan-theme /usr/local/bin/worktoper-apply-layan-theme",
      "cat >/usr/local/bin/worktoper-open-browser <<'WORKTOPER_BROWSER'",
      "#!/bin/sh",
      "export DISPLAY=:0",
      "export XDG_RUNTIME_DIR=/run/user/1000",
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "[ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority",
      "cd /home/worktoper",
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
      "  command -v xmessage >/dev/null 2>&1 && xmessage -center 'Microsoft VS Code is missing from this VM image.' || true",
      "  exit 127",
      "fi",
      "exec code --no-sandbox \"$@\" 2>/tmp/worktoper-code.log",
      "WORKTOPER_CODE",
      "chmod 0755 /usr/local/bin/worktoper-open-browser /usr/local/bin/worktoper-open-code",
      "rm -f /home/worktoper/Desktop/Chrome.desktop /home/worktoper/Desktop/VSCode.desktop /home/worktoper/Desktop/Code.desktop /home/worktoper/Desktop/Codium.desktop /home/worktoper/Desktop/VSCodium.desktop /usr/share/applications/codium.desktop /usr/share/applications/com.vscodium.codium.desktop 2>/dev/null || true",
      "if dpkg-query -W -f='${Status}' codium vscodium code-oss 2>/dev/null | grep -q 'install ok installed'; then",
      "  nohup sh -lc 'DEBIAN_FRONTEND=noninteractive apt-get purge -y codium vscodium code-oss' >/tmp/worktoper-remove-vscodium.log 2>&1 &",
      "fi",
      "command -v code >/dev/null 2>&1 || echo '$ Microsoft VS Code missing from VM image'",
      "command -v google-chrome >/dev/null 2>&1 || echo '$ Google Chrome missing from VM image'",
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
      ...this.displayAwakeGuestCommands(),
      "printf '%s\\n' '[Desktop Entry]' 'Type=Application' 'Name=WorkToper Layan Theme' 'Exec=/usr/local/bin/worktoper-apply-layan-theme' 'OnlyShowIn=XFCE;' 'Terminal=false' 'X-GNOME-Autostart-enabled=true' > /home/worktoper/.config/autostart/worktoper-layan-theme.desktop",
      "if find /usr/share/themes -maxdepth 1 -type d -name 'Layan*' | grep -q .; then",
      "  nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-apply-layan-theme' >/tmp/worktoper-apply-layan-theme.log 2>&1 &",
      "else",
      "  echo '$ Layan GTK theme missing from VM image'",
      "fi",
      "chmod +x /home/worktoper/Desktop/*.desktop 2>/dev/null || true",
      "chown -R worktoper:worktoper /home/worktoper/Desktop /home/worktoper/.config",
      "nohup runuser -u worktoper -- sh -lc '/usr/local/bin/worktoper-trust-desktop-launchers' >/tmp/worktoper-desktop-trust.log 2>&1 &",
      "if ! pgrep -u worktoper -x xfce4-session >/dev/null 2>&1; then",
      "  echo '$ startxfce4 (fallback desktop session)'",
      "  runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup dbus-run-session -- startxfce4 >/tmp/worktoper-xfce.log 2>&1 &'",
      "  sleep 2",
      "fi",
      "if ! pgrep -u worktoper -x xfce4-session >/dev/null 2>&1; then",
      "  pgrep -u worktoper -x xfce4-panel >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfce4-panel >/tmp/worktoper-xfce-panel.log 2>&1 &'",
      "  pgrep -u worktoper -x xfdesktop >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfdesktop >/tmp/worktoper-xfdesktop.log 2>&1 &'",
      "  pgrep -u worktoper -x xfwm4 >/dev/null 2>&1 || runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XAUTHORITY=/home/worktoper/.Xauthority; export XDG_RUNTIME_DIR=/run/user/1000; nohup xfwm4 >/tmp/worktoper-xfwm4.log 2>&1 &'",
      "fi",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `${text}\r\n`)
  }

  async ensureEmbeddedVnc({ restart = false } = {}) {
    if (!this.guestAgent || !this.vncTcpPort) return false
    const command = [
      "set -u",
      "if ! command -v x11vnc >/dev/null 2>&1; then",
      "  echo '$ x11vnc missing from VM image'",
      "  exit 1",
      "fi",
      ...(restart ? [
        "pkill -x x11vnc >/dev/null 2>&1 || true",
        "for attempt in $(seq 1 20); do",
        "  ! pgrep -x x11vnc >/dev/null 2>&1 && break",
        "  sleep 0.1",
        "done",
        "if pgrep -x x11vnc >/dev/null 2>&1; then pkill -KILL -x x11vnc >/dev/null 2>&1 || true; sleep 0.2; fi",
      ] : [":"]),
      "if ! pgrep -a -x x11vnc | grep -F -- '-rfbport 5900' >/dev/null 2>&1; then",
      "  echo '$ x11vnc -display :0 -rfbport 5900'",
      "  pkill -x x11vnc >/dev/null 2>&1 || true",
      `  nohup ${X11VNC_COMMAND} >/tmp/worktoper-x11vnc-start.log 2>&1 &`,
      "fi",
      "sleep 1",
      "vnc_ready=0",
      "pgrep -a -x x11vnc | grep -F -- '-rfbport 5900' || vnc_ready=1",
      "tail -n 30 /tmp/worktoper-x11vnc-start.log /tmp/worktoper-x11vnc.log 2>/dev/null | grep -Ev 'ncache|copyrect|karlrunge.com/x11vnc/faq|client.*caching' || true",
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
      "tail -n 120 /home/worktoper/.xsession-errors 2>/dev/null | grep -Ev 'libxfce4kbd-private-WARNING.*Failed to grab keycode|Another clipboard manager is already running|xfce4-panel: There is already a running instance|The notification area lost selection|ICE I/O Error|Disconnected from session manager|Failed to connect to session manager' | tail -n 80 || true",
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
    this.clearDesktopStartupTimers()
    this.send("worktoper:vm:boot", `\r\n[WorkToper] Boot 100% - Linux desktop is ready (${source}). Embedded display is active.\r\n`)
    this.update({
      phase: "ready",
      detail: this.message("Linux desktop is ready", "Linux 桌面已就绪"),
      bootProgress: 100,
      cpuActive: false,
      diskActive: false,
      network: "connected",
    })
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
        this.send("worktoper:vm:boot", `\r\n[WorkToper] ${this.message("System console connected. Startup output is shown here.", "系统控制台已连接，启动输出会显示在这里。")}\r\n`)
        this.update({ detail: this.message("Serial port connected. Waiting for Linux systemd/getty output.", "串口已连接，等待 Linux systemd/getty 输出"), bootProgress: 40 })
      })
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        if (this.shellReady) {
          this.send("worktoper:vm:terminal", text)
        } else {
          this.send("worktoper:vm:boot", text)
        }
        if (/login:/i.test(text)) this.update({ detail: this.message("Linux login prompt detected", "Linux 登录提示已出现"), bootProgress: 82 })
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
      this.update({ detail: this.state.phase === "ready" ? this.message("Linux desktop is ready", "Linux 桌面已就绪") : this.message("Linux shell is interactive. Waiting for the graphical desktop.", "Linux shell 可交互，等待图形桌面"), bootProgress: Math.max(this.state.bootProgress, 84), cpuActive: this.state.phase !== "ready", diskActive: this.state.phase !== "ready", network: "connected" })
      return
    }
    this.shellReady = true
    this.update({ phase: this.state.phase === "ready" ? "ready" : "loading", detail: this.message("Linux shell is interactive. Waiting for the graphical desktop.", "Linux shell 可交互，等待图形桌面"), bootProgress: Math.max(this.state.bootProgress, 84), cpuActive: true, diskActive: true, network: "connected" })
    this.send("worktoper:vm:terminal", "\r\n[WorkToper] Linux shell ready. Commands run inside the Debian VM.\r\n")
    if (promptText) this.send("worktoper:vm:terminal", promptText)
    const queued = this.pendingShellWrites.splice(0)
    queued.forEach((data) => this.write(data))
    this.startSerialDesktopFallback()
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
    if (!this.write(`setsid runuser -u worktoper -- sh -lc '${command.replaceAll("'", "'\\''")}' &\r`)) throw new Error(this.message("The Linux VM cannot receive launch commands yet", "Linux VM 还不能接收启动命令"))
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
    if (!command) throw new Error(this.message(`Unknown Linux application: ${appId}`, `未知 Linux 应用: ${appId}`))
    if (!this.desktopReady) {
      if (!this.pendingLaunches.includes(appId)) this.pendingLaunches.push(appId)
      this.update({ detail: this.message(`${appId} was added to the launch queue. Waiting for the Linux desktop.`, `${appId} 已加入启动队列，等待 Linux 桌面就绪`) })
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
    if (!this.guestAgent) throw new Error(this.message("The Linux VM is not ready and cannot be locked", "Linux VM 还没有就绪，无法锁屏"))
    const command = [
      "set -u",
      "printf 'worktoper:worktoper\\n' | chpasswd || true",
      "runuser -u worktoper -- sh -lc 'export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/1000; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; [ -f /home/worktoper/.Xauthority ] && export XAUTHORITY=/home/worktoper/.Xauthority; xflock4 || xfce4-screensaver-command --lock || light-locker-command -l || dm-tool lock'",
    ].join("\n")
    const status = await this.guestAgent.guestShell(command, { captureOutput: true })
    const text = [status.stdout, status.stderr].filter(Boolean).join("\n").trim()
    if (text) this.send("worktoper:vm:boot", `\r\n[WorkToper] Lock screen\r\n${text}\r\n`)
    if (status.exitcode !== 0) throw new Error(this.message("Failed to lock Linux. Confirm that the XFCE session is running.", "Linux 锁屏失败，请确认 XFCE 会话已启动"))
    return { ok: true }
  }

  async getAgentRobotStatus() {
    const port = this.agentRobotPort || this.connection?.agentRobotPort || DEFAULT_AGENT_ROBOT_PORT
    const url = `http://127.0.0.1:${port}`
    if (!this.process || !this.connection) return { ready: false, url, message: this.message("Linux VM has not started", "Linux VM 尚未启动") }
    return new Promise((resolve) => {
      const request = http.get(`${url}/api/version`, (response) => {
        response.resume()
        const ready = Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 500)
        resolve({ ready, url, message: ready ? this.message("Agent Robot is ready", "Agent Robot 已就绪") : this.message(`Agent Robot returned HTTP ${response.statusCode || "unknown"}`, `Agent Robot 返回 HTTP ${response.statusCode || "unknown"}`) })
      })
      request.setTimeout(1800, () => request.destroy(new Error("timeout")))
      request.on("error", () => resolve({ ready: false, url, message: this.message("Waiting for the Agent Robot service to start", "正在等待 Agent Robot 服务启动") }))
    })
  }

  async stop() {
    const processToStop = this.process
    this.serial?.destroy()
    this.serial = null
    this.guestAgent?.close()
    this.guestAgent = null
    this.guestIntegrationPromise = null
    this.clearDesktopStartupTimers()
    this.clearGuestAgentRetry()
    this.vncProxyServer?.close()
    this.vncProxyServer = null
    this.vncTcpPort = 0
    this.agentRobotPort = 0
    this.sharedDirectory = ""
    this.qgaPort = 0
    this.serialDesktopFallbackAttempts = 0
    this.guestAgentConnectAttempts = 0
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = null
    this.pendingDesktopSize = null
    this.lastAppliedDesktopSize = ""
    if (processToStop && processToStop.exitCode === null && processToStop.signalCode === null) {
      processToStop.kill("SIGTERM")
      const stopped = await waitForProcessExit(processToStop, 7000)
      if (!stopped && processToStop.exitCode === null && processToStop.signalCode === null) {
        processToStop.kill("SIGKILL")
        await waitForProcessExit(processToStop, 2500)
      }
    }
    if (this.process === processToStop) this.process = null
    this.connection = null
    this.pendingLaunches = []
    this.update({ phase: "idle", detail: this.message("Linux VM stopped", "Linux VM 已停止"), bootProgress: 0, cpuActive: false, diskActive: false, network: "disconnected" })
    return { ok: true }
  }
}

module.exports = { VmManager }
