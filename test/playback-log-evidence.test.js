const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const PlaybackLogEvidence = require('../src/integrations/playback-log-evidence');
const LogAnalyzerEngine = require('../src/engine');

async function writeClientLog(t, records, name = 'android.txt') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emby-guided-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await fs.writeFile(file, records.map((record, index) =>
    `Di. Nov. 17 04:00:00.${String(index).padStart(3, '0')} GMT+01:00 2026 ${record}`).join('\n'));
  return file;
}

const containerFailure = window =>
  `EventLogger: playerFailed [window=${window}, errorCode=ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED]`;
const recoveredTrack = window => [
  containerFailure(window),
  'Attempting to fallback to HLS playback',
  'PlaybackManager state: STATE_PLAYING'
];
const stalledTrack = window => [containerFailure(window), 'PlaybackManager state: STATE_ERROR'];

describe('Additional playback log evidence', () => {
  it('distinguishes an audio request and response from HLS segment requests', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emby-log-evidence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const serverLog = path.join(directory, 'embyserver.txt');
    const ffmpegLog = path.join(directory, 'ffmpeg-transcode-test.txt');
    await fs.writeFile(serverLog, [
      '2026-11-17 01:51:33.865 Info UniversalAudioService: http/2 GET https://emby.example/emby/Audio/2754046/universal?PlaySessionId=play-3&api_key=never-export-this. Source Ip: 192.0.2.10',
      '2026-11-17 01:51:33.871 Info UniversalAudioService: http/2 Response 200 to client. Time: 6ms. GET https://emby.example/emby/Audio/2754046/universal?PlaySessionId=play-3&api_key=never-export-this. Headers: Content-Type=application/vnd.apple.mpegurl',
      '2026-11-17 01:51:34.120 Info UniversalAudioService: http/1.1 Response completed after client disconnected. Time: 15202ms. GET https://emby.example/emby/Audio/2754046/universal?PlaySessionId=play-4&api_key=never-export-this.',
      '2026-11-17 01:51:34.000 Info DynamicHlsService: http/2 GET https://emby.example/emby/Audio/2754046/hls1/main/0.ts?PlaySessionId=play-3. Source Ip: 192.0.2.10',
      '2026-11-17 01:51:34.002 Info DynamicHlsService: http/2 Response 200 to client. Time: 2ms. GET https://emby.example/emby/Audio/2754046/hls1/main/0.ts?PlaySessionId=play-3.'
    ].join('\n'));
    await fs.writeFile(ffmpegLog, 'ffmpeg output is not an Emby HTTP log');

    const report = await PlaybackLogEvidence.analyze([serverLog, ffmpegLog]);
    assert.deepEqual({
      requests: report.serverPlaybackEvidence.audioRequests,
      responses: report.serverPlaybackEvidence.audioResponses,
      segments: report.serverPlaybackEvidence.audioSegmentRequests,
      failures: report.serverPlaybackEvidence.nonSuccessAudioResponses,
      clientDisconnects: report.serverPlaybackEvidence.clientDisconnectedResponses
    }, { requests: 2, responses: 3, segments: 1, failures: 0, clientDisconnects: 1 });
    assert.equal(report.serverPlaybackEvidence.events[1].httpStatus, 200);
    assert.equal(report.serverPlaybackEvidence.events[1].playSessionId, 'play-3');
    const disconnectedResponse = report.serverPlaybackEvidence.events.find(event =>
      event.playSessionId === 'play-4');
    assert.equal(disconnectedResponse.type, 'AUDIO_HTTP_RESPONSE');
    assert.equal(disconnectedResponse.httpStatus, null);
    assert.equal(disconnectedResponse.responseOutcome, 'client-disconnected');
    assert.equal(disconnectedResponse.durationMs, 15202);
    assert.equal(JSON.stringify(report).includes('never-export-this'), false);
  });

  it('parses supported Android logcat lines, redacts credentials, and flags unknown formats', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emby-client-evidence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const clientLog = path.join(directory, 'app-diagnostics.txt');
    const unsupportedLog = path.join(directory, 'app-export.txt');
    await fs.writeFile(clientLog, [
      '11-17 01:51:33.865  1234  5678 I Media3: Playback request started for next item',
      '11-17 01:51:34.120  1234  5678 E ExoPlayerImplInternal: Playback error after GET https://emby.example/Audio/1?api_key=client-secret',
      '2026-11-17 01:51:34.500 1234 5678 D OkHttp: request timed out'
    ].join('\n'));
    await fs.writeFile(unsupportedLog, 'diagnostic format not recognized');

    const report = await PlaybackLogEvidence.analyze([clientLog, unsupportedLog], [clientLog, unsupportedLog]);
    assert.equal(report.clientLogSummary.filesCount, 2);
    assert.equal(report.clientLogSummary.recognizedLines, 3);
    assert.equal(report.clientLogSummary.relevantEvents, 3);
    assert.deepEqual(report.clientLogSummary.unsupportedFiles, ['app-export.txt']);
    assert.match(report.clientLogSummary.events[1].details, /api_key=\[redacted\]/);
    assert.equal(JSON.stringify(report).includes('client-secret'), false);
  });

  it('parses the Emby Android diagnostic export and retains multiline ExoPlayer errors', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emby-android-export-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const clientLog = path.join(directory, 'emby_android.txt');
    await fs.writeFile(clientLog, [
      'Di. Nov. 17 02:53:15.937 GMT+01:00 2026 EventLogger: playerFailed [eventTime=122.01, mediaPos=0.00, window=2, errorCode=ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED] https://emby.example/audio?api_key=client-secret',
      '  androidx.media3.exoplayer.source.UnrecognizedInputFormatException: None of the available extractors could read the stream.',
      '      at androidx.media3.exoplayer.upstream.Loader$LoadTask.run(Loader.java:453)',
      'Di. Nov. 17 02:53:15.941 GMT+01:00 2026 PlaybackManager state: STATE_STOPPED'
    ].join('\r'));

    const report = await PlaybackLogEvidence.analyze([clientLog], [clientLog]);
    assert.equal(report.clientLogSummary.recognizedLines, 2);
    assert.equal(report.clientLogSummary.relevantEvents, 2);
    assert.equal(report.clientLogSummary.errorEvents, 1);
    assert.deepEqual(report.clientLogSummary.unsupportedFiles, []);
    assert.equal(report.clientLogSummary.events[0].timestamp, '2026-11-17 02:53:15.937+01:00');
    assert.equal(report.clientLogSummary.events[0].component, 'EventLogger');
    assert.match(report.clientLogSummary.events[0].details, /UnrecognizedInputFormatException/);
    assert.match(report.clientLogSummary.events[0].details, /Loader\.java:453/);
    assert.equal(JSON.stringify(report).includes('client-secret'), false);
  });

  it('rejects client files that are not in the selected input set', async () => {
    await assert.rejects(
      PlaybackLogEvidence.analyze(['/tmp/embyserver.txt'], ['/tmp/android-client.log']),
      /must also be included/
    );
  });

  it('recognizes the recovered-HLS/stall sequence and exports qualified guidance with source evidence', async t => {
    const file = await writeClientLog(t, [
      'ExoPlayerImpl: Init test-player',
      'Playing audio https://emby.example/emby/Audio/1/universal?api_key=never-export-this&MaxStreamingBitrate=1000001',
      ...recoveredTrack(7),
      ...recoveredTrack(8),
      ...stalledTrack(9)
    ]);
    const evidence = await PlaybackLogEvidence.analyze([file]);
    const guidance = evidence.androidPlaybackGuidance;
    assert.equal(guidance.status, 'fallback-stall-pattern');
    assert.deepEqual(guidance.requestedBitrates, [1000001]);
    assert.equal(evidence.serverPlaybackEvidence.filesCount, 0);
    assert.equal(guidance.evidence.length, 3);
    assert.match(guidance.evidence[2].signal, /window 9.*STATE_ERROR/);
    assert.equal(guidance.evidence[2].lineNumber, 10);
    assert.match(guidance.evidence[2].timestamp, /\+01:00$/);
    assert.match(guidance.nextSteps[0], /4 Mbps.*not for every source/);
    assert.match(guidance.limitations, /not an engine root cause or a guaranteed fix/);
    const engine = new LogAnalyzerEngine();
    const report = { ...await engine.analyzeFiles([]), ...evidence };
    for (const format of ['json', 'markdown', 'html']) {
      const output = engine.exportReport(report, format);
      assert.match(output, /4 Mbps/);
      assert.match(output, /STATE\\?_ERROR/);
      assert.match(output, /not an engine root cause/);
      assert.equal(output.includes('never-export-this'), false);
      if (format !== 'json') assert.match(output, /Not assessed/);
    }
    report.androidPlaybackGuidance.evidence[0].sourceFile = '<img src=x onerror=alert(1)>';
    assert.equal(engine.exportReport(report, 'html').includes('<img src=x'), false);
  });

  it('does not combine recoveries across files or ExoPlayer runs, or count one window twice', async t => {
    const examples = [
      [...recoveredTrack(1), 'ExoPlayerImpl: Release old', 'ExoPlayerImpl: Init new', ...recoveredTrack(2), ...stalledTrack(3)],
      [...recoveredTrack(1), ...recoveredTrack(1), ...stalledTrack(2)],
      [...recoveredTrack(1), ...recoveredTrack(2), ...stalledTrack(1)],
      [...recoveredTrack(1), ...recoveredTrack(2), 'PlaybackManager state: STATE_PLAYING', ...stalledTrack(3)]
    ];
    for (const records of examples) {
      const file = await writeClientLog(t, records);
      const report = await PlaybackLogEvidence.analyze([file]);
      assert.equal(report.androidPlaybackGuidance.status, 'container-errors');
      assert.equal(report.androidPlaybackGuidance.evidence.length, 0);
      assert.equal(report.androidPlaybackGuidance.nextSteps.some(step => /worked for/.test(step)), false);
    }
    const first = await writeClientLog(t, recoveredTrack(1));
    const second = await writeClientLog(t, [...recoveredTrack(2), ...stalledTrack(3)]);
    const report = await PlaybackLogEvidence.analyze([first, second]);
    assert.equal(report.androidPlaybackGuidance.status, 'container-errors');
  });

  it('does not label a later recovered error as a stall or forget an earlier complete pattern', async t => {
    const recovered = await writeClientLog(t, [...recoveredTrack(1), ...recoveredTrack(2), ...recoveredTrack(3)]);
    assert.equal((await PlaybackLogEvidence.analyze([recovered])).androidPlaybackGuidance.status, 'container-errors');
    const cumulative = await writeClientLog(t, [
      ...recoveredTrack(1), ...recoveredTrack(2), ...stalledTrack(3),
      'ExoPlayerImpl: Release old', 'ExoPlayerImpl: Init new',
      'EventLogger: audioInputFormat [window=1, container=audio/flac]',
      'PlaybackManager state: STATE_PLAYING'
    ]);
    const guidance = (await PlaybackLogEvidence.analyze([cumulative])).androidPlaybackGuidance;
    assert.equal(guidance.status, 'fallback-stall-pattern');
    assert.equal(guidance.evidence.length, 3);
    assert.match(guidance.explanation, /log shows/);
    assert.match(guidance.limitations, /each file\/player run/);
  });

  it('reports the requested 4 Mbps limit and FLAC input without claiming a cure', async t => {
    const file = await writeClientLog(t, [
      'ExoPlayerImpl: Init test-player',
      'Playing audio https://emby.example/Audio/1/universal?MaxStreamingBitrate=4000000&api_key=never-export-this',
      ...[1, 2, 3, 4].flatMap(window => [
        `EventLogger: audioInputFormat [window=${window}, mimeType=audio/raw, container=audio/flac]`,
        'PlaybackManager state: STATE_PLAYING'
      ])
    ]);
    const guidance = (await PlaybackLogEvidence.analyze([file])).androidPlaybackGuidance;
    assert.equal(guidance.status, 'no-matching-pattern');
    assert.deepEqual(guidance.requestedBitrates, [4000000]);
    assert.match(guidance.observations.join('\n'), /4 STATE_PLAYING event/);
    assert.match(guidance.explanation, /does not prove healthy playback/);
    assert.equal(guidance.nextSteps.some(step => /4 Mbps/.test(step)), false);
    assert.equal(guidance.evidence.length, 0);
  });

  it('does not infer audio quality from unrelated, malformed or absent bitrate fields', async t => {
    const file = await writeClientLog(t, [
      'Playing video https://emby.example/Video/1?MaxStreamingBitrate=4000000',
      'Playing audio https://emby.example/Audio/1/universal?MaxStreamingBitrate=invalid',
      'Playing audio https://emby.example/Audio/1/universal?MaxStreamingBitrate=9007199254740993',
      'Playing audio https://emby.example/Audio/1/universal?MaxStreamingBitrate=0',
      'Playing audio https://emby.example/Audio/1/universal?MaxStreamingBitrate=4000000oops'
    ]);
    const guidance = (await PlaybackLogEvidence.analyze([file])).androidPlaybackGuidance;
    assert.deepEqual(guidance.requestedBitrates, []);
    assert.match(guidance.observations.join('\n'), /cannot be verified/);
    const missing = await PlaybackLogEvidence.analyze([]);
    assert.equal(missing.androidPlaybackGuidance.status, 'client-data-unavailable');
    assert.equal(missing.androidPlaybackGuidance.nextSteps.some(step => /4 Mbps/.test(step)), false);
  });

  it('surfaces incomplete retained evidence instead of treating truncated logs as healthy', async t => {
    const file = await writeClientLog(t, Array(5001).fill('EventLogger: playback evidence'));
    const report = await PlaybackLogEvidence.analyze([file]);
    assert.equal(report.clientLogSummary.eventsTruncated, true);
    assert.match(report.androidPlaybackGuidance.limitations, /were truncated/);
    assert.equal(report.androidPlaybackGuidance.status, 'no-matching-pattern');
  });
});
