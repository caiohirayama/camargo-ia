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
          description: 'Preencha na mensagem em que você apresenta o resumo completo do pedido ao cliente (todos os itens, quantidades e preços confirmados via consulta ao catálogo) e pergunta se pode confirmar; nessa mensagem confirmar_pedido é sempre false. Use null em qualquer outra mensagem, inclusive na mensagem em que o cliente confirma (confirmar_pedido true) — o resumo já foi enviado antes, não precisa repetir os itens.',
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
                  produto_id: { type: 'string', description: 'Campo id retornado por consultar_produtos para este item exato. Nunca invente; copie o valor exatamente como veio da consulta.' },
                  variacao_id: { type: 'string', description: 'Campo variacao_id retornado por consultar_produtos para este item exato. Nunca invente; copie o valor exatamente como veio da consulta.' },
                  quantidade: { type: 'number', description: 'Quantidade solicitada pelo cliente.' },
                  unidade: { type: 'string', description: 'Unidade de venda (ex: caixa, fardo, unidade), conforme o catálogo.' },
                  valor_unitario: { type: 'number', description: 'Preço unitário conforme o catálogo, em reais.' },
                  valor_total: { type: 'number', description: 'quantidade × valor_unitario, em reais.' },
                },
                required: ['produto', 'produto_id', 'variacao_id', 'quantidade', 'unidade', 'valor_unitario', 'valor_total'],
              },
            },
            valor_total_geral: { type: 'number', description: 'Soma de valor_total de todos os itens, em reais.' },
          },
          required: ['nome_cliente', 'itens', 'valor_total_geral'],
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
