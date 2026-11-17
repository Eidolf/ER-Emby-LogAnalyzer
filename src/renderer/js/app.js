// Client-side Application Logic for Emby Log Analyzer Desktop
let stagedFiles = [];
let clientLogFiles = [];
let currentAnalysis = null;
let embySnapshot = null;
let scenarioCaptures = [];
let snapshotComparison = null;
let currentFilter = 'all';

// DOM Elements
const dropZone = document.getElementById('dropZone');
const btnBrowseFiles = document.getElementById('btnBrowseFiles');
const btnAnalyze = document.getElementById('btnAnalyze');
const fileList = document.getElementById('fileList');
const fileCountBadge = document.getElementById('fileCountBadge');
const emptyState = document.getElementById('emptyState');
const resultsDashboard = document.getElementById('resultsDashboard');

const metricHealth = document.getElementById('metricHealth');
const metricTotal = document.getElementById('metricTotal');
const metricSuccess = document.getElementById('metricSuccess');
const metricWarning = document.getElementById('metricWarning');
const metricError = document.getElementById('metricError');
const aiBriefingText = document.getElementById('aiBriefingText');
const sessionsList = document.getElementById('sessionsList');

const btnExportHtml = document.getElementById('btnExportHtml');
const btnExportMarkdown = document.getElementById('btnExportMarkdown');
const btnExportJson = document.getElementById('btnExportJson');
const embyApiUrl = document.getElementById('embyApiUrl');
const embyApiToken = document.getElementById('embyApiToken');
const embyConnectionName = document.getElementById('embyConnectionName');
const embyConnectionSelect = document.getElementById('embyConnectionSelect');
const embyClearSavedToken = document.getElementById('embyClearSavedToken');
const embyCredentialStorage = document.getElementById('embyCredentialStorage');
const settingsDialog = document.getElementById('settingsDialog');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const btnNewEmbyConnection = document.getElementById('btnNewEmbyConnection');
const btnSaveEmbyConnection = document.getElementById('btnSaveEmbyConnection');
const btnDeleteEmbyConnection = document.getElementById('btnDeleteEmbyConnection');
const btnFetchEmbySnapshot = document.getElementById('btnFetchEmbySnapshot');
const btnClearEmbySnapshot = document.getElementById('btnClearEmbySnapshot');
const embyApiStatus = document.getElementById('embyApiStatus');
const embyApiSnapshotPanel = document.getElementById('embyApiSnapshot');
const btnTestEmbyConnection = document.getElementById('btnTestEmbyConnection');
const embyIncludeSystemInfo = document.getElementById('embyIncludeSystemInfo');
const embyIncludeActivityLog = document.getElementById('embyIncludeActivityLog');
const embyScenarioControls = document.getElementById('embyScenarioControls');
const embyScenarioSession = document.getElementById('embyScenarioSession');
const btnCaptureEmbyScenario = document.getElementById('btnCaptureEmbyScenario');
const btnClearEmbyScenarios = document.getElementById('btnClearEmbyScenarios');
const embyScenarioStatus = document.getElementById('embyScenarioStatus');
const embyScenarioComparison = document.getElementById('embyScenarioComparison');
const embyScenarioSessionChoice = document.getElementById('embyScenarioSessionChoice');
const btnCancelScenarioChoice = document.getElementById('btnCancelScenarioChoice');
const btnListServerLogs = document.getElementById('btnListServerLogs');
const btnDownloadServerLogs = document.getElementById('btnDownloadServerLogs');
const serverLogList = document.getElementById('serverLogList');
const serverLogStatus = document.getElementById('serverLogStatus');
const clientLogGuidance = document.getElementById('clientLogGuidance');
const clientLogGuidanceText = document.getElementById('clientLogGuidanceText');
const clientLogStatus = document.getElementById('clientLogStatus');
const btnAddAndroidClientLog = document.getElementById('btnAddAndroidClientLog');
let embyConnections = [];
let availableServerLogs = [];
let currentConnectionId = '';
let pendingScenarioSnapshot = null;
let pendingScenarioContext = null;
let scenarioCaptureInProgress = false;
let serverLogsBusy = false;
let embyRequestBusy = false;

// File Selection & Drag-and-Drop
btnBrowseFiles.addEventListener('click', async () => {
  if (window.electronAPI) {
    const res = await window.electronAPI.openFiles();
    if (!res.canceled && res.filePaths) {
      addFiles(res.filePaths);
    }
  }
});

btnOpenSettings.addEventListener('click', async () => {
  await openConnectionSettings('connectionsSectionTitle');
});

async function openConnectionSettings(sectionId) {
  settingsDialog.showModal();
  await loadEmbyConnections();
  document.getElementById(sectionId).scrollIntoView({ block: 'start' });
}

document.querySelectorAll('[data-guide-action]').forEach(button => {
  button.addEventListener('click', async () => {
    const action = button.dataset.guideAction;
    const workflow = { server: 'workflowServer', mobile: 'workflowMobile', comparison: 'workflowComparison' }[action];
    if (workflow) {
      const panel = document.getElementById(workflow);
      panel.open = true;
      panel.querySelector('summary').focus();
      panel.scrollIntoView({ block: 'start' });
    } else if (action === 'local-logs') {
      btnBrowseFiles.click();
    } else if (action === 'server-logs' || action === 'connections') {
      await openConnectionSettings(action === 'server-logs' ? 'serverLogsTitle' : 'connectionsSectionTitle');
    } else if (action === 'android-logs') {
      await attachAndroidLogs();
    } else if (action === 'capture') {
      await loadEmbyConnections();
      embyScenarioControls.open = true;
      embyScenarioControls.querySelector('summary').focus();
      embyScenarioControls.scrollIntoView({ block: 'start' });
    } else if (action === 'results') {
      document.getElementById('clientLogGuidanceTitle').focus({ preventScroll: true });
      clientLogGuidance.scrollIntoView({ block: 'start' });
    }
  });
});

btnNewEmbyConnection.addEventListener('click', () => {
  setEmbySnapshot(null);
  currentConnectionId = '';
  embyConnectionSelect.value = '';
  embyConnectionName.value = '';
  embyApiUrl.value = 'http://localhost:8096/emby';
  embyApiToken.value = '';
  embyApiToken.placeholder = 'No API key saved';
  embyClearSavedToken.checked = false;
  embyClearSavedToken.disabled = true;
  btnDeleteEmbyConnection.disabled = true;
  embyApiStatus.textContent = 'Enter a name and server URL. Save a key to reuse it for later snapshots.';
  availableServerLogs = [];
  renderServerLogOptions();
  updateScenarioCaptureButton();
});

embyConnectionSelect.addEventListener('change', () => {
  currentConnectionId = embyConnectionSelect.value;
  const connection = embyConnections.find(item => item.id === currentConnectionId);
  if (!connection) {
    setEmbySnapshot(null);
    embyConnectionName.value = '';
    embyApiUrl.value = 'http://localhost:8096/emby';
    embyApiToken.value = '';
    embyApiToken.placeholder = 'No API key saved';
    embyClearSavedToken.checked = false;
    embyClearSavedToken.disabled = true;
    btnDeleteEmbyConnection.disabled = true;
    embyApiStatus.textContent = 'Enter a name and server URL. Save a key to reuse it for later snapshots.';
    availableServerLogs = [];
    renderServerLogOptions();
    updateScenarioCaptureButton();
    return;
  }
  setEmbySnapshot(null);
  embyConnectionName.value = connection.name;
  embyApiUrl.value = connection.baseUrl;
  embyApiToken.value = '';
  embyApiToken.placeholder = connection.hasToken
    ? connection.tokenStorage === 'persistent' ? 'API key saved securely' : 'Key held in memory until the app closes'
    : 'No API key saved';
  embyClearSavedToken.checked = false;
  embyClearSavedToken.disabled = !connection.hasToken;
  btnDeleteEmbyConnection.disabled = false;
  embyApiStatus.textContent = connection.hasToken
    ? 'Connection selected. The saved API key is never displayed.'
    : 'Connection selected. Add an API key to fetch snapshots.';
  availableServerLogs = [];
  renderServerLogOptions();
  updateScenarioCaptureButton();
});

async function loadEmbyConnections() {
  if (!window.electronAPI?.listEmbyConnections) {
    embyApiStatus.textContent = 'Emby connection settings are available in the desktop app.';
    return;
  }
  try {
    const result = await window.electronAPI.listEmbyConnections();
    if (!result.success) throw new Error(result.error);
    embyConnections = result.data.connections;
    renderConnectionOptions();
    const { storage, portable } = result.data;
    if (storage.persistentCredentials) {
      embyCredentialStorage.textContent = portable
        ? `Portable profile folder; API keys are encrypted with this OS account (${storage.backend}) and will not decrypt on another machine.`
        : `API keys are encrypted with this OS credential store (${storage.backend}).`;
      embyCredentialStorage.classList.remove('storage-warning');
    } else {
      embyCredentialStorage.textContent = 'No secure OS keyring is available. API keys stay in memory until the app closes and are never written to disk.';
      embyCredentialStorage.classList.add('storage-warning');
    }
    if (currentConnectionId) embyConnectionSelect.value = currentConnectionId;
    else if (embyConnections.length === 1) {
      embyConnectionSelect.value = embyConnections[0].id;
      embyConnectionSelect.dispatchEvent(new Event('change'));
    } else {
      updateScenarioCaptureButton();
    }
    updateServerLogButtons();
  } catch (error) {
    embyApiStatus.textContent = `Could not load saved connections: ${error.message}`;
  }
}

function renderConnectionOptions() {
  embyConnectionSelect.replaceChildren();
  const newOption = document.createElement('option');
  newOption.value = '';
  newOption.textContent = 'New connection';
  embyConnectionSelect.appendChild(newOption);
  for (const connection of embyConnections) {
    const option = document.createElement('option');
    option.value = connection.id;
    option.textContent = `${connection.name}${connection.hasToken ? ' · key saved' : ' · no key'}`;
    embyConnectionSelect.appendChild(option);
  }
}

function selectedConnectionHasUnsavedChanges() {
  const connection = embyConnections.find(item => item.id === currentConnectionId);
  return !connection
    || embyConnectionName.value.trim() !== connection.name
    || embyApiUrl.value.trim() !== connection.baseUrl
    || Boolean(embyApiToken.value.trim())
    || embyClearSavedToken.checked;
}

function updateServerLogButtons() {
  const connection = embyConnections.find(item => item.id === currentConnectionId);
  const canUseConnection = Boolean(connection?.hasToken) && !selectedConnectionHasUnsavedChanges();
  document.getElementById('workflowConnectionStatus').textContent = canUseConnection
    ? `Saved connection: ${connection.name}. Its saved key will be reused. Server log access still requires administrator permission.`
    : 'API prerequisite: select or create a connection and save any changes and its API key in Settings. Local files need no connection.';
  btnListServerLogs.disabled = embyRequestBusy || serverLogsBusy || !canUseConnection;
  btnDownloadServerLogs.disabled = embyRequestBusy || serverLogsBusy || !canUseConnection
    || serverLogList.querySelectorAll('input[type="checkbox"]:checked').length === 0;
}

function renderServerLogOptions() {
  serverLogList.replaceChildren();
  for (const log of availableServerLogs) {
    const label = document.createElement('label');
    label.className = 'server-log-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = log.name;
    checkbox.addEventListener('change', updateServerLogButtons);
    const description = document.createElement('span');
    const size = log.size == null ? 'size unknown' : `${(log.size / (1024 * 1024)).toFixed(2)} MiB`;
    const modified = log.dateModified ? new Date(log.dateModified).toLocaleString() : 'modified time unknown';
    description.textContent = `${log.name} — ${size}; modified ${modified}`;
    label.append(checkbox, description);
    serverLogList.appendChild(label);
  }
  updateServerLogButtons();
}

btnListServerLogs.addEventListener('click', async () => {
  if (!window.electronAPI || !currentConnectionId) return;
  serverLogsBusy = true;
  updateServerLogButtons();
  serverLogStatus.textContent = 'Listing available Emby and FFmpeg logs (administrator permission required)...';
  try {
    const result = await window.electronAPI.listEmbyServerLogs({ connectionId: currentConnectionId });
    if (!result.success) throw new Error(result.error);
    availableServerLogs = result.data;
    renderServerLogOptions();
    serverLogStatus.textContent = availableServerLogs.length
      ? `${availableServerLogs.length} relevant log file(s) listed. Choose only files covering the incident.`
      : 'The server returned no Emby or FFmpeg log files.';
  } catch (error) {
    serverLogStatus.textContent = `Could not list server logs: ${error.message}`;
  } finally {
    serverLogsBusy = false;
    updateServerLogButtons();
  }
});

btnDownloadServerLogs.addEventListener('click', async () => {
  if (!window.electronAPI || !currentConnectionId || serverLogsBusy) return;
  const names = Array.from(serverLogList.querySelectorAll('input[type="checkbox"]:checked'))
    .map(checkbox => checkbox.value);
  if (!names.length) return;
  serverLogsBusy = true;
  updateServerLogButtons();
  serverLogStatus.textContent = 'Downloading selected logs securely to temporary local storage...';
  try {
    const result = await window.electronAPI.downloadEmbyServerLogs({
      connectionId: currentConnectionId,
      names
    });
    if (!result.success) throw new Error(result.error);
    const files = result.data.files.map(file => file.path);
    addFiles(files);
    settingsDialog.close();
    serverLogStatus.textContent = `Downloaded ${files.length} log file(s). Analyzing selected logs...`;
    await runAnalysis();
  } catch (error) {
    serverLogStatus.textContent = `Could not download or analyze server logs: ${error.message}`;
  } finally {
    serverLogsBusy = false;
    updateServerLogButtons();
  }
});

btnSaveEmbyConnection.addEventListener('click', async () => {
  if (!window.electronAPI) return;
  btnSaveEmbyConnection.disabled = true;
  embyApiStatus.textContent = 'Saving connection...';
  try {
    const token = embyApiToken.value;
    const id = currentConnectionId || crypto.randomUUID();
    const result = await window.electronAPI.saveEmbyConnection({
      id,
      name: embyConnectionName.value,
      baseUrl: embyApiUrl.value,
      token,
      clearToken: embyClearSavedToken.checked && !token.trim()
    });
    if (!result.success) throw new Error(result.error);
    currentConnectionId = id;
    embyConnections = result.data;
    embyApiToken.value = '';
    embyClearSavedToken.checked = false;
    renderConnectionOptions();
    embyConnectionSelect.value = id;
    const connection = embyConnections.find(item => item.id === id);
    if (connection) {
      embyConnectionName.value = connection.name;
      embyApiUrl.value = connection.baseUrl;
    }
    embyApiToken.placeholder = connection?.tokenStorage === 'persistent'
      ? 'API key saved securely'
      : connection?.tokenStorage === 'session' ? 'Key held in memory until the app closes' : 'No API key saved';
    embyClearSavedToken.disabled = !connection?.hasToken;
    btnDeleteEmbyConnection.disabled = false;
    embyApiStatus.textContent = 'Connection saved. The API key was not sent back to the interface.';
    updateScenarioCaptureButton(false);
    await loadEmbyConnections();
  } catch (error) {
    embyApiStatus.textContent = `Could not save connection: ${error.message}`;
  } finally {
    btnSaveEmbyConnection.disabled = false;
  }
});

btnDeleteEmbyConnection.addEventListener('click', async () => {
  if (!currentConnectionId || !window.electronAPI) return;
  btnDeleteEmbyConnection.disabled = true;
  try {
    const result = await window.electronAPI.removeEmbyConnection(currentConnectionId);
    if (!result.success) throw new Error(result.error);
    embyConnections = result.data;
    currentConnectionId = '';
    renderConnectionOptions();
    setEmbySnapshot(null);
    btnNewEmbyConnection.click();
    embyApiStatus.textContent = 'Connection and its saved API key were deleted.';
  } catch (error) {
    btnDeleteEmbyConnection.disabled = false;
    embyApiStatus.textContent = `Could not delete connection: ${error.message}`;
  }
});

btnTestEmbyConnection.addEventListener('click', async () => {
  if (!window.electronAPI) return;
  setEmbyBusy(true);
  embyApiStatus.textContent = 'Testing public server URL without credentials...';
  try {
    const result = await window.electronAPI.testEmbyConnection({ baseUrl: embyApiUrl.value });
    embyApiStatus.textContent = result.success
      ? `Public URL reachable: ${result.data.server.name || 'Emby'} ${result.data.server.version || ''}. Token and session permissions NOT tested. ${result.data.warnings.join(' ')}`
      : `Connection test failed: ${result.error}`;
  } catch (error) {
    embyApiStatus.textContent = `Connection test failed: ${error.message}`;
  } finally {
    setEmbyBusy(false);
  }
});

embyApiUrl.addEventListener('input', () => {
  setEmbySnapshot(null);
  embyApiStatus.textContent = 'Server URL changed. Fetch a new snapshot.';
  updateScenarioCaptureButton();
});

for (const control of [embyConnectionName, embyApiToken]) {
  control.addEventListener('input', () => updateScenarioCaptureButton());
}
embyClearSavedToken.addEventListener('change', () => updateScenarioCaptureButton());

function setEmbyBusy(busy) {
  embyRequestBusy = busy;
  for (const control of [btnFetchEmbySnapshot, btnTestEmbyConnection, embyApiUrl,
    embyApiToken, embyIncludeSystemInfo, embyIncludeActivityLog, embyConnectionSelect,
    embyConnectionName, btnNewEmbyConnection, btnSaveEmbyConnection,
    btnDeleteEmbyConnection]) {
    control.disabled = busy;
  }
  embyClearSavedToken.disabled = busy
    || !embyConnections.find(connection => connection.id === currentConnectionId)?.hasToken;
  btnClearEmbySnapshot.disabled = busy || !embySnapshot;
  updateServerLogButtons();
}

btnFetchEmbySnapshot.addEventListener('click', async () => {
  if (!window.electronAPI) return;

  setEmbySnapshot(null);
  embyApiStatus.textContent = 'Fetching one read-only snapshot...';
  setEmbyBusy(true);

  try {
    const result = await window.electronAPI.fetchEmbySnapshot({
      connectionId: currentConnectionId,
      includeSystemInfo: embyIncludeSystemInfo.checked,
      includeActivityLog: embyIncludeActivityLog.checked
    });

    if (!result.success) {
      embyApiStatus.textContent = `Emby API request failed: ${result.error}`;
      return;
    }

    setEmbySnapshot(result.data);
    const sessionCount = result.data.sessions.length;
    embyApiStatus.textContent = `Snapshot captured at ${new Date(result.data.capturedAt).toLocaleString()} (${sessionCount} connected ${sessionCount === 1 ? 'session' : 'sessions'}). ${result.data.warnings.length} warning(s). No automatic refresh.`;
    settingsDialog.close();
  } catch (error) {
    embyApiStatus.textContent = `Emby API request failed: ${error.message}`;
  } finally {
    setEmbyBusy(false);
  }
});

btnClearEmbySnapshot.addEventListener('click', () => {
  setEmbySnapshot(null);
  embyApiStatus.textContent = 'Snapshot cleared.';
});

function setEmbySnapshot(snapshot) {
  embySnapshot = snapshot;
  if (currentAnalysis) {
    if (snapshot) currentAnalysis.embySnapshot = snapshot;
    else delete currentAnalysis.embySnapshot;
  }

  btnClearEmbySnapshot.disabled = !snapshot;
  updateExportButtons();
  emptyState.style.display = snapshot || currentAnalysis || snapshotComparison ? 'none' : 'flex';
  renderEmbySnapshot(snapshot);
}

function updateScenarioCaptureButton(updateStatus = true) {
  updateServerLogButtons();
  const connection = embyConnections.find(item => item.id === currentConnectionId);
  const hasUnsavedChanges = !connection
    || embyConnectionName.value.trim() !== connection.name
    || embyApiUrl.value.trim() !== connection.baseUrl
    || Boolean(embyApiToken.value.trim())
    || embyClearSavedToken.checked;
  btnCaptureEmbyScenario.disabled = scenarioCaptureInProgress
    || Boolean(pendingScenarioSnapshot)
    || !currentConnectionId
    || !connection?.hasToken
    || hasUnsavedChanges
    || scenarioCaptures.length >= 6;

  if (!updateStatus || scenarioCaptureInProgress || pendingScenarioSnapshot) return;
  if (!currentConnectionId) {
    embyScenarioStatus.textContent = 'Open Settings and select a saved Emby connection to capture.';
  } else if (!connection?.hasToken) {
    embyScenarioStatus.textContent = 'Save an API key for the selected connection in Settings before capturing.';
  } else if (hasUnsavedChanges) {
    embyScenarioStatus.textContent = 'Save the selected connection changes before capturing.';
  } else if (scenarioCaptures.length >= 6) {
    embyScenarioStatus.textContent = 'Capture limit reached (6). Clear captures to start another comparison.';
  } else {
    embyScenarioStatus.textContent = `${scenarioCaptures.length}/6 captures. Each capture fetches and saves a fresh snapshot.`;
  }
}

function getScenarioContext() {
  return {
    label: document.getElementById('embyScenarioLabel').value,
    network: document.getElementById('embyScenarioNetwork').value,
    launchSurface: document.getElementById('embyScenarioSurface').value,
    outcome: document.getElementById('embyScenarioOutcome').value
  };
}

btnCaptureEmbyScenario.addEventListener('click', async () => {
  if (!window.electronAPI || scenarioCaptureInProgress || pendingScenarioSnapshot) return;
  if (!currentConnectionId) {
    embyScenarioStatus.textContent = 'Open Settings and select a saved Emby connection before capturing.';
    return;
  }
  if (scenarioCaptures.length >= 6) {
    updateScenarioCaptureButton();
    return;
  }

  const context = getScenarioContext();
  try {
    SnapshotComparison.validateContext(context);
  } catch (error) {
    embyScenarioStatus.textContent = `Capture not started: ${error.message}`;
    return;
  }

  scenarioCaptureInProgress = true;
  updateScenarioCaptureButton(false);
  embyApiStatus.textContent = 'Fetching a fresh read-only snapshot for this scenario...';
  embyScenarioStatus.textContent = 'Fetching a fresh read-only snapshot...';
  try {
    const result = await window.electronAPI.fetchEmbySnapshot({
      connectionId: currentConnectionId,
      includeSystemInfo: embyIncludeSystemInfo.checked,
      includeActivityLog: embyIncludeActivityLog.checked
    });
    if (!result.success) throw new Error(result.error);

    const snapshot = result.data;
    if (snapshot.sessions.length <= 1) {
      saveScenarioCapture(snapshot, snapshot.sessions.length === 1 ? 0 : null, context);
      return;
    }

    pendingScenarioSnapshot = snapshot;
    pendingScenarioContext = context;
    populateScenarioSessionChoices(snapshot);
    embyScenarioControls.open = true;
    embyScenarioStatus.textContent = 'Fresh snapshot received. Choose the intended session; the capture is saved immediately after selection.';
  } catch (error) {
    embyScenarioStatus.textContent = `Capture failed: ${error.message}`;
    embyApiStatus.textContent = `Scenario snapshot request failed: ${error.message}`;
  } finally {
    scenarioCaptureInProgress = false;
    updateScenarioCaptureButton(false);
  }
});

function populateScenarioSessionChoices(snapshot) {
  embyScenarioSession.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a session to capture';
  embyScenarioSession.appendChild(placeholder);
  for (const [index, session] of snapshot.sessions.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = [session.deviceName, session.client, session.mediaItem?.name, session.id]
      .filter(Boolean).join(' / ');
    embyScenarioSession.appendChild(option);
  }
  const absent = document.createElement('option');
  absent.value = 'none';
  absent.textContent = 'No selected session (not proof of session end)';
  embyScenarioSession.appendChild(absent);
  embyScenarioSession.disabled = false;
  embyScenarioSessionChoice.hidden = false;
  embyScenarioSession.value = '';
}

btnCancelScenarioChoice.addEventListener('click', () => {
  pendingScenarioSnapshot = null;
  pendingScenarioContext = null;
  embyScenarioSessionChoice.hidden = true;
  embyScenarioSession.disabled = true;
  embyScenarioStatus.textContent = 'Fresh snapshot discarded; no scenario capture was saved.';
  updateScenarioCaptureButton(false);
});

embyScenarioSession.addEventListener('change', () => {
  if (!pendingScenarioSnapshot || embyScenarioSession.value === '') return;
  const snapshot = pendingScenarioSnapshot;
  const context = pendingScenarioContext;
  const sessionIndex = embyScenarioSession.value === 'none' ? null : Number(embyScenarioSession.value);
  pendingScenarioSnapshot = null;
  pendingScenarioContext = null;
  embyScenarioSessionChoice.hidden = true;
  embyScenarioSession.disabled = true;
  saveScenarioCapture(snapshot, sessionIndex, context);
  updateScenarioCaptureButton(false);
});

function saveScenarioCapture(snapshot, sessionIndex, context) {
  try {
    const capture = SnapshotComparison.capture(snapshot, sessionIndex, context);
    const next = [...scenarioCaptures, capture];
    const comparison = SnapshotComparison.compare(next);
    scenarioCaptures = next;
    snapshotComparison = comparison;
    if (currentAnalysis) currentAnalysis.snapshotComparison = snapshotComparison;
    btnClearEmbyScenarios.disabled = false;
    renderScenarioComparison();
    updateExportButtons();
    updateScenarioCaptureButton(false);
    embyScenarioStatus.textContent = `${scenarioCaptures.length}/6 captures saved. This capture keeps its own snapshot and is independent of the visible live snapshot.`;
    if (document.getElementById('embyScenarioLabel').value.trim() === context.label.trim()) {
      document.getElementById('embyScenarioLabel').value = String.fromCharCode(65 + scenarioCaptures.length);
    }
  } catch (error) {
    embyScenarioStatus.textContent = `Capture could not be saved: ${error.message}`;
    updateScenarioCaptureButton(false);
  }
}

btnClearEmbyScenarios.addEventListener('click', () => {
  scenarioCaptures = [];
  snapshotComparison = null;
  if (currentAnalysis) delete currentAnalysis.snapshotComparison;
  btnClearEmbyScenarios.disabled = true;
  pendingScenarioSnapshot = null;
  pendingScenarioContext = null;
  embyScenarioSessionChoice.hidden = true;
  embyScenarioSession.disabled = true;
  renderScenarioComparison();
  updateExportButtons();
  updateScenarioCaptureButton();
  embyScenarioStatus.textContent = 'Comparison captures cleared.';
  emptyState.style.display = embySnapshot || currentAnalysis ? 'none' : 'flex';
});

function renderScenarioComparison() {
  embyScenarioComparison.replaceChildren();
  embyScenarioComparison.hidden = !snapshotComparison;
  if (!snapshotComparison) return;
  const title = document.createElement('h2');
  title.textContent = 'Manual scenario comparison';
  embyScenarioComparison.appendChild(title);
  const scope = document.createElement('p');
  scope.className = 'emby-api-note';
  scope.textContent = snapshotComparison.scope;
  embyScenarioComparison.appendChild(scope);
  for (const correlation of snapshotComparison.correlations) {
    const note = document.createElement('p');
    note.textContent = `${scenarioCaptures[correlation.from].label} → ${scenarioCaptures[correlation.to].label}: ${correlation.observation}`;
    embyScenarioComparison.appendChild(note);
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'emby-comparison-table';
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const name of ['Field / comparison', ...scenarioCaptures.map(capture => capture.label)]) {
    const cell = document.createElement('th');
    cell.textContent = name;
    header.appendChild(cell);
  }
  const body = table.createTBody();
  for (const row of snapshotComparison.rows) {
    const tr = body.insertRow();
    if (row.status === 'different') tr.className = 'emby-api-warning';
    for (const value of [`${row.field} (${row.status})`, ...row.values]) {
      tr.insertCell().textContent = value ?? 'Unknown / not supplied';
    }
  }
  wrapper.appendChild(table);
  embyScenarioComparison.appendChild(wrapper);
}

function updateExportButtons() {
  for (const button of [btnExportHtml, btnExportMarkdown, btnExportJson]) {
    button.disabled = !currentAnalysis && !embySnapshot && !snapshotComparison;
  }
}

function renderEmbySnapshot(snapshot) {
  embyApiSnapshotPanel.replaceChildren();
  embyApiSnapshotPanel.hidden = !snapshot;
  if (!snapshot) return;

  const appendText = (parent, tag, text, className = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  };
  appendText(embyApiSnapshotPanel, 'h2', 'Emby API snapshot (read-only)');
  appendText(embyApiSnapshotPanel, 'p',
    `Captured ${new Date(snapshot.capturedAt).toLocaleString()}. Point-in-time data, not a live monitor or log-derived root cause.`, 'emby-api-note');
  const server = snapshot.server || {};
  const serverSummary = document.createElement('div');
  serverSummary.className = 'emby-api-server';
  serverSummary.textContent = [
    server.name || 'Emby Server',
    server.version ? `v${server.version}` : null,
    server.operatingSystemDisplayName || server.operatingSystem
  ].filter(Boolean).join(' · ');
  embyApiSnapshotPanel.appendChild(serverSummary);

  for (const warning of snapshot.warnings || []) {
    appendText(embyApiSnapshotPanel, 'p', warning, 'emby-api-warning');
  }
  for (const [label, value] of [
    ['Pending server restart', server.hasPendingRestart],
    ['Server shutting down', server.isShuttingDown]
  ]) {
    if (typeof value === 'boolean') appendText(embyApiSnapshotPanel, 'p', `${label}: ${value ? 'yes' : 'no'}`);
  }
  const endpointText = Object.entries(snapshot.endpointStatus || {})
    .map(([name, result]) => `${name}: ${result.status}`).join(' / ');
  appendText(embyApiSnapshotPanel, 'p', endpointText, 'emby-api-note');
  const summary = snapshot.summary;
  if (summary) {
    appendText(embyApiSnapshotPanel, 'p',
      `${summary.connected} connected / ${summary.playing} playing / ${summary.paused} paused / ${summary.playbackStateUnknown ?? 0} playback state unknown / ${summary.idle} idle / ${summary.transcodes} transcode info present / ${summary.hardwareVideo} hardware video / ${summary.softwareVideo} software video`);
  }

  appendText(embyApiSnapshotPanel, 'h3', 'Connected sessions returned by the API');
  if (snapshot.sessions.length === 0) appendText(embyApiSnapshotPanel, 'p', 'No connected sessions returned.', 'emby-api-note');

  for (const session of snapshot.sessions) {
    const card = document.createElement('div');
    card.className = 'emby-api-session';

    const title = document.createElement('strong');
    title.textContent = session.mediaItem?.name || 'No current media item';
    card.appendChild(title);

    const details = [
      [session.userName, [session.client, session.deviceName].filter(Boolean).join(' / ')].filter(Boolean).join(' · '),
      session.playState?.playMethod ? `Method: ${session.playState.playMethod}` : null,
      !session.mediaItem ? 'Idle' : session.playState?.isPaused === true ? 'Paused'
        : session.playState?.isPaused === false ? 'Playing' : 'Playback state unknown',
      session.applicationVersion ? `App version: ${session.applicationVersion}` : null,
      session.deviceType ? `Device type: ${session.deviceType}` : null,
      session.id ? `Session ID: ${session.id}` : null,
      session.deviceId ? `Device ID: ${session.deviceId}` : null,
      session.remoteEndPoint ? `Remote endpoint: ${session.remoteEndPoint}` : null,
      session.lastActivityDate ? `Last activity: ${session.lastActivityDate}` : null
    ];
    if (session.playlist) {
      details.push(`Playlist index / length (raw): ${session.playlist.index ?? '?'} / ${session.playlist.length ?? '?'}`);
    }
    if (session.playState?.positionTicks != null) {
      details.push(`Position: ${(session.playState.positionTicks / 10000000).toFixed(1)}s`);
    }
    const sourceAudio = SnapshotComparison.audioDescription(session.mediaSource?.audioStreams);
    const itemAudio = SnapshotComparison.audioDescription(session.mediaItem?.audioStreams);
    if (sourceAudio) details.push(`Playback source audio: ${sourceAudio}`);
    if (itemAudio) details.push(`Item audio metadata (candidates): ${itemAudio}`);
    if (session.playState?.mediaSourceId) details.push(`Media source ID: ${session.playState.mediaSourceId}`);
    if (session.playState?.repeatMode) details.push(`Repeat: ${session.playState.repeatMode}`);
    if (session.playState?.sleepTimerMode) details.push(`Sleep timer: ${session.playState.sleepTimerMode}`);
    const transcode = session.transcodingInfo;
    if (transcode) {
      const codecs = [transcode.videoCodec, transcode.audioCodec].filter(Boolean).join(' / ');
      if (codecs) details.push(`Codecs: ${codecs}`);
      if (transcode.transcodeReasons.length > 0) {
        details.push(`Reasons: ${transcode.transcodeReasons.join(', ')}`);
      }
    }

    const description = document.createElement('div');
    description.textContent = details.filter(Boolean).join(' · ') || 'Active Emby session';
    card.appendChild(description);
    for (const diagnostic of session.diagnostics || []) appendText(card, 'div', diagnostic);
    embyApiSnapshotPanel.appendChild(card);
  }

  if (snapshot.activityLog) {
    appendText(embyApiSnapshotPanel, 'h3', 'Recent server activity');
    const activity = snapshot.activityLog;
    appendText(embyApiSnapshotPanel, 'p',
      `Showing ${activity.entries.length} of ${activity.totalRecordCount ?? 'unknown'} entries (requested limit: ${activity.limit}). Server-wide context, not assigned to a selected session. No pagination or historical completeness guarantee.`, 'emby-api-note');
    for (const entry of activity.entries) {
      appendText(embyApiSnapshotPanel, 'div',
        [entry.date, entry.severity, entry.type, entry.name, entry.id ? `ID: ${entry.id}` : null,
          entry.itemId ? `ItemId: ${entry.itemId}` : null, entry.userId ? `UserId: ${entry.userId}` : null]
          .filter(Boolean).join(' · '), 'emby-api-session');
    }
  }
}

// Prevent default browser drop behavior (navigation/open file) on entire window
window.addEventListener('dragover', (e) => e.preventDefault(), false);
window.addEventListener('drop', (e) => e.preventDefault(), false);

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer && e.dataTransfer.files) {
    const paths = Array.from(e.dataTransfer.files).map(f => {
      if (window.electronAPI && window.electronAPI.getPathForFile) {
        return window.electronAPI.getPathForFile(f);
      }
      return f.path || null;
    }).filter(Boolean);

    if (paths.length > 0) {
      addFiles(paths);
    }
  }
});

function addFiles(paths, source = 'server') {
  for (const p of paths) {
    if (!stagedFiles.includes(p)) {
      stagedFiles.push(p);
    }
    if (source === 'client' && !clientLogFiles.includes(p)) {
      clientLogFiles.push(p);
    }
  }
  renderFileList();
}

function removeFile(index) {
  const [removed] = stagedFiles.splice(index, 1);
  clientLogFiles = clientLogFiles.filter(file => file !== removed);
  renderFileList();
}

function renderFileList() {
  fileList.innerHTML = '';
  fileCountBadge.textContent = stagedFiles.length;

  stagedFiles.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    const name = f.split('/').pop().split('\\').pop();
    li.innerHTML = `
      <span class="file-item-name" title="${escapeHtml(name)}">${clientLogFiles.includes(f) ? '[Android client] ' : ''}${escapeHtml(name)}</span>
      <button class="file-item-remove" onclick="removeFile(${idx})">✕</button>
    `;
    fileList.appendChild(li);
  });

  btnAnalyze.disabled = stagedFiles.length === 0;
  document.getElementById('workflowStatus').textContent = stagedFiles.length
    ? `${stagedFiles.length} file(s) selected, ${clientLogFiles.length} explicitly attached as Android logs. Press Analyze logs to refresh findings after adding or removing files. Existing captures are kept.`
    : 'Choose a diagnosis path. Select local logs or load server logs via API; Android logs can be analyzed alone or alongside server logs.';
}

// Analysis Execution
btnAnalyze.addEventListener('click', () => runAnalysis());

async function runAnalysis() {
  if (stagedFiles.length === 0 || !window.electronAPI) return;
  btnAnalyze.disabled = true;
  btnAnalyze.textContent = 'Analyzing...';

  try {
    const res = await window.electronAPI.runAnalysis({
      filePaths: stagedFiles,
      clientLogFiles
    });
    if (res.success) {
      currentAnalysis = res.data;
      if (embySnapshot) currentAnalysis.embySnapshot = embySnapshot;
      if (snapshotComparison) currentAnalysis.snapshotComparison = snapshotComparison;
      displayResults(res.data);
      document.getElementById('workflowStatus').textContent = 'Analysis complete. Review evidence and next steps below, then export HTML, Markdown or JSON. Export again after adding evidence; captures and reports are not automatically saved.';
    } else {
      alert(`Analysis failed: ${res.error}`);
    }
  } catch (err) {
    console.error('Error during analysis:', err);
    alert('Failed to analyze selected files.');
  } finally {
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = 'Analyze Logs';
  }
}

btnAddAndroidClientLog.addEventListener('click', attachAndroidLogs);

async function attachAndroidLogs() {
  if (!window.electronAPI) return;
  try {
    const result = await window.electronAPI.openFiles();
    if (result.canceled || !result.filePaths?.length) return;
    addFiles(result.filePaths, 'client');
    clientLogStatus.textContent = `${result.filePaths.length} client log file(s) attached. Run analysis again to include them.`;
  } catch (error) {
    document.getElementById('workflowStatus').textContent = `Could not attach Android logs: ${error.message}`;
  }
}

let selectedUser = 'all';
let searchKeyword = '';

const filterUserSelect = document.getElementById('filterUserSelect');
const searchMediaInput = document.getElementById('searchMediaInput');

if (filterUserSelect) {
  filterUserSelect.addEventListener('change', (e) => {
    selectedUser = e.target.value;
    renderSessions();
  });
}

if (searchMediaInput) {
  searchMediaInput.addEventListener('input', (e) => {
    searchKeyword = (e.target.value || '').trim().toLowerCase();
    renderSessions();
  });
}

function populateUserDropdown(sessions) {
  if (!filterUserSelect) return;
  const users = new Set();
  sessions.forEach(s => {
    if (s.user && s.user !== 'Unknown' && s.user !== 'App User') {
      users.add(s.user);
    }
  });

  const previousSelection = selectedUser;
  filterUserSelect.innerHTML = '<option value="all">All Users</option>';
  
  Array.from(users).sort().forEach(u => {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    if (u === previousSelection) opt.selected = true;
    filterUserSelect.appendChild(opt);
  });
}

function displayResults(data) {
  emptyState.style.display = 'none';
  resultsDashboard.style.display = 'flex';
  renderClientLogGuidance(data);
  const unassigned = data.unassignedPlaybackEvents || [];
  document.getElementById('unassignedPlaybackPanel').hidden = unassigned.length === 0;
  const unassignedList = document.getElementById('unassignedPlaybackEvents');
  unassignedList.replaceChildren();
  for (const event of unassigned.slice(0, 100)) {
    const row = document.createElement('p');
    row.textContent = `${event.timestamp} ${event.type} (${event.sourceFile}, line ${event.lineNumber ?? '?'}): ${event.details}`;
    unassignedList.appendChild(row);
  }

  // Metrics
  const clientEvidenceOnly = data.clientLogSummary?.filesCount > 0 && data.sessions.length === 0;
  metricHealth.textContent = clientEvidenceOnly ? 'Not assessed' : data.overallHealth;
  if (clientEvidenceOnly) {
    metricHealth.style.color = 'var(--text-muted)';
  } else if (data.overallHealth === 'Healthy' || data.overallHealth === 'Success') {
    metricHealth.style.color = 'var(--status-success)';
  } else if (data.overallHealth === 'Warning') {
    metricHealth.style.color = 'var(--status-warning)';
  } else {
    metricHealth.style.color = 'var(--status-error)';
  }

  metricTotal.textContent = data.metrics.totalSessions;
  metricSuccess.textContent = data.metrics.successCount;
  metricWarning.textContent = data.metrics.warningCount;
  metricError.textContent = data.metrics.errorCount + data.metrics.criticalCount;

  // AI Briefing
  if (clientEvidenceOnly) {
    aiBriefingText.textContent = 'No server playback sessions were extracted. The server-session metrics do not assess Android playback. Review the separate client evidence and next steps below.';
  } else {
    aiBriefingText.innerHTML = formatMarkdown(data.briefing);
  }

  // Populate Users
  populateUserDropdown(data.sessions);

  // Export buttons
  updateExportButtons();
  document.getElementById('btnReviewFindings').disabled = false;
  document.getElementById('clientLogGuidanceTitle').focus({ preventScroll: true });
  clientLogGuidance.scrollIntoView({ block: 'start' });
}

function renderClientLogGuidance(report) {
  const summary = report.clientLogSummary || { filesCount: 0, relevantEvents: 0, unsupportedFiles: [] };
  const server = report.serverPlaybackEvidence || {};
  const unsupported = summary.unsupportedFiles || [];
  const evidenceText = server.filesCount === 0
    ? 'No server log was included; API captures are not historical server request logs.'
    : `Server logs: ${server.audioRequests || 0} audio request(s), ${server.audioResponses || 0} response(s), ${server.audioSegmentRequests || 0} segment request(s), ${server.nonSuccessAudioResponses || 0} response(s) with HTTP 4xx/5xx, ${server.clientDisconnectedResponses || 0} response(s) completed after client disconnect.`;

  if (summary.filesCount === 0) {
    clientLogGuidanceText.textContent = `${evidenceText} Server logs can prove a request reached Emby and show its response, but cannot prove Android decoded or played the audio. If these server findings do not explain the symptom, use the Mobile device test guide to collect client evidence. A repeat is not required merely because no Android log is attached.`;
    clientLogStatus.textContent = 'No Android client log was included in this analysis.';
  } else if (unsupported.length > 0) {
    clientLogGuidanceText.textContent = `${evidenceText} ${unsupported.length} attached client log file(s) did not match a supported Android log format. They were not misclassified as Emby server logs.`;
    clientLogStatus.textContent = 'Try exporting the app diagnostic log as text, or provide the log format so parser support can be added.';
  } else {
    clientLogGuidanceText.textContent = `${evidenceText} ${summary.relevantEvents} relevant Android client event(s), including ${summary.errorEvents || 0} error-level event(s), were parsed from ${summary.filesCount} file(s). Review the latest events alongside the server playback evidence; the analyzer does not infer a cause from client events alone.`;
    clientLogStatus.textContent = 'Client-side evidence is included in this report.';
  }
  const advice = report.androidPlaybackGuidance;
  document.getElementById('androidPlaybackAdvice').hidden = !advice;
  if (advice) {
    document.getElementById('androidPlaybackAdviceTitle').textContent = advice.title;
    document.getElementById('androidPlaybackAdviceExplanation').textContent = advice.explanation;
    document.getElementById('androidPlaybackAdviceScope').textContent = advice.limitations;
    for (const [id, values] of [
      ['androidPlaybackAdviceObservations', [
        ...advice.observations,
        ...advice.evidence.map(event => `${event.timestamp} (${event.sourceFile}, line ${event.lineNumber}): ${event.signal}`)
      ]],
      ['androidPlaybackAdviceSteps', advice.nextSteps]
    ]) {
      const list = document.getElementById(id);
      list.replaceChildren();
      for (const value of values) {
        const item = document.createElement('li');
        item.textContent = value;
        list.appendChild(item);
      }
    }
  }

  const eventsContainer = document.getElementById('clientLogEvents');
  eventsContainer.replaceChildren();
  for (const event of (summary.events || []).slice(-100)) {
    const row = document.createElement('p');
    row.textContent = `${event.timestamp || 'Time unknown'} ${event.level}/${event.component} (${event.sourceFile}, line ${event.lineNumber}): ${event.details}`;
    eventsContainer.appendChild(row);
  }

  const serverEventsContainer = document.getElementById('serverPlaybackEvents');
  serverEventsContainer.replaceChildren();
  for (const event of (server.events || []).slice(-100)) {
    const row = document.createElement('p');
    const outcome = event.httpStatus ? ` HTTP ${event.httpStatus}`
      : event.responseOutcome === 'client-disconnected' ? ' completed after client disconnect (HTTP status unknown)' : '';
    row.textContent = `${event.timestamp} ${event.type}: ${event.resourceKind} for item ${event.itemId}${outcome} (${event.sourceFile}, line ${event.lineNumber})`;
    serverEventsContainer.appendChild(row);
  }
  clientLogGuidance.hidden = false;

  renderSessions();
}

// Session Filtering
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderSessions();
  });
});

function renderSessions() {
  if (!currentAnalysis) return;
  sessionsList.innerHTML = '';

  const filtered = currentAnalysis.sessions.filter(s => {
    // Status Filter
    if (currentFilter === 'error' && s.overallStatus !== 'Error' && s.overallStatus !== 'Critical') return false;
    if (currentFilter === 'warning' && s.overallStatus !== 'Warning') return false;
    if (currentFilter === 'success' && s.overallStatus !== 'Success') return false;

    // User Filter
    if (selectedUser !== 'all' && s.user !== selectedUser) {
      return false;
    }

    // Media Search Filter
    if (searchKeyword) {
      const matchTitle = (s.mediaItem || '').toLowerCase().includes(searchKeyword);
      const matchUser = (s.user || '').toLowerCase().includes(searchKeyword);
      const matchDevice = (s.clientDevice || '').toLowerCase().includes(searchKeyword);
      if (!matchTitle && !matchUser && !matchDevice) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    sessionsList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 20px;">No sessions match the selected filters (User: ${escapeHtml(selectedUser)}, Status: ${escapeHtml(currentFilter)}).</div>`;
    return;
  }

  for (const s of filtered) {
    const card = document.createElement('div');
    card.className = 'session-card';

    let badgeClass = 'badge-success';
    if (s.overallStatus === 'Warning') badgeClass = 'badge-warning';
    else if (s.overallStatus === 'Error') badgeClass = 'badge-error';
    else if (s.overallStatus === 'Critical') badgeClass = 'badge-critical';

    const root = s.primaryRootCause;

    let rcaContent = '';
    if (root) {
      const evList = (root.evidence || []).map(e => `<li>${escapeHtml(e)}</li>`).join('');
      const recList = (root.recommendations || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');

      let allFindingsHtml = '';
      if (s.allFindings && s.allFindings.length > 1) {
        const secondary = s.allFindings.slice(1);
        const secList = secondary.map(f => {
          let sevColor = '#10b981';
          if (f.severity === 'Warning') sevColor = '#f59e0b';
          else if (f.severity === 'Error') sevColor = '#ef4444';
          else if (f.severity === 'Critical') sevColor = '#dc2626';
          else if (f.severity === 'Info') sevColor = '#38bdf8';

          return `
            <li style="margin-bottom: 6px;">
              <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; color: #fff; background: ${sevColor}; margin-right: 6px;">${f.severity}</span>
              <strong style="color: #f1f5f9;">${escapeHtml(f.title)}</strong>
              <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 2px;">${escapeHtml(f.rootCause)}</div>
            </li>
          `;
        }).join('');

        allFindingsHtml = `
          <div style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
            <button class="btn" style="padding: 4px 10px; font-size: 0.75rem; background: rgba(255,255,255,0.06); border: 1px solid var(--border-color); color: var(--text-muted); border-radius: 6px; cursor: pointer;" onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none'; this.textContent = el.style.display === 'none' ? '▼ View All Diagnostic Checks (${s.allFindings.length})' : '▲ Hide Diagnostic Checks';">
              ▼ View All Diagnostic Checks (${s.allFindings.length})
            </button>
            <div style="display: none; margin-top: 10px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px;">
              <ul style="list-style: none; padding-left: 0; margin: 0;">${secList}</ul>
            </div>
          </div>
        `;
      }

      rcaContent = `
        <div class="rca-box">
          <div class="rca-title-row">
            <span class="rca-title">${escapeHtml(root.title)}</span>
            <span class="confidence-gauge">${root.confidence}% Confidence</span>
          </div>
          <div class="rca-cause">${escapeHtml(root.cause)}</div>
          <p style="font-size:0.85rem; color: #cbd5e1; margin-bottom: 8px;">${escapeHtml(root.explanation)}</p>
          ${root.evidence && root.evidence.length > 0 ? `<strong>Evidence:</strong><ul class="evidence-list">${evList}</ul>` : ''}
          ${root.recommendations && root.recommendations.length > 0 ? `<strong style="margin-top:6px; display:inline-block;">Actionable Remediation:</strong><ul class="recs-list">${recList}</ul>` : ''}
          ${allFindingsHtml}
        </div>
      `;
    }

    // Timeline elements
    let timelineRows = '';
    if (s.timeline && s.timeline.length > 0) {
      timelineRows = s.timeline.map(ev => `
        <div class="timeline-item ${ev.level.toLowerCase()}">
          <span class="timeline-ts">${escapeHtml(ev.timestamp || '-')}</span>
          <span class="timeline-source">${escapeHtml(ev.source)}</span>
          <span class="timeline-detail">${escapeHtml(ev.details)}${ev.association ? ` [${escapeHtml(ev.association)}]` : ''}</span>
        </div>
      `).join('');
    }

    let connHtml = '';
    if (s.connection && s.connection.ip) {
      const isCf = s.connection.isCloudflare;
      const protoClass = s.connection.protocol === 'IPv6' ? 'badge-ipv6' : 'badge-ipv4';
      
      let sslBadgeClass = 'ssl-badge-green';
      if (s.connection.sslStatus === 'red') {
        sslBadgeClass = 'ssl-badge-red';
      } else if (s.connection.sslStatus === 'yellow') {
        sslBadgeClass = 'ssl-badge-yellow';
      }

      connHtml = `
        <span class="connection-tag" title="${escapeHtml(s.connection.route)}">
          <span class="ssl-badge ${sslBadgeClass}" title="${escapeHtml(s.connection.sslLabel || s.connection.scheme)}">
            ${s.connection.scheme === 'HTTPS' ? '🔒 HTTPS' : '🔓 HTTP'}
          </span>
          <span class="proto-badge ${protoClass}">${s.connection.protocol}</span>
          <strong>${escapeHtml(s.connection.ip)}</strong> 
          <span class="route-badge ${isCf ? 'route-cloudflare' : 'route-direct'}">(${escapeHtml(s.connection.route)})</span>
        </span>
      `;
    }

    card.innerHTML = `
      <div class="session-header">
        <div class="session-title-group">
          <h3>${escapeHtml(s.mediaItem || 'Unknown Media')}</h3>
          <div class="session-meta-info">
            <span>User: <strong>${escapeHtml(s.user || 'Unknown')}</strong></span>
            <span>Device: <strong>${escapeHtml(s.clientDevice || 'Unknown')}</strong></span>
            <span>Method: <strong>${escapeHtml(s.playMethod)}</strong></span>
            ${connHtml}
            <span>FFmpeg Logs: <strong>${s.ffmpegTranscodeLogsCount}</strong></span>
          </div>
        </div>
        <span class="status-badge ${badgeClass}">${s.overallStatus}</span>
      </div>

      ${rcaContent}
      ${s.playbackEvidence ? `<p class="emby-api-note">Log evidence: playback stop reported=${s.playbackEvidence.playbackStopReported}; session end reported=${s.playbackEvidence.sessionEndReported}. Neither proves natural completion or a successful next-track transition. Explicit log PlayMethod: ${escapeHtml(s.playbackEvidence.reportedPlayMethod || 'unknown')}. PlaySessionId: ${escapeHtml(s.playbackEvidence.playSessionId || 'unknown')}.</p>` : ''}

      <div class="timeline-container">
        <button class="timeline-toggle" onclick="toggleTimeline(this)">
          ▶ Show Event Timeline (${s.timeline ? s.timeline.length : 0} events)
        </button>
        <div class="timeline-items" style="display: none;">
          ${timelineRows}
        </div>
      </div>
    `;

    sessionsList.appendChild(card);
  }
}

// View Tab Switching
const tabBtnSessions = document.getElementById('tabBtnSessions');
const tabBtnTimeline = document.getElementById('tabBtnTimeline');
const viewSessionsContainer = document.getElementById('viewSessionsContainer');
const viewTimelineContainer = document.getElementById('viewTimelineContainer');
const visualTimelineChart = document.getElementById('visualTimelineChart');
const timelineSummaryBadge = document.getElementById('timelineSummaryBadge');

if (tabBtnSessions && tabBtnTimeline) {
  tabBtnSessions.addEventListener('click', () => {
    tabBtnSessions.classList.add('active');
    tabBtnSessions.style.color = 'var(--accent-cyan)';
    tabBtnSessions.style.borderBottomColor = 'var(--accent-cyan)';
    tabBtnTimeline.classList.remove('active');
    tabBtnTimeline.style.color = 'var(--text-muted)';
    tabBtnTimeline.style.borderBottomColor = 'transparent';

    viewSessionsContainer.style.display = 'flex';
    viewTimelineContainer.style.display = 'none';
  });

  tabBtnTimeline.addEventListener('click', () => {
    tabBtnTimeline.classList.add('active');
    tabBtnTimeline.style.color = 'var(--accent-cyan)';
    tabBtnTimeline.style.borderBottomColor = 'var(--accent-cyan)';
    tabBtnSessions.classList.remove('active');
    tabBtnSessions.style.color = 'var(--text-muted)';
    tabBtnSessions.style.borderBottomColor = 'transparent';

    viewSessionsContainer.style.display = 'none';
    viewTimelineContainer.style.display = 'block';
    renderVisualTimeline();
  });
}

function renderVisualTimeline() {
  if (!currentAnalysis || !visualTimelineChart) return;
  visualTimelineChart.innerHTML = '';

  const sessions = currentAnalysis.sessions.filter(s => {
    if (selectedUser !== 'all' && s.user !== selectedUser) return false;
    if (searchKeyword && !(s.mediaItem || '').toLowerCase().includes(searchKeyword)) return false;
    return true;
  });

  if (sessions.length === 0) {
    visualTimelineChart.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 20px;">No sessions available for the timeline view.</div>`;
    return;
  }

  // Sort sessions chronologically
  sessions.sort((a, b) => {
    const ta = Date.parse((a.startTime || '').replace(/,/g, '.')) || 0;
    const tb = Date.parse((b.startTime || '').replace(/,/g, '.')) || 0;
    return ta - tb;
  });

  let totalGaps = 0;
  let prevStop = null;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const startMs = Date.parse((s.startTime || '').replace(/,/g, '.')) || null;
    const stopMs = Date.parse((s.stopTime || '').replace(/,/g, '.')) || null;

    // Check gap between previous track stop and this track start
    let gapHtml = '';
    if (prevStop && startMs) {
      const diffSec = Math.round((startMs - prevStop) / 1000);
      if (diffSec > 0) {
        totalGaps++;
        const isLongGap = diffSec > 10;
        gapHtml = `
          <div class="timeline-gap-indicator" style="display: flex; align-items: center; justify-content: center; margin: 4px 0; padding: 4px 12px; background: ${isLongGap ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.1)'}; border-left: 3px solid ${isLongGap ? 'var(--status-error)' : 'var(--status-warning)'}; border-radius: 4px; font-size: 0.75rem; color: ${isLongGap ? '#f87171' : '#fbbf24'};">
            ⏸️ Playback Interruption / Pause: <strong>${diffSec} seconds gap</strong> between tracks
          </div>
        `;
      }
    }

    if (stopMs) {
      prevStop = stopMs;
    } else if (startMs) {
      prevStop = startMs;
    }

    // Check for high latency / buffer events in timeline
    const latencyEvents = (s.timeline || []).filter(e => e.type === 'AUDIO_BUFFER_LATENCY' || (e.details && e.details.includes('download took')));

    let latencyWarningHtml = '';
    if (latencyEvents.length > 0) {
      latencyWarningHtml = `
        <div style="margin-top: 6px; padding: 6px 10px; background: rgba(245, 158, 11, 0.15); border-left: 3px solid var(--status-warning); border-radius: 4px; font-size: 0.75rem; color: #fde68a;">
          ⚠️ Buffer Latency: ${escapeHtml(latencyEvents[0].details)}
        </div>
      `;
    }

    const itemCard = document.createElement('div');
    itemCard.className = 'timeline-flow-card';
    itemCard.style.cssText = 'background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px;';

    const connStr = s.connection ? `${s.connection.protocol} via ${s.connection.route} (${s.connection.ip})` : 'Direct LAN';

    itemCard.innerHTML = `
      ${gapHtml}
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 600; color: #fff; font-size: 0.9rem;">🎵 ${escapeHtml(s.mediaItem)}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace;">${escapeHtml(s.startTime || '-')} → ${escapeHtml(s.stopTime || 'Now')}</span>
      </div>
      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; display: flex; gap: 12px;">
        <span>User: <strong>${escapeHtml(s.user)}</strong></span>
        <span>Device: <strong>${escapeHtml(s.clientDevice)}</strong></span>
        <span>Network: <strong>${escapeHtml(connStr)}</strong></span>
      </div>
      ${latencyWarningHtml}
    `;

    visualTimelineChart.appendChild(itemCard);
  }

  if (timelineSummaryBadge) {
    timelineSummaryBadge.textContent = `${sessions.length} Tracks | ${totalGaps} Interruption Gaps Detected`;
  }
}

window.toggleTimeline = function(btn) {
  const container = btn.nextElementSibling;
  if (container.style.display === 'none') {
    container.style.display = 'flex';
    btn.innerHTML = btn.innerHTML.replace('▶', '▼');
  } else {
    container.style.display = 'none';
    btn.innerHTML = btn.innerHTML.replace('▼', '▶');
  }
};

// Export Handlers
btnExportHtml.addEventListener('click', () => handleExport('html'));
btnExportMarkdown.addEventListener('click', () => handleExport('markdown'));
btnExportJson.addEventListener('click', () => handleExport('json'));

async function handleExport(fmt) {
  if ((!currentAnalysis && !embySnapshot && !snapshotComparison) || !window.electronAPI) return;
  try {
    const report = currentAnalysis || {
      reportType: embySnapshot ? 'emby-api-snapshot' : 'emby-api-comparison',
      ...(embySnapshot ? { embySnapshot } : {})
    };
    if (snapshotComparison) report.snapshotComparison = snapshotComparison;
    const res = await window.electronAPI.saveExport(fmt, report);
    if (res.success) alert(`Report saved to: ${res.filePath}`);
    else if (!res.canceled) alert(`Export failed: ${res.error || 'Unknown error'}`);
  } catch (error) {
    alert(`Export failed: ${error.message}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/### (.*?)\n/g, '<h4 style="color:var(--accent-cyan);margin:6px 0;">$1</h4>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.4);padding:2px 4px;border-radius:3px;">$1</code>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/- (.*?)\n/g, '• $1<br/>');
}
