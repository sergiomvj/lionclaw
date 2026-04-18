/**
 * Centralized embedding generation with provider fallback chain.
 *
 * Priority:
 *   1. OpenAI text-embedding-3-small (1536 dims, reliable, paid)
 *   2. Ollama nomic-embed-text (768 dims, local, free) -- only if dimensions match config
 *
 * IMPORTANT: All embeddings in a single database must use the same dimensions.
 * The configured EMBEDDING_DIMS determines which providers are compatible.
 */

import { createLogger } from './logger';
import { getSetting } from './db';
import { getSecret } from './secrets-vault';

const logger = createLogger('embedding-provider');

const OPENAI_TIMEOUT_MS = 15_000;
const OLLAMA_TIMEOUT_MS = 30_000;

/** Default embedding dimensions - matches OpenAI text-embedding-3-small */
export const EMBEDDING_DIMS = 1536;
export const EMBEDDING_MODEL = 'text-embedding-3-small';

function normalizeL2(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ---- OpenAI Provider ----

async function generateEmbeddingOpenAI(text: string): Promise<number[] | null> {
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) {
    logger.debug('OpenAI embedding skipped: no API key');
    return null;
  }

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

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.warn({ status: response.status, body: errText.substring(0, 200) }, 'OpenAI embedding failed');
      return null;
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) return null;

    return normalizeL2(embedding);
  } catch (err) {
    logger.warn({ err }, 'OpenAI embedding request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Ollama Provider ----

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

    // CRITICAL: check dimensions match. If Ollama model outputs different dims
    // than our configured EMBEDDING_DIMS, we cannot use it.
    if (normalized.length !== EMBEDDING_DIMS) {
      logger.warn(
        { expected: EMBEDDING_DIMS, got: normalized.length, model },
        'Ollama embedding dimensions mismatch, discarding',
      );
      return null;
    }

    return normalized;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Public API ----

export interface EmbeddingResult {
  embedding: number[];
  provider: 'openai' | 'ollama';
  model: string;
  dimensions: number;
}

/**
 * Generate an embedding for the given text.
 * Tries OpenAI first, falls back to Ollama (if dimensions match).
 * Returns null if all providers fail.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult | null> {
  // 1. Try OpenAI
  const openaiResult = await generateEmbeddingOpenAI(text);
  if (openaiResult) {
    return {
      embedding: openaiResult,
      provider: 'openai',
      model: EMBEDDING_MODEL,
      dimensions: openaiResult.length,
    };
  }

  // 2. Fallback to Ollama (only if dims match)
  const ollamaResult = await generateEmbeddingOllama(text);
  if (ollamaResult) {
    return {
      embedding: ollamaResult,
      provider: 'ollama',
      model: getSetting('ollama_embedding_model') || 'nomic-embed-text',
      dimensions: ollamaResult.length,
    };
  }

  logger.warn('All embedding providers failed');
  return null;
}

/**
 * Generate embeddings for multiple texts.
 */
export async function generateEmbeddings(texts: string[]): Promise<(EmbeddingResult | null)[]> {
  // OpenAI supports batch in a single request, but for simplicity
  // and fallback consistency, we process individually.
  return Promise.all(texts.map((t) => generateEmbedding(t)));
}
