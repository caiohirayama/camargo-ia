const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const registry = require('../projects/registry');
const productService = require('./productService');
const { flowPrefix, errorSummary } = require('../utils/logContext');

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOOL_ROUNDS = 3;

const PRODUCT_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'consultar_produtos',
    description: 'Consulta o catálogo real da Camargo Atacarejo de Bebidas por nome/termo e retorna os produtos encontrados com preço, unidade de venda e estoque. Use sempre antes de informar preço, disponibilidade ou fechar um item de orçamento, em vez de supor pela memória.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        termo: { type: 'string', description: 'Nome ou termo de busca do produto, como o cliente descreveu (ex: "cerveja skol lata", "coca 2 litros").' },
      },
      required: ['termo'],
    },
  },
};

async function executeProductSearchTool(rawArguments, messageId) {
  let termo;
  try {
    termo = JSON.parse(rawArguments || '{}')?.termo;
  } catch (_) {
    return { erro: 'argumentos inválidos' };
  }

  if (!termo || typeof termo !== 'string') {
    return { erro: 'termo de busca é obrigatório' };
  }

  return productService.searchProducts({ termo, messageId });
}

function isOfficialOpenAiBaseUrl(baseUrl) {
  if (!baseUrl) return true;

  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch (_) {
    return false;
  }
}

function isReasoningModel(model) {
  return /^(o\d|gpt-5)/i.test(String(model || ''));
}

function modelSupportsCustomTemperature(model) {
  return !isReasoningModel(model);
}

function getAiClientAndModel() {
  const baseUrl = env.aiBaseUrl || null;
  const apiKey = env.openaiApiKey || null;
  const model = env.aiModel || 'gpt-5-mini';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY não configurada no ambiente.');
  }

  if (baseUrl && !isOfficialOpenAiBaseUrl(baseUrl)) {
    const resolvedBase = baseUrl.replace(/\/+$/, '');
    return {
      client: new OpenAI({ apiKey, baseURL: resolvedBase }),
      model,
      provider: 'custom',
      baseUrl: resolvedBase,
    };
  }

  return {
    client: new OpenAI({ apiKey }),
    model,
    provider: 'openai',
    baseUrl: OPENAI_BASE_URL,
  };
}

function writeTempFile(base64, extension) {
  const tempDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

async function transcribeAudio({ base64, mimeType }) {
  const { client, provider } = getAiClientAndModel();
  if (provider !== 'openai') return null;

  const extension = mimeType?.split('/').pop()?.split(';')[0]?.trim() || 'mp3';
  const filePath = writeTempFile(base64, extension);

  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: env.openaiAudioModel,
    });
    return response?.text?.trim() || null;
  } catch (error) {
    console.error('[ia] falha ao transcrever áudio:', errorSummary(error));
    return null;
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

async function analyzeImage({ base64, mimeType }) {
  const { client, model, provider, baseUrl } = getAiClientAndModel();
  if (provider !== 'openai') return null;

  const imageDataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  const visionModel = env.openaiVisionModel || model;
  console.log(`[aiService] -> ${baseUrl}/responses | modelo: ${visionModel}`);

  try {
    const response = await client.responses.create({
      model: visionModel,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Descreva o que aparece na imagem (produtos, rótulos, embalagens, documentos). Extraia também qualquer texto legível, como nome de produto, quantidade ou código. Não invente detalhes.',
          },
          { type: 'input_image', image_url: imageDataUrl },
        ],
      }],
    });

    return response.output_text?.trim() || response.output?.[0]?.content?.[0]?.text?.trim() || null;
  } catch (error) {
    console.error('[ia] falha ao analisar imagem:', errorSummary(error));
    return null;
  }
}

function stripJsonCodeFences(raw) {
  return String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function buildRagQuery(history, userText) {
  const recentHistory = Array.isArray(history)
    ? history.slice(-4).map((message) => message.content).filter(Boolean)
    : [];
  return [...recentHistory, userText].join('\n');
}

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// Travessão é um tique de escrita de IA que humanos não usam no WhatsApp;
// removemos como garantia mesmo com a instrução já no prompt.
function stripEmDash(text) {
  return String(text || '').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',').trim();
}

function parseStructuredReply(raw, projeto) {
  const normalizedRaw = stripJsonCodeFences(raw);

  try {
    const parsed = JSON.parse(normalizedRaw);
    const replyText = typeof parsed?.resposta_cliente === 'string'
      ? stripEmDash(parsed.resposta_cliente)
      : '';

    return {
      replyText: replyText || projeto.buildSafeFallbackReply(),
      transferToHuman: Boolean(parsed?.transferir_humano),
      orcamento: parsed?.orcamento && typeof parsed.orcamento === 'object' ? parsed.orcamento : null,
      rawContent: normalizedRaw,
    };
  } catch (_) {
    if (normalizedRaw && !normalizedRaw.startsWith('{')) {
      return { replyText: stripEmDash(normalizedRaw), transferToHuman: false, orcamento: null, rawContent: normalizedRaw };
    }

    return {
      replyText: projeto.buildSafeFallbackReply(),
      transferToHuman: true,
      orcamento: null,
      rawContent: normalizedRaw,
    };
  }
}

function getCurrentDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getCurrentWeekday() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
  }).format(new Date());
}

async function generateReply({ history = [], userText = '', messageId = null }) {
  const { client, model, provider } = getAiClientAndModel();
  const startedAt = Date.now();
  const prefix = flowPrefix(messageId);
  console.log(`${prefix} [ia] gerando resposta | provider=${provider} | modelo=${model} | histórico=${history.length} | caracteresEntrada=${String(userText).length}`);
  const projeto = registry.getProject();
  const systemPrompt = fs.readFileSync(projeto.systemPromptPath, 'utf8');
  const ragQuery = buildRagQuery(history, userText);
  const ragContext = projeto.ragService?.buildContext(userText)
    || projeto.ragService?.buildContext(ragQuery)
    || null;

  if (ragContext) console.log('[rag] contexto Camargo injetado na resposta');

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'system',
      content: `Data atual: ${getCurrentDate()} (${getCurrentWeekday()}), horário de Brasília. Use esta data para horário de funcionamento e validade do orçamento.`,
    },
    ...(ragContext ? [{ role: 'system', content: ragContext }] : []),
    ...history,
    { role: 'user', content: userText },
  ];

  const productToolAvailable = productService.isProductsApiConfigured();

  let raw = '';
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = productToolAvailable && round < MAX_TOOL_ROUNDS;

    const request = {
      model,
      messages,
      max_completion_tokens: isReasoningModel(model) ? 1600 : 500,
    };

    if (modelSupportsCustomTemperature(model)) request.temperature = 0.4;
    else request.reasoning_effort = 'low';

    if (provider === 'openai') request.response_format = projeto.jsonSchema;
    if (allowTools) request.tools = [PRODUCT_SEARCH_TOOL];

    const response = await client.chat.completions.create(request);
    const choiceMessage = response.choices?.[0]?.message;
    const toolCalls = choiceMessage?.tool_calls;

    if (toolCalls?.length) {
      messages.push(choiceMessage);
      for (const toolCall of toolCalls) {
        console.log(`${prefix} [ia] chamando consultar_produtos | args=${toolCall.function?.arguments}`);
        const result = await executeProductSearchTool(toolCall.function?.arguments, messageId);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      continue;
    }

    raw = choiceMessage?.content?.trim() || '';
    break;
  }

  const parsedReply = parseStructuredReply(raw, projeto);

  if (normalizeComparableText(parsedReply.replyText) === normalizeComparableText(userText)) {
    console.warn('[aiService] resposta repetiu a mensagem do cliente; usando fallback de transferência');
    parsedReply.replyText = projeto.buildSafeFallbackReply();
    parsedReply.transferToHuman = true;
  }

  console.log(`${prefix} [ia] resposta pronta | duraçãoMs=${Date.now() - startedAt} | caracteresSaída=${parsedReply.replyText.length} | transferir=${parsedReply.transferToHuman}`);
  return parsedReply;
}

module.exports = {
  generateReply,
  transcribeAudio,
  analyzeImage,
};
