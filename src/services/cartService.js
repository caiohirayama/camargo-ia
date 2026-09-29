// Carrinho de itens confirmados durante a conversa, guardado em memória por
// clienteId — mesmo raciocínio de nunca informar preço de memória, aplicado
// à lista de itens: cada item confirmado é adicionado aqui via tool call
// (ver aiService.js, `adicionar_item_carrinho`), e o resumo final sempre
// relê esse estado (`consultar_carrinho`), nunca reconstrói a partir do
// texto da conversa. Não precisa sobreviver a restart, mesmo padrão de
// conversationLockService.js.
const carrinhos = new Map();

function getEstado(clienteId) {
  return carrinhos.get(clienteId) || { itens: [], nomeCliente: null, dadosCliente: null };
}

function getItens(clienteId) {
  if (!clienteId) return [];
  return getEstado(clienteId).itens;
}

function adicionarItem(clienteId, item) {
  if (!clienteId) return [];
  const estado = getEstado(clienteId);
  const itens = [...estado.itens, item];
  carrinhos.set(clienteId, { ...estado, itens });
  return itens;
}

function definirNomeCliente(clienteId, nome) {
  if (!clienteId || !nome) return;
  const estado = getEstado(clienteId);
  carrinhos.set(clienteId, { ...estado, nomeCliente: nome });
}

function getNomeCliente(clienteId) {
  if (!clienteId) return null;
  return getEstado(clienteId).nomeCliente;
}

// Dados de cadastro (tipo de pessoa + CPF/nome ou CNPJ) coletados antes de
// cadastrar um cliente novo no GestãoClick — mesmo motivo dos itens: a IA
// registra via tool call (`registrar_dados_cliente`) assim que o cliente
// informa, e o cadastro lê daqui, nunca do texto da conversa.
function definirDadosCliente(clienteId, dados) {
  if (!clienteId || !dados) return;
  const estado = getEstado(clienteId);
  carrinhos.set(clienteId, { ...estado, dadosCliente: dados });
}

function getDadosCliente(clienteId) {
  if (!clienteId) return null;
  return getEstado(clienteId).dadosCliente;
}

// Usado quando o cliente refaz a lista (tool `limpar_carrinho`): tira só os
// itens, sem perder nome/dados de cadastro já informados na conversa.
function limparItens(clienteId) {
  if (!clienteId) return;
  const estado = getEstado(clienteId);
  carrinhos.set(clienteId, { ...estado, itens: [] });
}

function limpar(clienteId) {
  if (!clienteId) return;
  carrinhos.delete(clienteId);
}

function calcularTotal(itens) {
  return (itens || []).reduce((total, item) => total + (Number(item.valor_total) || 0), 0);
}

module.exports = {
  getItens,
  adicionarItem,
  definirNomeCliente,
  getNomeCliente,
  definirDadosCliente,
  getDadosCliente,
  limparItens,
  limpar,
  calcularTotal,
};
