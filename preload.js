const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tt', {
  setMode:        (mode) => ipcRenderer.send('set-mode', mode),
  moveWidget:     (dx, dy) => ipcRenderer.send('move-widget', { dx, dy }),
  saveScreenshot: (dataUrl, name) => ipcRenderer.invoke('save-screenshot', { dataUrl, name }),
  quit:           () => ipcRenderer.send('quit-app'),
  onMode:         (cb) => ipcRenderer.on('mode-changed', (_, m) => cb(m)),
});
