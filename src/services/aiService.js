const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const registry = require('../projects/registry');
const productService = require('./productService');
const cartService = require('./cartService');
const ofertaService = require('./ofertaService');
const orcamentoService = require('./orcamentoService');
const cnpjService = require('./cnpjService');
const documento = require('../utils/documento');
const { flowPrefix, errorSummary } = require('../utils/logContext');

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOOL_ROUNDS = 4;

const PRODUCT_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'consultar_produtos',
    description: 'Consulta o catálogo real da Camargo Atacarejo de Bebidas por nome/termo e retorna os produtos encontrados com preço normal, unidade de venda e em_estoque (se tem ou não no momento, sem a quantidade). Produto que está em oferta hoje vem com o campo oferta (valor_oferta, quantidade_minima, valida_ate). Use sempre antes de informar preço, disponibilidade ou fechar um item de orçamento, em vez de supor pela memória.',
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
  let args;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch (_) {
    return { erro: 'argumentos inválidos' };
  }

  const termo = args?.termo;
  if (!termo || typeof termo !== 'string') {
    return { erro: 'termo de busca é obrigatório' };
  }

  const resultado = await productService.searchProducts({ termo, messageId });
  if (!resultado.consultaRealizada || !resultado.produtos?.length || !ofertaService.isConfigured()) {
    return resultado;
  }

  // Marca os produtos encontrados que estão na planilha de ofertas de hoje,
  // para a IA avisar o cliente mesmo quando ele não perguntou por oferta.
  // Falha na planilha não derruba a consulta: segue sem a marcação.
  const ofertas = await ofertaService.listarOfertasVigentes({ messageId });
  const porProduto = new Map((ofertas.ofertas || []).map((oferta) => [String(oferta.id), oferta]));
  return {
    ...resultado,
    produtos: resultado.produtos.map((produto) => {
      const oferta = porProduto.get(String(produto.id));
      return oferta
        ? { ...produto, oferta: { valor_oferta: oferta.valor_oferta, valor_oferta_unidade: oferta.valor_oferta_unidade, unidades_por_embalagem: oferta.unidades_por_embalagem, quantidade_minima: oferta.quantidade_minima, valida_ate: oferta.valida_ate } }
        : produto;
    }),
  };
}

// A planilha de ofertas define quais produtos estão em oferta e em que
// condições; preço e ids vêm do GestãoClick (ofertaService.js).
const OFFERS_TOOL = {
  type: 'function',
  function: {
    name: 'consultar_ofertas',
    description: 'Lista os produtos em oferta hoje, com preço normal, preço de oferta da embalagem (valor_oferta), preço de oferta por unidade (valor_oferta_unidade, já calculado), unidades por embalagem, quantidade mínima para pagar o preço de oferta, validade (valida_ate, null quando não tem) e os ids para o carrinho. Use quando o cliente perguntar por ofertas, promoções ou descontos, com ou sem citar um produto.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
};

// O carrinho é a fonte real dos itens do pedido — nunca a memória da
// conversa. Adicionar um item aqui, no momento exato em que o cliente
// confirma, evita que a IA "esqueça" um item já confirmado ao montar o
// resumo final mais tarde numa conversa longa.
const ADD_CART_ITEM_TOOL = {
  type: 'function',
  function: {
    name: 'adicionar_item_carrinho',
    description: 'Adiciona ao carrinho um item que o cliente acabou de confirmar (produto exato e quantidade), usando os dados que consultar_produtos ou consultar_ofertas retornou nesta mesma conversa. O retorno traz o preço realmente aplicado (em_oferta indica se foi o de oferta). Chame isso sempre que o cliente confirmar um item, imediatamente — nunca espere até o fim da lista.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        produto: { type: 'string', description: 'Nome do produto exatamente como retornado por consultar_produtos.' },
        produto_id: { type: 'string', description: 'Campo id retornado por consultar_produtos para este item. Nunca invente.' },
        variacao_id: { type: 'string', description: 'Campo variacao_id retornado por consultar_produtos para este item. Nunca invente.' },
        quantidade: { type: 'number', description: 'Quantidade confirmada pelo cliente.' },
        unidade: { type: 'string', description: 'Unidade de venda (ex: caixa, fardo, unidade), conforme o catálogo.' },
        valor_unitario: { type: 'number', description: 'Preço unitário normal retornado por consultar_produtos ou consultar_ofertas nesta conversa. Se o produto estiver em oferta e a quantidade atingir o mínimo, o sistema aplica o preço de oferta sozinho.' },
      },
      required: ['produto', 'produto_id', 'variacao_id', 'quantidade', 'unidade', 'valor_unitario'],
    },
  },
};

const VIEW_CART_TOOL = {
  type: 'function',
  function: {
    name: 'consultar_carrinho',
    description: 'Retorna os itens já confirmados e adicionados ao carrinho nesta conversa, com o total, e se ainda faltam os dados de cadastro do cliente (dados_cadastro_pendentes). Chame sempre antes de apresentar o resumo final do pedido ao cliente — nunca monte esse resumo de memória.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
};

const CLEAR_CART_TOOL = {
  type: 'function',
  function: {
    name: 'limpar_carrinho',
    description: 'Esvazia o carrinho. Use somente quando o cliente pedir para tirar, trocar ou refazer os itens do pedido depois de já ter itens confirmados — em seguida, adicione de novo (com adicionar_item_carrinho) só os itens que o cliente ainda quer.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
};

// Cliente novo no GestãoClick só é cadastrado com tipo de pessoa e
// documento: PF com nome + CPF, PJ com CNPJ (razão social vem da consulta
// ao CNPJ). Validação dos dígitos verificadores fica aqui, no servidor.
const REGISTER_CUSTOMER_DATA_TOOL = {
  type: 'function',
  function: {
    name: 'registrar_dados_cliente',
    description: 'Registra os dados de cadastro do cliente, necessários antes de fechar o pedido quando consultar_carrinho retorna dados_cadastro_pendentes: true. Só chame depois que o cliente já enviou TODOS os dados do tipo dele: pessoa física, nome completo e CPF; pessoa jurídica, CNPJ. Se ainda falta algum, não chame: peça o que falta. Nunca invente nem complete dados que o cliente não informou.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tipo_pessoa: { type: 'string', enum: ['PF', 'PJ'], description: 'PF para pessoa física, PJ para pessoa jurídica (empresa), conforme o cliente respondeu.' },
        nome: { type: ['string', 'null'], description: 'Pessoa física: nome completo informado pelo cliente. Pessoa jurídica: null.' },
        cpf: { type: ['string', 'null'], description: 'Pessoa física: CPF informado pelo cliente. Pessoa jurídica: null.' },
        cnpj: { type: ['string', 'null'], description: 'Pessoa jurídica: CNPJ informado pelo cliente. Pessoa física: null.' },
      },
      required: ['tipo_pessoa', 'nome', 'cpf', 'cnpj'],
    },
  },
};

async function executeRegisterCustomerDataTool(rawArguments, clienteId) {
  let args;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch (_) {
    return { erro: 'argumentos inválidos' };
  }

  // "Ainda não informado" e "informado errado" precisam de respostas
  // distintas: a IA já chamou esta tool só com o nome, recebeu "CPF
  // inválido" e disse ao cliente que o CPF estava errado antes de ele
  // mandar qualquer número.
  if (args?.tipo_pessoa === 'PF') {
    const nome = String(args.nome || '').trim();
    if (nome.length < 3) {
      return { registrado: false, falta: 'nome', instrucao: 'Nada foi registrado. O cliente ainda não informou o nome completo: peça o nome, sem dizer que há erro.' };
    }
    if (!documento.onlyDigits(args.cpf)) {
      return { registrado: false, falta: 'cpf', instrucao: 'Nada foi registrado. O cliente ainda não informou o CPF: peça o CPF, sem dizer que há erro.' };
    }
    if (!documento.isCpfValido(args.cpf)) {
      return { registrado: false, erro: 'O CPF que o cliente enviou é inválido: peça para ele conferir e enviar de novo.' };
    }
    const dados = { tipo_pessoa: 'PF', nome, cpf: documento.formatarCpf(args.cpf) };
    cartService.definirDadosCliente(clienteId, dados);
    return { registrado: true, ...dados };
  }

  if (args?.tipo_pessoa === 'PJ') {
    if (!documento.onlyDigits(args.cnpj)) {
      return { registrado: false, falta: 'cnpj', instrucao: 'Nada foi registrado. O cliente ainda não informou o CNPJ: peça o CNPJ, sem dizer que há erro.' };
    }
    if (!documento.isCnpjValido(args.cnpj)) {
      return { registrado: false, erro: 'O CNPJ que o cliente enviou é inválido: peça para ele conferir e enviar de novo.' };
    }

    // Consulta indisponível (null) não bloqueia o pedido: segue só com o CNPJ.
    const consulta = await cnpjService.consultarCnpj(args.cnpj);
    if (consulta && !consulta.encontrado) {
      return { registrado: false, erro: 'O CNPJ que o cliente enviou não existe: peça para ele conferir e enviar de novo.' };
    }

    const dados = {
      tipo_pessoa: 'PJ',
      cnpj: documento.formatarCnpj(args.cnpj),
      razao_social: consulta?.razao_social || null,
      nome_fantasia: consulta?.nome_fantasia || null,
    };
    cartService.definirDadosCliente(clienteId, dados);
    return { registrado: true, ...dados };
  }

  return { erro: 'tipo_pessoa deve ser PF ou PJ' };
}

async function executeAddCartItemTool(rawArguments, clienteId, messageId) {
  let args;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch (_) {
    return { erro: 'argumentos inválidos' };
  }

  const { produto, produto_id, variacao_id, quantidade, unidade, valor_unitario } = args || {};
  const quantidadeNum = Number(quantidade);
  const valorUnitarioNum = Number(valor_unitario);

  if (!produto || !produto_id || !variacao_id || !unidade || !Number.isFinite(quantidadeNum) || !Number.isFinite(valorUnitarioNum)) {
    return { erro: 'dados incompletos para adicionar ao carrinho' };
  }

  // O preço de oferta é decidido aqui, não pela IA: vale só para produto
  // da planilha vigente e com quantidade >= QTDMIN. Abaixo do mínimo, volta
  // ao preço normal mesmo que a IA tenha mandado o de oferta.
  let valorAplicado = valorUnitarioNum;
  let emOferta = false;
  let observacao = null;
  const oferta = ofertaService.isConfigured()
    ? await ofertaService.buscarOfertaVigente(produto_id, { messageId })
    : null;
  if (oferta) {
    if (quantidadeNum >= oferta.quantidade_minima) {
      valorAplicado = oferta.valor_oferta;
      emOferta = true;
    } else {
      valorAplicado = oferta.valor_normal ?? valorUnitarioNum;
      observacao = `Preço de oferta só a partir de ${oferta.quantidade_minima}; com essa quantidade vale o preço normal.`;
    }
  }

  const item = {
    produto,
    produto_id: String(produto_id),
    variacao_id: String(variacao_id),
    quantidade: quantidadeNum,
    unidade,
    valor_unitario: valorAplicado,
    valor_total: quantidadeNum * valorAplicado,
    em_oferta: emOferta,
  };

  const itens = cartService.adicionarItem(clienteId, item);
  return {
    item_adicionado: { ...item, ...(observacao ? { observacao } : {}) },
    itens,
    valor_total_geral: cartService.calcularTotal(itens),
  };
}

async function executeOffersTool(messageId) {
  const resultado = await ofertaService.listarOfertasVigentes({ messageId });
  if (resultado.consultaRealizada && resultado.ofertas.length === 0) {
    return { ...resultado, mensagem: 'nenhuma oferta vigente hoje' };
  }
  return resultado;
}

async function executeViewCartTool({ cliente, clienteId, messageId }) {
  const itens = cartService.getItens(clienteId);
  const dadosCadastroPendentes = await orcamentoService.precisaDadosCadastro({
    cliente,
    dadosCliente: cartService.getDadosCliente(clienteId),
    messageId,
  });
  return { itens, valor_total_geral: cartService.calcularTotal(itens), dados_cadastro_pendentes: dadosCadastroPendentes };
}

function executeClearCartTool(clienteId) {
  cartService.limparItens(clienteId);
  return { itens: [], valor_total_geral: 0 };
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
      mensagemUnica: Boolean(parsed?.mensagem_unica),
      confirmarPedido: Boolean(parsed?.confirmar_pedido),
      orcamento: parsed?.orcamento && typeof parsed.orcamento === 'object' ? parsed.orcamento : null,
      rawContent: normalizedRaw,
    };
  } catch (_) {
    if (normalizedRaw && !normalizedRaw.startsWith('{')) {
      return { replyText: stripEmDash(normalizedRaw), transferToHuman: false, confirmarPedido: false, orcamento: null, rawContent: normalizedRaw };
    }

    return {
      replyText: projeto.buildSafeFallbackReply(),
      transferToHuman: true,
      confirmarPedido: false,
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

async function generateReply({ history = [], userText = '', messageId = null, clienteId = null, cliente = null }) {
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
    if (allowTools) request.tools = [PRODUCT_SEARCH_TOOL, ADD_CART_ITEM_TOOL, VIEW_CART_TOOL, CLEAR_CART_TOOL, REGISTER_CUSTOMER_DATA_TOOL, OFFERS_TOOL];

    const response = await client.chat.completions.create(request);
    const choiceMessage = response.choices?.[0]?.message;
    const toolCalls = choiceMessage?.tool_calls;

    if (toolCalls?.length) {
      messages.push(choiceMessage);
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function?.name;
        // CPF/CNPJ do cliente não vão por extenso para o log.
        const logArgs = toolName === 'registrar_dados_cliente'
          ? String(toolCall.function?.arguments || '').replace(/("(?:cpf|cnpj)"\s*:\s*")[^"]*(")/g, '$1***$2')
          : toolCall.function?.arguments;
        console.log(`${prefix} [ia] chamando ${toolName} | args=${logArgs}`);

        let result;
        if (toolName === 'consultar_produtos') {
          result = await executeProductSearchTool(toolCall.function?.arguments, messageId);
        } else if (toolName === 'adicionar_item_carrinho') {
          result = await executeAddCartItemTool(toolCall.function?.arguments, clienteId, messageId);
        } else if (toolName === 'consultar_ofertas') {
          result = await executeOffersTool(messageId);
        } else if (toolName === 'consultar_carrinho') {
          result = await executeViewCartTool({ cliente, clienteId, messageId });
        } else if (toolName === 'limpar_carrinho') {
          result = executeClearCartTool(clienteId);
        } else if (toolName === 'registrar_dados_cliente') {
          result = await executeRegisterCustomerDataTool(toolCall.function?.arguments, clienteId);
        } else {
          result = { erro: 'ferramenta desconhecida' };
        }

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
