const env = require('../config/env');
const googleSheetsService = require('./googleSheetsService');
const productService = require('./productService');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// A planilha de ofertas (Google Sheets) é a fonte de QUAIS produtos estão em
// oferta e em que condições: CODIGO (código interno no GestãoClick), QTDMIN
// (quantidade mínima para pagar o preço de oferta) e DATAINICIO/DATAFIM
// (dd/mm/aaaa, inclusivas). Preço, nome, estoque e ids vêm sempre do
// GestãoClick — o preço de oferta é a faixa "Ofertas" do produto.
const CATALOGO_CACHE_MS = 60 * 1000;

let planilhaCache = { linhas: null, expiresAt: 0 };
let catalogoCache = { produtos: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(googleSheetsService.isConfigured() && env.ofertasSheetId && productService.isProductsApiConfigured());
}

function normalizarCabecalho(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toUpperCase();
}

// "29/09/2026" -> "2026-09-29" (comparável como texto); null se inválida.
function parseData(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, dia, mes, ano] = match;
  return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
}

function formatarData(iso) {
  const [ano, mes, dia] = String(iso).split('-');
  return `${dia}/${mes}/${ano}`;
}

function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Localiza as colunas pelo nome do cabeçalho (não pela posição), para a
// planilha continuar funcionando se alguém inserir uma coluna no meio.
// Linhas incompletas ou com data inválida são ignoradas.
function parsePlanilha(values) {
  const linhas = Array.isArray(values) ? values : [];
  const indiceCabecalho = linhas.findIndex((linha) => (linha || []).some((celula) => normalizarCabecalho(celula) === 'CODIGO'));
  if (indiceCabecalho < 0) return [];

  const cabecalho = linhas[indiceCabecalho].map(normalizarCabecalho);
  const col = (nome) => cabecalho.indexOf(nome);
  const [cCodigo, cQtdMin, cInicio, cFim] = [col('CODIGO'), col('QTDMIN'), col('DATAINICIO'), col('DATAFIM')];

  return linhas.slice(indiceCabecalho + 1).flatMap((linha) => {
    const codigo = String(linha?.[cCodigo] || '').trim();
    const inicio = parseData(linha?.[cInicio]);
    const fim = parseData(linha?.[cFim]);
    const quantidadeMinima = Number(String(linha?.[cQtdMin] || '').replace(',', '.')) || 1;
    if (!codigo || !inicio || !fim) return [];
    return [{ codigo, quantidadeMinima, inicio, fim }];
  });
}

function isVigente(linha, hoje) {
  return linha.inicio <= hoje && hoje <= linha.fim;
}

async function getLinhasPlanilha() {
  if (planilhaCache.linhas && Date.now() < planilhaCache.expiresAt) return planilhaCache.linhas;
  const values = await googleSheetsService.getValues(env.ofertasSheetId, env.ofertasSheetRange);
  const linhas = parsePlanilha(values);
  planilhaCache = { linhas, expiresAt: Date.now() + env.ofertasCacheSeconds * 1000 };
  return linhas;
}

async function getCatalogo() {
  if (catalogoCache.produtos && Date.now() < catalogoCache.expiresAt) return catalogoCache.produtos;
  const produtos = await productService.listarCatalogoAtivo();
  catalogoCache = { produtos, expiresAt: Date.now() + CATALOGO_CACHE_MS };
  return produtos;
}

// Cruza as linhas vigentes da planilha com o catálogo. Fica de fora (com log
// para quem mantém a planilha) o código que não existe/está inativo no
// sistema, que está sem estoque ou sem valor na faixa "Ofertas".
function montarOfertas(linhas, produtos, hoje, prefix = '') {
  const porCodigo = new Map(produtos.map((produto) => [String(produto?.codigo_interno || '').trim(), produto]));
  const vistas = new Set();

  return linhas.filter((linha) => isVigente(linha, hoje)).flatMap((linha) => {
    const produto = porCodigo.get(linha.codigo);
    if (!produto) {
      console.warn(`${prefix} [ofertas] código ${linha.codigo} da planilha não encontrado entre os produtos ativos do GestãoClick`);
      return [];
    }
    if (vistas.has(produto.id)) return [];
    vistas.add(produto.id);

    const base = productService.normalizeProduto(produto);
    const valorOferta = productService.valorPorFaixa(produto, 'Ofertas');
    if (valorOferta === null) {
      console.warn(`${prefix} [ofertas] código ${linha.codigo} (${base.nome}) sem valor na faixa "Ofertas" do GestãoClick`);
      return [];
    }
    if (base.estoque <= 0) return [];
    if (base.valor_venda !== null && valorOferta >= base.valor_venda) {
      console.warn(`${prefix} [ofertas] código ${linha.codigo} (${base.nome}) com valor de oferta ${valorOferta} maior ou igual ao normal ${base.valor_venda}`);
    }

    return [{
      id: base.id,
      codigo: base.codigo,
      nome: base.nome,
      estoque: base.estoque,
      variacao_id: base.variacao_id,
      valor_normal: base.valor_venda,
      valor_oferta: valorOferta,
      quantidade_minima: linha.quantidadeMinima,
      valida_ate: formatarData(linha.fim),
    }];
  });
}

async function listarOfertasVigentes({ messageId = null } = {}) {
  const prefix = flowPrefix(messageId);
  // Planilha não configurada é escolha de ambiente, não falha: responde "sem
  // ofertas" em vez de consultaRealizada false, que faria a IA transferir
  // para um atendente.
  if (!isConfigured()) {
    return { consultaRealizada: true, ofertas: [] };
  }

  try {
    const [linhas, produtos] = await Promise.all([getLinhasPlanilha(), getCatalogo()]);
    const ofertas = montarOfertas(linhas, produtos, hojeEmSaoPaulo(), prefix);
    console.log(`${prefix} [ofertas] consulta realizada | linhasPlanilha=${linhas.length} | ofertasVigentes=${ofertas.length}`);
    return { consultaRealizada: true, ofertas };
  } catch (error) {
    console.error(`${prefix} [ofertas] falha ao consultar planilha/catálogo:`, errorSummary(error));
    return { consultaRealizada: false, motivo: 'falha ao consultar as ofertas' };
  }
}

async function buscarOfertaVigente(produtoId, { messageId = null } = {}) {
  const resultado = await listarOfertasVigentes({ messageId });
  if (!resultado.consultaRealizada) return null;
  return resultado.ofertas.find((oferta) => String(oferta.id) === String(produtoId)) || null;
}

module.exports = {
  isConfigured,
  listarOfertasVigentes,
  buscarOfertaVigente,
  // Exportados para teste.
  parsePlanilha,
  montarOfertas,
};
