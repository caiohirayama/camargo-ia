// Converte o webhook do WAHA (eventos message.any e session.status) para o
// mesmo formato que messageParser.parseIncomingPayload devolve para a
// Evolution API, assim o webhookController trata os dois provedores igual.
// JIDs "@c.us" do WAHA viram "@s.whatsapp.net" para casar com os clientes já
// gravados em Bot.Cliente.

function toAppJid(chatId) {
  const jid = String(chatId || '').trim();
  return jid ? jid.replace(/@c\.us$/, '@s.whatsapp.net') : null;
}

function getEventType(body) {
  const event = String(body?.event || '').trim().toLowerCase();
  if (event === 'session.status') {
    const status = String(body?.payload?.status || '').toUpperCase();
    if (status === 'WORKING') return 'connected';
    if (status === 'FAILED') return 'loggedout';
  }
  return event || null;
}

function getContentType(payload) {
  if (payload?.hasMedia) {
    const mime = String(payload.media?.mimetype || '');
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    return 'document';
  }
  if (payload?.location) return 'location';
  if (Array.isArray(payload?.vCards) && payload.vCards.length) return 'contact';
  if (typeof payload?.body === 'string' && payload.body.trim()) return 'text';
  return 'unknown';
}

function extractText(payload, contentType) {
  const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
  if (body && contentType !== 'location') return body;
  if (contentType === 'document' && payload.media?.filename) return String(payload.media.filename).trim();
  if (contentType === 'contact') return '[contato compartilhado]';
  if (contentType === 'location') {
    const { latitude, longitude } = payload.location || {};
    return latitude !== undefined && longitude !== undefined
      ? `[localização compartilhada: ${latitude}, ${longitude}]`
      : '[localização compartilhada]';
  }
  return body || null;
}

// pushName fica no _data cru, com formato diferente por engine
// (NOWEB: pushName, WEBJS: notifyName, GOWS: Info.PushName).
function extractSenderName(payload) {
  const raw = payload?._data || {};
  const names = [raw.pushName, raw.notifyName, raw.Info?.PushName];
  const name = names.find((value) => typeof value === 'string' && value.trim());
  return name ? name.trim() : 'Sem Nome';
}

function parseWahaPayload(body) {
  const payload = body?.payload || {};
  const fromMe = Boolean(payload.fromMe);
  // Em mensagem enviada pelo próprio número, "from" é o número da loja e o
  // chat do cliente está em "to".
  const chatId = fromMe ? payload.to : payload.from;
  const sender = toAppJid(chatId);
  const contentType = getContentType(payload);
  const isMessageEvent = String(body?.event || '').startsWith('message');

  return {
    instanceName: body?.session || null,
    sender: isMessageEvent ? sender : null,
    lidSender: sender?.endsWith('@lid') ? sender : null,
    fromMe,
    // source "api" = enviada por chamada à API (a própria IA), "app" = celular.
    sentByApi: fromMe && payload.source === 'api',
    isGroup: Boolean(chatId && (chatId.endsWith('@g.us') || chatId.endsWith('@broadcast'))),
    messageId: payload.id || null,
    // Sem texto, mídia, localização nem contato: evento de sistema do
    // WhatsApp; os ramos de protocolMessage do controller já o ignoram.
    message: contentType === 'unknown' ? { protocolMessage: true } : null,
    rawData: payload,
    contentType,
    content: extractText(payload, contentType),
    mediaUrl: payload.media?.url || null,
    senderName: extractSenderName(payload),
    isCtwa: false,
    ctwaSource: null,
    ctwaSourceId: null,
    eventType: getEventType(body),
    reason: payload.status || null,
  };
}

module.exports = {
  parseWahaPayload,
};
