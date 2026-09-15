function shortId(value) {
  const normalized = String(value || 'sem-id');
  return normalized.length > 12 ? normalized.slice(-12) : normalized;
}

function maskJid(value) {
  const normalized = String(value || 'desconhecido');
  const [identifier, domain] = normalized.split('@');
  if (!domain) return normalized.length > 6 ? `${normalized.slice(0, 3)}***${normalized.slice(-2)}` : '***';
  const visible = identifier.length > 6
    ? `${identifier.slice(0, 3)}***${identifier.slice(-2)}`
    : `${identifier.slice(0, 1)}***`;
  return `${visible}@${domain}`;
}

function flowPrefix(messageId) {
  return `[fluxo:${shortId(messageId)}]`;
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/([?&](?:token|key|apikey|secret)=)[^&\s]*/gi, '$1[redacted]')
    .replace(/(\b(?:token|key|apikey|secret)\b\s*[:=]\s*)[^,;&\s}]*/gi, '$1[redacted]');
}

function sanitizeRequestUrl(value) {
  return redactSecrets(value || '/');
}

function errorSummary(error) {
  const message = redactSecrets(error?.message || 'erro desconhecido').slice(0, 500);
  return {
    message,
    ...(error?.response?.status ? { status: error.response.status } : {}),
    ...(error?.code ? { code: String(error.code).slice(0, 80) } : {}),
  };
}

module.exports = {
  shortId,
  maskJid,
  flowPrefix,
  sanitizeRequestUrl,
  errorSummary,
};
