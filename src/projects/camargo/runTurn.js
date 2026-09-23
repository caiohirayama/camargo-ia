const customerService = require('../../services/customerService');
const evolutionService = require('../../services/evolutionService');
const telegramService = require('../../services/telegramService');
const orcamentoService = require('../../services/orcamentoService');
const pendingOrderService = require('../../services/pendingOrderService');
const { flowPrefix, maskJid, errorSummary } = require('../../utils/logContext');

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
  });

  let reply = aiResult?.replyText?.trim() || 'Só um momento, já te retorno com uma resposta certinha.';
  let transferirHumano = Boolean(aiResult?.transferToHuman);

  if (await customerService.isPaused(cliente?.id)) {
    console.log(`${flowPrefix(messageId)} [camargo] IA pausada durante a geração | sender=${maskJid(sender)} | resposta descartada`);
    return;
  }

  // O orçamento só é apresentado (confirmarPedido false) ou confirmado
  // (confirmarPedido true) nunca os dois na mesma mensagem — ver
  // camargo_agent_prompt.md, seção "Confirmação do pedido". Só na confirmação
  // é que o cliente/orçamento realmente entram no GestãoClick.
  let pedidoRegistrado = null;
  let orcamentoConfirmado = null;
  let falhaAoRegistrarPedido = false;

  if (aiResult?.confirmarPedido) {
    const orcamentoPendente = pendingOrderService.get(cliente?.id);
    if (orcamentoPendente) {
      try {
        pedidoRegistrado = await orcamentoService.registrarPedidoConfirmado({
          cliente,
          orcamento: orcamentoPendente,
          messageId,
        });
        orcamentoConfirmado = orcamentoPendente;
        pendingOrderService.clear(cliente?.id);
      } catch (error) {
        falhaAoRegistrarPedido = true;
        console.error(`${flowPrefix(messageId)} [camargo] falha ao registrar pedido confirmado no GestãoClick:`, errorSummary(error));
      }
    } else {
      falhaAoRegistrarPedido = true;
      console.warn(`${flowPrefix(messageId)} [camargo] cliente confirmou mas não havia orçamento pendente em memória (ex: restart do processo no meio da espera)`);
    }

    if (falhaAoRegistrarPedido) {
      reply = 'Só um momento, já te retorno com uma resposta certinha.';
      transferirHumano = true;
    }
  } else if (aiResult?.orcamento) {
    pendingOrderService.save(cliente?.id, aiResult.orcamento);
  }

  if (transferirHumano) {
    await customerService.pause(cliente?.id);
    await telegramService.notifyAttendant({
      sender,
      motivo: falhaAoRegistrarPedido
        ? 'Cliente confirmou o pedido, mas houve falha ao registrar no GestãoClick.'
        : 'IA transferiu a conversa para atendimento pessoal.',
      mensagem: combinedText,
      pausado: true,
    });
  }

  const chunks = splitReplyIntoChunks(reply);
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
    await telegramService.notifyOrcamento({
      sender,
      orcamento: orcamentoConfirmado,
      pedidoGestaoClick: pedidoRegistrado,
    });
  }

  console.log(`${flowPrefix(messageId)} [camargo] turno concluído | bolhas=${chunks.length} | transferirHumano=${transferirHumano} | pedidoRegistrado=${Boolean(pedidoRegistrado)}`);
}

module.exports = { runTurn };
