const axios = require('axios');
const env = require('../config/env');
const customerService = require('./customerService');
const { flowPrefix, maskJid, shortId, errorSummary } = require('../utils/logContext');

// Mesma interface do evolutionService (sendText, sendNotificationText,
// setWebhook, downloadMedia, wasSentByAi), falando o contrato do WAHA
// (WhatsApp HTTP API): auth por X-Api-Key, sessão no corpo/rota e chatId
// no formato "<número>@c.us". O resto da aplicação guarda o JID no formato
// "@s.whatsapp.net" (o mesmo da Evolution), então a conversão fica só aqui
// e no wahaParser.

const DEFAULT_TYPING_MIN_MS = 2500;
const DEFAULT_TYPING_MAX_MS = 9000;
const DEFAULT_TYPING_PER_CHAR_MS = 140;
const FAST_TYPING_MIN_MS = 2000;
const FAST_TYPING_MAX_MS = 3000;
const SENT_BY_AI_TTL_MS = 30000;
const sentByAi = new Map();

function toChatId(remoteJid) {
  const jid = String(remoteJid || '').trim();
  if (!jid) return null;
  if (jid.endsWith('@lid') || jid.endsWith('@g.us') || jid.endsWith('@c.us')) return jid;
  return `${jid.replace(/@s\.whatsapp\.net$/, '')}@c.us`;
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
  if (!env.wahaApiUrl || !env.wahaApiKey) {
    throw new Error('WAHA_API_URL e WAHA_API_KEY são obrigatórios no ambiente.');
  }
  return axios.create({
    baseURL: env.wahaApiUrl,
    headers: { 'X-Api-Key': env.wahaApiKey, 'Content-Type': 'application/json' },
    timeout: 60000,
  });
}

// O WAHA devolve o id como string ("true_<chat>_<id>") ou, em alguns engines,
// como objeto { _serialized }; o eco no webhook usa o mesmo formato serializado.
function extractMessageId(data) {
  const id = data?.id;
  if (typeof id === 'string') return id;
  return id?._serialized || data?.key?.id || null;
}

// O WAHA já baixa a mídia e manda no webhook só a URL do próprio servidor
// (/api/files/...), que exige X-Api-Key. A chave só vai para o host do
// WAHA_API_URL: a URL do payload pode vir com o domínio público
// (WAHA_BASE_URL), então só o caminho é aproveitado.
async function downloadMedia(instanceName, messageData) {
  const media = messageData?.media;
  if (!messageData?.hasMedia || !media?.url) return null;
  getInstanceName(instanceName);
  const prefix = flowPrefix(messageData.id);

  let filePath;
  try {
    const parsed = new URL(media.url, env.wahaApiUrl);
    filePath = parsed.pathname;
  } catch (_) {
    return null;
  }
  if (!filePath.startsWith('/api/files/')) {
    console.warn(`${prefix} [waha] URL de mídia fora de /api/files ignorada`);
    return null;
  }

  console.log(`${prefix} [waha] solicitando mídia`);
  const response = await buildClient().get(filePath, {
    responseType: 'arraybuffer',
    maxContentLength: env.mediaMaxBytes,
  });
  const buffer = Buffer.from(response.data || []);
  const mimeType = media.mimetype || response.headers?.['content-type'] || 'application/octet-stream';
  console.log(`${prefix} [waha] mídia ${buffer.length ? 'recebida' : 'não encontrada'} | mime=${mimeType}`);
  return buffer.length ? { base64: buffer.toString('base64'), mimeType } : null;
}

async function sendText({ instanceName, remoteJid, text, fast = false, correlationId = null }) {
  const chatId = toChatId(remoteJid);
  if (!chatId || !text) return;
  const session = getInstanceName(instanceName);
  const target = maskJid(remoteJid);
  const prefix = flowPrefix(correlationId);

  const client = buildClient();
  const typingDelayMs = fast
    ? randomBetween(FAST_TYPING_MIN_MS, FAST_TYPING_MAX_MS)
    : calculateTypingDelayMs(text);
  try {
    console.log(`${prefix} [waha] presença composing | destino=${target} | delayMs=${typingDelayMs}`);
    await client.post('/api/startTyping', { session, chatId });
    await new Promise((resolve) => setTimeout(resolve, typingDelayMs));
  } catch (error) {
    console.warn(`${prefix} [waha] presença de digitação indisponível:`, errorSummary(error));
  }
  console.log(`${prefix} [waha] enviando texto | destino=${target} | caracteres=${String(text).length}`);
  const response = await client.post('/api/sendText', { session, chatId, text, linkPreview: true });
  const mensagemId = extractMessageId(response?.data);
  console.log(`${prefix} [waha] texto enviado | destino=${target} | outgoingId=${shortId(mensagemId)}`);
  registerSentByAi(session, mensagemId);
  try {
    await customerService.saveOutgoingMessage({ instanceName: session, sender: remoteJid, mensagemId, mensagem: text });
  } catch (error) {
    console.error(`${prefix} [postgres] falha ao salvar mensagem enviada:`, errorSummary(error));
  }
}

// Aviso interno para o grupo da equipe: sem digitação e sem gravar em
// Bot.Mensagens (mesmo comportamento do evolutionService).
async function sendNotificationText({ remoteJid, text }) {
  const chatId = toChatId(remoteJid);
  if (!chatId || !text) return null;
  const session = getInstanceName();
  const response = await buildClient().post('/api/sendText', { session, chatId, text, linkPreview: false });
  return extractMessageId(response?.data);
}

// "123@lid" -> "5547999999999@s.whatsapp.net", ou null se o WAHA não souber.
async function resolveLid(lid) {
  const session = getInstanceName();
  const response = await buildClient().get(
    `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
  );
  const value = response?.data?.pn || response?.data?.phoneNumber;
  const digits = String(value || '').split('@')[0].replace(/\D/g, '');
  return digits.length >= 8 ? `${digits}@s.whatsapp.net` : null;
}

// PUT /api/sessions/{session} substitui a config inteira (e reinicia a
// sessão), então lê a config atual e troca só os webhooks. O segredo vai por
// header (x-webhook-secret), não na URL.
async function setWebhook(instanceName) {
  const session = getInstanceName(instanceName);
  const webhookTarget = env.wahaWebhookUrl || env.publicWebhookUrl;
  if (!webhookTarget) throw new Error('WAHA_WEBHOOK_URL ou PUBLIC_WEBHOOK_URL é obrigatório no ambiente.');

  const client = buildClient();
  const current = await client.get(`/api/sessions/${encodeURIComponent(session)}`);
  const config = current?.data?.config || {};
  const webhook = {
    url: webhookTarget,
    events: ['message.any', 'session.status'],
    retries: { policy: 'constant', delaySeconds: 2, attempts: 5 },
  };
  if (env.webhookSecret) webhook.customHeaders = [{ name: 'X-Webhook-Secret', value: env.webhookSecret }];

  // Grupos, status, canais e listas de transmissão nem viram evento (o app já
  // os ignora); o envio para o grupo de avisos da equipe não é afetado.
  return client.put(`/api/sessions/${encodeURIComponent(session)}`, {
    name: session,
    config: {
      ...config,
      ignore: { status: true, groups: true, channels: true, broadcast: true },
      webhooks: [webhook],
    },
  });
}

module.exports = {
  sendText,
  sendNotificationText,
  setWebhook,
  downloadMedia,
  wasSentByAi,
  resolveLid,
};
