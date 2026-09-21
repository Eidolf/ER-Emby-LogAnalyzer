const fs = require('fs');
const readline = require('readline');

/**
 * Streaming parser for Emby Server logs (embyserver*.txt/log).
 * Extracts log timestamps, levels, components, sessions, playback starts/stops,
 * transcode triggers, user info, client devices, and errors.
 */
class EmbyParser {
  /**
   * Parse an Emby log file in a memory-efficient streaming manner.
   * @param {string} filePath
   * @param {Function} onProgress Optional progress callback (percent: number)
   * @returns {Promise<object>} Parsed log model
   */
  static async parseFile(filePath, onProgress = null) {
    const fileStats = fs.statSync(filePath);
    const totalSize = fileStats.size || 1;
    let bytesRead = 0;

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    const entries = [];
    const sessions = new Map(); // key: sessionId or playSessionId
    const errors = [];
    const transcodeInvocations = [];

    // Emby standard log line pattern:
    // e.g. "2026-09-20 14:15:22.123 Info App: User user1 is playing ..."
    // e.g. "2026-09-20 14:15:22.123 Debug Server: http/1.1 GET http://..."
    const logLineRegex = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Za-z]+)\s+([^:]+):\s+(.*)$/;

    let lastEntry = null;

    for await (const line of rl) {
      bytesRead += Buffer.byteLength(line, 'utf8') + 1;
      if (onProgress && Math.random() < 0.05) {
        onProgress(Math.min(99, Math.round((bytesRead / totalSize) * 100)));
      }

      if (!line.trim()) continue;

      const match = line.match(logLineRegex);
      if (match) {
        const timestamp = match[1];
        const level = match[2].trim();
        const component = match[3].trim();
        const message = match[4].trim();

        const entry = {
          timestamp,
          level,
          component,
          message,
          raw: line
        };

        // Inspect for session & playback activities
        EmbyParser.inspectLine(entry, sessions, transcodeInvocations, errors);

        entries.push(entry);
        lastEntry = entry;
      } else if (lastEntry) {
        // Multi-line stack trace or indented log body
        lastEntry.message += '\n' + line;
        if (lastEntry.level === 'Error' || line.includes('Exception:') || line.includes('Error:')) {
          EmbyParser.inspectStackLine(line, lastEntry, errors);
        }
      }
    }

    if (onProgress) onProgress(100);

    return {
      filePath,
      totalEntries: entries.length,
      entries,
      sessions: Array.from(sessions.values()),
      errors,
      transcodeInvocations
    };
  }

  static inspectLine(entry, sessionsMap, transcodeInvocations, errors) {
    const msg = entry.message;
    const lower = msg.toLowerCase();

    // Track errors/warnings
    if (entry.level === 'Error' || entry.level === 'Fatal' || lower.includes('exception') || lower.includes('failed')) {
      errors.push({
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        message: entry.message
      });
    }

    // Playback starting / playback reported
    // e.g.: "User John is playing Big Buck Bunny on Android TV. PlayMethod=DirectPlay"
    // e.g.: "Playback start reported: ..." or "PlaySessionId: 1a2b3c"
    const playMatch = msg.match(/User\s+(.+?)\s+is playing\s+(.+?)\s+on\s+([^.]+)\.?/i);
    const playSessionMatch = msg.match(/PlaySessionId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const sessionIdMatch = msg.match(/SessionId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const mediaSourceMatch = msg.match(/MediaSourceId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const playMethodMatch = msg.match(/PlayMethod[=:\s]+([A-Za-z]+)/i);

    let sessionKey = null;
    if (playSessionMatch) sessionKey = playSessionMatch[1];
    else if (sessionIdMatch) sessionKey = sessionIdMatch[1];

    if (playMatch) {
      const user = playMatch[1].trim();
      const item = playMatch[2].trim();
      const device = playMatch[3].trim();
      const generatedKey = sessionKey || `${user}_${item}_${entry.timestamp}`;

      if (!sessionsMap.has(generatedKey)) {
        sessionsMap.set(generatedKey, {
          id: generatedKey,
          sessionId: sessionIdMatch ? sessionIdMatch[1] : null,
          playSessionId: playSessionMatch ? playSessionMatch[1] : null,
          user,
          mediaItem: item,
          clientDevice: device,
          playMethod: playMethodMatch ? playMethodMatch[1] : 'DirectPlay',
          startTime: entry.timestamp,
          stopTime: null,
          status: 'Active',
          events: [],
          transcodeJobs: []
        });
      }

      const s = sessionsMap.get(generatedKey);
      s.events.push({
        timestamp: entry.timestamp,
        type: 'PLAYBACK_START',
        details: `User ${user} started playing "${item}" on ${device}`
      });
    }

    // FFmpeg launch or transcode command detection
    if (msg.includes('ffmpeg') && (msg.includes('-i ') || msg.includes('transcoding-temp') || msg.includes('transcode'))) {
      const transcodeKeyMatch = msg.match(/(ffmpeg-transcode-[a-zA-Z0-9_-]+)/i) || 
                                msg.match(/transcode-([a-zA-Z0-9_-]+)/i) ||
                                msg.match(/transcoding-temp[/\\]([a-zA-Z0-9_-]+)/i);
      const transcodeKey = transcodeKeyMatch ? transcodeKeyMatch[1] : null;

      const invocation = {
        timestamp: entry.timestamp,
        commandLine: msg,
        transcodeKey,
        playSessionId: playSessionMatch ? playSessionMatch[1] : null,
        mediaPath: EmbyParser.extractInputPath(msg)
      };

      transcodeInvocations.push(invocation);

      // Associate with target session (either by explicit sessionKey or most recent active session)
      let targetSession = null;
      if (sessionKey && sessionsMap.has(sessionKey)) {
        targetSession = sessionsMap.get(sessionKey);
      } else if (sessionsMap.size > 0) {
        // Fall back to most recent session
        const allSessions = Array.from(sessionsMap.values());
        targetSession = allSessions[allSessions.length - 1];
      }

      if (targetSession) {
        targetSession.playMethod = 'Transcode';
        if (transcodeKey && !targetSession.transcodeJobs.includes(transcodeKey)) {
          targetSession.transcodeJobs.push(transcodeKey);
        }
        targetSession.events.push({
          timestamp: entry.timestamp,
          type: 'TRANSCODE_START',
          details: `FFmpeg transcoding process initiated${transcodeKey ? ` [${transcodeKey}]` : ''}`
        });
      }
    }

    // Playback stop / Session ended / Network Disconnect / Errors
    if (lower.includes('playback stopped') || (lower.includes('session') && lower.includes('has ended')) || lower.includes('connection reset') || lower.includes('client disconnected')) {
      let targetSession = null;
      if (sessionKey && sessionsMap.has(sessionKey)) {
        targetSession = sessionsMap.get(sessionKey);
      } else {
        // Try to match by user name or session id token
        for (const [key, s] of sessionsMap.entries()) {
          if ((s.sessionId && msg.includes(s.sessionId)) || (s.playSessionId && msg.includes(s.playSessionId)) || (s.user && msg.includes(s.user))) {
            targetSession = s;
            break;
          }
        }
        // Fallback to most recent session if exactly 1 active
        if (!targetSession && sessionsMap.size === 1) {
          targetSession = Array.from(sessionsMap.values())[0];
        }
      }

      if (targetSession) {
        if (lower.includes('playback stopped') || lower.includes('has ended')) {
          targetSession.stopTime = entry.timestamp;
          targetSession.status = 'Stopped';
        }
        targetSession.events.push({
          timestamp: entry.timestamp,
          type: lower.includes('connection reset') || lower.includes('disconnected') ? 'NETWORK_EVENT' : 'PLAYBACK_STOP',
          details: msg
        });
      }
    }
  }

  static extractInputPath(cmd) {
    const inputMatch = cmd.match(/-i\s+["']?([^"'\s]+(?: [^"'\s]+)*)["']?\s+/i);
    return inputMatch ? inputMatch[1] : null;
  }

  static inspectStackLine(line, lastEntry, errors) {
    // If a multi-line exception comes in, attach or note it
    if (errors.length > 0 && errors[errors.length - 1].timestamp === lastEntry.timestamp) {
      errors[errors.length - 1].stack = (errors[errors.length - 1].stack || '') + '\n' + line;
    }
  }
}

module.exports = EmbyParser;
