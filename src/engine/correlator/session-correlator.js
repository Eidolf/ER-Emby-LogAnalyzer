const path = require('path');

/**
 * Intelligent correlation engine linking Emby Server sessions with FFmpeg transcode processes.
 * Identifies relationships via:
 * - Session IDs & PlaySessionIds
 * - Transcode job IDs (tokens in filenames and paths)
 * - Media filenames / file references
 * - Temporal / Timestamp proximity
 * - User / Device context
 */
class SessionCorrelator {
  /**
   * Correlates parsed Emby logs with parsed FFmpeg logs.
   * @param {Array<object>} embyLogs Array of parsed Emby log files
   * @param {Array<object>} ffmpegLogs Array of parsed FFmpeg log files
   * @returns {Array<object>} Unified sessions with correlated FFmpeg processes
   */
  static correlate(embyLogs, ffmpegLogs) {
    const sessions = [];
    const unassociatedFFmpeg = new Set(ffmpegLogs);

    // 1. Gather all Emby sessions
    for (const embyLog of embyLogs) {
      if (embyLog.sessions && Array.isArray(embyLog.sessions)) {
        for (const s of embyLog.sessions) {
          sessions.push({
            ...s,
            sourceEmbyFile: embyLog.filePath,
            ffmpegJobs: [],
            transcodeLogs: []
          });
        }
      }
    }

    // 2. Correlate FFmpeg logs to Emby sessions
    for (const session of sessions) {
      for (const ffmpegLog of Array.from(unassociatedFFmpeg)) {
        let matchScore = 0;
        const reasons = [];

        // Match Reason A: Explicit transcode job key or filename token
        if (session.transcodeJobs && session.transcodeJobs.length > 0) {
          for (const jobKey of session.transcodeJobs) {
            if (ffmpegLog.fileName.includes(jobKey) || (ffmpegLog.jobId && ffmpegLog.jobId.includes(jobKey)) || (jobKey.includes(ffmpegLog.jobId))) {
              matchScore += 90;
              reasons.push(`Job ID match: "${jobKey}"`);
            }
          }
        }

        // Match Reason B: PlaySessionId or SessionId inside FFmpeg command line or arguments
        if (session.playSessionId && ffmpegLog.commandLine && ffmpegLog.commandLine.includes(session.playSessionId)) {
          matchScore += 95;
          reasons.push(`PlaySessionId match: "${session.playSessionId}"`);
        }
        if (session.sessionId && ffmpegLog.commandLine && ffmpegLog.commandLine.includes(session.sessionId)) {
          matchScore += 90;
          reasons.push(`SessionId match: "${session.sessionId}"`);
        }

        // Match Reason C: Media File / Item Name correlation
        if (session.mediaItem && ffmpegLog.inputFiles && ffmpegLog.inputFiles.length > 0) {
          const itemClean = session.mediaItem.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const inputFile of ffmpegLog.inputFiles) {
            const inputClean = path.basename(inputFile).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (inputClean.includes(itemClean) || itemClean.includes(inputClean)) {
              matchScore += 70;
              reasons.push(`Media file correlation: "${path.basename(inputFile)}"`);
            }
          }
        }

        // Match Reason D: Timestamp Proximity
        if (session.startTime && ffmpegLog.startTime) {
          const sessionTime = SessionCorrelator.parseTime(session.startTime);
          const ffmpegTime = SessionCorrelator.parseTime(ffmpegLog.startTime);
          if (sessionTime && ffmpegTime) {
            const diffSeconds = Math.abs((ffmpegTime - sessionTime) / 1000);
            if (diffSeconds < 60) {
              matchScore += 40;
              reasons.push(`Started within ${Math.round(diffSeconds)}s of each other`);
            } else if (diffSeconds < 300) {
              matchScore += 20;
            }
          }
        }

        // Match Reason E: If there is exactly 1 session and 1 FFmpeg log in the batch, correlate with high confidence
        if (sessions.length === 1 && ffmpegLogs.length === 1) {
          matchScore += 50;
          reasons.push('Direct 1-to-1 session batch pairing');
        }

        // Threshold for associating FFmpeg log with session
        if (matchScore >= 40) {
          session.playMethod = 'Transcode';
          if ((!session.user || session.user === 'App User' || session.user === 'Unknown') && ffmpegLog.user) {
            session.user = ffmpegLog.user;
          }
          session.transcodeLogs.push({
            ffmpegLog,
            correlationConfidence: Math.min(100, matchScore),
            correlationReasons: reasons
          });
          unassociatedFFmpeg.delete(ffmpegLog);
        }
      }
    }

    // 3. For any remaining unassociated FFmpeg logs, create standalone Transcode Sessions
    // (Happens if administrator only loads ffmpeg logs or Emby log was rotated)
    for (const orphan of unassociatedFFmpeg) {
      sessions.push({
        id: `orphan_ffmpeg_${orphan.jobId}`,
        sessionId: null,
        playSessionId: null,
        user: orphan.user || 'Unknown (Standalone FFmpeg)',
        mediaItem: orphan.inputFiles.length > 0 ? path.basename(orphan.inputFiles[0]) : `Transcode Job ${orphan.jobId}`,
        clientDevice: 'Unknown',
        playMethod: 'Transcode',
        startTime: orphan.startTime || 'Unknown',
        stopTime: orphan.endTime || null,
        status: orphan.normalCompletion ? 'Completed' : (orphan.hasCrashed || orphan.errors.length > 0 ? 'Failed' : 'Active'),
        events: [],
        transcodeJobs: [orphan.jobId],
        sourceEmbyFile: null,
        transcodeLogs: [{
          ffmpegLog: orphan,
          correlationConfidence: 100,
          correlationReasons: ['Standalone FFmpeg Transcode Log (No matching Emby server log)']
        }]
      });
    }

    return sessions;
  }

  static parseTime(timeStr) {
    if (!timeStr) return null;
    const parsed = Date.parse(timeStr);
    if (!isNaN(parsed)) return parsed;
    // Try YYYY-MM-DD HH:mm:ss.mmm
    const clean = timeStr.replace(/,/g, '.');
    const d = new Date(clean);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
}

module.exports = SessionCorrelator;
