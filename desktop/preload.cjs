const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("worktoperVM", {
  start: () => ipcRenderer.invoke("worktoper:vm:start"),
  stop: () => ipcRenderer.invoke("worktoper:vm:stop"),
  write: (data) => ipcRenderer.invoke("worktoper:vm:write", data),
  launch: (appId) => ipcRenderer.invoke("worktoper:vm:launch", appId),
  resizeDesktop: (size) => ipcRenderer.invoke("worktoper:vm:resize-desktop", size),
  getSettings: () => ipcRenderer.invoke("worktoper:vm:settings:get"),
  setSettings: (settings) => ipcRenderer.invoke("worktoper:vm:settings:set", settings),
  chooseSharedDirectory: () => ipcRenderer.invoke("worktoper:vm:settings:choose-directory"),
  getWindowFullscreen: () => ipcRenderer.invoke("worktoper:window:fullscreen:get"),
  exitWindowFullscreen: () => ipcRenderer.invoke("worktoper:window:fullscreen:exit"),
  lock: () => ipcRenderer.invoke("worktoper:vm:lock"),
  readClipboardText: () => ipcRenderer.invoke("worktoper:clipboard:read-text"),
  writeClipboardText: (text) => ipcRenderer.invoke("worktoper:clipboard:write-text", text),
  restartApp: () => ipcRenderer.invoke("worktoper:app:restart"),
  closeApp: () => ipcRenderer.invoke("worktoper:app:close"),
  onState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on("worktoper:vm:state", listener)
    return () => ipcRenderer.off("worktoper:vm:state", listener)
  },
  onSerial: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on("worktoper:vm:serial", listener)
    return () => ipcRenderer.off("worktoper:vm:serial", listener)
  },
  onBoot: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on("worktoper:vm:boot", listener)
    return () => ipcRenderer.off("worktoper:vm:boot", listener)
  },
  onTerminal: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on("worktoper:vm:terminal", listener)
    return () => ipcRenderer.off("worktoper:vm:terminal", listener)
  },
  onWindowFullscreenChange: (callback) => {
    const listener = (_event, fullscreen) => callback(Boolean(fullscreen))
    ipcRenderer.on("worktoper:window:fullscreen-changed", listener)
    return () => ipcRenderer.off("worktoper:window:fullscreen-changed", listener)
  },
})
