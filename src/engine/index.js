const path = require('path');
const EmbyParser = require('./parser/emby-parser');
const FFmpegParser = require('./parser/ffmpeg-parser');
const SessionCorrelator = require('./correlator/session-correlator');
const RootCauseAnalyzer = require('./analyzer/root-cause-analyzer');
const KnowledgeBase = require('./kb/knowledge-base');
const AIExplainer = require('./ai/ai-explainer');
const ReportExporter = require('./exporter/report-exporter');

/**
 * Top-level LogAnalyzer orchestrator.
 * Handles file ingestion, dispatching to specialized parsers,
 * correlation, root-cause diagnostics, and report generation.
 */
class LogAnalyzerEngine {
  constructor(options = {}) {
    this.kb = new KnowledgeBase(options.customRulesPath);
    this.analyzer = new RootCauseAnalyzer(this.kb);
  }

  /**
   * Run full analysis on an array of file paths.
   * Automatically separates Emby server logs from FFmpeg transcode logs.
   * @param {Array<string>} filePaths
   * @param {Function} onProgress Progress callback
   * @returns {Promise<object>} Complete analysis result
   */
  async analyzeFiles(filePaths, onProgress = null) {
    const embyFiles = [];
    const ffmpegFiles = [];

    for (const fp of filePaths) {
      const base = path.basename(fp).toLowerCase();
      if (base.startsWith('ffmpeg') || base.includes('ffmpeg-transcode')) {
        ffmpegFiles.push(fp);
      } else if (base.startsWith('emby') || base.includes('server')) {
        embyFiles.push(fp);
      } else {
        // Fallback: check content/name
        if (base.includes('transcode')) {
          ffmpegFiles.push(fp);
        } else {
          embyFiles.push(fp);
        }
      }
    }

    if (onProgress) onProgress({ stage: 'parsing', progress: 10, detail: 'Parsing log files...' });

    // Parse Emby logs
    const embyLogs = [];
    for (const ef of embyFiles) {
      const parsed = await EmbyParser.parseFile(ef);
      embyLogs.push(parsed);
    }

    // Parse FFmpeg logs
    const ffmpegLogs = [];
    for (const ff of ffmpegFiles) {
      const parsed = await FFmpegParser.parseFile(ff);
      ffmpegLogs.push(parsed);
    }

    if (onProgress) onProgress({ stage: 'correlating', progress: 50, detail: 'Correlating playback sessions...' });

    // Correlate sessions
    const correlatedSessions = SessionCorrelator.correlate(embyLogs, ffmpegLogs);

    if (onProgress) onProgress({ stage: 'diagnosing', progress: 80, detail: 'Running root-cause diagnostics...' });

    // Collect server-wide unassociated errors
    const allEmbyErrors = [];
    for (const el of embyLogs) {
      allEmbyErrors.push(...el.errors);
    }

    // Analyze root causes
    const diagnosticReport = this.analyzer.analyzeAll(correlatedSessions, allEmbyErrors);

    // Attach local AI briefings
    diagnosticReport.briefing = AIExplainer.generateExplanation(diagnosticReport);
    for (const s of diagnosticReport.sessions) {
      s.aiBriefing = AIExplainer.generateExplanation(s);
    }

    if (onProgress) onProgress({ stage: 'complete', progress: 100, detail: 'Analysis complete.' });

    return {
      ...diagnosticReport,
      filesSummary: {
        embyFilesCount: embyFiles.length,
        ffmpegFilesCount: ffmpegFiles.length,
        totalFiles: filePaths.length
      }
    };
  }

  exportReport(analysisResult, format = 'html') {
    switch (format.toLowerCase()) {
      case 'json':
        return ReportExporter.toJSON(analysisResult);
      case 'markdown':
      case 'md':
        return ReportExporter.toMarkdown(analysisResult);
      case 'html':
      default:
        return ReportExporter.toHTML(analysisResult);
    }
  }
}

module.exports = LogAnalyzerEngine;
