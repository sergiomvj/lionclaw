import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('local-agent-config');

export interface LocalAgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  isActive: boolean;
  runtime: 'cloud' | 'local';
  localConfig?: {
    provider: 'ollama' | 'lmstudio' | 'openai-compatible';
    baseUrl: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  localMode: 'simple' | 'smart';
  maxToolRounds: number;
}

let db: Database.Database | null = null;

function getLionClawHome(): string {
  return process.env.LIONCLAW_HOME || path.join(process.env.HOME || '/tmp', '.lionclaw');
}

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(getLionClawHome(), 'data', 'lionclaw.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  logger.info({ dbPath }, 'SQLite connection opened (read-only)');
  return db;
}

export function loadAgentConfig(agentId: string): LocalAgentConfig | null {
  try {
    const database = getDb();
    const row = database.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const config: LocalAgentConfig = {
      id: row['id'] as string,
      name: row['name'] as string,
      description: row['description'] as string,
      systemPrompt: row['system_prompt'] as string,
      allowedTools: JSON.parse((row['allowed_tools'] as string) || '[]'),
      isActive: (row['is_active'] as number) === 1,
      runtime: (row['runtime'] as 'cloud' | 'local') || 'cloud',
      localConfig: row['local_config'] ? JSON.parse(row['local_config'] as string) : undefined,
      localMode: (row['local_mode'] as 'simple' | 'smart') || 'simple',
      maxToolRounds: (row['max_tool_rounds'] as number) || 5,
    };

    if (config.runtime !== 'local' || !config.localConfig) {
      logger.warn({ agentId }, 'Agent is not a local agent');
      return null;
    }

    return config;
  } catch (err) {
    logger.error({ err, agentId }, 'Failed to load agent config');
    return null;
  }
}

export function loadAgentRules(agentId: string): string | null {
  const rulesPath = path.join(getLionClawHome(), 'agents', agentId, 'RULES.md');
  try {
    return fs.readFileSync(rulesPath, 'utf-8');
  } catch {
    return null;
  }
}

export function loadAllLocalAgents(): LocalAgentConfig[] {
  try {
    const database = getDb();
    const rows = database.prepare(
      "SELECT * FROM agents WHERE is_active = 1 AND runtime = 'local'"
    ).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row['id'] as string,
      name: row['name'] as string,
      description: row['description'] as string,
      systemPrompt: row['system_prompt'] as string,
      allowedTools: JSON.parse((row['allowed_tools'] as string) || '[]'),
      isActive: true,
      runtime: 'local' as const,
      localConfig: row['local_config'] ? JSON.parse(row['local_config'] as string) : undefined,
      localMode: (row['local_mode'] as 'simple' | 'smart') || 'simple',
      maxToolRounds: (row['max_tool_rounds'] as number) || 5,
    })).filter((a) => a.localConfig);
  } catch (err) {
    logger.error({ err }, 'Failed to load local agents');
    return [];
  }
}

export async function checkOllamaHealth(): Promise<boolean> {
  return checkLocalLLMHealth('ollama', 'http://localhost:11434');
}

export async function checkLocalLLMHealth(
  provider: 'ollama' | 'lmstudio' | 'openai-compatible',
  baseUrl: string,
): Promise<boolean> {
  try {
    const url = provider === 'ollama'
      ? `${baseUrl}/api/version`
      : `${baseUrl}/v1/models`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
