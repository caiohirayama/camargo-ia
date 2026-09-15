const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');

test('valida a configuração da instância única Camargo no ambiente', (t) => {
  const original = {
    botPhoneNumber: env.botPhoneNumber,
    instanceName: env.instanceName,
    evolutionApiUrl: env.evolutionApiUrl,
    evolutionApiKey: env.evolutionApiKey,
    evolutionWebhookUrl: env.evolutionWebhookUrl,
    publicWebhookUrl: env.publicWebhookUrl,
    openaiApiKey: env.openaiApiKey,
    webhookSecret: env.webhookSecret,
    testApiKey: env.testApiKey,
    typingMinMs: env.typingMinMs,
    typingMaxMs: env.typingMaxMs,
  };
  t.after(() => Object.assign(env, original));

  Object.assign(env, {
    instanceName: 'camargo',
    botPhoneNumber: '5547999999999',
    evolutionApiUrl: 'https://evolution.example.com',
    evolutionApiKey: 'evolution-secret',
    evolutionWebhookUrl: 'https://app.example.com/webhook/evolution',
    openaiApiKey: 'openai-secret',
    webhookSecret: 'webhook-secret',
    testApiKey: 'test-secret',
    typingMinMs: 1000,
    typingMaxMs: 2000,
  });
  assert.equal(env.validateInstanceConfig(), true);

  env.evolutionApiKey = undefined;
  assert.throws(() => env.validateInstanceConfig(), /EVOLUTION_API_KEY/);

  env.evolutionApiKey = 'evolution-secret';
  env.instanceName = undefined;
  assert.throws(() => env.validateInstanceConfig(), /CAMARGO_INSTANCE_NAME/);
});
