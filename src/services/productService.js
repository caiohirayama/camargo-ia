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

function isProductsApiConfigured() {
  return Boolean(env.gestaoClickAccessToken && env.gestaoClickSecretToken);
}

function buildHeaders() {
  return {
    'access-token': env.gestaoClickAccessToken,
    'secret-access-token': env.gestaoClickSecretToken,
  };
}

// O GestãoClick permite cadastrar mais de um valor de venda por produto (ex:
// faixas "Pequena quantidade"/"Ofertas"), mas quem decide se um pedido tem
// direito a uma condição diferente da padrão é um atendente, não a IA — por
// isso só expomos o valor_venda padrão (a faixa "Pequena quantidade").
function normalizeProduto(produto) {
  return {
    id: produto?.id,
    nome: produto?.nome,
    codigo: produto?.codigo_interno,
    ativo: produto?.ativo === '1',
    estoque: Number(produto?.estoque) || 0,
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

  try {
    for (const tentativa of tentativas) {
      const response = await axios.get(`${GESTAOCLICK_API_BASE}/produtos`, {
        params: { nome: tentativa, ativo: 1 },
        headers: buildHeaders(),
        timeout: 8000,
      });

      const produtos = (response.data?.data || []).slice(0, MAX_RESULTADOS).map(normalizeProduto);
      console.log(`${prefix} [produtos] consulta realizada | termo="${tentativa}" | resultados=${produtos.length}`);
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

module.exports = {
  isProductsApiConfigured,
  searchProducts,
};
