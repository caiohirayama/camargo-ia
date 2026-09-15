const test = require('node:test');
const assert = require('node:assert/strict');
const { shortId, maskJid, flowPrefix, sanitizeRequestUrl, errorSummary } = require('../src/utils/logContext');

test('mascara identificadores pessoais nos logs', () => {
  assert.equal(maskJid('5547999999999@s.whatsapp.net'), '554***99@s.whatsapp.net');
  assert.equal(maskJid('123456789@lid'), '123***89@lid');
  assert.doesNotMatch(maskJid('5547999999999@s.whatsapp.net'), /5547999999999/);
});

test('gera prefixo curto e estável para acompanhar o fluxo', () => {
  assert.equal(shortId('ABCDEFGHIJKLMNO'), 'DEFGHIJKLMNO');
  assert.equal(flowPrefix('MESSAGE-ID'), '[fluxo:MESSAGE-ID]');
  assert.equal(flowPrefix(null), '[fluxo:sem-id]');
});

test('remove segredos de URLs e não inclui body de respostas nos erros', () => {
  const sanitized = sanitizeRequestUrl('/webhook/evolution?token=segredo-real&foo=bar');
  assert.equal(sanitized, '/webhook/evolution?token=[redacted]&foo=bar');
  assert.doesNotMatch(sanitized, /segredo-real/);

  const summary = errorSummary({
    message: 'falha em ?apikey=chave-real',
    response: { status: 502, data: { base64: 'conteudo-sensivel' } },
  });
  assert.deepEqual(summary, { message: 'falha em ?apikey=[redacted]', status: 502 });
  assert.doesNotMatch(JSON.stringify(summary), /conteudo-sensivel|chave-real/);
});
