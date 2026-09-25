/**
 * Coded Diagnostic Checks Engine.
 * Evaluates multiple factors on rich parsed object models (session, ffmpegLogs, serverContext)
 * instead of simple naive regex/string searches.
 *
 * Implements the 40 specialized programmatic diagnostic checks.
 */
class CodedChecksEngine {
  /**
   * Run all coded checks against a session and its correlated environment.
   * @param {object} session Correlated playback session
   * @param {object} serverContext Server environment metadata
   * @returns {Array<object>} Diagnostic findings produced by coded logic
   */
  static runAllChecks(session, serverContext = null) {
    const findings = [];
    const ctx = serverContext || session.serverContext || {};
    const ffmpegLogs = (session.transcodeLogs || []).map(t => t.ffmpegLog).filter(Boolean);

    // 1. Hardware & Acceleration Checks
    CodedChecksEngine.checkAvStartOffset(session, ffmpegLogs, findings);
    CodedChecksEngine.checkRdpGhostCodecs(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForAmf(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForMmal(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForOpenMax(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForV4L2(session, ffmpegLogs, findings);
    CodedChecksEngine.checkOpenCl1001Error(session, ffmpegLogs, findings);
    CodedChecksEngine.checkCuvidHevcDecoder(session, ffmpegLogs, findings);
    CodedChecksEngine.checkCuvidMp2Decoder(session, ffmpegLogs, findings);
    CodedChecksEngine.checkIntelArcLinuxKernelI915Instability(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkIntelDrivers(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkIntelGen11QsvLowPower(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkIntelHardware(session, ffmpegLogs, findings);
    CodedChecksEngine.checkIntelI915OpenClToneMappingResetRisk(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkIntelLinuxKernelMinVersion(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkJasperElkhartLake(session, ffmpegLogs, findings);
    CodedChecksEngine.checkJasperElkhartLakeOpenCL(session, ffmpegLogs, findings);
    CodedChecksEngine.checkMsdkVersion(session, ffmpegLogs, findings);
    CodedChecksEngine.checkQsvMp2Decoder(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForAmLogic(session, ffmpegLogs, findings);
    CodedChecksEngine.checkForAndroidSwCodecs(session, ffmpegLogs, findings);

    // 2. OS & System Checks
    CodedChecksEngine.checkAndroidExternalInstallation(session, ctx, findings);
    CodedChecksEngine.checkAndroidOs(session, ctx, findings);
    CodedChecksEngine.checkHwaOnBsd(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkMacOs(session, ffmpegLogs, ctx, findings);

    // 3. Stream & Media Bitrate Checks
    CodedChecksEngine.checkCompareFormat(session, ffmpegLogs, findings);
    CodedChecksEngine.checkCompareStreams(session, ffmpegLogs, findings);
    CodedChecksEngine.checkLongMediaPaths(session, ffmpegLogs, ctx, findings);
    CodedChecksEngine.checkSourceBitrate(session, ffmpegLogs, findings);
    CodedChecksEngine.checkOutputBitrate(session, ffmpegLogs, findings);

    // 4. Transcoding Decisions & Suggestions
    CodedChecksEngine.suggestDisableHwa(session, ffmpegLogs, findings);
    CodedChecksEngine.suggestDisableToneMapping(session, ffmpegLogs, findings);
    CodedChecksEngine.suggestTryWithoutSubtitles(session, ffmpegLogs, findings);
    CodedChecksEngine.checkTranscoding2ndRun(session, ffmpegLogs, findings);
    CodedChecksEngine.checkTranscodingSpeed(session, ffmpegLogs, findings);

    // 5. Version, Environment & Policy Checks
    CodedChecksEngine.checkFfmpegIsEmby(session, ffmpegLogs, findings);
    CodedChecksEngine.checkFfmpegVersionBackground(session, ffmpegLogs, findings);
    CodedChecksEngine.checkServerVersion(session, ctx, findings);
    CodedChecksEngine.checkUserPolicy(session, ffmpegLogs, findings);
    CodedChecksEngine.checkParsedLineCount(session, ffmpegLogs, ctx, findings);

    return findings;
  }

  // --- 1. CheckAvStartOffset ---
  static checkAvStartOffset(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const vStreams = (f.inputStreams || []).filter(s => s.type === 'Video');
      const aStreams = (f.inputStreams || []).filter(s => s.type === 'Audio');
      for (const vs of vStreams) {
        for (const as of aStreams) {
          const diff = Math.abs(vs.startTime - as.startTime);
          if (diff >= 0.5) { // 500ms offset
            findings.push({
              ruleId: 'CheckAvStartOffset',
              category: 'Hardware & Streams',
              title: 'Large Audio/Video Start-Time Offset Detected',
              rootCause: `Video stream (start: ${vs.startTime}s) and Audio stream (start: ${as.startTime}s) differ by ${diff.toFixed(3)}s.`,
              severity: 'Warning',
              confidence: 90,
              explanation: 'When container streams start with an asynchronous PTS offset exceeding 500ms, decoders and muxers may experience initial pipeline stalls, playback stutter, or A/V desync.',
              evidence: [`Stream ${vs.id} start: ${vs.startTime}s vs Stream ${as.id} start: ${as.startTime}s (offset: ${diff.toFixed(3)}s)`],
              recommendations: [
                'Remux the source file using MKVToolNix or FFmpeg with PTS normalization.',
                'Ensure client player has audio delay correction enabled if noticeable desync occurs.'
              ]
            });
            return;
          }
        }
      }
    }
  }

  // --- 2. CheckRdpGhostCodecs ---
  static checkRdpGhostCodecs(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const cmd = f.commandLine || '';
      const hasRdpCodec = /rdp_ghost|rdp_enc|chained_dd|RdpVideoCodecs/i.test(cmd) ||
        (f.hardwareDevices || []).some(d => /rdp|remote desktop/i.test(d.name));
      if (hasRdpCodec) {
        findings.push({
          ruleId: 'CheckRdpGhostCodecs',
          category: 'Hardware',
          title: 'Windows RDP Ghost Codec Detected',
          rootCause: 'Transcoding pipeline selected Windows Remote Desktop virtual display/audio codecs instead of bare-metal GPU/audio endpoints.',
          severity: 'Warning',
          confidence: 95,
          explanation: 'Running Emby or remote administration sessions via Windows RDP can inject virtual display adapter sinks that break direct GPU hardware acceleration hooks.',
          evidence: [cmd.slice(0, 150)],
          recommendations: [
            'Avoid running Emby Server as an active interactive RDP session; run Emby as a Windows Service.',
            'Ensure hardware transcoding is bound to physical display GPU indexes.'
          ]
        });
        return;
      }
    }
  }

  // --- 3. CheckForAmf ---
  static checkForAmf(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const isAmfConfigured = /amf/i.test(f.hwaccel) || /_amf/i.test(f.videoEncoder || '') || /_amf/i.test(f.videoDecoder || '');
      if (isAmfConfigured) {
        const amfError = f.errors.find(e => /amf|amf_runtime|AMF_FAIL/i.test(e.text));
        if (amfError) {
          findings.push({
            ruleId: 'CheckForAmf',
            category: 'Hardware',
            title: 'AMD AMF Hardware Acceleration Initialization Failure',
            rootCause: `AMD Advanced Media Framework (AMF) failed: ${amfError.text}`,
            severity: 'Error',
            confidence: 94,
            explanation: 'AMF encoder was requested for AMD Radeon GPU transcoding, but the AMF runtime libraries rejected the session parameters or encountered driver communication faults.',
            evidence: [amfError.text],
            recommendations: [
              'Update AMD Adrenalin graphics drivers to the latest WHQL release.',
              'On Linux, install AMDGPU-PRO proprietary AMF components or switch to VAAPI transcoding.'
            ]
          });
        }
      }
    }
  }

  // --- 4. CheckForMmal ---
  static checkForMmal(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesMmal = /mmal/i.test(f.commandLine || '') || /mmal/i.test(f.videoDecoder || '');
      if (usesMmal) {
        findings.push({
          ruleId: 'CheckForMmal',
          category: 'Hardware',
          title: 'Legacy MMAL Hardware Acceleration in Use',
          rootCause: 'Transcoding pipeline is utilizing legacy Raspberry Pi MMAL video decoding.',
          severity: 'Warning',
          confidence: 92,
          explanation: 'MMAL (Multi-Media Abstraction Layer) is deprecated in modern Linux kernels (kernel >= 5.15) and 64-bit Raspberry Pi OS distributions.',
          evidence: [f.videoDecoder || 'MMAL decoder'],
          recommendations: [
            'Migrate Raspberry Pi configuration to modern V4L2-M2M / DRM hardware pipelines in Emby Transcoding settings.',
            'Ensure kernel driver `bcm2835-codec` is active.'
          ]
        });
      }
    }
  }

  // --- 5. CheckForOpenMax ---
  static checkForOpenMax(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesOmx = /omx|openmax|h264_omx/i.test(f.commandLine || '') || /omx/i.test(f.videoEncoder || '');
      if (usesOmx) {
        findings.push({
          ruleId: 'CheckForOpenMax',
          category: 'Hardware',
          title: 'Deprecated OpenMAX (OMX) Codec Detected',
          rootCause: 'Transcoding is executing with OpenMAX IL encoders/decoders.',
          severity: 'Warning',
          confidence: 93,
          explanation: 'OpenMAX has been deprecated across Linux and Android platforms in favor of V4L2 Statefull/Stateless decoders and Android MediaCodec.',
          evidence: [f.videoEncoder || 'OpenMAX'],
          recommendations: [
            'Disable OMX encoders in Emby Server Transcoding settings and select V4L2 or VAAPI.'
          ]
        });
      }
    }
  }

  // --- 6. CheckForV4L2 ---
  static checkForV4L2(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesV4l2 = /v4l2/i.test(f.commandLine || '') || /v4l2m2m/i.test(f.videoEncoder || '') || /v4l2m2m/i.test(f.videoDecoder || '');
      if (usesV4l2) {
        const v4l2Err = f.errors.find(e => /v4l2|m2m|VIDIOC_/i.test(e.text));
        if (v4l2Err) {
          findings.push({
            ruleId: 'CheckForV4L2',
            category: 'Hardware',
            title: 'V4L2 M2M Hardware Acceleration Failure',
            rootCause: `Video4Linux2 hardware decoder/encoder failed: ${v4l2Err.text}`,
            severity: 'Error',
            confidence: 93,
            explanation: 'V4L2 Memory-to-Memory device communication returned an ioctl error or failed buffer queueing.',
            evidence: [v4l2Err.text],
            recommendations: [
              'Verify permissions on `/dev/video*` devices (`sudo usermod -aG video emby`).',
              'Check system `dmesg` for hardware codec reset or driver hangs.'
            ]
          });
        }
      }
    }
  }

  // --- 7. CheckOpenCl1001Error ---
  static checkOpenCl1001Error(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const err = f.errors.find(e => e.text.includes('-1001') || e.text.includes('CL_PLATFORM_NOT_FOUND_KHR') || /opencl.*1001/i.test(e.text));
      if (err) {
        findings.push({
          ruleId: 'CheckOpenCl1001Error',
          category: 'Hardware',
          title: 'OpenCL Error -1001 (Platform Not Found)',
          rootCause: 'OpenCL returned error code -1001: CL_PLATFORM_NOT_FOUND_KHR.',
          severity: 'Error',
          confidence: 98,
          explanation: 'OpenCL runtime platform is missing or ICD loader cannot find vendor ICD configuration (`/etc/OpenCL/vendors/`). This breaks OpenCL-based HDR tone mapping and subtitle scaling.',
          evidence: [err.text],
          recommendations: [
            'Install the vendor OpenCL compute runtime (e.g. `intel-opencl-icd` / `rocm-opencl` / `nvidia-opencl`).',
            'Verify OpenCL platform detection using `clinfo` CLI tool on the host.',
            'Temporarily switch Tone Mapping Mode from OpenCL to VPP/Native in Transcoding settings.'
          ]
        });
      }
    }
  }

  // --- 8. CheckCuvidHevcDecoder ---
  static checkCuvidHevcDecoder(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesCuvidHevc = /hevc_cuvid/i.test(f.commandLine || '') || /hevc_cuvid/i.test(f.videoDecoder || '');
      if (usesCuvidHevc) {
        findings.push({
          ruleId: 'CheckCuvidHevcDecoder',
          category: 'Hardware',
          title: 'Legacy CUVID HEVC Decoder Selected',
          rootCause: 'FFmpeg transcode is invoking legacy `hevc_cuvid` instead of modern NVDEC hardware decoding.',
          severity: 'Warning',
          confidence: 88,
          explanation: 'CUVID decoders create unnecessary host memory copies and do not support dynamic surface allocation as efficiently as NVDEC (`-hwaccel cuda -hwaccel_output_format cuda`).',
          evidence: [f.videoDecoder || 'hevc_cuvid'],
          recommendations: [
            'Update Emby Server and enable modern CUDA / NVDEC hardware acceleration in Transcoding settings.'
          ]
        });
      }
    }
  }

  // --- 9. CheckCuvidMp2Decoder ---
  static checkCuvidMp2Decoder(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesCuvidMp2 = /mpeg2_cuvid/i.test(f.commandLine || '') || /mpeg2_cuvid/i.test(f.videoDecoder || '');
      if (usesCuvidMp2) {
        findings.push({
          ruleId: 'CheckCuvidMp2Decoder',
          category: 'Hardware',
          title: 'CUVID MPEG-2 Decoder Selected',
          rootCause: 'FFmpeg transcode is invoking `mpeg2_cuvid` for MPEG-2 broadcast stream decoding.',
          severity: 'Warning',
          confidence: 86,
          explanation: 'Certain NVIDIA consumer GPU architectures exhibit deinterlacing artifacts and field tearing when decoding interlaced broadcast MPEG-2 via CUVID.',
          evidence: [f.videoDecoder || 'mpeg2_cuvid'],
          recommendations: [
            'If watching interlaced Live TV / DVR recordings with stutter, configure MPEG-2 to use software decoding.'
          ]
        });
      }
    }
  }

  // --- 10. CheckIntelArcLinuxKernelI915Instability ---
  static checkIntelArcLinuxKernelI915Instability(session, ffmpegLogs, ctx, findings) {
    const isLinux = ctx.osPlatform === 'Linux' || /linux/i.test(ctx.operatingSystem || '');
    const kernelVer = ctx.osKernel || '';
    for (const f of ffmpegLogs) {
      const hasArcGpu = (f.hardwareDevices || []).some(d => /arc|dg2|alchemist|a380|a310|a750|a770/i.test(d.name) || /^0x56/i.test(d.id || ''));
      if (isLinux && hasArcGpu) {
        // Kernels < 6.2 had serious i915 driver ring hangs with Intel Arc discrete GPUs
        const kParts = kernelVer.split('.').map(n => parseInt(n, 10));
        const isProblematic = kParts.length >= 2 && (kParts[0] < 6 || (kParts[0] === 6 && kParts[1] < 2));
        if (isProblematic || (f.errors || []).some(e => /i915.*hang|drm_sched/i.test(e.text))) {
          findings.push({
            ruleId: 'CheckIntelArcLinuxKernelI915Instability',
            category: 'Hardware & OS',
            title: 'Intel Arc GPU Linux Kernel i915 Instability Risk',
            rootCause: `Intel Arc GPU detected on Linux kernel ${kernelVer || 'outdated'} with i915 driver instability.`,
            severity: 'Error',
            confidence: 94,
            explanation: 'Intel Arc Alchemist (DG2) GPUs require Linux kernel >= 6.2 (recommended 6.5+ or the `xe` driver on 6.8+) for stable QSV/VAAPI hardware transcode without GPU ring lockups.',
            evidence: [`Kernel: ${kernelVer}`, `GPU: Arc detected`],
            recommendations: [
              'Upgrade Linux host kernel to version 6.5 or newer (or Ubuntu HWE kernel).',
              'Enable `i915.force_probe=56xx` in GRUB parameters if GPU is not natively recognized.'
            ]
          });
        }
      }
    }
  }

  // --- 11. CheckIntelDrivers ---
  static checkIntelDrivers(session, ffmpegLogs, ctx, findings) {
    const isWindows = ctx.osPlatform === 'Windows' || /windows/i.test(ctx.operatingSystem || '');
    if (isWindows) {
      for (const f of ffmpegLogs) {
        const intelDev = (f.hardwareDevices || []).find(d => /intel|uhd|iris/i.test(d.name));
        if (intelDev && intelDev.driver) {
          const match = intelDev.driver.match(/\b(\d{2})\.(\d+)\.(\d+)\.(\d+)\b/);
          if (match) {
            const build = parseInt(match[4], 10);
            if (build < 1010000 && build < 3100) { // Old Intel legacy driver
              findings.push({
                ruleId: 'CheckIntelDrivers',
                category: 'Hardware',
                title: 'Outdated Intel Windows Graphics Driver',
                rootCause: `Detected legacy Intel driver version ${intelDev.driver}.`,
                severity: 'Warning',
                confidence: 88,
                explanation: 'Older Intel Windows display drivers contain known memory leaks in MFX/oneVPL hardware encoder sessions.',
                evidence: [`Driver: ${intelDev.driver}`],
                recommendations: [
                  'Install latest Intel Graphics Windows DCH Drivers from intel.com (driver 31.0.101.x or higher).'
                ]
              });
            }
          }
        }
      }
    }
  }

  // --- 12. CheckIntelGen11QsvLowPower ---
  static checkIntelGen11QsvLowPower(session, ffmpegLogs, ctx, findings) {
    const isLinux = ctx.osPlatform === 'Linux' || /linux/i.test(ctx.operatingSystem || '');
    for (const f of ffmpegLogs) {
      const isGen11 = (f.hardwareDevices || []).some(d => /iris plus|g1|g4|g7|ice lake|10\d{2}g/i.test(d.name));
      const hasLowPower = /-low_power\s+1/i.test(f.commandLine || '');
      if (isLinux && isGen11 && hasLowPower) {
        findings.push({
          ruleId: 'CheckIntelGen11QsvLowPower',
          category: 'Hardware',
          title: 'Intel Gen11 (Ice Lake) Low-Power QSV Hang Risk',
          rootCause: 'Intel Gen11 Ice Lake GPU invoked with `-low_power 1` on Linux.',
          severity: 'Warning',
          confidence: 90,
          explanation: 'Ice Lake Gen11 iGPUs have silicon errata in low-power VDEnc execution pipelines under Linux VAAPI/QSV, resulting in kernel GPU ring buffer hangs.',
          evidence: ['Gen11 GPU with -low_power 1'],
          recommendations: [
            'In Emby Dashboard -> Transcoding -> Advanced, disable Low-Power Encoding mode for QuickSync.'
          ]
        });
      }
    }
  }

  // --- 13. CheckIntelHardware ---
  static checkIntelHardware(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const olderIntel = (f.hardwareDevices || []).find(d => /hd graphics [2345]000|hd graphics 4[246]00|hd graphics 5[123]0|ivy bridge|haswell|broadwell/i.test(d.name));
      const requestedHevc = (f.inputStreams || []).some(s => s.type === 'Video' && /hevc|h265|10-bit/i.test(s.codec));
      if (olderIntel && requestedHevc) {
        findings.push({
          ruleId: 'CheckIntelHardware',
          category: 'Hardware',
          title: 'Older Intel Generation Lacks 10-Bit HEVC Hardware Decode',
          rootCause: `${olderIntel.name} does not have fixed-function silicon for HEVC 10-bit hardware decode.`,
          severity: 'Warning',
          confidence: 92,
          explanation: 'Intel Quick Sync fixed-function 10-bit HEVC decoding was only introduced with 7th Generation Kaby Lake (HD 630). Older architectures must fall back to hybrid or CPU decode.',
          evidence: [`Adapter: ${olderIntel.name}`],
          recommendations: [
            'Upgrade server CPU to 8th Generation (Coffee Lake) or newer for full hardware 4K HEVC 10-bit decoding.',
            'Direct play HEVC content on compatible clients rather than transcoding on legacy hardware.'
          ]
        });
      }
    }
  }

  // --- 14. CheckIntelI915OpenClToneMappingResetRisk ---
  static checkIntelI915OpenClToneMappingResetRisk(session, ffmpegLogs, ctx, findings) {
    const isLinux = ctx.osPlatform === 'Linux' || /linux/i.test(ctx.operatingSystem || '');
    const kernelVer = ctx.osKernel || '';
    for (const f of ffmpegLogs) {
      const usesOpenClTonemap = /tonemap_opencl/i.test(f.commandLine || '') || f.videoProcessingSteps.some(s => /opencl/i.test(s));
      const hasIntel = (f.hardwareDevices || []).some(d => /intel|uhd|iris/i.test(d.name)) || /qsv|dev\/dri/i.test(f.commandLine || '');
      if (isLinux && hasIntel && usesOpenClTonemap) {
        // Kernel ranges 5.19 through 6.1 had i915 DRM scheduler race conditions during OpenCL SVM tone-mapping
        const kMatch = kernelVer.match(/^(\d+)\.(\d+)/);
        if (kMatch) {
          const major = parseInt(kMatch[1], 10);
          const minor = parseInt(kMatch[2], 10);
          if ((major === 5 && minor >= 19) || (major === 6 && minor <= 1)) {
            findings.push({
              ruleId: 'CheckIntelI915OpenClToneMappingResetRisk',
              category: 'Hardware & OS',
              title: 'Intel i915 Kernel OpenCL Tone-Mapping Reset Risk',
              rootCause: `Linux kernel ${kernelVer} contains known i915 GPU engine reset regressions when executing OpenCL HDR tone mapping.`,
              severity: 'Warning',
              confidence: 91,
              explanation: 'Linux kernel versions 5.19 - 6.1 contain scheduler synchronization bugs in i915 ring dispatch when sharing buffers between VAAPI/QSV and OpenCL tone mapping filters.',
              evidence: [`Kernel: ${kernelVer}`, 'OpenCL tone-mapping enabled'],
              recommendations: [
                'Upgrade Linux kernel to >= 6.2 or use native Intel VPP tone mapping instead of OpenCL in Emby Transcoding options.'
              ]
            });
          }
        }
      }
    }
  }

  // --- 15. CheckIntelLinuxKernelMinVersion ---
  static checkIntelLinuxKernelMinVersion(session, ffmpegLogs, ctx, findings) {
    const isLinux = ctx.osPlatform === 'Linux' || /linux/i.test(ctx.operatingSystem || '');
    const kernelVer = ctx.osKernel || '';
    if (isLinux && kernelVer) {
      for (const f of ffmpegLogs) {
        const isAlderOrRaptor = (f.hardwareDevices || []).some(d => /uhd 770|alder lake|raptor lake|12\d{2}0|13\d{2}0|14\d{2}0/i.test(d.name));
        const kParts = kernelVer.split('.').map(n => parseInt(n, 10));
        if (isAlderOrRaptor && (kParts[0] < 5 || (kParts[0] === 5 && kParts[1] < 16))) {
          findings.push({
            ruleId: 'CheckIntelLinuxKernelMinVersion',
            category: 'Hardware & OS',
            title: 'Intel Alder/Raptor Lake Linux Kernel Floor Not Met',
            rootCause: `Intel 12th/13th/14th Gen GPU running on Linux kernel ${kernelVer} below minimum requirement (5.16+).`,
            severity: 'Error',
            confidence: 95,
            explanation: 'Alder Lake and Raptor Lake iGPUs require Linux kernel 5.16 or higher to initialize the GuC/HuC microcontrollers and register `/dev/dri/renderD128`.',
            evidence: [`Kernel: ${kernelVer}`, 'Alder/Raptor Lake GPU'],
            recommendations: [
              'Upgrade Linux distribution kernel to version 5.19 or 6.x.'
            ]
          });
        }
      }
    }
  }

  // --- 16. CheckJasperElkhartLake ---
  static checkJasperElkhartLake(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const isJasperElkhart = (f.hardwareDevices || []).some(d => /n5105|n5095|n6005|j6412|elkhart lake|jasper lake/i.test(d.name));
      if (isJasperElkhart) {
        const hasGpuHang = f.errors.some(e => /gpu hang|drm_sched_job_timedout|i915.*reset/i.test(e.text));
        if (hasGpuHang) {
          findings.push({
            ruleId: 'CheckJasperElkhartLake',
            category: 'Hardware',
            title: 'Intel Jasper Lake (N5105/N5095) GPU Hang Detected',
            rootCause: 'Intel Jasper Lake GPU ring hang occurred during transcoding.',
            severity: 'Critical',
            confidence: 96,
            explanation: 'Jasper Lake (N5095/N5105) low-power Celeron/Pentium processors suffer from hardware locks in low-power transcode paths unless HuC/GuC firmware is loaded.',
            evidence: ['Jasper Lake processor detected with GPU hang'],
            recommendations: [
              'Enable GuC/HuC firmware loading in GRUB: `options i915 enable_guc=3`.',
              'Update host BIOS/microcode.'
            ]
          });
        }
      }
    }
  }

  // --- 17. CheckJasperElkhartLakeOpenCL ---
  static checkJasperElkhartLakeOpenCL(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const isJasperElkhart = (f.hardwareDevices || []).some(d => /n5105|n5095|n6005|j6412|jasper lake/i.test(d.name));
      const hasOpenClToneMap = /tonemap_opencl/i.test(f.commandLine || '') || f.videoProcessingSteps.some(s => /opencl/i.test(s));
      if (isJasperElkhart && hasOpenClToneMap) {
        findings.push({
          ruleId: 'CheckJasperElkhartLakeOpenCL',
          category: 'Hardware',
          title: 'Jasper Lake OpenCL HDR Tone Mapping Bottleneck',
          rootCause: 'Jasper Lake (N5095/N5105) 16/24 EU execution units overloaded by OpenCL tone mapping compute shaders.',
          severity: 'Warning',
          confidence: 90,
          explanation: 'Jasper Lake iGPUs have limited compute shaders (16 to 24 EUs). Running OpenCL tone-mapping shaders often drags transcoding speeds below 1.0x (real-time).',
          evidence: ['Jasper Lake with OpenCL tone mapping'],
          recommendations: [
            'In Emby Transcoding settings, switch Tone Mapping Method to VPP (Intel Video Processing Project) instead of OpenCL.'
          ]
        });
      }
    }
  }

  // --- 18. CheckMsdkVersion ---
  static checkMsdkVersion(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const hasLegacyMsdk = (f.hardwareDevices || []).some(d => d.sdkVersion && parseFloat(d.sdkVersion) < 1.30);
      if (hasLegacyMsdk) {
        findings.push({
          ruleId: 'CheckMsdkVersion',
          category: 'Hardware',
          title: 'Legacy Intel Media SDK (MSDK) Detected',
          rootCause: 'Intel MSDK version is below 1.30 or using legacy `i965` driver.',
          severity: 'Warning',
          confidence: 89,
          explanation: 'Intel has deprecated Media SDK in favor of oneVPL and the modern Intel Media Driver (`iHD`). Modern QSV features require updated oneVPL dispatchers.',
          evidence: [(f.hardwareDevices || []).map(d => `${d.name} SDK: ${d.sdkVersion}`).join(', ')],
          recommendations: [
            'Ensure `intel-media-va-driver-non-free` and oneVPL packages are installed on the host system.'
          ]
        });
      }
    }
  }

  // --- 19. CheckQsvMp2Decoder ---
  static checkQsvMp2Decoder(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const usesQsvMp2 = /mpeg2_qsv/i.test(f.commandLine || '') || /mpeg2_qsv/i.test(f.videoDecoder || '');
      if (usesQsvMp2) {
        const hasErr = f.errors.some(e => /mpeg2_qsv|qsv.*error|decode.*failed/i.test(e.text));
        if (hasErr) {
          findings.push({
            ruleId: 'CheckQsvMp2Decoder',
            category: 'Hardware',
            title: 'QuickSync MPEG-2 Hardware Decoder Failure',
            rootCause: 'Intel QuickSync `mpeg2_qsv` hardware decoder failed on broadcast video stream.',
            severity: 'Error',
            confidence: 92,
            explanation: 'Interlaced MPEG-2 DVB streams with dynamic aspect-ratio switches frequently crash Intel hardware MPEG-2 decoder sessions.',
            evidence: [f.videoDecoder || 'mpeg2_qsv'],
            recommendations: [
              'Disable MPEG-2 hardware acceleration in Emby Server Dashboard -> Transcoding -> Hardware Acceleration to decode MPEG-2 with CPU.'
            ]
          });
        }
      }
    }
  }

  // --- 20. CheckForAmLogic ---
  static checkForAmLogic(session, ffmpegLogs, findings) {
    const isAmLogic = /amlogic|odroid|khadas|s905|s912|s922/i.test(session.clientDevice || '');
    if (isAmLogic) {
      findings.push({
        ruleId: 'CheckForAmLogic',
        category: 'Hardware & Client',
        title: 'AMLogic Android Platform Client Detected',
        rootCause: 'Playback initiated from an AMLogic SoC client device.',
        severity: 'Info',
        confidence: 85,
        explanation: 'AMLogic SoC based Android TV devices utilize specialized MediaCodec decoders with strict memory bounds.',
        evidence: [`Client: ${session.clientDevice}`],
        recommendations: [
          'Ensure hardware decoding is set to Surface View in the Emby Android client app settings.'
        ]
      });
    }
  }

  // --- 21. CheckForAndroidSwCodecs ---
  static checkForAndroidSwCodecs(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const isAndroidSw = /c2\.android|omx\.google/i.test(f.commandLine || '') ||
        f.warnings.some(w => /c2\.android|omx\.google/i.test(w.text));
      if (isAndroidSw) {
        findings.push({
          ruleId: 'CheckForAndroidSwCodecs',
          category: 'Hardware & Client',
          title: 'Android Software Codec Fallback Detected',
          rootCause: 'Playback pipeline fell back to CPU software decoders (`c2.android.*` / `OMX.google.*`).',
          severity: 'Warning',
          confidence: 90,
          explanation: 'Client device hardware decoder rejected the profile or resolution level, forcing CPU-intensive software decoding.',
          evidence: ['c2.android / OMX.google in use'],
          recommendations: [
            'Check if video resolution or bit depth exceeds hardware limits of the Android client device.'
          ]
        });
      }
    }
  }

  // --- 22. CheckAndroidExternalInstallation ---
  static checkAndroidExternalInstallation(session, ctx, findings) {
    const pathIndicator = session.events.find(e => /mnt\/media_rw|\/storage\/[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}/i.test(e.details || ''));
    if (pathIndicator) {
      findings.push({
        ruleId: 'CheckAndroidExternalInstallation',
        category: 'Storage & OS',
        title: 'Android External SD Storage Installation',
        rootCause: 'Emby application data or playback buffer located on external adoptable SD storage.',
        severity: 'Warning',
        confidence: 92,
        explanation: 'Running Emby cache or app directory on external MicroSD cards introduces severe I/O read/write bottlenecks.',
        evidence: [pathIndicator.details],
        recommendations: [
          'Move Emby application data to internal high-speed flash storage.'
        ]
      });
    }
  }

  // --- 23. CheckAndroidOs ---
  static checkAndroidOs(session, ctx, findings) {
    const devStr = session.clientDevice || '';
    const match = devStr.match(/Android\s*(\d+)/i) || (session.events.find(e => (e.details || '').includes('Android')) || {}).details?.match(/Android\s*(\d+)/i);
    if (match) {
      const ver = parseInt(match[1], 10);
      if (ver <= 8) {
        findings.push({
          ruleId: 'CheckAndroidOs',
          category: 'OS',
          title: 'Legacy Android OS Version Detected',
          rootCause: `Client running Android ${ver}, which lacks modern AndroidX Media3 / ExoPlayer codecs.`,
          severity: 'Warning',
          confidence: 88,
          explanation: `Android ${ver} has known TLS cipher suite limitations and lacks hardware support for VP9 Profile 2 / AV1 decoding.`,
          evidence: [`Client OS: Android ${ver}`],
          recommendations: [
            'Update client device to Android 10 or newer if firmware is available.'
          ]
        });
      }
    }
  }

  // --- 24. CheckHwaOnBsd ---
  static checkHwaOnBsd(session, ffmpegLogs, ctx, findings) {
    const isBsd = ctx.osPlatform === 'BSD' || /freebsd|truenas/i.test(ctx.operatingSystem || '');
    if (isBsd) {
      for (const f of ffmpegLogs) {
        if (f.hwaccel !== 'None' && f.hwaccel !== 'Software (CPU)') {
          const hasDrmErr = f.errors.some(e => /drm|ioctl|renderD|vaapi/i.test(e.text));
          if (hasDrmErr) {
            findings.push({
              ruleId: 'CheckHwaOnBsd',
              category: 'Hardware & OS',
              title: 'FreeBSD / TrueNAS Hardware Acceleration Failure',
              rootCause: 'Hardware acceleration failed under FreeBSD / TrueNAS Core jail.',
              severity: 'Error',
              confidence: 93,
              explanation: 'FreeBSD requires explicit `drm-kmod` kernel module loading and devfs ruleset configuration for `/dev/dri` pass-through into jails.',
              evidence: ['FreeBSD OS with hardware transcode failure'],
              recommendations: [
                'Ensure `kldload i915kms` or appropriate driver is loaded in `/boot/loader.conf`.',
                'Verify jail devfs ruleset grants permissions to `/dev/dri/*`.'
              ]
            });
          }
        }
      }
    }
  }

  // --- 25. CheckMacOs ---
  static checkMacOs(session, ffmpegLogs, ctx, findings) {
    const isMac = ctx.osPlatform === 'macOS' || /darwin|mac/i.test(ctx.operatingSystem || '');
    if (isMac) {
      for (const f of ffmpegLogs) {
        const vtError = f.errors.find(e => /videotoolbox|vt_|coremedia/i.test(e.text));
        if (vtError) {
          findings.push({
            ruleId: 'CheckMacOs',
            category: 'OS & Hardware',
            title: 'macOS Apple VideoToolbox Transcoding Failure',
            rootCause: `Apple VideoToolbox session failed: ${vtError.text}`,
            severity: 'Error',
            confidence: 94,
            explanation: 'macOS VideoToolbox hardware encoder returned a framework session error or exceeded MaxSessionCount.',
            evidence: [vtError.text],
            recommendations: [
              'Verify that Emby Server has system permissions for hardware video processing.',
              'Ensure macOS has the latest Sonoma / Sequoia updates installed.'
            ]
          });
        }
      }
    }
  }

  // --- 26. CheckCompareFormat ---
  static checkCompareFormat(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      if (f.inputStreams.length > 0 && f.outputStreams.length > 0) {
        const inVideo = f.inputStreams.find(s => s.type === 'Video');
        const outVideo = f.outputStreams.find(s => s.type === 'Video');
        if (inVideo && outVideo) {
          if (inVideo.width && outVideo.width && outVideo.width < inVideo.width) {
            findings.push({
              ruleId: 'CheckCompareFormat',
              category: 'Stream & Bitrate',
              title: 'Resolution Downscale Transcoding Active',
              rootCause: `Video scaled down from ${inVideo.width}x${inVideo.height} to ${outVideo.width}x${outVideo.height}.`,
              severity: 'Info',
              confidence: 95,
              explanation: 'Emby is scaling video resolution down to fit client bandwidth caps or client display boundaries.',
              evidence: [`Input: ${inVideo.width}x${inVideo.height} -> Output: ${outVideo.width}x${outVideo.height}`],
              recommendations: [
                'Increase client streaming quality settings if on a high-speed network.'
              ]
            });
          }
        }
      }
    }
  }

  // --- 27. CheckCompareStreams ---
  static checkCompareStreams(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const inAudio = f.inputStreams.find(s => s.type === 'Audio');
      const outAudio = f.outputStreams.find(s => s.type === 'Audio');
      if (inAudio && outAudio) {
        if (/7\.1|truehd|dts-hd/i.test(inAudio.codec) && /2\.0|stereo/i.test(outAudio.codec || outAudio.raw)) {
          findings.push({
            ruleId: 'CheckCompareStreams',
            category: 'Stream & Bitrate',
            title: 'Surround Audio Downmixed to Stereo',
            rootCause: `Source audio (${inAudio.codec}) was downmixed to stereo for client compatibility.`,
            severity: 'Info',
            confidence: 90,
            explanation: 'The playback device does not report multichannel surround sound support, so Emby downmixed audio.',
            evidence: [`Input audio: ${inAudio.codec}`],
            recommendations: [
              'Verify client audio output settings and HDMI passthrough capabilities.'
            ]
          });
        }
      }
    }
  }

  // --- 28. CheckLongMediaPaths ---
  static checkLongMediaPaths(session, ffmpegLogs, ctx, findings) {
    const isWindows = ctx.osPlatform === 'Windows' || /windows/i.test(ctx.operatingSystem || '');
    for (const f of ffmpegLogs) {
      for (const p of f.inputFiles) {
        if (p.length > 255) {
          findings.push({
            ruleId: 'CheckLongMediaPaths',
            category: 'Storage & OS',
            title: 'Excessive Media File Path Length (>255 Characters)',
            rootCause: `Media path length (${p.length} chars) exceeds traditional MAX_PATH limits: ${p}`,
            severity: isWindows ? 'Error' : 'Warning',
            confidence: 94,
            explanation: 'File paths exceeding 260 characters cause silent I/O access failures on Windows systems unless `LongPathsEnabled` registry key is set.',
            evidence: [`Path length: ${p.length}`],
            recommendations: [
              'Shorten directory structure naming or enable long path support in Windows registry (`HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1`).'
            ]
          });
          return;
        }
      }
    }
  }

  // --- 29. CheckSourceBitrate ---
  static checkSourceBitrate(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const inVideo = (f.inputStreams || []).find(s => s.type === 'Video');
      if (inVideo && inVideo.bitrateKbps && inVideo.bitrateKbps > 50000) {
        findings.push({
          ruleId: 'CheckSourceBitrate',
          category: 'Stream & Bitrate',
          title: 'High Source Media Bitrate (>50 Mbps)',
          rootCause: `Source media bitrate is exceptionally high (${Math.round(inVideo.bitrateKbps / 1000)} Mbps).`,
          severity: 'Info',
          confidence: 92,
          explanation: 'Remuxes with bitrates over 50 Mbps require substantial sustained disk I/O and network bandwidth, increasing transcode load.',
          evidence: [`Bitrate: ${inVideo.bitrateKbps} kbps`],
          recommendations: [
            'Ensure media is stored on high-speed SSDs or gigabit local networks to prevent buffering.'
          ]
        });
      }
    }
  }

  // --- 30. CheckOutputBitrate ---
  static checkOutputBitrate(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const outVideo = (f.outputStreams || []).find(s => s.type === 'Video');
      if (outVideo && outVideo.bitrateKbps && outVideo.bitrateKbps > 30000) {
        findings.push({
          ruleId: 'CheckOutputBitrate',
          category: 'Stream & Bitrate',
          title: 'High Output Transcode Bitrate Target',
          rootCause: `FFmpeg transcoding target bitrate set to ${Math.round(outVideo.bitrateKbps / 1000)} Mbps.`,
          severity: 'Info',
          confidence: 88,
          explanation: 'Target transcode bitrates over 30 Mbps require high GPU encoder throughput and fast remote uplink speeds.',
          evidence: [`Output Bitrate: ${outVideo.bitrateKbps} kbps`],
          recommendations: [
            'Verify server upload speed limit matches user internet bandwidth.'
          ]
        });
      }
    }
  }

  // --- 31. SuggestDisableHwa ---
  static suggestDisableHwa(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const hasHwaFail = f.hasCrashed && (f.hwaccel !== 'None' && f.hwaccel !== 'Software (CPU)') &&
        f.errors.some(e => /initialize|device creation|driver|mfx|cuda|nvenc|vaapi/i.test(e.text));
      if (hasHwaFail) {
        findings.push({
          ruleId: 'SuggestDisableHwa',
          category: 'Decisions & Remediation',
          title: 'Recommendation: Temporarily Disable Hardware Acceleration',
          rootCause: 'Hardware accelerator failed to complete transcoding session.',
          severity: 'Error',
          confidence: 95,
          explanation: 'Because the hardware encoder crashed repeatedly, disabling hardware acceleration allows software CPU fallback.',
          evidence: ['Hardware transcoding crash verified'],
          recommendations: [
            'Go to Emby Server Dashboard -> Transcoding -> Hardware Acceleration and set to "No".'
          ]
        });
      }
    }
  }

  // --- 32. SuggestDisableToneMapping ---
  static suggestDisableToneMapping(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const hasTmError = f.errors.some(e => /tonemap|zscale|opencl.*tonemap|vpp_qsv.*tonemap/i.test(e.text));
      if (hasTmError || (f.toneMappingDesired && f.isSpeedBottleneck)) {
        findings.push({
          ruleId: 'SuggestDisableToneMapping',
          category: 'Decisions & Remediation',
          title: 'Recommendation: Disable HDR Tone Mapping',
          rootCause: 'HDR tone-mapping algorithm caused transcoding pipeline stall or driver crash.',
          severity: 'Warning',
          confidence: 92,
          explanation: 'Tone-mapping HDR (BT.2020 / HDR10) content to SDR requires heavy shader calculations that are overwhelming the GPU.',
          evidence: ['HDR tone mapping filter failure / bottleneck'],
          recommendations: [
            'In Emby Dashboard -> Transcoding, disable "Enable HDR tone mapping" or select native VPP.'
          ]
        });
      }
    }
  }

  // --- 33. SuggestTryWithoutSubtitles ---
  static suggestTryWithoutSubtitles(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const subBurnInFail = f.errors.some(e => /filter.*subtitles|too many packets buffered|packet queue full|pgssub/i.test(e.text));
      if (subBurnInFail) {
        findings.push({
          ruleId: 'SuggestTryWithoutSubtitles',
          category: 'Decisions & Remediation',
          title: 'Recommendation: Test Playback Without Subtitles',
          rootCause: 'Subtitle burn-in or packet buffering queue overflowed output buffers.',
          severity: 'Warning',
          confidence: 93,
          explanation: 'Burning graphical subtitles (PGS/VobSub) into transcoded video requires rasterization synchronization that often causes buffer underruns.',
          evidence: [f.errors.map(e => e.text).slice(0, 2).join('; ')],
          recommendations: [
            'Turn off subtitles in the client app to verify if video streams smoothly.',
            'Download external text (SRT) subtitles instead of burning PGS bitmap tracks.'
          ]
        });
      }
    }
  }

  // --- 34. CheckTranscoding2ndRun ---
  static checkTranscoding2ndRun(session, ffmpegLogs, findings) {
    if (ffmpegLogs.length >= 2) {
      const firstRun = ffmpegLogs[0];
      const secondRun = ffmpegLogs[1];
      if (firstRun.hasCrashed && !secondRun.hasCrashed) {
        findings.push({
          ruleId: 'CheckTranscoding2ndRun',
          category: 'Transcoding Decisions',
          title: 'Transcoding 2nd Run Software Fallback Succeeded',
          rootCause: `Initial transcode run (${firstRun.hwaccel}) crashed; Emby automatically launched a 2nd fallback run (${secondRun.hwaccel}).`,
          severity: 'Warning',
          confidence: 96,
          explanation: 'Emby Server detected an abnormal exit on the initial transcoding process and immediately re-spawned FFmpeg with fallback parameters.',
          evidence: [`Run 1 exit: ${firstRun.exitCode}`, `Run 2 exit: ${secondRun.exitCode}`],
          recommendations: [
            'Inspect the first run error to resolve underlying hardware transcoding crash.'
          ]
        });
      }
    }
  }

  // --- 35. CheckTranscodingSpeed ---
  static checkTranscodingSpeed(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      if (f.isSpeedBottleneck && f.avgSpeed !== null) {
        findings.push({
          ruleId: 'CheckTranscodingSpeed',
          category: 'Performance',
          title: `Transcoding Speed Bottleneck (${f.avgSpeed}x)`,
          rootCause: `Average transcoding speed was ${f.avgSpeed}x (min: ${f.minSpeed}x), which is below real-time playback speed (1.0x).`,
          severity: 'Error',
          confidence: 95,
          explanation: 'For smooth real-time playback, FFmpeg must process video faster than 1.0x. A speed below 1.0x causes immediate client buffer exhaustion and perpetual spinning wheel buffering.',
          evidence: [`Avg Speed: ${f.avgSpeed}x`, `Min Speed: ${f.minSpeed}x`],
          recommendations: [
            'Lower the transcoding preset (e.g. from VerySlow to Fast/VeryFast) in Transcoding settings.',
            'Enable Hardware Acceleration (NVENC/QuickSync/VAAPI) to relieve CPU pressure.'
          ]
        });
      }
    }
  }

  // --- 36. CheckFfmpegIsEmby ---
  static checkFfmpegIsEmby(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      if (f.ffmpegVersion && !f.isEmbyFfmpeg) {
        findings.push({
          ruleId: 'CheckFfmpegIsEmby',
          category: 'Environment',
          title: 'Stock FFmpeg Detected (Not Official Emby Custom Build)',
          rootCause: `Running stock FFmpeg binary (${f.ffmpegVersion}) without Emby custom patches.`,
          severity: 'Warning',
          confidence: 92,
          explanation: 'Emby requires a customized FFmpeg build maintained by softworkz with custom filtergraphs and low-latency HLS segmenters. Using system stock FFmpeg causes transcoding anomalies.',
          evidence: [`Version: ${f.ffmpegVersion}`],
          recommendations: [
            'Point Emby Transcoding settings to the bundled `/opt/emby-server/bin/ffmpeg` executable.'
          ]
        });
      }
    }
  }

  // --- 37. CheckFfmpegVersionBackground ---
  static checkFfmpegVersionBackground(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      if (f.ffmpegVersion) {
        findings.push({
          ruleId: 'CheckFfmpegVersionBackground',
          category: 'Environment',
          title: `FFmpeg Engine Version: ${f.ffmpegVersion}`,
          rootCause: `Validated FFmpeg binary version ${f.ffmpegVersion} (Custom Emby Build: ${f.isEmbyFfmpeg ? 'Yes' : 'No'}).`,
          severity: 'Info',
          confidence: 100,
          explanation: 'FFmpeg version and architecture validated from execution startup banner.',
          evidence: [`Version string: ${f.ffmpegVersion}`],
          recommendations: []
        });
      }
    }
  }

  // --- 38. CheckServerVersion ---
  static checkServerVersion(session, ctx, findings) {
    if (ctx.serverVersion) {
      findings.push({
        ruleId: 'CheckServerVersion',
        category: 'Environment',
        title: `Emby Server Version: ${ctx.serverVersion}`,
        rootCause: `Server is running Emby Server ${ctx.serverVersion} on ${ctx.operatingSystem || 'Linux'}.`,
        severity: 'Info',
        confidence: 100,
        explanation: 'Server version successfully extracted and validated from system log header.',
        evidence: [`Version: ${ctx.serverVersion}`],
        recommendations: []
      });
    }
  }

  // --- 39. CheckUserPolicy ---
  static checkUserPolicy(session, ffmpegLogs, findings) {
    for (const f of ffmpegLogs) {
      const pol = f.userPolicy;
      if (pol && pol.user) {
        if (pol.enableVideoPlaybackTranscoding === false) {
          findings.push({
            ruleId: 'CheckUserPolicy',
            category: 'User Policies',
            title: `Transcoding Forbidden by User Policy for "${pol.user}"`,
            rootCause: `User "${pol.user}" has EnableVideoPlaybackTranscoding set to False in Emby user settings.`,
            severity: 'Error',
            confidence: 98,
            explanation: 'The playback stream required transcoding, but the administrator policy expressly forbids transcoding for this account.',
            evidence: [`User policy for ${pol.user}: EnableVideoPlaybackTranscoding = False`],
            recommendations: [
              'In Emby Dashboard -> Users -> Profile, allow "Enable video playback that requires transcoding" if this user should be allowed to transcode.'
            ]
          });
        }
      }
    }
  }

  // --- 40. CheckParsedLineCount ---
  static checkParsedLineCount(session, ffmpegLogs, ctx, findings) {
    const totalLines = (ctx.parsedLineCount || 0) + ffmpegLogs.reduce((acc, f) => acc + (f.parsedLineCount || 0), 0);
    if (totalLines > 0) {
      findings.push({
        ruleId: 'CheckParsedLineCount',
        category: 'Metrics',
        title: `Diagnostic Log Metrics (${totalLines.toLocaleString()} Lines Evaluated)`,
        rootCause: `Deep model inspection completed across ${totalLines.toLocaleString()} log lines.`,
        severity: 'Info',
        confidence: 100,
        explanation: 'Parsed structured objects, streams, hardware devices, and timelines across all session files.',
        evidence: [`Total lines processed: ${totalLines}`],
        recommendations: []
      });
    }
  }
}

module.exports = CodedChecksEngine;
