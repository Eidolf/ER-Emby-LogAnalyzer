// Client-side Application Logic for Emby Log Analyzer Desktop
let stagedFiles = [];
let currentAnalysis = null;
let currentFilter = 'all';

// DOM Elements
const dropZone = document.getElementById('dropZone');
const btnBrowseFiles = document.getElementById('btnBrowseFiles');
const btnAnalyze = document.getElementById('btnAnalyze');
const sampleSelect = document.getElementById('sampleSelect');
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

// File Selection & Drag-and-Drop
btnBrowseFiles.addEventListener('click', async () => {
  if (window.electronAPI) {
    const res = await window.electronAPI.openFiles();
    if (!res.canceled && res.filePaths) {
      addFiles(res.filePaths);
    }
  }
});

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

// Sample Selector
sampleSelect.addEventListener('change', async (e) => {
  const val = e.target.value;
  if (!val) return;
  if (window.electronAPI) {
    const res = await window.electronAPI.loadSample(val);
    if (res.success && res.files) {
      stagedFiles = [];
      addFiles(res.files);
    }
  }
});

function addFiles(paths) {
  for (const p of paths) {
    if (!stagedFiles.includes(p)) {
      stagedFiles.push(p);
    }
  }
  renderFileList();
}

function removeFile(index) {
  stagedFiles.splice(index, 1);
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
      <span class="file-item-name" title="${f}">${escapeHtml(name)}</span>
      <button class="file-item-remove" onclick="removeFile(${idx})">✕</button>
    `;
    fileList.appendChild(li);
  });

  btnAnalyze.disabled = stagedFiles.length === 0;
}

// Analysis Execution
btnAnalyze.addEventListener('click', async () => {
  if (stagedFiles.length === 0) return;
  btnAnalyze.disabled = true;
  btnAnalyze.textContent = 'Analyzing...';

  try {
    const res = await window.electronAPI.runAnalysis(stagedFiles);
    if (res.success) {
      currentAnalysis = res.data;
      displayResults(res.data);
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
});

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

  // Metrics
  metricHealth.textContent = data.overallHealth;
  if (data.overallHealth === 'Healthy' || data.overallHealth === 'Success') {
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
  aiBriefingText.innerHTML = formatMarkdown(data.briefing);

  // Populate Users
  populateUserDropdown(data.sessions);

  // Export buttons
  btnExportHtml.disabled = false;
  btnExportMarkdown.disabled = false;
  btnExportJson.disabled = false;

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
          <span class="timeline-detail">${escapeHtml(ev.details)}</span>
        </div>
      `).join('');
    }

    let connHtml = '';
    if (s.connection && s.connection.ip) {
      const isCf = s.connection.isCloudflare;
      const protoClass = s.connection.protocol === 'IPv6' ? 'badge-ipv6' : 'badge-ipv4';
      connHtml = `
        <span class="connection-tag" title="${escapeHtml(s.connection.route)}">
          Network: 
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
  if (!currentAnalysis || !window.electronAPI) return;
  const res = await window.electronAPI.saveExport(fmt, currentAnalysis);
  if (res.success) {
    alert(`Report saved to: ${res.filePath}`);
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
