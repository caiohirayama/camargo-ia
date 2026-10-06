const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');
const evolutionService = require('../src/services/evolutionService');
const notificationService = require('../src/services/notificationService');

test('formata o contato do cliente para leitura no grupo', () => {
  assert.equal(notificationService.formatarContato('5519998483235@s.whatsapp.net'), '+55 19 99848-3235');
  assert.equal(notificationService.formatarContato('182712345185@lid'), '182712345185@lid');
});

test('pedido confirmado vai para o grupo de WhatsApp configurado, com valores em reais', async () => {
  const original = evolutionService.sendNotificationText;
  const anterior = env.whatsappNotificationGroupJid;
  const enviados = [];
  evolutionService.sendNotificationText = async (payload) => { enviados.push(payload); return 'id'; };
  env.whatsappNotificationGroupJid = '120363429411539223@g.us';
  try {
    await notificationService.notifyOrcamento({
      sender: '5519998483235@s.whatsapp.net',
      orcamento: {
        nome_cliente: 'João da Silva',
        itens: [{ quantidade: 2, unidade: 'fardo', produto: 'Baly Tradicional 2L FD/06', valor_total: 82.7, em_oferta: true }],
        valor_total_geral: 82.7,
      },
      pedidoGestaoClick: { codigo: '1234' },
    });
  } finally {
    evolutionService.sendNotificationText = original;
    env.whatsappNotificationGroupJid = anterior;
  }

  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].remoteJid, '120363429411539223@g.us');
  assert.match(enviados[0].text, /Pedido confirmado/);
  assert.match(enviados[0].text, /2 fardo de Baly Tradicional 2L FD\/06: R\$ 82,70 \(oferta\)/);
  assert.match(enviados[0].text, /Total: R\$ 82,70/);
  assert.match(enviados[0].text, /orçamento nº 1234/);
});
