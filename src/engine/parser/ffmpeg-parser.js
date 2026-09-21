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

      // Extract User from User policy line if present
      // e.g. ">>>>>>  User policy for Alex"
      if (!user && line.includes('User policy for')) {
        const uMatch = line.match(/User policy for\s+([^\r\n.]+)/i);
        if (uMatch) {
          user = uMatch[1].trim();
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

      // Check exit code e.g. "ffmpeg exit code: 0" or "[q] command received. Exiting."
      const exitMatch = line.match(/exit code:?\s*(-?\d+)/i);
      if (exitMatch) {
        exitCode = parseInt(exitMatch[1], 10);
      }
    }

    if (onProgress) onProgress(100);

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
      startTime,
      endTime,
      errors,
      warnings,
      exitCode,
      normalCompletion: normalCompletion || exitCode === 0,
      hasCrashed: exitCode !== null && exitCode !== 0 && !normalCompletion
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
