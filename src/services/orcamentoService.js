const customerService = require('./customerService');
const gestaoClickService = require('./gestaoClickService');
const { flowPrefix } = require('../utils/logContext');

// Bot.Cliente.telefone vem com DDI (jidToPhone em customerService.js), mas o
// GestãoClick guarda celular sem DDI e só casa busca por telefone nesse
// formato (ver gestaoClickService.findClienteByTelefone).
function toLocalPhone(telefoneComDdi) {
  const digits = String(telefoneComDdi || '').replace(/\D/g, '');
  return digits.startsWith('55') ? digits.slice(2) : digits;
}

// Evita cliente duplicado no GestãoClick a cada pedido do mesmo contato:
// usa o id já cacheado em Bot.Cliente se existir; senão busca por telefone
// (cobre cliente cadastrado por outro canal antes de falar com a IA) antes
// de criar um novo.
async function ensureGestaoClickCliente({ cliente, nomeOrcamento, messageId }) {
  const prefix = flowPrefix(messageId);

  if (cliente?.gestaoClickClienteId) {
    return cliente.gestaoClickClienteId;
  }

  const telefoneLocal = toLocalPhone(cliente?.telefone);
  const existente = await gestaoClickService.findClienteByTelefone(telefoneLocal);
  if (existente?.id) {
    console.log(`${prefix} [gestaoclick] cliente já cadastrado localizado pelo telefone | id=${existente.id}`);
    await customerService.setGestaoClickClienteId(cliente.id, existente.id);
    return existente.id;
  }

  const nome = nomeOrcamento || cliente?.nome || 'Cliente WhatsApp';
  const criado = await gestaoClickService.createCliente({ nome, telefoneLocal });
  console.log(`${prefix} [gestaoclick] cliente criado | id=${criado?.id} | nome="${nome}"`);
  await customerService.setGestaoClickClienteId(cliente.id, criado?.id);
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

module.exports = { registrarPedidoConfirmado };
