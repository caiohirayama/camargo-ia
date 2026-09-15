const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.TEST_DATABASE_URL;
const schemaFile = 'camargo_schema.sql';

test('schema e consultas funcionam em PostgreSQL', { skip: !connectionString }, async (t) => {
  process.env.DATABASE_URL = connectionString;
  const pool = new Pool({ connectionString });
  const databaseResult = await pool.query('SELECT current_database() AS name');
  const databaseName = databaseResult.rows[0].name;
  assert.match(databaseName, /_test$/, 'TEST_DATABASE_URL deve apontar para um banco terminado em _test');

  await pool.query('DROP SCHEMA IF EXISTS bot CASCADE');
  t.after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS bot CASCADE');
    await pool.end();
  });

  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', schemaFile), 'utf8');
  await pool.query(sql);

  process.env.CAMARGO_INSTANCE_NAME = 'camargo-test';
  process.env.CAMARGO_PHONE_NUMBER = '5547999999999';
  const customerService = require('../src/services/customerService');

  const requests = Array.from({ length: 2 }, () =>
    customerService.ensureCustomer({
      nome: 'Cliente Teste',
      sender: '5547988888888@s.whatsapp.net',
      instanceName: 'camargo-test',
    }),
  );
  const customers = await Promise.all(requests);
  assert.equal(customers[0].id, customers[1].id);

  const interaction = await customerService.saveInteraction({
    clienteId: customers[0].id,
    mensagemId: 'message-1',
    mensagem: 'Olá',
    type: 'text',
    fromMe: false,
    sender: '5547988888888@s.whatsapp.net',
    instanceName: 'camargo-test',
  });
  assert.ok(interaction.id);

  assert.equal(await customerService.isPaused(customers[0].id), false);
  await customerService.pause(customers[0].id);
  assert.equal(await customerService.isPaused(customers[0].id), true);
  await customerService.resume(customers[0].id);
  assert.equal(await customerService.isPaused(customers[0].id), false);

  await customerService.saveInteraction({
    clienteId: customers[0].id,
    mensagemId: 'message-2',
    mensagem: 'Certo, obrigado!',
    type: 'text',
    fromMe: true,
    sender: '5547988888888@s.whatsapp.net',
    instanceName: 'camargo-test',
  });
  const history = await customerService.getRecentHistory(customers[0].id);
  assert.deepEqual(history, [
    { role: 'user', content: 'Olá' },
    { role: 'assistant', content: 'Certo, obrigado!' },
  ]);
});
