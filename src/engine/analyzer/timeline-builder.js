/**
 * Stitches together unified chronological event timelines from
 * Emby server events, client requests, and FFmpeg transcode lines.
 */
class TimelineBuilder {
  /**
   * Build unified timeline for a correlated session.
   * @param {object} session Correlated session object
   * @returns {Array<object>} Chronological timeline events
   */
  static build(session) {
    const rawEvents = [];

    // 1. Session base events
    if (session.events && Array.isArray(session.events)) {
      for (const ev of session.events) {
        rawEvents.push({
          timestamp: ev.timestamp,
          source: 'Emby Server',
          type: ev.type,
          level: 'Info',
          details: ev.details
        });
      }
    }

    // 2. Correlated FFmpeg events
    if (session.transcodeLogs && session.transcodeLogs.length > 0) {
      for (const entry of session.transcodeLogs) {
        const ffmpeg = entry.ffmpegLog;
        if (ffmpeg.startTime) {
          rawEvents.push({
            timestamp: ffmpeg.startTime,
            source: 'FFmpeg Transcoder',
            type: 'FFMPEG_START',
            level: 'Info',
            details: `Transcoder spawned (${ffmpeg.hwaccel || 'Software CPU'}, Output: ${ffmpeg.videoEncoder || 'auto'})`
          });
        }

        // Add errors from FFmpeg
        for (const err of ffmpeg.errors) {
          rawEvents.push({
            timestamp: err.timestamp || ffmpeg.endTime || ffmpeg.startTime,
            source: 'FFmpeg Transcoder',
            type: 'FFMPEG_ERROR',
            level: 'Error',
            details: err.text,
            line: err.line
          });
        }

        // Add warnings from FFmpeg
        for (const warn of ffmpeg.warnings) {
          rawEvents.push({
            timestamp: warn.timestamp || ffmpeg.endTime || ffmpeg.startTime,
            source: 'FFmpeg Transcoder',
            type: 'FFMPEG_WARNING',
            level: 'Warning',
            details: warn.text,
            line: warn.line
          });
        }

        // Add exit or completion
        if (ffmpeg.endTime || ffmpeg.exitCode !== null) {
          const isSuccess = ffmpeg.normalCompletion || ffmpeg.exitCode === 0;
          rawEvents.push({
            timestamp: ffmpeg.endTime || ffmpeg.startTime,
            source: 'FFmpeg Transcoder',
            type: isSuccess ? 'FFMPEG_EXIT_OK' : 'FFMPEG_EXIT_FAIL',
            level: isSuccess ? 'Info' : 'Error',
            details: isSuccess
              ? 'FFmpeg transcoder finished successfully'
              : `FFmpeg transcoder terminated with exit code ${ffmpeg.exitCode !== null ? ffmpeg.exitCode : 'abnormal'}`
          });
        }
      }
    }

    // 3. Chronological sorting
    rawEvents.sort((a, b) => {
      const ta = TimelineBuilder.parseTimestamp(a.timestamp);
      const tb = TimelineBuilder.parseTimestamp(b.timestamp);
      return ta - tb;
    });

    return rawEvents;
  }

  static parseTimestamp(str) {
    if (!str) return 0;
    const t = Date.parse(str);
    if (!isNaN(t)) return t;
    const clean = str.replace(/,/g, '.');
    const d = new Date(clean);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
}

module.exports = TimelineBuilder;
