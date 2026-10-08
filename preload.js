const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (name, ...args) => ipcRenderer.invoke(name, ...args).catch(e => {
    throw new Error(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a)),
  pathFor: file => webUtils.getPathForFile(file),
});
