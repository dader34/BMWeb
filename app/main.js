// electron main. spawns .NET sidecar (EDIABAS engine) and opens the window
// immediately; the renderer polls /api/health while its boot splash shows.
// on quit: SIGTERM the sidecar (server runs flash-recovery cleanup), then
// hard-kill after ~3s if it hangs.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// app name, else shows as "Electron"
app.setName('BMacW');

const SIDECAR_URL = 'http://127.0.0.1:8777';
let sidecar = null;
let sidecarExited = false;
let win = null;

// sidecar stdout/stderr -> ~/Library/Logs/BMacW/sidecar.log so crashes are
// debuggable ("sidecar exited: null" used to be all we had). append mode;
// truncated at spawn once it grows past 5MB.
function openSidecarLog() {
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'sidecar.log');
    try {
      if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.truncateSync(logPath, 0);
    } catch {}
    return fs.createWriteStream(logPath, { flags: 'a' });
  } catch (e) {
    console.error(`sidecar log unavailable: ${e.message}`);
    return null;
  }
}

function startSidecar() {
  // EDIABAS data root (vendor/EDIABAS, vendor/EC-APPS, tools/translations).
  // packaged: Resources/data. dev: __dirname/.. . no machine-specific paths.
  const candidates = [
    path.join(process.resourcesPath || '', 'data'),  // packaged
    path.join(__dirname, '..'),                        // dev
  ];
  const dataRoot = candidates.find(c => fs.existsSync(path.join(c, 'vendor', 'EDIABAS')))
                 || path.join(__dirname, '..');
  const env = { ...process.env, BMACW_ROOT: process.env.BMACW_ROOT || dataRoot };

  // bundled self-contained binary if present, else dev `dotnet run`
  const bundled = path.join(process.resourcesPath || '', 'server-dist', 'InpaMac.Server');
  const local = path.join(__dirname, 'server-dist', 'InpaMac.Server');
  let serverBin = null;
  if (fs.existsSync(bundled)) serverBin = bundled;
  else if (fs.existsSync(local)) serverBin = local;

  const log = openSidecarLog();
  const logLine = (msg) => { if (log) log.write(`[${new Date().toISOString()}] ${msg}\n`); };

  let cmdDesc;
  if (serverBin) {
    cmdDesc = serverBin;
    sidecar = spawn(serverBin, [], {
      cwd: path.dirname(serverBin), stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  } else {
    const serverProj = path.join(dataRoot, 'src', 'InpaMac.Server');
    cmdDesc = `dotnet run --project ${serverProj} -c Release`;
    sidecar = spawn('dotnet', ['run', '--project', serverProj, '-c', 'Release'], {
      cwd: dataRoot, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  }
  logLine(`spawn: ${cmdDesc} (pid ${sidecar.pid}, BMACW_ROOT=${env.BMACW_ROOT})`);
  if (sidecar.stdout) sidecar.stdout.pipe(log || process.stdout, { end: false });
  if (sidecar.stderr) sidecar.stderr.pipe(log || process.stderr, { end: false });
  sidecar.on('error', (err) => logLine(`spawn error: ${err.message}`));
  sidecar.on('exit', (code, signal) => {
    sidecarExited = true;
    logLine(`sidecar exited: code=${code} signal=${signal}`);
    console.log(`sidecar exited: code=${code} signal=${signal}`);
    if (log) log.end();
  });
}

function createWindow() {
  // see-through window for the Aero skin. macOS native frame keeps an opaque backing
  // that paints white, so transparent:true alone looks solid. need frame:false +
  // transparent + hasShadow:false; renderer draws its own controls and drag region.
  // no vibrancy: conflicts with transparency on macOS (electron#31862).
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    transparent: true,
    frame: false,                    // frame forces opaque backing on macOS
    hasShadow: false,                // native shadow cant render on transparent window
    backgroundColor: '#00000000',    // transparent base, renderer fills per theme
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--bmacw-version=${app.getVersion()}`],
    },
  });
  // pass sidecar base URL to renderer
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { api: SIDECAR_URL },
  });
}

// CSV logging IPC for Status multi-watch stream-to-file
const logStreams = new Map();
let logSeq = 0;

ipcMain.handle('log:start', async (_evt, suggestedName, header) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Stream Status values to CSV',
    defaultPath: suggestedName || 'bmacw-log.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  const id = String(++logSeq);
  const stream = fs.createWriteStream(res.filePath, { flags: 'w' });
  if (Array.isArray(header)) stream.write(header.map(csvCell).join(',') + '\n');
  logStreams.set(id, stream);
  return { ok: true, id, path: res.filePath };
});

ipcMain.handle('log:append', (_evt, id, cells) => {
  const s = logStreams.get(id);
  if (!s) return { ok: false };
  s.write(cells.map(csvCell).join(',') + '\n');
  return { ok: true };
});

ipcMain.handle('log:stop', (_evt, id) => {
  const s = logStreams.get(id);
  if (s) { s.end(); logStreams.delete(id); }
  return { ok: true };
});

// render a fault report (self-contained HTML) to PDF via an offscreen window,
// then save it through the native dialog. returns { ok, path } or { ok:false }.
ipcMain.handle('pdf:save', async (_evt, suggestedName, html) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save fault report as PDF',
    defaultPath: suggestedName || 'bmacw-faults.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  let worker;
  try {
    worker = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await worker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await worker.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      pageSize: 'Letter',
    });
    fs.writeFileSync(res.filePath, pdf);
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    if (worker && !worker.isDestroyed()) worker.destroy();
  }
});

// set native backgroundColor so opaque themes dont flash the transparent base on
// load/resize. see-through itself is a CSS concern.
ipcMain.handle('window:translucent', (_evt, on) => {
  if (!win) return { ok: false };
  try {
    win.setBackgroundColor(on ? '#00000000' : '#0b0f14');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('window:setDockIcon', (_evt, dataUrl) => {
  if (process.platform === 'darwin' && app.dock) {
    try {
      const img = nativeImage.createFromDataURL(dataUrl);
      app.dock.setIcon(img);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return { ok: false, error: 'Not macOS or app.dock unavailable' };
});

// custom controls for the frameless window
ipcMain.handle('window:close', () => { win && win.close(); });
ipcMain.handle('window:minimize', () => { win && win.minimize(); });
ipcMain.handle('window:zoom', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});

function csvCell(v) {
  const str = v == null ? '' : String(v);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch {}
  }

  // app menu (name comes from first submenu label)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'BMacW',
        submenu: [
          { role: 'about', label: 'About BMacW' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide BMacW' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit BMacW' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  }
  // window first: spawn the sidecar and open the UI immediately. the renderer
  // polls /api/health behind its boot splash, so no 30s blank-app wait here.
  startSidecar();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// tear down sidecar on quit: SIGTERM first so the server can run its
// flash-recovery cleanup, wait up to ~3s for exit, then SIGKILL. pkill only
// as a last resort for orphans not tracked by our child handle.
function stopSidecarGracefully() {
  return new Promise((resolve) => {
    if (!sidecar || sidecarExited) return resolve();
    const child = sidecar;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

// sweep orphaned servers still holding the port (e.g. from a crashed run)
function killOrphans() {
  try {
    require('child_process').execSync(
      "pkill -9 -f InpaMac.Server 2>/dev/null; lsof -ti:8777 2>/dev/null | xargs kill -9 2>/dev/null",
      { stdio: 'ignore', shell: '/bin/sh' });
  } catch {}
}

app.on('window-all-closed', () => {
  app.quit(); // quit on macOS too: closing the window quits BMacW
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault(); // hold quit until the sidecar had its chance to clean up
  stopSidecarGracefully().then(() => {
    killOrphans();
    app.quit();
  });
});

// last-resort sync sweep if the process exits some other way
process.on('exit', () => { if (!quitting) killOrphans(); });
