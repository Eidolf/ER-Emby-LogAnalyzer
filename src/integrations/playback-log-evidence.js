const path = require('path');
const fs = require('fs');
const readline = require('readline');
const AndroidClientLogParser = require('./android-client-log-parser');
const buildAndroidPlaybackGuidance = require('./android-playback-guidance');

const MAX_SERVER_EVENTS = 10000;

class PlaybackLogEvidence {
  static async analyze(filePaths, explicitClientFiles = []) {
    if (!Array.isArray(filePaths) || explicitClientFiles.some(file => !filePaths.includes(file))) {
      throw new Error('Android client logs must also be included in the selected file list.');
    }

    const explicitClientSet = new Set(explicitClientFiles);
    const clientFiles = [];
    const serverFiles = [];
    for (const file of filePaths) {
      const name = path.basename(file).toLowerCase();
      if (explicitClientSet.has(file) || /(?:android|client|logcat)/i.test(name)) {
        clientFiles.push(file);
      } else if (!name.startsWith('ffmpeg') && !name.includes('ffmpeg-transcode')) {
        serverFiles.push(file);
      }
    }

    const serverEvents = [];
    for (const file of serverFiles) {
      await PlaybackLogEvidence.readServerFile(file, serverEvents);
    }
    serverEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const clientLogs = [];
    for (const file of clientFiles) {
      clientLogs.push(await AndroidClientLogParser.parseFile(file));
    }

    const clientLogSummary = {
      filesCount: clientLogs.length,
      recognizedLines: clientLogs.reduce((total, log) => total + log.recognizedLines, 0),
      relevantEvents: clientLogs.reduce((total, log) => total + log.relevantEventCount, 0),
      errorEvents: clientLogs.reduce((total, log) => total + log.errorEventCount, 0),
      eventsTruncated: clientLogs.some(log => log.eventsTruncated),
      unsupportedFiles: clientLogs.filter(log => log.recognizedLines === 0)
        .map(log => path.basename(log.filePath)),
      events: clientLogs.flatMap(log => log.events)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    };

    return {
      serverPlaybackEvidence: {
        filesCount: serverFiles.length,
        audioRequests: serverEvents.filter(event => event.type === 'AUDIO_HTTP_REQUEST').length,
        audioResponses: serverEvents.filter(event => event.type === 'AUDIO_HTTP_RESPONSE').length,
        audioSegmentRequests: serverEvents.filter(event =>
          event.type === 'AUDIO_HTTP_REQUEST' && event.resourceKind === 'segment').length,
        nonSuccessAudioResponses: serverEvents.filter(event =>
          event.type === 'AUDIO_HTTP_RESPONSE' && event.httpStatus >= 400).length,
        clientDisconnectedResponses: serverEvents.filter(event =>
          event.type === 'AUDIO_HTTP_RESPONSE' && event.responseOutcome === 'client-disconnected').length,
        events: serverEvents
      },
      clientLogSummary,
      androidPlaybackGuidance: buildAndroidPlaybackGuidance(clientLogs)
    };
  }

  static async readServerFile(filePath, events) {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (events.length >= MAX_SERVER_EVENTS) break;
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+/);
      if (!timestampMatch) continue;
      const requestDetails = PlaybackLogEvidence.audioRequestDetails(line);
      if (!requestDetails) continue;
      const responseMatch = line.match(/\bhttp\/\S+\s+Response(?:\s+(\d{3})|\s+completed\b)/i);
      const status = responseMatch?.[1] ? Number(responseMatch[1]) : null;
      events.push({
        timestamp: timestampMatch[1],
        type: responseMatch ? 'AUDIO_HTTP_RESPONSE' : 'AUDIO_HTTP_REQUEST',
        itemId: requestDetails.itemId,
        playSessionId: requestDetails.playSessionId,
        resourceKind: requestDetails.kind,
        httpStatus: status,
        responseOutcome: responseMatch?.[0].toLowerCase().includes('completed')
          ? 'client-disconnected' : responseMatch ? 'http-status' : null,
        durationMs: Number(line.match(/\bTime:\s*(\d+(?:\.\d+)?)\s*ms/i)?.[1]) || null,
        sourceFile: path.basename(filePath),
        lineNumber
      });
    }
  }

  static audioRequestDetails(line) {
    const requestMatch = line.match(/\b(?:GET|HEAD)\s+(https?:\/\/[^\s]+|\/[^\s]+)/i);
    if (!requestMatch) return null;
    let requestUrl;
    try {
      requestUrl = new URL(requestMatch[1].replace(/[.,]$/, ''), 'http://localhost');
    } catch {
      return null;
    }

    const pathMatch = requestUrl.pathname.match(/\/(?:emby\/)?Audio\/([a-zA-Z0-9_-]+)\/(.+)/i);
    if (!pathMatch) return null;
    const resource = pathMatch[2].toLowerCase();
    const kind = /(?:^|\/)\d+\.ts$/.test(resource) ? 'segment'
      : resource.endsWith('.m3u8') || resource === 'main' ? 'playlist'
        : resource === 'universal' ? 'stream'
          : 'resource';
    return {
      itemId: pathMatch[1],
      playSessionId: requestUrl.searchParams.get('PlaySessionId'),
      kind
    };
  }
}

module.exports = PlaybackLogEvidence;
