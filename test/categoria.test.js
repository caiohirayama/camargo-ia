const test = require('node:test');
const assert = require('node:assert/strict');
const { filtrarPorCategoria } = require('../src/services/productService');

const produtos = [
  { nome: 'Poty Guaraná 2L FD/06', nome_grupo: 'Refrigerante' },
  { nome: 'Furioso Melancia 2L FD/06', nome_grupo: 'Energético' },
  { nome: 'Coca Cola 2L FD/06', nome_grupo: '' },
];

test('categoria pedida tira produtos de outro grupo e mantém os sem grupo', () => {
  assert.deepEqual(filtrarPorCategoria(produtos, 'refrigerantes').map((p) => p.nome), ['Poty Guaraná 2L FD/06', 'Coca Cola 2L FD/06']);
  assert.deepEqual(filtrarPorCategoria(produtos, 'energetico').map((p) => p.nome), ['Furioso Melancia 2L FD/06', 'Coca Cola 2L FD/06']);
});

test('sem categoria ou categoria que não é grupo de nenhum resultado não filtra', () => {
  assert.equal(filtrarPorCategoria(produtos, null).length, 3);
  assert.equal(filtrarPorCategoria(produtos, 'whisky').length, 3);
});
