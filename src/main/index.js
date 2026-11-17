const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const LogAnalyzerEngine = require('../engine/index');
const EmbyApiClient = require('../integrations/emby-api-client');
const PlaybackLogEvidence = require('../integrations/playback-log-evidence');
const EmbyConnectionStore = require('./emby-connection-store');

// In container/CI Linux environments, disable the SUID sandbox requirement
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let mainWindow = null;
let analyzerEngine = new LogAnalyzerEngine();
const embyApiClient = new EmbyApiClient();
let embyConnectionStore = null;
const downloadedLogDirectories = new Set();
const MAX_SELECTED_LOGS = 20;
const MAX_TOTAL_LOG_BYTES = 100 * 1024 * 1024;

function getEmbyConnectionStore() {
  const portableDirectory = app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR;
  const storageDirectory = portableDirectory
    ? path.join(portableDirectory, 'EmbyLogAnalyzerData')
    : app.getPath('userData');
  return new EmbyConnectionStore({
    filePath: path.join(storageDirectory, 'emby-connections.json'),
    safeStorage
  });
}

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
  embyConnectionStore = getEmbyConnectionStore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const directory of downloadedLogDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      console.error('Could not remove temporary Emby logs:', error);
    }
  }
  downloadedLogDirectories.clear();
});

// IPC: File Open Dialog
ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Emby, FFmpeg or Android app logs',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Log & Text Files', extensions: ['txt', 'log'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

// IPC: Run Analysis
ipcMain.handle('analyzer:run', async (event, request) => {
  try {
    const filePaths = Array.isArray(request) ? request : request?.filePaths;
    const clientLogFiles = Array.isArray(request?.clientLogFiles) ? request.clientLogFiles : [];
    if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.some(file => typeof file !== 'string')) {
      throw new Error('Select at least one log file to analyze.');
    }
    if (clientLogFiles.some(file => typeof file !== 'string' || !filePaths.includes(file))) {
      throw new Error('Every Android client log must also be in the selected file list.');
    }
    const clientFileSet = new Set(clientLogFiles);
    for (const file of filePaths) {
      if (/(?:android|client|logcat)/i.test(path.basename(file))) clientFileSet.add(file);
    }
    const analysisFilePaths = filePaths.filter(file => !clientFileSet.has(file));
    const report = await analyzerEngine.analyzeFiles(analysisFilePaths, (progress) => {
      if (mainWindow) {
        mainWindow.webContents.send('analyzer:progress', progress);
      }
    });
    const evidence = await PlaybackLogEvidence.analyze(filePaths, [...clientFileSet]);
    report.clientLogSummary = evidence.clientLogSummary;
    report.serverPlaybackEvidence = evidence.serverPlaybackEvidence;
    report.androidPlaybackGuidance = evidence.androidPlaybackGuidance;
    report.filesSummary = {
      ...report.filesSummary,
      clientLogFilesCount: clientFileSet.size,
      totalFiles: filePaths.length
    };
    return { success: true, data: report };
  } catch (err) {
    console.error('Analysis error:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Fetch one read-only Emby API snapshot
ipcMain.handle('emby:testConnection', async (event, connection) => {
  try {
    const result = await embyApiClient.testConnection(connection);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:connections:list', async () => {
  try {
    return {
      success: true,
      data: {
        connections: await embyConnectionStore.list(),
        storage: embyConnectionStore.storageStatus(),
        portable: Boolean(app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR)
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:connections:save', async (event, connection) => {
  try {
    return { success: true, data: await embyConnectionStore.save(connection) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:connections:remove', async (event, id) => {
  try {
    return { success: true, data: await embyConnectionStore.remove(id) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:fetchSnapshot', async (event, request) => {
  try {
    const connection = await embyConnectionStore.getForRequest(request.connectionId);
    const snapshot = await embyApiClient.fetchSnapshot({
      ...connection,
      includeSystemInfo: request.includeSystemInfo === true,
      includeActivityLog: request.includeActivityLog === true
    });
    return { success: true, data: snapshot };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:logs:list', async (event, request) => {
  try {
    const connection = await embyConnectionStore.getForRequest(request?.connectionId);
    return { success: true, data: await embyApiClient.listServerLogs(connection) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emby:logs:download', async (event, request) => {
  let temporaryDirectory = null;
  try {
    const connection = await embyConnectionStore.getForRequest(request?.connectionId);
    const names = request?.names;
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_SELECTED_LOGS
      || names.some(name => !EmbyApiClient.isSupportedLogName(name))) {
      throw new Error(`Select between 1 and ${MAX_SELECTED_LOGS} supported server log files.`);
    }

    const availableLogs = await embyApiClient.listServerLogs(connection);
    const selectedLogs = names.map(name => {
      const log = availableLogs.find(item => item.name === name);
      if (!log) throw new Error('A selected log is no longer available on the server. Refresh the list.');
      return log;
    });
    if (new Set(names).size !== names.length) throw new Error('The selected log list contains duplicates.');
    const reportedBytes = selectedLogs.reduce((total, log) => total + (log.size || 0), 0);
    if (reportedBytes > MAX_TOTAL_LOG_BYTES) {
      throw new Error('The selected logs exceed the 100 MiB total download limit.');
    }

    temporaryDirectory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'emby-log-analyzer-'));
    downloadedLogDirectories.add(temporaryDirectory);
    const files = [];
    for (const log of selectedLogs) {
      const content = await embyApiClient.fetchServerLog({ ...connection, name: log.name });
      if (content.byteLength > MAX_TOTAL_LOG_BYTES - files.reduce((total, file) => total + file.size, 0)) {
        throw new Error('Downloaded logs exceeded the 100 MiB total download limit.');
      }
      const filePath = path.join(temporaryDirectory, log.name);
      await fs.promises.writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
      files.push({ name: log.name, path: filePath, size: content.byteLength });
    }
    return { success: true, data: { files } };
  } catch (err) {
    if (temporaryDirectory) {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        downloadedLogDirectories.delete(temporaryDirectory);
      } catch (cleanupError) {
        console.error('Could not remove incomplete temporary Emby logs:', cleanupError);
      }
    }
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
