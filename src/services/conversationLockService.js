// Mutex em memória por conversa: evita processar dois turnos da mesma
// conversa em paralelo (ex: duas mensagens chegando quase juntas). Não
// precisa sobreviver a restart — um processo novo não tem turno em
// andamento, então começar sem locks é o estado correto.
class ConversationLockService {
  constructor() {
    this.locks = new Set();
  }

  buildKey(instanceName, remoteJid) {
    return `${instanceName}::${remoteJid}`;
  }

  isLocked(instanceName, remoteJid) {
    return this.locks.has(this.buildKey(instanceName, remoteJid));
  }

  lock(instanceName, remoteJid) {
    this.locks.add(this.buildKey(instanceName, remoteJid));
  }

  unlock(instanceName, remoteJid) {
    this.locks.delete(this.buildKey(instanceName, remoteJid));
  }
}

module.exports = new ConversationLockService();
