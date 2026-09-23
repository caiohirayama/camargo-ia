const axios = require('axios');
const env = require('../config/env');

// Contrato da API do GestãoClick (fixo por fornecedor): só os tokens variam
// por cliente. Ver src/services/productService.js para o mesmo padrão.
const GESTAOCLICK_API_BASE = 'https://api.gestaoclick.com/api';

function isConfigured() {
  return Boolean(env.gestaoClickAccessToken && env.gestaoClickSecretToken);
}

function buildHeaders() {
  return {
    'access-token': env.gestaoClickAccessToken,
    'secret-access-token': env.gestaoClickSecretToken,
  };
}

// O parâmetro `telefone` casa contra `celular` OU `telefone` cadastrados,
// ignorando formatação (parênteses, traço) — mas exige o número sem o DDI
// (ex: "19991957082", não "5519991957082"), confirmado contra a API real.
// `celular`/`email` como parâmetro de busca são ignorados pela API (retornam
// a listagem inteira sem filtrar).
async function findClienteByTelefone(telefoneLocal) {
  if (!telefoneLocal) return null;

  const response = await axios.get(`${GESTAOCLICK_API_BASE}/clientes`, {
    params: { telefone: telefoneLocal },
    headers: buildHeaders(),
    timeout: 8000,
  });

  return response.data?.data?.[0] || null;
}

// Único campo realmente obrigatório além de `nome` é `tipo_pessoa`. Contato
// vindo do WhatsApp sempre entra como PF (a loja não pede CNPJ nesse canal).
async function createCliente({ nome, telefoneLocal }) {
  const response = await axios.post(
    `${GESTAOCLICK_API_BASE}/clientes`,
    {
      tipo_pessoa: 'PF',
      nome: nome || 'Cliente WhatsApp',
      celular: telefoneLocal || undefined,
    },
    { headers: buildHeaders(), timeout: 8000 },
  );

  return response.data?.data;
}

// vendedor_id fica de fora de propósito: a API já preenche com o dono do
// token quando omitido. Canal de venda não tem endpoint de listagem, então
// fica no padrão ("Presencial"). valor_venda de cada item precisa ser
// enviado explicitamente — se omitido, a API cria o item com valor zero em
// vez de puxar o preço do catálogo.
async function createOrcamento({ clienteId, itens, observacoes }) {
  const produtos = (itens || []).map((item) => ({
    produto_id: item.produto_id,
    variacao_id: item.variacao_id,
    quantidade: item.quantidade,
    valor_venda: item.valor_unitario,
  }));

  const response = await axios.post(
    `${GESTAOCLICK_API_BASE}/orcamentos`,
    {
      cliente_id: clienteId,
      data: new Date().toISOString().slice(0, 10),
      observacoes: observacoes || 'Pedido confirmado via WhatsApp (IA).',
      produtos,
    },
    { headers: buildHeaders(), timeout: 8000 },
  );

  return response.data?.data;
}

module.exports = {
  isConfigured,
  findClienteByTelefone,
  createCliente,
  createOrcamento,
};
