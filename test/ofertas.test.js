const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');
const ofertaService = require('../src/services/ofertaService');

const produtoHeineken = {
  id: '75310077',
  codigo_interno: '221',
  nome: 'Heineken 350ml FD/12',
  ativo: '1',
  estoque: '519',
  valor_venda: '55.10',
  valores: [
    { nome_tipo: 'Pequena quantidade', valor_venda: '55.10' },
    { nome_tipo: 'Ofertas', valor_venda: '52.90' },
  ],
  variacoes: [{ variacao: { id: '999' } }],
};

test('lê a planilha pelo nome das colunas; data vazia vale como sem limite, data ilegível descarta a linha', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  let linhas;
  try {
    linhas = ofertaService.parsePlanilha([
      ['DATAINICIO', 'CODIGO', 'QTDMIN', 'DATAFIM', 'VALOR'],
      ['29/09/2026', '221', '20', '30/09/2026', 'R$ 53,00'],
      ['', '300', '5', '30/09/2026', 'R$ 10,00'],
      ['1/10/2026', ' 400 ', '', '5/10/2026'],
      ['', '500', '6', '', 'R$ 15,90'],
      ['31-12-2026', '600', '1', '', 'R$ 1,00'],
      ['', '', '1', '', 'R$ 1,00'],
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(linhas, [
    { codigo: '221', quantidadeMinima: 20, inicio: '2026-09-29', fim: '2026-09-30', valor: 53 },
    { codigo: '300', quantidadeMinima: 5, inicio: null, fim: '2026-09-30', valor: 10 },
    { codigo: '400', quantidadeMinima: 1, inicio: '2026-10-01', fim: '2026-10-05', valor: null },
    { codigo: '500', quantidadeMinima: 6, inicio: null, fim: null, valor: 15.9 },
  ]);
});

test('calcula unidades por embalagem pelo nome do produto', () => {
  assert.equal(ofertaService.unidadesPorEmbalagem('Baly Tradicional 2L FD/06'), 6);
  assert.equal(ofertaService.unidadesPorEmbalagem('Heineken 600ml CX/24'), 24);
  assert.equal(ofertaService.unidadesPorEmbalagem('Heineken Zero Long 330ml  FD/24'), 24);
  assert.equal(ofertaService.unidadesPorEmbalagem('1985 Licor'), null);
});

test('converte o VALOR da planilha no formato brasileiro', () => {
  assert.equal(ofertaService.parseValor('R$ 195,00'), 195);
  assert.equal(ofertaService.parseValor('R$ 1.234,56'), 1234.56);
  assert.equal(ofertaService.parseValor('39,55'), 39.55);
  assert.equal(ofertaService.parseValor('53.5'), 53.5);
  assert.equal(ofertaService.parseValor(''), null);
  assert.equal(ofertaService.parseValor('R$ 0,00'), null);
});

test('só inclui oferta vigente, com produto ativo, estoque e VALOR na planilha; ignora a faixa Ofertas do sistema', () => {
  const linhas = [
    { codigo: '221', quantidadeMinima: 20, inicio: '2026-09-29', fim: '2026-09-29', valor: 52.9 },
    { codigo: '221', quantidadeMinima: 20, inicio: '2026-09-29', fim: '2026-09-29', valor: 52.9 },
    { codigo: '500', quantidadeMinima: 1, inicio: '2026-09-29', fim: '2026-09-29', valor: 10 },
    { codigo: '600', quantidadeMinima: 1, inicio: '2026-09-29', fim: '2026-09-29', valor: 10 },
    { codigo: '700', quantidadeMinima: 1, inicio: '2026-09-29', fim: '2026-09-29', valor: null },
  ];
  const produtos = [
    // Faixa "Ofertas" do sistema mais cara que o normal: tem de ser ignorada.
    { ...produtoHeineken, valores: [{ nome_tipo: 'Ofertas', valor_venda: '55.31' }] },
    { ...produtoHeineken, id: '2', codigo_interno: '600', estoque: '0' },
    { ...produtoHeineken, id: '3', codigo_interno: '700' },
  ];

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(ofertaService.montarOfertas(linhas, produtos, '2026-09-29'), [{
      id: '75310077',
      codigo: '221',
      nome: 'Heineken 350ml FD/12',
      variacao_id: '999',
      valor_normal: 55.1,
      valor_oferta: 52.9,
      unidades_por_embalagem: 12,
      valor_oferta_unidade: 4.41,
      quantidade_minima: 20,
      valida_ate: '29/09/2026',
      bloco_mensagem: '🔥 Heineken 350ml FD/12\n🏷️ R$ 4,41 a unidade\n💰 R$ 52,90 o fardo com 12\n📦 A partir de 20 fardos\n⏰ Válido até 29/09/2026',
    }]);
    assert.deepEqual(ofertaService.montarOfertas(linhas, produtos, '2026-09-30'), []);
    assert.deepEqual(ofertaService.montarOfertas(linhas, produtos, '2026-09-28'), []);

    // Sem datas: vale todo dia e sai sem validade.
    const semData = ofertaService.montarOfertas([{ codigo: '221', quantidadeMinima: 1, inicio: null, fim: null, valor: 41.35 }], produtos, '2030-01-01');
    assert.equal(semData.length, 1);
    assert.equal(semData[0].valida_ate, null);
    assert.equal(semData[0].valor_oferta_unidade, 3.45);
  } finally {
    console.warn = originalWarn;
  }
});

test('troca um JWT assinado com a chave da conta de serviço por access token', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = require('../src/config/env');
  Object.assign(env, {
    googleServiceAccountEmail: 'bot@projeto.iam.gserviceaccount.com',
    googleServiceAccountPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });

  const originalPost = axios.post;
  const originalGet = axios.get;
  let assertion;
  axios.post = async (url, body) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assertion = new URLSearchParams(body).get('assertion');
    return { data: { access_token: 'token-teste', expires_in: 3600 } };
  };
  axios.get = async (url, config) => {
    assert.match(url, /\/spreadsheets\/planilha-id\/values\/A%3AD$/);
    assert.equal(config.headers.Authorization, 'Bearer token-teste');
    return { data: { values: [['CODIGO']] } };
  };

  try {
    const googleSheetsService = require('../src/services/googleSheetsService');
    assert.deepEqual(await googleSheetsService.getValues('planilha-id', 'A:D'), [['CODIGO']]);

    const [header, claims, assinatura] = assertion.split('.');
    const valida = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(assinatura, 'base64url'));
    assert.equal(valida, true);
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(payload.iss, 'bot@projeto.iam.gserviceaccount.com');
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
  }
});
