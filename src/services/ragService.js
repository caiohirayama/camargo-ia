const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt']);
const MAX_CHUNK_CHARS = 1400;
const CHUNK_OVERLAP_CHARS = 180;

// Verbos e palavras funcionais de altíssima frequência: aparecem em quase
// qualquer chunk e por isso não discriminam nada. Sem eles, respostas curtas
// e genéricas do cliente (ex: "pode ser as 9") ficam sem nenhum token de
// conteúdo real, e a busca corretamente retorna vazio em vez de casar por
// acidente com um chunk qualquer que contenha essas palavras comuns.
const STOPWORDS = new Set([
  'a', 'ao', 'aos', 'as', 'ate', 'com', 'como', 'da', 'das', 'de', 'do',
  'dos', 'e', 'em', 'essa', 'esse', 'esta', 'este', 'eu', 'foi', 'mais',
  'mas', 'me', 'minha', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para',
  'por', 'pra', 'qual', 'que', 'se', 'sem', 'sobre', 'sua', 'um', 'uma',
  'voce', 'voces',
  'pode', 'podem', 'poder', 'posso', 'podendo', 'ser', 'sendo', 'sido',
  'estou', 'estamos', 'estao', 'estive', 'estava', 'tem', 'tenho', 'temos',
  'tinha', 'ter', 'tera', 'vou', 'vai', 'vamos', 'iria', 'irei', 'ja',
  'ainda', 'so', 'bem', 'bom', 'boa', 'entao', 'tambem', 'aqui', 'ali',
  'agora', 'sim', 'nao', 'tudo', 'todo', 'toda', 'todos', 'todas', 'muito',
  'muita', 'muitos', 'muitas', 'oi', 'ola', 'obrigado', 'obrigada', 'seja',
  'quero', 'queria', 'gostaria', 'consegue', 'consigo',
]);

let cache = {
  loadedAt: 0,
  signature: '',
  chunks: [],
};

let warnedEmptyKnowledge = false;

function resolveKnowledgeDir() {
  if (!env.ragKnowledgeDir) {
    return path.join(__dirname, '..', 'rag', 'knowledge');
  }

  return path.isAbsolute(env.ragKnowledgeDir)
    ? env.ragKnowledgeDir
    : path.resolve(process.cwd(), env.ragKnowledgeDir);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

// Radical simples: aproxima variações de uma mesma palavra em português
// (entregar/entrega/entregas, retirar/retirada/retiradas) sem
// um stemmer completo, já que o índice é só correspondência exata de token.
function stem(token) {
  return token.length > 4 ? token.slice(0, 4) : token;
}

function listKnowledgeFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listKnowledgeFiles(fullPath);
      }

      return SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ? [fullPath]
        : [];
    })
    .sort();
}

function getSignature(files) {
  return files
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
}

function extractTitle(content, filePath) {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) {
    return heading[1].trim();
  }

  return path.basename(filePath, path.extname(filePath));
}

function splitIntoChunks(content) {
  const normalizedContent = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!normalizedContent) {
    return [];
  }

  const paragraphs = normalizedContent
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;

    if (next.length <= MAX_CHUNK_CHARS) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (paragraph.length <= MAX_CHUNK_CHARS) {
      current = paragraph;
      continue;
    }

    for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS) {
      chunks.push(paragraph.slice(start, start + MAX_CHUNK_CHARS).trim());
    }

    current = '';
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildChunks(files, baseDir) {
  return files.flatMap((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const title = extractTitle(content, filePath);
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');

    return splitIntoChunks(content).map((chunk, index) => {
      const tokens = tokenize(`${title}\n${chunk}`);
      return {
        id: `${relativePath}#${index + 1}`,
        title,
        source: relativePath,
        index: index + 1,
        content: chunk,
        tokens,
        stems: tokens.map(stem),
        normalizedContent: normalizeText(chunk),
        normalizedTitle: normalizeText(title),
      };
    });
  });
}

function loadIndex({ force = false } = {}) {
  const knowledgeDir = resolveKnowledgeDir();
  const files = listKnowledgeFiles(knowledgeDir);
  const signature = getSignature(files);

  if (!force && cache.loadedAt && cache.signature === signature) {
    return cache;
  }

  cache = {
    loadedAt: Date.now(),
    signature,
    chunks: buildChunks(files, knowledgeDir),
  };

  if (!cache.chunks.length && !warnedEmptyKnowledge) {
    warnedEmptyKnowledge = true;
    console.warn(`[rag] nenhuma base de conhecimento encontrada em ${knowledgeDir}`);
  }

  console.log(`[rag] indice carregado: ${cache.chunks.length} chunk(s) em ${knowledgeDir}`);
  return cache;
}

function scoreChunk(queryTokens, normalizedQuery, chunk) {
  if (!queryTokens.length) {
    return 0;
  }

  const chunkTokenCounts = new Map();
  for (const token of chunk.tokens) {
    chunkTokenCounts.set(token, (chunkTokenCounts.get(token) || 0) + 1);
  }

  const chunkStemCounts = new Map();
  for (const tokenStem of chunk.stems) {
    chunkStemCounts.set(tokenStem, (chunkStemCounts.get(tokenStem) || 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    const count = chunkTokenCounts.get(token) || 0;
    if (count > 0) {
      score += 1 + Math.min(count, 4) * 0.35;
    } else {
      // Sem match exato: tenta o radical (ex: "retirar" aproxima "retirada").
      const tokenStem = stem(token);
      const stemCount = tokenStem !== token ? chunkStemCounts.get(tokenStem) || 0 : 0;
      if (stemCount > 0) {
        score += (1 + Math.min(stemCount, 4) * 0.35) * 0.7;
      }
    }

    if (chunk.normalizedTitle.includes(token)) {
      score += 1.5;
    }
  }

  if (normalizedQuery.length >= 12 && chunk.normalizedContent.includes(normalizedQuery)) {
    score += 4;
  }

  return score;
}

function search(query, options = {}) {
  if (!env.ragEnabled) {
    return [];
  }

  const topK = Number(options.topK) || env.ragTopK;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : env.ragMinScore;
  const index = loadIndex(options);
  const normalizedQuery = normalizeText(query).trim();
  const queryTokens = [...new Set(tokenize(query))];

  return index.chunks
    .map((chunk) => ({
      id: chunk.id,
      title: chunk.title,
      source: chunk.source,
      index: chunk.index,
      content: chunk.content,
      score: scoreChunk(queryTokens, normalizedQuery, chunk),
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function buildContext(query, options = {}) {
  const results = search(query, options);
  if (!results.length) {
    return null;
  }

  const context = results
    .map((item, index) => [
      `[Fonte ${index + 1}: ${item.source} | score ${item.score.toFixed(2)}]`,
      item.content,
    ].join('\n'))
    .join('\n\n---\n\n');

  return [
    'Contexto recuperado por RAG. Nao envie esse bloco ao cliente.',
    'Use esse contexto apenas quando ele for relevante para responder com precisao.',
    'Se o contexto nao contiver a informacao solicitada, nao invente.',
    'Nunca diga que consultou arquivos internos.',
    '',
    context,
  ].join('\n');
}

function getStatus() {
  const index = loadIndex();
  return {
    enabled: env.ragEnabled,
    knowledgeDir: resolveKnowledgeDir(),
    chunks: index.chunks.length,
    loadedAt: index.loadedAt,
  };
}

module.exports = {
  buildContext,
  getStatus,
  loadIndex,
  search,
};
