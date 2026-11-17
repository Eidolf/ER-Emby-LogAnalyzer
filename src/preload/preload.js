const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  runAnalysis: (filePaths) => ipcRenderer.invoke('analyzer:run', filePaths),
  fetchEmbySnapshot: (connection) => ipcRenderer.invoke('emby:fetchSnapshot', connection),
  listEmbyServerLogs: (connection) => ipcRenderer.invoke('emby:logs:list', connection),
  downloadEmbyServerLogs: (request) => ipcRenderer.invoke('emby:logs:download', request),
  testEmbyConnection: (connection) => ipcRenderer.invoke('emby:testConnection', connection),
  listEmbyConnections: () => ipcRenderer.invoke('emby:connections:list'),
  saveEmbyConnection: (connection) => ipcRenderer.invoke('emby:connections:save', connection),
  removeEmbyConnection: (id) => ipcRenderer.invoke('emby:connections:remove', id),
  saveExport: (format, data) => ipcRenderer.invoke('dialog:saveExport', { format, data }),
  getPathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : (file.path || null)),
  onProgress: (callback) => {
    const handler = (event, val) => callback(val);
    ipcRenderer.on('analyzer:progress', handler);
    return () => ipcRenderer.removeListener('analyzer:progress', handler);
  }
});
