const path = require('path');
const ragService = require('../../services/ragService');
const { runTurn } = require('./runTurn');

const JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'camargo_reply',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resposta_cliente: {
          type: 'string',
          description: 'Mensagem que será enviada ao cliente no WhatsApp. Separe partes que devem virar mensagens distintas com uma linha em branco (\\n\\n); cada uma vira uma bolha própria enviada com simulação de digitação. Use quebra de linha simples (\\n) para organizar frases dentro da mesma bolha.',
        },
        transferir_humano: {
          type: 'boolean',
          description: 'True somente quando um atendente humano precisa assumir a conversa (situações de transferência descritas no prompt). Pausa a IA para esse cliente.',
        },
        orcamento: {
          type: ['object', 'null'],
          description: 'Preencha somente na mensagem em que você fecha o orçamento completo com o cliente (todos os itens, quantidades e preços já confirmados via consulta ao catálogo). Em qualquer outra mensagem, use null.',
          additionalProperties: false,
          properties: {
            nome_cliente: {
              type: ['string', 'null'],
              description: 'Nome do cliente, se ele informou em algum momento da conversa. Use null se não foi informado.',
            },
            itens: {
              type: 'array',
              description: 'Itens do orçamento, na ordem em que foram confirmados.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  produto: { type: 'string', description: 'Nome do produto como retornado pela consulta ao catálogo.' },
                  quantidade: { type: 'number', description: 'Quantidade solicitada pelo cliente.' },
                  unidade: { type: 'string', description: 'Unidade de venda (ex: caixa, fardo, unidade), conforme o catálogo.' },
                  valor_unitario: { type: 'number', description: 'Preço unitário conforme o catálogo, em reais.' },
                  valor_total: { type: 'number', description: 'quantidade × valor_unitario, em reais.' },
                },
                required: ['produto', 'quantidade', 'unidade', 'valor_unitario', 'valor_total'],
              },
            },
            valor_total_geral: { type: 'number', description: 'Soma de valor_total de todos os itens, em reais.' },
          },
          required: ['nome_cliente', 'itens', 'valor_total_geral'],
        },
      },
      required: ['resposta_cliente', 'transferir_humano', 'orcamento'],
    },
  },
};

function buildSafeFallbackReply() {
  return 'Só um momento, já te retorno com uma resposta certinha.';
}

module.exports = {
  id: 'camargo',
  nome: 'Camargo Atacarejo de Bebidas',
  systemPromptPath: path.join(__dirname, '..', '..', 'prompts', 'camargo_agent_prompt.md'),
  jsonSchema: JSON_SCHEMA,
  buildSafeFallbackReply,
  ragService,
  runTurn,
};
