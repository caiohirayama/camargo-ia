const axios = require('axios');
const env = require('../config/env');
const { errorSummary } = require('../utils/logContext');

async function sendAlert({ instanceName, eventType, details }) {
  const botToken = env.telegramBotToken;
  const chatId = env.telegramChatId;

  if (!botToken || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados. Ignorando alerta.');
    return;
  }

  // Sem parse_mode: eventType/details podem conter texto de fora (webhook,
  // erro) e um "*"/"_" desbalanceado faz o Telegram recusar a mensagem com 400.
  const text = [
    `🚨 Alerta de Evolution`,
    `Instância: ${instanceName || 'desconhecida'}`,
    `Evento: ${eventType || 'desconhecido'}`,
    details ? `Detalhes: ${details}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (error) {
    console.error('[telegram] falha ao enviar alerta:', errorSummary(error));
  }
}

async function notifyAttendant({ sender, motivo, mensagem, pausado }) {
  const botToken = env.telegramBotToken;
  const chatId = env.telegramChatId;

  if (!botToken || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados. Ignorando notificação.');
    return;
  }

  // Sem parse_mode: "mensagem" é texto livre do cliente e um "*"/"_"/"`"
  // desbalanceado faz o Telegram recusar a mensagem inteira com 400.
  const text = [
    `📣 Atenção necessária`,
    `Cliente: ${sender || 'desconhecido'}`,
    `Motivo: ${motivo || 'não informado'}`,
    pausado ? 'A IA pausou essa conversa.' : 'A IA segue atendendo normalmente.',
    mensagem ? `Última mensagem: ${mensagem}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (error) {
    console.error('[telegram] falha ao notificar atendente:', errorSummary(error));
  }
}

async function notifyOrcamento({ sender, orcamento, pedidoGestaoClick }) {
  const botToken = env.telegramBotToken;
  const chatId = env.telegramChatId;

  if (!botToken || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados. Ignorando notificação de orçamento.');
    return;
  }

  const itens = Array.isArray(orcamento?.itens) ? orcamento.itens : [];
  const linhasItens = itens.map((item) => `${item.quantidade} ${item.unidade} de ${item.produto} — R$ ${item.valor_total}`);

  const text = [
    `🧾 Pedido confirmado pelo cliente`,
    `Cliente: ${orcamento?.nome_cliente || sender || 'desconhecido'}`,
    ...linhasItens,
    `Total: R$ ${orcamento?.valor_total_geral ?? '-'}`,
    pedidoGestaoClick?.codigo
      ? `Registrado no GestãoClick: orçamento nº ${pedidoGestaoClick.codigo}.`
      : 'Retirada no local; combinar pagamento e confirmar com o cliente.',
  ].join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (error) {
    console.error('[telegram] falha ao notificar orçamento:', errorSummary(error));
  }
}

module.exports = {
  sendAlert,
  notifyAttendant,
  notifyOrcamento,
};
