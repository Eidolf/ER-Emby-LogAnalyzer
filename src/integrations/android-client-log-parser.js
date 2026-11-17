const fs = require('fs');
const path = require('path');
const readline = require('readline');
const redactSensitiveText = require('./log-redaction');

const MAX_EVENTS = 5000;
const MAX_MESSAGE_LENGTH = 10000;
const RELEVANT_EVIDENCE = /playback|player|exo|media3|audio|decoder|load|http|okhttp|network|buffer|queue|track|source|error|exception|timeout|failed|cancel/i;
const MONTHS = {
  jan: '01', januar: '01',
  feb: '02', februar: '02',
  mar: '03', mär: '03', mrz: '03', märz: '03',
  apr: '04', april: '04',
  may: '05', mai: '05',
  jun: '06', juni: '06',
  jul: '07', juli: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', okt: '10', oktober: '10',
  nov: '11', november: '11',
  dec: '12', dez: '12', dezember: '12'
};

class AndroidClientLogParser {
  static async parseFile(filePath) {
    let lineNumber = 0;
    let recognizedLines = 0;
    let relevantEventCount = 0;
    let errorEventCount = 0;
    const events = [];
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let pendingRecord = null;

    const appendRecord = () => {
      if (!pendingRecord) return;
      recognizedLines++;
      if (['E', 'F'].includes(pendingRecord.level)) errorEventCount++;
      if (RELEVANT_EVIDENCE.test(`${pendingRecord.component} ${pendingRecord.message}`)
        || ['W', 'E', 'F'].includes(pendingRecord.level)) {
        relevantEventCount++;
        if (events.length < MAX_EVENTS) {
          const audioQuery = pendingRecord.message.match(/\bPlaying audio\s+https?:\/\/[^\s?#]+\/Audio\/[^\s?#]+\?([^\s#]+)/i)?.[1];
          const bitrate = Number(audioQuery?.match(/(?:^|&)MaxStreamingBitrate=(\d+)(?:&|$)/)?.[1]);
          const requestedMaxStreamingBitrate = Number.isSafeInteger(bitrate) && bitrate > 0 ? bitrate : null;
          events.push({
            timestamp: pendingRecord.timestamp,
            level: pendingRecord.level,
            component: pendingRecord.component,
            details: redactSensitiveText(pendingRecord.message).slice(0, 1000),
            sourceFile: path.basename(filePath),
            lineNumber: pendingRecord.lineNumber,
            ...(requestedMaxStreamingBitrate === null ? {} : { requestedMaxStreamingBitrate })
          });
        }
      }
      pendingRecord = null;
    };

    for await (const line of rl) {
      lineNumber++;
      const record = AndroidClientLogParser.parseRecord(line);
      if (record) {
        appendRecord();
        pendingRecord = { ...record, lineNumber };
      } else if (pendingRecord && line.trim() && /^\s/.test(line)) {
        pendingRecord.message = `${pendingRecord.message}\n${line.trim()}`.slice(0, MAX_MESSAGE_LENGTH);
      } else if (line.trim()) {
        appendRecord();
      }
    }
    appendRecord();

    return {
      filePath,
      totalLines: lineNumber,
      recognizedLines,
      relevantEventCount,
      errorEventCount,
      events,
      eventsTruncated: relevantEventCount > events.length
    };
  }

  static parseRecord(line) {
    const appDiagnostic = line.match(
      /^(?:\S+\s+)?([^\s.]+)\.?\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+GMT([+-]\d{2}:\d{2})\s+(\d{4})\s+(.*)$/u
    );
    if (appDiagnostic) {
      const month = MONTHS[appDiagnostic[1].toLowerCase()];
      if (!month) return null;
      const message = appDiagnostic[6];
      const componentMatch = message.match(/^([A-Za-z][A-Za-z0-9_.$-]{0,80}):\s*(.*)$/);
      const component = componentMatch && !componentMatch[2].startsWith('//')
        ? componentMatch[1] : 'Emby Android';
      const details = componentMatch && component !== 'Emby Android' ? componentMatch[2] : message;
      const level = /\b(?:fatal|error|exception|failed|failure|timeout|STATE_ERROR)\b|internalError|loadError|playerFailed|errorCode=/i.test(details) ? 'E'
        : /\b(?:warning|warn)\b/i.test(details) ? 'W' : 'I';
      return {
        timestamp: `${appDiagnostic[5]}-${month}-${appDiagnostic[2].padStart(2, '0')} ${appDiagnostic[3]}${appDiagnostic[4]}`,
        level,
        component,
        message: details
      };
    }

    const threadTime = line.match(
      /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/i
    );
    if (threadTime) {
      return {
        timestamp: `${threadTime[1]} ${threadTime[2]}`,
        level: threadTime[3].toUpperCase(),
        component: threadTime[4].trim(),
        message: threadTime[5]
      };
    }

    const datedLogcat = line.match(
      /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/i
    );
    if (datedLogcat) {
      return {
        timestamp: datedLogcat[1].replace('T', ' '),
        level: datedLogcat[2].toUpperCase(),
        component: datedLogcat[3].trim(),
        message: datedLogcat[4]
      };
    }

    const appLog = line.match(
      /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(Verbose|Debug|Info|Warn(?:ing)?|Error|Fatal)\s+([^:]+):\s?(.*)$/i
    );
    if (!appLog) return null;
    const level = appLog[2].toUpperCase();
    return {
      timestamp: appLog[1].replace('T', ' '),
      level: level === 'WARNING' ? 'W' : level === 'ERROR' ? 'E' : level === 'FATAL' ? 'F' : level[0],
      component: appLog[3].trim(),
      message: appLog[4]
    };
  }
}

module.exports = AndroidClientLogParser;
