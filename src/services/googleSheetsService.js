const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');

// Leitura de planilha via conta de serviço do Google (fluxo OAuth "JWT
// bearer"): assina um JWT com a chave privada da conta e troca por um access
// token. Feito com o crypto do Node para não puxar o SDK inteiro do Google só
// para um GET de valores. A planilha precisa estar compartilhada (leitura)
// com o e-mail da conta de serviço.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

let tokenCache = { accessToken: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(env.googleServiceAccountEmail && env.googleServiceAccountPrivateKey);
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const agora = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: env.googleServiceAccountEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: agora,
    exp: agora + 3600,
  }));
  const assinatura = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), env.googleServiceAccountPrivateKey);
  const assertion = `${header}.${claims}.${base64url(assinatura)}`;

  const response = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 },
  );

  const expiresIn = Number(response.data?.expires_in) || 3600;
  tokenCache = {
    accessToken: response.data?.access_token,
    // Renova um minuto antes de expirar.
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
  return tokenCache.accessToken;
}

// Retorna as linhas como texto formatado (como aparecem na planilha, ex:
// datas "29/09/2026"), incluindo a linha de cabeçalho.
async function getValues(sheetId, range) {
  const accessToken = await getAccessToken();
  const response = await axios.get(`${SHEETS_API_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8000,
  });
  return Array.isArray(response.data?.values) ? response.data.values : [];
}

module.exports = {
  isConfigured,
  getValues,
};
