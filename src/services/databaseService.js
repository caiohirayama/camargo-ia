const { Pool } = require('pg');
const env = require('../config/env');
const { errorSummary } = require('../utils/logContext');

const poolConfig = env.databaseUrl
  ? { connectionString: env.databaseUrl }
  : {
      host: env.postgresHost,
      port: env.postgresPort,
      database: env.postgresDatabase,
      user: env.postgresUser,
      password: env.postgresPassword,
    };

poolConfig.max = 10;
poolConfig.idleTimeoutMillis = 30000;
poolConfig.connectionTimeoutMillis = 10000;
poolConfig.query_timeout = 15000;
if (env.postgresSsl) {
  poolConfig.ssl = {
    rejectUnauthorized: env.postgresSslRejectUnauthorized,
    ...(env.postgresSslCa ? { ca: env.postgresSslCa } : {}),
  };
}

let pool;

function isPostgresConfigured() {
  return Boolean(
    env.databaseUrl ||
      (env.postgresHost && env.postgresDatabase && env.postgresUser && env.postgresPassword),
  );
}

function getPool() {
  if (!isPostgresConfigured()) return null;

  if (!pool) {
    pool = new Pool(poolConfig);
    pool.on('error', (error) => {
      console.error('[postgres] erro inesperado no pool:', errorSummary(error));
    });
  }

  return pool;
}

async function checkDatabaseConnection() {
  const postgres = getPool();
  if (!postgres) {
    throw new Error(
      'PostgreSQL não configurado. Informe DATABASE_URL ou todas as variáveis POSTGRES_HOST, POSTGRES_DATABASE, POSTGRES_USER e POSTGRES_PASSWORD.',
    );
  }

  await postgres.query(`
    SELECT id, nome, telefone, sender, instancia, fbEventId, origem, gestaoClickClienteId, createdAt, updatedAt
    FROM Bot.Cliente
    LIMIT 0
  `);
  await postgres.query(`
    SELECT
      id, clienteId, mensagemId, mensagem, type, status, fromMe,
      mensagemRespostaId, mediaUrl, celularEnvio, celularRecebimento, createdAt
    FROM Bot.Mensagens
    LIMIT 0
  `);

  const permissions = await postgres.query(`
    SELECT
      has_table_privilege(current_user, 'bot.cliente', 'SELECT') AS read_customers,
      has_table_privilege(current_user, 'bot.cliente', 'INSERT') AS insert_customers,
      has_column_privilege(current_user, 'bot.cliente', 'iapausada', 'UPDATE') AS pause_customers,
      has_column_privilege(current_user, 'bot.cliente', 'gestaoclickclienteid', 'UPDATE') AS link_gestaoclick_customers,
      has_table_privilege(current_user, 'bot.mensagens', 'SELECT') AS read_messages,
      has_table_privilege(current_user, 'bot.mensagens', 'INSERT') AS insert_messages,
      has_sequence_privilege(
        current_user,
        pg_get_serial_sequence('bot.cliente', 'id'),
        'USAGE'
      ) AS use_customer_ids,
      has_sequence_privilege(
        current_user,
        pg_get_serial_sequence('bot.mensagens', 'id'),
        'USAGE'
      ) AS use_message_ids
  `);
  const missingPermission = Object.entries(permissions.rows[0]).find(([, allowed]) => !allowed);
  if (missingPermission) throw new Error(`Permissão PostgreSQL ausente: ${missingPermission[0]}`);

  return true;
}

module.exports = {
  getPool,
  checkDatabaseConnection,
};
