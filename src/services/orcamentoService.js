const customerService = require('./customerService');
const gestaoClickService = require('./gestaoClickService');
const { flowPrefix, errorSummary } = require('../utils/logContext');

// Bot.Cliente.telefone vem com DDI (jidToPhone em customerService.js), mas o
// GestãoClick guarda celular sem DDI e só casa busca por telefone nesse
// formato (ver gestaoClickService.findClienteByTelefone). Contato que chega
// só como @lid tem em `telefone` o identificador do WhatsApp, não o número:
// ele não vira telefone (null), senão o GestãoClick descarta e o cliente
// fica cadastrado sem telefone.
function toLocalPhone(telefone) {
  const digits = String(telefone || '').replace(/\D/g, '');
  const local = /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
  return /^[1-9]{2}9?\d{8}$/.test(local) ? local : null;
}

// Telefone do contato no WhatsApp ou, se ele chegou só como @lid, o que o
// cliente informou no cadastro.
function telefoneDoCliente(cliente, dadosCliente) {
  return toLocalPhone(cliente?.telefone) || toLocalPhone(dadosCliente?.telefone);
}

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

// "19991957082" -> "(19)99195-7082", mesmo formato dos cadastros da loja.
function formatarTelefone(local) {
  const match = String(local).match(/^(\d{2})(\d{4,5})(\d{4})$/);
  return match ? `(${match[1]})${match[2]}-${match[3]}` : local;
}

// Cliente que já existe no GestãoClick é completado com o que faltar no
// cadastro (telefone, CPF/CNPJ, nome), sem sobrescrever o que a loja já
// preencheu. Falha aqui não impede o pedido: só fica no log.
async function completarCadastroExistente({ gestaoClickClienteId, cliente, dadosCliente, messageId }) {
  const prefix = flowPrefix(messageId);
  try {
    const atual = await gestaoClickService.getCliente(gestaoClickClienteId);
    if (!atual) return;

    const alteracoes = {};
    const telefone = telefoneDoCliente(cliente, dadosCliente);
    const telefonesCadastrados = [somenteDigitos(atual.celular), somenteDigitos(atual.telefone)];
    if (telefone && !telefonesCadastrados.includes(telefone)) {
      if (!atual.celular) alteracoes.celular = formatarTelefone(telefone);
      else if (!atual.telefone) alteracoes.telefone = formatarTelefone(telefone);
    }

    if (dadosCliente?.tipo_pessoa && dadosCliente.tipo_pessoa === atual.tipo_pessoa) {
      if (dadosCliente.tipo_pessoa === 'PF') {
        if (!atual.cpf && dadosCliente.cpf) alteracoes.cpf = dadosCliente.cpf;
        if ((!atual.nome || atual.nome === 'Cliente WhatsApp') && dadosCliente.nome) alteracoes.nome = dadosCliente.nome;
      } else {
        if (!atual.cnpj && dadosCliente.cnpj) alteracoes.cnpj = dadosCliente.cnpj;
        if (!atual.razao_social && dadosCliente.razao_social) alteracoes.razao_social = dadosCliente.razao_social;
      }
    }

    const campos = Object.keys(alteracoes);
    if (!campos.length) return;
    await gestaoClickService.updateCliente(atual, alteracoes);
    console.log(`${prefix} [gestaoclick] cadastro existente atualizado | id=${gestaoClickClienteId} | campos=${campos.join(',')}`);
  } catch (error) {
    console.error(`${prefix} [gestaoclick] falha ao atualizar cadastro existente | id=${gestaoClickClienteId}:`, errorSummary(error));
  }
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

  const telefoneLocal = telefoneDoCliente(cliente, dadosCliente);
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

// Contato que chegou só como @lid e ainda não tem cadastro ligado: a IA pede
// o telefone junto com os dados de cadastro.
function precisaTelefone({ cliente, dadosCliente }) {
  return !cliente?.gestaoClickClienteId && !telefoneDoCliente(cliente, dadosCliente);
}

async function ensureGestaoClickCliente({ cliente, dadosCliente, nomeOrcamento, messageId }) {
  const prefix = flowPrefix(messageId);

  const existenteId = await localizarClienteExistente({ cliente, dadosCliente, messageId });
  if (existenteId) {
    await completarCadastroExistente({ gestaoClickClienteId: existenteId, cliente, dadosCliente, messageId });
    return existenteId;
  }

  // Cliente novo nunca é cadastrado sem tipo de pessoa e documento.
  if (!dadosCliente?.tipo_pessoa) {
    throw new DadosCadastroPendentesError();
  }

  const telefoneLocal = telefoneDoCliente(cliente, dadosCliente);
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
  console.log(`${prefix} [gestaoclick] cliente criado | id=${criado?.id} | tipo=${dadosCliente.tipo_pessoa} | nome="${nome}" | telefone=${telefoneLocal ? 'sim' : 'não'}`);
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
  precisaTelefone,
  toLocalPhone,
  DadosCadastroPendentesError,
};
