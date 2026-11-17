class SnapshotComparison {
  static validateContext(context) {
    const valuesByField = {
      network: ['unknown', 'mobile', 'wifi'],
      launchSurface: ['unknown', 'phone', 'android-auto'],
      outcome: ['unknown', 'working', 'stalled']
    };
    const label = typeof context?.label === 'string' ? context.label.trim() : '';
    if (!label || label.length > 80) throw new Error('Enter a scenario label (1-80 characters).');
    const annotations = { label };
    for (const [field, values] of Object.entries(valuesByField)) {
      if (!values.includes(context?.[field])) throw new Error(`Select a valid ${field} annotation.`);
      annotations[field] = context[field];
    }
    return annotations;
  }

  static capture(snapshot, sessionIndex, context) {
    if (!snapshot || !Array.isArray(snapshot.sessions) || !snapshot.capturedAt) {
      throw new Error('Fetch an API snapshot before capturing a scenario.');
    }
    const annotations = SnapshotComparison.validateContext(context);
    if (sessionIndex !== null && (!Number.isInteger(sessionIndex)
      || sessionIndex < 0 || sessionIndex >= snapshot.sessions.length)) {
      throw new Error('Select a session from the current snapshot.');
    }
    const captured = structuredClone(snapshot);
    return {
      ...annotations,
      snapshot: {
        ...captured,
        sessions: sessionIndex === null ? [] : [captured.sessions[sessionIndex]],
        summary: null,
        returnedSessionCount: captured.sessions.length,
        selectionScope: 'Only the selected session is retained in this capture; no selection is not evidence of session termination. Activity entries remain server-wide context.'
      },
      selection: sessionIndex === null ? 'none' : 'one-session'
    };
  }

  static audioDescription(streams) {
    if (!Array.isArray(streams) || streams.length === 0) return null;
    return streams.map(stream => [
      `index=${stream.index ?? '?'}`, `codec=${stream.codec ?? '?'}`,
      `bitrate=${stream.bitrate ?? '?'}`, `rate=${stream.sampleRate ?? '?'}`,
      `depth=${stream.bitDepth ?? '?'}`, `channels=${stream.channels ?? '?'}`
    ].join(', ')).join(' / ');
  }

  static facts(capture) {
    const snapshot = capture.snapshot;
    const session = snapshot.sessions[0];
    const state = session?.playState;
    const source = session?.mediaSource;
    const transcode = session?.transcodingInfo;
    return [
      ['Scenario label (administrator)', capture.label],
      ['Network (administrator; not detected)', capture.network === 'unknown' ? null : capture.network],
      ['Launch surface (administrator; not detected)', capture.launchSurface === 'unknown' ? null : capture.launchSurface],
      ['Observed outcome (administrator)', capture.outcome === 'unknown' ? null : capture.outcome],
      ['Capture time', snapshot.capturedAt],
      ['Server ID', snapshot.server?.id],
      ['Server version', snapshot.server?.version],
      ['Selected API session', session ? 'present' : 'none selected / absent; not an end event'],
      ['API session ID (not PlaySessionId)', session?.id],
      ['Device ID', session?.deviceId],
      ['Client', session?.client],
      ['Application version', session?.applicationVersion],
      ['Device name', session?.deviceName],
      ['Device type', session?.deviceType],
      ['Remote endpoint (not proof of mobile/WLAN)', session?.remoteEndPoint],
      ['Last activity', session?.lastActivityDate],
      ['Item ID', session?.mediaItem?.id],
      ['Item name', session?.mediaItem?.name],
      ['Item type', session?.mediaItem?.type],
      ['Item container', session?.mediaItem?.container],
      ['Item audio streams (metadata candidates)', SnapshotComparison.audioDescription(session?.mediaItem?.audioStreams)],
      ['Runtime (ticks)', session?.mediaItem?.runTimeTicks],
      ['Play method', state?.playMethod],
      ['Position (ticks)', state?.positionTicks],
      ['Paused', state?.isPaused],
      ['Media source ID', state?.mediaSourceId],
      ['Selected audio stream index', state?.audioStreamIndex],
      ['Playback source container', source?.container],
      ['Playback source bitrate', source?.bitrate],
      ['Playback source audio streams', SnapshotComparison.audioDescription(source?.audioStreams)],
      ['Playlist item ID', session?.playlist?.itemId],
      ['Playlist index (raw API value)', session?.playlist?.index],
      ['Playlist length', session?.playlist?.length],
      ['Repeat mode', state?.repeatMode],
      ['Shuffle', state?.shuffle],
      ['Sleep timer mode', state?.sleepTimerMode],
      ['Transcode info present', session ? Boolean(transcode) : null],
      ['Transcode output audio codec', transcode?.audioCodec],
      ['Audio copied', transcode?.isAudioDirect],
      ['Transcode output bitrate', transcode?.bitrate],
      ['Transcode reasons', transcode?.transcodeReasons?.length ? transcode.transcodeReasons.join(', ') : null],
      ['System endpoint status', snapshot.endpointStatus?.systemInfo?.status],
      ['Activity endpoint status', snapshot.endpointStatus?.activityLog?.status]
    ];
  }

  static compare(captures) {
    if (!Array.isArray(captures) || captures.length === 0 || captures.length > 6) {
      throw new Error('Compare between one and six manually captured scenarios.');
    }
    const facts = captures.map(capture => SnapshotComparison.facts(capture));
    const rows = facts[0].map(([field], index) => {
      const values = facts.map(rows => {
        const value = rows[index][1];
        return value == null || value === '' ? null : String(value);
      });
      const known = values.filter(value => value !== null);
      const partialAudio = field.includes('audio streams') && known.some(value => value.includes('=?'));
      return {
        field,
        values,
        status: new Set(known).size > 1 ? 'different'
          : known.length < captures.length || partialAudio ? 'unknown' : 'same'
      };
    });
    const correlations = [];
    for (let index = 1; index < captures.length; index++) {
      const before = captures[index - 1].snapshot;
      const after = captures[index].snapshot;
      const sameServer = Boolean(before.server?.id && before.server.id === after.server?.id);
      const left = before.sessions[0];
      const right = after.sessions[0];
      const sameSession = sameServer && Boolean(left?.id && left.id === right?.id);
      correlations.push({
        from: index - 1,
        to: index,
        sameServer,
        sameSession,
        observation: sameSession
          ? 'Same reported server and API session ID. This is not a PlaySessionId match or proof of uninterrupted playback.'
          : 'No confirmed same-server API-session continuity. Missing selections do not establish session termination.'
      });
    }
    return {
      captures,
      rows,
      correlations,
      scope: 'Manual point-in-time comparison, not continuous monitoring. Highlighted differences are not faults. Network, launch surface and outcome are administrator annotations. Android Auto cannot reliably be inferred from Client alone. Server-wide activity is context, not automatically assigned to the selected session. No root cause or natural playback completion is established.'
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = SnapshotComparison;
else window.SnapshotComparison = SnapshotComparison;
