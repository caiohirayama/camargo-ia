const express = require('express');
const routes = require('./routes');
const env = require('./config/env');
const morgan = require('morgan');
const { checkDatabaseConnection } = require('./services/databaseService');
const { checkR2Connection } = require('./services/r2Service');
const { sanitizeRequestUrl, errorSummary } = require('./utils/logContext');

const app = express();

morgan.token('safe-url', (req) => sanitizeRequestUrl(req.originalUrl || req.url));
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
app.use(routes);

app.use((error, req, res, next) => {
  console.error('[server] erro não tratado:', errorSummary(error));
  res.status(500).json({ ok: false, error: 'Erro interno' });
});

async function start() {
  try {
    console.log(`[startup] iniciando Camargo Atacarejo de Bebidas | instância=${env.instanceName || 'não configurada'} | porta=${env.port}`);
    console.log('[startup] validando variáveis de ambiente...');
    env.validateInstanceConfig();
    console.log('[startup] configuração da instância: ok');
    console.log('[startup] verificando Cloudflare R2...');
    await checkR2Connection();
    console.log('[startup] Cloudflare R2: ok');
    console.log('[startup] verificando PostgreSQL e permissões...');
    await checkDatabaseConnection();
    console.log('[startup] PostgreSQL: ok');
    app.listen(env.port, () => {
      console.log(`[startup] servidor pronto em http://localhost:${env.port}`);
    });
  } catch (error) {
    console.error('[startup] configuração ou dependência indisponível:', errorSummary(error));
    process.exit(1);
  }
}

start();
