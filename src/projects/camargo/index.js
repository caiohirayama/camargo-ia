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
        confirmar_pedido: {
          type: 'boolean',
          description: 'True somente na mensagem em que o cliente acabou de confirmar de forma explícita e inequívoca um orçamento que você já apresentou antes nesta mesma conversa (ver "Confirmação do pedido" no prompt). Em qualquer outra mensagem, inclusive a que apresenta o resumo pela primeira vez, use false.',
        },
        orcamento: {
          type: ['object', 'null'],
          description: 'Preencha (só com nome_cliente) na mensagem em que você apresenta o resumo do pedido ao cliente e pergunta se pode confirmar — sempre depois de chamar consultar_carrinho nesta mesma resposta, para pegar os itens reais (nunca monte a lista de memória). Nessa mensagem confirmar_pedido é sempre false. Use null em qualquer outra mensagem, inclusive na mensagem em que o cliente confirma (confirmar_pedido true).',
          additionalProperties: false,
          properties: {
            nome_cliente: {
              type: ['string', 'null'],
              description: 'Nome do cliente, se ele informou em algum momento da conversa. Use null se não foi informado.',
            },
          },
          required: ['nome_cliente'],
        },
      },
      required: ['resposta_cliente', 'transferir_humano', 'confirmar_pedido', 'orcamento'],
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
