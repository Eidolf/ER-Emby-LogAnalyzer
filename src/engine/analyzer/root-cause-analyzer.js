const KnowledgeBase = require('../kb/knowledge-base');
const TimelineBuilder = require('./timeline-builder');
const CodedChecksEngine = require('./coded-checks');

/**
 * Diagnostic & Root Cause Analysis Engine.
 * Evaluates session events, matched KB patterns, FFmpeg exit codes, hardware errors,
 * and runs programmatic multi-factor Coded Checks against rich parsed object models.
 */
class RootCauseAnalyzer {
  constructor(knowledgeBase = null) {
    this.kb = knowledgeBase || new KnowledgeBase();
  }

  /**
   * Analyze a single correlated session.
   * @param {object} session Correlated session object
   * @param {Array<object>} globalEmbyErrors Any unassociated Emby server errors
   * @returns {object} Full diagnostic analysis report
   */
  analyzeSession(session, globalEmbyErrors = []) {
    const timeline = TimelineBuilder.build(session);
    const matchedFindings = [];
    const evidenceList = [];

    // 1. Evaluate session events
    for (const ev of timeline) {
      const matches = this.kb.evaluate(ev.details, ev.source.includes('FFmpeg') ? 'ffmpeg' : 'emby');
      for (const m of matches) {
        matchedFindings.push({
          ...m,
          timestamp: ev.timestamp,
          source: ev.source
        });
      }
    }

    // 2. Evaluate correlated FFmpeg transcode errors specifically
    if (session.transcodeLogs) {
      for (const tLog of session.transcodeLogs) {
        const f = tLog.ffmpegLog;
        for (const err of f.errors) {
          const matches = this.kb.evaluate(err.text, 'ffmpeg');
          for (const m of matches) {
            matchedFindings.push({
              ...m,
              timestamp: err.timestamp,
              source: 'FFmpeg Transcoder',
              line: err.line
            });
          }
        }
      }
    }

    // 3. Run programmatic multi-factor Coded Checks on rich parsed object models
    const codedFindings = CodedChecksEngine.runAllChecks(session, session.serverContext);
    for (const cf of codedFindings) {
      matchedFindings.push({
        ...cf,
        timestamp: session.startTime || null,
        source: 'Diagnostic Coded Engine'
      });
    }

    // 4. Deduplicate findings by ruleId & compute highest confidence
    const ruleGroups = new Map();
    for (const finding of matchedFindings) {
      const initialEvidence = Array.isArray(finding.evidence)
        ? finding.evidence.filter(Boolean)
        : [finding.contextSnippet || finding.matchedSnippet].filter(Boolean);

      if (!ruleGroups.has(finding.ruleId)) {
        ruleGroups.set(finding.ruleId, {
          ruleId: finding.ruleId,
          category: finding.category,
          title: finding.title,
          rootCause: finding.rootCause,
          severity: finding.severity,
          confidence: finding.confidence,
          explanation: finding.explanation,
          recommendations: finding.recommendations || [],
          occurrences: 1,
          evidence: initialEvidence
        });
      } else {
        const grp = ruleGroups.get(finding.ruleId);
        grp.occurrences++;
        for (const ev of initialEvidence) {
          if (grp.evidence.length < 5 && !grp.evidence.includes(ev)) {
            grp.evidence.push(ev);
          }
        }
        // Slightly bump confidence if error pattern repeats
        grp.confidence = Math.min(99, grp.confidence + 2);
      }
    }

    const uniqueFindings = Array.from(ruleGroups.values());
    const severityWeight = {
      Critical: 4,
      Error: 3,
      Warning: 2,
      Info: 1
    };
    uniqueFindings.sort((a, b) => {
      const wa = severityWeight[a.severity] || 0;
      const wb = severityWeight[b.severity] || 0;
      if (wa !== wb) return wb - wa;
      return b.confidence - a.confidence;
    });

    // 4. Determine overall status and root causes
    let overallStatus = 'Success';
    let primaryRootCause = null;

    const hasCritical = uniqueFindings.some(f => f.severity === 'Critical');
    const hasErrors = uniqueFindings.some(f => f.severity === 'Error');
    const hasWarnings = uniqueFindings.some(f => f.severity === 'Warning');

    // Check FFmpeg exit status
    let ffmpegCrashed = false;
    if (session.transcodeLogs && session.transcodeLogs.length > 0) {
      for (const t of session.transcodeLogs) {
        if (t.ffmpegLog.hasCrashed) {
          ffmpegCrashed = true;
          evidenceList.push(`FFmpeg process terminated abnormally (exit code ${t.ffmpegLog.exitCode})`);
        }
      }
    }

    if (uniqueFindings.length > 0) {
      const top = uniqueFindings[0];
      if (hasCritical) {
        overallStatus = 'Critical';
      } else if (hasErrors || ffmpegCrashed) {
        overallStatus = 'Error';
      } else if (hasWarnings) {
        overallStatus = 'Warning';
      } else {
        overallStatus = 'Success';
      }

      if (overallStatus === 'Success') {
        primaryRootCause = {
          title: 'No failure detected in supplied logs',
          cause: session.playMethod === 'DirectPlay'
            ? 'Reported Direct Play; no matching failure detected in the supplied logs.'
            : `Analysis playback classification: ${session.playMethod || 'Unknown'}. No matching failure detected in the supplied logs.`,
          category: 'Playback',
          confidence: 99,
          severity: 'Success',
          explanation: 'No fatal error was detected. This does not establish natural track completion, a successful next-track transition or complete log coverage.',
          evidence: [
            `PlayMethod: ${session.playMethod}`,
            `Client: ${session.clientDevice || 'Unknown'}`,
            `User: ${session.user || 'Unknown'}`
          ],
          recommendations: [
            'Check playback-stop, session-end and next-track evidence before concluding that album playback completed.'
          ]
        };
      } else {
        primaryRootCause = {
          title: top.title,
          cause: top.rootCause,
          category: top.category,
          confidence: top.confidence,
          severity: top.severity,
          explanation: top.explanation,
          evidence: top.evidence,
          recommendations: top.recommendations
        };
      }
    } else if (ffmpegCrashed) {
      overallStatus = 'Error';
      primaryRootCause = {
        title: 'FFmpeg Transcoding Aborted',
        cause: 'FFmpeg exited with non-zero exit code without matching specific KB rule.',
        category: 'Transcoding',
        confidence: 85,
        severity: 'Error',
        explanation: 'The FFmpeg process crashed or was forcefully killed during transcoding.',
        evidence: evidenceList,
        recommendations: [
          'Inspect raw FFmpeg transcode log for custom filter or driver crashes.',
          'Verify available system RAM and swap memory.'
        ]
      };
    } else {
      // Clean playback session
      overallStatus = 'Success';
      primaryRootCause = {
        title: 'No failure detected in supplied logs',
        cause: session.playMethod === 'DirectPlay' 
          ? 'Reported Direct Play; no matching failure detected in the supplied logs.'
          : `Analysis playback classification: ${session.playMethod || 'Unknown'}. No matching failure detected in the supplied logs.`,
        category: 'Playback',
        confidence: 99,
        severity: 'Success',
        explanation: 'No fatal error was detected. This does not establish natural track completion, a successful next-track transition or complete log coverage.',
        evidence: [
          `PlayMethod: ${session.playMethod}`,
          `Client: ${session.clientDevice || 'Unknown'}`,
          `User: ${session.user || 'Unknown'}`
        ],
        recommendations: [
          'Check playback-stop, session-end and next-track evidence before concluding that album playback completed.'
        ]
      };
    }

    return {
      sessionId: session.id,
      mediaItem: session.mediaItem,
      user: session.user,
      clientDevice: session.clientDevice,
      playMethod: session.playMethod,
      startTime: session.startTime,
      stopTime: session.stopTime,
      playbackEvidence: {
        embySessionId: session.sessionId || null,
        playSessionId: session.playSessionId || null,
        mediaSourceId: session.mediaSourceId || null,
        deviceId: session.deviceId || null,
        clientApplication: session.clientApplication || null,
        reportedPlayMethod: session.reportedPlayMethod || null,
        sourceFile: session.sourceEmbyFile || null,
        playbackStopReported: (session.events || []).some(event => event.type === 'PLAYBACK_STOP'),
        sessionEndReported: (session.events || []).some(event => event.type === 'SESSION_ENDED'),
        naturalCompletion: 'not-established',
        events: (session.events || []).filter(event => [
          'PLAYBACK_START', 'PLAYBACK_PROGRESS', 'PLAYBACK_PAUSE', 'PLAYBACK_UNPAUSE',
          'PLAYLIST_MOVE', 'PLAYBACK_STOP', 'SESSION_ENDED', 'NETWORK_EVENT', 'AUDIO_HTTP_RESPONSE'
        ].includes(event.type))
      },
      connection: session.connection || null,
      overallStatus,
      primaryRootCause,
      allFindings: uniqueFindings,
      timeline,
      ffmpegTranscodeLogsCount: (session.transcodeLogs || []).length
    };
  }

  /**
   * Analyze all correlated sessions.
   * @param {Array<object>} correlatedSessions
   * @param {Array<object>} globalEmbyErrors
   * @returns {object} Complete batch diagnostic analysis
   */
  analyzeAll(correlatedSessions, globalEmbyErrors = []) {
    const sessionReports = correlatedSessions.map(s => this.analyzeSession(s, globalEmbyErrors));

    let successCount = 0;
    let warningCount = 0;
    let errorCount = 0;
    let criticalCount = 0;

    for (const rep of sessionReports) {
      if (rep.overallStatus === 'Success') successCount++;
      else if (rep.overallStatus === 'Warning') warningCount++;
      else if (rep.overallStatus === 'Error') errorCount++;
      else if (rep.overallStatus === 'Critical') criticalCount++;
    }

    const overallHealth = criticalCount > 0 ? 'Critical' : (errorCount > 0 ? 'Error' : (warningCount > 0 ? 'Warning' : 'Healthy'));

    return {
      analyzedAt: new Date().toISOString(),
      overallHealth,
      metrics: {
        totalSessions: sessionReports.length,
        successCount,
        warningCount,
        errorCount,
        criticalCount
      },
      sessions: sessionReports
    };
  }
}

module.exports = RootCauseAnalyzer;
