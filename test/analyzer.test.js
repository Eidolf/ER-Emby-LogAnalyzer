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
});
