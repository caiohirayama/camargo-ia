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

// Produto bate com o termo se contém todas as palavras dele, ignorando
// acento, caixa e apóstrofo.
function nomeContemTermo(nome, termo) {
  const nomeComparavel = semApostrofo(nome);
  return semApostrofo(termo).split(/\s+/).filter(Boolean).every((palavra) => nomeComparavel.includes(palavra));
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
    ativo: produto?.ativo === '1',
    em_estoque: (Number(produto?.estoque) || 0) > 0,
    valor_venda: Number(produto?.valor_venda) || null,
    // Necessário pra fechar um orçamento no GestãoClick (POST /orcamentos
    // exige produto_id + variacao_id por item); todo produto tem ao menos
    // uma variação, mesmo sem `possui_variacao`.
    variacao_id: produto?.variacoes?.[0]?.variacao?.id || null,
  };
}

async function searchProducts({ termo, messageId = null }) {
  const prefix = flowPrefix(messageId);

  if (!isProductsApiConfigured()) {
    console.warn(`${prefix} [produtos] API de produtos não configurada; consulta não pôde ser feita`);
    return { consultaRealizada: false, motivo: 'catálogo indisponível no momento' };
  }

  const termoLimpo = stripFillerWords(termo);
  const tentativas = [...new Set([termoLimpo, termo.trim()])].filter(Boolean);

  const buscarPorNome = async (nome, limite) => {
    const response = await axios.get(`${GESTAOCLICK_API_BASE}/produtos`, {
      params: { nome, ativo: 1, ...(limite ? { limite } : {}) },
      headers: buildHeaders(),
      timeout: 8000,
    });
    return response.data?.data || [];
  };

  try {
    for (const tentativa of tentativas) {
      const produtos = (await buscarPorNome(tentativa))
        .map(normalizeProduto)
        .slice(0, MAX_RESULTADOS);
      console.log(`${prefix} [produtos] consulta realizada | termo="${tentativa}" | resultados=${produtos.length}`);
      if (produtos.length > 0) {
        return { consultaRealizada: true, produtos };
      }
    }

    // Reserva para grafia diferente do cadastro (apóstrofo): busca por uma
    // palavra do termo e filtra aqui pelo termo inteiro.
    for (const palavra of palavrasParaBusca(termoLimpo)) {
      const produtos = (await buscarPorNome(palavra, 100))
        .filter((produto) => nomeContemTermo(produto?.nome, termoLimpo))
        .map(normalizeProduto)
        .slice(0, MAX_RESULTADOS);
      console.log(`${prefix} [produtos] consulta por palavra | termo="${termoLimpo}" | palavra="${palavra}" | resultados=${produtos.length}`);
      if (produtos.length > 0) {
        return { consultaRealizada: true, produtos };
      }
    }

    return { consultaRealizada: true, produtos: [] };
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

module.exports = {
  isProductsApiConfigured,
  searchProducts,
  listarCatalogoAtivo,
  normalizeProduto,
  valorPorFaixa,
};
