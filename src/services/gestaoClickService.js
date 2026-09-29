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

// `cpf_cnpj` filtra de verdade (aceita com ou sem máscara), ao contrário de
// `cpf`/`cnpj` separados, que são ignorados e devolvem a listagem inteira
// — confirmado contra a API real.
async function findClienteByDocumento(documento) {
  if (!documento) return null;

  const response = await axios.get(`${GESTAOCLICK_API_BASE}/clientes`, {
    params: { cpf_cnpj: documento },
    headers: buildHeaders(),
    timeout: 8000,
  });

  return response.data?.data?.[0] || null;
}

// Só `tipo_pessoa` e `nome` são obrigatórios na API; CPF/CNPJ e razão
// social vão formatados, no mesmo padrão dos cadastros já existentes.
async function createCliente({ tipoPessoa, nome, cpf, cnpj, razaoSocial, telefoneLocal }) {
  const response = await axios.post(
    `${GESTAOCLICK_API_BASE}/clientes`,
    {
      tipo_pessoa: tipoPessoa === 'PJ' ? 'PJ' : 'PF',
      nome: nome || 'Cliente WhatsApp',
      cpf: tipoPessoa === 'PJ' ? undefined : cpf || undefined,
      cnpj: tipoPessoa === 'PJ' ? cnpj || undefined : undefined,
      razao_social: tipoPessoa === 'PJ' ? razaoSocial || undefined : undefined,
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
  findClienteByDocumento,
  createCliente,
  createOrcamento,
};
