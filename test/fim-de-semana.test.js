const test = require('node:test');
const assert = require('node:assert/strict');
const { aceitaPedidoHoje } = require('../src/services/aiService');

test('pedidos pelo WhatsApp só de segunda a sexta, no horário de Brasília', () => {
  assert.equal(aceitaPedidoHoje(new Date('2026-10-30T15:00:00-03:00')), true); // sexta
  assert.equal(aceitaPedidoHoje(new Date('2026-10-31T10:00:00-03:00')), false); // sábado
  assert.equal(aceitaPedidoHoje(new Date('2026-11-01T10:00:00-03:00')), false); // domingo
  assert.equal(aceitaPedidoHoje(new Date('2026-11-02T00:30:00-03:00')), true); // segunda
  // 23h30 de domingo em Brasília já é segunda em UTC: ainda é fim de semana.
  assert.equal(aceitaPedidoHoje(new Date('2026-11-02T02:30:00Z')), false);
});
