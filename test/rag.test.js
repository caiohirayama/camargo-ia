const test = require('node:test');
const assert = require('node:assert/strict');
const ragService = require('../src/services/ragService');

function sourcesFor(query) {
  return ragService.search(query).map((result) => result.source);
}

test('carrega somente a base Camargo', () => {
  const status = ragService.getStatus();
  assert.equal(status.enabled, true);
  assert.ok(status.chunks >= 3);
});

test('recupera endereço e política de retirada', () => {
  assert.ok(sourcesFor('endereco da loja').includes('company.md'));
  assert.ok(sourcesFor('voces fazem entrega').includes('company.md'));
});

test('recupera horário de funcionamento', () => {
  assert.ok(sourcesFor('horario de funcionamento').includes('hours.md'));
  assert.ok(sourcesFor('abre domingo').includes('hours.md'));
  assert.ok(sourcesFor('voces atendem sabado').includes('hours.md'));
});

test('recupera política comercial de preço e desconto', () => {
  assert.ok(sourcesFor('preco do produto').includes('commercial-policies.md'));
  assert.ok(sourcesFor('desconto').includes('commercial-policies.md'));
});
