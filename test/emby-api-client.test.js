const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const EmbyApiClient = require('../src/integrations/emby-api-client');
const ReportExporter = require('../src/engine/exporter/report-exporter');
const SnapshotComparison = require('../src/shared/snapshot-comparison');
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

describe('Emby read-only API client', () => {
  it('fetches public server info and active sessions with GET only', async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url: new URL(url), options });
      return jsonResponse(new URL(url).pathname.endsWith('/System/Info/Public')
          ? { ServerName: 'Test Emby', Version: '4.11.0.13', OperatingSystem: 'Linux' }
          : [{
              Id: 'session-1',
              UserName: 'Alex',
              Client: 'Emby Theater',
              DeviceName: 'Living Room',
              DeviceId: 'device-1',
              DeviceType: 'Tv',
              RemoteEndPoint: '192.0.2.10',
              LastActivityDate: '2026-11-16T23:00:00Z',
              ApplicationVersion: '1.2.3',
              NowPlayingItem: { Id: 'item-1', Name: 'Example Movie' },
              PlayState: {
                PlayMethod: 'Transcode', PositionTicks: 50000000, IsPaused: false,
                MediaSource: { Path: '/private/media', TranscodingUrl: '/stream?api_key=test-token' }
              },
              TranscodingInfo: {
                VideoCodec: 'h264',
                VideoEncoder: 'h264_qsv',
                VideoEncoderIsHardware: true,
                VideoEncoderHwAccel: 'qsv',
                TranscodeReasons: ['VideoCodecNotSupported']
              }
            }]);
    };

    const client = new EmbyApiClient({ fetchImpl, timeoutMs: 1000 });
    const snapshot = await client.fetchSnapshot({
      baseUrl: 'http://localhost:8096',
      token: 'test-token'
    });

    assert.deepEqual(requests.map(request => request.url.pathname), [
      '/emby/System/Info/Public',
      '/emby/Sessions'
    ]);
    assert.ok(requests.every(request => request.options.method === 'GET'));
    assert.equal(requests[0].options.headers['X-Emby-Token'], undefined);
    assert.equal(requests[1].options.headers['X-Emby-Token'], 'test-token');
    assert.equal(snapshot.server.version, '4.11.0.13');
    assert.equal(snapshot.sessions[0].mediaItem.name, 'Example Movie');
    assert.equal(snapshot.sessions[0].transcodingInfo.videoEncoderIsHardware, true);
    assert.equal(snapshot.sessions[0].deviceId, 'device-1');
    assert.equal(snapshot.sessions[0].remoteEndPoint, '192.0.2.10');
    assert.equal(snapshot.summary.playing, 1);
    assert.deepEqual(snapshot.sessions[0].transcodingInfo.transcodeReasons, ['VideoCodecNotSupported']);
    assert.equal(JSON.stringify(snapshot).includes('test-token'), false);
  });

  it('accepts a base URL already ending in /emby without duplicating the path', async () => {
    const requestedPaths = [];
    const fetchImpl = async url => {
      requestedPaths.push(new URL(url).pathname);
      return jsonResponse(new URL(url).pathname.endsWith('/System/Info/Public') ? {} : []);
    };

    const client = new EmbyApiClient({ fetchImpl, timeoutMs: 1000 });
    await client.fetchSnapshot({ baseUrl: 'https://emby.example/emby/', token: 'token' });

    assert.deepEqual(requestedPaths, ['/emby/System/Info/Public', '/emby/Sessions']);
  });

  it('rejects unsafe or malformed server URLs before making a request', async () => {
    let calls = 0;
    const client = new EmbyApiClient({
      fetchImpl: async () => {
        calls++;
        throw new Error('unexpected network request');
      }
    });

    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'file:///tmp/emby', token: 'token' }),
      /must use HTTP or HTTPS/
    );
    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'https://user:password@emby.example', token: 'token' }),
      /Do not include credentials/
    );
    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'https://emby.example/?api_key=secret', token: 'token' }),
      /must not contain a query string/
    );
    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'https://emby.example' }),
      /API key or access token is required/
    );
    assert.equal(calls, 0);
  });

  it('surfaces HTTP failures without including the API token', async () => {
    const client = new EmbyApiClient({
      fetchImpl: async () => jsonResponse({ error: 'Do not expose response bodies' }, 401),
      timeoutMs: 1000
    });

    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'https://emby.example', token: 'secret-token' }),
      error => {
        assert.match(error.message, /HTTP 401/);
        assert.equal(error.message.includes('secret-token'), false);
        return true;
      }
    );
  });

  it('rejects invalid API response shapes', async () => {
    let calls = 0;
    const client = new EmbyApiClient({
      fetchImpl: async () => jsonResponse(++calls === 1 ? {} : { Items: [] }),
      timeoutMs: 1000
    });

    await assert.rejects(
      client.fetchSnapshot({ baseUrl: 'http://localhost:8096/emby', token: 'token' }),
      /invalid sessions response/
    );
  });

  it('tests a public URL without requiring or sending credentials', async () => {
    const requests = [];
    const client = new EmbyApiClient({
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return jsonResponse({ ServerName: 'Public Emby', Id: 'server-1' });
      }
    });
    const result = await client.testConnection({ baseUrl: 'http://localhost:8096', token: 'ignored' });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/System\/Info\/Public$/);
    assert.equal(requests[0].options.headers['X-Emby-Token'], undefined);
    assert.equal(result.server.id, 'server-1');
    assert.match(result.warnings[0], /HTTP is unencrypted/);
  });

  it('retains the core snapshot and explicitly reports a denied optional endpoint', async () => {
    const requests = [];
    const client = new EmbyApiClient({
      fetchImpl: async (url, options) => {
        const path = new URL(url).pathname;
        requests.push({ url: new URL(url), options });
        if (path.endsWith('/Info/Public')) return jsonResponse({ ServerName: 'Emby' });
        if (path.endsWith('/Sessions')) return jsonResponse([]);
        if (path.endsWith('/System/Info')) return jsonResponse({
          HasPendingRestart: false, IsShuttingDown: true, OperatingSystemDisplayName: 'Linux test',
          ProgramDataPath: '/private/path'
        });
        return jsonResponse({ error: 'private server response' }, 403);
      }
    });
    const snapshot = await client.fetchSnapshot({
      baseUrl: 'https://emby.example', token: 'credential',
      includeSystemInfo: true, includeActivityLog: true
    });
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.options.method === 'GET'));
    assert.ok(requests.every(request => request.options.redirect === 'error'));
    const activityRequest = requests.find(request => request.url.pathname.endsWith('/Entries'));
    assert.equal(activityRequest.url.searchParams.get('Limit'), '50');
    assert.equal(activityRequest.url.searchParams.get('StartIndex'), '0');
    assert.equal(activityRequest.url.searchParams.has('api_key'), false);
    assert.equal(snapshot.server.hasPendingRestart, false);
    assert.equal(snapshot.server.isShuttingDown, true);
    assert.equal(snapshot.endpointStatus.systemInfo.status, 'ok');
    assert.equal(snapshot.endpointStatus.activityLog.status, 'error');
    assert.equal(snapshot.activityLog, null);
    assert.match(snapshot.warnings[0], /HTTP 403/);
    assert.equal(JSON.stringify(snapshot).includes('/private/path'), false);
    assert.equal(JSON.stringify(snapshot).includes('private server response'), false);
    assert.equal(JSON.stringify(snapshot).includes('credential'), false);
  });

  it('limits activity entries and excludes raw descriptions, paths and playback URLs', async () => {
    const client = new EmbyApiClient({
      fetchImpl: async url => {
        const path = new URL(url).pathname;
        if (path.endsWith('/Info/Public')) return jsonResponse({});
        if (path.endsWith('/Sessions')) return jsonResponse([]);
        return jsonResponse({
          TotalRecordCount: 123,
          Items: Array.from({ length: 60 }, (_, index) => ({
            Name: `Entry ${index}`, Date: '2026-11-16T23:00:00Z', Severity: 'Warn', Type: 'Test',
            Overview: 'secret-detail', UserId: 'private-id'
          }))
        });
      }
    });
    const snapshot = await client.fetchSnapshot({
      baseUrl: 'https://emby.example', token: 'test-token', includeActivityLog: true
    });
    assert.equal(snapshot.endpointStatus.systemInfo.status, 'not-requested');
    assert.equal(snapshot.activityLog.entries.length, 50);
    assert.equal(snapshot.activityLog.totalRecordCount, 123);
    assert.equal(snapshot.activityLog.entries[0].severity, 'Warn');
    assert.equal(JSON.stringify(snapshot).includes('secret-detail'), false);
    assert.equal(snapshot.activityLog.entries[0].userId, 'private-id');
  });

  it('reports malformed optional responses instead of claiming empty success', async () => {
    const client = new EmbyApiClient({
      fetchImpl: async url => jsonResponse(new URL(url).pathname.endsWith('/Info/Public') ? {}
        : new URL(url).pathname.endsWith('/Sessions') ? [] : { Items: null })
    });
    const snapshot = await client.fetchSnapshot({
      baseUrl: 'https://emby.example', token: 'test-token', includeActivityLog: true
    });
    assert.equal(snapshot.activityLog, null);
    assert.equal(snapshot.endpointStatus.activityLog.status, 'error');
    assert.match(snapshot.warnings.join(' '), /invalid activity log entries/);
  });

  it('lists and downloads only supported Emby/FFmpeg logs with authenticated GET requests', async () => {
    const requests = [];
    const client = new EmbyApiClient({
      fetchImpl: async (url, options) => {
        requests.push({ url: new URL(url), options });
        if (new URL(url).pathname.endsWith('/System/Logs')) {
          return jsonResponse([
            { Name: 'embyserver.txt', Size: 128, DateModified: '2026-11-17T00:00:00Z' },
            { Name: 'ffmpeg-transcode-abc_1.txt', Size: 64 },
            { Name: '../embyserver-secret.txt', Size: 5 },
            { Name: 'config.json', Size: 5 }
          ]);
        }
        return new Response('server log contents');
      }
    });

    const logs = await client.listServerLogs({
      baseUrl: 'https://emby.example', token: 'admin-token'
    });
    assert.deepEqual(logs.map(log => log.name), ['embyserver.txt', 'ffmpeg-transcode-abc_1.txt']);
    assert.equal(logs[0].size, 128);

    const content = await client.fetchServerLog({
      baseUrl: 'https://emby.example', token: 'admin-token', name: 'embyserver.txt'
    });
    assert.equal(content.toString('utf8'), 'server log contents');
    assert.deepEqual(requests.map(request => request.options.method), ['GET', 'GET']);
    assert.ok(requests.every(request => request.options.redirect === 'error'));
    assert.ok(requests.every(request => request.options.headers['X-Emby-Token'] === 'admin-token'));
    assert.equal(requests[1].url.pathname, '/emby/System/Logs/Log');
    assert.equal(requests[1].url.searchParams.get('Name'), 'embyserver.txt');
    assert.ok(requests.every(request => !request.url.href.includes('admin-token')));

    await assert.rejects(
      client.fetchServerLog({ baseUrl: 'https://emby.example', token: 'admin-token', name: '../secret.txt' }),
      /Select an Emby server or FFmpeg log/
    );
    assert.equal(requests.length, 2);
  });

  it('surfaces administrator permission failures without leaking server response bodies', async () => {
    const client = new EmbyApiClient({
      fetchImpl: async () => jsonResponse({ error: 'private admin detail' }, 403)
    });
    await assert.rejects(
      client.listServerLogs({ baseUrl: 'https://emby.example', token: 'admin-token' }),
      error => {
        assert.match(error.message, /HTTP 403/);
        assert.equal(error.message.includes('private admin detail'), false);
        assert.equal(error.message.includes('admin-token'), false);
        return true;
      }
    );
  });

  it('distinguishes copied video, reported software and unknown hardware status', () => {
    const normalize = value => EmbyApiClient.normalizeSession({
      NowPlayingItem: { Name: 'Example' }, TranscodingInfo: value
    });
    const copied = normalize({ IsVideoDirect: true, IsAudioDirect: false, VideoEncoderIsHardware: false });
    const software = normalize({ VideoEncoder: 'libx264', VideoEncoderIsHardware: false, Bitrate: 0, CurrentCpuUsage: 0 });
    const unknown = normalize({});
    const hardware = normalize({ VideoEncoderIsHardware: true, VideoDecoderIsHardware: false });
    hardware.playState.isPaused = false;
    const idle = EmbyApiClient.normalizeSession({ DeviceId: 'idle-device', DeviceType: 'Tv' });
    const paused = EmbyApiClient.normalizeSession({ NowPlayingItem: { Name: 'Paused' }, PlayState: { IsPaused: true } });
    const summary = EmbyApiClient.summarizeSessions([copied, software, unknown, hardware, idle, paused]);
    assert.deepEqual(summary, { connected: 6, playing: 1, paused: 1, playbackStateUnknown: 3, idle: 1, transcodes: 4, hardwareVideo: 1, softwareVideo: 1 });
    assert.match(copied.diagnostics.join(' '), /copied \(no video conversion\)/);
    assert.match(copied.diagnostics.join(' '), /Audio: converted/);
    assert.match(unknown.diagnostics.join(' '), /hardware status unknown/);
    assert.match(software.diagnostics.join(' '), /CPU \(server reported\): 0%/);
    assert.equal(idle.deviceId, 'idle-device');
  });

  it('surfaces invalid JSON, oversized bodies, timeouts and sanitized transport failures', async () => {
    const connection = { baseUrl: 'https://emby.example' };
    const invalid = new EmbyApiClient({ fetchImpl: async () => new Response('not json') });
    await assert.rejects(invalid.testConnection(connection), /invalid JSON/);
    const validBody = '{"ServerName":"At the limit"}';
    const atLimit = new EmbyApiClient({
      fetchImpl: async () => new Response(validBody.padEnd(2 * 1024 * 1024, ' '))
    });
    assert.equal((await atLimit.testConnection(connection)).server.name, 'At the limit');
    const oversized = new EmbyApiClient({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
    await assert.rejects(oversized.testConnection(connection), /2 MiB response limit/);
    const offline = new EmbyApiClient({ fetchImpl: async () => { throw new Error('transport includes secret-token'); } });
    await assert.rejects(offline.testConnection(connection), error => {
      assert.match(error.message, /network and TLS/);
      assert.equal(error.message.includes('secret-token'), false);
      return true;
    });
    const timeout = new EmbyApiClient({
      timeoutMs: 10,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    });
    await assert.rejects(timeout.testConnection(connection), /timed out/);
  });

  it('uses the real HTTP transport with only fixed GET routes and refuses redirects', async t => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, token: request.headers['x-emby-token'] });
      if (request.url === '/slow/emby/System/Info/Public') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        return;
      }
      if (request.url === '/redirect/emby/System/Info/Public'
        || request.url === '/auth-redirect/emby/Sessions') {
        response.writeHead(302, { Location: '/unexpected' });
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url.endsWith('/Sessions') ? [] : { ServerName: 'HTTP fixture' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = new EmbyApiClient({ timeoutMs: 1000 });
    const snapshot = await client.fetchSnapshot({ baseUrl, token: 'local-fixture-token' });
    assert.equal(snapshot.server.name, 'HTTP fixture');
    assert.deepEqual(requests.map(request => request.method), ['GET', 'GET']);
    assert.equal(requests.find(request => request.url.endsWith('/Public')).token, undefined);
    assert.equal(requests.find(request => request.url.endsWith('/Sessions')).token, 'local-fixture-token');
    await assert.rejects(client.testConnection({ baseUrl: `${baseUrl}/redirect` }), /redirects are not followed/);
    await assert.rejects(client.fetchSnapshot({
      baseUrl: `${baseUrl}/auth-redirect`, token: 'local-fixture-token'
    }), /redirects are not followed/);
    assert.equal(requests.some(request => request.url === '/unexpected'), false);
    const shortTimeout = new EmbyApiClient({ timeoutMs: 50 });
    await assert.rejects(shortTimeout.testConnection({ baseUrl: `${baseUrl}/slow` }), /timed out/);
    assert.ok(requests.some(request => request.url === '/slow/emby/System/Info/Public'));
  });

  it('exports an optional snapshot without credentials in Markdown and HTML', () => {
    const report = {
      analyzedAt: '2026-11-16T10:00:00.000Z',
      overallHealth: 'Healthy',
      metrics: {
        totalSessions: 0,
        successCount: 0,
        warningCount: 0,
        errorCount: 0,
        criticalCount: 0
      },
      sessions: [],
      embySnapshot: {
        capturedAt: '2026-11-16T09:59:00.000Z',
        server: { name: 'Local Emby', version: '4.11.0.13', operatingSystem: 'Linux' },
        sessions: [{
          userName: 'Alex',
          client: 'Emby Theater',
          deviceName: 'Living Room',
          mediaItem: { name: 'Example Movie' },
          playState: { playMethod: 'Transcode' },
          transcodingInfo: {
            videoCodec: 'h264',
            videoEncoder: 'h264_qsv',
            videoEncoderIsHardware: true,
            transcodeReasons: ['VideoCodecNotSupported']
          }
        }]
      }
    };

    const markdown = ReportExporter.toMarkdown(report);
    const html = ReportExporter.toHTML(report);
    const json = ReportExporter.toJSON(report);

    assert.match(markdown, /Live Emby API Snapshot \(read-only\)/);
    assert.match(markdown, /VideoCodecNotSupported/);
    assert.match(html, /Live Emby API Snapshot \(read-only\)/);
    assert.match(html, /h264_qsv/);
    assert.match(json, /Local Emby/);
    assert.equal(json.includes('X-Emby-Token'), false);
  });

  it('exports API-only reports with explicit scope, partial errors and escaped server content', () => {
    const report = {
      reportType: 'emby-api-snapshot',
      embySnapshot: {
        capturedAt: '2026-11-16T23:00:00Z',
        server: { name: '<img src=x onerror=alert(1)>', hasPendingRestart: false },
        sessions: [],
        warnings: ['GET /System/Info failed with HTTP 403.'],
        endpointStatus: { systemInfo: { status: 'error', error: 'HTTP 403' } },
        activityLog: {
          limit: 50, totalRecordCount: 100,
          entries: [{ date: 'now', severity: 'Error', type: 'Test', name: '[unsafe](https://example.test) <script>bad()</script>' }]
        }
      }
    };
    const html = ReportExporter.toHTML(report);
    const markdown = ReportExporter.toMarkdown(report);
    for (const output of [html, markdown]) {
      assert.match(output, /HTTP 403/);
      assert.match(output, /Point-in-time/);
      assert.match(output, /Showing 1 of 100/);
      assert.match(output, /false/);
      assert.equal(output.includes('<script>'), false);
      assert.equal(output.includes('<img src=x'), false);
      assert.equal(output.includes('Fleet Health'), false);
    }
    assert.ok(markdown.includes('\\[unsafe\\]\\(https://example.test\\)'));
    assert.equal(JSON.parse(ReportExporter.toJSON(report)).reportType, 'emby-api-snapshot');
  });
});

describe('Manual audio scenario comparison', () => {
  const context = (label, overrides = {}) => ({
    label, network: 'unknown', launchSurface: 'unknown', outcome: 'unknown', ...overrides
  });
  const snapshot = (overrides = {}) => ({
    capturedAt: '2026-11-16T23:30:00Z',
    server: { id: 'server-1', version: '4.9' },
    sessions: [EmbyApiClient.normalizeSession({
      Id: 'client-session', Client: 'Emby for Android', DeviceId: 'phone',
      PlaylistIndex: 0, PlaylistLength: 4, PlaylistItemId: 'queue-item-1',
      NowPlayingItem: {
        Id: 'track-1', Name: 'Track 1', Type: 'Audio', Container: 'flac',
        MediaStreams: [{ Type: 'Audio', Index: 0, Codec: 'flac', SampleRate: 96000, BitDepth: 24, Channels: 2 }]
      },
      PlayState: {
        PlayMethod: 'DirectPlay', PositionTicks: 0, IsPaused: false,
        MediaSourceId: 'source-1', AudioStreamIndex: 0, Shuffle: false,
        RepeatMode: 'RepeatNone', SleepTimerMode: 'None',
        MediaSource: {
          Id: 'source-1', Container: 'flac', Bitrate: 1800000,
          Path: '/private/audio.flac', TranscodingUrl: '/audio?api_key=do-not-export',
          MediaStreams: [{ Type: 'Audio', Index: 0, Codec: 'flac', SampleRate: 96000, BitDepth: 24, Channels: 2 }]
        }
      }
    })],
    ...overrides
  });

  it('preserves audio, playlist and playback context without retaining streaming URLs', () => {
    const data = snapshot();
    const session = data.sessions[0];
    assert.equal(session.playlist.index, 0);
    assert.equal(session.playState.shuffle, false);
    assert.equal(session.playState.mediaSourceId, 'source-1');
    assert.equal(session.mediaSource.audioStreams[0].codec, 'flac');
    assert.equal(session.mediaItem.audioStreams[0].bitDepth, 24);
    assert.equal(JSON.stringify(data).includes('do-not-export'), false);
    assert.equal(JSON.stringify(data).includes('/private/audio'), false);
    const audioOnly = EmbyApiClient.normalizeSession({
      NowPlayingItem: { Type: 'Audio' },
      TranscodingInfo: { AudioCodec: 'aac', IsAudioDirect: false, VideoEncoderIsHardware: false }
    });
    assert.equal(EmbyApiClient.summarizeSessions([audioOnly]).softwareVideo, 0);
    assert.equal(audioOnly.diagnostics.some(detail => detail.startsWith('Video encoder:')), false);
    assert.match(audioOnly.diagnostics.join(' '), /Audio: converted/);
  });

  it('shows A/B/C differences while keeping Android Auto and network annotations explicit', () => {
    const a = SnapshotComparison.capture(snapshot(), 0, context('A', {
      network: 'mobile', launchSurface: 'phone', outcome: 'stalled'
    }));
    const bData = snapshot();
    bData.sessions[0].playState.playMethod = 'DirectStream';
    const b = SnapshotComparison.capture(bData, 0, context('B', {
      network: 'wifi', launchSurface: 'phone', outcome: 'working'
    }));
    const c = SnapshotComparison.capture(snapshot(), 0, context('C', {
      network: 'mobile', launchSurface: 'android-auto', outcome: 'working'
    }));
    const comparison = SnapshotComparison.compare([a, b, c]);
    const row = name => comparison.rows.find(row => row.field === name);
    assert.deepEqual(row('Play method').values, ['DirectPlay', 'DirectStream', 'DirectPlay']);
    assert.equal(row('Play method').status, 'different');
    assert.equal(row('Client').status, 'same');
    assert.equal(row('Item audio streams (metadata candidates)').status, 'unknown');
    assert.equal(row('Launch surface (administrator; not detected)').status, 'different');
    assert.deepEqual(row('Playlist index (raw API value)').values, ['0', '0', '0']);
    assert.deepEqual(row('Shuffle').values, ['false', 'false', 'false']);
    assert.equal(comparison.correlations[0].sameSession, true);
    assert.match(comparison.scope, /No root cause/);
    assert.match(comparison.scope, /Android Auto cannot reliably be inferred/);
  });

  it('does not equate missing values, missing sessions or cross-server IDs with proven continuity', () => {
    const a = SnapshotComparison.capture(snapshot(), 0, context('A'));
    const missingIdentity = snapshot({ server: {} });
    const b = SnapshotComparison.capture(missingIdentity, 0, context('B'));
    const c = SnapshotComparison.capture(snapshot({ server: { id: 'other-server' } }), 0, context('C'));
    const d = SnapshotComparison.capture(snapshot({ sessions: [] }), null, context('D'));
    const comparison = SnapshotComparison.compare([a, b, c, d]);
    assert.ok(comparison.correlations.every(correlation => correlation.sameSession === false));
    assert.equal(comparison.rows.find(row => row.field === 'Sleep timer mode').status, 'unknown');
    assert.match(comparison.correlations.at(-1).observation, /do not establish session termination/);
  });

  it('copies captures and enforces selection, annotation and six-capture limits', () => {
    const original = snapshot();
    original.sessions.push(EmbyApiClient.normalizeSession({ Id: 'not-selected' }));
    const capture = SnapshotComparison.capture(original, 0, context('A'));
    original.sessions[0].mediaItem.name = 'Changed later';
    assert.equal(capture.snapshot.sessions[0].mediaItem.name, 'Track 1');
    assert.equal(capture.snapshot.sessions.length, 1);
    assert.equal(capture.snapshot.returnedSessionCount, 2);
    assert.equal(capture.snapshot.summary, null);
    assert.throws(() => SnapshotComparison.capture(original, -1, context('A')), /Select a session/);
    assert.throws(() => SnapshotComparison.capture(original, 0, context('A', { network: 'inferred-4g' })), /valid network/);
    assert.throws(() => SnapshotComparison.capture(original, 0, context('')), /scenario label/);
    assert.equal(SnapshotComparison.compare(Array(6).fill(capture)).captures.length, 6);
    assert.throws(() => SnapshotComparison.compare(Array(7).fill(capture)), /one and six/);
  });

  it('exports comparison-only evidence safely in all three report formats', () => {
    const a = SnapshotComparison.capture(snapshot(), 0, context('<script>A</script>'));
    const b = SnapshotComparison.capture(snapshot(), 0, context('B'));
    const report = { reportType: 'emby-api-comparison', snapshotComparison: SnapshotComparison.compare([a, b]) };
    for (const rendered of [ReportExporter.toHTML(report), ReportExporter.toMarkdown(report)]) {
      assert.match(rendered, /Manual scenario comparison/);
      assert.match(rendered, /flac/);
      assert.match(rendered, /96000/);
      assert.match(rendered, /metadata candidates/);
      assert.equal(rendered.includes('<script>'), false);
      assert.equal(rendered.includes('Fleet Health'), false);
    }
    assert.equal(JSON.parse(ReportExporter.toJSON(report)).snapshotComparison.captures.length, 2);
  });
});
