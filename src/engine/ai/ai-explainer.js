/**
 * Local Privacy-First AI explanation layer.
 * Synthesizes technical indicators, timeline sequences, and confidence metrics
 * into conversational administrator briefings without sending data externally.
 */
class AIExplainer {
  /**
   * Generates a conversational executive explanation for an Emby administrator.
   * @param {object} analysisReport Single session report or batch report
   * @returns {string} Plain-language administrator briefing
   */
  static generateExplanation(analysisReport) {
    if (!analysisReport) return 'No diagnostic data available to explain.';

    // If it's a single session
    if (analysisReport.primaryRootCause) {
      const { overallStatus, primaryRootCause, mediaItem, user, clientDevice, playMethod } = analysisReport;

      if (overallStatus === 'Success') {
        return `Playback of "${mediaItem || 'media'}" by user ${user || 'Admin'} on ${clientDevice || 'the client'} was completed without any disruptions using ${playMethod}. FFmpeg and Emby Server logs confirm that streams opened and closed cleanly.`;
      }

      const conf = primaryRootCause.confidence || 90;
      let summary = `### Diagnostic Summary (${conf}% Confidence)\n\n`;
      summary += `The playback session for **"${mediaItem || 'Unknown Media'}"** (User: \`${user || 'N/A'}\`, Client: \`${clientDevice || 'N/A'}\`) encountered an issue categorized under **${primaryRootCause.category}**.\n\n`;
      summary += `**What Happened?**\n${primaryRootCause.cause}\n\n`;
      summary += `**Detailed Explanation:**\n${primaryRootCause.explanation}\n\n`;

      if (primaryRootCause.evidence && primaryRootCause.evidence.length > 0) {
        summary += `**Key Evidence Extracted:**\n`;
        for (const ev of primaryRootCause.evidence.slice(0, 3)) {
          summary += `- \`${ev.replace(/`/g, "'")}\`\n`;
        }
        summary += `\n`;
      }

      if (primaryRootCause.recommendations && primaryRootCause.recommendations.length > 0) {
        summary += `**Recommended Action Steps:**\n`;
        for (const rec of primaryRootCause.recommendations) {
          summary += `1. ${rec}\n`;
        }
      }

      return summary;
    }

    // If it's a batch report
    const { metrics, overallHealth } = analysisReport;
    return `### Server Fleet Log Analysis Overview\n` +
      `- Overall Health State: **${overallHealth}**\n` +
      `- Total Playback Sessions: **${metrics.totalSessions}**\n` +
      `- Successful Streams: **${metrics.successCount}**\n` +
      `- Warnings (e.g. Disconnects/Timeouts): **${metrics.warningCount}**\n` +
      `- Errors / Hardware Crashes: **${metrics.errorCount + metrics.criticalCount}**\n\n` +
      `Review individual session tabs below to inspect root-cause chains and actionable troubleshooting advice.`;
  }
}

module.exports = AIExplainer;
