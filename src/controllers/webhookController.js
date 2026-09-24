const { parseIncomingPayload } = require('../utils/messageParser');
const { containsInappropriateContent, getModerationReply } = require('../utils/moderation');
const aiService = require('../services/aiService');
const evolutionService = require('../services/evolutionService');
const conversationLockService = require('../services/conversationLockService');
const customerService = require('../services/customerService');
const r2Service = require('../services/r2Service');
const telegramService = require('../services/telegramService');
const registry = require('../projects/registry');
const env = require('../config/env');
const { flowPrefix, maskJid, shortId, errorSummary } = require('../utils/logContext');

const conversationState = new Map();

function getConversationKey(instanceName, sender) {
  return `${instanceName}::${sender}`;
}

// Quando um atendente envia uma mensagem manual, pausa a IA para essa conversa.
// A pausa é persistida em Bot.Cliente para sobreviver a um restart do processo.
async function pauseConversation(instanceName, sender, clienteId) {
  const key = getConversationKey(instanceName, sender);
  const state = conversationState.get(key);

  if (state?.timer) {
    clearTimeout(state.timer);
  }

  conversationState.delete(key);

  await customerService.pause(clienteId);
  console.log(`[pause] IA pausada | sender=${maskJid(sender)} | instância=${instanceName} | clienteId=${clienteId || '-'}`);
}

function scheduleConversationProcessing(instanceName, sender) {
  const key = getConversationKey(instanceName, sender);
  const state = conversationState.get(key);

  if (!state) {
    return;
  }

  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(async () => {
    const latestState = conversationState.get(key);
    if (!latestState) {
      return;
    }

    if (latestState.messages.length === 0) {
      conversationState.delete(key);
      return;
    }

    const pendingMessages = latestState.messages.slice();
    conversationState.delete(key);

    try {
      await processPendingConversation(instanceName, sender, pendingMessages);
    } catch (error) {
      console.error(`${flowPrefix(pendingMessages[0]?.messageId)} [fila] falha no processamento assíncrono:`, errorSummary(error));
    }
  }, env.messageDebounceMs);

  conversationState.set(key, state);
}

async function processPendingConversation(instanceName, sender, pendingMessages) {
  if (!pendingMessages || pendingMessages.length === 0) {
    return;
  }

  const flowId = pendingMessages[0]?.messageId;
  const prefix = flowPrefix(flowId);
  console.log(`${prefix} [fila] iniciando lote | mensagens=${pendingMessages.length} | sender=${maskJid(sender)} | instância=${instanceName}`);

  if (conversationLockService.isLocked(instanceName, sender)) {
    const key = getConversationKey(instanceName, sender);
    const queuedState = conversationState.get(key) || { messages: [], timer: null };
    queuedState.messages.unshift(...pendingMessages);
    conversationState.set(key, queuedState);
    scheduleConversationProcessing(instanceName, sender);
    console.log(`${prefix} [fila] conversa ocupada | reagendadas=${pendingMessages.length}`);
    return;
  }

  const projeto = registry.getProject();

  const lidSender = pendingMessages.map((item) => item.lidSender).find(Boolean) || null;
  const ctwaSourceId = pendingMessages.map((item) => item.ctwaSourceId).find(Boolean) || null;
  const ctwaSource = pendingMessages.map((item) => item.ctwaSource).find(Boolean) || null;

  const cliente = await customerService.ensureCustomer({
    nome: pendingMessages[0]?.senderName || 'Pessoa',
    sender,
    instanceName,
    lidSender,
    fbEventId: ctwaSourceId,
    origem: ctwaSource,
  });

  const aiActive = !(await customerService.isPauseInEffect(cliente?.id));
  console.log(`${prefix} [cliente] resolvido | clienteId=${cliente?.id || 'não encontrado'} | iaAtiva=${aiActive}`);

  // Precisa ser buscado antes de persistir as mensagens deste lote logo abaixo,
  // senão elas apareceriam duplicadas (uma vez no histórico, outra como turno atual).
  const history = await customerService.getRecentHistory(cliente?.id);

  const combinedText = pendingMessages
    .map((item) => item.text || item.content || `[${item.type || 'unknown'}]`)
    .filter(Boolean)
    .join('\n\n');

  for (const message of pendingMessages) {
    await customerService.saveInteraction({
      clienteId: cliente?.id,
      mensagemId: message.messageId || null,
      mensagem: message.text || message.content || '',
      type: message.type,
      fromMe: false,
      mediaUrl: message.mediaUrl || null,
      sender,
      instanceName,
    });
  }

  if (!aiActive) {
    console.log(`${prefix} [fluxo] IA pausada; mensagens persistidas sem resposta automática`);
    return;
  }

  if (!combinedText) {
    console.log(`${prefix} [fluxo] lote sem conteúdo processável; encerrando`);
    return;
  }

  if (containsInappropriateContent(combinedText)) {
    console.log(`${prefix} [moderação] conteúdo bloqueado; enviando resposta segura`);
    await evolutionService.sendText({
      instanceName,
      remoteJid: sender,
      text: getModerationReply(),
      correlationId: flowId,
    });
    return;
  }

  conversationLockService.lock(instanceName, sender);

  try {
    // O projeto Camargo concentra prompt, RAG e comportamento da conversa.
    await projeto.runTurn({
      cliente,
      history,
      combinedText,
      instanceName,
      sender,
      senderName: pendingMessages[0]?.senderName,
      messageId: flowId,
    });
  } catch (error) {
    console.error(`${prefix} [fluxo] erro ao processar conversa:`, errorSummary(error));
  } finally {
    conversationLockService.unlock(instanceName, sender);
    console.log(`${prefix} [fluxo] processamento finalizado`);
  }
}

async function queueConversationMessage(instanceName, sender, message) {
  const key = getConversationKey(instanceName, sender);
  const currentState = conversationState.get(key) || { messages: [], timer: null };

  currentState.messages.push(message);
  conversationState.set(key, currentState);
  console.log(`${flowPrefix(message.messageId)} [fila] mensagem adicionada | acumuladas=${currentState.messages.length} | debounceMs=${env.messageDebounceMs}`);
  scheduleConversationProcessing(instanceName, sender);
}

async function handleOutgoingEvent(parsed) {
  if (!parsed.instanceName || !parsed.sender) {
    return;
  }

  // protocolMessage/secretEncryptedMessage/reactionMessage são eventos de sistema
  // (revogar/editar/reagir) — não é o atendente mandando mensagem manual de verdade,
  // não pausa nada.
  if (parsed.message?.protocolMessage || parsed.message?.secretEncryptedMessage || parsed.message?.reactionMessage) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] evento de sistema fromMe ignorado`);
    return;
  }

  // A própria IA mandando mensagem (via /message/sendText/:instance) também gera um evento fromMe
  // idêntico ao de um humano mandando manualmente pelo celular conectado. Se foi a
  // IA quem mandou, não é "atendente assumindo a conversa" — e o histórico já foi
  // salvo em evolutionService.sendText no momento do envio (não depende desse eco,
  // que pode resolver o sender/JID errado e atribuir a mensagem ao cliente errado).
  if (evolutionService.wasSentByAi({ instanceName: parsed.instanceName, messageId: parsed.messageId })) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] eco da própria IA confirmado e ignorado`);
    return;
  }

  // Garante que o cliente existe (cria com nome genérico se for a primeira vez que
  // alguém fala com esse contato) pra já desativar a IA pra ele. parsed.senderName
  // em evento fromMe é o perfil de quem está operando o número (atendente), nunca
  // o nome do cliente — por isso não vem nome real aqui.
  const cliente = await customerService.ensureCustomer({
    nome: 'sem-nome',
    sender: parsed.sender,
    instanceName: parsed.instanceName,
  });

  // Se a IA já estava pausada (ex: atendimento já finalizado e transferido antes
  // dessa mensagem), não é o atendente pausando agora — não registra como pausa nova.
  const jaEstavaPausada = await customerService.isPaused(cliente?.id);

  if (!jaEstavaPausada) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] envio manual detectado | sender=${maskJid(parsed.sender)} | pausando IA`);
  }

  await pauseConversation(parsed.instanceName, parsed.sender, cliente?.id);

  await customerService.saveInteraction({
    clienteId: cliente?.id,
    mensagemId: parsed.messageId || null,
    mensagem: parsed.content || null,
    type: parsed.contentType || 'text',
    fromMe: true,
    mediaUrl: parsed.mediaUrl || null,
    sender: parsed.sender,
    instanceName: parsed.instanceName,
  });
}

async function handleIncomingEvent(parsed) {
  if (!parsed.instanceName || !parsed.sender) {
    return;
  }

  if (parsed.content?.startsWith('⚠️ Sua instância da IA foi desconectada')) {
    return;
  }

  // protocolMessage é evento de sistema do WhatsApp (ex: cliente ativou/desativou
  // mensagens temporárias) — não é conversa de verdade, não tem o que processar.
  if (parsed.message?.protocolMessage) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] protocolMessage ignorada | sender=${maskJid(parsed.sender)}`);
    return;
  }

  // secretEncryptedMessage cobre edição de mensagem, reação e voto de enquete —
  // tem criptografia própria separada, não dá pra extrair texto sem implementar
  // essa decriptação específica, e não é conteúdo de conversa real.
  if (parsed.message?.secretEncryptedMessage) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] mensagem criptografada de sistema ignorada`);
    return;
  }

  // reactionMessage é o cliente reagindo com emoji a uma mensagem — não é conversa.
  if (parsed.message?.reactionMessage) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] reação ignorada`);
    return;
  }

  if (parsed.contentType === 'text' && !parsed.content) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] texto vazio ignorado`);
    return;
  }

  console.log(`${flowPrefix(parsed.messageId)} [webhook] mensagem recebida | tipo=${parsed.contentType} | sender=${maskJid(parsed.sender)} | caracteres=${String(parsed.content || '').length}`);

  let text = parsed.content || '';
  let mediaUrl = parsed.mediaUrl || null;

  const mediaContentTypes = ['audio', 'image', 'video', 'document'];

  if (mediaContentTypes.includes(parsed.contentType)) {
    // A URL de origem do WhatsApp pode expirar ou apontar para conteúdo criptografado.
    // Mídias persistidas recebem somente a URL confirmada pelo R2.
    mediaUrl = null;
    console.log(`${flowPrefix(parsed.messageId)} [mídia] iniciando download | tipo=${parsed.contentType}`);
    const media = await evolutionService.downloadMedia(parsed.instanceName, parsed.rawData);
    if (media?.base64) {
      try {
        const uploadedUrl = await r2Service.uploadMedia({
          base64: media.base64,
          mimeType: media.mimeType,
          instanceName: parsed.instanceName,
          sender: parsed.sender,
          messageId: parsed.messageId,
        });
        mediaUrl = uploadedUrl;
        console.log(`${flowPrefix(parsed.messageId)} [mídia] persistida no Cloudflare R2`);
      } catch (error) {
        console.error(`${flowPrefix(parsed.messageId)} [r2] falha no upload:`, errorSummary(error));
      }

      if (parsed.contentType === 'audio') {
        console.log(`${flowPrefix(parsed.messageId)} [ia] iniciando transcrição de áudio`);
        text = await aiService.transcribeAudio({
          instanceName: parsed.instanceName,
          base64: media.base64,
          mimeType: media.mimeType,
        }) || `[áudio recebido]`;
        console.log(`${flowPrefix(parsed.messageId)} [ia] transcrição concluída | caracteres=${String(text).length}`);
      } else if (parsed.contentType === 'image') {
        console.log(`${flowPrefix(parsed.messageId)} [ia] iniciando análise de imagem`);
        text = await aiService.analyzeImage({
          instanceName: parsed.instanceName,
          base64: media.base64,
          mimeType: media.mimeType,
        }) || `[imagem recebida]`;
        console.log(`${flowPrefix(parsed.messageId)} [ia] análise de imagem concluída | caracteres=${String(text).length}`);
      } else {
        text = `[${parsed.contentType} recebido]`;
      }
    } else {
      console.warn(`[webhook] falha ao baixar mídia (${parsed.contentType}), usando placeholder`);
      text = `[${parsed.contentType} recebido]`;
    }
  }

  const message = {
    type: parsed.contentType || 'text',
    content: parsed.content,
    text,
    senderName: parsed.senderName,
    message: parsed.message,
    messageId: parsed.messageId,
    mediaUrl,
    lidSender: parsed.lidSender,
    ctwaSourceId: parsed.ctwaSourceId,
    ctwaSource: parsed.ctwaSource,
  };

  // Cliente mandou uma mensagem de botão/lista interativa (ex: respondendo um menu)
  // — a IA não tem como interpretar isso como conversa, então salva normalmente e
  // pausa a IA pra um atendente assumir, em vez de tentar gerar uma resposta.
  if (parsed.message?.interactiveMessage) {
    console.log(`${flowPrefix(parsed.messageId)} [webhook] mensagem interativa | sender=${maskJid(parsed.sender)} | pausando IA`);
    const cliente = await customerService.ensureCustomer({
      nome: parsed.senderName,
      sender: parsed.sender,
      instanceName: parsed.instanceName,
      lidSender: parsed.lidSender,
      fbEventId: parsed.ctwaSourceId,
      origem: parsed.ctwaSource,
    });

    await customerService.saveInteraction({
      clienteId: cliente?.id,
      mensagemId: parsed.messageId || null,
      mensagem: message.text || message.content || '',
      type: message.type,
      fromMe: false,
      mediaUrl: message.mediaUrl || null,
      sender: parsed.sender,
      instanceName: parsed.instanceName,
    });

    await customerService.pause(cliente?.id);
    return;
  }

  // Agrupa mensagens consecutivas antes de gerar uma única resposta.
  await queueConversationMessage(parsed.instanceName, parsed.sender, message);
}

async function handleEvolutionWebhook(req, res) {
  try {
    const key = req.body?.data?.key || {};
    console.log(`${flowPrefix(key.id)} [webhook] recebido | evento=${req.body?.event || req.body?.type || 'desconhecido'} | instância=${req.body?.instance || 'ausente'} | fromMe=${Boolean(key.fromMe)}`);
    res.status(200).json({ ok: true });
    console.log(`${flowPrefix(key.id)} [webhook] ACK 200 enviado; processamento assíncrono iniciado`);
    setImmediate(async () => {
      try {
        await processEvolutionWebhookBody(req.body);
      } catch (error) {
        console.error(`${flowPrefix(req.body?.data?.key?.id)} [webhook] erro no processamento assíncrono:`, errorSummary(error));
      }
    });
  } catch (error) {
    console.error('[webhook] erro no handler:', errorSummary(error));
  }
}

// Números de celular brasileiros podem aparecer no JID com ou sem o "9" extra
// depois do DDD (ex: 5519978287957 vs 551978287957) dependendo de como o
// WhatsApp normalizou o contato — por isso comparamos as duas variantes.
function phoneNumberVariants(digits) {
  const variants = new Set([digits]);
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    variants.add(digits.slice(0, 4) + digits.slice(5));
  } else if (digits.length === 12 && digits.startsWith('55')) {
    variants.add(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  return variants;
}

// Modo de teste: quando TEST_MODE_ALLOWED_NUMBER está configurado, só esses
// números recebem respostas da IA — qualquer outro remetente é ignorado antes
// de chegar na fila de conversa.
function isTestModeAllowed(sender) {
  if (!env.testModeAllowedNumbers.length) return true;
  if (typeof sender !== 'string') return false;
  const senderDigits = sender.split('@')[0].replace(/\D/g, '');
  return env.testModeAllowedNumbers.some((number) => {
    const allowedDigits = number.replace(/\D/g, '');
    return phoneNumberVariants(allowedDigits).has(senderDigits);
  });
}

function getWebhookMessageRoute(parsed) {
  if (
    !parsed?.instanceName ||
    parsed.instanceName !== env.instanceName ||
    !parsed?.sender ||
    parsed.isGroup
  ) return 'ignore';
  if (!parsed.fromMe && !isTestModeAllowed(parsed.sender)) return 'ignore';
  return parsed.fromMe ? 'outgoing' : 'incoming';
}

async function processEvolutionWebhookBody(body) {
  const parsed = parseIncomingPayload(body);
  const prefix = flowPrefix(parsed.messageId);

  if (parsed.instanceName !== env.instanceName) {
    console.warn(`${prefix} [webhook] instância não autorizada ignorada: ${parsed.instanceName || 'ausente'}`);
    return;
  }

  if (parsed.eventType === 'loggedout') {
    console.log(`[webhook] logout detectado na instância ${parsed.instanceName}`);
    await telegramService.sendAlert({
      instanceName: parsed.instanceName,
      eventType: 'logout',
      details: parsed.reason ? `${parsed.reason}` : null,
    });
    return;
  }

  if (parsed.eventType === 'connected') {
    console.log(`[webhook] conexão detectada na instância ${parsed.instanceName}`);
    // await telegramService.sendAlert({
    //   instanceName: parsed.instanceName,
    //   eventType: 'connected',
    //   details: parsed.reason ? `${parsed.reason}` : null,
    // });
    return;
  }

  const route = getWebhookMessageRoute(parsed);
  console.log(`${prefix} [webhook] roteamento | evento=${parsed.eventType || 'desconhecido'} | rota=${route} | tipo=${parsed.contentType}`);
  if (route === 'ignore') {
    if (parsed.isGroup) console.log(`${prefix} [webhook] grupo ignorado | sender=${maskJid(parsed.sender)}`);
    else if (!parsed.fromMe && !isTestModeAllowed(parsed.sender)) {
      console.log(`${prefix} [webhook] modo de teste ativo; sender fora do número permitido ignorado | sender=${maskJid(parsed.sender)}`);
    } else console.log(`${prefix} [webhook] evento ignorado por ausência de remetente ou rota válida`);
    return;
  }

  if (parsed.sender.includes('@lid') || (!parsed.fromMe && parsed.senderName === 'Sem Nome')) {
    console.log(`${prefix} [webhook] identidade parcial | sender=${maskJid(parsed.sender)} | messageId=${shortId(parsed.messageId)}`);
  }

  if (route === 'outgoing') {
    await handleOutgoingEvent(parsed);
    return;
  }

  await handleIncomingEvent(parsed);
}

module.exports = {
  handleEvolutionWebhook,
  getWebhookMessageRoute,
  isTestModeAllowed,
};
