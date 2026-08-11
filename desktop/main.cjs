const path = require("node:path")
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron")
const { createStaticServer } = require("./static-server.cjs")
const { VmManager } = require("./vm-manager.cjs")

const isDev = !app.isPackaged
let staticServer = null
let mainWindow = null
let appOrigin = ""
let vmManager = null

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

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1024,
    minHeight: 720,
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
    mainWindow?.maximize()
    mainWindow?.show()
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
