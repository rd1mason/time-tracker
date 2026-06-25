const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');

let win = null;

const SIZES = {
  compact:     { w: 380,  h: 108 },
  pre_start:   { w: 440,  h: 298 },
  session_end: { w: 440,  h: 590 },
  full:        { w: 1120, h: 780 },
};

let currentMode = 'compact';
let compactPos  = null;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const { w, h } = SIZES.compact;
  win = new BrowserWindow({
    width: w, height: h,
    x: sw - w - 24,
    y: sh - h - 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: true,
    icon: path.join(__dirname, 'src/assets/icon.icns'),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('src/index.html');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
}

function setMode(mode) {
  if (!win) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const sz = SIZES[mode];
  if (!sz) return;
  const { w, h } = sz;

  if (currentMode === 'compact') compactPos = win.getPosition();
  currentMode = mode;

  if (mode === 'compact') {
    const [cx, cy] = compactPos || [sw - SIZES.compact.w - 24, sh - SIZES.compact.h - 24];
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setResizable(false);
    win.setBounds({ x: cx, y: Math.min(cy, sh - h - 8), width: w, height: h }, true);
  } else if (mode === 'pre_start') {
    const [cx, cy] = compactPos || [sw - SIZES.compact.w - 24, sh - SIZES.compact.h - 24];
    const x = Math.max(8, Math.min(cx + SIZES.compact.w - w, sw - w - 8));
    const y = Math.max(8, Math.min(cy - h + SIZES.compact.h, sh - h - 8));
    win.setAlwaysOnTop(true, 'floating');
    win.setResizable(false);
    win.setBounds({ x, y, width: w, height: h }, true);
  } else if (mode === 'session_end') {
    const x = sw - w - 24;
    const y = sh - h - 24;
    win.setAlwaysOnTop(true, 'floating');
    win.setResizable(false);
    win.setBounds({ x, y, width: w, height: h }, true);
  } else if (mode === 'full') {
    const x = Math.round((sw - w) / 2);
    const y = Math.round((sh - h) / 2);
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setBounds({ x, y, width: w, height: h }, true);
  }

  win.webContents.send('mode-changed', mode);
}

ipcMain.on('set-mode', (_, mode) => setMode(mode));

ipcMain.on('move-widget', (_, { dx, dy }) => {
  if (!win || currentMode !== 'compact') return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

// Stable screenshot save: convert dataUrl to Buffer on main side, show native dialog
ipcMain.handle('save-screenshot', async (_, { dataUrl, name }) => {
  try {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: name || 'screenshot.png',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(result.filePath, buf);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('quit-app', () => app.quit());

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('CommandOrControl+Alt+I', () => {
    if (win) win.webContents.openDevTools({ mode: 'detach' });
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
