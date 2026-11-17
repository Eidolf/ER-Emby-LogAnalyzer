const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const ACTIVITY_LIMIT = 50;
const ENDPOINTS = {
  publicInfo: 'System/Info/Public',
  sessions: 'Sessions',
  systemInfo: 'System/Info',
  activityLog: 'System/ActivityLog/Entries',
  serverLogs: 'System/Logs',
  serverLog: 'System/Logs/Log'
};

class EmbyApiError extends Error {}

class EmbyApiClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('A Fetch API implementation is required.');
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async testConnection({ baseUrl } = {}) {
    const apiBase = EmbyApiClient.normalizeBaseUrl(baseUrl);
    const info = await this.fetchJson(apiBase, 'publicInfo');
    return {
      checkedAt: new Date().toISOString(),
      server: EmbyApiClient.normalizeServer(info),
      warnings: EmbyApiClient.transportWarnings(apiBase)
    };
  }

  async fetchSnapshot({ baseUrl, token, includeSystemInfo = false, includeActivityLog = false } = {}) {
    const apiBase = EmbyApiClient.normalizeBaseUrl(baseUrl);
    const apiToken = typeof token === 'string' ? token.trim() : '';
    if (!apiToken) {
      throw new Error('An Emby API key or access token is required to read active sessions.');
    }

    const endpointStatus = {};
    const warnings = EmbyApiClient.transportWarnings(apiBase);
    const read = async (endpoint, normalize, optional = false) => {
      try {
        const data = normalize(await this.fetchJson(apiBase, endpoint, endpoint === 'publicInfo' ? null : apiToken));
        endpointStatus[endpoint] = { status: 'ok' };
        return data;
      } catch (error) {
        endpointStatus[endpoint] = { status: 'error', error: error.message };
        if (!optional) throw error;
        warnings.push(`${ENDPOINTS[endpoint]} unavailable: ${error.message}`);
        return null;
      }
    };
    const readOptional = (endpoint, normalize, enabled) => {
      if (enabled === true) return read(endpoint, normalize, true);
      endpointStatus[endpoint] = { status: 'not-requested' };
      return null;
    };
    const [server, sessions, systemInfo, activityLog] = await Promise.all([
      read('publicInfo', EmbyApiClient.normalizeServer),
      read('sessions', value => {
        if (!Array.isArray(value)) throw new Error('Emby returned an invalid sessions response.');
        return value.map(session => EmbyApiClient.normalizeSession(session));
      }),
      readOptional('systemInfo', EmbyApiClient.normalizeSystemInfo, includeSystemInfo),
      readOptional('activityLog', EmbyApiClient.normalizeActivityLog, includeActivityLog)
    ]);

    return {
      source: 'Emby API (read-only)',
      capturedAt: new Date().toISOString(),
      server: { ...server, ...(systemInfo || {}) },
      summary: EmbyApiClient.summarizeSessions(sessions),
      sessions,
      activityLog,
      endpointStatus,
      warnings
    };
  }

  async listServerLogs({ baseUrl, token } = {}) {
    const apiBase = EmbyApiClient.normalizeBaseUrl(baseUrl);
    const apiToken = EmbyApiClient.requireToken(token);
    const result = await this.fetchJson(apiBase, 'serverLogs', apiToken);
    if (!Array.isArray(result)) {
      throw new EmbyApiError('Emby returned an invalid server log list.');
    }

    return result.filter(file => file && EmbyApiClient.isSupportedLogName(file.Name)).map(file => ({
      name: file.Name,
      size: EmbyApiClient.optionalNumber(file.Size),
      dateModified: EmbyApiClient.optionalString(file.DateModified)
    }));
  }

  async fetchServerLog({ baseUrl, token, name } = {}) {
    const apiBase = EmbyApiClient.normalizeBaseUrl(baseUrl);
    const apiToken = EmbyApiClient.requireToken(token);
    if (!EmbyApiClient.isSupportedLogName(name)) {
      throw new Error('Select an Emby server or FFmpeg log file from the server log list.');
    }

    const url = new URL(EmbyApiClient.endpoint(apiBase, ENDPOINTS.serverLog));
    url.searchParams.set('Name', name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60000));
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'text/plain', 'X-Emby-Token': apiToken },
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EmbyApiError(`GET /${ENDPOINTS.serverLog} failed with HTTP ${response.status}.`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new EmbyApiError(`GET /${ENDPOINTS.serverLog} returned an empty response.`);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_LOG_BYTES) {
            await reader.cancel();
            throw new EmbyApiError(`Server log ${name} exceeded the 50 MiB download limit.`);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new EmbyApiError(`GET /${ENDPOINTS.serverLog} timed out.`);
      }
      if (error instanceof EmbyApiError) throw error;
      throw new EmbyApiError(`GET /${ENDPOINTS.serverLog} could not be completed. Check the server address, network and TLS certificate; redirects are not followed.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchJson(apiBase, endpoint, token = null) {
    const route = ENDPOINTS[endpoint];
    if (!route) throw new Error('Unsupported Emby read-only endpoint.');
    const url = new URL(EmbyApiClient.endpoint(apiBase, route));
    if (endpoint === 'activityLog') {
      url.searchParams.set('StartIndex', '0');
      url.searchParams.set('Limit', String(ACTIVITY_LIMIT));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { Accept: 'application/json' };
    if (token) headers['X-Emby-Token'] = token;

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new EmbyApiError(`GET /${route} failed with HTTP ${response.status}.`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new EmbyApiError(`GET /${route} returned an empty response.`);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new EmbyApiError(`GET /${route} exceeded the 2 MiB response limit.`);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new EmbyApiError(`Emby API returned invalid JSON for /${route}.`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new EmbyApiError(`GET /${route} timed out.`);
      }
      if (error instanceof EmbyApiError) throw error;
      throw new EmbyApiError(`GET /${route} could not be completed. Check the server address, network and TLS certificate; redirects are not followed.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  static normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Enter an Emby server URL.');
    }

    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Enter a valid Emby server URL, including http:// or https://.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('The Emby server URL must use HTTP or HTTPS.');
    }
    if (url.username || url.password) {
      throw new Error('Do not include credentials in the Emby server URL.');
    }
    if (url.search || url.hash) {
      throw new Error('The Emby server URL must not contain a query string or fragment.');
    }

    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = /\/emby$/i.test(pathname) ? pathname : `${pathname}/emby`;
    return url;
  }

  static endpoint(apiBase, path) {
    const pathname = `${apiBase.pathname.replace(/\/+$/, '')}/${path}`;
    return new URL(pathname, apiBase.origin).toString();
  }

  static requireToken(token) {
    const apiToken = typeof token === 'string' ? token.trim() : '';
    if (!apiToken) throw new Error('An Emby API key or access token is required to read server logs.');
    return apiToken;
  }

  static isSupportedLogName(name) {
    return typeof name === 'string'
      && name === name.trim()
      && !/[\\/]/.test(name)
      && name !== '.'
      && name !== '..'
      && /^(?:embyserver|ffmpeg)[\w.-]*\.(?:txt|log)$/i.test(name);
  }

  static transportWarnings(apiBase) {
    return apiBase.protocol === 'http:'
      ? ['HTTP is unencrypted: credentials and snapshot data can be read in transit. Use HTTPS or a trusted local connection.']
      : [];
  }

  static normalizeServer(info) {
    EmbyApiClient.requireObject(info, 'public system information');
    return {
      id: EmbyApiClient.optionalString(info.Id),
      name: EmbyApiClient.optionalString(info.ServerName),
      version: EmbyApiClient.optionalString(info.Version),
      operatingSystem: EmbyApiClient.optionalString(info.OperatingSystem)
    };
  }

  static normalizeSystemInfo(info) {
    EmbyApiClient.requireObject(info, 'system information');
    return {
      operatingSystemDisplayName: EmbyApiClient.optionalString(info.OperatingSystemDisplayName),
      hasPendingRestart: EmbyApiClient.optionalBoolean(info.HasPendingRestart),
      isShuttingDown: EmbyApiClient.optionalBoolean(info.IsShuttingDown)
    };
  }

  static normalizeActivityLog(result) {
    EmbyApiClient.requireObject(result, 'activity log');
    if (!Array.isArray(result.Items)) throw new Error('Emby returned invalid activity log entries.');
    return {
      limit: ACTIVITY_LIMIT,
      totalRecordCount: EmbyApiClient.optionalNumber(result.TotalRecordCount),
      entries: result.Items.slice(0, ACTIVITY_LIMIT).map(entry => {
        EmbyApiClient.requireObject(entry, 'activity log entry');
        return {
          id: typeof entry.Id === 'string' ? entry.Id
            : Number.isSafeInteger(entry.Id) ? String(entry.Id) : null,
          itemId: EmbyApiClient.optionalString(entry.ItemId),
          userId: EmbyApiClient.optionalString(entry.UserId),
          date: EmbyApiClient.optionalString(entry.Date),
          name: EmbyApiClient.optionalString(entry.Name),
          type: EmbyApiClient.optionalString(entry.Type),
          severity: EmbyApiClient.optionalString(entry.Severity)
        };
      })
    };
  }

  static requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Emby returned an invalid ${label} response.`);
    }
  }

  static normalizeSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      throw new Error('Emby returned an invalid session entry.');
    }
    for (const field of ['PlayState', 'TranscodingInfo', 'NowPlayingItem']) {
      if (session[field] != null) EmbyApiClient.requireObject(session[field], `session ${field}`);
    }

    const playState = session.PlayState && typeof session.PlayState === 'object'
      ? session.PlayState
      : {};
    const transcoding = session.TranscodingInfo && typeof session.TranscodingInfo === 'object'
      ? session.TranscodingInfo
      : null;
    if (playState.MediaSource != null) EmbyApiClient.requireObject(playState.MediaSource, 'session media source');
    const source = playState.MediaSource;

    const normalized = {
      id: EmbyApiClient.optionalString(session.Id),
      userName: EmbyApiClient.optionalString(session.UserName),
      client: EmbyApiClient.optionalString(session.Client),
      deviceName: EmbyApiClient.optionalString(session.DeviceName),
      applicationVersion: EmbyApiClient.optionalString(session.ApplicationVersion),
      deviceId: EmbyApiClient.optionalString(session.DeviceId),
      deviceType: EmbyApiClient.optionalString(session.DeviceType),
      remoteEndPoint: EmbyApiClient.optionalString(session.RemoteEndPoint),
      lastActivityDate: EmbyApiClient.optionalString(session.LastActivityDate),
      playlist: {
        itemId: EmbyApiClient.optionalString(session.PlaylistItemId),
        index: EmbyApiClient.optionalNumber(session.PlaylistIndex),
        length: EmbyApiClient.optionalNumber(session.PlaylistLength)
      },
      mediaItem: session.NowPlayingItem
        ? {
            id: EmbyApiClient.optionalString(session.NowPlayingItem.Id),
            name: EmbyApiClient.optionalString(session.NowPlayingItem.Name),
            runTimeTicks: EmbyApiClient.optionalNumber(session.NowPlayingItem.RunTimeTicks),
            type: EmbyApiClient.optionalString(session.NowPlayingItem.Type),
            container: EmbyApiClient.optionalString(session.NowPlayingItem.Container),
            audioStreams: EmbyApiClient.normalizeAudioStreams(session.NowPlayingItem.MediaStreams)
          }
        : null,
      playState: {
        playMethod: EmbyApiClient.optionalString(playState.PlayMethod),
        positionTicks: EmbyApiClient.optionalNumber(playState.PositionTicks),
        mediaSourceId: EmbyApiClient.optionalString(playState.MediaSourceId),
        audioStreamIndex: EmbyApiClient.optionalNumber(playState.AudioStreamIndex),
        repeatMode: EmbyApiClient.optionalString(playState.RepeatMode),
        sleepTimerMode: EmbyApiClient.optionalString(playState.SleepTimerMode),
        shuffle: EmbyApiClient.optionalBoolean(playState.Shuffle),
        isPaused: typeof playState.IsPaused === 'boolean' ? playState.IsPaused : null,
        isMuted: typeof playState.IsMuted === 'boolean' ? playState.IsMuted : null
      },
      mediaSource: source ? {
        id: EmbyApiClient.optionalString(source.Id),
        container: EmbyApiClient.optionalString(source.Container),
        bitrate: EmbyApiClient.optionalNumber(source.Bitrate),
        audioStreams: EmbyApiClient.normalizeAudioStreams(source.MediaStreams)
      } : null,
      transcodingInfo: transcoding ? {
        audioCodec: EmbyApiClient.optionalString(transcoding.AudioCodec),
        videoCodec: EmbyApiClient.optionalString(transcoding.VideoCodec),
        container: EmbyApiClient.optionalString(transcoding.Container),
        bitrate: EmbyApiClient.optionalNumber(transcoding.Bitrate),
        framerate: EmbyApiClient.optionalNumber(transcoding.Framerate),
        isVideoDirect: EmbyApiClient.optionalBoolean(transcoding.IsVideoDirect),
        isAudioDirect: EmbyApiClient.optionalBoolean(transcoding.IsAudioDirect),
        transcodeReasons: Array.isArray(transcoding.TranscodeReasons)
          ? transcoding.TranscodeReasons.filter(value => typeof value === 'string')
          : [],
        currentCpuUsage: EmbyApiClient.optionalNumber(transcoding.CurrentCpuUsage),
        averageCpuUsage: EmbyApiClient.optionalNumber(transcoding.AverageCpuUsage),
        videoDecoder: EmbyApiClient.optionalString(transcoding.VideoDecoder),
        videoDecoderIsHardware: typeof transcoding.VideoDecoderIsHardware === 'boolean'
          ? transcoding.VideoDecoderIsHardware
          : null,
        videoDecoderHwAccel: EmbyApiClient.optionalString(transcoding.VideoDecoderHwAccel),
        videoEncoder: EmbyApiClient.optionalString(transcoding.VideoEncoder),
        videoEncoderIsHardware: typeof transcoding.VideoEncoderIsHardware === 'boolean'
          ? transcoding.VideoEncoderIsHardware
          : null,
        videoEncoderHwAccel: EmbyApiClient.optionalString(transcoding.VideoEncoderHwAccel)
      } : null
    };
    normalized.diagnostics = EmbyApiClient.sessionDiagnostics(normalized);
    return normalized;
  }

  static sessionDiagnostics(session) {
    const transcode = session.transcodingInfo;
    if (!transcode) return [];
    const acceleration = (label, direct, hardware, name, accelerator) => {
      const mode = direct === true ? 'copied (no video conversion)'
        : hardware === true ? 'hardware'
          : hardware === false ? 'software' : 'hardware status unknown';
      return `${label}: ${mode}${name ? ` / ${name}` : ''}${accelerator ? ` / ${accelerator}` : ''}`;
    };
    const hasVideo = EmbyApiClient.hasVideoProcessing(session);
    const details = hasVideo ? [
      acceleration('Video decoder', transcode.isVideoDirect, transcode.videoDecoderIsHardware,
        transcode.videoDecoder, transcode.videoDecoderHwAccel),
      acceleration('Video encoder', transcode.isVideoDirect, transcode.videoEncoderIsHardware,
        transcode.videoEncoder, transcode.videoEncoderHwAccel)
    ] : [];
    if (!hasVideo) details.push('No video processing information supplied; hardware status unknown. GPU use cannot be inferred from audio transcoding.');
    if (transcode.isAudioDirect !== null) {
      details.push(`Audio: ${transcode.isAudioDirect ? 'copied' : 'converted'}`);
    }
    if (transcode.bitrate !== null) details.push(`Output bitrate: ${(transcode.bitrate / 1000000).toFixed(2)} Mbps`);
    if (transcode.framerate !== null) details.push(`Transcode framerate: ${transcode.framerate} fps`);
    if (transcode.currentCpuUsage !== null) details.push(`Transcoder CPU (server reported): ${transcode.currentCpuUsage}%`);
    return details;
  }

  static normalizeAudioStreams(streams) {
    if (streams == null) return [];
    if (!Array.isArray(streams)) throw new Error('Emby returned invalid media streams.');
    return streams.filter(stream => stream && stream.Type === 'Audio').map(stream => ({
      index: EmbyApiClient.optionalNumber(stream.Index),
      codec: EmbyApiClient.optionalString(stream.Codec),
      bitrate: EmbyApiClient.optionalNumber(stream.BitRate),
      sampleRate: EmbyApiClient.optionalNumber(stream.SampleRate),
      bitDepth: EmbyApiClient.optionalNumber(stream.BitDepth),
      channels: EmbyApiClient.optionalNumber(stream.Channels)
    }));
  }

  static hasVideoProcessing(session) {
    const transcode = session.transcodingInfo;
    return session.mediaItem?.type !== 'Audio' && Boolean(transcode
      && (transcode.videoCodec || transcode.videoDecoder || transcode.videoEncoder
        || transcode.isVideoDirect === true
        || transcode.videoDecoderIsHardware === true || transcode.videoEncoderIsHardware === true));
  }

  static optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  static optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  static optionalBoolean(value) {
    return typeof value === 'boolean' ? value : null;
  }

  static summarizeSessions(sessions) {
    const playing = sessions.filter(session => session.mediaItem);
    const transcodes = sessions.filter(session => session.transcodingInfo);
    return {
      connected: sessions.length,
      playing: playing.filter(session => session.playState.isPaused === false).length,
      paused: playing.filter(session => session.playState.isPaused === true).length,
      playbackStateUnknown: playing.filter(session => session.playState.isPaused === null).length,
      idle: sessions.length - playing.length,
      transcodes: transcodes.length,
      hardwareVideo: transcodes.filter(session => EmbyApiClient.hasVideoProcessing(session)
        && session.transcodingInfo.isVideoDirect !== true
        && session.transcodingInfo.videoEncoderIsHardware === true).length,
      softwareVideo: transcodes.filter(session => EmbyApiClient.hasVideoProcessing(session)
        && session.transcodingInfo.isVideoDirect !== true
        && session.transcodingInfo.videoEncoderIsHardware === false).length
    };
  }
}

module.exports = EmbyApiClient;
