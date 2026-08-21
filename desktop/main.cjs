const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } = require("electron")
const { createStaticServer } = require("./static-server.cjs")
const { VmManager } = require("./vm-manager.cjs")

const isDev = !app.isPackaged
let staticServer = null
let mainWindow = null
let agentRobotWindow = null
let agentRobotRetryTimer = null
let agentRobotOrigin = ""
let appOrigin = ""
let vmManager = null
let resizingToAspect = false
let syncingAgentRobotWindow = false

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json")
}

function defaultVmSettings() {
  return {
    cpus: Math.max(2, Math.min(os.cpus().length, 4)),
    memoryMb: 4096,
    sharedDirectory: "",
    lockPassword: "worktoper",
    language: "en",
  }
}

function normalizeVmSettings(input = {}) {
  const defaults = defaultVmSettings()
  const maxCpus = Math.max(1, os.cpus().length)
  const cpus = Number(input.cpus ?? defaults.cpus)
  const memoryMb = Number(input.memoryMb ?? defaults.memoryMb)
  const sharedDirectory = typeof input.sharedDirectory === "string" ? input.sharedDirectory.trim() : ""
  const lockPassword = typeof input.lockPassword === "string" && input.lockPassword ? input.lockPassword : defaults.lockPassword
  const language = input.language === "zh" ? "zh" : "en"
  let validSharedDirectory = ""
  if (sharedDirectory) {
    try {
      validSharedDirectory = fs.statSync(sharedDirectory).isDirectory() ? sharedDirectory : ""
    } catch {}
  }
  return {
    cpus: Number.isFinite(cpus) ? Math.max(1, Math.min(maxCpus, Math.round(cpus))) : defaults.cpus,
    memoryMb: Number.isFinite(memoryMb) ? Math.max(1024, Math.min(32768, Math.round(memoryMb))) : defaults.memoryMb,
    sharedDirectory: validSharedDirectory,
    lockPassword,
    language,
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

function getWindowIconPath() {
  const candidates = [
    path.join(app.getAppPath(), "images", "icons", "icon.png"),
    path.join(__dirname, "..", "images", "icons", "icon.png"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function getAgentRobotLoadingUrl() {
  const language = readVmSettings().language
  const copy = language === "zh"
    ? { preparing: "正在准备你的智能工作空间，服务就绪后将自动进入。", connecting: "正在连接本地服务" }
    : { preparing: "Preparing your intelligent workspace. It will open automatically when ready.", connecting: "Connecting to local service" }
  const html = `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Robot</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow: hidden; background: #f3f6fc; color: #182238; }
    body::before { content: ""; position: fixed; inset: 0; background: radial-gradient(circle at 12% 15%, rgba(79, 137, 255, .2), transparent 30%), radial-gradient(circle at 88% 84%, rgba(96, 165, 250, .15), transparent 28%); }
    body::after { content: ""; position: fixed; inset: 0; opacity: .34; background-image: linear-gradient(rgba(102, 132, 187, .07) 1px, transparent 1px), linear-gradient(90deg, rgba(102, 132, 187, .07) 1px, transparent 1px); background-size: 28px 28px; mask-image: radial-gradient(circle at center, #000, transparent 76%); }
    main { position: relative; z-index: 1; display: grid; min-height: 100vh; place-items: center; padding: 24px; }
    section { width: min(438px, 100%); padding: 28px 30px 24px; border: 1px solid rgba(167, 190, 231, .56); border-radius: 25px; background: rgba(255, 255, 255, .78); box-shadow: 0 26px 70px rgba(51, 86, 153, .15), inset 0 1px rgba(255, 255, 255, .95); backdrop-filter: blur(22px) saturate(135%); }
    .identity { display: flex; align-items: center; gap: 15px; text-align: left; }
    .mark { position: relative; display: grid; width: 58px; height: 58px; flex: none; place-items: center; border-radius: 18px; background: linear-gradient(145deg, #3478f6, #1754dc); box-shadow: 0 14px 28px rgba(29, 92, 220, .27), inset 0 1px rgba(255, 255, 255, .34); }
    .mark::after { content: ""; position: absolute; inset: -5px; border: 1px solid rgba(52, 120, 246, .18); border-radius: 22px; animation: breathe 2.4s ease-in-out infinite; }
    svg { width: 31px; height: 31px; fill: none; stroke: #fff; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.55; }
    .title { min-width: 0; }
    .eyebrow { display: block; margin-bottom: 5px; color: #5270a8; font-size: 9px; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -.025em; }
    p { margin: 20px 0 0; color: #71809c; font-size: 12px; line-height: 1.65; }
    .progress { height: 5px; margin-top: 22px; overflow: hidden; border-radius: 999px; background: #e4ebf8; }
    .progress span { display: block; width: 44%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2868eb, #72a5ff); box-shadow: 0 0 14px rgba(40, 104, 235, .42); animation: loading 1.7s ease-in-out infinite; }
    .status { display: flex; align-items: center; gap: 8px; margin-top: 14px; color: #6f7f9c; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; letter-spacing: .055em; text-transform: uppercase; }
    .status i { width: 6px; height: 6px; border-radius: 50%; background: #2f73ee; box-shadow: 0 0 10px rgba(47, 115, 238, .65); animation: blink 1.2s ease-in-out infinite; }
    .status strong { margin-left: auto; color: #9aa7bd; font-size: inherit; font-weight: 600; }
    footer { position: fixed; right: 18px; bottom: 14px; z-index: 1; color: #91a0ba; font-size: 8px; font-weight: 650; letter-spacing: .12em; }
    @keyframes breathe { 50% { opacity: .35; transform: scale(1.05); } }
    @keyframes blink { 50% { opacity: .25; } }
    @keyframes loading { 0% { transform: translateX(-110%); } 55%, 100% { transform: translateX(250%); } }
  </style>
</head>
<body>
  <main><section>
    <div class="identity">
      <div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M9 13v2M15 13v2"/></svg></div>
      <div class="title"><span class="eyebrow">Smart Desktop · Local Agent</span><h1>Agent Robot</h1></div>
    </div>
    <p>${copy.preparing}</p>
    <div class="progress"><span></span></div>
    <div class="status"><i></i>${copy.connecting}<strong>127.0.0.1:8088</strong></div>
  </section></main>
  <footer>POWERED BY WORKTCLAW</footer>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function scheduleAgentRobotLoad(delay = 0) {
  if (agentRobotRetryTimer) clearTimeout(agentRobotRetryTimer)
  agentRobotRetryTimer = setTimeout(async () => {
    agentRobotRetryTimer = null
    if (!agentRobotWindow || agentRobotWindow.isDestroyed() || !vmManager) return
    const status = await vmManager.getAgentRobotStatus()
    if (!agentRobotWindow || agentRobotWindow.isDestroyed()) return
    if (!status.ready) {
      scheduleAgentRobotLoad(1500)
      return
    }
    agentRobotOrigin = new URL(status.url).origin
    await agentRobotWindow.loadURL(status.url).catch(() => {
      scheduleAgentRobotLoad(1500)
    })
  }, delay)
}

function getAgentRobotWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 427, height: 720 }
  const mainBounds = mainWindow.getBounds()
  const width = Math.max(320, Math.round(mainBounds.width / 3))
  const display = screen.getDisplayMatching(mainBounds)
  const groupWidth = mainBounds.width + width
  let mainX = mainBounds.x

  if (!mainWindow.isFullScreen() && !mainWindow.isMaximized() && groupWidth <= display.workArea.width) {
    const maximumMainX = display.workArea.x + display.workArea.width - groupWidth
    mainX = Math.min(Math.max(mainX, display.workArea.x), maximumMainX)
    if (mainX !== mainBounds.x) mainWindow.setPosition(mainX, mainBounds.y)
  }

  return {
    x: mainX + mainBounds.width,
    y: mainBounds.y,
    width,
    height: mainBounds.height,
  }
}

function syncAgentRobotWindowBounds() {
  if (syncingAgentRobotWindow || !agentRobotWindow || agentRobotWindow.isDestroyed()) return
  syncingAgentRobotWindow = true
  try {
    agentRobotWindow.setBounds(getAgentRobotWindowBounds())
  } finally {
    syncingAgentRobotWindow = false
  }
}

async function openAgentRobotWindow() {
  if (!vmManager) throw new Error("WorkToper VM manager is not ready")
  if (agentRobotWindow && !agentRobotWindow.isDestroyed()) {
    syncAgentRobotWindowBounds()
    if (agentRobotWindow.isMinimized()) agentRobotWindow.restore()
    agentRobotWindow.show()
    agentRobotWindow.focus()
    if (!agentRobotOrigin || agentRobotWindow.webContents.getURL().startsWith("data:")) scheduleAgentRobotLoad()
    return { ok: true }
  }

  const bounds = getAgentRobotWindowBounds()
  agentRobotWindow = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 360,
    title: "Agent Robot · Smart Desktop",
    icon: getWindowIconPath(),
    backgroundColor: "#f3f6fc",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  agentRobotWindow.once("ready-to-show", () => agentRobotWindow?.show())
  agentRobotWindow.on("closed", () => {
    if (agentRobotRetryTimer) clearTimeout(agentRobotRetryTimer)
    agentRobotRetryTimer = null
    agentRobotOrigin = ""
    agentRobotWindow = null
  })
  agentRobotWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      if (agentRobotOrigin && new URL(targetUrl).origin === agentRobotOrigin) {
        void agentRobotWindow?.loadURL(targetUrl)
      } else {
        void shell.openExternal(targetUrl)
      }
    } catch {}
    return { action: "deny" }
  })
  agentRobotWindow.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      if (targetUrl.startsWith("data:") || (agentRobotOrigin && new URL(targetUrl).origin === agentRobotOrigin)) return
    } catch {}
    event.preventDefault()
    void shell.openExternal(targetUrl)
  })
  agentRobotWindow.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || !validatedUrl.startsWith("http://127.0.0.1:")) return
    void agentRobotWindow?.loadURL(getAgentRobotLoadingUrl()).then(() => scheduleAgentRobotLoad(1500))
  })
  agentRobotWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "fullscreen"])
    let trustedOrigin = false
    try {
      trustedOrigin = Boolean(agentRobotOrigin && new URL(webContents.getURL()).origin === agentRobotOrigin)
    } catch {}
    callback(trustedOrigin && allowedPermissions.has(permission))
  })

  await agentRobotWindow.loadURL(getAgentRobotLoadingUrl())
  scheduleAgentRobotLoad()
  return { ok: true }
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
    icon: getWindowIconPath(),
    backgroundColor: "#000000",
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

  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("worktoper:window:fullscreen-changed", true)
  })

  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("worktoper:window:fullscreen-changed", false)
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

  mainWindow.on("move", syncAgentRobotWindowBounds)
  mainWindow.on("resize", syncAgentRobotWindowBounds)

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

ipcMain.handle("worktoper:vm:stop", async () => {
  await vmManager?.stop()
  return { ok: true }
})

ipcMain.handle("worktoper:vm:agent-robot:open", () => openAgentRobotWindow())

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

ipcMain.handle("worktoper:window:fullscreen:get", () => ({
  fullscreen: Boolean(mainWindow?.isFullScreen()),
}))

ipcMain.handle("worktoper:window:fullscreen:exit", () => {
  if (!mainWindow) return { ok: false }
  mainWindow.setFullScreen(false)
  return { ok: true }
})

ipcMain.handle("worktoper:vm:lock", () => {
  if (!vmManager) throw new Error("WorkToper VM manager is not ready")
  return vmManager.lock()
})

ipcMain.handle("worktoper:clipboard:read-text", () => ({ text: clipboard.readText() || "" }))

ipcMain.handle("worktoper:clipboard:write-text", (_event, text) => {
  clipboard.writeText(typeof text === "string" ? text : "")
  return { ok: true }
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

app.whenReady().then(() => {
  installApplicationMenu()
  return createWindow()
}).catch((error) => {
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
  if (agentRobotRetryTimer) clearTimeout(agentRobotRetryTimer)
  vmManager?.stop()
  if (staticServer) void staticServer.close()
})
