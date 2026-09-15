const axios = require('axios');
const env = require('../config/env');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// Contrato da API de produtos do GestãoClick (fixo por fornecedor, como as
// URLs do Google Calendar/Evolution em outros services): só os tokens variam
// por cliente, então só eles vêm do .env.
const GESTAOCLICK_API_BASE = 'https://api.gestaoclick.com/api';
const MAX_RESULTADOS = 8;

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
  };
}

async function searchProducts({ termo, messageId = null }) {
  const prefix = flowPrefix(messageId);

  if (!isProductsApiConfigured()) {
    console.warn(`${prefix} [produtos] API de produtos não configurada; consulta não pôde ser feita`);
    return { consultaRealizada: false, motivo: 'catálogo indisponível no momento' };
  }

  try {
    const response = await axios.get(`${GESTAOCLICK_API_BASE}/produtos`, {
      params: { nome: termo, ativo: 1 },
      headers: buildHeaders(),
      timeout: 8000,
    });

    const produtos = (response.data?.data || []).slice(0, MAX_RESULTADOS).map(normalizeProduto);
    console.log(`${prefix} [produtos] consulta realizada | termo="${termo}" | resultados=${produtos.length}`);
    return { consultaRealizada: true, produtos };
  } catch (error) {
    console.error(`${prefix} [produtos] falha ao consultar API de produtos:`, errorSummary(error));
    return { consultaRealizada: false, motivo: 'falha ao consultar o catálogo' };
  }
}

module.exports = {
  isProductsApiConfigured,
  searchProducts,
};
