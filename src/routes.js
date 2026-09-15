const express = require('express');
const crypto = require('crypto');
const webhookController = require('./controllers/webhookController');
const testController = require('./controllers/testController');
const env = require('./config/env');
const { checkDatabaseConnection } = require('./services/databaseService');
const { checkR2Connection } = require('./services/r2Service');

const router = express.Router();

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function requireSecret({ getProvided, getExpected, label }) {
  return (req, res, next) => {
    const expected = getExpected();
    if (!expected) {
      return res.status(503).json({ ok: false, error: `${label} não configurado.` });
    }

    if (!secretsMatch(getProvided(req), expected)) {
      return res.status(401).json({ ok: false, error: 'Não autorizado.' });
    }

    return next();
  };
}

const requireWebhookSecret = requireSecret({
  getProvided: (req) => req.get('x-webhook-secret') || req.query.token,
  getExpected: () => env.webhookSecret,
  label: 'WEBHOOK_SECRET',
});

const requireTestApiKey = requireSecret({
  getProvided: (req) => req.get('x-api-key'),
  getExpected: () => env.testApiKey,
  label: 'TEST_API_KEY',
});

router.get('/health', async (req, res) => {
  try {
    env.validateInstanceConfig();
    await checkR2Connection();
    await checkDatabaseConnection();
    res.status(200).json({ status: 'ok', database: 'ok', storage: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'unavailable' });
  }
});

router.post(
  '/webhook/evolution',
  requireWebhookSecret,
  express.json({ limit: '2mb' }),
  webhookController.handleEvolutionWebhook,
);
router.use('/test', requireTestApiKey);
router.use('/test', express.json({ limit: '2mb' }));
router.post('/test/set-webhook', testController.setWebhook);
router.post('/test/send-test', testController.sendTest);
router.get('/test/rag/status', testController.getRagStatus);
router.post('/test/rag/search', testController.searchRag);

module.exports = router;
