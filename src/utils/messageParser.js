function getWebhookEventType(body) {
  const candidate = body?.event || body?.type;
  if (!candidate) return null;

  const event = String(candidate).trim().toLowerCase().replace(/_/g, '.');
  if (event === 'connection.update') {
    const state = String(body?.data?.state || '').toLowerCase();
    if (state === 'open') return 'connected';
    const statusReason = Number(
      body?.data?.statusReason ??
      body?.data?.lastDisconnect?.error?.output?.statusCode ??
      body?.data?.lastDisconnect?.error?.statusCode,
    );
    if (state === 'close' && statusReason === 401) return 'loggedout';
  }
  return event;
}

const MESSAGE_WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
];

function unwrapMessage(message) {
  let current = message;
  for (let depth = 0; depth < 5; depth += 1) {
    const wrapper = MESSAGE_WRAPPERS.find((key) => current?.[key]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

function getMessageObject(body) {
  return unwrapMessage(body?.data?.message || null);
}

function extractText(message) {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.conversation === 'string') return message.conversation.trim();
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text.trim();
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption.trim();
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption.trim();
  if (typeof message.documentMessage?.fileName === 'string') return message.documentMessage.fileName.trim();
  if (typeof message.interactiveMessage?.body?.text === 'string') return message.interactiveMessage.body.text.trim();
  if (typeof message.buttonsMessage?.contentText === 'string') return message.buttonsMessage.contentText.trim();
  if (message.contactMessage?.displayName) return `[contato compartilhado: ${message.contactMessage.displayName.trim()}]`;
  if (message.eventMessage) {
    const local = message.eventMessage.location?.name ? ` (${message.eventMessage.location.name})` : '';
    return `[evento criado: ${message.eventMessage.name || 'sem título'}${local}]`;
  }
  if (message.locationMessage) {
    const lat = message.locationMessage.degreesLatitude;
    const lng = message.locationMessage.degreesLongitude;
    return typeof lat === 'number' && typeof lng === 'number'
      ? `[localização compartilhada: ${lat}, ${lng}]`
      : '[localização compartilhada]';
  }
  return null;
}

function extractMediaUrl(message) {
  const media = message?.audioMessage || message?.imageMessage || message?.videoMessage ||
    message?.documentMessage || message?.stickerMessage;
  const url = media?.url || media?.URL;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function extractSenderName(data) {
  const names = [data?.pushName, data?.senderName, data?.notifyName, data?.verifiedBizName];
  const name = names.find((value) => typeof value === 'string' && value.trim());
  return name ? name.trim() : 'Sem Nome';
}

function getMessageContentType(message) {
  if (!message || typeof message !== 'object') return 'unknown';
  if (message.audioMessage || message.documentMessage?.mimetype?.startsWith('audio/')) return 'audio';
  if (message.imageMessage || message.documentMessage?.mimetype?.startsWith('image/') || message.stickerMessage) return 'image';
  if (message.videoMessage || message.documentMessage?.mimetype?.startsWith('video/')) return 'video';
  if (
    typeof message.conversation === 'string' ||
    typeof message.extendedTextMessage?.text === 'string' ||
    typeof message.imageMessage?.caption === 'string' ||
    typeof message.videoMessage?.caption === 'string' ||
    typeof message.interactiveMessage?.body?.text === 'string' ||
    typeof message.buttonsMessage?.contentText === 'string'
  ) return 'text';
  if (message.documentMessage) return 'document';
  if (message.eventMessage) return 'event';
  if (message.contactMessage) return 'contact';
  if (message.locationMessage) return 'location';
  return 'unknown';
}

function isPhoneJid(value) {
  return typeof value === 'string' && value.includes('@s.whatsapp.net');
}

function isLidJid(value) {
  return typeof value === 'string' && value.includes('@lid');
}

function isCtwaMessage(message) {
  const contextInfo = message?.extendedTextMessage?.contextInfo || {};
  return contextInfo.conversionSource === 'FB_Ads' || Boolean(contextInfo.externalAdReply);
}

function extractCtwaPhoneJid(message) {
  const text = message?.extendedTextMessage?.text || '';
  if (!isCtwaMessage(message)) return null;
  const match = text.match(/WhatsApp\s+number[:\s]+(\+?\d[\d\s\-().]{7,})/i);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  return digits.length >= 8 ? `${digits}@s.whatsapp.net` : null;
}

function extractCtwaName(message) {
  const text = message?.extendedTextMessage?.text || '';
  if (!isCtwaMessage(message)) return null;
  const match = text.match(/Full\s+name[:\s]+(.+)/i);
  return match ? match[1].trim() : null;
}

function parseIncomingPayload(body) {
  const data = body?.data || {};
  const key = data?.key || {};
  const message = getMessageObject(body);
  const fromMe = Boolean(key.fromMe);
  const candidates = [key.remoteJidAlt, key.remoteJid, key.participantAlt, key.participant].filter(Boolean);
  const phoneJid = candidates.find(isPhoneJid) || extractCtwaPhoneJid(message) || null;
  const lidJid = candidates.find(isLidJid) || null;
  const sender = phoneJid || key.remoteJid || key.participant || null;

  return {
    instanceName: body?.instance || null,
    sender,
    lidSender: lidJid,
    fromMe,
    isGroup: Boolean(key.remoteJid?.endsWith('@g.us')),
    messageId: key.id || null,
    message,
    rawData: data,
    contentType: getMessageContentType(message),
    content: extractText(message),
    mediaUrl: extractMediaUrl(message),
    senderName: extractCtwaName(message) || extractSenderName(data),
    isCtwa: isCtwaMessage(message),
    ctwaSource: message?.extendedTextMessage?.contextInfo?.externalAdReply?.sourceApp || null,
    ctwaSourceId: message?.extendedTextMessage?.contextInfo?.externalAdReply?.sourceID || null,
    eventType: getWebhookEventType(body),
    reason: data?.statusReason || data?.reason || data?.state || null,
  };
}

module.exports = {
  parseIncomingPayload,
};
