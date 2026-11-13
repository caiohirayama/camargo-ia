const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const customerService = require('../src/services/customerService');
const env = require('../src/config/env');
const { parseWahaPayload } = require('../src/utils/wahaParser');
const { getWebhookMessageRoute } = require('../src/controllers/webhookController');

env.instanceName = 'default';
env.testModeAllowedNumbers = [];

test('interpreta message.any do WAHA no mesmo formato da Evolution', () => {
  const parsed = parseWahaPayload({
    event: 'message.any',
    session: 'default',
    payload: {
      id: 'false_5547999999999@c.us_AAAA',
      from: '5547999999999@c.us',
      to: '5547888888888@c.us',
      fromMe: false,
      body: 'Olá',
      hasMedia: false,
      _data: { Info: { PushName: 'Cliente Teste' } },
    },
  });

  assert.equal(parsed.instanceName, 'default');
  assert.equal(parsed.sender, '5547999999999@s.whatsapp.net');
  assert.equal(parsed.messageId, 'false_5547999999999@c.us_AAAA');
  assert.equal(parsed.content, 'Olá');
  assert.equal(parsed.contentType, 'text');
  assert.equal(parsed.senderName, 'Cliente Teste');
  assert.equal(getWebhookMessageRoute(parsed), 'incoming');
});

test('mensagem fromMe usa o chat em "to" e marca eco da API', () => {
  const echo = parseWahaPayload({
    event: 'message.any',
    session: 'default',
    payload: { id: 'true_x', from: '5547888888888@c.us', to: '5547999999999@c.us', fromMe: true, source: 'api', body: 'Oi' },
  });
  assert.equal(echo.sender, '5547999999999@s.whatsapp.net');
  assert.equal(echo.sentByApi, true);
  assert.equal(getWebhookMessageRoute(echo), 'outgoing');

  const manual = parseWahaPayload({
    event: 'message.any',
    session: 'default',
    payload: { id: 'true_y', from: '5547888888888@c.us', to: '5547999999999@c.us', fromMe: true, source: 'app', body: 'Oi' },
  });
  assert.equal(manual.sentByApi, false);
});

test('mídia, grupo, LID, evento de sistema e session.status', () => {
  const audio = parseWahaPayload({
    event: 'message.any',
    session: 'default',
    payload: { id: 'a', from: '5547999999999@c.us', hasMedia: true, body: '', media: { url: 'https://waha.example.com/api/files/default/a.oga', mimetype: 'audio/ogg' } },
  });
  assert.equal(audio.contentType, 'audio');

  const group = parseWahaPayload({ event: 'message.any', session: 'default', payload: { id: 'g', from: '120363000000000000@g.us', body: 'x' } });
  assert.equal(group.isGroup, true);
  assert.equal(getWebhookMessageRoute(group), 'ignore');

  const lid = parseWahaPayload({ event: 'message.any', session: 'default', payload: { id: 'l', from: '123456789@lid', body: 'x' } });
  assert.equal(lid.lidSender, '123456789@lid');

  const system = parseWahaPayload({ event: 'message.any', session: 'default', payload: { id: 's', from: '5547999999999@c.us', body: '' } });
  assert.ok(system.message?.protocolMessage);

  const working = parseWahaPayload({ event: 'session.status', session: 'default', payload: { status: 'WORKING' } });
  assert.equal(working.eventType, 'connected');
  assert.equal(working.sender, null);
  const failed = parseWahaPayload({ event: 'session.status', session: 'default', payload: { status: 'FAILED' } });
  assert.equal(failed.eventType, 'loggedout');
});

test('usa somente endpoints e payloads do WAHA', async (t) => {
  const calls = [];
  const fakeClient = {
    async post(url, body) {
      calls.push({ method: 'post', url, body });
      if (url === '/api/sendText') return { data: { id: 'true_5547999999999@c.us_OUT1' } };
      return { data: {} };
    },
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      if (url === '/api/sessions/default') return { data: { name: 'default', config: { debug: false } } };
      if (url.startsWith('/api/default/lids/')) return { data: { lid: '123@lid', pn: '5547999999999@c.us' } };
      if (url.startsWith('/api/files/')) return { data: Buffer.from('media'), headers: { 'content-type': 'audio/ogg' } };
      return { data: {} };
    },
    async put(url, body) {
      calls.push({ method: 'put', url, body });
      return { data: {} };
    },
  };
  const originalCreate = axios.create;
  const originalSave = customerService.saveOutgoingMessage;
  const originalEnv = { ...env };
  axios.create = () => fakeClient;
  customerService.saveOutgoingMessage = async () => null;
  Object.assign(env, {
    instanceName: 'default',
    wahaApiUrl: 'http://127.0.0.1:3000',
    wahaApiKey: 'secret',
    wahaWebhookUrl: 'https://app.example.com/webhook/waha',
    webhookSecret: 'test-secret',
    typingMinMs: 1,
    typingMaxMs: 1,
    typingPerCharMs: 1,
  });
  t.after(() => {
    axios.create = originalCreate;
    customerService.saveOutgoingMessage = originalSave;
    Object.assign(env, originalEnv);
  });

  delete require.cache[require.resolve('../src/services/wahaService')];
  const waha = require('../src/services/wahaService');
  await waha.sendText({ instanceName: 'default', remoteJid: '5547999999999@s.whatsapp.net', text: 'Teste' });
  await waha.sendText({ instanceName: 'default', remoteJid: '123456789@lid', text: 'Teste LID' });
  await waha.setWebhook('default');
  const media = await waha.downloadMedia('default', {
    id: 'MEDIA', hasMedia: true, media: { url: 'https://waha.example.com/api/files/default/a.oga', mimetype: 'audio/ogg' },
  });
  const outside = await waha.downloadMedia('default', { id: 'X', hasMedia: true, media: { url: 'https://evil.example.com/steal' } });
  const phone = await waha.resolveLid('123@lid');

  assert.ok(calls.some(({ url, body }) => url === '/api/sendText' && body.chatId === '5547999999999@c.us' && body.session === 'default'));
  assert.ok(calls.some(({ url, body }) => url === '/api/sendText' && body.chatId === '123456789@lid'));
  assert.ok(calls.some(({ url, body }) => url === '/api/startTyping' && body.chatId === '5547999999999@c.us'));
  const put = calls.find(({ method }) => method === 'put');
  assert.equal(put.url, '/api/sessions/default');
  assert.equal(put.body.config.debug, false);
  assert.deepEqual(put.body.config.ignore, { status: true, groups: true, channels: true, broadcast: true });
  assert.deepEqual(put.body.config.webhooks[0].events, ['message.any', 'session.status']);
  assert.equal(put.body.config.webhooks[0].url, 'https://app.example.com/webhook/waha');
  assert.deepEqual(put.body.config.webhooks[0].customHeaders, [{ name: 'X-Webhook-Secret', value: 'test-secret' }]);
  assert.ok(calls.some(({ url }) => url === '/api/files/default/a.oga'));
  assert.equal(media.mimeType, 'audio/ogg');
  assert.equal(Buffer.from(media.base64, 'base64').toString(), 'media');
  assert.equal(outside, null);
  assert.equal(phone, '5547999999999@s.whatsapp.net');
  assert.equal(waha.wasSentByAi({ instanceName: 'default', messageId: 'true_5547999999999@c.us_OUT1' }), true);
  await assert.rejects(
    waha.sendText({ instanceName: 'outra', remoteJid: '5547999999999@s.whatsapp.net', text: 'x' }),
    /Instância não autorizada/,
  );
});
