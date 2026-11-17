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

    // Server environment metadata
    let serverVersion = null;
    let operatingSystem = null; // e.g. Linux version 7.0.0-27-generic
    let osKernel = null;        // e.g. 7.0.0
    let osPlatform = 'Unknown'; // Linux, Windows, Android, macOS, BSD
    let framework = null;       // e.g. .NET 8.0.25
    let processorCount = null;

    // Emby standard log line pattern:
    // e.g. "2026-09-20 14:15:22.123 Info App: User user1 is playing ..."
    // e.g. "2026-09-18 10:50:44.826 Info UniversalAudioService-0HNOE1NSCNV5T:0000000F: User policy for demoUser..."
    const logLineRegex = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Za-z]+)\s+(.+?):\s+(.*)$/;

    let lastEntry = null;

    const context = {
      userByDeviceId: new Map(),
      lastSeenUser: null,
      unassignedPlaybackEvents: []
    };

    let lineIndex = 0;
    for await (const line of rl) {
      lineIndex++;
      bytesRead += Buffer.byteLength(line, 'utf8') + 1;
      if (onProgress && Math.random() < 0.05) {
        onProgress(Math.min(99, Math.round((bytesRead / totalSize) * 100)));
      }

      if (!line.trim()) continue;

      // Extract Server environment info from startup banners
      if (!serverVersion && line.includes('Emby Server Version:')) {
        const vMatch = line.match(/Emby Server Version:\s*([0-9.]+)/i);
        if (vMatch) serverVersion = vMatch[1];
      }
      if (!operatingSystem && line.includes('Operating system:')) {
        const osMatch = line.match(/Operating system:\s*(.+)$/i);
        if (osMatch) {
          operatingSystem = osMatch[1].trim();
          if (/linux/i.test(operatingSystem)) osPlatform = 'Linux';
          else if (/windows/i.test(operatingSystem)) osPlatform = 'Windows';
          else if (/darwin|mac/i.test(operatingSystem)) osPlatform = 'macOS';
          else if (/bsd/i.test(operatingSystem)) osPlatform = 'BSD';
          else if (/android/i.test(operatingSystem)) osPlatform = 'Android';

          const kMatch = operatingSystem.match(/Linux version\s+([0-9.]+)/i) || operatingSystem.match(/kernel\s+([0-9.]+)/i);
          if (kMatch) osKernel = kMatch[1];
        }
      }
      if (!framework && line.includes('Framework:')) {
        const fMatch = line.match(/Framework:\s*(.+)$/i);
        if (fMatch) framework = fMatch[1].trim();
      }
      if (!processorCount && line.includes('Processor count:')) {
        const pMatch = line.match(/Processor count:\s*(\d+)/i);
        if (pMatch) processorCount = parseInt(pMatch[1], 10);
      }

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
          lineNumber: lineIndex,
          raw: line
        };

        // Inspect for session & playback activities
        EmbyParser.inspectLine(entry, sessions, transcodeInvocations, errors, context);

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
      transcodeInvocations,
      unassignedPlaybackEvents: context.unassignedPlaybackEvents,
      serverVersion,
      operatingSystem,
      osKernel,
      osPlatform,
      framework,
      processorCount,
      parsedLineCount: lineIndex
    };
  }

  static inspectLine(entry, sessionsMap, transcodeInvocations, errors, context = null) {
    const msg = entry.message;
    const lower = msg.toLowerCase();

    // Track User policy lines
    // e.g.: "User policy for demoUser. EnableAudioPlaybackTranscoding: True"
    // e.g.: "User policy for demoUser."
    if (msg.includes('User policy for')) {
      const upMatch = msg.match(/User policy for\s+([^.\r\n]+)/i);
      if (upMatch && context) {
        context.lastSeenUser = upMatch[1].trim();
      }
    }

    // Track DeviceId to User mapping if present in request query/body
    const deviceIdMatch = msg.match(/DeviceId=([a-zA-Z0-9_-]+)/i) || msg.match(/X-Emby-Device-Id=([a-zA-Z0-9_-]+)/i);
    const deviceId = deviceIdMatch ? deviceIdMatch[1] : null;

    // Track IP Address, Protocol (IPv4/IPv6), and Routing (Cloudflare Proxy vs Direct / LAN)
    let extractedIp = null;
    let isCloudflare = false;

    // 1. Cloudflare Connecting IP header
    const cfMatch = msg.match(/Cf-Connecting-Ip=([0-9a-fA-F:.]+)/i);
    if (cfMatch) {
      extractedIp = cfMatch[1].trim();
      isCloudflare = true;
    }

    // 2. X-Forwarded-For header
    if (!extractedIp) {
      const xffMatch = msg.match(/X-Forwarded-For=([0-9a-fA-F:.]+)/i);
      if (xffMatch) {
        extractedIp = xffMatch[1].split(',')[0].trim();
      }
    }

    // 3. Emby Source Ip or RemoteEndPoint
    if (!extractedIp) {
      const srcMatch = msg.match(/Source Ip:\s*([0-9a-fA-F:.]+)/i) ||
                       msg.match(/RemoteEndPoint:\s*([0-9a-fA-F:.]+)/i);
      if (srcMatch && !srcMatch[1].startsWith('host')) {
        extractedIp = srcMatch[1].trim();
      }
    }

    // 4. Fallback: Explicit client IP or URL host IP (excluding Version: X.X.X.X)
    if (!extractedIp) {
      const lineWithoutVersion = msg.replace(/Version[=:\s]+[0-9.]+/gi, '');
      const ipInUrlMatch = lineWithoutVersion.match(/https?:\/\/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[?[0-9a-fA-F:]{3,}\]?)(?::\d+)?/i);
      if (ipInUrlMatch) {
        extractedIp = ipInUrlMatch[1].replace(/[[\]]/g, '').trim();
      }
    }

    if (msg.includes('Cdn-Loop=cloudflare') || msg.includes('cf-ray') || msg.includes('Cf-Ray=')) {
      isCloudflare = true;
    }

    // Detect URL Scheme (HTTPS vs HTTP)
    let scheme = 'HTTP';
    if (msg.includes('https://') || msg.includes('X-Forwarded-Proto=https') || msg.includes(':8920/')) {
      scheme = 'HTTPS';
    } else if (msg.includes('http://') || msg.includes(':8096/')) {
      scheme = 'HTTP';
    }

    let connectionInfo = null;
    if (extractedIp) {
      const isV6 = extractedIp.includes(':');
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|fe80:|::1)/i.test(extractedIp);
      
      let route = 'Direct';
      if (isCloudflare) {
        route = 'Cloudflare (Proxy)';
      } else if (isPrivate) {
        route = 'LAN / Local Network';
      } else {
        route = 'Direct (Firewall / WAN)';
      }

      // SSL Security Evaluation:
      // Green = HTTPS (Encrypted)
      // Yellow = HTTP but internal LAN (acceptable in home network)
      // Red = HTTP over external WAN / Proxy (Insecure cleartext transmission of credentials/tokens)
      let sslStatus = 'green';
      let sslLabel = 'HTTPS (Encrypted)';
      if (scheme === 'HTTPS') {
        sslStatus = 'green';
        sslLabel = 'HTTPS (Secure)';
      } else if (isPrivate) {
        sslStatus = 'yellow';
        sslLabel = 'HTTP (Internal LAN)';
      } else {
        sslStatus = 'red';
        sslLabel = 'HTTP Insecure (External WAN)';
      }

      connectionInfo = {
        ip: extractedIp,
        protocol: isV6 ? 'IPv6' : 'IPv4',
        scheme,
        route,
        isCloudflare,
        sslStatus,
        sslLabel
      };

      if (context) {
        if (deviceId) {
          context.userByDeviceId.set(deviceId, {
            ...(context.userByDeviceId.get(deviceId) || {}),
            connectionInfo
          });
        }
        context.lastSeenConnection = connectionInfo;
      }

      // If this request contains a playSessionId or sessionId, link connectionInfo directly to existing session
      const targetPIdMatch = msg.match(/PlaySessionId[=:\s]+([a-zA-Z0-9_-]+)/i);
      if (targetPIdMatch && sessionsMap.has(targetPIdMatch[1])) {
        const targetSession = sessionsMap.get(targetPIdMatch[1]);
        if (!targetSession.connection || targetSession.connection.ip.startsWith('192.168.') && isCloudflare) {
          targetSession.connection = connectionInfo;
        }
      }
    }

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
    // Pattern 1: "User John is playing Big Buck Bunny on Android TV. PlayMethod=DirectPlay"
    // Pattern 2: "Playback start reported by app AndroidTv 2.1.55g on TV-LivingRoom playing Big Buck Bunny. Position: 4749358 ms. PlaySessionId: 07c82fb558ea44a2a3852fb682dd2ada"
    const playMatch1 = msg.match(/User\s+(.+?)\s+is playing\s+(.+?)\s+on\s+([^.]+)\.?/i);
    const playMatch2 = msg.match(/Playback start reported by app\s+(.+?)\s+on\s+(.+?)\s+playing\s+(.+?)\.\s+Position:.*?PlaySessionId:\s*([a-zA-Z0-9_-]+)/i);

    const playSessionMatch = msg.match(/\bPlaySessionId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const sessionIdMatch = msg.match(/\bSessionId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const mediaSourceMatch = msg.match(/MediaSourceId[=:\s]+([a-zA-Z0-9_-]+)/i);
    const playMethodMatch = msg.match(/PlayMethod[=:\s]+([A-Za-z]+)/i);

    let sessionKey = null;
    if (playSessionMatch) sessionKey = playSessionMatch[1];
    else if (sessionIdMatch) sessionKey = sessionIdMatch[1];
    const association = playSessionMatch ? 'explicit PlaySessionId'
      : 'session context (not an exact playback ID)';

    const currentConn = connectionInfo || (deviceId && context && context.userByDeviceId.has(deviceId) ? context.userByDeviceId.get(deviceId).connectionInfo : null) || (context ? context.lastSeenConnection : null);

    if (playMatch1) {
      const user = playMatch1[1].trim();
      const item = playMatch1[2].trim();
      const device = playMatch1[3].trim();
      const generatedKey = sessionKey || `${user}_${item}_${entry.timestamp}`;

      if (!sessionsMap.has(generatedKey)) {
        sessionsMap.set(generatedKey, {
          id: generatedKey,
          sessionId: sessionIdMatch ? sessionIdMatch[1] : null,
          playSessionId: playSessionMatch ? playSessionMatch[1] : null,
          user,
          mediaItem: item,
          clientDevice: device,
          clientApplication: null,
          deviceId,
          mediaSourceId: mediaSourceMatch ? mediaSourceMatch[1] : null,
          reportedPlayMethod: playMethodMatch ? playMethodMatch[1] : null,
          playMethod: playMethodMatch ? playMethodMatch[1] : 'Unknown',
          startTime: entry.timestamp,
          stopTime: null,
          status: 'Active',
          connection: currentConn,
          events: [],
          transcodeJobs: []
        });
      }

      const s = sessionsMap.get(generatedKey);
      if (!s.connection && currentConn) {
        s.connection = currentConn;
      }
      s.events.push({
        timestamp: entry.timestamp,
        type: 'PLAYBACK_START',
        positionMs: EmbyParser.positionMs(msg),
        association,
        lineNumber: entry.lineNumber,
        details: `User ${user} started playing "${item}" on ${device}${s.connection ? ` [${s.connection.protocol} via ${s.connection.route}: ${s.connection.ip}]` : ''}`
      });
    } else if (playMatch2) {
      const appName = playMatch2[1].trim();
      const device = playMatch2[2].trim();
      const item = playMatch2[3].trim();
      const pSessionId = playMatch2[4].trim();
      const generatedKey = pSessionId || sessionKey || `${item}_${entry.timestamp}`;
      const resolvedUser = (context && context.lastSeenUser) ? context.lastSeenUser : 'App User';

      if (!sessionsMap.has(generatedKey)) {
        sessionsMap.set(generatedKey, {
          id: generatedKey,
          sessionId: sessionIdMatch ? sessionIdMatch[1] : null,
          playSessionId: pSessionId,
          user: resolvedUser,
          mediaItem: item,
          clientDevice: `${appName} (${device})`,
          clientApplication: appName,
          deviceId,
          mediaSourceId: mediaSourceMatch ? mediaSourceMatch[1] : null,
          reportedPlayMethod: playMethodMatch ? playMethodMatch[1] : null,
          playMethod: playMethodMatch ? playMethodMatch[1] : 'Unknown',
          startTime: entry.timestamp,
          stopTime: null,
          status: 'Active',
          connection: currentConn,
          events: [],
          transcodeJobs: []
        });
      }

      const s = sessionsMap.get(generatedKey);
      if (s.user === 'App User' && resolvedUser !== 'App User') {
        s.user = resolvedUser;
      }
      if (!s.connection && currentConn) {
        s.connection = currentConn;
      }
      s.events.push({
        timestamp: entry.timestamp,
        type: 'PLAYBACK_START',
        positionMs: EmbyParser.positionMs(msg),
        association,
        lineNumber: entry.lineNumber,
        details: `Playback started for "${item}" on ${device} (${appName})${s.connection ? ` [${s.connection.protocol} via ${s.connection.route}: ${s.connection.ip}]` : ''}`
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

    // Playback progress (Pause, Unpause, Volume, Seek, Buffer)
    if (msg.includes('Playback progress')) {
      const targetSession = EmbyParser.resolvePlaybackSession(msg, sessionsMap);

      if (targetSession) {
        let pType = 'PLAYBACK_PROGRESS';
        if (msg.includes('(Pause)')) pType = 'PLAYBACK_PAUSE';
        else if (msg.includes('(Unpause)')) pType = 'PLAYBACK_UNPAUSE';
        else if (msg.includes('(PlaylistItemMove)')) pType = 'PLAYLIST_MOVE';

        // Filter out spammy volume changes, keep Pause/Unpause/Position info
        if (!msg.includes('(VolumeChange)')) {
          targetSession.events.push({
            timestamp: entry.timestamp,
            type: pType,
            details: msg,
            positionMs: EmbyParser.positionMs(msg),
            association,
            lineNumber: entry.lineNumber
          });
        }
      } else if (context && !msg.includes('(VolumeChange)')) {
        context.unassignedPlaybackEvents.push({
          timestamp: entry.timestamp,
          type: 'PLAYBACK_PROGRESS',
          details: msg,
          positionMs: EmbyParser.positionMs(msg),
          association: 'unassigned',
          lineNumber: entry.lineNumber
        });
      }
    }

    // Transfer duration is not startup latency or evidence of buffer starvation.
    if (/\/(?:emby\/)?Audio\//i.test(msg) && /\bResponse\s+\d{3}\b/i.test(msg)) {
      const timeMatch = msg.match(/Time:\s*(\d+(?:\.\d+)?)\s*ms/i);
      const ms = timeMatch ? Number(timeMatch[1]) : null;
      const httpStatus = Number(msg.match(/\bResponse\s+(\d{3})\b/i)[1]);
      const targetSession = EmbyParser.resolvePlaybackSession(msg, sessionsMap, false);
      const event = {
        timestamp: entry.timestamp,
        type: 'AUDIO_HTTP_RESPONSE',
        details: `Audio HTTP response ${httpStatus}; request duration ${ms === null ? 'not reported' : `${ms}ms`}. This does not establish startup latency, buffer starvation or successful playback.`,
        httpStatus,
        association: targetSession ? association : 'unassigned',
        durationMs: ms,
        lineNumber: entry.lineNumber
      };
      if (targetSession) targetSession.events.push(event);
      else if (context) context.unassignedPlaybackEvents.push(event);
    }

    // Playback stop / Session ended / Network Disconnect / Errors
    if (lower.includes('playback stopped') || (lower.includes('session') && lower.includes('has ended')) || lower.includes('connection reset') || lower.includes('client disconnected')) {
      const targetSession = EmbyParser.resolvePlaybackSession(msg, sessionsMap);
      const event = {
        timestamp: entry.timestamp,
        type: lower.includes('connection reset') || lower.includes('disconnected') ? 'NETWORK_EVENT'
          : lower.includes('has ended') ? 'SESSION_ENDED' : 'PLAYBACK_STOP',
        details: msg,
        positionMs: EmbyParser.positionMs(msg),
        association: targetSession ? association : 'unassigned',
        lineNumber: entry.lineNumber
      };
      if (targetSession) {
        if (lower.includes('playback stopped') || lower.includes('has ended')) {
          targetSession.stopTime = entry.timestamp;
          targetSession.status = 'Stopped';
        }
        targetSession.events.push(event);
      } else if (context) context.unassignedPlaybackEvents.push(event);
    }
  }

  static resolvePlaybackSession(message, sessionsMap, allowSingleActive = true) {
    const sessions = Array.from(sessionsMap.values());
    const playId = message.match(/\bPlaySessionId[=:\s]+([a-zA-Z0-9_-]+)/i)?.[1];
    if (playId) return sessions.find(session => session.playSessionId === playId) || null;
    const sessionId = message.match(/\bSessionId[=:\s]+([a-zA-Z0-9_-]+)/i)?.[1]
      || message.match(/\bSession\s+([a-zA-Z0-9_-]+)\s+has ended/i)?.[1];
    const candidates = sessionId ? sessions.filter(session => session.sessionId === sessionId) : sessions;
    if (!sessionId && !allowSingleActive) return null;
    const active = candidates.filter(session => session.status === 'Active');
    if (active.length === 1) return active[0];
    return candidates.length === 1 ? candidates[0] : null;
  }

  static positionMs(message) {
    const match = message.match(/\bPosition:\s*(\d+(?:\.\d+)?)\s*(ms|s|ticks)\b/i);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    return unit === 's' ? value * 1000 : unit === 'ticks' ? value / 10000 : value;
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
