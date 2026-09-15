const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const env = require('../config/env');
const { flowPrefix } = require('../utils/logContext');

let client;

function getR2Configuration() {
  const values = {
    accountId: env.r2AccountId?.trim(),
    accessKeyId: env.r2AccessKeyId?.trim(),
    secretAccessKey: env.r2SecretAccessKey?.trim(),
    bucket: env.r2Bucket?.trim(),
    publicBaseUrl: env.r2PublicBaseUrl?.trim(),
    maxBytes: env.mediaMaxBytes,
  };
  const missing = Object.entries(values)
    .filter(([name, value]) => name !== 'maxBytes' && !value)
    .map(([name]) => name);

  if (missing.length) throw new Error(`configuração Cloudflare R2 incompleta: ${missing.join(', ')}`);
  if (!/^[a-f0-9]{32}$/i.test(values.accountId)) {
    throw new Error('R2_ACCOUNT_ID deve conter os 32 caracteres hexadecimais da conta');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket)) {
    throw new Error('R2_BUCKET possui um nome inválido');
  }
  if (!Number.isSafeInteger(values.maxBytes) || values.maxBytes <= 0) {
    throw new Error('MEDIA_MAX_BYTES deve ser um inteiro positivo');
  }

  let publicUrl;
  try {
    publicUrl = new URL(values.publicBaseUrl);
  } catch {
    throw new Error('R2_PUBLIC_BASE_URL inválida');
  }
  if (
    publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
    publicUrl.search || publicUrl.hash || (publicUrl.pathname && publicUrl.pathname !== '/')
  ) {
    throw new Error('R2_PUBLIC_BASE_URL deve ser uma origem HTTPS sem credenciais, caminho, query ou fragmento');
  }

  values.publicBaseUrl = publicUrl.origin;
  return values;
}

function assertR2Configured() {
  getR2Configuration();
  return true;
}

async function checkR2Connection() {
  const configuration = getR2Configuration();
  await getClient(configuration).send(new HeadBucketCommand({ Bucket: configuration.bucket }));
  return true;
}

function getClient(configuration) {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
  }
  return client;
}

function normalizeMimeType(mimeType) {
  const value = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (value.length > 100) return 'application/octet-stream';
  if (/^(image\/(?:jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(value)) return value;
  if (/^application\/(?:pdf|zip|msword|vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+)$/.test(value)) return value;
  if (value === 'text/plain') return value;
  return 'application/octet-stream';
}

function extensionFromMimeType(mimeType) {
  const known = {
    'application/octet-stream': 'bin',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/msword': 'doc',
    'image/jpeg': 'jpg',
    'text/plain': 'txt',
  };
  if (known[mimeType]) return known[mimeType];
  return mimeType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
}

function decodeBase64(base64, maxBytes) {
  if (typeof base64 !== 'string' || !base64 || base64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('mídia recebida não contém base64 válido');
  }
  if (Math.floor((base64.length * 3) / 4) > maxBytes + 2) {
    throw new Error(`mídia excede o limite de ${maxBytes} bytes`);
  }
  const body = Buffer.from(base64, 'base64');
  if (!body.length || body.length > maxBytes) {
    throw new Error(`mídia vazia ou acima do limite de ${maxBytes} bytes`);
  }
  return body;
}

function buildPublicUrl(key, publicBaseUrl) {
  const encodedKey = String(key).split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/${encodedKey}`;
}

function buildObjectKey({ mimeType, now = new Date(), id = crypto.randomUUID() }) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `whatsapp-media/${year}/${month}/${day}/${id}.${extensionFromMimeType(mimeType)}`;
}

async function putMediaObject({ base64, mimeType }, { storageClient, bucket, publicBaseUrl, maxBytes }) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const body = decodeBase64(base64, maxBytes);
  const key = buildObjectKey({ mimeType: normalizedMimeType });
  await storageClient.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: normalizedMimeType,
    ContentDisposition: 'attachment',
  }));
  return buildPublicUrl(key, publicBaseUrl);
}

async function uploadMedia({ base64, mimeType, messageId = null }) {
  const configuration = getR2Configuration();
  const startedAt = Date.now();
  const estimatedBytes = Math.floor((String(base64 || '').length * 3) / 4);
  const prefix = flowPrefix(messageId);
  console.log(`${prefix} [r2] iniciando upload | mime=${normalizeMimeType(mimeType)} | bytesAproximados=${estimatedBytes}`);
  const publicUrl = await putMediaObject(
    { base64, mimeType },
    {
      storageClient: getClient(configuration),
      bucket: configuration.bucket,
      publicBaseUrl: configuration.publicBaseUrl,
      maxBytes: configuration.maxBytes,
    },
  );
  console.log(`${prefix} [r2] upload concluído | duraçãoMs=${Date.now() - startedAt}`);
  return publicUrl;
}

module.exports = {
  uploadMedia,
  assertR2Configured,
  checkR2Connection,
  buildPublicUrl,
  buildObjectKey,
  normalizeMimeType,
  putMediaObject,
};
