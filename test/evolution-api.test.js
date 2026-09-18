const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const customerService = require('../src/services/customerService');
const env = require('../src/config/env');
const { parseIncomingPayload } = require('../src/utils/messageParser');
const { getWebhookMessageRoute } = require('../src/controllers/webhookController');

env.instanceName = 'camargo';
env.testModeAllowedNumbers = [];

test('interpreta webhook MESSAGES_UPSERT da Evolution API', () => {
  const parsed = parseIncomingPayload({
    event: 'messages.upsert',
    instance: 'camargo',
    data: {
      key: {
        remoteJid: '5547999999999@s.whatsapp.net',
        fromMe: false,
        id: 'MESSAGE-ID',
      },
      pushName: 'Cliente Teste',
      message: { conversation: 'Olá' },
      messageType: 'conversation',
    },
  });

  assert.equal(parsed.instanceName, 'camargo');
  assert.equal(parsed.sender, '5547999999999@s.whatsapp.net');
  assert.equal(parsed.messageId, 'MESSAGE-ID');
  assert.equal(parsed.content, 'Olá');
  assert.equal(parsed.senderName, 'Cliente Teste');
  assert.equal(parsed.eventType, 'messages.upsert');
});

test('interpreta CONNECTION_UPDATE e identifica grupos', () => {
  const connected = parseIncomingPayload({ event: 'connection.update', instance: 'camargo', data: { state: 'open' } });
  assert.equal(connected.eventType, 'connected');

  const reconnecting = parseIncomingPayload({
    event: 'CONNECTION_UPDATE',
    instance: 'camargo',
    data: { state: 'close', statusReason: 408 },
  });
  assert.equal(reconnecting.eventType, 'connection.update');

  const loggedOut = parseIncomingPayload({
    event: 'CONNECTION_UPDATE',
    instance: 'camargo',
    data: { state: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } },
  });
  assert.equal(loggedOut.eventType, 'loggedout');

  const group = parseIncomingPayload({
    event: 'MESSAGES_UPSERT',
    instance: 'camargo',
    data: {
      key: { remoteJid: '120363000000000000@g.us', participant: '5547999999999@s.whatsapp.net' },
      message: { conversation: 'Mensagem de grupo' },
    },
  });
  assert.equal(group.isGroup, true);
});

test('desencapsula mensagens efêmeras e view-once sem alterar o envelope original', () => {
  const originalMessage = {
    ephemeralMessage: {
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: { caption: 'Foto protegida', mimetype: 'image/jpeg' },
          },
        },
      },
    },
  };
  const parsed = parseIncomingPayload({
    event: 'MESSAGES_UPSERT',
    instance: 'camargo',
    data: {
      key: { remoteJid: '5547999999999@s.whatsapp.net', id: 'WRAPPED-ID' },
      message: originalMessage,
    },
  });

  assert.equal(parsed.contentType, 'image');
  assert.equal(parsed.content, 'Foto protegida');
  assert.equal(parsed.rawData.message, originalMessage);
});

test('ignora grupos inclusive fromMe e mantém contatos somente LID no atendimento', () => {
  const groupFromMe = parseIncomingPayload({
    event: 'MESSAGES_UPSERT',
    instance: 'camargo',
    data: {
      key: { remoteJid: '120363000000000000@g.us', fromMe: true, id: 'GROUP-ID' },
      message: { conversation: 'Mensagem própria no grupo' },
    },
  });
  assert.equal(getWebhookMessageRoute(groupFromMe), 'ignore');

  const lidPayload = (id, message) => parseIncomingPayload({
    event: 'MESSAGES_UPSERT',
    instance: 'camargo',
    data: {
      key: { remoteJid: '123456789@lid', fromMe: false, id },
      pushName: 'Cliente LID',
      message: { conversation: message },
    },
  });
  assert.equal(getWebhookMessageRoute(lidPayload('LID-1', 'Primeira mensagem')), 'incoming');
  assert.equal(getWebhookMessageRoute(lidPayload('LID-2', 'Segunda mensagem')), 'incoming');
});

test('usa somente endpoints e payloads da Evolution API', async (t) => {
  const calls = [];
  let outgoingSequence = 0;
  const fakeClient = {
    async post(url, body) {
      calls.push({ url, body });
      if (url.includes('getBase64FromMediaMessage')) {
        return { data: { base64: Buffer.from('media').toString('base64'), mimetype: 'image/jpeg' } };
      }
      if (url.includes('findContacts')) {
        return { data: [{ id: 'internal-id', remoteJid: '5547999999999@s.whatsapp.net', pushName: 'Cliente' }] };
      }
      if (url.includes('sendText')) {
        outgoingSequence += 1;
        return { data: { key: { id: `OUT-ID-${outgoingSequence}` } } };
      }
      return { data: { success: true } };
    },
  };
  const originalCreate = axios.create;
  const originalSave = customerService.saveOutgoingMessage;
  const originalEnv = {
    instanceName: env.instanceName,
    evolutionApiUrl: env.evolutionApiUrl,
    evolutionApiKey: env.evolutionApiKey,
    evolutionWebhookUrl: env.evolutionWebhookUrl,
    webhookSecret: env.webhookSecret,
    typingMinMs: env.typingMinMs,
    typingMaxMs: env.typingMaxMs,
    typingPerCharMs: env.typingPerCharMs,
  };
  axios.create = () => fakeClient;
  customerService.saveOutgoingMessage = async () => null;
  env.instanceName = 'camargo';
  env.evolutionApiUrl = 'https://evolution.example.com';
  env.evolutionApiKey = 'secret';
  env.evolutionWebhookUrl = 'https://app.example.com/webhook/evolution';
  env.webhookSecret = 'test-secret';
  env.typingMinMs = 1;
  env.typingMaxMs = 1;
  env.typingPerCharMs = 1;
  t.after(() => {
    axios.create = originalCreate;
    customerService.saveOutgoingMessage = originalSave;
    Object.assign(env, originalEnv);
  });

  delete require.cache[require.resolve('../src/services/evolutionService')];
  const evolution = require('../src/services/evolutionService');
  await evolution.sendText({ instanceName: 'camargo', remoteJid: '5547999999999@s.whatsapp.net', text: 'Teste' });
  await evolution.sendText({ instanceName: 'camargo', remoteJid: '123456789@lid', text: 'Teste LID' });
  const contacts = await evolution.getContacts('camargo');
  await evolution.setWebhook('camargo');
  await evolution.downloadMedia('camargo', {
    key: { id: 'MEDIA-ID', remoteJid: '5547999999999@s.whatsapp.net' },
    message: { imageMessage: { mimetype: 'image/jpeg' } },
  });

  assert.ok(calls.some(({ url, body }) => url === '/message/sendText/camargo' && body.text === 'Teste'));
  assert.ok(calls.some(({ url, body }) => url === '/message/sendText/camargo' && body.number === '123456789@lid'));
  assert.ok(calls.some(({ url, body }) => url === '/chat/sendPresence/camargo' && body.presence === 'composing'));
  assert.ok(calls.some(({ url }) => url === '/chat/findContacts/camargo'));
  assert.ok(calls.some(({ url }) => url === '/chat/getBase64FromMediaMessage/camargo'));
  const webhookCall = calls.find(({ url }) => url === '/webhook/set/camargo');
  assert.deepEqual(webhookCall.body, {
    webhook: {
      enabled: true,
      url: 'https://app.example.com/webhook/evolution?token=test-secret',
      byEvents: false,
      base64: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    },
  });
  assert.equal(contacts[0].remoteJid, '5547999999999@s.whatsapp.net');
  assert.equal(evolution.wasSentByAi({ instanceName: 'camargo', messageId: 'OUT-ID-1' }), true);
  assert.equal(evolution.wasSentByAi({ instanceName: 'camargo', messageId: 'OUT-ID-1' }), false);
  assert.equal(evolution.wasSentByAi({ instanceName: 'camargo', messageId: 'UNKNOWN' }), false);
  await assert.rejects(
    evolution.sendText({ instanceName: 'outra-instancia', remoteJid: '5547999999999@s.whatsapp.net', text: 'Bloqueada' }),
    /Instância não autorizada/,
  );

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'evolutionService.js'), 'utf8');
  assert.doesNotMatch(source, /'\/send\/text'|'\/message\/presence'|'\/user\/contacts'/);
});
