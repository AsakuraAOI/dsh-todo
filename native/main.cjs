const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const endpoint = process.env.DSH_TODO_ENDPOINT, token = process.env.DSH_TODO_TOKEN;
const smokeReport = process.env.DSH_TODO_SMOKE_REPORT;
if (smokeReport) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
app.setPath('userData', join(process.env.DSH_TODO_DATA_ROOT, 'window-profile'));
delete process.env.DSH_TODO_TOKEN;
delete process.env.DSH_TODO_ENDPOINT;
let win, heartbeat, heartbeatRunning = false, currentTheme, themeRevision = -1;
function applyTheme(theme, revision) {
  currentTheme = theme; themeRevision = revision;
  nativeTheme.themeSource = theme.colorScheme;
  if (win && !win.isDestroyed()) {
    const color = theme.tokens['--dsw-alias-bg-layer-1'];
    win.setBackgroundColor(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color || '') ? color : theme.colorScheme === 'dark' ? '#191b20' : '#ffffff');
    win.webContents.send('todo:theme', theme);
  }
}
async function rpc(kind, input) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ kind, input }), signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '待办服务不可用。');
  return data;
}
function owned(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(join(__dirname, 'index.html')).href) throw new Error('拒绝未知页面访问待办。');
}
app.whenReady().then(async () => {
  const initialTheme = await rpc('theme'); applyTheme(initialTheme.theme, initialTheme.themeRevision);
  win = new BrowserWindow({ width: 420, height: 580, minWidth: 330, minHeight: 300, title: '待办清单', autoHideMenuBar: true, show: false, backgroundColor: currentTheme.colorScheme === 'dark' ? '#191b20' : '#ffffff', webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.handle('todo:list', event => { owned(event); return rpc('list'); });
  ipcMain.handle('todo:mutate', (event, input) => { owned(event); return rpc('mutate', input); });
  ipcMain.handle('todo:theme', event => { owned(event); return currentTheme; });
  ipcMain.handle('todo:window', (event, action) => {
    owned(event);
    if (action === 'pin') { win.setAlwaysOnTop(!win.isAlwaysOnTop()); return { pinned: win.isAlwaysOnTop() }; }
    if (action === 'minimize') win.minimize();
    else if (action === 'close') { win.close(); return { closed: true }; }
    else if (action !== 'pin' && action !== 'status') throw new Error('无此窗口操作。');
    return { pinned: win?.isAlwaysOnTop() || false };
  });
  await win.loadFile(join(__dirname, 'index.html'));
  if (!smokeReport) win.show();
  await rpc('ready');
  heartbeat = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const { commands, theme, themeRevision: nextRevision } = await rpc('heartbeat');
      if (nextRevision !== themeRevision) applyTheme(theme, nextRevision);
      for (const command of commands) if (command === 'focus') { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    } catch { app.quit(); } finally { heartbeatRunning = false; }
  }, 750);
  if (smokeReport) await require('./smoke.cjs')({ app, win, rpc, report: smokeReport });
}).catch(error => { if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ error: error.stack })); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => clearInterval(heartbeat));
