// Guarda em memória o orçamento apresentado ao cliente enquanto aguarda a
// confirmação explícita dele antes de registrar no GestãoClick. Não precisa
// sobreviver a restart (mesmo padrão de src/services/conversationLockService.js):
// se o processo reiniciar no meio da espera, o cliente só confirma de novo.
const pendentes = new Map();

function save(clienteId, orcamento) {
  if (!clienteId) return;
  pendentes.set(clienteId, orcamento);
}

function get(clienteId) {
  if (!clienteId) return null;
  return pendentes.get(clienteId) || null;
}

function clear(clienteId) {
  if (!clienteId) return;
  pendentes.delete(clienteId);
}

module.exports = { save, get, clear };
