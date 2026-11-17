const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EmbyParser = require('../src/engine/parser/emby-parser');

const LogAnalyzerEngine = require('../src/engine/index');
const KnowledgeBase = require('../src/engine/kb/knowledge-base');

describe('Emby Log Analyzer Diagnostic Test Suite', () => {
  const engine = new LogAnalyzerEngine();

  it('Scenario 01: Direct Play Success', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/01-direct-play-success/embyserver.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Healthy');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].overallStatus, 'Success');
    assert.equal(result.sessions[0].playMethod, 'DirectPlay');
    assert.equal(result.sessions[0].user, 'Alice');
  });

  it('Scenario 02: Hardware Transcode NVENC Success', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/02-hardware-transcode-nvenc-success/embyserver.txt'),
      path.join(__dirname, '../test-datasets/02-hardware-transcode-nvenc-success/ffmpeg-transcode-job-nvenc-02.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Healthy');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].overallStatus, 'Success');
    assert.equal(result.sessions[0].ffmpegTranscodeLogsCount, 1);
    assert.equal(result.sessions[0].user, 'Bob');
  });

  it('Scenario 03: Failed Transcode - NVENC Driver Crash', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/embyserver.txt'),
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/ffmpeg-transcode-nvenc-fail-03.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Error');
    const s = result.sessions[0];
    assert.equal(s.overallStatus, 'Error');
    assert.equal(s.primaryRootCause.category, 'Hardware Acceleration');
    assert.match(s.primaryRootCause.title, /NVENC/i);
    assert.ok(s.primaryRootCause.confidence >= 90);
    assert.ok(s.primaryRootCause.recommendations.length > 0);
  });

  it('Scenario 04: Network Client Disconnect', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/04-network-client-disconnect/embyserver.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Warning');
    const s = result.sessions[0];
    assert.equal(s.overallStatus, 'Warning');
    assert.equal(s.primaryRootCause.category, 'Network');
    assert.match(s.primaryRootCause.title, /Client Disconnected/i);
    assert.ok(s.primaryRootCause.confidence >= 85);
  });

  it('Scenario 05: Storage Disk Full', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/05-storage-disk-full/embyserver.txt'),
      path.join(__dirname, '../test-datasets/05-storage-disk-full/ffmpeg-transcode-disk-05.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Critical');
    const s = result.sessions[0];
    assert.equal(s.overallStatus, 'Critical');
    assert.equal(s.primaryRootCause.category, 'Storage');
    assert.match(s.primaryRootCause.title, /Disk Space|Storage/i);
    assert.ok(s.primaryRootCause.confidence >= 95);
  });

  it('Scenario 06: Corrupted Media Container', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/06-corrupted-media-container/embyserver.txt'),
      path.join(__dirname, '../test-datasets/06-corrupted-media-container/ffmpeg-transcode-corrupt-06.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Error');
    const s = result.sessions[0];
    assert.equal(s.primaryRootCause.category, 'Codec & Media');
    assert.match(s.primaryRootCause.title, /Corrupt Container/i);
  });

  it('Scenario 07: File System Permission Denied', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/07-permission-denied-transcode-temp/embyserver.txt'),
      path.join(__dirname, '../test-datasets/07-permission-denied-transcode-temp/ffmpeg-transcode-perm-07.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Error');
    const s = result.sessions[0];
    assert.equal(s.primaryRootCause.category, 'Permissions');
    assert.match(s.primaryRootCause.title, /Permission Denied/i);
  });

  it('Scenario 08: Intel QuickSync / VAAPI Driver Error', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/08-qsv-hardware-failure/embyserver.txt'),
      path.join(__dirname, '../test-datasets/08-qsv-hardware-failure/ffmpeg-transcode-qsv-08.txt')
    ];
    const result = await engine.analyzeFiles(files);
    assert.equal(result.overallHealth, 'Error');
    const s = result.sessions[0];
    assert.equal(s.primaryRootCause.category, 'Hardware Acceleration');
    assert.match(s.primaryRootCause.title, /VAAPI|QuickSync/i);
  });

  it('Multi-session Correlation across multiple log files', async () => {
    const allFiles = [
      path.join(__dirname, '../test-datasets/02-hardware-transcode-nvenc-success/embyserver.txt'),
      path.join(__dirname, '../test-datasets/02-hardware-transcode-nvenc-success/ffmpeg-transcode-job-nvenc-02.txt'),
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/embyserver.txt'),
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/ffmpeg-transcode-nvenc-fail-03.txt')
    ];
    const result = await engine.analyzeFiles(allFiles);
    assert.equal(result.sessions.length, 2);
    const sessionUsers = result.sessions.map(s => s.user).sort();
    assert.deepEqual(sessionUsers, ['Bob', 'Charlie']);
  });

  it('Exporters: HTML, Markdown, JSON generation', async () => {
    const files = [
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/embyserver.txt'),
      path.join(__dirname, '../test-datasets/03-failed-transcode-nvenc-driver-crash/ffmpeg-transcode-nvenc-fail-03.txt')
    ];
    const result = await engine.analyzeFiles(files);
    const jsonRep = engine.exportReport(result, 'json');
    const mdRep = engine.exportReport(result, 'markdown');
    const htmlRep = engine.exportReport(result, 'html');

    assert.ok(jsonRep.includes('NVENC'));
    assert.ok(mdRep.includes('# Emby Log Analyzer Diagnostic Report'));
    assert.ok(htmlRep.includes('<!DOCTYPE html>'));
  });

  it('Coded Checks Engine: evaluates rich object model multi-factor checks', async () => {
    const CodedChecksEngine = require('../src/engine/analyzer/coded-checks');

    // Synthetic session with rich parsed object models
    const syntheticSession = {
      id: 'session-test-01',
      user: 'Alex',
      clientDevice: 'SHIELD Android TV (Android 11)',
      mediaItem: 'Sample 4K Movie.mkv',
      playMethod: 'Transcode',
      events: [
        { details: '/mnt/media_rw/sdcard1/cache' }
      ],
      serverContext: {
        serverVersion: '4.9.5.0',
        operatingSystem: 'Linux version 5.15.0-generic',
        osPlatform: 'Linux',
        osKernel: '5.15.0',
        parsedLineCount: 1500
      },
      transcodeLogs: [
        {
          ffmpegLog: {
            filePath: '/var/log/ffmpeg.txt',
            fileName: 'ffmpeg-transcode-01.txt',
            hwaccel: 'QuickSync (Intel)',
            commandLine: 'ffmpeg -init_hw_device qsv -c:v:0 hevc_qsv -i /long_path -c:v:0 h264_qsv -b:v:0 35000000',
            ffmpegVersion: '5.1-emby_2023_06_25_p4',
            isEmbyFfmpeg: true,
            hasCrashed: false,
            exitCode: 0,
            parsedLineCount: 300,
            userPolicy: {
              user: 'Alex',
              enablePlaybackRemuxing: true,
              enableVideoPlaybackTranscoding: false,
              enableAudioPlaybackTranscoding: true
            },
            hardwareDevices: [
              { index: 0, name: 'Intel UHD Graphics 770 (Alder Lake)', id: '0x4690', sdkVersion: '1.25' }
            ],
            inputStreams: [
              { id: '0:0', type: 'Video', codec: 'hevc', startTime: 0.0, bitrateKbps: 65000, width: 3840, height: 2160 },
              { id: '0:1', type: 'Audio', codec: 'truehd 7.1', startTime: 0.8, bitrateKbps: 4500 }
            ],
            outputStreams: [
              { id: '0:0', type: 'Video', codec: 'h264', bitrateKbps: 35000, width: 1920, height: 1080 },
              { id: '0:1', type: 'Audio', codec: 'aac stereo', bitrateKbps: 384, raw: 'stereo' }
            ],
            videoProcessingSteps: ['HEVC_QSV >> QSV qsv p010 >> vpp_qsv'],
            fpsSamples: [
              { frame: 100, fps: 18, speed: 0.72 },
              { frame: 200, fps: 19, speed: 0.75 },
              { frame: 300, fps: 20, speed: 0.78 }
            ],
            avgSpeed: 0.75,
            minSpeed: 0.72,
            maxSpeed: 0.78,
            isSpeedBottleneck: true,
            errors: [
              { text: 'Too many packets buffered for output stream 1:1' }
            ],
            warnings: [],
            inputFiles: ['/media/shares/' + 'a'.repeat(265) + '.mkv']
          }
        }
      ]
    };

    const findings = CodedChecksEngine.runAllChecks(syntheticSession, syntheticSession.serverContext);
    const ruleIds = findings.map(f => f.ruleId);

    // Verify key multi-factor coded findings triggered on rich models:
    assert.ok(ruleIds.includes('CheckAvStartOffset'), 'Should detect A/V start offset difference (0.8s >= 0.5s)');
    assert.ok(ruleIds.includes('CheckIntelLinuxKernelMinVersion'), 'Should detect Alder Lake kernel floor not met (5.15 < 5.16)');
    assert.ok(ruleIds.includes('CheckMsdkVersion'), 'Should detect legacy MSDK version (1.25 < 1.30)');
    assert.ok(ruleIds.includes('CheckLongMediaPaths'), 'Should detect excessive file path (>255 chars)');
    assert.ok(ruleIds.includes('CheckSourceBitrate'), 'Should detect high source bitrate (>50 Mbps)');
    assert.ok(ruleIds.includes('CheckOutputBitrate'), 'Should detect high output bitrate target (>30 Mbps)');
    assert.ok(ruleIds.includes('CheckCompareFormat'), 'Should detect video downscale (3840 -> 1920)');
    assert.ok(ruleIds.includes('CheckCompareStreams'), 'Should detect surround audio downmixing');
    assert.ok(ruleIds.includes('CheckTranscodingSpeed'), 'Should detect speed bottleneck (0.75x < 1.0x)');
    assert.ok(ruleIds.includes('SuggestTryWithoutSubtitles'), 'Should suggest trying without subtitles on packet buffer overflow');
    assert.ok(ruleIds.includes('CheckServerVersion'), 'Should validate Emby server version');
    assert.ok(ruleIds.includes('CheckFfmpegVersionBackground'), 'Should validate FFmpeg version');
    assert.ok(ruleIds.includes('CheckUserPolicy'), 'Should flag transcoding forbidden by user policy');
    assert.ok(ruleIds.includes('CheckParsedLineCount'), 'Should report diagnostic metrics line count');
  });
});

describe('Audio playback lifecycle evidence', () => {
  function fixture(t, lines) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-playback-evidence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'embyserver.txt');
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  }

  it('distinguishes stop and session end, retaining position, line and neutral HTTP evidence', async t => {
    const file = fixture(t, [
      '2026-11-16 20:00:00.000 Info App: User Test is playing Track 1.flac on Android. PlayMethod=DirectPlay, SessionId=transport, PlaySessionId=play-1',
      '2026-11-16 20:00:06.000 Info Server: Response 206. Time: 6000.5ms. GET /emby/Audio/1/stream?PlaySessionId=play-1&api_key=never-export-this',
      '2026-11-16 20:01:00.000 Info SessionManager: Playback progress: Position: 60000 ms. PlaySessionId: play-1',
      '2026-11-16 20:01:01.000 Info SessionManager: Playback stopped reported by app Android. Position: 61s. PlaySessionId: play-1',
      '2026-11-16 20:01:02.000 Info SessionManager: Session transport has ended'
    ]);
    const report = await new LogAnalyzerEngine().analyzeFiles([file]);
    const evidence = report.sessions[0].playbackEvidence;
    assert.equal(evidence.embySessionId, 'transport');
    assert.equal(evidence.playSessionId, 'play-1');
    assert.equal(evidence.playbackStopReported, true);
    assert.equal(evidence.sessionEndReported, true);
    assert.equal(evidence.naturalCompletion, 'not-established');
    const response = evidence.events.find(event => event.type === 'AUDIO_HTTP_RESPONSE');
    assert.equal(response.httpStatus, 206);
    assert.equal(response.durationMs, 6000.5);
    assert.equal(response.lineNumber, 2);
    assert.equal(evidence.events.find(event => event.type === 'PLAYBACK_STOP').positionMs, 61000);
    assert.equal(JSON.stringify(report).includes('never-export-this'), false);
    assert.equal(report.sessions[0].timeline.some(event => event.type === 'AUDIO_BUFFER_LATENCY'), false);
    assert.doesNotMatch(report.sessions[0].primaryRootCause.explanation, /session completed normally/i);
    for (const format of ['html', 'markdown', 'json']) {
      const exported = new LogAnalyzerEngine().exportReport(report, format);
      assert.match(exported, /PLAYBACK_STOP/);
      assert.match(exported, /SESSION_ENDED/);
      assert.match(exported, /not-established/);
    }
  });

  it('retains ambiguous and unknown-ID events without assigning them by username or nearest track', async t => {
    const file = fixture(t, [
      '2026-11-16 20:00:00.000 Info App: User Test is playing Track 1.flac on Phone. PlayMethod=DirectPlay, PlaySessionId=play-1',
      '2026-11-16 20:00:01.000 Info App: User Test is playing Track 2.flac on TV. PlayMethod=DirectStream, PlaySessionId=play-2',
      '2026-11-16 20:00:02.000 Info SessionManager: Playback stopped reported by client: User Test, Position: 2s',
      '2026-11-16 20:00:03.000 Info SessionManager: Playback stopped. PlaySessionId=not-in-this-file',
      '2026-11-16 20:00:04.000 Info Server: Response 200. Time: 85000ms. GET /emby/Audio/2/stream',
      '2026-11-16 20:00:05.000 Info SessionManager: Playback progress: Position: 4s. PlaySessionId=not-in-this-file',
      '2026-11-16 20:00:06.000 Info Server: Response 416. GET /emby/Audio/2/stream',
      '2026-11-16 20:00:07.000 Info App: ffmpeg -i "/media/track2.flac" -c:a copy "/tmp/transcoding-temp/remux.m4a" PlaySessionId=play-2'
    ]);
    const parsed = await EmbyParser.parseFile(file);
    assert.ok(parsed.sessions.every(session => session.sessionId === null));
    assert.ok(parsed.sessions.every(session => session.stopTime === null));
    assert.equal(parsed.unassignedPlaybackEvents.length, 5);
    assert.equal(parsed.unassignedPlaybackEvents.at(-1).httpStatus, 416);
    assert.equal(parsed.unassignedPlaybackEvents.at(-1).durationMs, null);
    const report = await new LogAnalyzerEngine().analyzeFiles([file]);
    assert.equal(report.unassignedPlaybackEvents.length, 5);
    assert.ok(report.sessions.every(session => session.playbackEvidence.playbackStopReported === false));
    const remux = report.sessions.find(session => session.playbackEvidence.playSessionId === 'play-2');
    assert.equal(remux.playMethod, 'Transcode');
    assert.equal(remux.playbackEvidence.reportedPlayMethod, 'DirectStream');
    assert.match(new LogAnalyzerEngine().exportReport(report, 'html'), /Unassigned playback/);
  });

  it('does not default unreported play methods to Direct Play or missing ends to completed playback', async t => {
    const file = fixture(t, [
      '2026-11-16 20:00:00.000 Info App: Playback start reported by app Emby for Android 3.4 on Phone playing Track 1.flac. Position: 0 ms. PlaySessionId: only-play-id'
    ]);
    const report = await new LogAnalyzerEngine().analyzeFiles([file]);
    const session = report.sessions[0];
    assert.equal(session.playMethod, 'Unknown');
    assert.equal(session.playbackEvidence.embySessionId, null);
    assert.equal(session.playbackEvidence.clientApplication, 'Emby for Android 3.4');
    assert.equal(session.playbackEvidence.playbackStopReported, false);
    assert.equal(session.playbackEvidence.sessionEndReported, false);
    assert.equal(session.playbackEvidence.events[0].positionMs, 0);
    assert.equal(session.playbackEvidence.events[0].association, 'explicit PlaySessionId');
    assert.doesNotMatch(session.primaryRootCause.cause, /transcoded and streamed smoothly/);
    assert.doesNotMatch(session.aiBriefing, /completed without any disruptions|confirm that streams opened and closed cleanly/);
    assert.match(session.aiBriefing, /does not establish natural track completion/);
  });

  it('does not diagnose buffer starvation from a response-after-disconnect observation', () => {
    const matches = new KnowledgeBase().evaluate('Response completed after client disconnected', 'emby');
    const observation = matches.find(match => match.ruleId === 'AUDIO_TRANSFER_BUFFER_STARVATION');
    assert.ok(observation);
    assert.equal(observation.severity, 'Info');
    assert.doesNotMatch(observation.rootCause, /causing playback buffer exhaustion/);
    assert.doesNotMatch(observation.explanation, /19MB|75,000|throttling/);
  });

  it('distinguishes Android app versions from explicitly labelled client OS context', () => {
    const CodedChecksEngine = require('../src/engine/analyzer/coded-checks');
    const findings = [];
    CodedChecksEngine.checkAndroidOs({
      clientDevice: 'Emby for Android 3.4 (Phone)',
      events: [{ details: 'Playback started on AndroidTv 2.1.55g' }]
    }, {}, findings);
    assert.equal(findings.length, 0);
    CodedChecksEngine.checkAndroidOs({
      clientDevice: 'Phone', events: [{ details: 'Client OS: Android 8.1' }]
    }, {}, findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'Info');
    assert.doesNotMatch(findings[0].rootCause, /lacks|failure|codec/);
  });

});
