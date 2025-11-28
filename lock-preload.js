const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockAPI', {
  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('lock-state', handler);
  },
  setPin: (pin) => ipcRenderer.invoke('lock:set-pin', pin),
  unlock: (pin) => ipcRenderer.invoke('lock:unlock', pin),
});
