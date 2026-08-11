const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("worktoperVM", {
  start: () => ipcRenderer.invoke("worktoper:vm:start"),
  stop: () => ipcRenderer.invoke("worktoper:vm:stop"),
  write: (data) => ipcRenderer.invoke("worktoper:vm:write", data),
  launch: (appId) => ipcRenderer.invoke("worktoper:vm:launch", appId),
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
})
