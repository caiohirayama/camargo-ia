const axios = require('axios');
const env = require('../config/env');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// Contrato da API de produtos do GestãoClick (fixo por fornecedor, como as
// URLs do Google Calendar/Evolution em outros services): só os tokens variam
// por cliente, então só eles vêm do .env.
const GESTAOCLICK_API_BASE = 'https://api.gestaoclick.com/api';
const MAX_RESULTADOS = 8;

// O parâmetro `nome` da API do GestãoClick faz correspondência por substring
// literal contra o nome cadastrado do produto (ex: "Skol 350ml FD/12"), sem
// separar por palavra nem ignorar termos fora de ordem. O nome cadastrado
// nunca inclui o tipo de recipiente/categoria genérica que o cliente usa no
// WhatsApp (ex: "cerveja skol lata 350" não bate com nada, mas "skol 350"
// bate) — por isso removemos esses termos antes de consultar.
const FILLER_WORDS = new Set([
  'cerveja', 'cervejas', 'refrigerante', 'refrigerantes', 'refri', 'bebida', 'bebidas',
  'lata', 'latas', 'latinha', 'latinhas', 'garrafa', 'garrafas', 'vidro', 'pet',
  'pacote', 'pacotes', 'unidade', 'unidades', 'un',
  'fardo', 'fardos', 'caixa', 'caixas', 'engradado', 'engradados',
  'de', 'da', 'do', 'das', 'dos', 'com', 'para', 'por', 'favor', 'e', 'a', 'o',
]);

function normalizeForCompare(word) {
  return String(word || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Preserva grafia/acentos originais das palavras mantidas (o valor vai direto
// pro parâmetro `nome` da API) e só usa a forma normalizada pra decidir o que
// descartar.
function stripFillerWords(termo) {
  const original = String(termo || '').trim();
  const palavras = original.split(/\s+/).filter(Boolean);
  const filtradas = palavras.filter((palavra) => !FILLER_WORDS.has(normalizeForCompare(palavra)));
  const resultado = filtradas.join(' ').trim();
  return resultado || original;
}

// O cadastro mistura apóstrofo reto e curvo ("Jack Daniel's Honey 1L" e
// "Jack Daniel’s Fire 1L") e o cliente às vezes nem digita ("jack daniels"),
// e a busca da API é substring literal. Para comparar, tiramos os apóstrofos.
const APOSTROFOS = /['’‘`´]/g;
const MAX_BUSCAS_POR_PALAVRA = 3;

function semApostrofo(texto) {
  return normalizeForCompare(texto).replace(APOSTROFOS, '');
}

// Palavras do termo para a busca de reserva, maiores primeiro (mais
// distintivas). Quebra no apóstrofo: "Daniel's" vira "Daniel".
function palavrasParaBusca(termo) {
  const palavras = String(termo || '').split(/[\s'’‘`´]+/).filter((palavra) => palavra.length >= 3);
  return [...new Set(palavras)].sort((a, b) => b.length - a.length).slice(0, MAX_BUSCAS_POR_PALAVRA);
}

// Quantas palavras do termo o nome contém, ignorando acento, caixa e
// apóstrofo. Produto bate com o termo quando contém todas.
function palavrasEmComum(nome, termo) {
  const nomeComparavel = semApostrofo(nome);
  return semApostrofo(termo).split(/\s+/).filter(Boolean).filter((palavra) => nomeComparavel.includes(palavra)).length;
}

// O grupo do produto no GestãoClick (nome_grupo: "Refrigerante",
// "Energético", "Cerveja"...) separa categorias que o nome não separa: "2L"
// traz refrigerante e energético juntos. Produto sem grupo cadastrado (~1/3
// do catálogo em 2026-10-27) continua aparecendo, porque pode ser da
// categoria pedida.
function palavrasDaCategoria(texto) {
  return normalizeForCompare(texto)
    .split(/\s+/)
    .filter((palavra) => palavra.length >= 3)
    .map((palavra) => palavra.replace(/s$/, ''));
}

function grupoBate(produto, categoria) {
  const grupo = palavrasDaCategoria(produto?.nome_grupo);
  return palavrasDaCategoria(categoria).some((palavra) => grupo.includes(palavra));
}

// Se nenhum resultado é do grupo pedido (ex: a IA mandou "whisky" e o grupo
// é "Destilados"), o filtro não vale: melhor mostrar a busca inteira do que
// esconder tudo.
function filtrarPorCategoria(produtos, categoria) {
  if (!categoria || !produtos.some((produto) => grupoBate(produto, categoria))) return produtos;
  // Os do grupo pedido vêm antes dos sem grupo, para não perderem as vagas do
  // limite de resultados.
  return [
    ...produtos.filter((produto) => grupoBate(produto, categoria)),
    ...produtos.filter((produto) => !produto?.nome_grupo),
  ];
}

// O cliente escreve as marcas como fala ("cristal" para Crystal, "heiniken",
// "budwiser", "smirnof") e a busca da API é substring literal. Para a busca
// de reserva no catálogo inteiro, cada palavra vira uma forma "como se fala"
// (y→i, k→c, w→v, ph→f, letras dobradas viram uma) e ainda aceita uma letra
// diferente nas palavras de 5 letras ou mais.
function formaFonetica(palavra) {
  return semApostrofo(palavra)
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/y/g, 'i')
    .replace(/k/g, 'c')
    .replace(/w/g, 'v')
    .replace(/(.)\1+/g, '$1');
}

function distanciaEdicao(a, b) {
  const anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = anterior[0];
    anterior[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const acima = anterior[j];
      anterior[j] = Math.min(anterior[j] + 1, anterior[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = acima;
    }
  }
  return anterior[b.length];
}

function palavraParecida(palavraTermo, palavrasNome) {
  const termo = formaFonetica(palavraTermo);
  if (!termo) return true;
  return palavrasNome.some((palavra) => {
    const nome = formaFonetica(palavra);
    if (nome.includes(termo)) return true;
    return termo.length >= 5 && distanciaEdicao(termo, nome) <= 1;
  });
}

function nomeParecido(nome, termo) {
  const palavrasNome = String(nome || '').split(/[\s'’‘`´]+/).filter(Boolean);
  const palavrasTermo = String(termo || '').split(/\s+/).filter(Boolean);
  return palavrasTermo.length > 0 && palavrasTermo.every((palavra) => palavraParecida(palavra, palavrasNome));
}

function isProductsApiConfigured() {
  return Boolean(env.gestaoClickAccessToken && env.gestaoClickSecretToken);
}

function buildHeaders() {
  return {
    'access-token': env.gestaoClickAccessToken,
    'secret-access-token': env.gestaoClickSecretToken,
  };
}

// O GestãoClick permite cadastrar mais de um valor de venda por produto
// (faixas "Pequena quantidade"/"Ofertas"). "Pequena quantidade" (valor_venda)
// é o preço normal. A faixa "Ofertas" NÃO é usada: o preço de oferta vem da
// coluna VALOR da planilha de ofertas (ofertaService.js). Ela é inconsistente:
// 179 dos 202 produtos ativos têm valor nela, e em 28 é mais caro que o
// normal (levantamento de 2026-09-29). Valor 0.00 = sem valor cadastrado.
function valorPorFaixa(produto, nomeFaixa) {
  const valores = Array.isArray(produto?.valores) ? produto.valores : [];
  const alvo = valores.find((item) => normalizeForCompare(item?.nome_tipo) === normalizeForCompare(nomeFaixa));
  const valor = Number(alvo?.valor_venda);
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

// Quantidade em estoque não vai para a IA: ela não deve informar ao cliente
// quantas unidades a loja tem. Vai só se tem ou não (em_estoque).
function normalizeProduto(produto) {
  return {
    id: produto?.id,
    nome: produto?.nome,
    codigo: produto?.codigo_interno,
    grupo: produto?.nome_grupo || null,
    ativo: produto?.ativo === '1',
    em_estoque: (Number(produto?.estoque) || 0) > 0,
    valor_venda: Number(produto?.valor_venda) || null,
    // Necessário pra fechar um orçamento no GestãoClick (POST /orcamentos
    // exige produto_id + variacao_id por item); todo produto tem ao menos
    // uma variação, mesmo sem `possui_variacao`.
    variacao_id: produto?.variacoes?.[0]?.variacao?.id || null,
  };
}

// Produto sem estoque não vai para a IA: listar o que acabou só polui a
// mensagem. Quando tudo o que bateu com o termo está zerado, a consulta avisa
// com `sem_estoque: true` (sem a lista), para a IA dizer que acabou em vez de
// tratar como produto que a loja não vende.
function comEstoqueSemLimite(produtos) {
  return produtos.map(normalizeProduto).filter((produto) => produto.em_estoque);
}

function comEstoque(produtos) {
  return comEstoqueSemLimite(produtos).slice(0, MAX_RESULTADOS);
}

async function searchProducts({ termo, categoria = null, messageId = null }) {
  const prefix = flowPrefix(messageId);

  if (!isProductsApiConfigured()) {
    console.warn(`${prefix} [produtos] API de produtos não configurada; consulta não pôde ser feita`);
    return { consultaRealizada: false, motivo: 'catálogo indisponível no momento' };
  }

  // A categoria já filtra pelo grupo; no nome ela quase nunca aparece
  // ("energetico 2l" não bate com "Furioso Melancia 2L"), então sai do termo.
  const palavrasCategoria = new Set(palavrasDaCategoria(categoria));
  const semCategoria = String(termo).split(/\s+/)
    .filter((palavra) => !palavrasDaCategoria(palavra).some((p) => palavrasCategoria.has(p)))
    .join(' ');
  const termoLimpo = stripFillerWords(semCategoria.trim() || termo);
  const tentativas = [...new Set([termoLimpo, termo.trim()])].filter(Boolean);

  // Com categoria, busca a página inteira (100) antes de filtrar: "2L" sozinho
  // passa de 30 produtos, e os do grupo pedido podem não estar nos primeiros.
  const buscarPorNome = async (nome, limite = categoria ? 100 : null) => {
    const response = await axios.get(`${GESTAOCLICK_API_BASE}/produtos`, {
      params: { nome, ativo: 1, ...(limite ? { limite } : {}) },
      headers: buildHeaders(),
      timeout: 8000,
    });
    return filtrarPorCategoria(response.data?.data || [], categoria);
  };

  try {
    for (const tentativa of tentativas) {
      const encontrados = await buscarPorNome(tentativa);
      const produtos = comEstoque(encontrados);
      console.log(`${prefix} [produtos] consulta realizada | termo="${tentativa}" | resultados=${encontrados.length} | com_estoque=${produtos.length}`);
      if (encontrados.length > 0) {
        return produtos.length > 0
          ? { consultaRealizada: true, produtos }
          : { consultaRealizada: true, produtos: [], sem_estoque: true };
      }
    }

    // Reserva para grafia diferente do cadastro (apóstrofo): busca por uma
    // palavra do termo e filtra aqui pelo termo inteiro.
    const totalPalavras = semApostrofo(termoLimpo).split(/\s+/).filter(Boolean).length;
    const candidatos = new Map();
    for (const palavra of palavrasParaBusca(termoLimpo)) {
      const encontrados = await buscarPorNome(palavra, 100);
      encontrados.forEach((produto) => candidatos.set(produto.id, produto));
      const correspondentes = encontrados.filter((produto) => palavrasEmComum(produto?.nome, termoLimpo) === totalPalavras);
      const produtos = comEstoque(correspondentes);
      console.log(`${prefix} [produtos] consulta por palavra | termo="${termoLimpo}" | palavra="${palavra}" | resultados=${correspondentes.length} | com_estoque=${produtos.length}`);
      if (correspondentes.length > 0) {
        return produtos.length > 0
          ? { consultaRealizada: true, produtos }
          : { consultaRealizada: true, produtos: [], sem_estoque: true };
      }
    }

    // Grafia diferente da marca ("cristal" para Crystal): a API não acha
    // nem por palavra, então compara com o catálogo inteiro tolerando a grafia.
    const catalogo = filtrarPorCategoria(await catalogoEmCache(), categoria);
    const porGrafia = catalogo.filter((produto) => nomeParecido(produto?.nome, termoLimpo));
    if (porGrafia.length > 0) {
      const produtos = comEstoque(porGrafia);
      console.log(`${prefix} [produtos] consulta por grafia parecida | termo="${termoLimpo}" | resultados=${porGrafia.length} | com_estoque=${produtos.length}`);
      return produtos.length > 0
        ? { consultaRealizada: true, produtos }
        : { consultaRealizada: true, produtos: [], sem_estoque: true };
    }

    // Nome diferente do cadastro (ex: "maçã verde" para "Jack Daniel's
    // Apple 1L"): devolve os produtos com estoque que mais se parecem com o
    // termo, para a IA oferecer as opções em vez de transferir para um
    // atendente.
    const pontuados = comEstoqueSemLimite([...candidatos.values()])
      .map((produto) => ({ produto, pontos: palavrasEmComum(produto.nome, termoLimpo) }));
    const melhor = Math.max(0, ...pontuados.map((item) => item.pontos));
    const parecidos = melhor > 0
      ? pontuados.filter((item) => item.pontos === melhor).map((item) => item.produto).slice(0, MAX_RESULTADOS)
      : [];
    console.log(`${prefix} [produtos] produtos parecidos | termo="${termoLimpo}" | resultados=${parecidos.length}`);
    return parecidos.length > 0
      ? { consultaRealizada: true, correspondencia_exata: false, produtos: parecidos }
      : { consultaRealizada: true, produtos: [] };
  } catch (error) {
    console.error(`${prefix} [produtos] falha ao consultar API de produtos:`, errorSummary(error));
    return { consultaRealizada: false, motivo: 'falha ao consultar o catálogo' };
  }
}

// Catálogo ativo inteiro (~200 produtos = 3 páginas de 100, ~600 ms),
// usado para cruzar a planilha de ofertas pelo código interno: a API não tem
// filtro exato por código (`codigo_interno` como parâmetro é ignorado).
async function listarCatalogoAtivo() {
  const produtos = [];
  for (let pagina = 1; pagina <= 20; pagina += 1) {
    const response = await axios.get(`${GESTAOCLICK_API_BASE}/produtos`, {
      params: { ativo: 1, limite: 100, pagina },
      headers: buildHeaders(),
      timeout: 8000,
    });
    produtos.push(...(response.data?.data || []));
    if (!response.data?.meta?.proxima_pagina) break;
  }
  return produtos;
}

// A busca por grafia parecida varre o catálogo inteiro; o cache evita três
// chamadas à API a cada erro de digitação. Estoque e preço podem ficar até
// 5 minutos atrasados só nesse caminho de reserva.
const CATALOGO_CACHE_MS = 5 * 60 * 1000;
let catalogoCache = { produtos: null, expiraEm: 0 };

async function catalogoEmCache() {
  if (catalogoCache.produtos && Date.now() < catalogoCache.expiraEm) return catalogoCache.produtos;
  const produtos = await listarCatalogoAtivo();
  catalogoCache = { produtos, expiraEm: Date.now() + CATALOGO_CACHE_MS };
  return produtos;
}

module.exports = {
  isProductsApiConfigured,
  searchProducts,
  listarCatalogoAtivo,
  normalizeProduto,
  filtrarPorCategoria,
  nomeParecido,
  valorPorFaixa,
};
