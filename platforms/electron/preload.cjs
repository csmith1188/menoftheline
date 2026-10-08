const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("motlDesktop", {
  openExternal: (url) => ipcRenderer.invoke("motl:openExternal", url),
  getServerUrl: () => ipcRenderer.invoke("motl:getServerUrl"),
  onAuthToken: (cb) => {
    ipcRenderer.on("motl:authToken", (_ev, token) => {
      if (typeof cb === "function") cb(token);
    });
  },
});

contextBridge.exposeInMainWorld("MOTL_SHELL", true);
