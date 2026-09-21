const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const LogAnalyzerEngine = require('../engine/index');

// In container/CI Linux environments, disable the SUID sandbox requirement
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let mainWindow = null;
let analyzerEngine = new LogAnalyzerEngine();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    title: 'Emby Log Analyzer',
    icon: path.join(__dirname, '../../assets/logo.png'),
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: File Open Dialog
ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Emby Server and FFmpeg Logs',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Log & Text Files', extensions: ['txt', 'log'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

// IPC: Run Analysis
ipcMain.handle('analyzer:run', async (event, filePaths) => {
  try {
    const report = await analyzerEngine.analyzeFiles(filePaths, (progress) => {
      if (mainWindow) {
        mainWindow.webContents.send('analyzer:progress', progress);
      }
    });
    return { success: true, data: report };
  } catch (err) {
    console.error('Analysis error:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Export Report
ipcMain.handle('dialog:saveExport', async (event, { format, data }) => {
  if (!mainWindow) return { canceled: true };
  const extensions = format === 'json' ? ['json'] : (format === 'markdown' ? ['md'] : ['html']);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export Diagnostic Report (${format.toUpperCase()})`,
    defaultPath: `emby-diagnostic-report.${extensions[0]}`,
    filters: [{ name: format.toUpperCase(), extensions }]
  });

  if (!result.canceled && result.filePath) {
    const exportedText = analyzerEngine.exportReport(data, format);
    fs.writeFileSync(result.filePath, exportedText, 'utf8');
    return { success: true, filePath: result.filePath };
  }

  return { canceled: true };
});

// IPC: Read sample dataset for quick demo in UI
ipcMain.handle('app:loadSample', async (event, sampleFolder) => {
  const sampleDir = path.join(__dirname, '../../test-datasets', sampleFolder);
  if (fs.existsSync(sampleDir)) {
    const files = fs.readdirSync(sampleDir)
      .filter(f => f.endsWith('.txt') || f.endsWith('.log'))
      .map(f => path.join(sampleDir, f));
    return { success: true, files };
  }
  return { success: false, error: 'Sample not found' };
});
