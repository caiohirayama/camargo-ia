const env = require('../config/env');
const evolutionService = require('./evolutionService');
const telegramService = require('./telegramService');
const { errorSummary } = require('../utils/logContext');

// Avisos para a equipe da loja (cliente transferido, pedido confirmado) vão
// para o grupo de WhatsApp configurado em WHATSAPP_NOTIFICATION_GROUP_JID.
// Sem o grupo configurado, caem no Telegram como antes. Alerta de queda da
// conexão do WhatsApp continua só no Telegram (telegramService.sendAlert):
// com o WhatsApp desconectado, um aviso pelo próprio WhatsApp não chegaria.

function formatarReais(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return '-';
  return `R$ ${numero.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

// "5519999999999@s.whatsapp.net" -> "+55 19 99999-9999"; @lid e outros
// formatos ficam como vieram (não dá pra derivar o telefone deles).
function formatarContato(sender) {
  const jid = String(sender || '');
  const match = jid.match(/^(55)(\d{2})(\d{4,5})(\d{4})@s\.whatsapp\.net$/);
  if (!match) return jid || 'desconhecido';
  const [, ddi, ddd, parte1, parte2] = match;
  return `+${ddi} ${ddd} ${parte1}-${parte2}`;
}

function grupoConfigurado() {
  return Boolean(env.whatsappNotificationGroupJid);
}

async function enviarParaGrupo(text, contexto) {
  try {
    await evolutionService.sendNotificationText({ remoteJid: env.whatsappNotificationGroupJid, text });
  } catch (error) {
    console.error(`[notificacao] falha ao enviar ${contexto} para o grupo de WhatsApp:`, errorSummary(error));
  }
}

async function notifyAttendant({ sender, motivo, mensagem, pausado }) {
  if (!grupoConfigurado()) {
    return telegramService.notifyAttendant({ sender, motivo, mensagem, pausado });
  }

  const text = [
    '📣 *Atenção necessária*',
    `Cliente: ${formatarContato(sender)}`,
    `Motivo: ${motivo || 'não informado'}`,
    pausado ? 'A IA pausou essa conversa.' : 'A IA segue atendendo normalmente.',
    mensagem ? `Última mensagem: ${mensagem}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  await enviarParaGrupo(text, 'aviso de atendimento');
}

async function notifyOrcamento({ sender, orcamento, pedidoGestaoClick }) {
  if (!grupoConfigurado()) {
    return telegramService.notifyOrcamento({ sender, orcamento, pedidoGestaoClick });
  }

  const itens = Array.isArray(orcamento?.itens) ? orcamento.itens : [];
  const linhasItens = itens.map((item) => `• ${item.quantidade} ${item.unidade} de ${item.produto}: ${formatarReais(item.valor_total)}${item.em_oferta ? ' (oferta)' : ''}`);

  const text = [
    '🧾 *Pedido confirmado pelo cliente*',
    `Cliente: ${orcamento?.nome_cliente || 'não informado'}`,
    `Contato: ${formatarContato(sender)}`,
    '',
    ...linhasItens,
    '',
    `*Total: ${formatarReais(orcamento?.valor_total_geral)}*`,
    pedidoGestaoClick?.codigo
      ? `Registrado no GestãoClick: orçamento nº ${pedidoGestaoClick.codigo}.`
      : 'Retirada no local; combinar pagamento e confirmar com o cliente.',
  ].join('\n');

  await enviarParaGrupo(text, 'pedido confirmado');
}

module.exports = {
  notifyAttendant,
  notifyOrcamento,
  // Exportado para teste.
  formatarContato,
};
