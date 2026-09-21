const fs = require('fs');

/**
 * Report exporter supporting Markdown, HTML, JSON, and PDF (printable HTML).
 */
class ReportExporter {
  /**
   * Export diagnostic batch results to JSON.
   */
  static toJSON(analysisResult, pretty = true) {
    return JSON.stringify(analysisResult, null, pretty ? 2 : 0);
  }

  /**
   * Export diagnostic batch results to Markdown.
   */
  static toMarkdown(analysisResult) {
    const { overallHealth, metrics, sessions, analyzedAt } = analysisResult;
    let md = `# Emby Log Analyzer Diagnostic Report\n\n`;
    md += `*Generated on: ${analyzedAt}*\n\n`;
    md += `## Fleet Overview\n\n`;
    md += `- **Overall Status**: ${overallHealth}\n`;
    md += `- **Total Sessions**: ${metrics.totalSessions}\n`;
    md += `- **Successful Playbacks**: ${metrics.successCount}\n`;
    md += `- **Warnings**: ${metrics.warningCount}\n`;
    md += `- **Errors / Transcode Failures**: ${metrics.errorCount}\n`;
    md += `- **Critical Outages**: ${metrics.criticalCount}\n\n`;

    md += `## Detailed Session Analysis\n\n`;

    for (const s of sessions) {
      md += `### Session: ${s.mediaItem || 'Unknown Media'} (${s.overallStatus})\n\n`;
      md += `- **User**: ${s.user || 'Unknown'}\n`;
      md += `- **Device**: ${s.clientDevice || 'Unknown'}\n`;
      md += `- **Play Method**: ${s.playMethod}\n`;
      md += `- **Start Time**: ${s.startTime || 'N/A'}\n`;
      md += `- **Correlated FFmpeg Logs**: ${s.ffmpegTranscodeLogsCount}\n\n`;

      if (s.primaryRootCause) {
        md += `#### Primary Root Cause: ${s.primaryRootCause.title} (${s.primaryRootCause.confidence}% Confidence)\n\n`;
        md += `**Cause**: ${s.primaryRootCause.cause}\n\n`;
        md += `**Explanation**: ${s.primaryRootCause.explanation}\n\n`;

        if (s.primaryRootCause.evidence && s.primaryRootCause.evidence.length > 0) {
          md += `**Evidence:**\n`;
          for (const ev of s.primaryRootCause.evidence) {
            md += `- \`${ev}\`\n`;
          }
          md += `\n`;
        }

        if (s.primaryRootCause.recommendations && s.primaryRootCause.recommendations.length > 0) {
          md += `**Recommendations:**\n`;
          for (const rec of s.primaryRootCause.recommendations) {
            md += `1. ${rec}\n`;
          }
          md += `\n`;
        }
      }

      if (s.timeline && s.timeline.length > 0) {
        md += `#### Event Timeline\n\n`;
        md += `| Timestamp | Source | Type | Details |\n`;
        md += `| :--- | :--- | :--- | :--- |\n`;
        for (const ev of s.timeline.slice(0, 20)) {
          md += `| ${ev.timestamp || '-'} | ${ev.source} | ${ev.type} | ${ev.details.replace(/\|/g, '\\|').slice(0, 100)} |\n`;
        }
        md += `\n---\n\n`;
      }
    }

    return md;
  }

  /**
   * Export diagnostic batch results to polished HTML.
   */
  static toHTML(analysisResult) {
    const { overallHealth, metrics, sessions, analyzedAt } = analysisResult;
    const statusColor = {
      Success: '#10b981',
      Warning: '#f59e0b',
      Error: '#ef4444',
      Critical: '#dc2626'
    };

    let sessionCards = '';
    for (const s of sessions) {
      const color = statusColor[s.overallStatus] || '#6b7280';
      const root = s.primaryRootCause;

      let evidenceHtml = '';
      if (root && root.evidence) {
        evidenceHtml = `<ul>${root.evidence.map(e => `<li><code>${ReportExporter.escapeHtml(e)}</code></li>`).join('')}</ul>`;
      }

      let recsHtml = '';
      if (root && root.recommendations) {
        recsHtml = `<ol>${root.recommendations.map(r => `<li>${ReportExporter.escapeHtml(r)}</li>`).join('')}</ol>`;
      }

      let timelineHtml = '';
      if (s.timeline && s.timeline.length > 0) {
        timelineHtml = `
          <div class="timeline">
            <h4>Timeline</h4>
            <table>
              <thead><tr><th>Time</th><th>Source</th><th>Event</th><th>Details</th></tr></thead>
              <tbody>
                ${s.timeline.slice(0, 25).map(ev => `
                  <tr class="${ev.level.toLowerCase()}">
                    <td>${ReportExporter.escapeHtml(ev.timestamp || '')}</td>
                    <td>${ReportExporter.escapeHtml(ev.source)}</td>
                    <td>${ReportExporter.escapeHtml(ev.type)}</td>
                    <td>${ReportExporter.escapeHtml(ev.details)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }

      sessionCards += `
        <div class="card session-card" style="border-left: 5px solid ${color};">
          <div class="card-header">
            <h3>${ReportExporter.escapeHtml(s.mediaItem || 'Unknown Media')}</h3>
            <span class="badge" style="background:${color};">${s.overallStatus}</span>
          </div>
          <p class="meta"><strong>User:</strong> ${ReportExporter.escapeHtml(s.user || 'N/A')} | <strong>Device:</strong> ${ReportExporter.escapeHtml(s.clientDevice || 'N/A')} | <strong>Method:</strong> ${s.playMethod} | <strong>FFmpeg Logs:</strong> ${s.ffmpegTranscodeLogsCount}</p>
          ${root ? `
            <div class="root-cause">
              <h4>${ReportExporter.escapeHtml(root.title)} <span class="confidence">(${root.confidence}% Confidence)</span></h4>
              <p><strong>Cause:</strong> ${ReportExporter.escapeHtml(root.cause)}</p>
              <p>${ReportExporter.escapeHtml(root.explanation)}</p>
              ${root.evidence && root.evidence.length > 0 ? `<h5>Evidence</h5>${evidenceHtml}` : ''}
              ${root.recommendations && root.recommendations.length > 0 ? `<h5>Actionable Recommendations</h5>${recsHtml}` : ''}
            </div>
          ` : ''}
          ${timelineHtml}
        </div>
      `;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Emby Log Analyzer Diagnostic Report</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #334155;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.5;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1, h2, h3, h4, h5 { color: #fff; margin-top: 0; }
    .header-bar { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .metric-card { background: var(--card-bg); padding: 1.25rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
    .metric-num { font-size: 2rem; font-weight: bold; margin-top: 0.5rem; }
    .card { background: var(--card-bg); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid var(--border); }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .badge { padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; text-transform: uppercase; color: #fff; }
    .meta { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem; }
    .root-cause { background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    .confidence { font-size: 0.9rem; color: #38bdf8; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: rgba(255,255,255,0.05); }
    tr.error td { color: #f87171; }
    tr.warning td { color: #fbbf24; }
    code { background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; }
    @media print {
      body { background: #fff; color: #000; padding: 0; }
      .card { background: #fff; border: 1px solid #ccc; page-break-inside: avoid; }
      .root-cause { background: #f8f9fa; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <h1>Emby Log Analyzer Diagnostic Report</h1>
      <p class="meta">Generated: ${analyzedAt} | Fleet Health: <strong>${overallHealth}</strong></p>
    </div>
    <div class="metrics-grid">
      <div class="metric-card"><div>Total Sessions</div><div class="metric-num">${metrics.totalSessions}</div></div>
      <div class="metric-card"><div>Successful</div><div class="metric-num" style="color:#10b981">${metrics.successCount}</div></div>
      <div class="metric-card"><div>Warnings</div><div class="metric-num" style="color:#f59e0b">${metrics.warningCount}</div></div>
      <div class="metric-card"><div>Errors / Crashes</div><div class="metric-num" style="color:#ef4444">${metrics.errorCount + metrics.criticalCount}</div></div>
    </div>
    <h2>Session Diagnostic Breakdowns</h2>
    ${sessionCards}
  </div>
</body>
</html>`;
  }

  static escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = ReportExporter;
