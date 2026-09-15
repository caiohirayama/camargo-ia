const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function listFiles(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath, extension);
    return fullPath.endsWith(extension) ? [fullPath] : [];
  });
}

test('runtime não contém regras do modelo anterior', () => {
  const source = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /MyBox|marcenaria|expansao|franquia|ClienteLeadState|RelacionamentoUpsert/i);
  assert.doesNotMatch(source, /MyIcar|Balneario|Camboriu|veiculo|agendamento|verificar_disponibilidade|googleCalendar/i);
});

test('runtime só insere em cliente/mensagens; Bot.Mensagens nunca é alterado ou apagado', () => {
  const source = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  // Bot.Mensagens é log de auditoria imutável: sem UPDATE nem DELETE nunca.
  // Bot.Cliente aceita UPDATE só para a flag operacional iaPausada (não é
  // status comercial/lead) — ver customerService.pause/resume.
  assert.doesNotMatch(source, /\bDELETE\s+FROM\s+(?:Bot|dbo)\./i);
  assert.doesNotMatch(source, /\bMERGE\s+INTO\s+(?:Bot|dbo)\./i);
  assert.doesNotMatch(source, /UPDATE\s+Bot\.Mensagens/i);
  assert.doesNotMatch(source, /\.execute\s*\(/i);

  const inserts = [...source.matchAll(/INSERT\s+INTO\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.deepEqual([...new Set(inserts)].sort(), ['Bot.Cliente', 'Bot.Mensagens']);

  const updates = [...source.matchAll(/UPDATE\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.deepEqual([...new Set(updates)].sort(), ['Bot.Cliente']);
});

test('runtime e migrações usam somente PostgreSQL', () => {
  const runtime = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const migrations = listFiles(path.join(root, 'sql'), '.sql')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.match(runtime, /require\('pg'\)/);
  assert.doesNotMatch(runtime, /require\('mssql'\)|SQL_SERVER_|SCOPE_IDENTITY|SELECT\s+TOP/i);
  assert.doesNotMatch(migrations, /\bNVARCHAR\b|\bDATETIME2\b|SYSUTCDATETIME|OBJECT_ID|COL_LENGTH|^GO$/im);
});

test('mantém somente o schema operacional da Camargo, sem migrations ou tabela de instâncias', () => {
  const sqlFiles = fs.readdirSync(path.join(root, 'sql'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);
  const schema = fs.readFileSync(path.join(root, 'sql', 'camargo_schema.sql'), 'utf8');

  assert.deepEqual(sqlFiles, ['camargo_schema.sql']);
  assert.doesNotMatch(schema, /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+Bot\.Instancias/i);
  assert.match(schema, /DROP\s+TABLE\s+IF\s+EXISTS\s+Bot\.Instancias/i);
  assert.doesNotMatch(sqlFiles.join('\n'), /^\d+_/m);
});

test('documenta e valida privilégios mínimos do PostgreSQL', () => {
  const databaseService = fs.readFileSync(path.join(root, 'src', 'services', 'databaseService.js'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  assert.match(databaseService, /'bot\.cliente', 'SELECT'\) AS read_customers/);
  assert.match(databaseService, /'bot\.cliente', 'INSERT'\) AS insert_customers/);
  assert.match(databaseService, /'bot\.cliente', 'iapausada', 'UPDATE'\) AS pause_customers/);
  assert.match(databaseService, /'bot\.mensagens', 'SELECT'\) AS read_messages/);
  assert.match(databaseService, /'bot\.mensagens', 'INSERT'\) AS insert_messages/);
  assert.doesNotMatch(readme, /GRANT SELECT, INSERT ON ALL TABLES/i);
  assert.doesNotMatch(readme, /GRANT[^\n]+bot\.instancias/i);
});

test('configuração da instância única vem somente do ambiente', () => {
  const runtime = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.doesNotMatch(runtime, /instanceConfigService|getInstanceConfig|Bot\.Instancias|bot\.instancias/);
  assert.match(runtime, /process\.env\.CAMARGO_INSTANCE_NAME/);
  assert.match(runtime, /process\.env\.EVOLUTION_API_URL/);
  assert.match(runtime, /process\.env\.EVOLUTION_API_KEY/);
  assert.match(runtime, /process\.env\.OPENAI_API_KEY/);
});

test('armazenamento de mídia usa configuração Cloudflare R2', () => {
  const runtime = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.match(runtime, /r2\.cloudflarestorage\.com/);
  assert.match(runtime, /region:\s*'auto'/);
  assert.match(runtime, /mediaUrl\s*=\s*null;[\s\S]*uploadMedia/);
  assert.doesNotMatch(runtime, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|AWS_S3_BUCKET/);
});

test('integração não contém contrato específico do Evolution Go', () => {
  const runtime = listFiles(path.join(root, 'src'), '.js')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.doesNotMatch(runtime, /data\?\.Message|data\?\.Info|\.IsFromMe|\/send\/text|\/message\/presence|\/user\/contacts/);
  assert.match(runtime, /\/message\/sendText\/\$\{/);
  assert.match(runtime, /MESSAGES_UPSERT/);
});

test('prompt não duplica fatos comerciais do RAG', () => {
  const prompt = fs.readFileSync(path.join(root, 'src', 'prompts', 'camargo_agent_prompt.md'), 'utf8');
  assert.doesNotMatch(prompt, /R\$|Jânio Quadros|1604|09h|18h|13h|domingo/i);
});

test('pausa da IA e histórico de conversa são persistidos em Bot.Cliente/Bot.Mensagens', () => {
  const customerServiceSource = fs.readFileSync(path.join(root, 'src', 'services', 'customerService.js'), 'utf8');
  assert.match(customerServiceSource, /UPDATE\s+Bot\.Cliente\s+SET\s+iaPausada\s*=\s*TRUE/i);
  assert.match(customerServiceSource, /UPDATE\s+Bot\.Cliente\s+SET\s+iaPausada\s*=\s*FALSE/i);
  assert.match(customerServiceSource, /FROM\s+Bot\.Mensagens[\s\S]*ORDER\s+BY\s+createdAt/i);

  const schema = fs.readFileSync(path.join(root, 'sql', 'camargo_schema.sql'), 'utf8');
  assert.match(schema, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+iaPausada\s+BOOLEAN/i);
});

test('lock de concorrência por conversa continua só em memória (não precisa sobreviver a restart)', () => {
  const conversationLockService = require('../src/services/conversationLockService');
  const instance = 'test-instance';
  const sender = '5511999999999@s.whatsapp.net';
  assert.equal(conversationLockService.isLocked(instance, sender), false);
  conversationLockService.lock(instance, sender);
  assert.equal(conversationLockService.isLocked(instance, sender), true);
  conversationLockService.unlock(instance, sender);
  assert.equal(conversationLockService.isLocked(instance, sender), false);
});

test('rotas de webhook e teste exigem autenticação', () => {
  const routes = fs.readFileSync(path.join(root, 'src', 'routes.js'), 'utf8');
  assert.match(routes, /\/webhook\/evolution'[\s\S]*requireWebhookSecret[\s\S]*express\.json\(\{ limit: '2mb' \}\)/);
  assert.match(routes, /router\.use\('\/test', requireTestApiKey\)/);
});
