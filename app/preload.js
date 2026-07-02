// file-logging bridge for Status multi-watch stream-to-file
const { contextBridge, ipcRenderer } = require('electron');

const { version } = require('./package.json');

contextBridge.exposeInMainWorld('bmacw', {
  // app version, for the settings page
  version,
  // save dialog + start CSV log. returns { ok, path } or { ok:false }
  startLog: (suggestedName, header) => ipcRenderer.invoke('log:start', suggestedName, header),
  // append one CSV row
  appendLog: (id, cells) => ipcRenderer.invoke('log:append', id, cells),
  stopLog: (id) => ipcRenderer.invoke('log:stop', id),
  // render report HTML to PDF + save dialog. returns { ok, path } or { ok:false }
  savePdf: (suggestedName, html) => ipcRenderer.invoke('pdf:save', suggestedName, html),
  // native background transparent vs solid per theme
  setTranslucent: (on) => ipcRenderer.invoke('window:translucent', on),
  setDockIcon: (dataUrl) => ipcRenderer.invoke('window:setDockIcon', dataUrl),
  // frameless window controls
  winClose: () => ipcRenderer.invoke('window:close'),
  winMinimize: () => ipcRenderer.invoke('window:minimize'),
  winZoom: () => ipcRenderer.invoke('window:zoom'),
});
