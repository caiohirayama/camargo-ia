const axios = require('axios');
const { onlyDigits } = require('../utils/documento');
const { errorSummary } = require('../utils/logContext');

// BrasilAPI (pública, sem token): o GestãoClick exige `nome` no cadastro, mas
// de pessoa jurídica a loja só pede o CNPJ — a razão social e o nome
// fantasia vêm daqui. Responde 400 para CNPJ inexistente/inválido.
const BRASIL_API_CNPJ_URL = 'https://brasilapi.com.br/api/cnpj/v1';

// Retorna { encontrado: true, razao_social, nome_fantasia, situacao },
// { encontrado: false } quando a Receita não conhece o CNPJ, ou null quando a
// consulta não pôde ser feita (quem chama decide seguir sem os dados).
async function consultarCnpj(cnpj) {
  try {
    const response = await axios.get(`${BRASIL_API_CNPJ_URL}/${onlyDigits(cnpj)}`, { timeout: 8000 });
    const data = response.data || {};
    return {
      encontrado: true,
      razao_social: data.razao_social || null,
      nome_fantasia: data.nome_fantasia || null,
      situacao: data.descricao_situacao_cadastral || null,
    };
  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 404) {
      return { encontrado: false };
    }
    console.error('[cnpj] falha ao consultar BrasilAPI:', errorSummary(error));
    return null;
  }
}

module.exports = { consultarCnpj };
