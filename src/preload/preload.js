const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  runAnalysis: (filePaths) => ipcRenderer.invoke('analyzer:run', filePaths),
  saveExport: (format, data) => ipcRenderer.invoke('dialog:saveExport', { format, data }),
  loadSample: (sampleFolder) => ipcRenderer.invoke('app:loadSample', sampleFolder),
  onProgress: (callback) => {
    const handler = (event, val) => callback(val);
    ipcRenderer.on('analyzer:progress', handler);
    return () => ipcRenderer.removeListener('analyzer:progress', handler);
  }
});
