function buildAndroidPlaybackGuidance(clientLogs) {
  const evidence = [];
  let patternCount = 0;
  let parsingErrors = 0;
  let fallbackAttempts = 0;
  let flacPlaying = 0;
  const requestedBitrates = new Set();
  const reference = (event, signal) => ({
    timestamp: event.timestamp,
    sourceFile: event.sourceFile,
    lineNumber: event.lineNumber,
    signal
  });

  for (const log of clientLogs) {
    let recoveredWindows = new Set();
    let pending = null;
    let flacInput = false;
    let recoveryEvidence = [];
    for (const event of log.events) {
      const text = event.component === 'PlaybackManager' ? `PlaybackManager ${event.details}` : event.details;
      if (Number.isSafeInteger(event.requestedMaxStreamingBitrate)) {
        requestedBitrates.add(event.requestedMaxStreamingBitrate);
      }
      if (event.component === 'ExoPlayerImpl' && /^(?:Init|Release)\s/.test(text)) {
        recoveredWindows = new Set();
        pending = null;
        flacInput = false;
        recoveryEvidence = [];
      }
      if (/ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED/.test(text)) {
        parsingErrors++;
        const window = text.match(/\bwindow=(\d+)/)?.[1];
        pending = { window, fallback: false, event };
        flacInput = false;
      }
      if (/Attempting to fallback to HLS playback/i.test(text)) {
        fallbackAttempts++;
        if (pending) pending.fallback = true;
      }
      if (/audioInputFormat\b/.test(text)) flacInput = /\bcontainer=audio\/flac\b/i.test(text);
      if (/\bPlaybackManager state:\s*STATE_PLAYING\b/.test(text)) {
        if (flacInput) flacPlaying++;
        if (pending?.fallback && pending.window !== undefined) {
          recoveredWindows.add(pending.window);
          recoveryEvidence.push(reference(pending.event, `Container parsing failed for playlist window ${pending.window}; HLS fallback subsequently reached STATE_PLAYING.`));
        } else {
          recoveredWindows.clear();
          recoveryEvidence = [];
        }
        pending = null;
      }
      if (/\bPlaybackManager state:\s*STATE_ERROR\b/.test(text)) {
        if (pending && !pending.fallback && pending.window !== undefined
          && recoveredWindows.size >= 2 && !recoveredWindows.has(pending.window)) {
          patternCount++;
          evidence.push(...recoveryEvidence.slice(-2),
            reference(event, `Playlist window ${pending.window} reached STATE_ERROR after a container parsing failure, with no HLS fallback logged between failure and error state.`));
        }
        recoveredWindows.clear();
        recoveryEvidence = [];
        pending = null;
      }
    }
  }

  const truncated = clientLogs.some(log => log.eventsTruncated);
  const recognized = clientLogs.some(log => log.recognizedLines > 0);
  const status = patternCount ? 'fallback-stall-pattern'
    : parsingErrors ? 'container-errors'
      : recognized ? 'no-matching-pattern' : 'client-data-unavailable';
  const observations = [
    `${parsingErrors} unsupported-container player failure(s); ${fallbackAttempts} logged HLS fallback attempt(s).`,
    `${patternCount} sequence(s) with recovery on at least two distinct playlist windows followed by an unrecovered error on another window in the same logged player run.`,
    `${flacPlaying} STATE_PLAYING event(s) preceded by a reported FLAC input format; this does not prove audible or uninterrupted playback.`
  ];
  observations.push(requestedBitrates.size
    ? `Explicit audio-start MaxStreamingBitrate value(s): ${[...requestedBitrates].sort((a, b) => a - b).join(', ')} bit/s. These are requested limits, not measured network speed or proof of the selected UI setting.`
    : 'No explicit audio-start MaxStreamingBitrate was recognized; the selected audio quality cannot be verified from this log.');

  return {
    status,
    title: patternCount ? 'Observed HLS recovery / subsequent playback failure'
      : parsingErrors ? 'Android container parsing errors observed'
        : recognized ? 'Android evidence reviewed: no matching HLS failure pattern'
          : 'Android evidence is missing or unsupported',
    explanation: patternCount
      ? 'The client log shows repeated container parsing failures, successful HLS recovery on earlier playlist windows, then an error without another logged fallback. This resembles an observed Emby Android case; it is not a proven internal retry limit or server diagnosis.'
      : parsingErrors
        ? 'Container parsing failed, but the complete repeated-recovery/stall pattern was not established. Do not diagnose a third-track bug from an isolated error.'
        : recognized
          ? 'The specific repeated HLS recovery/stall pattern was not established in the retained events. Absence of that pattern does not prove healthy playback.'
          : 'Attach a supported Android diagnostic export before drawing client-side conclusions.',
    observations,
    nextSteps: patternCount ? [
      'Record current Audio streaming quality for Internet and Mobile separately from Video settings. As a controlled workaround test, use an explicit audio limit above the affected source bitrate (4 Mbps worked for the previously investigated FLAC case, not for every source). Higher limits can increase mobile data use.',
      'Restart the Android app, keep network and title order unchanged, and play at least four titles. Include automatic transitions as well as any manually observed skips. Save the original setting so it can be restored.',
      'Export a fresh client log. Verify the actual audio-start MaxStreamingBitrate changed and inspect input formats, player errors and STATE_PLAYING; do not assume a UI change took effect. Preserve before/after logs separately.',
      'If the error persists, collect time-matched Emby/FFmpeg logs and report client/server versions plus the fallback sequence to Emby. Enable server Debug logging only for a short repeat if normal logs lack the needed detail, then disable it.'
    ] : parsingErrors ? [
      'Match the client error time and time zone with the server manifest/segment requests and any FFmpeg job. A playlist HTTP 200 is not proof of client playback.',
      'Record audio quality, network and title order. Repeat only to close a specific evidence gap; one parsing error alone does not justify the 4 Mbps workaround.'
    ] : recognized ? [
      'Compare these events with the reported symptom and matching server logs. If this is a follow-up test, compare the requested audio limit and player path with the original failing log; no automatic cross-run fix confirmation is made.'
    ] : [
      'If server findings leave a client-side evidence gap, use an Android diagnostic export. Keep any unsupported original and try a supported text export first; if a repeat is needed, enable app diagnostic logging beforehand and note exact times and time zone. Server API snapshots cannot retrieve client logs.'
    ],
    limitations: `Separate desktop evidence guidance, not an engine root cause or a guaranteed fix. Analysis is confined to each file/player run; files and devices are not automatically correlated. A missing log message does not prove an action never occurred. ${truncated ? 'Client events were truncated; observations cover only retained events.' : 'Only recognized, retained client events are considered.'}`,
    requestedBitrates: [...requestedBitrates].sort((a, b) => a - b),
    evidence: evidence.slice(-12)
  };
}

module.exports = buildAndroidPlaybackGuidance;
