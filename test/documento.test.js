const test = require('node:test');
const assert = require('node:assert/strict');
const documento = require('../src/utils/documento');

test('valida CPF pelos dígitos verificadores, com ou sem máscara', () => {
  assert.equal(documento.isCpfValido('221.464.818-62'), true);
  assert.equal(documento.isCpfValido('22146481862'), true);
  assert.equal(documento.isCpfValido('221.464.818-63'), false);
  assert.equal(documento.isCpfValido('111.111.111-11'), false);
  assert.equal(documento.isCpfValido('2214648186'), false);
  assert.equal(documento.isCpfValido(null), false);
});

test('valida CNPJ pelos dígitos verificadores, com ou sem máscara', () => {
  assert.equal(documento.isCnpjValido('51.146.335/0001-53'), true);
  assert.equal(documento.isCnpjValido('51146335000153'), true);
  assert.equal(documento.isCnpjValido('51.146.335/0001-54'), false);
  assert.equal(documento.isCnpjValido('11.111.111/1111-11'), false);
  assert.equal(documento.isCnpjValido('22146481862'), false);
});

test('formata CPF/CNPJ no mesmo padrão dos cadastros do GestãoClick', () => {
  assert.equal(documento.formatarCpf('22146481862'), '221.464.818-62');
  assert.equal(documento.formatarCnpj('51146335000153'), '51.146.335/0001-53');
});
