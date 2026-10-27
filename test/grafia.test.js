const test = require('node:test');
const assert = require('node:assert/strict');
const { nomeParecido } = require('../src/services/productService');

test('marca escrita como se fala bate com o nome do cadastro', () => {
  assert.ok(nomeParecido('Crystal 350ml FD/12', 'cristal'));
  assert.ok(nomeParecido('Crystal 350ml FD/12', 'cristal 350'));
  assert.ok(nomeParecido('Heineken 600ml CX/24', 'heiniken'));
  assert.ok(nomeParecido('Budweiser 350ml FD/12', 'budwiser'));
  assert.ok(nomeParecido('Smirnoff Vodka 998ml', 'smirnof'));
  assert.ok(nomeParecido("Ballantine's Finest 1L", 'balantines'));
  assert.ok(nomeParecido('Poty Guaraná 2L FD/06', 'poti guarana'));
});

test('grafia parecida não confunde marcas diferentes', () => {
  assert.ok(!nomeParecido('Crystal 350ml FD/12', 'cristal 600'));
  assert.ok(!nomeParecido('Skol 350ml FD/12', 'sol'));
  assert.ok(!nomeParecido('Brahma 350ml FD/18', 'heineken'));
});
