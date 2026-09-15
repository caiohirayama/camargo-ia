const customerService = require('../../services/customerService');
const evolutionService = require('../../services/evolutionService');
const telegramService = require('../../services/telegramService');
const { flowPrefix, maskJid } = require('../../utils/logContext');

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

  const reply = aiResult?.replyText?.trim() || 'Só um momento, já te retorno com uma resposta certinha.';
  const transferirHumano = Boolean(aiResult?.transferToHuman);

  if (await customerService.isPaused(cliente?.id)) {
    console.log(`${flowPrefix(messageId)} [camargo] IA pausada durante a geração | sender=${maskJid(sender)} | resposta descartada`);
    return;
  }

  if (transferirHumano) {
    await customerService.pause(cliente?.id);
    await telegramService.notifyAttendant({
      sender,
      motivo: 'IA transferiu a conversa para atendimento pessoal.',
      mensagem: combinedText,
      pausado: true,
    });
  }

  const chunks = splitReplyIntoChunks(reply);
  let bolhasEnviadas = true;
  for (const chunk of chunks) {
    // Se transferirHumano é true, a pausa acima foi causada por este próprio turno
    // (handoff intencional) — não é o atendente assumindo no meio do envio, então
    // a resposta final deve sair inteira mesmo assim.
    if (!transferirHumano && await customerService.isPaused(cliente?.id)) {
      console.log(`${flowPrefix(messageId)} [camargo] atendente assumiu durante o envio | sender=${maskJid(sender)} | bolhas restantes descartadas`);
      bolhasEnviadas = false;
      break;
    }
    await evolutionService.sendText({
      instanceName,
      remoteJid: sender,
      text: chunk,
      correlationId: messageId,
    });
  }

  // Só notifica o orçamento se a confirmação realmente chegou ao cliente.
  if (bolhasEnviadas && aiResult?.orcamento) {
    await telegramService.notifyOrcamento({ sender, orcamento: aiResult.orcamento });
  }

  console.log(`${flowPrefix(messageId)} [camargo] turno concluído | bolhas=${chunks.length} | transferirHumano=${transferirHumano} | orcamentoFechado=${Boolean(aiResult?.orcamento)}`);
}

module.exports = { runTurn };
