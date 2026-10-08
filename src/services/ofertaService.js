const env = require('../config/env');
const googleSheetsService = require('./googleSheetsService');
const productService = require('./productService');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// A planilha de ofertas (Google Sheets) é a fonte de QUAIS produtos estão em
// oferta e em que condições: CODIGO (código interno no GestãoClick), QTDMIN
// (quantidade mínima para pagar o preço de oferta), DATAINICIO/DATAFIM
// (dd/mm/aaaa, inclusivas; vazias = sem limite daquele lado) e VALOR (preço de oferta, ex: "R$ 53,00"). O preço
// de oferta vem SEMPRE da planilha: a faixa "Ofertas" do GestãoClick é
// inconsistente (em vários produtos é mais cara que o preço normal). Nome,
// estoque, preço normal e ids vêm do GestãoClick.
const CATALOGO_CACHE_MS = 60 * 1000;

let planilhaCache = { linhas: null, expiresAt: 0 };
let catalogoCache = { produtos: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(googleSheetsService.isConfigured() && env.ofertasSheetId && productService.isProductsApiConfigured());
}

function normalizarCabecalho(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toUpperCase();
}

// "R$ 1.234,56" / "53,00" / "53.5" -> número; null se vazio ou inválido.
function parseValor(value) {
  let texto = String(value || '').replace(/[^\d.,]/g, '');
  if (!texto) return null;
  // Vírgula presente = formato brasileiro: ponto é separador de milhar.
  if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
  const valor = Number(texto);
  return Number.isFinite(valor) && valor > 0 ? valor : null;
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

// Data vazia = sem limite naquele lado (sem DATAINICIO: já vale; sem
// DATAFIM: vale até a linha ser apagada). Data preenchida mas ilegível
// descarta a linha: um erro de digitação não pode virar oferta sem prazo.
function parseDataOpcional(value) {
  if (!String(value || '').trim()) return { ok: true, data: null };
  const data = parseData(value);
  return { ok: Boolean(data), data };
}

// "Baly Tradicional 2L FD/06" -> 6, "Heineken 600ml CX/24" -> 24; null quando
// o nome não traz a embalagem (produto vendido por unidade).
function unidadesPorEmbalagem(nome) {
  const match = String(nome || '').match(/\b(?:FD|CX|PCT|PC|EMB|ENG)\s*\/?\s*(\d+)\b/i);
  const unidades = match ? Number(match[1]) : null;
  return unidades && unidades > 1 ? unidades : null;
}

function formatarReais(valor) {
  return `R$ ${Number(valor).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// FD = fardo, CX = caixa (como a loja chama a embalagem no WhatsApp).
function nomeEmbalagem(nome) {
  if (/\bFD\s*\/?\s*\d+/i.test(nome)) return { singular: 'fardo', plural: 'fardos', artigo: 'o' };
  if (/\bCX\s*\/?\s*\d+/i.test(nome)) return { singular: 'caixa', plural: 'caixas', artigo: 'a' };
  return null;
}

// Bloco pronto de cada oferta para a mensagem "OFERTAS BOMBÁSTICAS": montado
// aqui e copiado pela IA, porque numa lista longa o modelo pulava linhas
// (ex: a quantidade mínima). Linhas opcionais só aparecem quando há dado.
function montarBlocoOferta({ nome, valorOferta, unidades, valorUnidade, quantidadeMinima, validaAte }) {
  const embalagem = nomeEmbalagem(nome);
  const linhas = [`🔥 ${String(nome).replace(/\s+/g, ' ').trim()}`];
  if (valorUnidade) linhas.push(`🏷️ ${formatarReais(valorUnidade)} a unidade`);
  if (embalagem && unidades) {
    linhas.push(`💰 ${formatarReais(valorOferta)} ${embalagem.artigo} ${embalagem.singular} com ${unidades}`);
  } else {
    linhas.push(`💰 ${formatarReais(valorOferta)}`);
  }
  if (quantidadeMinima > 1) {
    linhas.push(`📦 A partir de ${quantidadeMinima} ${embalagem ? embalagem.plural : 'unidades'}`);
  }
  if (validaAte) linhas.push(`⏰ Válido até ${validaAte}`);
  return linhas.join('\n');
}

// Localiza as colunas pelo nome do cabeçalho (não pela posição), para a
// planilha continuar funcionando se alguém inserir uma coluna no meio.
// Linhas sem código ou com data ilegível são ignoradas.
function parsePlanilha(values) {
  const linhas = Array.isArray(values) ? values : [];
  const indiceCabecalho = linhas.findIndex((linha) => (linha || []).some((celula) => normalizarCabecalho(celula) === 'CODIGO'));
  if (indiceCabecalho < 0) return [];

  const cabecalho = linhas[indiceCabecalho].map(normalizarCabecalho);
  const col = (nome) => cabecalho.indexOf(nome);
  const [cCodigo, cQtdMin, cInicio, cFim, cValor] = [col('CODIGO'), col('QTDMIN'), col('DATAINICIO'), col('DATAFIM'), col('VALOR')];

  return linhas.slice(indiceCabecalho + 1).flatMap((linha) => {
    const codigo = String(linha?.[cCodigo] || '').trim();
    const inicio = parseDataOpcional(cInicio >= 0 ? linha?.[cInicio] : '');
    const fim = parseDataOpcional(cFim >= 0 ? linha?.[cFim] : '');
    const quantidadeMinima = Number(String(linha?.[cQtdMin] || '').replace(',', '.')) || 1;
    const valor = cValor >= 0 ? parseValor(linha?.[cValor]) : null;
    if (!codigo) return [];
    if (!inicio.ok || !fim.ok) {
      console.warn(`[ofertas] código ${codigo} ignorado: data inválida na planilha (use dd/mm/aaaa)`);
      return [];
    }
    return [{ codigo, quantidadeMinima, inicio: inicio.data, fim: fim.data, valor }];
  });
}

function isVigente(linha, hoje) {
  return (!linha.inicio || linha.inicio <= hoje) && (!linha.fim || hoje <= linha.fim);
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
// sistema, que está sem estoque ou sem VALOR preenchido na planilha.
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
    const valorOferta = linha.valor;
    if (valorOferta === null || valorOferta === undefined) {
      console.warn(`${prefix} [ofertas] código ${linha.codigo} (${base.nome}) sem VALOR válido na planilha de ofertas`);
      return [];
    }
    if ((Number(produto?.estoque) || 0) <= 0) return [];
    if (base.valor_venda !== null && valorOferta >= base.valor_venda) {
      console.warn(`${prefix} [ofertas] código ${linha.codigo} (${base.nome}) com valor de oferta ${valorOferta} maior ou igual ao normal ${base.valor_venda}`);
    }

    // Preço por unidade calculado aqui, não pela IA (conta de divisão em
    // texto livre é onde o modelo erra). Arredondado como no material da
    // loja: 41,35 / 6 = 6,89.
    const unidades = unidadesPorEmbalagem(base.nome);
    const valorUnidade = unidades ? Math.round((valorOferta / unidades) * 100) / 100 : null;
    const validaAte = linha.fim ? formatarData(linha.fim) : null;
    return [{
      id: base.id,
      codigo: base.codigo,
      nome: base.nome,
      variacao_id: base.variacao_id,
      valor_normal: base.valor_venda,
      valor_oferta: valorOferta,
      unidades_por_embalagem: unidades,
      valor_oferta_unidade: valorUnidade,
      quantidade_minima: linha.quantidadeMinima,
      valida_ate: validaAte,
      bloco_mensagem: montarBlocoOferta({
        nome: base.nome,
        valorOferta,
        unidades,
        valorUnidade,
        quantidadeMinima: linha.quantidadeMinima,
        validaAte,
      }),
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
  parseValor,
  unidadesPorEmbalagem,
  montarOfertas,
};
