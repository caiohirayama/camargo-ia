const dotenv = require('dotenv');

dotenv.config({ quiet: true });

function envNumber(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : Number(value);
}

const env = {
  port: Number(process.env.PORT) || 3001,
  instanceName: process.env.CAMARGO_INSTANCE_NAME,
  botPhoneNumber: process.env.CAMARGO_PHONE_NUMBER,
  evolutionApiUrl: process.env.EVOLUTION_API_URL,
  evolutionApiKey: process.env.EVOLUTION_API_KEY,
  evolutionWebhookUrl: process.env.EVOLUTION_WEBHOOK_URL,
  aiModel: process.env.AI_MODEL || 'gpt-5-mini',
  aiBaseUrl: process.env.AI_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
  typingMinMs: envNumber('TYPING_MIN_MS', 2500),
  typingMaxMs: envNumber('TYPING_MAX_MS', 9000),
  typingPerCharMs: envNumber('TYPING_PER_CHAR_MS', 140),
  openaiAudioModel: process.env.OPENAI_AUDIO_MODEL || 'gpt-4o-transcribe',
  openaiVisionModel: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
  ragEnabled: String(process.env.RAG_ENABLED || 'true').toLowerCase() === 'true',
  ragKnowledgeDir: process.env.RAG_KNOWLEDGE_DIR,
  ragTopK: Number(process.env.RAG_TOP_K) || 4,
  ragMinScore: Number(process.env.RAG_MIN_SCORE) || 1.25,
  databaseUrl: process.env.DATABASE_URL,
  postgresHost: process.env.POSTGRES_HOST,
  postgresPort: Number(process.env.POSTGRES_PORT) || 5432,
  postgresDatabase: process.env.POSTGRES_DATABASE,
  postgresUser: process.env.POSTGRES_USER,
  postgresPassword: process.env.POSTGRES_PASSWORD,
  postgresSsl: String(process.env.POSTGRES_SSL || 'false').toLowerCase() === 'true',
  postgresSslRejectUnauthorized:
    String(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true',
  postgresSslCa: process.env.POSTGRES_SSL_CA?.replace(/\\n/g, '\n'),
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL,
  webhookSecret: process.env.WEBHOOK_SECRET,
  testApiKey: process.env.TEST_API_KEY,
  messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS) || 25000,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2Bucket: process.env.R2_BUCKET,
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES) || 25 * 1024 * 1024,
  testModeAllowedNumber: process.env.TEST_MODE_ALLOWED_NUMBER || null,
  gestaoClickAccessToken: process.env.GESTAOCLICK_ACCESS_TOKEN || null,
  gestaoClickSecretToken: process.env.GESTAOCLICK_SECRET_TOKEN || null,
};

function validateUrl(name, value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocolo inválido');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('credenciais, query e fragmento não são permitidos');
    }
  } catch (_) {
    throw new Error(`${name} deve ser uma URL HTTP(S) válida, sem credenciais, query ou fragmento.`);
  }
}

env.validateInstanceConfig = function validateInstanceConfig() {
  const required = {
    CAMARGO_INSTANCE_NAME: env.instanceName,
    CAMARGO_PHONE_NUMBER: env.botPhoneNumber,
    EVOLUTION_API_URL: env.evolutionApiUrl,
    EVOLUTION_API_KEY: env.evolutionApiKey,
    OPENAI_API_KEY: env.openaiApiKey,
    WEBHOOK_SECRET: env.webhookSecret,
    TEST_API_KEY: env.testApiKey,
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  if (!env.evolutionWebhookUrl && !env.publicWebhookUrl) missing.push('EVOLUTION_WEBHOOK_URL');
  if (missing.length) throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}.`);

  validateUrl('EVOLUTION_API_URL', env.evolutionApiUrl);
  validateUrl('EVOLUTION_WEBHOOK_URL', env.evolutionWebhookUrl || env.publicWebhookUrl);
  if (env.aiBaseUrl) validateUrl('AI_BASE_URL', env.aiBaseUrl);
  const typingValues = [env.typingMinMs, env.typingMaxMs, env.typingPerCharMs];
  if (typingValues.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('TYPING_MIN_MS, TYPING_MAX_MS e TYPING_PER_CHAR_MS devem ser números positivos.');
  }
  if (env.typingMaxMs < env.typingMinMs) {
    throw new Error('TYPING_MAX_MS deve ser maior ou igual a TYPING_MIN_MS.');
  }
  return true;
};

module.exports = env;
