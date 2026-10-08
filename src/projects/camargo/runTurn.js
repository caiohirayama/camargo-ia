const customerService = require('../../services/customerService');
const evolutionService = require('../../services/evolutionService');
const notificationService = require('../../services/notificationService');
const orcamentoService = require('../../services/orcamentoService');
const cartService = require('../../services/cartService');
const { flowPrefix, maskJid, errorSummary } = require('../../utils/logContext');

// Última linha da saudação de abertura do prompt (camargo_agent_prompt.md).
const FIM_DA_SAUDACAO = 'Pode mandar sua lista por aqui!';

// A IA separa partes que devem virar bolhas distintas no WhatsApp com uma
// linha em branco. Cada parte é enviada em uma chamada própria, o que já
// aciona a simulação de digitação (presença "composing" + delay) por bolha.
function splitReplyIntoChunks(reply) {
  const chunks = String(reply || '')
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : [String(reply || '').trim()].filter(Boolean);
}

async function runTurn({ cliente, history = [], combinedText, instanceName, sender, messageId = null }) {
  // Deferred to avoid the aiService -> registry -> project cycle during startup.
  const aiService = require('../../services/aiService');
  const aiResult = await aiService.generateReply({
    history,
    userText: combinedText,
    instanceName,
    messageId,
    clienteId: cliente?.id,
    cliente,
  });

  let reply = aiResult?.replyText?.trim() || 'Só um momento, já te retorno com uma resposta certinha.';
  let transferirHumano = Boolean(aiResult?.transferToHuman);

  if (await customerService.isPaused(cliente?.id)) {
    console.log(`${flowPrefix(messageId)} [camargo] IA pausada durante a geração | sender=${maskJid(sender)} | resposta descartada`);
    return;
  }

  // O carrinho (cartService) é a fonte real dos itens — a IA adiciona cada
  // item confirmado via tool call durante a conversa (aiService.js), nunca
  // reconstrói a lista de memória. O orçamento só é apresentado
  // (confirmarPedido false) ou confirmado (confirmarPedido true), nunca os
  // dois na mesma mensagem — ver camargo_agent_prompt.md, seção "Confirmação
  // do pedido". Só na confirmação é que o cliente/orçamento realmente entram
  // no GestãoClick.
  let pedidoRegistrado = null;
  let orcamentoConfirmado = null;
  let falhaAoRegistrarPedido = false;
  let dadosCadastroPendentes = false;

  if (aiResult?.confirmarPedido) {
    const itensCarrinho = cartService.getItens(cliente?.id);
    if (itensCarrinho.length > 0) {
      const orcamentoPendente = {
        nome_cliente: cartService.getNomeCliente(cliente?.id),
        dados_cliente: cartService.getDadosCliente(cliente?.id),
        itens: itensCarrinho,
        valor_total_geral: cartService.calcularTotal(itensCarrinho),
      };
      try {
        pedidoRegistrado = await orcamentoService.registrarPedidoConfirmado({
          cliente,
          orcamento: orcamentoPendente,
          messageId,
        });
        orcamentoConfirmado = orcamentoPendente;
        cartService.limpar(cliente?.id);
      } catch (error) {
        if (error instanceof orcamentoService.DadosCadastroPendentesError) {
          // Trava do servidor: cliente novo não é cadastrado sem tipo de
          // pessoa e documento, mesmo se a IA pular essa etapa. O carrinho
          // fica intacto e o pedido é registrado depois que o cliente
          // informar os dados e confirmar de novo.
          dadosCadastroPendentes = true;
          console.warn(`${flowPrefix(messageId)} [camargo] confirmação sem dados de cadastro de cliente novo | pedido não registrado, pedindo os dados`);
        } else {
          falhaAoRegistrarPedido = true;
          console.error(`${flowPrefix(messageId)} [camargo] falha ao registrar pedido confirmado no GestãoClick:`, errorSummary(error));
        }
      }
    } else {
      falhaAoRegistrarPedido = true;
      console.warn(`${flowPrefix(messageId)} [camargo] cliente confirmou mas o carrinho está vazio (ex: restart do processo no meio da espera)`);
    }

    if (dadosCadastroPendentes) {
      reply = 'Antes de confirmar, preciso de alguns dados para o cadastro.\n\nO pedido é para pessoa física ou jurídica?';
      transferirHumano = false;
    } else if (falhaAoRegistrarPedido) {
      reply = 'Só um momento, já te retorno com uma resposta certinha.';
      transferirHumano = true;
    }
  } else if (aiResult?.orcamento?.nome_cliente) {
    cartService.definirNomeCliente(cliente?.id, aiResult.orcamento.nome_cliente);
  }

  if (transferirHumano) {
    await customerService.pause(cliente?.id);
    await notificationService.notifyAttendant({
      sender,
      motivo: falhaAoRegistrarPedido
        ? 'Cliente confirmou o pedido, mas houve falha ao registrar no GestãoClick.'
        : 'IA transferiu a conversa para atendimento pessoal.',
      mensagem: combinedText,
      pausado: true,
    });
  }

  // Saudação, lista de ofertas e resumo do pedido vão inteiros numa mensagem
  // só (pedido da loja), mesmo com linhas em branco separando os blocos. A
  // saudação completa é reconhecida aqui também, caso a IA não marque
  // mensagem_unica.
  const mensagemUnica = aiResult?.mensagemUnica || reply.includes(FIM_DA_SAUDACAO);
  const chunks = mensagemUnica && !falhaAoRegistrarPedido && !dadosCadastroPendentes
    ? [reply.trim()].filter(Boolean)
    : splitReplyIntoChunks(reply);
  for (const chunk of chunks) {
    // Se transferirHumano é true, a pausa acima foi causada por este próprio turno
    // (handoff intencional) — não é o atendente assumindo no meio do envio, então
    // a resposta final deve sair inteira mesmo assim.
    if (!transferirHumano && await customerService.isPaused(cliente?.id)) {
      console.log(`${flowPrefix(messageId)} [camargo] atendente assumiu durante o envio | sender=${maskJid(sender)} | bolhas restantes descartadas`);
      break;
    }
    await evolutionService.sendText({
      instanceName,
      remoteJid: sender,
      text: chunk,
      correlationId: messageId,
    });
  }

  // Notifica sempre que o pedido foi registrado no GestãoClick, mesmo que o
  // atendente tenha assumido a conversa no meio do envio (bolhasEnviadas
  // false): o pedido já é real no sistema, Felipe precisa saber de qualquer
  // jeito.
  if (pedidoRegistrado) {
    await notificationService.notifyOrcamento({
      sender,
      orcamento: orcamentoConfirmado,
      pedidoGestaoClick: pedidoRegistrado,
    });
  }

  console.log(`${flowPrefix(messageId)} [camargo] turno concluído | bolhas=${chunks.length} | transferirHumano=${transferirHumano} | pedidoRegistrado=${Boolean(pedidoRegistrado)}`);
}

module.exports = { runTurn };
