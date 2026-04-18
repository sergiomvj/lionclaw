import fs from 'fs';
import path from 'path';
import { getDb, getSessionMessages, getSession, getSetting, insertChunkWithEmbedding, insertChunkPlainWithFTS, searchBM25, searchVector } from './db';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { generateEmbedding as generateEmbeddingProvider } from './embedding-provider';
import { ollamaChat } from './ollama-client';
import { executeVaultOperation, regenerateVaultIndex, updateVaultHot, appendVaultLog, getExistingVaultFilesList } from './mgraph-engine';
import { BrowserWindow } from 'electron';
import type { VaultOperation } from '../../src/types';

const logger = createLogger('memory');

function getLionClawPath(): string {
  return getLionClawHome();
}

/**
 * Run memory compaction for a given time period.
 * Summarizes messages, extracts facts, updates working memory,
 * creates semantic chunks with embeddings.
 */
export async function runCompaction(periodStart: Date, periodEnd: Date, sessionId?: string): Promise<void> {
  const db = getDb();

  // 1. Read raw messages - prefer sessionId if provided, fallback to date range
  let messages: Array<Record<string, unknown>>;
  if (sessionId) {
    messages = db.prepare(`
      SELECT m.*, s.title as session_title
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
  } else {
    // Date range fallback - format dates to match SQLite CURRENT_TIMESTAMP format (no T, no Z)
    const formatForSQLite = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
    messages = db.prepare(`
      SELECT m.*, s.title as session_title
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.created_at >= ? AND m.created_at <= ?
      ORDER BY m.created_at ASC
    `).all(formatForSQLite(periodStart), formatForSQLite(periodEnd)) as Array<Record<string, unknown>>;
  }

  if (messages.length === 0) {
    logger.info('No messages to compact');
    return;
  }

  logger.info({ count: messages.length }, 'Compacting messages');

  // 2. Build message text for summarization
  const messageText = messages.map((m) => {
    const role = m['role'] as string;
    const content = (m['content'] as string).substring(0, 2000);
    return `[${role}] ${content}`;
  }).join('\n\n');

  // 3. Summarize via Anthropic API
  let summary: CompactionResult;
  try {
    summary = await summarizeMessages(messageText);
  } catch (error) {
    logger.error({ error }, 'Summarization failed');
    return;
  }

  // 4. Update working memory and user profile
  if (summary.working_memory_updates) {
    await updateWorkingMemory(summary.working_memory_updates);
  }

  if (summary.user_profile_updates && summary.user_profile_updates.length > 0) {
    await updateUserProfile(summary.user_profile_updates);
  }

  // 5. Save semantic chunks (with embeddings via OpenAI/Ollama fallback)
  for (const chunk of summary.semantic_chunks) {
    try {
      const result = await generateEmbeddingProvider(chunk.content);
      if (result) {
        insertChunkWithEmbedding(chunk.content, chunk.topic, result.embedding);
        logger.debug({ provider: result.provider, model: result.model, dims: result.dimensions }, 'Chunk embedded');
        continue;
      }
    } catch (err) {
      logger.warn({ err }, 'Embedding generation failed, saving chunk without vector');
    }
    insertChunkPlainWithFTS(chunk.content, chunk.topic);
  }

  // 5b. Execute vault operations when mgraph_mode is active
  if (getSetting('mgraph_mode') === 'true' && summary.vault_operations && summary.vault_operations.length > 0) {
    let opsProcessed = 0;
    for (const op of summary.vault_operations) {
      try {
        const result = executeVaultOperation(op);
        if (result.success) {
          opsProcessed++;
          appendVaultLog(`[${new Date().toISOString()}] ${op.action.toUpperCase()} ${op.path} "${op.title}" (source:compaction)`);
        } else {
          logger.warn({ path: op.path, error: result.error }, 'Vault operation failed');
          appendVaultLog(`[${new Date().toISOString()}] FAILED ${op.path} "${op.title}" error:${result.error}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ path: op.path, error: errMsg }, 'Vault operation threw error');
        appendVaultLog(`[${new Date().toISOString()}] ERROR ${op.path} "${op.title}" error:${errMsg}`);
      }
    }

    regenerateVaultIndex();
    updateVaultHot();

    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mgraph:updated');
    }

    logger.info({ operations: opsProcessed }, 'Memory graph updated');
  }

  // 6. Save daily summary
  const dateStr = periodStart.toISOString().split('T')[0];
  db.prepare(`
    INSERT OR REPLACE INTO daily_summaries
    (date, summary, decisions, tasks_created, facts_extracted, message_count, subagents_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    dateStr,
    summary.executive_summary,
    JSON.stringify(summary.decisions),
    JSON.stringify(summary.tasks_created),
    JSON.stringify(summary.facts),
    messages.length,
    JSON.stringify([...new Set(messages.map((m) => m['subagent']).filter(Boolean))]),
  );

  // 7. Log compaction
  db.prepare(`
    INSERT INTO compaction_log (period_start, period_end, messages_processed, chunks_created, facts_updated)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    periodStart.toISOString(),
    periodEnd.toISOString(),
    messages.length,
    summary.semantic_chunks.length,
    summary.facts.length,
  );

  // 8. Archive transcript
  archiveTranscript(messages, dateStr, summary.executive_summary);

  logger.info({
    messages: messages.length,
    chunks: summary.semantic_chunks.length,
    facts: summary.facts.length,
  }, 'Compaction complete');
}

interface CompactionResult {
  executive_summary: string;
  decisions: string[];
  tasks_created: string[];
  facts: string[];
  semantic_chunks: Array<{ topic: string; content: string }>;
  user_profile_updates: Array<{ action: 'add' | 'remove'; section: string; fact: string }>;
  working_memory_updates: {
    add: string[];
    remove: string[];
  };
  vault_operations?: VaultOperation[];
}

const COMPACTION_PROMPT = `You are a memory management system. Analyze the following conversation messages and produce a structured summary.

MESSAGES:
{{MESSAGES}}

Separe os fatos em duas categorias:

1. **user_profile_updates**: Fatos sobre o USUARIO que devem ir no USER.md
   - Nome, profissao, stack tecnologico, preferencias de trabalho
   - Projetos em que esta trabalhando
   - Habitos e preferencias descobertos
   Formato: { action: 'add' | 'remove', section: string, fact: string }

2. **working_memory_updates**: Fatos sobre o CONTEXTO ATUAL que devem ir no MEMORY.md
   - Decisoes tomadas na conversa
   - Tarefas em andamento
   - Contexto temporario relevante

Produce a JSON response with this exact structure:
{
  "executive_summary": "3-5 sentence summary of the session",
  "decisions": ["Decision 1", "Decision 2"],
  "tasks_created": ["Task 1", "Task 2"],
  "facts": ["Fact about user or project 1", "Fact 2"],
  "semantic_chunks": [
    {
      "topic": "Short topic label",
      "content": "200-500 token summary of this topic with key details"
    }
  ],
  "user_profile_updates": [
    { "action": "add", "section": "Perfil profissional", "fact": "Desenvolve com TypeScript" }
  ],
  "working_memory_updates": {
    "add": ["New fact to add to working memory"],
    "remove": ["Stale fact to remove from working memory"]
  }
}

Rules:
- Facts should be atomic, one concept per fact
- Semantic chunks should be self-contained
- user_profile_updates: facts about the USER (relatively static info like role, preferences, tools)
- working_memory_updates: facts about CURRENT CONTEXT (temporary, situational)
- Always respond in Brazilian Portuguese
- Output ONLY the JSON, no markdown fences, no explanation`;

function buildVaultInstructionsBlock(): string {
  const existingFiles = getExistingVaultFilesList();
  return `

VAULT INSTRUCTIONS:
Alem do JSON principal, inclua um campo "vault_operations" no JSON de resposta.
Gere operacoes para alimentar o memory graph com informacoes significativas da conversa.

EXISTING_VAULT_FILES:
${existingFiles || '(nenhuma nota existente)'}

Regras para vault_operations:
- Use backlinks com [[filename-sem-extensao]] em kebab-case para conectar notas relacionadas
- Para notas que ja existem em EXISTING_VAULT_FILES, use action "update" com append:true
- Conteudo deve ser conciso, autocontido e em portugues
- Path format: {type}/{slug}.md onde type e: entities, meetings, decisions, projects, references
- Slug: lowercase, apenas a-z 0-9 hyphens, max 50 chars
- Somente crie notas para informacoes SIGNIFICATIVAS (entidades recorrentes, decisoes explicitas, projetos detalhados)
- Se nao houver informacao significativa, retorne "vault_operations": []

Formato de cada operacao:
{
  "action": "create" | "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Titulo legivel",
  "tags": ["tag1", "tag2"],
  "content": "Conteudo markdown com [[backlinks]]",
  "append": true  // apenas para updates
}`;
}

async function summarizeMessages(messageText: string): Promise<CompactionResult> {
  const ollamaEnabled = getSetting('ollama_enabled') === 'true';
  const ollamaBaseUrl = getSetting('ollama_base_url') || 'http://localhost:11434';
  const compactionModel = getSetting('ollama_compaction_model') || '';

  if (ollamaEnabled && compactionModel) {
    try {
      return await summarizeWithOllama(ollamaBaseUrl, compactionModel, messageText);
    } catch (err) {
      logger.warn({ err }, 'Ollama compaction failed, falling back to Claude');
    }
  }

  return await summarizeWithClaude(messageText);
}

async function summarizeWithOllama(
  baseUrl: string,
  model: string,
  messageText: string,
): Promise<CompactionResult> {
  let basePrompt = COMPACTION_PROMPT.replace('{{MESSAGES}}', messageText.substring(0, 30000));
  if (getSetting('mgraph_mode') === 'true') {
    basePrompt += buildVaultInstructionsBlock();
  }
  const prompt = 'CRITICAL: respond ONLY with valid JSON, no markdown, no explanation.\n\n' + basePrompt;

  logger.info({ model, messageLength: messageText.length }, 'Calling Ollama for summarization');

  const raw = await ollamaChat(baseUrl, model, prompt);

  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(text);
  } catch (parseError) {
    const debugPath = path.join(getLionClawPath(), 'data', 'last-compaction-response-ollama.txt');
    fs.writeFileSync(debugPath, text, 'utf-8');
    logger.error(
      { parseError: (parseError as Error).message, debugPath, first200: text.substring(0, 200) },
      'JSON parse failed on Ollama compaction response',
    );
    throw parseError;
  }
}

async function summarizeWithClaude(messageText: string): Promise<CompactionResult> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { getApiKey } = await import('./secrets-vault');
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('API key not configured');

    const client = new Anthropic({ apiKey });
    let prompt = COMPACTION_PROMPT.replace('{{MESSAGES}}', messageText.substring(0, 50000));
    if (getSetting('mgraph_mode') === 'true') {
      prompt += buildVaultInstructionsBlock();
    }

    logger.info({ messageLength: messageText.length, promptLength: prompt.length }, 'Calling Anthropic for summarization');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 20000,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? (b as { text: string }).text : ''))
      .join('');

    text = text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    logger.info({ responseLength: text.length }, 'Summarization response received');

    try {
      return JSON.parse(text);
    } catch (parseError) {
      const debugPath = path.join(getLionClawPath(), 'data', 'last-compaction-response.txt');
      fs.writeFileSync(debugPath, text, 'utf-8');
      logger.error({ parseError: (parseError as Error).message, debugPath, first200: text.substring(0, 200) }, 'JSON parse failed on summarization response');
      throw parseError;
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg, stack: error instanceof Error ? error.stack : undefined }, 'Anthropic summarization call failed');
    return {
      executive_summary: 'Compaction failed - messages preserved.',
      decisions: [],
      tasks_created: [],
      facts: [],
      semantic_chunks: [],
      user_profile_updates: [],
      working_memory_updates: { add: [], remove: [] },
    };
  }
}

async function updateWorkingMemory(updates: { add: string[]; remove: string[] }): Promise<void> {
  const memoryPath = path.join(getLionClawPath(), 'MEMORY.md');
  let content: string;

  try {
    content = fs.readFileSync(memoryPath, 'utf-8');
  } catch {
    content = '# LionClaw Working Memory\n\n## Fatos\n';
  }

  // Remove stale facts
  for (const fact of updates.remove) {
    content = content.replace(`- ${fact}\n`, '');
  }

  // Add new facts
  if (updates.add.length > 0) {
    const factsSection = updates.add.map((f) => `- ${f}`).join('\n');

    if (content.includes('## Contexto atual')) {
      content = content.replace(
        '## Contexto atual',
        `${factsSection}\n\n## Contexto atual`,
      );
    } else {
      content += `\n${factsSection}\n`;
    }
  }

  fs.writeFileSync(memoryPath, content, 'utf-8');
  logger.info({ added: updates.add.length, removed: updates.remove.length }, 'Working memory updated');
}

async function updateUserProfile(
  updates: Array<{ action: 'add' | 'remove'; section: string; fact: string }>,
): Promise<void> {
  const userPath = path.join(getLionClawPath(), 'USER.md');
  let content: string;

  try {
    content = fs.readFileSync(userPath, 'utf-8');
  } catch {
    content = '# Sobre o Usuario\n';
  }

  for (const update of updates) {
    if (update.action === 'remove') {
      content = content.replace(`- ${update.fact}\n`, '');
    } else if (update.action === 'add') {
      const sectionHeader = `## ${update.section}`;
      if (content.includes(sectionHeader)) {
        // Find the section and append the fact after it
        const sectionIndex = content.indexOf(sectionHeader);
        const nextSectionIndex = content.indexOf('\n## ', sectionIndex + sectionHeader.length);
        const insertPos = nextSectionIndex !== -1 ? nextSectionIndex : content.length;
        const factLine = `- ${update.fact}\n`;

        // Avoid duplicates
        if (!content.includes(factLine)) {
          content = content.slice(0, insertPos) + factLine + content.slice(insertPos);
        }
      } else {
        // Section doesn't exist, create it
        content += `\n${sectionHeader}\n- ${update.fact}\n`;
      }
    }
  }

  fs.writeFileSync(userPath, content, 'utf-8');
  logger.info({ updates: updates.length }, 'User profile updated');
}

function archiveTranscript(
  messages: Array<Record<string, unknown>>,
  dateStr: string,
  summary: string,
): void {
  const archiveDir = path.join(getLionClawPath(), 'conversations');
  fs.mkdirSync(archiveDir, { recursive: true });

  const lines = [
    `# Conversa ${dateStr}`,
    '',
    `## Resumo`,
    summary,
    '',
    `## Mensagens`,
    '',
  ];

  for (const msg of messages) {
    const role = msg['role'] as string;
    const content = (msg['content'] as string).substring(0, 5000);
    const time = (msg['created_at'] as string).split('T')[1]?.substring(0, 5) || '';
    lines.push(`### [${time}] ${role}`);
    lines.push(content);
    lines.push('');
  }

  const filename = `${dateStr}.md`;
  fs.writeFileSync(path.join(archiveDir, filename), lines.join('\n'), 'utf-8');
  logger.info({ filename }, 'Transcript archived');
}

/**
 * Reciprocal Rank Fusion (RRF) - combines rankings from multiple retrieval methods.
 * RRF score = sum(1 / (k + rank_i)) for each method i where the doc appears.
 * Higher score = more relevant.
 */
function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: number; content: string; topic: string; created_at: string }>>,
  k: number = 60,
): Array<{ id: number; content: string; topic: string; created_at: string; rrf_score: number }> {
  const scores = new Map<number, { score: number; item: { id: number; content: string; topic: string; created_at: string } }>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfContribution = 1.0 / (k + rank + 1); // rank is 0-indexed, so +1
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

export interface HybridSearchResult {
  id: number;
  content: string;
  topic: string;
  created_at: string;
  rrf_score: number;
  sources: string[];
}

/**
 * Hybrid search combining BM25 (keyword) + vector (semantic) with RRF fusion.
 * Falls back gracefully: if Ollama is off, uses BM25 only. If FTS5 fails, uses vector only.
 */
export async function hybridMemorySearch(query: string, limit: number = 10): Promise<HybridSearchResult[]> {
  const candidateLimit = Math.max(limit * 3, 30); // fetch more candidates for better fusion
  const rankedLists: Array<Array<{ id: number; content: string; topic: string; created_at: string }>> = [];
  const sourceMap = new Map<number, Set<string>>();

  // 1. BM25 search via FTS5
  try {
    const bm25Results = searchBM25(query, candidateLimit);
    if (bm25Results.length > 0) {
      rankedLists.push(bm25Results);
      for (const r of bm25Results) {
        const s = sourceMap.get(r.id) || new Set();
        s.add('bm25');
        sourceMap.set(r.id, s);
      }
      logger.info({ count: bm25Results.length }, 'BM25 search returned results');
    }
  } catch (err) {
    logger.warn({ err }, 'BM25 search failed');
  }

  // 2. Vector search via embedding-provider (OpenAI -> Ollama fallback)
  try {
    const embResult = await generateEmbeddingProvider(query);
    if (embResult) {
      const queryBuf = Buffer.from(new Float32Array(embResult.embedding).buffer);
      const vecResults = searchVector(queryBuf, candidateLimit);
      if (vecResults.length > 0) {
        rankedLists.push(vecResults);
        for (const r of vecResults) {
          const s = sourceMap.get(r.id) || new Set();
          s.add(`vector:${embResult.provider}`);
          sourceMap.set(r.id, s);
        }
        logger.info({ count: vecResults.length, provider: embResult.provider }, 'Vector search returned results');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Vector search failed');
  }

  // 3. If no results from either method, fallback to LIKE
  if (rankedLists.length === 0) {
    logger.info('No BM25 or vector results, falling back to LIKE search');
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, content, topic, created_at
      FROM semantic_memories
      WHERE content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`%${query}%`, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;

    return rows.map(r => ({ ...r, rrf_score: 0, sources: ['like'] }));
  }

  // 4. Fuse with RRF
  const fused = reciprocalRankFusion(rankedLists);

  // 5. Annotate sources and return top-K
  return fused.slice(0, limit).map(r => ({
    ...r,
    sources: Array.from(sourceMap.get(r.id) || []),
  }));
}

/**
 * Legacy search - kept for IPC backward compatibility.
 * Now delegates to hybridMemorySearch.
 */
export async function searchSemanticMemories(query: string, limit: number = 10) {
  return hybridMemorySearch(query, limit);
}

/**
 * Clean old raw messages beyond retention period.
 */
export function cleanOldMessages(retentionDays: number): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM messages WHERE created_at < ? AND session_id IN (
      SELECT id FROM sessions WHERE updated_at < ?
    )
  `).run(cutoff, cutoff);

  if ((result.changes as number) > 0) {
    logger.info({ deleted: result.changes, cutoff }, 'Old messages cleaned');
  }
}

/**
 * Archive a single conversation session to a markdown file in .lionclaw/conversations/.
 * Returns the absolute path of the written file.
 */
export function archiveConversation(sessionId: string): string {
  const session = getSession(sessionId);
  const messages = getSessionMessages(sessionId);

  const dateStr = session
    ? session.createdAt.split('T')[0]
    : new Date().toISOString().split('T')[0];

  const rawTitle = session?.title || sessionId;
  const titleSlug = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);

  const frontmatter = [
    '---',
    `date: ${dateStr}`,
    `session_id: ${sessionId}`,
    `message_count: ${messages.length}`,
    `title: "${rawTitle.replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n');

  const lines: string[] = [
    frontmatter,
    `# ${rawTitle}`,
    '',
  ];

  for (const msg of messages) {
    const time = msg.createdAt.split('T')[1]?.substring(0, 5) || '';
    const label = msg.subagent ? `${msg.role} (${msg.subagent})` : msg.role;
    lines.push(`### [${time}] ${label}`);
    lines.push('');
    lines.push(msg.content.substring(0, 5000));
    lines.push('');
  }

  const archiveDir = path.join(getLionClawPath(), 'conversations');
  fs.mkdirSync(archiveDir, { recursive: true });

  const filename = `${dateStr}-${titleSlug}.md`;
  const filePath = path.join(archiveDir, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  logger.info({ sessionId, filename, messageCount: messages.length }, 'Conversation archived');
  return filePath;
}
