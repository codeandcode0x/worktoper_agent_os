const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron")
const { createStaticServer } = require("./static-server.cjs")
const { VmManager } = require("./vm-manager.cjs")

const isDev = !app.isPackaged
let staticServer = null
let mainWindow = null
let appOrigin = ""
let vmManager = null
let resizingToAspect = false

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json")
}

function defaultVmSettings() {
  return {
    cpus: Math.max(2, Math.min(os.cpus().length, 4)),
    memoryMb: 4096,
    sharedDirectory: "",
    lockPassword: "worktoper",
  }
}

function normalizeVmSettings(input = {}) {
  const defaults = defaultVmSettings()
  const maxCpus = Math.max(1, os.cpus().length)
  const cpus = Number(input.cpus ?? defaults.cpus)
  const memoryMb = Number(input.memoryMb ?? defaults.memoryMb)
  const sharedDirectory = typeof input.sharedDirectory === "string" ? input.sharedDirectory.trim() : ""
  const lockPassword = typeof input.lockPassword === "string" && input.lockPassword ? input.lockPassword : defaults.lockPassword
  return {
    cpus: Number.isFinite(cpus) ? Math.max(1, Math.min(maxCpus, Math.round(cpus))) : defaults.cpus,
    memoryMb: Number.isFinite(memoryMb) ? Math.max(1024, Math.min(32768, Math.round(memoryMb))) : defaults.memoryMb,
    sharedDirectory: sharedDirectory && fs.existsSync(sharedDirectory) ? sharedDirectory : "",
    lockPassword,
  }
}

function readVmSettings() {
  try {
    const file = getSettingsPath()
    if (!fs.existsSync(file)) return defaultVmSettings()
    return normalizeVmSettings(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return defaultVmSettings()
  }
}

function writeVmSettings(settings) {
  const normalized = normalizeVmSettings(settings)
  const file = getSettingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

app.setName("WorkToper Agent OS")
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer")
if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", process.env.WORKTOPER_REMOTE_DEBUGGING_PORT || "9223")

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
  process.exit(0)
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

function getStaticRoot() {
  return isDev ? path.join(__dirname, "..", "out") : path.join(app.getAppPath(), "out")
}

async function createWindow() {
  const root = getStaticRoot()
  staticServer = createStaticServer(root)
  const { url } = await staticServer.listen(0, "127.0.0.1")
  appOrigin = new URL(url).origin
  const { width: displayWidth, height: displayHeight } = screen.getPrimaryDisplay().workAreaSize
  const maxContentWidth = Math.max(1024, displayWidth - 160)
  const maxContentHeight = Math.max(720, displayHeight - 140)
  let windowWidth = Math.max(1024, Math.min(1280, maxContentWidth))
  let windowHeight = Math.round(windowWidth * 9 / 16)
  if (windowHeight > maxContentHeight) {
    windowHeight = Math.max(720, Math.min(800, maxContentHeight))
    windowWidth = Math.round(windowHeight * 16 / 9)
  }

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    useContentSize: true,
    minWidth: 1024,
    minHeight: 720,
    center: true,
    aspectRatio: 16 / 9,
    title: "WorkToper Agent OS",
    backgroundColor: "#111317",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setAspectRatio(16 / 9)
    mainWindow?.show()
  })

  mainWindow.on("resize", () => {
    if (!mainWindow || resizingToAspect) return
    const [contentWidth, contentHeight] = mainWindow.getContentSize()
    if (!contentWidth || !contentHeight) return
    const expectedHeight = Math.round(contentWidth * 9 / 16)
    if (Math.abs(expectedHeight - contentHeight) < 2) return
    resizingToAspect = true
    mainWindow.setContentSize(contentWidth, expectedHeight)
    resizingToAspect = false
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl)
    return { action: "deny" }
  })

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin === appOrigin) return
    event.preventDefault()
    shell.openExternal(targetUrl)
  })

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  await mainWindow.loadURL(url)
  vmManager = new VmManager({
    app,
    webContents: mainWindow.webContents,
    getSettings: readVmSettings,
  })
}

ipcMain.handle("worktoper:vm:start", async () => {
  if (!vmManager || !mainWindow) throw new Error("WorkToper VM manager is not ready")
  return vmManager.start()
})

ipcMain.handle("worktoper:vm:stop", () => {
  vmManager?.stop()
  return { ok: true }
})

ipcMain.handle("worktoper:vm:write", (_event, data) => {
  if (typeof data !== "string") throw new Error("Invalid serial input")
  return { ok: Boolean(vmManager?.write(data)) }
})

ipcMain.handle("worktoper:vm:launch", (_event, appId) => {
  if (typeof appId !== "string") throw new Error("Invalid app id")
  if (!vmManager) throw new Error("WorkToper VM manager is not ready")
  return vmManager.launch(appId)
})

ipcMain.handle("worktoper:vm:resize-desktop", (_event, size) => {
  if (!vmManager) return { ok: false }
  const width = Number(size?.width)
  const height = Number(size?.height)
  return vmManager.resizeDesktop(width, height)
})

ipcMain.handle("worktoper:vm:settings:get", () => readVmSettings())

ipcMain.handle("worktoper:vm:settings:set", (_event, settings) => writeVmSettings(settings || {}))

ipcMain.handle("worktoper:vm:settings:choose-directory", async () => {
  if (!mainWindow) throw new Error("WorkToper window is not ready")
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  })
  return { canceled: result.canceled, path: result.filePaths[0] || "" }
})

ipcMain.handle("worktoper:vm:lock", () => {
  if (!vmManager) throw new Error("WorkToper VM manager is not ready")
  return vmManager.lock()
})

ipcMain.handle("worktoper:app:restart", () => {
  vmManager?.stop()
  app.relaunch()
  app.quit()
  return { ok: true }
})

ipcMain.handle("worktoper:app:close", () => {
  app.quit()
  return { ok: true }
})

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("WorkToper Agent OS failed to start", error instanceof Error ? error.stack || error.message : String(error))
  app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      dialog.showErrorBox("WorkToper Agent OS failed to start", error instanceof Error ? error.message : String(error))
    })
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  vmManager?.stop()
  if (staticServer) void staticServer.close()
})
