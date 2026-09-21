#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const LogAnalyzerEngine = require('../src/engine/index');

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
Emby Log Analyzer CLI (v1.0.0)
Usage: emby-log-analyzer [options] <log_files_or_directories...>

Options:
  -f, --format <format>   Output format: console, json, markdown, html (default: console)
  -o, --output <file>     Write report to file instead of stdout
  -c, --custom-kb <file>  Path to custom knowledge base rules JSON
  -v, --version           Display version
  -h, --help              Display this help message

Examples:
  node cli/cli.js /var/log/emby/embyserver.txt /var/log/emby/ffmpeg-transcode-*.txt
  node cli/cli.js -f html -o report.html ./test-datasets/03-failed-transcode-nvenc-driver-crash
`);
}

async function main() {
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let format = 'console';
  let outputFile = null;
  let customKbPath = null;
  const inputPaths = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-f' || arg === '--format') {
      format = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      outputFile = args[++i];
    } else if (arg === '-c' || arg === '--custom-kb') {
      customKbPath = args[++i];
    } else if (arg === '-v' || arg === '--version') {
      console.log('1.0.0');
      process.exit(0);
    } else {
      inputPaths.push(arg);
    }
  }

  // Resolve directory contents recursively if directories are passed
  const resolvedFiles = [];
  for (const p of inputPaths) {
    if (!fs.existsSync(p)) {
      console.error(`Warning: Path does not exist: ${p}`);
      continue;
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      const dirFiles = fs.readdirSync(p).map(f => path.join(p, f)).filter(f => fs.statSync(f).isFile());
      resolvedFiles.push(...dirFiles);
    } else {
      resolvedFiles.push(p);
    }
  }

  if (resolvedFiles.length === 0) {
    console.error('Error: No valid log files found to analyze.');
    process.exit(1);
  }

  const engine = new LogAnalyzerEngine({ customRulesPath: customKbPath });
  const result = await engine.analyzeFiles(resolvedFiles);

  if (format === 'json') {
    const output = engine.exportReport(result, 'json');
    writeOutput(output, outputFile);
  } else if (format === 'markdown' || format === 'md') {
    const output = engine.exportReport(result, 'markdown');
    writeOutput(output, outputFile);
  } else if (format === 'html') {
    const output = engine.exportReport(result, 'html');
    writeOutput(output, outputFile);
  } else {
    // Console output
    console.log('\n========================================');
    console.log('  EMBY LOG ANALYZER - DIAGNOSTIC REPORT ');
    console.log('========================================\n');
    console.log(`Server Fleet Health : ${result.overallHealth.toUpperCase()}`);
    console.log(`Total Sessions      : ${result.metrics.totalSessions}`);
    console.log(`Successful Streams  : ${result.metrics.successCount}`);
    console.log(`Warnings            : ${result.metrics.warningCount}`);
    console.log(`Errors / Crashes    : ${result.metrics.errorCount + result.metrics.criticalCount}\n`);

    for (const s of result.sessions) {
      console.log(`----------------------------------------`);
      console.log(`Session: ${s.mediaItem} [${s.overallStatus}]`);
      console.log(`User: ${s.user} | Device: ${s.clientDevice} | Method: ${s.playMethod}`);
      if (s.primaryRootCause) {
        console.log(`Root Cause   : ${s.primaryRootCause.title} (${s.primaryRootCause.confidence}% confidence)`);
        console.log(`Diagnosis    : ${s.primaryRootCause.cause}`);
        if (s.primaryRootCause.recommendations && s.primaryRootCause.recommendations.length > 0) {
          console.log(`Remediation  : ${s.primaryRootCause.recommendations[0]}`);
        }
      }
    }
    console.log(`----------------------------------------\n`);
  }
}

function writeOutput(content, targetFile) {
  if (targetFile) {
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log(`Report successfully written to: ${targetFile}`);
  } else {
    console.log(content);
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
