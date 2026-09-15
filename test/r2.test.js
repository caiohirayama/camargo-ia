const test = require('node:test');
const assert = require('node:assert/strict');
const { buildObjectKey, buildPublicUrl, normalizeMimeType, putMediaObject } = require('../src/services/r2Service');

test('monta URL pública R2 sem duplicar barras e codifica o caminho', () => {
  const url = buildPublicUrl('whatsapp-media/arquivo com espaço.jpg', 'https://media.example.com/');
  assert.equal(url, 'https://media.example.com/whatsapp-media/arquivo%20com%20espa%C3%A7o.jpg');
});

test('gera chave opaca sem instância ou telefone do cliente', () => {
  const key = buildObjectKey({
    mimeType: 'image/jpeg',
    now: new Date('2026-08-11T12:00:00Z'),
    id: 'fixed-id',
  });
  assert.equal(key, 'whatsapp-media/2026/08/11/fixed-id.jpg');
});

test('normaliza conteúdo ativo desconhecido para download binário', () => {
  assert.equal(normalizeMimeType('image/svg+xml'), 'application/octet-stream');
  assert.equal(normalizeMimeType('text/html'), 'application/octet-stream');
  assert.equal(normalizeMimeType('image/jpeg; charset=binary'), 'image/jpeg');
});

test('envia corpo decodificado e metadados seguros ao R2', async () => {
  let commandInput;
  const storageClient = {
    async send(command) {
      commandInput = command.input;
    },
  };
  const base64 = Buffer.from('conteúdo de teste').toString('base64');
  const url = await putMediaObject(
    { base64, mimeType: 'image/png' },
    {
      storageClient,
      bucket: 'camargo-media',
      publicBaseUrl: 'https://media.example.com',
      maxBytes: 1024,
    },
  );

  assert.equal(commandInput.Bucket, 'camargo-media');
  assert.equal(commandInput.ContentType, 'image/png');
  assert.equal(commandInput.ContentDisposition, 'attachment');
  assert.equal(commandInput.Body.toString(), 'conteúdo de teste');
  assert.match(url, /^https:\/\/media\.example\.com\/whatsapp-media\/\d{4}\/\d{2}\/\d{2}\//);
});

test('recusa base64 malformado e mídia acima do limite', async () => {
  const options = {
    storageClient: { send: async () => {} },
    bucket: 'camargo-media',
    publicBaseUrl: 'https://media.example.com',
    maxBytes: 3,
  };
  await assert.rejects(() => putMediaObject({ base64: '%%%=', mimeType: 'image/jpeg' }, options), /base64 válido/);
  await assert.rejects(
    () => putMediaObject({ base64: Buffer.from('grande').toString('base64'), mimeType: 'image/jpeg' }, options),
    /excede|acima do limite/,
  );
});
