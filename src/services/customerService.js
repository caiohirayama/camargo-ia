const { getPool } = require('./databaseService');
const env = require('../config/env');
const { flowPrefix, maskJid } = require('../utils/logContext');

const customerAliases = new Map();

const CUSTOMER_COLUMNS = `
  id,
  nome,
  telefone,
  sender,
  instancia,
  fbEventId AS "fbEventId",
  origem,
  createdAt AS "createdAt",
  updatedAt AS "updatedAt"
`;

function requirePool() {
  const postgres = getPool();
  if (!postgres) {
    throw new Error('PostgreSQL não configurado; a persistência é obrigatória.');
  }
  return postgres;
}

function aliasKey(instanceName, sender) {
  return `${instanceName}::${sender}`;
}

function getConfiguredInstance(instanceName) {
  if (instanceName && instanceName !== env.instanceName) {
    throw new Error(`Instância não autorizada: ${instanceName}. Esta aplicação atende somente ${env.instanceName}.`);
  }
  return env.instanceName;
}

function jidToPhone(sender) {
  if (!sender) return null;
  return String(sender).replace(/@.+$/, '') || null;
}

function jidToMessagePhone(sender) {
  if (!sender) return null;
  const value = String(sender);
  return value.includes('@lid') ? value : jidToPhone(value);
}

async function findClienteBySender({ sender, instanceName }) {
  if (!sender) return null;
  const configuredInstance = getConfiguredInstance(instanceName);

  const postgres = requirePool();

  const aliasClienteId = customerAliases.get(aliasKey(configuredInstance, sender));
  if (aliasClienteId) {
    const aliasResult = await postgres.query(`SELECT ${CUSTOMER_COLUMNS} FROM Bot.Cliente WHERE id = $1 LIMIT 1`, [aliasClienteId]);
    if (aliasResult.rows[0]) return aliasResult.rows[0];
    customerAliases.delete(aliasKey(configuredInstance, sender));
  }

  const result = await postgres.query(
    `
      SELECT ${CUSTOMER_COLUMNS}
      FROM Bot.Cliente
      WHERE telefone = $1 AND instancia = $2
      ORDER BY id ASC
      LIMIT 1
    `,
    [jidToPhone(sender), configuredInstance],
  );

  return result.rows[0] || null;
}

async function createCliente({ nome, sender, instancia, fbEventId, origem }) {
  const postgres = requirePool();

  let result = await postgres.query(
    `
      INSERT INTO Bot.Cliente (nome, telefone, sender, instancia, fbEventId, origem)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (telefone, instancia) WHERE telefone IS NOT NULL DO NOTHING
      RETURNING ${CUSTOMER_COLUMNS}
    `,
    [nome || null, jidToPhone(sender), sender || null, instancia || null, fbEventId || null, origem || null],
  );

  if (!result.rows.length) {
    result = await postgres.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM Bot.Cliente WHERE telefone = $1 AND instancia = $2 LIMIT 1`,
      [jidToPhone(sender), instancia],
    );
  }

  return result.rows[0] || null;
}

async function ensureCustomer({ nome, sender, instanceName, lidSender = null, fbEventId = null, origem = null }) {
  const configuredInstance = getConfiguredInstance(instanceName);
  const cliente = await findClienteBySender({ sender, instanceName: configuredInstance });
  if (cliente) {
    console.log(`[postgres] cliente localizado | clienteId=${cliente.id} | sender=${maskJid(sender)}`);
    return cliente;
  }

  if (lidSender && lidSender !== sender) {
    const placeholder = await findClienteBySender({ sender: lidSender, instanceName: configuredInstance });
    if (placeholder?.id) {
      customerAliases.set(aliasKey(configuredInstance, sender), placeholder.id);
      console.log(`[customer] identidade @lid reconciliada em memória | clienteId=${placeholder.id}`);
      return placeholder;
    }
  }

  const novoCliente = await createCliente({ nome, sender, instancia: configuredInstance, fbEventId, origem });
  console.log(`[postgres] cliente incluído | clienteId=${novoCliente?.id || '-'} | sender=${maskJid(sender)}`);
  return novoCliente;
}

async function saveInteraction({ clienteId, mensagemId, mensagem, type, fromMe, mensagemRespostaId, mediaUrl, sender, instanceName }) {
  if (!type) return null;
  getConfiguredInstance(instanceName);

  const postgres = requirePool();

  const clientePhone = jidToMessagePhone(sender);
  const botPhone = env.botPhoneNumber || null;
  const celularEnvio = fromMe ? botPhone : clientePhone;
  const celularRecebimento = fromMe ? clientePhone : botPhone;
  const result = await postgres.query(
    `
      INSERT INTO Bot.Mensagens
        (clienteId, mensagemId, mensagem, type, status, fromMe, mensagemRespostaId, mediaUrl, celularEnvio, celularRecebimento)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
    [
      clienteId || null,
      mensagemId || null,
      mensagem || null,
      type,
      fromMe ? 'sent' : 'received',
      Boolean(fromMe),
      mensagemRespostaId || null,
      mediaUrl || null,
      celularEnvio || null,
      celularRecebimento || null,
    ],
  );

  console.log(`${flowPrefix(mensagemId)} [postgres] mensagem persistida | registroId=${result.rows[0]?.id || '-'} | clienteId=${clienteId || '-'} | direção=${fromMe ? 'saída' : 'entrada'} | tipo=${type}`);
  return result.rows[0] || null;
}

async function saveOutgoingMessage({ instanceName, sender, mensagemId, mensagem }) {
  const cliente = await findClienteBySender({ sender, instanceName });
  return saveInteraction({
    clienteId: cliente?.id,
    mensagemId,
    mensagem,
    type: 'text',
    fromMe: true,
    sender,
    instanceName,
  });
}

const MAX_HISTORY_MESSAGES = 20;

async function isPaused(clienteId) {
  if (!clienteId) return false;

  const postgres = requirePool();
  const result = await postgres.query(
    'SELECT iaPausada AS "iaPausada" FROM Bot.Cliente WHERE id = $1 LIMIT 1',
    [clienteId],
  );
  return result.rows[0]?.iaPausada === true;
}

async function pause(clienteId) {
  if (!clienteId) return;

  const postgres = requirePool();
  await postgres.query(
    'UPDATE Bot.Cliente SET iaPausada = TRUE, updatedAt = NOW() WHERE id = $1',
    [clienteId],
  );
}

async function resume(clienteId) {
  if (!clienteId) return;

  const postgres = requirePool();
  await postgres.query(
    'UPDATE Bot.Cliente SET iaPausada = FALSE, updatedAt = NOW() WHERE id = $1',
    [clienteId],
  );
}

// Reconstrói o histórico de conversa a partir de Bot.Mensagens, para o
// contexto da IA sobreviver a um restart do processo. Precisa ser chamado
// antes de persistir as mensagens do turno atual, senão elas apareceriam
// duplicadas (uma vez no histórico, outra como a mensagem do turno).
async function getRecentHistory(clienteId, { limit = MAX_HISTORY_MESSAGES } = {}) {
  if (!clienteId) return [];

  const postgres = requirePool();
  const result = await postgres.query(
    `
      SELECT mensagem, fromMe AS "fromMe"
      FROM Bot.Mensagens
      WHERE clienteId = $1 AND mensagem IS NOT NULL AND mensagem <> ''
      ORDER BY createdAt DESC, id DESC
      LIMIT $2
    `,
    [clienteId, limit],
  );

  return result.rows
    .reverse()
    .map((row) => ({ role: row.fromMe ? 'assistant' : 'user', content: row.mensagem }));
}

async function hasRepliedBefore({ clienteId }) {
  if (!clienteId) return false;

  const postgres = requirePool();

  const result = await postgres.query(
    'SELECT 1 AS existe FROM Bot.Mensagens WHERE clienteId = $1 AND fromMe = TRUE LIMIT 1',
    [clienteId],
  );
  return result.rows.length > 0;
}

module.exports = {
  ensureCustomer,
  findClienteBySender,
  saveInteraction,
  saveOutgoingMessage,
  hasRepliedBefore,
  isPaused,
  pause,
  resume,
  getRecentHistory,
};
