const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tt', {
  setMode:    (mode)       => ipcRenderer.send('set-mode', mode),
  moveWidget: (dx, dy)     => ipcRenderer.send('move-widget', { dx, dy }),
  saveFile:   (name, buf)  => ipcRenderer.send('save-file', { name, buffer: buf }),
  quit:       ()           => ipcRenderer.send('quit-app'),
  onMode:     (cb)         => ipcRenderer.on('mode-changed', (_, m) => cb(m)),
});
