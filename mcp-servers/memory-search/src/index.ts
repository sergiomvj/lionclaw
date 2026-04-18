import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import { z } from 'zod';

// ---- Config ----

const DB_PATH = path.join(os.homedir(), '.lionclaw', 'data', 'lionclaw.db');
const OPENAI_TIMEOUT_MS = 15_000;
const OLLAMA_TIMEOUT_MS = 10_000;
const COHERE_TIMEOUT_MS = 10_000;
const EMBEDDING_DIMS = 1536;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const COHERE_RERANK_MODEL = 'rerank-multilingual-v3.0';
const COHERE_RATE_LIMIT_MS = 650;

// ---- DB setup (read-only, WAL allows concurrent reads) ----

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
  }
  return db;
}

// ---- Settings helper ----

function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

// ---- Diacritics removal for BM25 queries ----

const DIACRITICS_MAP: Record<string, string> = {
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
  'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
  'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
  'ý': 'y', 'ÿ': 'y',
  'ñ': 'n', 'ç': 'c',
  'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
  'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
  'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I',
  'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
  'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U',
  'Ý': 'Y', 'Ñ': 'N', 'Ç': 'C',
};

function stripDiacritics(text: string): string {
  return text.replace(/[^\x00-\x7F]/g, (char) => DIACRITICS_MAP[char] ?? char);
}

// ---- L2 normalization ----

function normalizeL2(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ---- OpenAI Provider ----

async function generateEmbeddingOpenAI(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) return null;

    return normalizeL2(embedding);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Ollama Provider (fallback, only if dims match) ----

async function generateEmbeddingOllama(text: string): Promise<number[] | null> {
  const ollamaEnabled = getSetting('ollama_enabled') === 'true';
  if (!ollamaEnabled) return null;

  const baseUrl = getSetting('ollama_base_url') || 'http://localhost:11434';
  const model = getSetting('ollama_embedding_model') || 'nomic-embed-text';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { embedding?: number[] };
    if (!data.embedding || data.embedding.length === 0) return null;

    const normalized = normalizeL2(data.embedding);

    // Dimensions must match stored vectors
    if (normalized.length !== EMBEDDING_DIMS) return null;

    return normalized;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate query embedding: OpenAI first, Ollama fallback (if dims match).
 * Returns null if all providers fail -> search degrades to BM25-only.
 */
async function generateQueryEmbedding(text: string): Promise<number[] | null> {
  const openaiResult = await generateEmbeddingOpenAI(text);
  if (openaiResult) return openaiResult;
  return generateEmbeddingOllama(text);
}

// ---- Cohere Reranking ----

let lastCohereCallAt = 0;

async function cohereRerank(
  query: string,
  documents: Array<{ id: number; content: string }>,
  topN: number,
): Promise<Array<{ id: number; content: string; relevanceScore: number }> | null> {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey || documents.length === 0) return null;

  // Rate limit: max ~1.5 req/s
  const now = Date.now();
  const elapsed = now - lastCohereCallAt;
  if (elapsed < COHERE_RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, COHERE_RATE_LIMIT_MS - elapsed));
  }
  lastCohereCallAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COHERE_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: COHERE_RERANK_MODEL,
        query,
        documents: documents.map((d) => d.content),
        top_n: topN,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };

    if (!data.results) return null;

    return data.results.map((r) => ({
      id: documents[r.index].id,
      content: documents[r.index].content,
      relevanceScore: r.relevance_score,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- BM25 search via FTS5 ----

function searchBM25(query: string, limit: number): Array<{ id: number; content: string; topic: string; created_at: string }> {
  // Sanitize FTS5 special characters
  const sanitized = query.replace(/["*(){}[\]^~\\:]/g, ' ').trim();
  if (!sanitized) return [];

  // Strip diacritics for accent-insensitive matching
  const normalized = stripDiacritics(sanitized);

  // Convert to OR between terms (FTS5 uses implicit AND by default)
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const orQuery = terms.join(' OR ');

  try {
    return getDb().prepare(`
      SELECT sm.id, sm.content, sm.topic, sm.created_at
      FROM semantic_memories_fts fts
      JOIN semantic_memories sm ON sm.id = fts.rowid
      WHERE semantic_memories_fts MATCH ?
      ORDER BY bm25(semantic_memories_fts) ASC
      LIMIT ?
    `).all(orQuery, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;
  } catch {
    return [];
  }
}

// ---- Vector search via sqlite-vec ----

function searchVector(queryBuf: Buffer, limit: number): Array<{ id: number; content: string; topic: string; created_at: string }> {
  try {
    return getDb().prepare(`
      SELECT sm.id, sm.content, sm.topic, sm.created_at
      FROM semantic_memories_vec v
      JOIN semantic_memories sm ON CAST(sm.id AS TEXT) = v.id
      WHERE v.embedding MATCH ?
      AND k = ?
      ORDER BY distance ASC
    `).all(queryBuf, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;
  } catch {
    // Fallback to non-KNN query if MATCH syntax not supported
    try {
      return getDb().prepare(`
        SELECT sm.id, sm.content, sm.topic, sm.created_at,
               vec_distance_cosine(v.embedding, ?) AS distance
        FROM semantic_memories_vec v
        JOIN semantic_memories sm ON CAST(sm.id AS TEXT) = v.id
        ORDER BY distance ASC
        LIMIT ?
      `).all(queryBuf, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;
    } catch {
      return [];
    }
  }
}

// ---- LIKE fallback ----

function searchLike(query: string, limit: number): Array<{ id: number; content: string; topic: string; created_at: string }> {
  try {
    return getDb().prepare(`
      SELECT id, content, topic, created_at
      FROM semantic_memories
      WHERE content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;
  } catch {
    return [];
  }
}

// ---- Reciprocal Rank Fusion ----

interface MemoryRow {
  id: number;
  content: string;
  topic: string;
  created_at: string;
}

function reciprocalRankFusion(
  rankedLists: Array<MemoryRow[]>,
  k: number = 60,
): Array<MemoryRow & { rrf_score: number }> {
  const scores = new Map<number, { score: number; item: MemoryRow }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfContribution = 1.0 / (k + rank + 1);
      const existing = scores.get(item.id);
      if (existing) {
        existing.score += rrfContribution;
      } else {
        scores.set(item.id, { score: rrfContribution, item });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, item }) => ({ ...item, rrf_score: score }));
}

// ---- Hybrid search ----

interface SearchResult extends MemoryRow {
  score: number;
  sources: string[];
}

async function hybridSearch(
  query: string,
  limit: number,
  topic?: string,
): Promise<SearchResult[]> {
  const candidateLimit = Math.max(limit * 3, 30);
  const rankedLists: MemoryRow[][] = [];
  const sourceMap = new Map<number, Set<string>>();

  // BM25
  const bm25Hits = searchBM25(topic ? `${query} ${topic}` : query, candidateLimit);
  if (bm25Hits.length > 0) {
    rankedLists.push(bm25Hits);
    for (const r of bm25Hits) {
      const s = sourceMap.get(r.id) || new Set();
      s.add('bm25');
      sourceMap.set(r.id, s);
    }
  }

  // Vector search
  const embedding = await generateQueryEmbedding(query);
  if (embedding) {
    const queryBuf = Buffer.from(new Float32Array(embedding).buffer);
    const vecHits = searchVector(queryBuf, candidateLimit);
    if (vecHits.length > 0) {
      rankedLists.push(vecHits);
      for (const r of vecHits) {
        const s = sourceMap.get(r.id) || new Set();
        s.add('vector');
        sourceMap.set(r.id, s);
      }
    }
  }

  // Fallback to LIKE
  if (rankedLists.length === 0) {
    const likeHits = searchLike(query, limit);
    return likeHits.map((r) => ({ ...r, score: 0, sources: ['like'] }));
  }

  // RRF fusion
  const fused = reciprocalRankFusion(rankedLists);
  const topCandidates = fused.slice(0, Math.max(limit * 2, 20));

  // Cohere reranking (if API key available)
  const rerankInput = topCandidates.map((r) => ({ id: r.id, content: r.content }));
  const reranked = await cohereRerank(query, rerankInput, limit);

  if (reranked) {
    // Cohere available: use relevance scores (0-1 range)
    const rerankMap = new Map(topCandidates.map((r) => [r.id, r]));
    return reranked.map((r) => {
      const original = rerankMap.get(r.id)!;
      return {
        ...original,
        score: r.relevanceScore,
        sources: [...(Array.from(sourceMap.get(r.id) || [])), 'rerank'],
      };
    });
  }

  // No rerank: normalize RRF scores to 0-1
  const maxRrf = topCandidates[0]?.rrf_score ?? 1;
  return topCandidates.slice(0, limit).map((r) => ({
    ...r,
    score: maxRrf > 0 ? r.rrf_score / maxRrf : 0,
    sources: Array.from(sourceMap.get(r.id) || []),
  }));
}

// ---- Stats ----

function getMemoryStats(): { total: number; withEmbedding: number; ftsIndexed: number } {
  const d = getDb();
  const total = (d.prepare('SELECT COUNT(*) as c FROM semantic_memories').get() as { c: number }).c;
  const withEmbedding = (d.prepare('SELECT COUNT(*) as c FROM semantic_memories WHERE embedding IS NOT NULL').get() as { c: number }).c;
  let ftsIndexed = 0;
  try {
    ftsIndexed = (d.prepare('SELECT COUNT(*) as c FROM semantic_memories_fts').get() as { c: number }).c;
  } catch { /* FTS table may not exist */ }
  return { total, withEmbedding, ftsIndexed };
}

// ---- MCP Server ----

const server = new McpServer({
  name: 'memory-search',
  version: '1.1.0',
});

server.tool(
  'memory_search',
  `Busca na memoria de longo prazo do LionClaw usando busca hibrida (BM25 keywords + similaridade semantica vetorial + Cohere reranking).
Use esta tool quando o usuario perguntar sobre algo que voces ja conversaram, pedir para lembrar de algo,
ou quando voce precisar de contexto de conversas anteriores.
Exemplos de quando usar:
- "lembra daquele video que falamos?"
- "o que decidimos sobre o projeto X?"
- "qual era o nome daquela ferramenta?"
- "o que conversamos ontem sobre deploy?"
- qualquer referencia a conversas, decisoes ou contexto passado`,
  {
    query: z.string().describe('O que buscar na memoria. Pode ser uma pergunta, palavras-chave, ou descricao do que quer lembrar.'),
    topic: z.string().optional().describe('Topico opcional para filtrar (ex: "deploy", "projeto X")'),
    limit: z.number().optional().default(10).describe('Numero maximo de resultados (padrao: 10)'),
  },
  async ({ query, topic, limit }) => {
    try {
      const results = await hybridSearch(query, limit || 10, topic);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Nenhuma memoria encontrada para: "${query}". O banco de memorias pode estar vazio ou o termo nao corresponde a nenhum conteudo armazenado.`,
          }],
        };
      }

      const formatted = results.map((r, i) => {
        const date = r.created_at?.split(' ')[0] || 'data desconhecida';
        const sources = r.sources.join('+');
        return `### [${i + 1}] ${r.topic || 'Sem topico'} (${date}) [${sources}] score=${r.score.toFixed(4)}\n${r.content}`;
      }).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Encontrei ${results.length} memorias relevantes:\n\n${formatted}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Erro na busca de memoria: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_stats',
  'Retorna estatisticas sobre o banco de memorias semanticas (total de memorias, com embedding, indexadas no FTS5).',
  {},
  async () => {
    try {
      const stats = getMemoryStats();
      const hasCohere = !!process.env.COHERE_API_KEY;
      return {
        content: [{
          type: 'text' as const,
          text: `Estatisticas de memoria:\n- Total de memorias: ${stats.total}\n- Com embedding vetorial: ${stats.withEmbedding}\n- Indexadas no FTS5 (BM25): ${stats.ftsIndexed}\n- Cohere reranking: ${hasCohere ? 'ativo' : 'inativo (sem API key)'}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Erro ao obter stats: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
);

// ---- Start ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`memory-search MCP failed: ${err}\n`);
  process.exit(1);
});
