const customerService = require('./customerService');
const gestaoClickService = require('./gestaoClickService');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// Bot.Cliente.telefone vem com DDI (jidToPhone em customerService.js), mas o
// GestãoClick guarda celular sem DDI e só casa busca por telefone nesse
// formato (ver gestaoClickService.findClienteByTelefone).
function toLocalPhone(telefoneComDdi) {
  const digits = String(telefoneComDdi || '').replace(/\D/g, '');
  return digits.startsWith('55') ? digits.slice(2) : digits;
}

// Erro esperado (não é falha de integração): o cliente ainda não existe no
// GestãoClick e os dados de cadastro não foram coletados. runTurn trata
// pedindo os dados em vez de transferir para um atendente.
class DadosCadastroPendentesError extends Error {
  constructor() {
    super('dados de cadastro do cliente não informados');
    this.name = 'DadosCadastroPendentesError';
  }
}

// Evita cliente duplicado no GestãoClick a cada pedido do mesmo contato:
// usa o id já cacheado em Bot.Cliente se existir; senão busca por telefone
// (cobre cliente cadastrado por outro canal antes de falar com a IA) e, se
// já houver CPF/CNPJ informado, pelo documento. Retorna null se não achar.
async function localizarClienteExistente({ cliente, dadosCliente, messageId }) {
  const prefix = flowPrefix(messageId);

  if (cliente?.gestaoClickClienteId) {
    return cliente.gestaoClickClienteId;
  }

  const telefoneLocal = toLocalPhone(cliente?.telefone);
  const porTelefone = await gestaoClickService.findClienteByTelefone(telefoneLocal);
  if (porTelefone?.id) {
    console.log(`${prefix} [gestaoclick] cliente já cadastrado localizado pelo telefone | id=${porTelefone.id}`);
    await customerService.setGestaoClickClienteId(cliente?.id, porTelefone.id);
    return porTelefone.id;
  }

  const documento = dadosCliente?.tipo_pessoa === 'PJ' ? dadosCliente?.cnpj : dadosCliente?.cpf;
  const porDocumento = await gestaoClickService.findClienteByDocumento(documento);
  if (porDocumento?.id) {
    console.log(`${prefix} [gestaoclick] cliente já cadastrado localizado pelo CPF/CNPJ | id=${porDocumento.id}`);
    await customerService.setGestaoClickClienteId(cliente?.id, porDocumento.id);
    return porDocumento.id;
  }

  return null;
}

// Usado antes do resumo do pedido (tool consultar_carrinho) para a IA saber
// se precisa coletar tipo de pessoa e CPF/nome ou CNPJ. Se a consulta ao
// GestãoClick falhar, pede os dados mesmo assim: é o lado seguro, e o
// documento ainda serve para achar o cadastro na hora de registrar.
async function precisaDadosCadastro({ cliente, dadosCliente, messageId }) {
  if (dadosCliente) return false;
  if (!gestaoClickService.isConfigured()) return false;

  try {
    return !(await localizarClienteExistente({ cliente, dadosCliente: null, messageId }));
  } catch (error) {
    console.error(`${flowPrefix(messageId)} [gestaoclick] falha ao verificar cadastro do cliente:`, errorSummary(error));
    return true;
  }
}

async function ensureGestaoClickCliente({ cliente, dadosCliente, nomeOrcamento, messageId }) {
  const prefix = flowPrefix(messageId);

  const existenteId = await localizarClienteExistente({ cliente, dadosCliente, messageId });
  if (existenteId) return existenteId;

  // Cliente novo nunca é cadastrado sem tipo de pessoa e documento.
  if (!dadosCliente?.tipo_pessoa) {
    throw new DadosCadastroPendentesError();
  }

  const telefoneLocal = toLocalPhone(cliente?.telefone);
  const nome = dadosCliente.tipo_pessoa === 'PJ'
    ? dadosCliente.nome_fantasia || dadosCliente.razao_social || nomeOrcamento || cliente?.nome || 'Cliente WhatsApp'
    : dadosCliente.nome;

  const criado = await gestaoClickService.createCliente({
    tipoPessoa: dadosCliente.tipo_pessoa,
    nome,
    cpf: dadosCliente.cpf,
    cnpj: dadosCliente.cnpj,
    razaoSocial: dadosCliente.razao_social,
    telefoneLocal,
  });
  console.log(`${prefix} [gestaoclick] cliente criado | id=${criado?.id} | tipo=${dadosCliente.tipo_pessoa} | nome="${nome}"`);
  await customerService.setGestaoClickClienteId(cliente?.id, criado?.id);
  return criado?.id;
}

// Chamado só depois que o cliente confirmou explicitamente o orçamento
// apresentado (ver camargo_agent_prompt.md, seção "Confirmação do pedido").
async function registrarPedidoConfirmado({ cliente, orcamento, messageId }) {
  const prefix = flowPrefix(messageId);

  if (!gestaoClickService.isConfigured()) {
    throw new Error('API do GestãoClick não configurada');
  }
  if (!orcamento?.itens?.length) {
    throw new Error('orçamento pendente sem itens');
  }

  const gestaoClickClienteId = await ensureGestaoClickCliente({
    cliente,
    dadosCliente: orcamento.dados_cliente,
    nomeOrcamento: orcamento.nome_cliente,
    messageId,
  });

  const pedido = await gestaoClickService.createOrcamento({
    clienteId: gestaoClickClienteId,
    itens: orcamento.itens,
    observacoes: 'Pedido confirmado via WhatsApp (IA).',
  });

  console.log(`${prefix} [gestaoclick] orçamento criado | id=${pedido?.id} | codigo=${pedido?.codigo} | total=${pedido?.valor_total}`);
  return pedido;
}

module.exports = {
  registrarPedidoConfirmado,
  precisaDadosCadastro,
  DadosCadastroPendentesError,
};
