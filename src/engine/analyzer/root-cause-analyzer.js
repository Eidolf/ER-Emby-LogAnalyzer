const KnowledgeBase = require('../kb/knowledge-base');
const TimelineBuilder = require('./timeline-builder');

/**
 * Diagnostic & Root Cause Analysis Engine.
 * Evaluates session events, matched KB patterns, FFmpeg exit codes, and hardware errors
 * to calculate confidence scores, identify true root causes, and produce remediation guidance.
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

    // 3. Deduplicate findings by ruleId & compute highest confidence
    const ruleGroups = new Map();
    for (const finding of matchedFindings) {
      if (!ruleGroups.has(finding.ruleId)) {
        ruleGroups.set(finding.ruleId, {
          ruleId: finding.ruleId,
          category: finding.category,
          title: finding.title,
          rootCause: finding.rootCause,
          severity: finding.severity,
          confidence: finding.confidence,
          explanation: finding.explanation,
          recommendations: finding.recommendations,
          occurrences: 1,
          evidence: [finding.contextSnippet || finding.matchedSnippet]
        });
      } else {
        const grp = ruleGroups.get(finding.ruleId);
        grp.occurrences++;
        if (grp.evidence.length < 5) {
          grp.evidence.push(finding.contextSnippet || finding.matchedSnippet);
        }
        // Slightly bump confidence if error pattern repeats
        grp.confidence = Math.min(99, grp.confidence + 2);
      }
    }

    const uniqueFindings = Array.from(ruleGroups.values());
    uniqueFindings.sort((a, b) => b.confidence - a.confidence);

    // 4. Determine overall status and root causes
    let overallStatus = 'Success';
    let primaryRootCause = null;

    const hasErrors = uniqueFindings.some(f => f.severity === 'Error' || f.severity === 'Critical');
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
      if (top.severity === 'Critical') {
        overallStatus = 'Critical';
      } else if (top.severity === 'Error' || ffmpegCrashed) {
        overallStatus = 'Error';
      } else if (hasWarnings) {
        overallStatus = 'Warning';
      }

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
        title: 'Playback Successful',
        cause: session.playMethod === 'DirectPlay' 
          ? 'Media was streamed directly without transcoding. No critical issues detected.'
          : 'Media was transcoded and streamed smoothly to the client.',
        category: 'Playback',
        confidence: 99,
        severity: 'Success',
        explanation: 'The session completed normally with no fatal errors detected in either Emby or FFmpeg logs.',
        evidence: [
          `PlayMethod: ${session.playMethod}`,
          `Client: ${session.clientDevice || 'Unknown'}`,
          `User: ${session.user || 'Unknown'}`
        ],
        recommendations: [
          'No remediation needed. Everything operated as expected.'
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
