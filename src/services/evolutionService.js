const axios = require('axios');
const env = require('../config/env');
const customerService = require('./customerService');
const { flowPrefix, maskJid, shortId, errorSummary } = require('../utils/logContext');

const DEFAULT_TYPING_MIN_MS = 2500;
const DEFAULT_TYPING_MAX_MS = 9000;
const DEFAULT_TYPING_PER_CHAR_MS = 140;
const FAST_TYPING_MIN_MS = 2000;
const FAST_TYPING_MAX_MS = 3000;
const SENT_BY_AI_TTL_MS = 30000;
const sentByAi = new Map();

function jidToNumber(remoteJid) {
  const jid = String(remoteJid || '').trim();
  if (jid.endsWith('@lid') || jid.endsWith('@g.us')) return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

function sentByAiKey(instanceName, messageId) {
  return `${instanceName}::${messageId}`;
}

function registerSentByAi(instanceName, messageId) {
  if (messageId) sentByAi.set(sentByAiKey(instanceName, messageId), Date.now() + SENT_BY_AI_TTL_MS);
}

function wasSentByAi({ instanceName, messageId }) {
  if (!instanceName || !messageId) return false;
  const key = sentByAiKey(instanceName, messageId);
  const expiresAt = sentByAi.get(key);
  if (!expiresAt) return false;
  sentByAi.delete(key);
  return expiresAt > Date.now();
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateTypingDelayMs(text) {
  const minMs = Number(env.typingMinMs) || DEFAULT_TYPING_MIN_MS;
  const maxMs = Number(env.typingMaxMs) || DEFAULT_TYPING_MAX_MS;
  const perCharMs = Number(env.typingPerCharMs) || DEFAULT_TYPING_PER_CHAR_MS;
  const byTextLength = String(text || '').length * perCharMs;
  return Math.max(minMs, Math.min(maxMs, byTextLength));
}

function getInstanceName(instanceName) {
  const configured = env.instanceName;
  if (instanceName && instanceName !== configured) {
    throw new Error(`Instância não autorizada: ${instanceName}. Esta aplicação atende somente ${configured}.`);
  }
  return configured;
}

function buildClient() {
  if (!env.evolutionApiUrl || !env.evolutionApiKey) {
    throw new Error('EVOLUTION_API_URL e EVOLUTION_API_KEY são obrigatórios no ambiente.');
  }
  return axios.create({
    baseURL: env.evolutionApiUrl,
    headers: { apikey: env.evolutionApiKey, 'Content-Type': 'application/json' },
    timeout: 60000,
  });
}

function getMediaMimeType(message) {
  const media = message?.audioMessage || message?.imageMessage || message?.videoMessage ||
    message?.documentMessage || message?.stickerMessage;
  return media?.mimetype || 'application/octet-stream';
}

function normalizeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/^data:[^;]+;base64,/, '');
}

async function downloadMedia(instanceName, messageData) {
  if (!messageData?.key || !messageData?.message) return null;
  const configuredInstance = getInstanceName(instanceName);
  const prefix = flowPrefix(messageData.key.id);

  const mimeType = getMediaMimeType(messageData.message);
  const inlineBase64 = normalizeBase64(messageData.base64 || messageData.message?.base64);
  if (inlineBase64) return { base64: inlineBase64, mimeType };

  const client = buildClient();
  console.log(`${prefix} [evolution] solicitando mídia | instância=${configuredInstance}`);
  const response = await client.post(
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(configuredInstance)}`,
    { message: messageData, convertToMp4: false },
  );
  const payload = response?.data?.data || response?.data || {};
  const base64 = normalizeBase64(payload.base64);
  console.log(`${prefix} [evolution] mídia ${base64 ? 'recebida' : 'não encontrada'} | mime=${payload.mimetype || mimeType}`);
  return base64 ? { base64, mimeType: payload.mimetype || mimeType } : null;
}

async function sendTypingPresence({ client, instanceName, number, delay }) {
  await client.post(`/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
    number,
    delay: Math.min(delay, 20000),
    presence: 'composing',
  });
}

async function sendText({ instanceName, remoteJid, text, fast = false, correlationId = null }) {
  const number = jidToNumber(remoteJid);
  if (!number || !text) return;
  const configuredInstance = getInstanceName(instanceName);
  const target = maskJid(remoteJid);
  const prefix = flowPrefix(correlationId);

  const client = buildClient();
  const typingDelayMs = fast
    ? randomBetween(FAST_TYPING_MIN_MS, FAST_TYPING_MAX_MS)
    : calculateTypingDelayMs(text);
  try {
    console.log(`${prefix} [evolution] presença composing | destino=${target} | delayMs=${typingDelayMs}`);
    await sendTypingPresence({ client, instanceName: configuredInstance, number, delay: typingDelayMs });
  } catch (error) {
    console.warn(`${prefix} [evolution] presença de digitação indisponível:`, errorSummary(error));
  }
  console.log(`${prefix} [evolution] enviando texto | destino=${target} | caracteres=${String(text).length}`);
  const response = await client.post(`/message/sendText/${encodeURIComponent(configuredInstance)}`, {
    number,
    text,
    delay: 0,
    linkPreview: true,
  });
  const mensagemId = response?.data?.key?.id || null;
  console.log(`${prefix} [evolution] texto enviado | destino=${target} | outgoingId=${shortId(mensagemId)}`);
  registerSentByAi(configuredInstance, mensagemId);
  try {
    await customerService.saveOutgoingMessage({ instanceName: configuredInstance, sender: remoteJid, mensagemId, mensagem: text });
  } catch (error) {
    console.error(`${prefix} [postgres] falha ao salvar mensagem enviada:`, errorSummary(error));
  }
}

async function getContacts(instanceName) {
  const configuredInstance = getInstanceName(instanceName);
  const client = buildClient();
  const response = await client.post(`/chat/findContacts/${encodeURIComponent(configuredInstance)}`, {
    where: {},
    take: 10000,
  });
  return Array.isArray(response?.data) ? response.data : response?.data?.data || [];
}

async function setWebhook(instanceName) {
  const configuredInstance = getInstanceName(instanceName);
  const webhookTarget = env.evolutionWebhookUrl || env.publicWebhookUrl;
  if (!webhookTarget) throw new Error('EVOLUTION_WEBHOOK_URL ou PUBLIC_WEBHOOK_URL é obrigatório no ambiente.');

  const webhookUrl = new URL(webhookTarget);
  if (env.webhookSecret) webhookUrl.searchParams.set('token', env.webhookSecret);
  return buildClient().post(`/webhook/set/${encodeURIComponent(configuredInstance)}`, {
    webhook: {
      enabled: true,
      url: webhookUrl.toString(),
      byEvents: false,
      base64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    },
  });
}

module.exports = {
  sendText,
  setWebhook,
  downloadMedia,
  wasSentByAi,
  getContacts,
};
