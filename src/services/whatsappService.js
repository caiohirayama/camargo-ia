const env = require('../config/env');

// Provedor de WhatsApp escolhido por WHATSAPP_PROVIDER (evolution | waha).
// Os dois services expõem a mesma interface usada pelo resto da aplicação.
module.exports = env.whatsappProvider === 'waha'
  ? require('./wahaService')
  : require('./evolutionService');
