const blockedPatterns = [
  /vadia/i,
];

const safeReplies = [
  'Me respeita. Não fala assim comigo.',
  'Eu converso numa boa, mas com respeito.',
  'Que falta de respeito.',
];

function containsInappropriateContent(text = '') {
  return blockedPatterns.some((pattern) => pattern.test(text));
}

function getModerationReply() {
  return safeReplies[Math.floor(Math.random() * safeReplies.length)];
}

module.exports = {
  containsInappropriateContent,
  getModerationReply,
};
