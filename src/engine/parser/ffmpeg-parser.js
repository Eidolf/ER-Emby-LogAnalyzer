const fs = require('fs');
const readline = require('readline');
const path = require('path');

/**
 * Streaming parser for FFmpeg transcoding logs (ffmpeg-transcode-*.txt).
 * Extracts CLI parameters, input streams, encoders/decoders, hardware acceleration methods,
 * frame processing rates, warnings, exit codes, and error lines.
 */
class FFmpegParser {
  /**
   * Parse an FFmpeg transcode log file.
   * @param {string} filePath
   * @param {Function} onProgress Optional progress callback
   * @returns {Promise<object>} Parsed FFmpeg log model
   */
  static async parseFile(filePath, onProgress = null) {
    const fileName = path.basename(filePath);
    // Extract jobId token from filename e.g. ffmpeg-transcode-a1b2c3d4-....txt
    const jobIdMatch = fileName.match(/ffmpeg-transcode-([a-zA-Z0-9_-]+)/i);
    const jobId = jobIdMatch ? jobIdMatch[1] : fileName;

    const fileStats = fs.statSync(filePath);
    const totalSize = fileStats.size || 1;
    let bytesRead = 0;

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    const lines = [];
    const errors = [];
    const warnings = [];
    let commandLine = null;
    let inputFiles = [];
    let hwaccel = 'None'; // e.g. nvenc, qsv, vaapi, amf, none
    let videoDecoder = null;
    let videoEncoder = null;
    let audioEncoder = null;
    let user = null;
    let fpsSamples = [];
    let startTime = null;
    let endTime = null;
    let exitCode = null;
    let normalCompletion = false;

    // Rich parsed object model properties
    let ffmpegVersion = null;
    let isEmbyFfmpeg = false;
    let userPolicy = {
      user: null,
      enablePlaybackRemuxing: null,
      enableVideoPlaybackTranscoding: null,
      enableAudioPlaybackTranscoding: null
    };
    let hardwareDevices = []; // e.g. [{ name, id, driver, vendor, sdkVersion, type }]
    let inputStreams = [];    // e.g. [{ id, type, codec, profile, bitrate, startTime, resolution }]
    let outputStreams = [];   // e.g. [{ id, type, codec, bitrate }]
    let videoProcessingSteps = []; // e.g. [{ step, hwContext, format, swFormat, size }]
    let toneMappingDesired = false;
    let toneMappingDisabled = false;

    // Time extraction regex in FFmpeg logs:
    // e.g. ">>>>>>  User policy for ... at 9/20/2026 2:15:23 PM" or "2026-09-20 14:15:23.000"
    const timestampRegex = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{3})?|\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:[AP]M)?)/i;

    let lineIndex = 0;
    for await (const line of rl) {
      lineIndex++;
      bytesRead += Buffer.byteLength(line, 'utf8') + 1;
      if (onProgress && Math.random() < 0.05) {
        onProgress(Math.min(99, Math.round((bytesRead / totalSize) * 100)));
      }

      if (!line.trim()) continue;

      // Extract timestamp if present on line
      const tsMatch = line.match(timestampRegex);
      if (tsMatch) {
        const parsedTime = tsMatch[1];
        if (!startTime) startTime = parsedTime;
        endTime = parsedTime;
      }

      // Detect Command line invocation
      if (!commandLine && (line.includes('ffmpeg -') || line.includes('/ffmpeg ') || line.includes('\\ffmpeg.exe') || line.startsWith('Command:'))) {
        commandLine = line;
        FFmpegParser.inspectCommandLine(line, (detected) => {
          if (detected.hwaccel) hwaccel = detected.hwaccel;
          if (detected.videoEncoder) videoEncoder = detected.videoEncoder;
          if (detected.audioEncoder) audioEncoder = detected.audioEncoder;
          if (detected.inputFiles && detected.inputFiles.length > 0) inputFiles = detected.inputFiles;
        });
      }

      // Also extract input files from 'Input #0' if not found yet
      if (inputFiles.length === 0 && line.includes('Input #') && line.includes('from ')) {
        const inpMatch = line.match(/from\s+['"]?([^'"]+)['"]?:?/i);
        if (inpMatch) {
          inputFiles.push(inpMatch[1].trim());
        }
      }

      // Extract User and policy flags from User policy section
      // e.g. ">>>>>>  User policy for demoUser"
      // e.g. "        Enable Playback Remuxing: True"
      // e.g. "        Enable Video Playback Transcoding: True"
      // e.g. "        Enable Audio Playback Transcoding: True"
      if (line.includes('User policy for')) {
        const uMatch = line.match(/User policy for\s+([^\r\n.]+)/i);
        if (uMatch) {
          user = uMatch[1].trim();
          userPolicy.user = user;
        }
      }
      if (line.includes('Enable Playback Remuxing:')) {
        userPolicy.enablePlaybackRemuxing = /true/i.test(line);
      }
      if (line.includes('Enable Video Playback Transcoding:')) {
        userPolicy.enableVideoPlaybackTranscoding = /true/i.test(line);
      }
      if (line.includes('Enable Audio Playback Transcoding:')) {
        userPolicy.enableAudioPlaybackTranscoding = /true/i.test(line);
      }

      // Hardware Devices and Adapters
      // e.g. "        Adapter #0: 'CoffeeLake-S GT2 UHD Graphics 630' Id:16017 (Driver: , Vendor: 32902, SDK Version: 1.35)"
      if (line.includes('Adapter #') && line.includes('Id:')) {
        const adMatch = line.match(/Adapter\s+#(\d+):\s*'([^']+)'\s+Id:([^\s(]+)(?:\s*\(([^)]*)\))?/i);
        if (adMatch) {
          const extra = adMatch[4] || '';
          const driverMatch = extra.match(/Driver:\s*([^,]*)/i);
          const vendorMatch = extra.match(/Vendor:\s*([^,]*)/i);
          const sdkMatch = extra.match(/SDK Version:\s*([^,)]*)/i);
          hardwareDevices.push({
            index: parseInt(adMatch[1], 10),
            name: adMatch[2].trim(),
            id: adMatch[3].trim(),
            driver: driverMatch ? driverMatch[1].trim() : '',
            vendor: vendorMatch ? vendorMatch[1].trim() : '',
            sdkVersion: sdkMatch ? sdkMatch[1].trim() : ''
          });
        }
      }

      // Tone mapping decisions
      if (line.includes('Tone Mapping would be desired, but hardware tone mapping is disabled')) {
        toneMappingDesired = true;
        toneMappingDisabled = true;
      } else if (line.includes('Tone Mapping would be desired') || line.includes('ToneMapping (when possible)')) {
        toneMappingDesired = true;
      }

      // Video Processing Steps
      // e.g. "        HEVC_QSV             >> QSV          qsv          p010           3840x2160 >> vpp_qsv"
      if (line.includes('>>') && (line.includes('QSV') || line.includes('VAAPI') || line.includes('CUDA') || line.includes('D3D11') || line.includes('OpenCL'))) {
        const stepMatch = line.trim().split(/\s{2,}|\t/);
        if (stepMatch.length >= 3) {
          videoProcessingSteps.push(line.trim());
        }
      }

      // Detailed Input Stream metadata
      // e.g. "  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], Level 153, 23.98 fps, 23.98 tbr, 1k tbn, Start-Time 0.015s (default)"
      // e.g. "  Stream #0:1(ger): Audio: eac3, 48000 Hz, 7.1, fltp, 1024 kb/s, Start-Time 0.015s (default)"
      if (line.includes('Stream #') && line.includes(': ') && !line.includes('->')) {
        const stMatch = line.match(/Stream #(\d+:\d+)(?:\(([^)]+)\))?:\s+(Video|Audio|Subtitle|Data):\s+([^,\r\n]+)/i);
        if (stMatch) {
          const streamId = stMatch[1];
          const lang = stMatch[2] || '';
          const stType = stMatch[3];
          const codecDesc = stMatch[4].trim();

          const startTimeMatch = line.match(/Start-Time\s+([\d.]+)/i);
          const bitrateMatch = line.match(/(\d+)\s+kb\/s/i);
          const resMatch = line.match(/(\d{3,5})x(\d{3,5})/i);

          const streamObj = {
            id: streamId,
            language: lang,
            type: stType,
            codec: codecDesc,
            startTime: startTimeMatch ? parseFloat(startTimeMatch[1]) : 0.0,
            bitrateKbps: bitrateMatch ? parseInt(bitrateMatch[1], 10) : null,
            width: resMatch ? parseInt(resMatch[1], 10) : null,
            height: resMatch ? parseInt(resMatch[2], 10) : null,
            raw: line.trim()
          };

          if (line.includes('Output #') || line.includes('Stream mapping:')) {
            outputStreams.push(streamObj);
          } else {
            inputStreams.push(streamObj);
          }
        }
      }

      // Check Hardware Accel indicators in output logs
      if (hwaccel === 'None') {
        if (/nvenc|cuda|nvcuda/i.test(line)) hwaccel = 'NVENC (NVIDIA)';
        else if (/qsv|mfx/i.test(line)) hwaccel = 'QuickSync (Intel)';
        else if (/vaapi/i.test(line)) hwaccel = 'VAAPI';
        else if (/amf/i.test(line)) hwaccel = 'AMF (AMD)';
        else if (/videotoolbox/i.test(line)) hwaccel = 'VideoToolbox (Apple)';
      }

      // Track Stream mapping
      // e.g. "Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_nvenc))"
      const streamMapMatch = line.match(/Stream #\d+:\d+.*->.*Stream #\d+:\d+\s+\(([^)]+)\s+->\s+([^)]+)\)/);
      if (streamMapMatch) {
        const fromCodec = streamMapMatch[1];
        const toCodec = streamMapMatch[2];
        if (!videoDecoder && fromCodec) videoDecoder = fromCodec;
        if (!videoEncoder && toCodec) videoEncoder = toCodec;
      }

      // Parse periodic frame rate progress lines
      // e.g. "frame= 1240 fps= 62 q=24.0 size=   14336kB time=00:00:51.20 bitrate=2293.8kbits/s speed=2.56x"
      const progressMatch = line.match(/frame=\s*(\d+)\s+fps=\s*([\d.]+).*speed=\s*([\d.]+)x/i);
      if (progressMatch) {
        fpsSamples.push({
          frame: parseInt(progressMatch[1], 10),
          fps: parseFloat(progressMatch[2]),
          speed: parseFloat(progressMatch[3])
        });
      }

      // Check errors and warnings
      const lower = line.toLowerCase();
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('failed') || lower.includes('cannot load') || lower.includes('aborting')) {
        errors.push({
          line: lineIndex,
          timestamp: endTime || startTime,
          text: line.trim()
        });
      } else if (lower.includes('warning') || lower.includes('deprecated') || lower.includes('drop frame')) {
        warnings.push({
          line: lineIndex,
          timestamp: endTime || startTime,
          text: line.trim()
        });
      }

      // Check normal completion
      if (line.includes('video:') && line.includes('audio:') && line.includes('subtitle:') && line.includes('global headers:')) {
        normalCompletion = true;
      }

      // Parse banner & Emby FFmpeg custom build
      if (!ffmpegVersion && line.includes('ffmpeg version')) {
        const verMatch = line.match(/ffmpeg version\s+([^\s]+)/i);
        if (verMatch) ffmpegVersion = verMatch[1];
        if (line.includes('softworkz for Emby LLC') || line.includes('-emby')) {
          isEmbyFfmpeg = true;
        }
      }

      // Check exit code e.g. "ffmpeg exit code: 0" or "[q] command received. Exiting."
      const exitMatch = line.match(/exit code:?\s*(-?\d+)/i);
      if (exitMatch) {
        exitCode = parseInt(exitMatch[1], 10);
      }
    }

    if (onProgress) onProgress(100);

    // Calculate aggregate transcoding speed statistics
    let avgSpeed = null;
    let minSpeed = null;
    let maxSpeed = null;
    let isSpeedBottleneck = false;
    if (fpsSamples.length > 0) {
      let speedSum = 0;
      minSpeed = fpsSamples[0].speed;
      maxSpeed = fpsSamples[0].speed;
      for (const s of fpsSamples) {
        speedSum += s.speed;
        if (s.speed < minSpeed) minSpeed = s.speed;
        if (s.speed > maxSpeed) maxSpeed = s.speed;
      }
      avgSpeed = parseFloat((speedSum / fpsSamples.length).toFixed(2));
      // Speed bottleneck if average speed is below 1.0x (or minimum drops critically below 0.8x)
      if (avgSpeed < 1.0 || (fpsSamples.length >= 3 && minSpeed < 0.75)) {
        isSpeedBottleneck = true;
      }
    }

    return {
      filePath,
      fileName,
      jobId,
      commandLine,
      inputFiles,
      hwaccel,
      videoDecoder,
      videoEncoder,
      audioEncoder,
      user,
      fpsSamples,
      avgSpeed,
      minSpeed,
      maxSpeed,
      isSpeedBottleneck,
      startTime,
      endTime,
      errors,
      warnings,
      exitCode,
      normalCompletion: normalCompletion || exitCode === 0,
      hasCrashed: exitCode !== null && exitCode !== 0 && !normalCompletion,
      ffmpegVersion,
      isEmbyFfmpeg,
      userPolicy,
      hardwareDevices,
      inputStreams,
      outputStreams,
      videoProcessingSteps,
      toneMappingDesired,
      toneMappingDisabled,
      parsedLineCount: lineIndex
    };
  }

  static inspectCommandLine(cmd, callback) {
    const result = { inputFiles: [] };

    if (/h264_nvenc|hevc_nvenc|-hwaccel\s+cuda/i.test(cmd)) {
      result.hwaccel = 'NVENC (NVIDIA)';
    } else if (/h264_qsv|hevc_qsv|-hwaccel\s+qsv/i.test(cmd)) {
      result.hwaccel = 'QuickSync (Intel)';
    } else if (/vaapi/i.test(cmd)) {
      result.hwaccel = 'VAAPI (Linux)';
    } else if (/h264_amf|hevc_amf/i.test(cmd)) {
      result.hwaccel = 'AMF (AMD)';
    } else {
      result.hwaccel = 'Software (CPU)';
    }

    const vCodecMatch = cmd.match(/-c:v\s+([^\s]+)/i) || cmd.match(/-vcodec\s+([^\s]+)/i);
    if (vCodecMatch) result.videoEncoder = vCodecMatch[1];

    const aCodecMatch = cmd.match(/-c:a\s+([^\s]+)/i) || cmd.match(/-acodec\s+([^\s]+)/i);
    if (aCodecMatch) result.audioEncoder = aCodecMatch[1];

    const inputMatch = cmd.match(/-i\s+["']?([^"']+)["']?/g);
    if (inputMatch) {
      result.inputFiles = inputMatch.map(s => s.replace(/^-i\s+["']?/, '').replace(/["']$/, ''));
    }

    callback(result);
  }
}

module.exports = FFmpegParser;
