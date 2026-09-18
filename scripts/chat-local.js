// Testa o fluxo de IA (prompt + RAG + consultar_produtos) isoladamente, sem
// subir o Express e sem depender de Evolution API, R2 ou PostgreSQL — só
// precisa de OPENAI_API_KEY (e GESTAOCLICK_* pra testar consulta de produto).
// Uso: node scripts/chat-local.js
const readline = require('readline');
const aiService = require('../src/services/aiService');

const history = [];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('Chat local Camargo IA — digite uma mensagem (ou "sair" para encerrar).\n');

function ask() {
  rl.question('você: ', async (input) => {
    const message = input.trim();
    if (!message) return ask();
    if (message.toLowerCase() === 'sair') {
      rl.close();
      return;
    }

    try {
      const result = await aiService.generateReply({ history, userText: message });
      console.log(`ia: ${result.replyText}`);
      if (result.transferToHuman) console.log('  [transferir_humano: true]');
      if (result.orcamento) console.log('  [orcamento]', JSON.stringify(result.orcamento));

      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: result.replyText });
    } catch (error) {
      console.error('erro:', error?.response?.data || error.message);
    }

    if (!rl.closed) ask();
  });
}

ask();
