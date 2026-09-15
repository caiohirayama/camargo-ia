const evolutionService = require('../services/evolutionService');
const ragService = require('../services/ragService');

async function setWebhook(req, res) {
  try {
    const result = await evolutionService.setWebhook();
    return res.status(200).json({ ok: true, data: result.data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.response?.data || error.message,
    });
  }
}

async function sendTest(req, res) {
  try {
    const { remoteJid, text } = req.body || {};

    await evolutionService.sendText({
      remoteJid,
      text: text || 'Mensagem de teste enviada com sucesso.',
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.response?.data || error.message,
    });
  }
}

function getRagStatus(req, res) {
  try {
    return res.status(200).json({ ok: true, data: ragService.getStatus() });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

function searchRag(req, res) {
  try {
    const { query, topK, minScore } = req.body || {};

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Informe query como string.',
      });
    }

    return res.status(200).json({
      ok: true,
      data: {
        results: ragService.search(query, { topK, minScore }),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

module.exports = {
  setWebhook,
  sendTest,
  getRagStatus,
  searchRag,
};
