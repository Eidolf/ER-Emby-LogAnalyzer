function redactSensitiveText(value) {
  return String(value)
    .replace(/([?&](?:api_key|access_token|token)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b(X-Emby-Token\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(Authorization\s*[:=]\s*(?:Bearer|MediaBrowser)\s+)[^\s,;]+/gi, '$1[redacted]');
}

module.exports = redactSensitiveText;
