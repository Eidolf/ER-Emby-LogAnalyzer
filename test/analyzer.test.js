const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

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
