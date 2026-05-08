import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { migrateLegacyHarnessSprintsJsonFile } from './pipeline-paths';
import { harnessPlanner, harnessCoder, harnessEvaluator, skillCreator } from './seed-agents';
import { applyMigrationV50 } from './db-migrations/v50-prompts';
import { applyMigrationV53 } from './db-migrations/v53-architecture-review';
import { applyMigrationV54 } from './db-migrations/v54-triage-meta-exclusions';
import { applyMigrationV55 } from './db-migrations/v55-architecture-mapper-layers';
import { applyMigrationV56 } from './db-migrations/v56-interviewer-strict-format';
import { applyMigrationV57 } from './db-migrations/v57-drop-token-usage';
import type {
  ChatMessage,
  ChatSession,
  AgentConfig,
  ExternalConfig,
  CodexConfig,
  CostSource,
  AuditEntry,
  LogFilters,
  MCPServerConfig,
  DailySummary,
  HarnessProject,
  HarnessSprint,
  HarnessRound,
  HarnessProjectMetrics,
  SprintMetrics,
  IngestJob,
} from '../../src/types';
import type { PipelineType, RoundDetail, SecuritySummary } from '../../src/types/pipeline';

const logger = createLogger('db');

let db: Database.Database;

function getLionClawPath(): string {
  return getLionClawHome();
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initDatabase(): void {
  const dbDir = path.join(getLionClawPath(), 'data');
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'lionclaw.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension for vector search
  sqliteVec.load(db);

  runMigrations();
  migrateLegacyHarnessSprintsJsonPaths();
  fixVecTableIfNeeded();
  logger.info({ path: dbPath }, 'Database ready');
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(MIGRATION_V1);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    logger.info('Applied migration v1');
  }

  if (currentVersion < 2) {
    db.exec(MIGRATION_V2);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
    logger.info('Applied migration v2');
  }

  if (currentVersion < 3) {
    db.exec(MIGRATION_V3);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
    logger.info('Applied migration v3');
  }

  if (currentVersion < 4) {
    db.exec(MIGRATION_V4);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
    logger.info('Applied migration v4');
  }

  if (currentVersion < 5) {
    db.exec(MIGRATION_V5);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
    logger.info('Applied migration v5');
  }

  if (currentVersion < 6) {
    db.exec(MIGRATION_V6);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    logger.info('Applied migration v6');
  }

  if (currentVersion < 7) {
    // Must disable FK checks via pragma() before table recreation
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V7);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
    logger.info('Applied migration v7');
  }

  if (currentVersion < 8) {
    db.exec(MIGRATION_V8);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(8);
    logger.info('Applied migration v8');
  }

  if (currentVersion < 9) {
    db.exec(MIGRATION_V9);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
    logger.info('Applied migration v9');
  }

  if (currentVersion < 10) {
    db.exec(MIGRATION_V10);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(10);
    logger.info('Applied migration v10');
  }

  if (currentVersion < 11) {
    db.exec(MIGRATION_V11);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(11);
    logger.info('Applied migration v11');
  }

  if (currentVersion < 12) {
    db.exec(MIGRATION_V12);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(12);
    logger.info('Applied migration v12 - FTS5 for BM25 search');
  }

  if (currentVersion < 13) {
    db.exec(MIGRATION_V13);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(13);
    logger.info('Applied migration v13 - vec table upgraded to 1536 dims (OpenAI)');
  }

  if (currentVersion < 14) {
    db.exec(MIGRATION_V14);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(14);
    logger.info('Applied migration v14 - local agent mode and tool rounds');
  }

  if (currentVersion < 15) {
    db.exec(MIGRATION_V15);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(15);
    logger.info('Applied migration v15 - knowledge base RAG tables');
  }

  if (currentVersion < 16) {
    db.exec(MIGRATION_V16);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(16);
    logger.info('Applied migration v16 - mcp_tool_registry for auto-discovery');
  }

  if (currentVersion < 17) {
    db.exec(MIGRATION_V17);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(17);
    logger.info('Applied migration v17 - personal tasks');
  }

  // V18: Migrate telegram channels config from allowedUserId/allowedUserIds to allowedUsers[]
  if (currentVersion < 18) {
    const rows = db.prepare(
      "SELECT id, config FROM channels WHERE type = 'telegram'",
    ).all() as Array<{ id: string; config: string }>;

    for (const row of rows) {
      try {
        const cfg = JSON.parse(row.config);
        if (cfg.allowedUsers && cfg.allowedUsers.length > 0) continue;

        let allowedUsers: Array<{ userId: number; name: string }> = [];
        if (cfg.allowedUserIds && cfg.allowedUserIds.length > 0) {
          allowedUsers = cfg.allowedUserIds.map((id: number, i: number) => ({
            userId: id,
            name: `Usuario ${i + 1}`,
          }));
        } else if (cfg.allowedUserId) {
          allowedUsers = [{ userId: cfg.allowedUserId, name: 'Usuario 1' }];
        }

        if (allowedUsers.length > 0) {
          const updated = { ...cfg, allowedUsers };
          delete updated.allowedUserId;
          delete updated.allowedUserIds;
          db.prepare('UPDATE channels SET config = ? WHERE id = ?').run(
            JSON.stringify(updated),
            row.id,
          );
        }
      } catch {
        // skip malformed config rows
      }
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(18);
    logger.info('Applied migration v18 - telegram allowedUsers multi-id support');
  }

  if (currentVersion < 19) {
    try {
      db.exec(MIGRATION_V19);
    } catch {
      // Column may already exist from a previous build before merge conflict
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(19);
    logger.info('Applied migration v19 - squad column for agents');
  }

  if (currentVersion < 20) {
    db.exec(MIGRATION_V20);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(20);
    logger.info('Applied migration v20 - task_executions for per-agent usage tracking');
  }

  if (currentVersion < 21) {
    db.exec(MIGRATION_V21);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(21);
    logger.info('Applied migration v21 - harness projects, sprints, rounds');
  }

  if (currentVersion < 22) {
    db.exec(MIGRATION_V22);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(22);
    logger.info('Applied migration v22 - planner metrics on harness_projects');
  }

  if (currentVersion < 23) {
    db.exec(MIGRATION_V23);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(23);
    logger.info('Applied migration v23 - workflow_runs table');
  }

  if (currentVersion < 24) {
    db.exec(MIGRATION_V24);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(24);
    logger.info('Applied migration v24 - workflow_runs add generating status');
  }

  if (currentVersion < 25) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V25);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(25);
    logger.info('Applied migration v25 - workflow_runs add current_question');
  }

  if (currentVersion < 26) {
    db.exec(MIGRATION_V26);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(26);
    logger.info('Applied migration v26 - enrich_sessions table');
  }

  if (currentVersion < 27) {
    db.exec(MIGRATION_V27);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(27);
    logger.info('Applied migration v27 - enrich_messages table');
  }

  if (currentVersion < 28) {
    db.exec(MIGRATION_V28);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(28);
    logger.info('Applied migration v28 - FTS5 unicode61 remove_diacritics');
  }

  if (currentVersion < 29) {
    db.exec(MIGRATION_V29);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(29);
    logger.info('Applied migration v29 - ingest_jobs table');
  }

  if (currentVersion < 30) {
    db.exec(MIGRATION_V30);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(30);
    logger.info('Applied migration v30 - ingest_jobs partial status + file_hash index');
  }

  if (currentVersion < 31) {
    db.exec(MIGRATION_V31);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(31);
    logger.info('Applied migration v31 - pipeline_phase_metrics and pipeline_messages tables');
  }

  if (currentVersion < 32) {
    db.exec(MIGRATION_V32_MIGRATE_HARNESS_TO_PIPELINE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(32);
    logger.info('Applied migration v32 - migrated legacy harness metrics to pipeline_phase_metrics');
  }

  if (currentVersion < 33) {
    db.exec(MIGRATION_V33_SPRINT_INDEX_COLUMN);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(33);
    logger.info('Applied migration v33 - added sprint_index column, per-sprint metrics rows');
  }

  if (currentVersion < 34) {
    db.exec(MIGRATION_V34_FIX_AGENT_IDS);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(34);
    logger.info('Applied migration v34 - fix pipeline_phase_metrics agent_id from harness_sprints');
  }

  if (currentVersion < 35) {
    // Disable FK enforcement during table recreation to avoid issues with child tables
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V35_HARNESS_STATUS_IDLE);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(35);
    logger.info('Applied migration v35 - add idle status to harness_projects CHECK constraint');
  }

  if (currentVersion < 36) {
    db.exec(MIGRATION_V36_PIPELINE_STATE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(36);
    logger.info('Applied migration v36 - pipeline state persistence columns');
  }

  if (currentVersion < 37) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V37_DROP_TECH_SUBSTEP);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(37);
    logger.info('Applied migration v37 - drop pipeline_tech_substep, cleanup old phase data');
  }

  if (currentVersion < 38) {
    db.exec(MIGRATION_V38_PIPELINE_MSG_SPRINT_COLS);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(38);
    logger.info('Applied migration v38 - add sprint_index/round_index/agent_id to pipeline_messages and round_index to pipeline_phase_metrics');
  }

  if (currentVersion < 39) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V39_HARNESS_SPRINT_VERDICT);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(39);
    logger.info('Applied migration v39 - add verdict/updated_at to harness_sprints and rejected status');
  }

  if (currentVersion < 40) {
    db.exec(MIGRATION_V40_RECONCILE_LEGACY_SESSION_TYPES);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(40);
    logger.info('Applied migration v40 - reconcile legacy scheduler/telegram sessions with type=chat');
  }

  if (currentVersion < 41) {
    db.exec(MIGRATION_V41_SECURITY_PIPELINE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(41);
    logger.info('Applied migration v41 - pipeline_type column and security_agent_status table');
  }

  if (currentVersion < 42) {
    db.exec(MIGRATION_V42_SECURITY_SUMMARY);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(42);
    logger.info('Applied migration v42 - security_summary_json column on harness_projects');
  }

  if (currentVersion < 43) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V43);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(43);
    logger.info('Applied migration v43 - external runtime + external_config column');
  }

  if (currentVersion < 44) {
    db.exec(MIGRATION_V44);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(44);
    logger.info('Applied migration v44 - cost source + runtime/provider/model snapshot');
  }

  if (currentVersion < 45) {
    db.exec(MIGRATION_V45);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(45);
    logger.info('Applied migration v45 - pipeline_docs_id column on harness_projects');
  }

  if (currentVersion < 46) {
    db.exec(MIGRATION_V46);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(46);
    logger.info('Applied migration v46 - metadata column on harness_rounds');
  }

  if (currentVersion < 47) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V47);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(47);
    logger.info('Applied migration v47 - codex runtime + codex_config column on agents');
  }

  // P1.6: guard idempotente por schema real. Se schema_version>=48 vier de uma
  // branch onde V48 significava outra coisa (drift), o CHECK pode estar sem
  // 'aborted'/'interrupted'. O helper aplica a migration baseado no SCHEMA REAL,
  // nao em schema_version. Se a coluna ja aceita os estados, no-op.
  // FK off/on: harness_sprints/harness_rounds reference harness_projects(id);
  // recreating the parent table invalidaria FK pointers mid-DDL — o helper trata.
  ensureHarnessProjectStatusCheckExpanded(db);
  if (currentVersion < 48) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(48);
    logger.info('Applied migration v48 - expand harness_projects.status CHECK to include aborted/interrupted');
  }

  if (currentVersion < 49) {
    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);
    applyMigrationV49Tools(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(49);
    logger.info('Applied migration v49 - fix agent squads + secrets-scanner tools');
  }

  if (currentVersion < 50) {
    applyMigrationV50(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(50);
    logger.info('Applied migration v50 - update spec-builder/validator/security-skeptic prompts');
  }

  if (currentVersion < 51) {
    db.exec(MIGRATION_V51);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(51);
    logger.info('Applied migration v51 - codex_windows_prep_consent + codex_patch_failures column');
  }

  if (currentVersion < 52) {
    applyMigrationV52TechWriteRemoval(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(52);
    logger.info('Applied migration v52 - remove Write tool from feat-tech-* and tech-* agents');
  }

  if (currentVersion < 53) {
    applyMigrationV53(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(53);
    logger.info('Applied migration v53 - architecture-review pipeline seed agents');
  }

  if (currentVersion < 54) {
    applyMigrationV54(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(54);
    logger.info('Applied migration v54 - architecture-target-triage meta exclusions (CLAUDE.md, docs/)');
  }

  if (currentVersion < 55) {
    applyMigrationV55(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(55);
    logger.info('Applied migration v55 - architecture-mapper layer/kind schema fields');
  }

  if (currentVersion < 56) {
    applyMigrationV56(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(56);
    logger.info('Applied migration v56 - architecture-decision-interviewer strict format labels');
  }

  if (currentVersion < 57) {
    applyMigrationV57(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(57);
    logger.info('Applied migration v57 - drop token_usage table (UsagePage replaced by CodeBurn embed)');
  }
}

function fixVecTableIfNeeded(): void {
  try {
    const testBuf = Buffer.from(new Float32Array(1536).buffer);
    db.prepare('INSERT INTO semantic_memories_vec (id, embedding) VALUES (?, ?)').run('__test__', testBuf);
    db.prepare('DELETE FROM semantic_memories_vec WHERE id = ?').run('__test__');
  } catch {
    logger.info('Recreating semantic_memories_vec with correct schema (1536 dims)');
    db.exec('DROP TABLE IF EXISTS semantic_memories_vec');
    db.exec(`CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[1536]
    )`);
  }
}

const MIGRATION_V21 = `
  CREATE TABLE IF NOT EXISTS harness_projects (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'planning'
      CHECK (status IN ('planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS harness_sprints (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id TEXT NOT NULL REFERENCES harness_projects(id),
    sprint_index INTEGER NOT NULL,
    sprint_json_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'passed', 'failed', 'interrupted', 'skipped')),
    coder_agent_id TEXT,
    evaluator_agent_id TEXT,
    rounds_used INTEGER DEFAULT 0,
    max_rounds INTEGER DEFAULT 3,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_harness_sprints_project ON harness_sprints(project_id);
  CREATE INDEX IF NOT EXISTS idx_harness_sprints_status ON harness_sprints(status);

  CREATE TABLE IF NOT EXISTS harness_rounds (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sprint_id TEXT NOT NULL REFERENCES harness_sprints(id),
    round_number INTEGER NOT NULL,
    coder_session_id TEXT,
    coder_input_tokens INTEGER DEFAULT 0,
    coder_output_tokens INTEGER DEFAULT 0,
    coder_cache_tokens INTEGER DEFAULT 0,
    coder_cost_usd REAL DEFAULT 0,
    coder_duration_ms INTEGER DEFAULT 0,
    coder_tool_uses INTEGER DEFAULT 0,
    coder_api_requests INTEGER DEFAULT 0,
    evaluator_session_id TEXT,
    evaluator_input_tokens INTEGER DEFAULT 0,
    evaluator_output_tokens INTEGER DEFAULT 0,
    evaluator_cache_tokens INTEGER DEFAULT 0,
    evaluator_cost_usd REAL DEFAULT 0,
    evaluator_duration_ms INTEGER DEFAULT 0,
    evaluator_tool_uses INTEGER DEFAULT 0,
    evaluator_api_requests INTEGER DEFAULT 0,
    verdict TEXT CHECK (verdict IN ('pass', 'fail')),
    feedback_summary TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_harness_rounds_sprint ON harness_rounds(sprint_id);
`;

const MIGRATION_V22 = `
  ALTER TABLE harness_projects ADD COLUMN planner_input_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_output_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_cache_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_cost_usd REAL DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_duration_ms INTEGER DEFAULT 0;
`;

const MIGRATION_V23 = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V24 = `
  CREATE TABLE IF NOT EXISTS workflow_runs_new (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT OR IGNORE INTO workflow_runs_new SELECT * FROM workflow_runs;
  DROP TABLE workflow_runs;
  ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V25 = `
  CREATE TABLE IF NOT EXISTS workflow_runs_new (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    current_question TEXT DEFAULT 'Q1',
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT OR IGNORE INTO workflow_runs_new
    SELECT id, workflow_id, session_id, current_stage, 'Q1', notes_path, status, started_at, updated_at, completed_at
    FROM workflow_runs;
  DROP TABLE workflow_runs;
  ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V26 = `
  CREATE TABLE IF NOT EXISTS enrich_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    project_path TEXT,
    prd_path TEXT,
    user_message TEXT,
    validator_agent_id TEXT NOT NULL,
    enricher_agent_id TEXT NOT NULL DEFAULT 'spec-enricher',
    phase TEXT NOT NULL DEFAULT 'validator' CHECK (phase IN ('validator', 'enricher', 'done')),
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting', 'finalizing', 'done')),
    final_spec_path TEXT,
    validator_input_tokens INTEGER DEFAULT 0,
    validator_output_tokens INTEGER DEFAULT 0,
    validator_cache_read_tokens INTEGER DEFAULT 0,
    validator_cache_creation_tokens INTEGER DEFAULT 0,
    validator_cost_usd REAL DEFAULT 0,
    validator_duration_ms INTEGER DEFAULT 0,
    validator_tool_uses INTEGER DEFAULT 0,
    validator_api_requests INTEGER DEFAULT 0,
    validator_messages INTEGER DEFAULT 0,
    enricher_input_tokens INTEGER DEFAULT 0,
    enricher_output_tokens INTEGER DEFAULT 0,
    enricher_cache_read_tokens INTEGER DEFAULT 0,
    enricher_cache_creation_tokens INTEGER DEFAULT 0,
    enricher_cost_usd REAL DEFAULT 0,
    enricher_duration_ms INTEGER DEFAULT 0,
    enricher_tool_uses INTEGER DEFAULT 0,
    enricher_api_requests INTEGER DEFAULT 0,
    enricher_messages INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const MIGRATION_V27 = `
  CREATE TABLE IF NOT EXISTS enrich_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES enrich_sessions(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('validator', 'enricher')),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_enrich_messages_session ON enrich_messages(session_id, phase);
`;

const MIGRATION_V28 = `
  -- Rebuild FTS5 table with unicode61 tokenizer for accent-insensitive search
  DROP TABLE IF EXISTS semantic_memories_fts;
  CREATE VIRTUAL TABLE semantic_memories_fts USING fts5(
    content,
    topic,
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  INSERT INTO semantic_memories_fts(rowid, content, topic)
    SELECT id, content, COALESCE(topic, '') FROM semantic_memories;
`;

const MIGRATION_V29 = `
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    original_path TEXT,
    file_hash TEXT,
    status TEXT NOT NULL DEFAULT 'extracting'
      CHECK (status IN ('extracting', 'estimating', 'waiting_confirm', 'processing', 'completed', 'failed')),
    total_chunks INTEGER DEFAULT 0,
    processed_chunks INTEGER DEFAULT 0,
    last_processed_chunk INTEGER DEFAULT -1,
    notes_created INTEGER DEFAULT 0,
    notes_updated INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_note_paths TEXT DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_started ON ingest_jobs(started_at);
`;

const MIGRATION_V30 = `
  -- Allow 'partial' status for ingest_jobs (recreate CHECK via new column trick not needed in SQLite,
  -- but we can drop the constraint by recreating the table or just rely on application-level validation).
  -- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so we add an index on file_hash for dup detection.
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_file_hash ON ingest_jobs(file_hash);
`;

const MIGRATION_V31 = `
  -- Pipeline phase metrics: one row per phase per project execution
  CREATE TABLE IF NOT EXISTS pipeline_phase_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    phase_name TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'interrupted')),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    messages_count INTEGER DEFAULT 0,
    model TEXT,
    runtime TEXT,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, phase_number)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_project ON pipeline_phase_metrics(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_number ON pipeline_phase_metrics(project_id, phase_number);

  -- Pipeline messages: persisted chat messages per phase
  CREATE TABLE IF NOT EXISTS pipeline_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_project ON pipeline_messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_phase ON pipeline_messages(project_id, phase_number);

  -- Extra columns on harness_projects for pipeline orchestration
  ALTER TABLE harness_projects ADD COLUMN pipeline_start_phase INTEGER DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN pipeline_current_phase INTEGER DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN discovery_notes_path TEXT DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN prd_path TEXT DEFAULT NULL;
`;

// V32: Migrate legacy harness metrics into pipeline_phase_metrics so old projects
// show data in the unified Pipeline metrics view.
// Planner data lives on harness_projects columns; Coder+Evaluator data lives in harness_rounds.
// We aggregate per project and insert as phase 8 (Planner), 10 (Coder), 11 (Evaluator).
// Only projects that DON'T already have rows in pipeline_phase_metrics are migrated
// (i.e. projects created before the pipeline system).
const MIGRATION_V32_MIGRATE_HARNESS_TO_PIPELINE = `
  -- Phase 8 (Planner) from harness_projects planner columns
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    hp.id,
    8,
    'Planner',
    'harness-planner',
    CASE WHEN hp.planner_cost_usd > 0 THEN 'completed' ELSE 'skipped' END,
    COALESCE(hp.planner_input_tokens, 0),
    COALESCE(hp.planner_output_tokens, 0),
    COALESCE(hp.planner_cache_tokens, 0),
    0,
    COALESCE(hp.planner_cost_usd, 0),
    COALESCE(hp.planner_duration_ms, 0),
    0,
    0,
    NULL,
    hp.created_at,
    hp.updated_at
  FROM harness_projects hp
  WHERE hp.id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics)
    AND (hp.planner_cost_usd > 0 OR hp.planner_input_tokens > 0);

  -- Phase 10 (Coder) aggregated from harness_rounds
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    s.project_id,
    10,
    'Coder',
    'harness-coder',
    'completed',
    COALESCE(SUM(r.coder_input_tokens), 0),
    COALESCE(SUM(r.coder_output_tokens), 0),
    COALESCE(SUM(r.coder_cache_tokens), 0),
    0,
    COALESCE(SUM(r.coder_cost_usd), 0),
    COALESCE(SUM(r.coder_duration_ms), 0),
    COALESCE(SUM(r.coder_tool_uses), 0),
    COALESCE(SUM(r.coder_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  WHERE s.project_id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics WHERE phase_number = 10)
  GROUP BY s.project_id;

  -- Phase 11 (Evaluator) aggregated from harness_rounds
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    s.project_id,
    11,
    'Evaluator',
    'harness-evaluator',
    'completed',
    COALESCE(SUM(r.evaluator_input_tokens), 0),
    COALESCE(SUM(r.evaluator_output_tokens), 0),
    COALESCE(SUM(r.evaluator_cache_tokens), 0),
    0,
    COALESCE(SUM(r.evaluator_cost_usd), 0),
    COALESCE(SUM(r.evaluator_duration_ms), 0),
    COALESCE(SUM(r.evaluator_tool_uses), 0),
    COALESCE(SUM(r.evaluator_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  WHERE s.project_id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics WHERE phase_number = 11)
  GROUP BY s.project_id;
`;

// V33: Add sprint_index column to pipeline_phase_metrics so each sprint gets its own row.
// The old UNIQUE(project_id, phase_number) only allowed one row per phase per project,
// which meant per-sprint cost breakdowns were impossible.
// New UNIQUE is (project_id, phase_number, sprint_index).
// sprint_index = -1 for non-sprint phases (1-9); >= 0 for sprint phases (10, 11, 12).
// SQLite can't ALTER a UNIQUE constraint, so we recreate the table entirely.
// Also re-migrates harness_rounds data as per-sprint rows instead of aggregated totals.
const MIGRATION_V33_SPRINT_INDEX_COLUMN = `
  -- 1. Create new table with sprint_index column and updated UNIQUE constraint
  CREATE TABLE pipeline_phase_metrics_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    sprint_index INTEGER NOT NULL DEFAULT -1,
    phase_name TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'interrupted')),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    messages_count INTEGER DEFAULT 0,
    model TEXT,
    runtime TEXT,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, phase_number, sprint_index)
  );

  -- 2. Copy non-sprint rows (phases that are NOT 10/11 from the old aggregated V32 migration)
  INSERT INTO pipeline_phase_metrics_new
    (id, project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, messages_count,
     model, runtime, started_at, completed_at, metadata, created_at)
  SELECT
    id, project_id, phase_number, -1, phase_name, agent_id, status,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    cost_usd, duration_ms, tool_uses, api_requests, messages_count,
    model, runtime, started_at, completed_at, metadata, created_at
  FROM pipeline_phase_metrics
  WHERE phase_number NOT IN (10, 11);

  -- 3. Drop old table and rename new one
  DROP TABLE pipeline_phase_metrics;
  ALTER TABLE pipeline_phase_metrics_new RENAME TO pipeline_phase_metrics;

  -- 4. Recreate indexes
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_project ON pipeline_phase_metrics(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_number ON pipeline_phase_metrics(project_id, phase_number);

  -- 5. Insert Coder (phase 10) metrics PER SPRINT from harness_rounds
  --    Uses the ACTUAL coder_agent_id from harness_sprints (not generic 'harness-coder')
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at, metadata)
  SELECT
    s.project_id,
    10,
    s.sprint_index,
    'Coder',
    COALESCE(s.coder_agent_id, 'harness-coder'),
    'completed',
    COALESCE(SUM(r.coder_input_tokens), 0),
    COALESCE(SUM(r.coder_output_tokens), 0),
    COALESCE(SUM(r.coder_cache_tokens), 0),
    0,
    COALESCE(SUM(r.coder_cost_usd), 0),
    COALESCE(SUM(r.coder_duration_ms), 0),
    COALESCE(SUM(r.coder_tool_uses), 0),
    COALESCE(SUM(r.coder_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at),
    json_object('sprintIndex', s.sprint_index, 'sprintName', s.name)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  GROUP BY s.project_id, s.sprint_index;

  -- 6. Insert Evaluator (phase 11) metrics PER SPRINT from harness_rounds
  --    Uses the ACTUAL evaluator_agent_id from harness_sprints
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at, metadata)
  SELECT
    s.project_id,
    11,
    s.sprint_index,
    'Evaluator',
    COALESCE(s.evaluator_agent_id, 'harness-evaluator'),
    'completed',
    COALESCE(SUM(r.evaluator_input_tokens), 0),
    COALESCE(SUM(r.evaluator_output_tokens), 0),
    COALESCE(SUM(r.evaluator_cache_tokens), 0),
    0,
    COALESCE(SUM(r.evaluator_cost_usd), 0),
    COALESCE(SUM(r.evaluator_duration_ms), 0),
    COALESCE(SUM(r.evaluator_tool_uses), 0),
    COALESCE(SUM(r.evaluator_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at),
    json_object('sprintIndex', s.sprint_index, 'sprintName', s.name)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  GROUP BY s.project_id, s.sprint_index;
`;

// V34: Fix agent_id on pipeline_phase_metrics for sprint phases (10, 11).
// V33 may have already run with the correct agent IDs, but if it ran before the
// COALESCE(s.coder_agent_id) fix was added, rows still have generic 'harness-coder'.
// This migration updates all sprint-phase rows to use the real agent_id from harness_sprints.
const MIGRATION_V34_FIX_AGENT_IDS = `
  -- Fix Coder (phase 10) agent_id: use harness_sprints.coder_agent_id when available
  UPDATE pipeline_phase_metrics
  SET agent_id = (
    SELECT s.coder_agent_id
    FROM harness_sprints s
    WHERE s.project_id = pipeline_phase_metrics.project_id
      AND s.sprint_index = pipeline_phase_metrics.sprint_index
    LIMIT 1
  )
  WHERE phase_number = 10
    AND sprint_index >= 0
    AND EXISTS (
      SELECT 1 FROM harness_sprints s
      WHERE s.project_id = pipeline_phase_metrics.project_id
        AND s.sprint_index = pipeline_phase_metrics.sprint_index
        AND s.coder_agent_id IS NOT NULL
        AND s.coder_agent_id != ''
    );

  -- Fix Evaluator (phase 11) agent_id: use harness_sprints.evaluator_agent_id when available
  UPDATE pipeline_phase_metrics
  SET agent_id = (
    SELECT s.evaluator_agent_id
    FROM harness_sprints s
    WHERE s.project_id = pipeline_phase_metrics.project_id
      AND s.sprint_index = pipeline_phase_metrics.sprint_index
    LIMIT 1
  )
  WHERE phase_number = 11
    AND sprint_index >= 0
    AND EXISTS (
      SELECT 1 FROM harness_sprints s
      WHERE s.project_id = pipeline_phase_metrics.project_id
        AND s.sprint_index = pipeline_phase_metrics.sprint_index
        AND s.evaluator_agent_id IS NOT NULL
        AND s.evaluator_agent_id != ''
    );
`;

// V35: Add 'idle' to harness_projects status CHECK constraint.
// The pipeline system uses 'idle' as the initial status, but the old harness
// CHECK constraint only allows: planning, reviewing, ready, running, paused, done, failed.
// SQLite cannot ALTER CHECK constraints, so we recreate the table.
const MIGRATION_V35_HARNESS_STATUS_IDLE = `
  CREATE TABLE harness_projects_new (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL
  );

  INSERT INTO harness_projects_new
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_new RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
`;

const MIGRATION_V36_PIPELINE_STATE = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_tech_substep TEXT DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN pipeline_sprint_index INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN pipeline_discovery_block INTEGER DEFAULT 1;
`;

// V37: Drop pipeline_tech_substep column from harness_projects (column was abandoned) and
// clean up pipeline data for phase numbers >= 5 (old numbering being abandoned).
// Because SQLite ALTER TABLE DROP COLUMN requires 3.35+, we use the table-recreate pattern
// to be safe. Keep pipeline_sprint_index and pipeline_discovery_block from V36.
const MIGRATION_V37_DROP_TECH_SUBSTEP = `
  CREATE TABLE harness_projects_v37 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1
  );

  INSERT INTO harness_projects_v37
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path,
      pipeline_sprint_index, pipeline_discovery_block
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_v37 RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);

  -- Cleanup pipeline data from obsolete phase numbering (phase >= 5)
  UPDATE harness_projects SET pipeline_current_phase = NULL WHERE pipeline_current_phase >= 5;
  DELETE FROM pipeline_phase_metrics WHERE phase_number >= 5;
  DELETE FROM pipeline_messages WHERE phase_number >= 5;
`;

// V38: Add sprint_index, round_index, agent_id to pipeline_messages and
// add round_index to pipeline_phase_metrics, then create supporting indexes.
const MIGRATION_V38_PIPELINE_MSG_SPRINT_COLS = `
  ALTER TABLE pipeline_messages ADD COLUMN sprint_index INTEGER DEFAULT NULL;
  ALTER TABLE pipeline_messages ADD COLUMN round_index INTEGER DEFAULT NULL;
  ALTER TABLE pipeline_messages ADD COLUMN agent_id TEXT DEFAULT NULL;

  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_sprint
    ON pipeline_messages(project_id, phase_number, sprint_index, round_index);

  ALTER TABLE pipeline_phase_metrics ADD COLUMN round_index INTEGER DEFAULT NULL;

  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_metrics_sprint
    ON pipeline_phase_metrics(project_id, phase_number, sprint_index, round_index);
`;

// V39: Add verdict, updated_at columns and 'rejected' to the status CHECK on harness_sprints.
// SQLite cannot ALTER CHECK constraints, so we recreate the table.
// FK checks are disabled in the runMigrations block for this version.
const MIGRATION_V39_HARNESS_SPRINT_VERDICT = `
  CREATE TABLE harness_sprints_v39 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id TEXT NOT NULL REFERENCES harness_projects(id),
    sprint_index INTEGER NOT NULL,
    sprint_json_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'passed', 'rejected', 'failed', 'interrupted', 'skipped')),
    verdict TEXT DEFAULT NULL,
    coder_agent_id TEXT,
    evaluator_agent_id TEXT,
    rounds_used INTEGER DEFAULT 0,
    max_rounds INTEGER DEFAULT 3,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO harness_sprints_v39
    SELECT
      id, project_id, sprint_index, sprint_json_id, name, status,
      NULL AS verdict,
      coder_agent_id, evaluator_agent_id, rounds_used, max_rounds,
      started_at, completed_at,
      datetime('now') AS updated_at,
      created_at
    FROM harness_sprints;

  DROP TABLE harness_sprints;
  ALTER TABLE harness_sprints_v39 RENAME TO harness_sprints;

  CREATE INDEX IF NOT EXISTS idx_harness_sprints_project ON harness_sprints(project_id);
  CREATE INDEX IF NOT EXISTS idx_harness_sprints_status ON harness_sprints(status);
`;

const MIGRATION_V40_RECONCILE_LEGACY_SESSION_TYPES = `
  UPDATE sessions
  SET type = 'scheduled'
  WHERE task_id IS NOT NULL
    AND type = 'chat';

  UPDATE sessions
  SET type = 'telegram'
  WHERE title LIKE '[Telegram]%'
    AND type = 'chat'
    AND task_id IS NULL;
`;

const MIGRATION_V41_SECURITY_PIPELINE = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_type TEXT NOT NULL DEFAULT 'development';

  CREATE TABLE IF NOT EXISTS security_agent_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    findings_count INTEGER DEFAULT 0,
    output_file TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_security_agent_status_project ON security_agent_status(project_id);
`;

const MIGRATION_V42_SECURITY_SUMMARY = `
  ALTER TABLE harness_projects ADD COLUMN security_summary_json TEXT DEFAULT NULL;
`;

// V43: Add external runtime support to agents table.
// SQLite does not support ALTER TABLE ... ADD CONSTRAINT, so the table is recreated
// using the same pattern as V35 to update the runtime CHECK constraint.
// The external_config column (nullable JSON) is added for the new runtime path.
const MIGRATION_V43 = `
  CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    effort TEXT DEFAULT 'medium',
    thinking TEXT DEFAULT 'adaptive',
    thinking_budget INTEGER,
    max_turns INTEGER,
    skills TEXT DEFAULT '[]',
    kb_enabled INTEGER NOT NULL DEFAULT 1,
    runtime TEXT DEFAULT 'cloud'
      CHECK (runtime IN ('cloud', 'local', 'external')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;

// V44: Add cost source tracking and runtime/provider/model snapshots to harness_rounds.
// All 4 columns are nullable so existing rows remain valid (they will have NULL values).
const MIGRATION_V44 = `
  ALTER TABLE harness_rounds ADD COLUMN cost_source TEXT;
  ALTER TABLE harness_rounds ADD COLUMN runtime_used TEXT;
  ALTER TABLE harness_rounds ADD COLUMN provider_used TEXT;
  ALTER TABLE harness_rounds ADD COLUMN model_used TEXT;
`;

// V45: Add pipeline_docs_id to harness_projects for document organization per pipeline run.
const MIGRATION_V45 = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_docs_id TEXT DEFAULT NULL;
`;

// V46: Add metadata JSON column to harness_rounds for telemetry (e.g. evaluatorParseTier).
const MIGRATION_V46 = `
  ALTER TABLE harness_rounds ADD COLUMN metadata TEXT DEFAULT '{}';
`;

// V47: Add runtime 'codex' support to agents table.
// SQLite does not support ALTER TABLE ... ADD CONSTRAINT, so the table is recreated
// using the same pattern as V43 to update the runtime CHECK constraint.
// The codex_config column (nullable JSON) is added for the new runtime path.
const MIGRATION_V47 = `
  CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    effort TEXT DEFAULT 'medium',
    thinking TEXT DEFAULT 'adaptive',
    thinking_budget INTEGER,
    max_turns INTEGER,
    skills TEXT DEFAULT '[]',
    kb_enabled INTEGER NOT NULL DEFAULT 1,
    runtime TEXT DEFAULT 'cloud'
      CHECK (runtime IN ('cloud', 'local', 'external', 'codex')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    codex_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    codex_config
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    NULL AS codex_config
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;

// V48: Expand harness_projects.status CHECK constraint to include
// 'aborted' and 'interrupted'.
//
// Why: pre-V48, the only "stop" statuses persisted were 'paused' and 'failed'.
// recoverInterruptedPipelines (boot crash recovery) wrote 'paused' to the DB
// but emitted 'interrupted' over IPC — a gambiarra. Similarly, abortPipeline
// persisted 'failed' even though the abort was an explicit user action, not
// an actual failure. Post-V48, the persisted status equals the truth: aborted
// means user-aborted, interrupted means crash-recovered.
//
// SQLite cannot ALTER CHECK constraints, so the table is recreated. All 27
// existing columns (V37 base + V41 pipeline_type + V42 security_summary_json
// + V45 pipeline_docs_id) are preserved verbatim.
const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `
  CREATE TABLE harness_projects_v48 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN (
        'idle', 'planning', 'reviewing', 'ready',
        'running', 'paused', 'done', 'failed',
        'aborted', 'interrupted'
      )),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1,
    pipeline_type TEXT NOT NULL DEFAULT 'development',
    security_summary_json TEXT DEFAULT NULL,
    pipeline_docs_id TEXT DEFAULT NULL
  );

  INSERT INTO harness_projects_v48
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path,
      pipeline_sprint_index, pipeline_discovery_block,
      pipeline_type, security_summary_json, pipeline_docs_id
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_v48 RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
  CREATE INDEX IF NOT EXISTS idx_harness_projects_pipeline_type ON harness_projects(pipeline_type);
`;

/**
 * Le o SQL do CREATE TABLE atual de harness_projects via sqlite_master.
 * Retorna null se a tabela nao existir (DB ainda nao migrou).
 */
export function getHarnessProjectsCreateSql(database: Database.Database): string | null {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_projects'")
    .get() as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

/**
 * Verifica se o CHECK constraint de harness_projects.status aceita
 * 'aborted' E 'interrupted'. Retorna false se a tabela nao existir
 * ou se o CHECK nao mencionar ambos.
 */
export function harnessProjectStatusCheckSupportsTerminalStates(database: Database.Database): boolean {
  const sql = getHarnessProjectsCreateSql(database);
  if (!sql) return false;
  // Match dentro do CHECK do status. Procuramos por 'aborted' E 'interrupted'
  // entre apostrofes (literais SQL) — evita falso positivo em comentarios.
  return sql.includes("'aborted'") && sql.includes("'interrupted'");
}

/**
 * Garante que o CHECK de harness_projects.status aceita 'aborted'/'interrupted'.
 * Idempotente: se ja aceita, no-op. Senao aplica MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK
 * (FK off/on, table-recreate preservando colunas e indices).
 *
 * NAO mexe em schema_version — quem chama decide se bumpa V48.
 *
 * Cobre o caso de drift onde schema_version >= 48 mas o CHECK real nao tem os
 * estados (DB criado em outra branch onde V48 significava outra coisa).
 */
export function ensureHarnessProjectStatusCheckExpanded(database: Database.Database): void {
  if (harnessProjectStatusCheckSupportsTerminalStates(database)) return;
  // Se a tabela nao existir, MIGRATION_V21 ainda vai criar — nao tentar aqui.
  if (getHarnessProjectsCreateSql(database) === null) return;
  database.pragma('foreign_keys = OFF');
  try {
    database.exec(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK);
    logger.info(
      'ensureHarnessProjectStatusCheckExpanded: applied schema-real migration (CHECK was missing aborted/interrupted)',
    );
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

// V49: Reconciliacao insert-only de squads pra DBs antigas (fresh installs ja
// nascem certo via S6.4a). Sem isso, instalacoes anteriores ao S6.4a continuam
// com squad NULL ou 'workflow' nos agents seed.
//
// - tech-* foi seedado historicamente como 'workflow', deveria ser 'pipeline'
// - harness/pipeline/security agents nunca tiveram squad declarado nos seeds
//   antigos, entao nasceram NULL (reconcileSeedAgent so faz INSERT, nao UPDATE)
const MIGRATION_V49_FIX_AGENT_SQUADS = `
  UPDATE agents SET squad = 'pipeline'
    WHERE id IN ('tech-database', 'tech-backend', 'tech-frontend', 'tech-security')
      AND squad = 'workflow';

  UPDATE agents SET squad = 'harness'
    WHERE squad IS NULL AND id IN ('harness-coder', 'harness-planner', 'harness-evaluator');

  UPDATE agents SET squad = 'pipeline'
    WHERE squad IS NULL AND id IN ('repo-profiler', 'spec-builder', 'spec-validator');

  UPDATE agents SET squad = 'security'
    WHERE squad IS NULL AND id IN (
      'security-secrets-scanner', 'security-auth-auditor', 'security-isolation-inspector',
      'security-duplication-detector', 'security-logic-analyzer', 'security-standards-checker',
      'security-owasp-scanner', 'security-deduplicator', 'security-skeptic-security',
      'security-skeptic-quality', 'security-resolution-tracker'
    );
`;

// V49 (TS prepared statement): allowed_tools pra security-secrets-scanner.
// O seed atual exige Bash (pra rodar 'git log' e detectar .env commitados).
// DBs antigos podem ter persistido sem Bash; condicional pra preservar
// customizacoes do user.
function applyMigrationV49Tools(database: Database.Database): void {
  const OLD_TOOLS = '["Read","Grep","Glob"]';
  const NEW_TOOLS = '["Read","Grep","Glob","Bash"]';
  database
    .prepare(`UPDATE agents SET allowed_tools = ? WHERE id = 'security-secrets-scanner' AND allowed_tools = ?`)
    .run(NEW_TOOLS, OLD_TOOLS);
}

/**
 * V52: Remove a tool 'Write' dos 8 agentes tech-* (feature pipeline + dev pipeline).
 *
 * Motivacao: esses agentes editam APENAS uma secao do PRD ja existente. 'Write' nao
 * tem uso legitimo neles e e footgun pra modelos fracos (ex: GLM-4.7-flash sobrescreveu
 * PRD inteira em vez de fazer Edit cirurgico). Edit sozinho cobre todos os casos
 * (modificar secao existente E adicionar nova secao).
 *
 * Condicional: so atualiza se allowed_tools = OLD exato. Preserva customizacoes do user
 * (mesmo padrao da V49).
 *
 * Agentes afetados:
 * - Feature: feat-tech-database, feat-tech-backend, feat-tech-frontend, feat-tech-security
 * - Dev:     tech-database, tech-backend, tech-frontend, tech-security
 */
function applyMigrationV52TechWriteRemoval(database: Database.Database): void {
  const OLD_TOOLS = '["Read","Write","Edit","Glob","Grep"]';
  const NEW_TOOLS = '["Read","Edit","Glob","Grep"]';
  const AGENT_IDS = [
    'feat-tech-database',
    'feat-tech-backend',
    'feat-tech-frontend',
    'feat-tech-security',
    'tech-database',
    'tech-backend',
    'tech-frontend',
    'tech-security',
  ];
  const stmt = database.prepare(
    `UPDATE agents SET allowed_tools = ? WHERE id = ? AND allowed_tools = ?`,
  );
  for (const id of AGENT_IDS) {
    stmt.run(NEW_TOOLS, id, OLD_TOOLS);
  }
}

// V51: Codex Windows fix infrastructure.
// 1. codex_windows_prep_consent — opt-in versionado por repo Git para auto-prep
//    (CRLF/.gitattributes). Ver SPEC-codex-windows-fix.md Camada 2.
// 2. codex_patch_failures — telemetria de apply_patch verification failures por
//    round (Camada 4). Default 0; runtimes nao-Codex sempre persistem 0.
const MIGRATION_V51 = `
  CREATE TABLE IF NOT EXISTS codex_windows_prep_consent (
    repo_root TEXT PRIMARY KEY,
    prep_version INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('prepared', 'skip')),
    consented_at INTEGER NOT NULL,
    last_applied_at INTEGER
  );

  ALTER TABLE harness_rounds ADD COLUMN codex_patch_failures INTEGER DEFAULT 0;
`;

const MIGRATION_V20 = `
  CREATE TABLE IF NOT EXISTS task_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    task_id TEXT NOT NULL,
    tool_use_id TEXT,
    agent_id TEXT,
    agent_name TEXT,
    model TEXT,
    description TEXT,
    status TEXT DEFAULT 'running',
    summary TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_task_exec_session ON task_executions(session_id);
  CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_executions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_task_exec_created ON task_executions(created_at);
  CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_executions(status);
`;

const MIGRATION_V19 = `
  ALTER TABLE agents ADD COLUMN squad TEXT DEFAULT NULL;
`;

const MIGRATION_V17 = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
    priority        TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    due_date        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    done_at         TEXT,
    done_comment    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
`;

const MIGRATION_V16 = `
  CREATE TABLE IF NOT EXISTS mcp_tool_registry (
    mcp_id    TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (mcp_id, tool_name)
  );
`;

const MIGRATION_V15 = `
  CREATE TABLE knowledge_sources (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    file_type       TEXT NOT NULL CHECK(file_type IN ('pdf','docx','txt','md','csv')),
    file_size       INTEGER NOT NULL,
    file_path       TEXT NOT NULL,
    title           TEXT,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','processing','completed','failed')),
    chunks_count    INTEGER DEFAULT 0,
    chunk_strategy  TEXT NOT NULL DEFAULT 'recursive',
    chunk_size      INTEGER DEFAULT 1000,
    chunk_overlap   INTEGER DEFAULT 200,
    quality_score   REAL,
    best_strategy   TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at    TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_ksources_agent_id ON knowledge_sources(agent_id);
  CREATE INDEX idx_ksources_status   ON knowledge_sources(status);

  CREATE TABLE knowledge_chunks (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    strategy_used   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id)  REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_kchunks_source_id ON knowledge_chunks(source_id);
  CREATE INDEX idx_kchunks_agent_id  ON knowledge_chunks(agent_id);

  CREATE VIRTUAL TABLE knowledge_chunks_vec USING vec0(
    chunk_id   TEXT PRIMARY KEY,
    embedding  FLOAT[1536]
  );

  CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
    chunk_id  UNINDEXED,
    agent_id  UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  CREATE TABLE knowledge_benchmarks (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
                      CHECK(status IN ('running','completed','failed')),
    winner_strategy TEXT,
    winner_score    REAL,
    questions       TEXT DEFAULT '[]',
    results         TEXT DEFAULT '{}',
    total_questions INTEGER DEFAULT 10,
    execution_time  INTEGER,
    model_judge     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_kbenchmarks_source_id ON knowledge_benchmarks(source_id);

  CREATE TABLE knowledge_agent_config (
    agent_id          TEXT PRIMARY KEY,
    hyde_enabled      INTEGER NOT NULL DEFAULT 1,
    hyde_threshold    REAL    NOT NULL DEFAULT 0.50,
    min_score         REAL    NOT NULL DEFAULT 0.40,
    default_strategy  TEXT    NOT NULL DEFAULT 'recursive',
    rerank_enabled    INTEGER NOT NULL DEFAULT 1,
    rerank_top_k      INTEGER NOT NULL DEFAULT 3,
    search_top_k      INTEGER NOT NULL DEFAULT 20,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  ALTER TABLE agents ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 1;
`;

const MIGRATION_V14 = `
  ALTER TABLE agents ADD COLUMN local_mode TEXT DEFAULT 'simple';
  ALTER TABLE agents ADD COLUMN max_tool_rounds INTEGER DEFAULT 5;
`;

const MIGRATION_V13 = `
  -- Migrate vector table from 768 dims (Ollama nomic-embed-text) to 1536 dims (OpenAI text-embedding-3-small).
  -- Old embeddings are incompatible and must be regenerated.
  DROP TABLE IF EXISTS semantic_memories_vec;
  CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[1536]
  );

  -- Clear old embedding blobs (they're 768-dim, incompatible with new 1536-dim vec table)
  UPDATE semantic_memories SET embedding = NULL WHERE embedding IS NOT NULL;
`;

const MIGRATION_V12 = `
  CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_fts USING fts5(
    content,
    topic,
    content_rowid='id'
  );

  -- Backfill existing semantic_memories into FTS5
  INSERT OR IGNORE INTO semantic_memories_fts(rowid, content, topic)
    SELECT id, content, COALESCE(topic, '') FROM semantic_memories;
`;

const MIGRATION_V11 = `
  ALTER TABLE agents ADD COLUMN runtime TEXT DEFAULT 'cloud'
    CHECK (runtime IN ('cloud', 'local'));
  ALTER TABLE agents ADD COLUMN local_config TEXT DEFAULT NULL;
`;

const MIGRATION_V8 = `
  ALTER TABLE scheduled_tasks ADD COLUMN tags TEXT DEFAULT '[]';
  ALTER TABLE task_runs ADD COLUMN scheduled_for DATETIME;
  CREATE INDEX IF NOT EXISTS idx_task_runs_scheduled_for ON task_runs(scheduled_for);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
`;

const MIGRATION_V9 = `
  ALTER TABLE semantic_memories ADD COLUMN embedding BLOB;
  CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[768]
  );
`;

const MIGRATION_V10 = `
  DROP TABLE IF EXISTS semantic_memories_vec;
  CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[768]
  );
`;

const MIGRATION_V2 = `
  ALTER TABLE sessions ADD COLUMN input_tokens INTEGER DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN output_tokens INTEGER DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN cost_usd REAL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
  ALTER TABLE sessions ADD COLUMN max_tokens INTEGER DEFAULT 0;

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    subagent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_usage_session ON token_usage(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON token_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON token_usage(model);
`;

const MIGRATION_V3 = `
  ALTER TABLE mcp_servers ADD COLUMN description TEXT;
`;

const MIGRATION_V4 = `
  ALTER TABLE agents ADD COLUMN effort TEXT DEFAULT 'medium';
  ALTER TABLE agents ADD COLUMN thinking TEXT DEFAULT 'adaptive';
  ALTER TABLE agents ADD COLUMN thinking_budget INTEGER DEFAULT NULL;
  ALTER TABLE agents ADD COLUMN max_turns INTEGER DEFAULT NULL;
  ALTER TABLE agents ADD COLUMN skills TEXT DEFAULT '[]';
`;

const MIGRATION_V5 = `
  ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'chat'
    CHECK (type IN ('chat', 'scheduled', 'manual'));
  ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES scheduled_tasks(id);
  ALTER TABLE task_runs ADD COLUMN session_id TEXT REFERENCES sessions(id);
  ALTER TABLE task_runs ADD COLUMN review_status TEXT DEFAULT NULL
    CHECK (review_status IN ('pending_review', 'validated', 'rejected'));
  ALTER TABLE task_runs ADD COLUMN review_note TEXT;
  ALTER TABLE task_runs ADD COLUMN reviewed_at DATETIME;
`;

const MIGRATION_V7 = `
  -- Cleanup in case previous migration attempt left sessions_new behind
  DROP TABLE IF EXISTS sessions_new;

  -- Recreate sessions table to expand type CHECK constraint to include 'telegram'
  CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    subagent TEXT,
    title TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    max_tokens INTEGER DEFAULT 0,
    type TEXT DEFAULT 'chat'
      CHECK (type IN ('chat', 'scheduled', 'manual', 'telegram')),
    task_id TEXT REFERENCES scheduled_tasks(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO sessions_new (id, sdk_session_id, subagent, title, input_tokens, output_tokens, cost_usd, status, max_tokens, type, task_id, created_at, updated_at)
    SELECT id, sdk_session_id, subagent, title,
      COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), COALESCE(cost_usd, 0),
      COALESCE(status, 'active'), COALESCE(max_tokens, 0),
      COALESCE(type, 'chat'), task_id,
      created_at, updated_at
    FROM sessions;

  DROP TABLE sessions;

  ALTER TABLE sessions_new RENAME TO sessions;
`;

const MIGRATION_V6 = `
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('telegram', 'slack', 'discord', 'whatsapp')),
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER DEFAULT 0,
    status TEXT DEFAULT 'disconnected'
      CHECK (status IN ('connected', 'disconnected', 'error')),
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const MIGRATION_V1 = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    session_token TEXT,
    session_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    subagent TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    subagent TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    model TEXT DEFAULT 'sonnet',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS semantic_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source_session TEXT REFERENCES sessions(id),
    topic TEXT,
    subagent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_topic ON semantic_memories(topic);
  CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic_memories(created_at);

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    decisions TEXT,
    tasks_created TEXT,
    facts_extracted TEXT,
    message_count INTEGER DEFAULT 0,
    subagents_used TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS compaction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    messages_processed INTEGER DEFAULT 0,
    chunks_created INTEGER DEFAULT 0,
    facts_updated INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    subagent TEXT,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
    schedule_value TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
    last_run DATETIME,
    next_run DATETIME,
    run_count INTEGER DEFAULT 0,
    notify INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    status TEXT CHECK (status IN ('running', 'success', 'error')),
    result TEXT,
    error TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT DEFAULT '[]',
    env_keys TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    subagent TEXT,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    input TEXT,
    output TEXT,
    duration_ms INTEGER,
    approved INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
`;

// ---- Sessions ----

export function createSession(
  id: string,
  title?: string,
  subagent?: string,
  options?: { type?: 'chat' | 'scheduled' | 'manual' | 'telegram'; taskId?: string },
): ChatSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, title, subagent, type, task_id) VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    title ?? '',
    subagent ?? null,
    options?.type ?? 'chat',
    options?.taskId ?? null,
  );
  return getSession(id)!;
}

export function getSession(id: string): ChatSession | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapSession(row);
}

export function getAllSessions(): ChatSession[] {
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE type IN ('chat', 'manual', 'telegram')
      AND status != 'trashed'
      AND task_id IS NULL
      AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
    ORDER BY updated_at DESC, created_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(mapSession);
}

export function getScheduledSessions(): ChatSession[] {
  const rows = db.prepare("SELECT * FROM sessions WHERE type = 'scheduled' ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(mapSession);
}

export function deleteScheduledSessions(): void {
  db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE type = 'scheduled')").run();
  db.prepare("DELETE FROM sessions WHERE type = 'scheduled'").run();
}

export function updateSessionTitle(id: string, title: string): void {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, id);
}

export function deleteSessionById(id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  tx();
}

export function trashSession(id: string): { success: boolean; error?: string } {
  const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
    | { status: string }
    | undefined;

  if (!session) return { success: false, error: 'session_not_found' };
  if (session.status === 'active') return { success: false, error: 'cannot_trash_active_session' };
  if (session.status === 'trashed') return { success: false, error: 'already_trashed' };

  db.prepare(`UPDATE sessions SET status = 'trashed', updated_at = datetime('now') WHERE id = ?`).run(id);
  return { success: true };
}

function mapSession(row: Record<string, unknown>): ChatSession {
  return {
    id: row['id'] as string,
    sdkSessionId: row['sdk_session_id'] as string | undefined,
    subagent: row['subagent'] as string | undefined,
    title: row['title'] as string | undefined,
    inputTokens: (row['input_tokens'] as number) || 0,
    outputTokens: (row['output_tokens'] as number) || 0,
    costUsd: (row['cost_usd'] as number) || 0,
    status: (row['status'] as string as ChatSession['status']) || 'active',
    type: (row['type'] as ChatSession['type']) || 'chat',
    taskId: row['task_id'] as string | undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

// ---- Messages ----

export function insertMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  subagent?: string,
  metadata?: string,
): number {
  const result = db.prepare(`
    INSERT INTO messages (session_id, role, content, subagent, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, role, content, subagent ?? null, metadata ?? null);

  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

  return result.lastInsertRowid as number;
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row['id'] as number,
    sessionId: row['session_id'] as string,
    role: row['role'] as 'user' | 'assistant' | 'system',
    content: row['content'] as string,
    subagent: row['subagent'] as string | undefined,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : undefined,
    createdAt: row['created_at'] as string,
  };
}

// ---- Agents ----

export function getAllAgents(): AgentConfig[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY sort_order ASC').all() as Record<string, unknown>[];
  return rows.map(mapAgent);
}

export function getAgent(id: string): AgentConfig | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapAgent(row);
}

export function insertAgent(agent: Omit<AgentConfig, 'sortOrder'> & { sortOrder?: number }): AgentConfig {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM agents').get() as { m: number };
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, model, allowed_tools, mcp_servers, is_active, sort_order, effort, thinking, thinking_budget, max_turns, skills, runtime, local_config, external_config, codex_config, local_mode, max_tool_rounds, squad)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name,
    agent.description,
    agent.systemPrompt,
    agent.model,
    JSON.stringify(agent.allowedTools),
    JSON.stringify(agent.mcpServers),
    agent.isActive ? 1 : 0,
    agent.sortOrder ?? maxOrder.m + 1,
    agent.effort || 'medium',
    agent.thinking || 'adaptive',
    agent.thinkingBudget ?? null,
    agent.maxTurns ?? null,
    JSON.stringify(agent.skills || []),
    agent.runtime || 'cloud',
    agent.localConfig ? JSON.stringify(agent.localConfig) : null,
    agent.externalConfig ? JSON.stringify(agent.externalConfig) : null,
    agent.codexConfig ? JSON.stringify(agent.codexConfig) : null,
    agent.localMode || 'simple',
    agent.maxToolRounds ?? 5,
    agent.squad ?? null,
  );
  return getAgent(agent.id)!;
}

export function updateAgent(id: string, updates: Partial<AgentConfig>): AgentConfig {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.systemPrompt !== undefined) { fields.push('system_prompt = ?'); values.push(updates.systemPrompt); }
  if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model); }
  if (updates.allowedTools !== undefined) { fields.push('allowed_tools = ?'); values.push(JSON.stringify(updates.allowedTools)); }
  if (updates.mcpServers !== undefined) { fields.push('mcp_servers = ?'); values.push(JSON.stringify(updates.mcpServers)); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(updates.sortOrder); }
  if (updates.effort !== undefined) { fields.push('effort = ?'); values.push(updates.effort); }
  if (updates.thinking !== undefined) { fields.push('thinking = ?'); values.push(updates.thinking); }
  if (updates.thinkingBudget !== undefined) { fields.push('thinking_budget = ?'); values.push(updates.thinkingBudget); }
  if (updates.maxTurns !== undefined) { fields.push('max_turns = ?'); values.push(updates.maxTurns); }
  if (updates.skills !== undefined) { fields.push('skills = ?'); values.push(JSON.stringify(updates.skills)); }
  if (updates.runtime !== undefined) { fields.push('runtime = ?'); values.push(updates.runtime); }
  if (updates.localConfig !== undefined) { fields.push('local_config = ?'); values.push(JSON.stringify(updates.localConfig)); }
  if (updates.externalConfig !== undefined) { fields.push('external_config = ?'); values.push(JSON.stringify(updates.externalConfig)); }
  if (updates.codexConfig !== undefined) { fields.push('codex_config = ?'); values.push(updates.codexConfig ? JSON.stringify(updates.codexConfig) : null); }
  if (updates.localMode !== undefined) { fields.push('local_mode = ?'); values.push(updates.localMode); }
  if (updates.maxToolRounds !== undefined) { fields.push('max_tool_rounds = ?'); values.push(updates.maxToolRounds); }
  if (updates.squad !== undefined) { fields.push('squad = ?'); values.push(updates.squad); }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getAgent(id)!;
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgent(row: Record<string, unknown>): AgentConfig {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string,
    systemPrompt: row['system_prompt'] as string,
    model: row['model'] as string,
    allowedTools: JSON.parse((row['allowed_tools'] as string) || '[]'),
    mcpServers: JSON.parse((row['mcp_servers'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
    sortOrder: row['sort_order'] as number,
    effort: (row['effort'] as AgentConfig['effort']) || 'medium',
    thinking: (row['thinking'] as AgentConfig['thinking']) || 'adaptive',
    thinkingBudget: (row['thinking_budget'] as number) || undefined,
    maxTurns: (row['max_turns'] as number) || undefined,
    skills: JSON.parse((row['skills'] as string) || '[]'),
    runtime: (row['runtime'] as AgentConfig['runtime']) || 'cloud',
    localConfig: row['local_config'] ? JSON.parse(row['local_config'] as string) : undefined,
    externalConfig: row['external_config'] ? (JSON.parse(row['external_config'] as string) as ExternalConfig) : undefined,
    codexConfig: row['codex_config'] ? (JSON.parse(row['codex_config'] as string) as CodexConfig) : undefined,
    localMode: (row['local_mode'] as AgentConfig['localMode']) || 'simple',
    maxToolRounds: (row['max_tool_rounds'] as number) || 5,
    squad: (row['squad'] as string) || undefined,
  };
}

// ---- Audit Log ----

export function insertAuditEntry(entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  db.prepare(`
    INSERT INTO audit_log (session_id, subagent, event_type, tool_name, input, output, duration_ms, approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId ?? null,
    entry.subagent ?? null,
    entry.eventType,
    entry.toolName ?? null,
    entry.input ?? null,
    entry.output ?? null,
    entry.durationMs ?? null,
    entry.approved !== undefined ? (entry.approved ? 1 : 0) : null,
  );
}

export function queryAuditLog(filters: LogFilters): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
  if (filters.subagent) { conditions.push('subagent = ?'); params.push(filters.subagent); }
  if (filters.eventType) { conditions.push('event_type = ?'); params.push(filters.eventType); }
  if (filters.from) { conditions.push('created_at >= ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('created_at <= ?'); params.push(filters.to); }
  if (filters.search) {
    conditions.push('(tool_name LIKE ? OR input LIKE ? OR output LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const rows = db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(mapAudit);
}

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: row['id'] as number,
    sessionId: row['session_id'] as string | undefined,
    subagent: row['subagent'] as string | undefined,
    eventType: row['event_type'] as AuditEntry['eventType'],
    toolName: row['tool_name'] as string | undefined,
    input: row['input'] as string | undefined,
    output: row['output'] as string | undefined,
    durationMs: row['duration_ms'] as number | undefined,
    approved: row['approved'] !== null ? (row['approved'] as number) === 1 : undefined,
    createdAt: row['created_at'] as string,
  };
}

// ---- Settings ----

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

// ---- Auth ----

export function getAuthRow(): { password_hash: string; totp_secret: string | null; session_token: string | null; session_expires_at: string | null } | undefined {
  return db.prepare('SELECT * FROM auth WHERE id = 1').get() as {
    password_hash: string;
    totp_secret: string | null;
    session_token: string | null;
    session_expires_at: string | null;
  } | undefined;
}

export function createAuthRow(passwordHash: string): void {
  db.prepare('INSERT OR REPLACE INTO auth (id, password_hash) VALUES (1, ?)').run(passwordHash);
}

export function updateAuthSession(token: string, expiresAt: string): void {
  db.prepare('UPDATE auth SET session_token = ?, session_expires_at = ? WHERE id = 1').run(token, expiresAt);
}

export function clearAuthSession(): void {
  db.prepare('UPDATE auth SET session_token = NULL, session_expires_at = NULL WHERE id = 1').run();
}

export function setTotpSecret(secret: string): void {
  db.prepare('UPDATE auth SET totp_secret = ? WHERE id = 1').run(secret);
}

// ---- MCP Servers ----

export function getAllMCPServers(): MCPServerConfig[] {
  const rows = db.prepare('SELECT * FROM mcp_servers').all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row['id'] as string,
    name: row['name'] as string,
    description: (row['description'] as string) || undefined,
    command: row['command'] as string,
    args: JSON.parse((row['args'] as string) || '[]'),
    envKeys: JSON.parse((row['env_keys'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
  }));
}

// ---- Daily Summaries ----

export function getDailySummaries(from?: string, to?: string): DailySummary[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from) { conditions.push('date >= ?'); params.push(from); }
  if (to) { conditions.push('date <= ?'); params.push(to); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM daily_summaries ${where} ORDER BY date DESC`).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row['id'] as number,
    date: row['date'] as string,
    summary: row['summary'] as string,
    decisions: JSON.parse((row['decisions'] as string) || '[]'),
    tasksCreated: JSON.parse((row['tasks_created'] as string) || '[]'),
    factsExtracted: JSON.parse((row['facts_extracted'] as string) || '[]'),
    messageCount: row['message_count'] as number,
    subagentsUsed: JSON.parse((row['subagents_used'] as string) || '[]'),
    tokensUsed: row['tokens_used'] as number,
    costUsd: row['cost_usd'] as number,
  }));
}

// ---- Session Tokens (sessions table; CodeBurn embed handles dashboard) ----

export function updateSessionTokens(sessionId: string, inputTokens: number, outputTokens: number, costUsd: number): void {
  const stmt = db.prepare(`
    UPDATE sessions
    SET input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cost_usd = cost_usd + ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(inputTokens, outputTokens, costUsd, sessionId);
}

export function updateSessionStatus(sessionId: string, status: 'active' | 'archived' | 'compacted' | 'trashed'): void {
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, sessionId);
}

export function clearAllSessions(): void {
  const database = getDb();
  database.exec('DELETE FROM messages');
  database.exec('DELETE FROM audit_log');
  database.exec('DELETE FROM task_executions');
  database.exec('DELETE FROM sessions');
}

type ActiveSessionSummary = {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
};

function mapActiveSession(row: Record<string, unknown>): ActiveSessionSummary {
  return {
    id: row['id'] as string,
    title: (row['title'] as string) || '',
    type: (row['type'] as string) || 'chat',
    createdAt: row['created_at'] as string,
    inputTokens: (row['input_tokens'] as number) || 0,
    outputTokens: (row['output_tokens'] as number) || 0,
  };
}

export function getActiveSession(): ActiveSessionSummary | null {
  const row = db.prepare(`
    SELECT id, title, type, created_at, input_tokens, output_tokens
    FROM sessions
    WHERE status = 'active'
      AND type IN ('chat', 'manual', 'telegram')
      AND task_id IS NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapActiveSession(row);
}

export function getActiveChatSession(): ActiveSessionSummary | null {
  const row = db.prepare(`
    SELECT id, title, type, created_at, input_tokens, output_tokens
    FROM sessions
    WHERE status = 'active'
      AND type IN ('chat', 'manual')
      AND task_id IS NULL
      AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapActiveSession(row);
}

// ---- Tool Settings ----

const ALL_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
  'NotebookEdit', 'AskUserQuestion',
] as const;

const DEFAULT_DISABLED_TOOLS = new Set(['WebSearch', 'WebFetch', 'NotebookEdit']);

export function getEnabledTools(): string[] {
  return ALL_TOOLS.filter((tool) => {
    const val = getSetting(`tool:${tool}`);
    if (val === undefined) return !DEFAULT_DISABLED_TOOLS.has(tool);
    return val === 'true';
  });
}

export function getDisabledTools(): string[] {
  return ALL_TOOLS.filter((tool) => {
    const val = getSetting(`tool:${tool}`);
    if (val === undefined) return DEFAULT_DISABLED_TOOLS.has(tool);
    return val !== 'true';
  });
}

export function setToolEnabled(tool: string, enabled: boolean): void {
  setSetting(`tool:${tool}`, enabled ? 'true' : 'false');
}

export function getToolSettings(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const tool of ALL_TOOLS) {
    const val = getSetting(`tool:${tool}`);
    result[tool] = val === undefined ? !DEFAULT_DISABLED_TOOLS.has(tool) : val === 'true';
  }
  return result;
}

export function seedToolDefaults(): void {
  const defaults: Record<string, boolean> = {
    Read: true, Write: true, Edit: true, Glob: true, Grep: true,
    Bash: true, Agent: true, TodoWrite: true, AskUserQuestion: true,
    WebSearch: false, WebFetch: false, NotebookEdit: false,
  };

  for (const [tool, enabled] of Object.entries(defaults)) {
    const existing = getSetting(`tool:${tool}`);
    if (existing === undefined) {
      setSetting(`tool:${tool}`, enabled ? 'true' : 'false');
    }
  }
}

// ---- Seed default agents ----

export function seedDefaultAgents(): void {
  const existing = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
  if (existing.c > 0) return;

  const defaults = [
    {
      id: 'coder',
      name: 'Coder',
      description: 'Especialista em codigo, debugging, arquitetura de software',
      systemPrompt: 'Voce e o Coder, um engenheiro de software senior. Escreva codigo limpo, testavel e bem documentado. Use TypeScript por padrao. Siga SOLID principles.',
      model: 'sonnet',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch'],
      mcpServers: [],
      isActive: true,
      effort: 'high' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'researcher',
      name: 'Researcher',
      description: 'Pesquisa web, analise de documentos, sintese de informacao',
      systemPrompt: 'Voce e o Researcher, especialista em pesquisa e analise. Busque informacoes na web, analise documentos e sintetize insights claros e acionaveis.',
      model: 'sonnet',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      mcpServers: [],
      isActive: true,
      effort: 'medium' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'writer',
      name: 'Writer',
      description: 'Redacao, emails, documentos, conteudo',
      systemPrompt: 'Voce e o Writer, especialista em comunicacao escrita. Redija textos claros, persuasivos e adaptados ao publico-alvo. Tom informal e direto em portugues brasileiro.',
      model: 'sonnet',
      allowedTools: ['Read', 'Write', 'Edit', 'WebSearch'],
      mcpServers: [],
      isActive: true,
      effort: 'medium' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'ops',
      name: 'Ops',
      description: 'Automacao, scripts, gestao de arquivos, sistema',
      systemPrompt: 'Voce e o Ops, especialista em operacoes e automacao. Execute tarefas no sistema, gerencie arquivos, crie scripts de automacao. Sempre confirme antes de acoes destrutivas.',
      model: 'sonnet',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      mcpServers: [],
      isActive: true,
      effort: 'low' as const,
      thinking: 'disabled' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    skillCreator,
    // Harness agents (Planner, Coder, Evaluator)
    harnessPlanner,
    harnessCoder,
    harnessEvaluator,
  ];

  const insert = db.transaction(() => {
    for (const agent of defaults) {
      insertAgent(agent);
    }
  });
  insert();
  logger.info('Seeded default agents');
}

// ---- Semantic Memories with Embeddings ----

export function insertChunkWithEmbedding(content: string, topic: string, embedding: number[]): number {
  const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer);

  const result = db.prepare(
    `INSERT INTO semantic_memories (content, topic, embedding, created_at) VALUES (?, ?, ?, datetime('now'))`,
  ).run(content, topic, embeddingBuf);

  const rowId = Number(result.lastInsertRowid);
  const vecId = String(rowId);

  try {
    db.prepare('DELETE FROM semantic_memories_vec WHERE id = ?').run(vecId);
  } catch { /* ignore if not exists */ }

  db.prepare(
    'INSERT INTO semantic_memories_vec (id, embedding) VALUES (?, ?)',
  ).run(vecId, embeddingBuf);

  // Also insert into FTS5 for BM25 search
  try {
    db.prepare(
      'INSERT INTO semantic_memories_fts(rowid, content, topic) VALUES (?, ?, ?)',
    ).run(rowId, content, topic || '');
  } catch { /* FTS5 table may not exist yet */ }

  return rowId;
}

export function insertChunkPlainWithFTS(content: string, topic: string): number {
  const result = db.prepare(
    `INSERT INTO semantic_memories (content, topic, created_at) VALUES (?, ?, datetime('now'))`,
  ).run(content, topic);

  const rowId = Number(result.lastInsertRowid);

  try {
    db.prepare(
      'INSERT INTO semantic_memories_fts(rowid, content, topic) VALUES (?, ?, ?)',
    ).run(rowId, content, topic || '');
  } catch { /* FTS5 table may not exist yet */ }

  return rowId;
}

/**
 * BM25 search via FTS5.
 * Returns rows sorted by BM25 relevance (lower = more relevant in SQLite FTS5).
 */
export function searchBM25(query: string, limit: number = 20): Array<{ id: number; content: string; topic: string; created_at: string; bm25_score: number }> {
  // Escape FTS5 special chars and build query
  const sanitized = query.replace(/["*(){}[\]^~\\:]/g, ' ').trim();
  if (!sanitized) return [];

  // Convert to OR between terms (FTS5 uses implicit AND by default)
  const terms = sanitized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const orQuery = terms.join(' OR ');

  // Use FTS5 match with BM25 ranking
  const rows = db.prepare(`
    SELECT sm.id, sm.content, sm.topic, sm.created_at,
           bm25(semantic_memories_fts) AS bm25_score
    FROM semantic_memories_fts fts
    JOIN semantic_memories sm ON sm.id = fts.rowid
    WHERE semantic_memories_fts MATCH ?
    ORDER BY bm25_score ASC
    LIMIT ?
  `).all(orQuery, limit) as Array<{ id: number; content: string; topic: string; created_at: string; bm25_score: number }>;

  return rows;
}

/**
 * Vector cosine similarity search via sqlite-vec.
 */
export function searchVector(queryEmbedding: Buffer, limit: number = 20): Array<{ id: number; content: string; topic: string; created_at: string; distance: number }> {
  const rows = db.prepare(`
    SELECT sm.id, sm.content, sm.topic, sm.created_at,
           vec_distance_cosine(v.embedding, ?) AS distance
    FROM semantic_memories_vec v
    JOIN semantic_memories sm ON CAST(sm.id AS TEXT) = v.id
    ORDER BY distance ASC
    LIMIT ?
  `).all(queryEmbedding, limit) as Array<{ id: number; content: string; topic: string; created_at: string; distance: number }>;

  return rows;
}

/**
 * Reconcile a single seed agent with the database.
 *
 * Behaviour:
 *  - If the agent does not exist, INSERT it (full record from the seed).
 *  - If it exists, do nothing — user edits via the UI are authoritative and
 *    must survive every app boot.
 */
export function reconcileSeedAgent(agent: Omit<AgentConfig, 'sortOrder'>, category: string): void {
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id);
  if (existing) return;
  insertAgent(agent);
  logger.info({ agentId: agent.id, category }, 'Created seed agent');
}

// NOTE: as funcoes ensure*Agents() historicas foram removidas. O boot agora
// usa `ensureAllSeedAgents()` de `seed-agents/ensure.ts`, que reconcilia todos
// os seeds (insert-only) e materializa snapshots em .lionclaw/agents/.
// reconcileSeedAgent permanece exportado pra ser usado por aquele modulo.

// ---- Knowledge Base CRUD ----

export interface KnowledgeSourceRow {
  id: string;
  agentId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  title?: string;
  description?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  chunksCount: number;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  qualityScore?: number;
  bestStrategy?: string;
  errorMessage?: string;
  createdAt: string;
  processedAt?: string;
  updatedAt: string;
}

function mapKnowledgeSource(row: Record<string, unknown>): KnowledgeSourceRow {
  return {
    id: row['id'] as string,
    agentId: row['agent_id'] as string,
    fileName: row['file_name'] as string,
    fileType: row['file_type'] as string,
    fileSize: row['file_size'] as number,
    filePath: row['file_path'] as string,
    title: row['title'] as string | undefined,
    description: row['description'] as string | undefined,
    status: row['status'] as KnowledgeSourceRow['status'],
    chunksCount: (row['chunks_count'] as number) ?? 0,
    chunkStrategy: row['chunk_strategy'] as string,
    chunkSize: (row['chunk_size'] as number) ?? 1000,
    chunkOverlap: (row['chunk_overlap'] as number) ?? 200,
    qualityScore: row['quality_score'] as number | undefined,
    bestStrategy: row['best_strategy'] as string | undefined,
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
    processedAt: row['processed_at'] as string | undefined,
    updatedAt: row['updated_at'] as string,
  };
}

export function insertKnowledgeSource(source: Omit<KnowledgeSourceRow, 'createdAt' | 'updatedAt'>): KnowledgeSourceRow {
  db.prepare(`
    INSERT INTO knowledge_sources
      (id, agent_id, file_name, file_type, file_size, file_path, title, description,
       status, chunks_count, chunk_strategy, chunk_size, chunk_overlap,
       quality_score, best_strategy, error_message, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id,
    source.agentId,
    source.fileName,
    source.fileType,
    source.fileSize,
    source.filePath,
    source.title ?? null,
    source.description ?? null,
    source.status,
    source.chunksCount,
    source.chunkStrategy,
    source.chunkSize,
    source.chunkOverlap,
    source.qualityScore ?? null,
    source.bestStrategy ?? null,
    source.errorMessage ?? null,
    source.processedAt ?? null,
  );
  return getKnowledgeSource(source.id)!;
}

export function getKnowledgeSource(id: string): KnowledgeSourceRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeSource(row);
}

export function getKnowledgeSources(agentId: string): KnowledgeSourceRow[] {
  const rows = db.prepare(
    'SELECT * FROM knowledge_sources WHERE agent_id = ? ORDER BY created_at DESC',
  ).all(agentId) as Record<string, unknown>[];
  return rows.map(mapKnowledgeSource);
}

export function getCompletedDocsCount(agentId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM knowledge_sources
    WHERE agent_id = ? AND status = 'completed'
  `).get(agentId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function updateKnowledgeSource(id: string, updates: Partial<Omit<KnowledgeSourceRow, 'id' | 'agentId' | 'createdAt'>>): KnowledgeSourceRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.fileName !== undefined)    { fields.push('file_name = ?');      values.push(updates.fileName); }
  if (updates.fileType !== undefined)    { fields.push('file_type = ?');      values.push(updates.fileType); }
  if (updates.fileSize !== undefined)    { fields.push('file_size = ?');      values.push(updates.fileSize); }
  if (updates.filePath !== undefined)    { fields.push('file_path = ?');      values.push(updates.filePath); }
  if (updates.title !== undefined)       { fields.push('title = ?');          values.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description = ?');    values.push(updates.description); }
  if (updates.status !== undefined)      { fields.push('status = ?');         values.push(updates.status); }
  if (updates.chunksCount !== undefined) { fields.push('chunks_count = ?');   values.push(updates.chunksCount); }
  if (updates.chunkStrategy !== undefined) { fields.push('chunk_strategy = ?'); values.push(updates.chunkStrategy); }
  if (updates.chunkSize !== undefined)   { fields.push('chunk_size = ?');     values.push(updates.chunkSize); }
  if (updates.chunkOverlap !== undefined){ fields.push('chunk_overlap = ?');  values.push(updates.chunkOverlap); }
  if (updates.qualityScore !== undefined){ fields.push('quality_score = ?');  values.push(updates.qualityScore); }
  if (updates.bestStrategy !== undefined){ fields.push('best_strategy = ?');  values.push(updates.bestStrategy); }
  if (updates.errorMessage !== undefined){ fields.push('error_message = ?');  values.push(updates.errorMessage); }
  if (updates.processedAt !== undefined) { fields.push('processed_at = ?');   values.push(updates.processedAt); }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE knowledge_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getKnowledgeSource(id)!;
}

export function deleteKnowledgeSource(id: string): void {
  const source = getKnowledgeSource(id);

  const doDelete = db.transaction(() => {
    // Remove FTS and vec entries for all chunks of this source
    const chunkIds = db.prepare(
      'SELECT id FROM knowledge_chunks WHERE source_id = ?',
    ).all(id) as Array<{ id: string }>;

    for (const { id: cid } of chunkIds) {
      db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
      db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(cid);
    }

    db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM knowledge_benchmarks WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
  });
  doDelete();

  // Remove filesystem files after DB transaction succeeds
  if (source) {
    try {
      const dir = path.dirname(source.filePath);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ err, sourceId: id }, 'Failed to remove knowledge source files from filesystem');
    }
  }
}

// ---- Knowledge Chunks ----

export interface KnowledgeChunkRow {
  id: string;
  sourceId: string;
  agentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
  strategyUsed: string;
  createdAt: string;
}

function mapKnowledgeChunk(row: Record<string, unknown>): KnowledgeChunkRow {
  return {
    id: row['id'] as string,
    sourceId: row['source_id'] as string,
    agentId: row['agent_id'] as string,
    chunkIndex: row['chunk_index'] as number,
    content: row['content'] as string,
    tokenCount: row['token_count'] as number,
    metadata: JSON.parse((row['metadata'] as string) || '{}'),
    strategyUsed: row['strategy_used'] as string,
    createdAt: row['created_at'] as string,
  };
}

export function insertKnowledgeChunk(chunk: Omit<KnowledgeChunkRow, 'createdAt'>): void {
  db.prepare(`
    INSERT INTO knowledge_chunks
      (id, source_id, agent_id, chunk_index, content, token_count, metadata, strategy_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.id,
    chunk.sourceId,
    chunk.agentId,
    chunk.chunkIndex,
    chunk.content,
    chunk.tokenCount,
    JSON.stringify(chunk.metadata),
    chunk.strategyUsed,
  );
}

export function getKnowledgeChunks(sourceId: string): KnowledgeChunkRow[] {
  const rows = db.prepare(
    'SELECT * FROM knowledge_chunks WHERE source_id = ? ORDER BY chunk_index ASC',
  ).all(sourceId) as Record<string, unknown>[];
  return rows.map(mapKnowledgeChunk);
}

export function deleteKnowledgeChunksBySource(sourceId: string): void {
  const chunkIds = db.prepare(
    'SELECT id FROM knowledge_chunks WHERE source_id = ?',
  ).all(sourceId) as Array<{ id: string }>;

  for (const { id: cid } of chunkIds) {
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
    db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(cid);
  }
  db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
}

// ---- Knowledge Vec / FTS entries ----

export function insertKnowledgeChunkVec(chunkId: string, embedding: number[]): void {
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare('INSERT INTO knowledge_chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(chunkId, buf);
}

export function deleteKnowledgeChunkVec(chunkId: string): void {
  db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(chunkId);
}

export function insertKnowledgeChunkFts(chunkId: string, agentId: string, content: string): void {
  db.prepare(
    'INSERT INTO knowledge_chunks_fts (chunk_id, agent_id, content) VALUES (?, ?, ?)',
  ).run(chunkId, agentId, content);
}

export function deleteKnowledgeChunkFtsBySource(sourceId: string): void {
  const chunkIds = db.prepare(
    'SELECT id FROM knowledge_chunks WHERE source_id = ?',
  ).all(sourceId) as Array<{ id: string }>;
  for (const { id: cid } of chunkIds) {
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
  }
}

// ---- Knowledge Benchmarks ----

export interface KnowledgeBenchmarkRow {
  id: string;
  sourceId: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  winnerStrategy?: string;
  winnerScore?: number;
  questions: string[];
  results: Record<string, unknown>;
  totalQuestions: number;
  executionTime?: number;
  modelJudge?: string;
  createdAt: string;
  completedAt?: string;
}

function mapKnowledgeBenchmark(row: Record<string, unknown>): KnowledgeBenchmarkRow {
  return {
    id: row['id'] as string,
    sourceId: row['source_id'] as string,
    agentId: row['agent_id'] as string,
    status: row['status'] as KnowledgeBenchmarkRow['status'],
    winnerStrategy: row['winner_strategy'] as string | undefined,
    winnerScore: row['winner_score'] as number | undefined,
    questions: JSON.parse((row['questions'] as string) || '[]'),
    results: JSON.parse((row['results'] as string) || '{}'),
    totalQuestions: (row['total_questions'] as number) ?? 10,
    executionTime: row['execution_time'] as number | undefined,
    modelJudge: row['model_judge'] as string | undefined,
    createdAt: row['created_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
  };
}

export function insertKnowledgeBenchmark(benchmark: Omit<KnowledgeBenchmarkRow, 'createdAt'>): KnowledgeBenchmarkRow {
  db.prepare(`
    INSERT INTO knowledge_benchmarks
      (id, source_id, agent_id, status, winner_strategy, winner_score,
       questions, results, total_questions, execution_time, model_judge, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    benchmark.id,
    benchmark.sourceId,
    benchmark.agentId,
    benchmark.status,
    benchmark.winnerStrategy ?? null,
    benchmark.winnerScore ?? null,
    JSON.stringify(benchmark.questions),
    JSON.stringify(benchmark.results),
    benchmark.totalQuestions,
    benchmark.executionTime ?? null,
    benchmark.modelJudge ?? null,
    benchmark.completedAt ?? null,
  );
  return getKnowledgeBenchmark(benchmark.id)!;
}

export function getKnowledgeBenchmark(id: string): KnowledgeBenchmarkRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_benchmarks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeBenchmark(row);
}

export function updateKnowledgeBenchmark(id: string, updates: Partial<Omit<KnowledgeBenchmarkRow, 'id' | 'sourceId' | 'agentId' | 'createdAt'>>): KnowledgeBenchmarkRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined)         { fields.push('status = ?');          values.push(updates.status); }
  if (updates.winnerStrategy !== undefined) { fields.push('winner_strategy = ?'); values.push(updates.winnerStrategy); }
  if (updates.winnerScore !== undefined)    { fields.push('winner_score = ?');    values.push(updates.winnerScore); }
  if (updates.questions !== undefined)      { fields.push('questions = ?');       values.push(JSON.stringify(updates.questions)); }
  if (updates.results !== undefined)        { fields.push('results = ?');         values.push(JSON.stringify(updates.results)); }
  if (updates.totalQuestions !== undefined) { fields.push('total_questions = ?'); values.push(updates.totalQuestions); }
  if (updates.executionTime !== undefined)  { fields.push('execution_time = ?');  values.push(updates.executionTime); }
  if (updates.modelJudge !== undefined)     { fields.push('model_judge = ?');     values.push(updates.modelJudge); }
  if (updates.completedAt !== undefined)    { fields.push('completed_at = ?');    values.push(updates.completedAt); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE knowledge_benchmarks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getKnowledgeBenchmark(id)!;
}

// ---- Knowledge Agent Config ----

export interface KnowledgeAgentConfigRow {
  agentId: string;
  hydeEnabled: boolean;
  hydeThreshold: number;
  minScore: number;
  defaultStrategy: string;
  rerankEnabled: boolean;
  rerankTopK: number;
  searchTopK: number;
  createdAt: string;
  updatedAt: string;
}

function mapKnowledgeAgentConfig(row: Record<string, unknown>): KnowledgeAgentConfigRow {
  return {
    agentId: row['agent_id'] as string,
    hydeEnabled: (row['hyde_enabled'] as number) === 1,
    hydeThreshold: (row['hyde_threshold'] as number) ?? 0.5,
    minScore: (row['min_score'] as number) ?? 0.4,
    defaultStrategy: (row['default_strategy'] as string) ?? 'recursive',
    rerankEnabled: (row['rerank_enabled'] as number) === 1,
    rerankTopK: (row['rerank_top_k'] as number) ?? 3,
    searchTopK: (row['search_top_k'] as number) ?? 20,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function getKnowledgeAgentConfig(agentId: string): KnowledgeAgentConfigRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_agent_config WHERE agent_id = ?').get(agentId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeAgentConfig(row);
}

export function upsertKnowledgeAgentConfig(
  agentId: string,
  config: Partial<Omit<KnowledgeAgentConfigRow, 'agentId' | 'createdAt' | 'updatedAt'>>,
): KnowledgeAgentConfigRow {
  const existing = getKnowledgeAgentConfig(agentId);

  if (!existing) {
    db.prepare(`
      INSERT INTO knowledge_agent_config
        (agent_id, hyde_enabled, hyde_threshold, min_score, default_strategy,
         rerank_enabled, rerank_top_k, search_top_k)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      config.hydeEnabled !== undefined ? (config.hydeEnabled ? 1 : 0) : 1,
      config.hydeThreshold ?? 0.5,
      config.minScore ?? 0.4,
      config.defaultStrategy ?? 'recursive',
      config.rerankEnabled !== undefined ? (config.rerankEnabled ? 1 : 0) : 1,
      config.rerankTopK ?? 3,
      config.searchTopK ?? 20,
    );
  } else {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (config.hydeEnabled !== undefined)    { fields.push('hyde_enabled = ?');    values.push(config.hydeEnabled ? 1 : 0); }
    if (config.hydeThreshold !== undefined)  { fields.push('hyde_threshold = ?');  values.push(config.hydeThreshold); }
    if (config.minScore !== undefined)       { fields.push('min_score = ?');       values.push(config.minScore); }
    if (config.defaultStrategy !== undefined){ fields.push('default_strategy = ?');values.push(config.defaultStrategy); }
    if (config.rerankEnabled !== undefined)  { fields.push('rerank_enabled = ?');  values.push(config.rerankEnabled ? 1 : 0); }
    if (config.rerankTopK !== undefined)     { fields.push('rerank_top_k = ?');    values.push(config.rerankTopK); }
    if (config.searchTopK !== undefined)     { fields.push('search_top_k = ?');    values.push(config.searchTopK); }

    if (fields.length > 0) {
      fields.push(`updated_at = datetime('now')`);
      values.push(agentId);
      db.prepare(`UPDATE knowledge_agent_config SET ${fields.join(', ')} WHERE agent_id = ?`).run(...values);
    }
  }

  return getKnowledgeAgentConfig(agentId)!;
}

// ---- Personal Tasks ----

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  done_comment: string | null;
}

function mapTask(row: Record<string, unknown>): TaskRow {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || null,
    category: (row.category as string) || null,
    status: row.status as TaskRow['status'],
    priority: (row.priority as TaskRow['priority']) || 'normal',
    due_date: (row.due_date as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    done_at: (row.done_at as string) || null,
    done_comment: (row.done_comment as string) || null,
  };
}

export function getAllTasks(filters?: {
  status?: string;
  category?: string;
  priority?: string;
  period?: 'last30' | 'last90' | 'all';
}): TaskRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status && filters.status !== 'all') {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters?.category && filters.category !== 'all') {
    conditions.push('category = ?');
    params.push(filters.category);
  }

  if (filters?.priority && filters.priority !== 'all') {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }

  // Period filter: show pending/in_progress always, filter done by period
  const period = filters?.period || 'last30';
  if (period !== 'all') {
    const days = period === 'last90' ? 90 : 30;
    conditions.push(`(status != 'done' OR created_at >= datetime('now', '-${days} days'))`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM tasks ${where}
    ORDER BY
      CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN due_date IS NOT NULL THEN due_date END ASC,
      created_at DESC
  `).all(...params) as Record<string, unknown>[];

  return rows.map(mapTask);
}

export function getTask(id: string): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapTask(row) : undefined;
}

export function insertTask(task: {
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  due_date?: string;
}): TaskRow {
  const id = require('crypto').randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO tasks (id, title, description, category, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    task.title,
    task.description || null,
    task.category || null,
    task.priority || 'normal',
    task.due_date || null,
  );
  return getTask(id)!;
}

export function updateTask(id: string, updates: Partial<{
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  done_comment: string | null;
}>): TaskRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined)        { fields.push('title = ?');        values.push(updates.title); }
  if (updates.description !== undefined)  { fields.push('description = ?');  values.push(updates.description); }
  if (updates.category !== undefined)     { fields.push('category = ?');     values.push(updates.category); }
  if (updates.priority !== undefined)     { fields.push('priority = ?');     values.push(updates.priority); }
  if (updates.due_date !== undefined)     { fields.push('due_date = ?');     values.push(updates.due_date); }
  if (updates.done_comment !== undefined) { fields.push('done_comment = ?'); values.push(updates.done_comment); }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'done') {
      fields.push(`done_at = datetime('now')`);
    } else {
      fields.push('done_at = NULL');
    }
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  return getTask(id)!;
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function getTaskCategories(): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL AND category != '' ORDER BY category`
  ).all() as Array<{ category: string }>;
  return rows.map(r => r.category);
}

export function getPendingTasksDueCount(): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date <= date('now')`
  ).get() as { count: number };
  return row.count;
}

// ---- Task Executions (per-subagent usage tracking) ----

export function insertTaskExecution(data: {
  sessionId: string;
  taskId: string;
  toolUseId: string | null;
  agentId: string | null;
  agentName: string;
  model: string;
  description: string;
  status: string;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  apiRequests: number;
  toolUses: number;
  durationMs: number;
}): void {
  const stmt = db.prepare(`
    INSERT INTO task_executions (session_id, task_id, tool_use_id, agent_id, agent_name, model, description, status, summary, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, api_requests, tool_uses, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    data.sessionId,
    data.taskId,
    data.toolUseId,
    data.agentId,
    data.agentName,
    data.model,
    data.description,
    data.status,
    data.summary,
    data.inputTokens,
    data.outputTokens,
    data.cacheReadTokens,
    data.cacheCreationTokens,
    data.costUsd,
    data.apiRequests,
    data.toolUses,
    data.durationMs,
  );
}

// ---- Harness Projects ----

function mapHarnessProject(row: Record<string, unknown>): HarnessProject {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | undefined,
    projectPath: row['project_path'] as string,
    specPath: row['spec_path'] as string,
    sprintsJsonPath: row['sprints_json_path'] as string | undefined,
    status: row['status'] as HarnessProject['status'],
    config: JSON.parse((row['config'] as string) || '{}'),
    currentSprintIndex: (row['current_sprint_index'] as number) ?? -1,
    totalSprints: (row['total_sprints'] as number) ?? 0,
    totalFeatures: (row['total_features'] as number) ?? 0,
    plannerInputTokens: (row['planner_input_tokens'] as number) ?? 0,
    plannerOutputTokens: (row['planner_output_tokens'] as number) ?? 0,
    plannerCacheTokens: (row['planner_cache_tokens'] as number) ?? 0,
    plannerCostUsd: (row['planner_cost_usd'] as number) ?? 0,
    plannerDurationMs: (row['planner_duration_ms'] as number) ?? 0,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    discoveryNotesPath: row['discovery_notes_path'] as string | undefined,
    prdPath: row['prd_path'] as string | undefined,
    pipelineCurrentPhase: row['pipeline_current_phase'] as number | null | undefined,
    pipelineStartPhase: row['pipeline_start_phase'] as number | null | undefined,
    pipelineSprintIndex: (row['pipeline_sprint_index'] as number | null | undefined) ?? 0,
    pipelineDiscoveryBlock: (row['pipeline_discovery_block'] as number | null | undefined) ?? 1,
    pipelineType: ((row['pipeline_type'] as string | undefined) ?? 'development') as PipelineType,
    pipelineDocsId: (row['pipeline_docs_id'] as string | null) ?? null,
  };
}

function applyLegacyHarnessSprintsJsonMigration(project: HarnessProject): HarnessProject {
  try {
    const result = migrateLegacyHarnessSprintsJsonFile(project);
    if (result.shouldUpdateDb) {
      db.prepare(`
        UPDATE harness_projects
        SET sprints_json_path = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(result.canonicalPath, project.id);
      return { ...project, sprintsJsonPath: result.canonicalPath };
    }
  } catch (err) {
    logger.warn({ err, projectId: project.id }, 'Failed to migrate legacy harness sprints JSON');
  }
  return project;
}

export function migrateLegacyHarnessSprintsJsonPaths(): void {
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(`
      SELECT * FROM harness_projects
      WHERE sprints_json_path IS NOT NULL
        AND sprints_json_path != ''
    `).all() as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err }, 'Failed to query harness projects for legacy sprints migration');
    return;
  }

  for (const row of rows) {
    applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row));
  }
}

export function insertHarnessProject(data: {
  name: string;
  description?: string;
  projectPath: string;
  specPath: string;
  sprintsJsonPath?: string;
  config: HarnessProject['config'];
  pipelineType?: PipelineType;
  pipelineDocsId?: string | null;
}): HarnessProject {
  const result = db.prepare(`
    INSERT INTO harness_projects (name, description, project_path, spec_path, sprints_json_path, config, pipeline_type, pipeline_docs_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.description ?? null,
    data.projectPath,
    data.specPath,
    data.sprintsJsonPath ?? null,
    JSON.stringify(data.config),
    data.pipelineType ?? 'development',
    data.pipelineDocsId ?? null,
  );
  const id = db.prepare('SELECT id FROM harness_projects WHERE rowid = ?').get(result.lastInsertRowid) as { id: string };
  return getHarnessProject(id.id)!;
}

export function updateHarnessProject(id: string, updates: Partial<{
  name: string;
  description: string | null;
  projectPath: string;
  specPath: string;
  sprintsJsonPath: string | null;
  status: HarnessProject['status'];
  config: HarnessProject['config'];
  currentSprintIndex: number;
  totalSprints: number;
  totalFeatures: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
  plannerCacheTokens: number;
  plannerCostUsd: number;
  plannerDurationMs: number;
  pipelineDocsId: string | null;
}>): HarnessProject {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined)              { fields.push('name = ?');                values.push(updates.name); }
  if (updates.description !== undefined)       { fields.push('description = ?');         values.push(updates.description); }
  if (updates.projectPath !== undefined)       { fields.push('project_path = ?');        values.push(updates.projectPath); }
  if (updates.specPath !== undefined)          { fields.push('spec_path = ?');           values.push(updates.specPath); }
  if (updates.sprintsJsonPath !== undefined)   { fields.push('sprints_json_path = ?');   values.push(updates.sprintsJsonPath); }
  if (updates.status !== undefined)            { fields.push('status = ?');              values.push(updates.status); }
  if (updates.config !== undefined)            { fields.push('config = ?');              values.push(JSON.stringify(updates.config)); }
  if (updates.currentSprintIndex !== undefined){ fields.push('current_sprint_index = ?'); values.push(updates.currentSprintIndex); }
  if (updates.totalSprints !== undefined)      { fields.push('total_sprints = ?');       values.push(updates.totalSprints); }
  if (updates.totalFeatures !== undefined)     { fields.push('total_features = ?');      values.push(updates.totalFeatures); }
  if (updates.plannerInputTokens !== undefined)  { fields.push('planner_input_tokens = ?');  values.push(updates.plannerInputTokens); }
  if (updates.plannerOutputTokens !== undefined) { fields.push('planner_output_tokens = ?'); values.push(updates.plannerOutputTokens); }
  if (updates.plannerCacheTokens !== undefined)  { fields.push('planner_cache_tokens = ?');  values.push(updates.plannerCacheTokens); }
  if (updates.plannerCostUsd !== undefined)      { fields.push('planner_cost_usd = ?');      values.push(updates.plannerCostUsd); }
  if (updates.plannerDurationMs !== undefined)   { fields.push('planner_duration_ms = ?');   values.push(updates.plannerDurationMs); }
  if (updates.pipelineDocsId !== undefined)      { fields.push('pipeline_docs_id = ?');      values.push(updates.pipelineDocsId); }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getHarnessProject(id)!;
}

export function getHarnessProject(id: string): HarnessProject | undefined {
  const row = db.prepare('SELECT * FROM harness_projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row));
}

export function listHarnessProjects(): HarnessProject[] {
  const rows = db.prepare('SELECT * FROM harness_projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map((row) => applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row)));
}

/**
 * Delete a harness project and all related data (sprints, rounds).
 * Also removes the project directory from filesystem.
 */
export function deleteHarnessProject(id: string): void {
  // Database-only cleanup: deletes rounds → sprints → project rows.
  //
  // FILES ON DISK ARE NOT TOUCHED. This is intentional and matches the
  // security pipeline pattern (`.lionclaw/Security/Security-*.md` files
  // also persist after delete). For architecture-review,
  // `<projectPath>/.lionclaw/pipelines/architecture-review/<runId>/`
  // remains on disk so the user retains the human-readable artefacts
  // (Map / Candidates / Diagnosis / Decisions / SPEC) for review.
  //
  // If the user wants to also delete files, they remove the dir manually.
  // A future `pipeline:delete-artifacts(projectId)` IPC could automate this
  // with destructive confirmation — explicitly out of scope for the MVP
  // (per ARCHITECTURE-REVIEW-PIPELINE-SPEC.md §9.3).
  const deleteAll = db.transaction(() => {
    // 1. Delete rounds (child of sprints)
    db.prepare(`
      DELETE FROM harness_rounds
      WHERE sprint_id IN (SELECT id FROM harness_sprints WHERE project_id = ?)
    `).run(id);
    // 2. Delete sprints
    db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(id);
    // 3. Delete project
    db.prepare('DELETE FROM harness_projects WHERE id = ?').run(id);
  });
  deleteAll();
  logger.info({ projectId: id }, 'Deleted harness project and related data (files on disk preserved)');
}

// ---- Harness Sprints ----

function mapHarnessSprint(row: Record<string, unknown>): HarnessSprint {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    sprintIndex: row['sprint_index'] as number,
    sprintJsonId: row['sprint_json_id'] as string,
    name: row['name'] as string,
    status: row['status'] as HarnessSprint['status'],
    verdict: row['verdict'] as string | null | undefined,
    coderAgentId: row['coder_agent_id'] as string | undefined,
    evaluatorAgentId: row['evaluator_agent_id'] as string | undefined,
    roundsUsed: (row['rounds_used'] as number) ?? 0,
    maxRounds: (row['max_rounds'] as number) ?? 3,
    startedAt: row['started_at'] as string | undefined,
    completedAt: row['completed_at'] as string | undefined,
    updatedAt: row['updated_at'] as string | undefined,
  };
}

export function insertHarnessSprint(data: {
  projectId: string;
  sprintIndex: number;
  sprintJsonId: string;
  name: string;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  maxRounds?: number;
}): HarnessSprint {
  const result = db.prepare(`
    INSERT INTO harness_sprints (project_id, sprint_index, sprint_json_id, name, coder_agent_id, evaluator_agent_id, max_rounds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.projectId,
    data.sprintIndex,
    data.sprintJsonId,
    data.name,
    data.coderAgentId ?? null,
    data.evaluatorAgentId ?? null,
    data.maxRounds ?? 3,
  );
  const row = db.prepare('SELECT id FROM harness_sprints WHERE rowid = ?').get(result.lastInsertRowid) as { id: string };
  return getHarnessSprints(data.projectId).find(s => s.id === row.id)!;
}

export function updateHarnessSprint(id: string, updates: Partial<{
  status: HarnessSprint['status'];
  coderAgentId: string | null;
  evaluatorAgentId: string | null;
  roundsUsed: number;
  maxRounds: number;
  startedAt: string | null;
  completedAt: string | null;
}>): HarnessSprint {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined)           { fields.push('status = ?');             values.push(updates.status); }
  if (updates.coderAgentId !== undefined)     { fields.push('coder_agent_id = ?');     values.push(updates.coderAgentId); }
  if (updates.evaluatorAgentId !== undefined) { fields.push('evaluator_agent_id = ?'); values.push(updates.evaluatorAgentId); }
  if (updates.roundsUsed !== undefined)       { fields.push('rounds_used = ?');        values.push(updates.roundsUsed); }
  if (updates.maxRounds !== undefined)        { fields.push('max_rounds = ?');         values.push(updates.maxRounds); }
  if (updates.startedAt !== undefined)        { fields.push('started_at = ?');         values.push(updates.startedAt); }
  if (updates.completedAt !== undefined)      { fields.push('completed_at = ?');       values.push(updates.completedAt); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE harness_sprints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const row = db.prepare('SELECT * FROM harness_sprints WHERE id = ?').get(id) as Record<string, unknown>;
  return mapHarnessSprint(row);
}

export function getHarnessSprints(projectId: string): HarnessSprint[] {
  const rows = db.prepare(
    'SELECT * FROM harness_sprints WHERE project_id = ? ORDER BY sprint_index ASC',
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(mapHarnessSprint);
}

// ---- Harness Rounds ----

function mapHarnessRound(row: Record<string, unknown>): HarnessRound {
  return {
    id: row['id'] as string,
    sprintId: row['sprint_id'] as string,
    roundNumber: row['round_number'] as number,
    coderSessionId: row['coder_session_id'] as string | undefined,
    coderInputTokens: (row['coder_input_tokens'] as number) ?? 0,
    coderOutputTokens: (row['coder_output_tokens'] as number) ?? 0,
    coderCacheTokens: (row['coder_cache_tokens'] as number) ?? 0,
    coderCostUsd: (row['coder_cost_usd'] as number) ?? 0,
    coderDurationMs: (row['coder_duration_ms'] as number) ?? 0,
    coderToolUses: (row['coder_tool_uses'] as number) ?? 0,
    coderApiRequests: (row['coder_api_requests'] as number) ?? 0,
    evaluatorSessionId: row['evaluator_session_id'] as string | undefined,
    evaluatorInputTokens: (row['evaluator_input_tokens'] as number) ?? 0,
    evaluatorOutputTokens: (row['evaluator_output_tokens'] as number) ?? 0,
    evaluatorCacheTokens: (row['evaluator_cache_tokens'] as number) ?? 0,
    evaluatorCostUsd: (row['evaluator_cost_usd'] as number) ?? 0,
    evaluatorDurationMs: (row['evaluator_duration_ms'] as number) ?? 0,
    evaluatorToolUses: (row['evaluator_tool_uses'] as number) ?? 0,
    evaluatorApiRequests: (row['evaluator_api_requests'] as number) ?? 0,
    verdict: row['verdict'] as HarnessRound['verdict'],
    feedbackSummary: row['feedback_summary'] as string | undefined,
    startedAt: row['started_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
    costSource: (row['cost_source'] as CostSource | null) ?? null,
    runtimeUsed: (row['runtime_used'] as HarnessRound['runtimeUsed']) ?? null,
    providerUsed: (row['provider_used'] as string | null) ?? null,
    modelUsed: (row['model_used'] as string | null) ?? null,
    metadata: row['metadata'] ? (JSON.parse(row['metadata'] as string) as Record<string, unknown>) : {},
    codexPatchFailures: (row['codex_patch_failures'] as number) ?? 0,
  };
}

export function insertHarnessRound(data: {
  sprintId: string;
  roundNumber: number;
  coderSessionId?: string;
  costSource?: CostSource | null;
  runtimeUsed?: 'cloud' | 'local' | 'external' | null;
  providerUsed?: string | null;
  modelUsed?: string | null;
}): HarnessRound {
  const result = db.prepare(`
    INSERT INTO harness_rounds (sprint_id, round_number, coder_session_id, cost_source, runtime_used, provider_used, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.sprintId,
    data.roundNumber,
    data.coderSessionId ?? null,
    data.costSource ?? null,
    data.runtimeUsed ?? null,
    data.providerUsed ?? null,
    data.modelUsed ?? null,
  );
  const row = db.prepare('SELECT * FROM harness_rounds WHERE rowid = ?').get(result.lastInsertRowid) as Record<string, unknown>;
  return mapHarnessRound(row);
}

export function updateHarnessRound(id: string, updates: Partial<{
  coderSessionId: string | null;
  coderInputTokens: number;
  coderOutputTokens: number;
  coderCacheTokens: number;
  coderCostUsd: number;
  coderDurationMs: number;
  coderToolUses: number;
  coderApiRequests: number;
  evaluatorSessionId: string | null;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCacheTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  evaluatorToolUses: number;
  evaluatorApiRequests: number;
  verdict: HarnessRound['verdict'];
  feedbackSummary: string | null;
  completedAt: string | null;
  costSource: CostSource | null;
  runtimeUsed: 'cloud' | 'local' | 'external' | null;
  providerUsed: string | null;
  modelUsed: string | null;
  metadata: Record<string, unknown>;
  codexPatchFailures: number;
}>): HarnessRound {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.coderSessionId !== undefined)      { fields.push('coder_session_id = ?');      values.push(updates.coderSessionId); }
  if (updates.coderInputTokens !== undefined)    { fields.push('coder_input_tokens = ?');    values.push(updates.coderInputTokens); }
  if (updates.coderOutputTokens !== undefined)   { fields.push('coder_output_tokens = ?');   values.push(updates.coderOutputTokens); }
  if (updates.coderCacheTokens !== undefined)    { fields.push('coder_cache_tokens = ?');    values.push(updates.coderCacheTokens); }
  if (updates.coderCostUsd !== undefined)        { fields.push('coder_cost_usd = ?');        values.push(updates.coderCostUsd); }
  if (updates.coderDurationMs !== undefined)     { fields.push('coder_duration_ms = ?');     values.push(updates.coderDurationMs); }
  if (updates.coderToolUses !== undefined)       { fields.push('coder_tool_uses = ?');       values.push(updates.coderToolUses); }
  if (updates.coderApiRequests !== undefined)    { fields.push('coder_api_requests = ?');    values.push(updates.coderApiRequests); }
  if (updates.evaluatorSessionId !== undefined)  { fields.push('evaluator_session_id = ?');  values.push(updates.evaluatorSessionId); }
  if (updates.evaluatorInputTokens !== undefined){ fields.push('evaluator_input_tokens = ?');values.push(updates.evaluatorInputTokens); }
  if (updates.evaluatorOutputTokens !== undefined){ fields.push('evaluator_output_tokens = ?');values.push(updates.evaluatorOutputTokens); }
  if (updates.evaluatorCacheTokens !== undefined){ fields.push('evaluator_cache_tokens = ?');values.push(updates.evaluatorCacheTokens); }
  if (updates.evaluatorCostUsd !== undefined)    { fields.push('evaluator_cost_usd = ?');    values.push(updates.evaluatorCostUsd); }
  if (updates.evaluatorDurationMs !== undefined) { fields.push('evaluator_duration_ms = ?'); values.push(updates.evaluatorDurationMs); }
  if (updates.evaluatorToolUses !== undefined)   { fields.push('evaluator_tool_uses = ?');   values.push(updates.evaluatorToolUses); }
  if (updates.evaluatorApiRequests !== undefined){ fields.push('evaluator_api_requests = ?');values.push(updates.evaluatorApiRequests); }
  if (updates.verdict !== undefined)             { fields.push('verdict = ?');               values.push(updates.verdict); }
  if (updates.feedbackSummary !== undefined)     { fields.push('feedback_summary = ?');      values.push(updates.feedbackSummary); }
  if (updates.completedAt !== undefined)         { fields.push('completed_at = ?');          values.push(updates.completedAt); }
  if (updates.costSource !== undefined)          { fields.push('cost_source = ?');           values.push(updates.costSource); }
  if (updates.runtimeUsed !== undefined)         { fields.push('runtime_used = ?');          values.push(updates.runtimeUsed); }
  if (updates.providerUsed !== undefined)        { fields.push('provider_used = ?');         values.push(updates.providerUsed); }
  if (updates.modelUsed !== undefined)           { fields.push('model_used = ?');            values.push(updates.modelUsed); }
  if (updates.metadata !== undefined)            { fields.push('metadata = ?');              values.push(JSON.stringify(updates.metadata)); }
  if (updates.codexPatchFailures !== undefined)  { fields.push('codex_patch_failures = ?');  values.push(updates.codexPatchFailures); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE harness_rounds SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const row = db.prepare('SELECT * FROM harness_rounds WHERE id = ?').get(id) as Record<string, unknown>;
  return mapHarnessRound(row);
}

export function getHarnessRounds(sprintId: string): HarnessRound[] {
  const rows = db.prepare(
    'SELECT * FROM harness_rounds WHERE sprint_id = ? ORDER BY round_number ASC',
  ).all(sprintId) as Record<string, unknown>[];
  return rows.map(mapHarnessRound);
}

/**
 * Returns per-round details for a sprint, enriched with the model used by
 * Coder and Evaluator. coderModel/evaluatorModel come from harness_rounds.model_used
 * which is populated by spawnCoder/spawnEvaluator via updateHarnessRound.
 * Falls back to pipeline_phase_metrics.model when rounds have no model_used recorded.
 */
export function getRoundDetailsForSprint(projectId: string, sprintIndex: number): RoundDetail[] {
  const sprintRow = db.prepare(
    `SELECT id FROM harness_sprints WHERE project_id = ? AND sprint_index = ? LIMIT 1`,
  ).get(projectId, sprintIndex) as { id: string } | undefined;
  if (!sprintRow) return [];

  const rounds = db.prepare(
    `SELECT round_number, verdict, feedback_summary,
            model_used,
            coder_input_tokens, coder_output_tokens, coder_cost_usd, coder_duration_ms,
            evaluator_input_tokens, evaluator_output_tokens, evaluator_cost_usd, evaluator_duration_ms,
            started_at, completed_at
     FROM harness_rounds
     WHERE sprint_id = ?
     ORDER BY round_number ASC`,
  ).all(sprintRow.id) as Record<string, unknown>[];

  // Fallback: read coder/evaluator model from pipeline_phase_metrics if rounds don't have it.
  // Phases 10 or 13 = Coder; 11 or 14 = Evaluator.
  const coderPhaseRow = db.prepare(
    `SELECT model FROM pipeline_phase_metrics
     WHERE project_id = ? AND sprint_index = ? AND phase_number IN (10, 13)
     LIMIT 1`,
  ).get(projectId, sprintIndex) as { model: string | null } | undefined;

  const evalPhaseRow = db.prepare(
    `SELECT model FROM pipeline_phase_metrics
     WHERE project_id = ? AND sprint_index = ? AND phase_number IN (11, 14)
     LIMIT 1`,
  ).get(projectId, sprintIndex) as { model: string | null } | undefined;

  const fallbackCoderModel = coderPhaseRow?.model ?? null;
  const fallbackEvalModel = evalPhaseRow?.model ?? null;

  return rounds.map(r => ({
    roundNumber: (r['round_number'] as number),
    verdict: (r['verdict'] as string | null) ?? null,
    feedbackSummary: (r['feedback_summary'] as string | null) ?? null,
    coderModel: (r['model_used'] as string | null) ?? fallbackCoderModel,
    evaluatorModel: (r['model_used'] as string | null) ?? fallbackEvalModel,
    coderInputTokens: (r['coder_input_tokens'] as number) ?? 0,
    coderOutputTokens: (r['coder_output_tokens'] as number) ?? 0,
    coderCostUsd: (r['coder_cost_usd'] as number) ?? 0,
    coderDurationMs: (r['coder_duration_ms'] as number) ?? 0,
    evaluatorInputTokens: (r['evaluator_input_tokens'] as number) ?? 0,
    evaluatorOutputTokens: (r['evaluator_output_tokens'] as number) ?? 0,
    evaluatorCostUsd: (r['evaluator_cost_usd'] as number) ?? 0,
    evaluatorDurationMs: (r['evaluator_duration_ms'] as number) ?? 0,
    startedAt: (r['started_at'] as string | null) ?? null,
    completedAt: (r['completed_at'] as string | null) ?? null,
  }));
}

export interface HarnessSprintAggregateMetrics {
  coder: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  };
  evaluator: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  };
}

export function getHarnessSprintAggregateMetrics(sprintId: string): HarnessSprintAggregateMetrics {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(coder_input_tokens), 0)      AS coder_input,
      COALESCE(SUM(coder_output_tokens), 0)     AS coder_output,
      COALESCE(SUM(coder_cache_tokens), 0)      AS coder_cache,
      COALESCE(SUM(coder_cost_usd), 0)          AS coder_cost,
      COALESCE(SUM(coder_duration_ms), 0)       AS coder_duration,
      COALESCE(SUM(coder_tool_uses), 0)         AS coder_tools,
      COALESCE(SUM(coder_api_requests), 0)      AS coder_requests,
      COALESCE(SUM(evaluator_input_tokens), 0)  AS eval_input,
      COALESCE(SUM(evaluator_output_tokens), 0) AS eval_output,
      COALESCE(SUM(evaluator_cache_tokens), 0)  AS eval_cache,
      COALESCE(SUM(evaluator_cost_usd), 0)      AS eval_cost,
      COALESCE(SUM(evaluator_duration_ms), 0)   AS eval_duration,
      COALESCE(SUM(evaluator_tool_uses), 0)     AS eval_tools,
      COALESCE(SUM(evaluator_api_requests), 0)  AS eval_requests
    FROM harness_rounds WHERE sprint_id = ?
  `).get(sprintId) as Record<string, number>;
  return {
    coder: {
      inputTokens: row['coder_input'],
      outputTokens: row['coder_output'],
      cacheReadTokens: row['coder_cache'],
      costUsd: row['coder_cost'],
      durationMs: row['coder_duration'],
      toolUses: row['coder_tools'],
      apiRequests: row['coder_requests'],
    },
    evaluator: {
      inputTokens: row['eval_input'],
      outputTokens: row['eval_output'],
      cacheReadTokens: row['eval_cache'],
      costUsd: row['eval_cost'],
      durationMs: row['eval_duration'],
      toolUses: row['eval_tools'],
      apiRequests: row['eval_requests'],
    },
  };
}

// ---- Harness Metrics ----

export function getHarnessProjectMetrics(projectId: string): HarnessProjectMetrics {
  const sprints = getHarnessSprints(projectId);

  const sprintMetrics: SprintMetrics[] = sprints.map((sprint) => {
    const rounds = getHarnessRounds(sprint.id);
    const coderCost = rounds.reduce((sum, r) => sum + r.coderCostUsd, 0);
    const evaluatorCost = rounds.reduce((sum, r) => sum + r.evaluatorCostUsd, 0);
    const coderInputTokens = rounds.reduce((sum, r) => sum + r.coderInputTokens, 0);
    const coderOutputTokens = rounds.reduce((sum, r) => sum + r.coderOutputTokens, 0);
    const evaluatorInputTokens = rounds.reduce((sum, r) => sum + r.evaluatorInputTokens, 0);
    const evaluatorOutputTokens = rounds.reduce((sum, r) => sum + r.evaluatorOutputTokens, 0);
    const duration = rounds.reduce((sum, r) => sum + r.coderDurationMs + r.evaluatorDurationMs, 0);
    return {
      sprintId: sprint.id,
      name: sprint.name,
      rounds: rounds.length,
      coderCost,
      evaluatorCost,
      totalCost: coderCost + evaluatorCost,
      coderInputTokens,
      coderOutputTokens,
      evaluatorInputTokens,
      evaluatorOutputTokens,
      duration,
      verdict: sprint.status === 'passed' ? 'passed' : 'failed',
    };
  });

  const allRoundsRow = db.prepare(`
    SELECT
      COALESCE(SUM(r.coder_cost_usd + r.evaluator_cost_usd), 0)            AS total_cost,
      COALESCE(SUM(r.coder_duration_ms + r.evaluator_duration_ms), 0)       AS total_duration,
      COUNT(r.id)                                                            AS total_rounds,
      COALESCE(SUM(r.coder_input_tokens + r.coder_output_tokens
                 + r.evaluator_input_tokens + r.evaluator_output_tokens), 0) AS total_tokens,
      COALESCE(SUM(r.coder_input_tokens + r.evaluator_input_tokens), 0)     AS total_input_tokens,
      COALESCE(SUM(r.coder_output_tokens + r.evaluator_output_tokens), 0)   AS total_output_tokens,
      COALESCE(SUM(r.coder_api_requests + r.evaluator_api_requests), 0)     AS total_api_requests,
      COALESCE(SUM(r.coder_cost_usd), 0)                                    AS coder_cost,
      COALESCE(SUM(r.evaluator_cost_usd), 0)                                AS evaluator_cost
    FROM harness_rounds r
    JOIN harness_sprints s ON s.id = r.sprint_id
    WHERE s.project_id = ?
  `).get(projectId) as Record<string, number>;

  const passedSprints = sprints.filter(s => s.status === 'passed').length;
  const completedSprints = sprints.filter(s => s.status === 'passed' || s.status === 'failed').length;
  const passRate = completedSprints > 0 ? passedSprints / completedSprints : 0;

  // Include planner cost from the project record
  const project = getHarnessProject(projectId);
  const plannerCost = project?.plannerCostUsd ?? 0;
  const plannerDuration = project?.plannerDurationMs ?? 0;
  const plannerTokens = (project?.plannerInputTokens ?? 0) + (project?.plannerOutputTokens ?? 0);

  return {
    totalCost: (allRoundsRow['total_cost'] ?? 0) + plannerCost,
    totalDuration: (allRoundsRow['total_duration'] ?? 0) + plannerDuration,
    totalRounds: allRoundsRow['total_rounds'] ?? 0,
    totalTokens: (allRoundsRow['total_tokens'] ?? 0) + plannerTokens,
    totalInputTokens: (allRoundsRow['total_input_tokens'] ?? 0) + (project?.plannerInputTokens ?? 0),
    totalOutputTokens: (allRoundsRow['total_output_tokens'] ?? 0) + (project?.plannerOutputTokens ?? 0),
    totalApiRequests: allRoundsRow['total_api_requests'] ?? 0,
    passRate,
    coderCost: allRoundsRow['coder_cost'] ?? 0,
    evaluatorCost: allRoundsRow['evaluator_cost'] ?? 0,
    plannerCost,
    sprintMetrics,
  };
}

// ---- Enrich Sessions CRUD ----

export interface EnrichSessionRow {
  id: string;
  name: string;
  specPath: string;
  projectPath: string | null;
  prdPath: string | null;
  userMessage: string | null;
  validatorAgentId: string;
  enricherAgentId: string;
  phase: 'validator' | 'enricher' | 'done';
  status: 'idle' | 'running' | 'waiting' | 'finalizing' | 'done';
  finalSpecPath: string | null;
  validatorInputTokens: number;
  validatorOutputTokens: number;
  validatorCacheReadTokens: number;
  validatorCacheCreationTokens: number;
  validatorCostUsd: number;
  validatorDurationMs: number;
  validatorToolUses: number;
  validatorApiRequests: number;
  validatorMessages: number;
  enricherInputTokens: number;
  enricherOutputTokens: number;
  enricherCacheReadTokens: number;
  enricherCacheCreationTokens: number;
  enricherCostUsd: number;
  enricherDurationMs: number;
  enricherToolUses: number;
  enricherApiRequests: number;
  enricherMessages: number;
  createdAt: string;
  updatedAt: string;
}

function mapEnrichSession(row: Record<string, unknown>): EnrichSessionRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    specPath: row['spec_path'] as string,
    projectPath: (row['project_path'] as string | null) ?? null,
    prdPath: (row['prd_path'] as string | null) ?? null,
    userMessage: (row['user_message'] as string | null) ?? null,
    validatorAgentId: row['validator_agent_id'] as string,
    enricherAgentId: row['enricher_agent_id'] as string,
    phase: row['phase'] as EnrichSessionRow['phase'],
    status: row['status'] as EnrichSessionRow['status'],
    finalSpecPath: (row['final_spec_path'] as string | null) ?? null,
    validatorInputTokens: (row['validator_input_tokens'] as number) ?? 0,
    validatorOutputTokens: (row['validator_output_tokens'] as number) ?? 0,
    validatorCacheReadTokens: (row['validator_cache_read_tokens'] as number) ?? 0,
    validatorCacheCreationTokens: (row['validator_cache_creation_tokens'] as number) ?? 0,
    validatorCostUsd: (row['validator_cost_usd'] as number) ?? 0,
    validatorDurationMs: (row['validator_duration_ms'] as number) ?? 0,
    validatorToolUses: (row['validator_tool_uses'] as number) ?? 0,
    validatorApiRequests: (row['validator_api_requests'] as number) ?? 0,
    validatorMessages: (row['validator_messages'] as number) ?? 0,
    enricherInputTokens: (row['enricher_input_tokens'] as number) ?? 0,
    enricherOutputTokens: (row['enricher_output_tokens'] as number) ?? 0,
    enricherCacheReadTokens: (row['enricher_cache_read_tokens'] as number) ?? 0,
    enricherCacheCreationTokens: (row['enricher_cache_creation_tokens'] as number) ?? 0,
    enricherCostUsd: (row['enricher_cost_usd'] as number) ?? 0,
    enricherDurationMs: (row['enricher_duration_ms'] as number) ?? 0,
    enricherToolUses: (row['enricher_tool_uses'] as number) ?? 0,
    enricherApiRequests: (row['enricher_api_requests'] as number) ?? 0,
    enricherMessages: (row['enricher_messages'] as number) ?? 0,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function insertEnrichSession(session: {
  id: string;
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  userMessage?: string;
  validatorAgentId: string;
  enricherAgentId?: string;
}): EnrichSessionRow {
  db.prepare(`
    INSERT INTO enrich_sessions (id, name, spec_path, project_path, prd_path, user_message, validator_agent_id, enricher_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.name,
    session.specPath,
    session.projectPath ?? null,
    session.prdPath ?? null,
    session.userMessage ?? null,
    session.validatorAgentId,
    session.enricherAgentId ?? 'spec-enricher',
  );
  return getEnrichSession(session.id)!;
}

export function getEnrichSession(id: string): EnrichSessionRow | undefined {
  const row = db.prepare('SELECT * FROM enrich_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapEnrichSession(row);
}

export function updateEnrichSession(id: string, fields: Partial<{
  name: string;
  specPath: string;
  projectPath: string | null;
  prdPath: string | null;
  userMessage: string | null;
  validatorAgentId: string;
  enricherAgentId: string;
  phase: EnrichSessionRow['phase'];
  status: EnrichSessionRow['status'];
  finalSpecPath: string | null;
}>): EnrichSessionRow {
  const cols: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined)             { cols.push('name = ?');               values.push(fields.name); }
  if (fields.specPath !== undefined)         { cols.push('spec_path = ?');           values.push(fields.specPath); }
  if (fields.projectPath !== undefined)      { cols.push('project_path = ?');        values.push(fields.projectPath); }
  if (fields.prdPath !== undefined)          { cols.push('prd_path = ?');            values.push(fields.prdPath); }
  if (fields.userMessage !== undefined)      { cols.push('user_message = ?');        values.push(fields.userMessage); }
  if (fields.validatorAgentId !== undefined) { cols.push('validator_agent_id = ?'); values.push(fields.validatorAgentId); }
  if (fields.enricherAgentId !== undefined)  { cols.push('enricher_agent_id = ?');  values.push(fields.enricherAgentId); }
  if (fields.phase !== undefined)            { cols.push('phase = ?');               values.push(fields.phase); }
  if (fields.status !== undefined)           { cols.push('status = ?');              values.push(fields.status); }
  if (fields.finalSpecPath !== undefined)    { cols.push('final_spec_path = ?');     values.push(fields.finalSpecPath); }

  if (cols.length > 0) {
    cols.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE enrich_sessions SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }
  return getEnrichSession(id)!;
}

export function listEnrichSessions(): EnrichSessionRow[] {
  const rows = db.prepare('SELECT * FROM enrich_sessions ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapEnrichSession);
}

export function deleteEnrichSession(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM enrich_messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM enrich_sessions WHERE id = ?').run(id);
  })();
}

export function accumulateEnrichMetrics(
  id: string,
  phase: 'validator' | 'enricher',
  metrics: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    durationMs?: number;
    toolUses?: number;
    apiRequests?: number;
    messages?: number;
  },
): void {
  const p = phase;
  const cols: string[] = [];
  const values: unknown[] = [];

  if (metrics.inputTokens)       { cols.push(`${p}_input_tokens = ${p}_input_tokens + ?`);                 values.push(metrics.inputTokens); }
  if (metrics.outputTokens)      { cols.push(`${p}_output_tokens = ${p}_output_tokens + ?`);               values.push(metrics.outputTokens); }
  if (metrics.cacheReadTokens)   { cols.push(`${p}_cache_read_tokens = ${p}_cache_read_tokens + ?`);       values.push(metrics.cacheReadTokens); }
  if (metrics.cacheCreationTokens) { cols.push(`${p}_cache_creation_tokens = ${p}_cache_creation_tokens + ?`); values.push(metrics.cacheCreationTokens); }
  if (metrics.costUsd)           { cols.push(`${p}_cost_usd = ${p}_cost_usd + ?`);                         values.push(metrics.costUsd); }
  if (metrics.durationMs)        { cols.push(`${p}_duration_ms = ${p}_duration_ms + ?`);                   values.push(metrics.durationMs); }
  if (metrics.toolUses)          { cols.push(`${p}_tool_uses = ${p}_tool_uses + ?`);                       values.push(metrics.toolUses); }
  if (metrics.apiRequests)       { cols.push(`${p}_api_requests = ${p}_api_requests + ?`);                 values.push(metrics.apiRequests); }
  if (metrics.messages)          { cols.push(`${p}_messages = ${p}_messages + ?`);                         values.push(metrics.messages); }

  if (cols.length === 0) return;

  cols.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE enrich_sessions SET ${cols.join(', ')} WHERE id = ?`).run(...values);
}

// NOTE: ensureEnrichAgents/ensureDevAgents/ensurePipelineAgents/ensureTechAgents/
// ensureSecurityAgents/ensureFeatureAgents foram removidas — substituidas pela
// `ensureAllSeedAgents()` em `seed-agents/ensure.ts`.

// ---- Security Agent Status CRUD ----

export interface SecurityAgentStatusRow {
  id: number;
  projectId: string;
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount: number;
  outputFile?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
}

function mapSecurityAgentStatus(row: Record<string, unknown>): SecurityAgentStatusRow {
  return {
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    agentId: row['agent_id'] as string,
    agentName: row['agent_name'] as string,
    status: row['status'] as SecurityAgentStatusRow['status'],
    findingsCount: (row['findings_count'] as number) ?? 0,
    outputFile: row['output_file'] as string | undefined,
    startedAt: row['started_at'] as string | undefined,
    completedAt: row['completed_at'] as string | undefined,
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
  };
}

export function insertSecurityAgentStatus(
  projectId: string,
  agents: Array<{ agentId: string; agentName: string }>,
): void {
  const insert = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO security_agent_status (project_id, agent_id, agent_name, status)
      VALUES (?, ?, ?, 'pending')
    `);
    for (const agent of agents) {
      stmt.run(projectId, agent.agentId, agent.agentName);
    }
  });
  insert();
}

export function updateSecurityAgentStatus(
  projectId: string,
  agentId: string,
  patch: Partial<Pick<SecurityAgentStatusRow, 'status' | 'findingsCount' | 'outputFile' | 'startedAt' | 'completedAt' | 'errorMessage'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.status !== undefined)       { fields.push('status = ?');          values.push(patch.status); }
  if (patch.findingsCount !== undefined) { fields.push('findings_count = ?');  values.push(patch.findingsCount); }
  if (patch.outputFile !== undefined)   { fields.push('output_file = ?');      values.push(patch.outputFile); }
  if (patch.startedAt !== undefined)    { fields.push('started_at = ?');       values.push(patch.startedAt); }
  if (patch.completedAt !== undefined)  { fields.push('completed_at = ?');     values.push(patch.completedAt); }
  if (patch.errorMessage !== undefined) { fields.push('error_message = ?');    values.push(patch.errorMessage); }

  if (fields.length === 0) return;

  values.push(projectId, agentId);
  db.prepare(`
    UPDATE security_agent_status SET ${fields.join(', ')}
    WHERE project_id = ? AND agent_id = ?
  `).run(...values);
}

export function getSecurityAgentStatuses(projectId: string): SecurityAgentStatusRow[] {
  const rows = db.prepare(`
    SELECT * FROM security_agent_status WHERE project_id = ? ORDER BY id ASC
  `).all(projectId) as Record<string, unknown>[];
  return rows.map(mapSecurityAgentStatus);
}

export function deleteSecurityAgentStatuses(projectId: string): void {
  db.prepare('DELETE FROM security_agent_status WHERE project_id = ?').run(projectId);
}

export interface AuditAgentRow {
  agentId: string;
  agentName: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  findingsCount?: number;
  costUsd: number;
  durationMs: number;
  model: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  toolCallsCount: number;
}

export function getAuditAgentsState(projectId: string): AuditAgentRow[] {
  const statuses = getSecurityAgentStatuses(projectId);
  if (statuses.length === 0) return [];

  const metricsRows = db.prepare(`
    SELECT agent_id, model, cost_usd, duration_ms, tool_uses, started_at, completed_at, status, metadata
    FROM pipeline_phase_metrics
    WHERE project_id = ? AND phase_number = 2 AND agent_id IS NOT NULL
  `).all(projectId) as Array<{
    agent_id: string;
    model: string | null;
    cost_usd: number;
    duration_ms: number;
    tool_uses: number;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    metadata: string | null;
  }>;

  const metricsByAgent = new Map<string, typeof metricsRows[0]>();
  for (const m of metricsRows) {
    metricsByAgent.set(m.agent_id, m);
  }

  return statuses.map((s) => {
    const m = metricsByAgent.get(s.agentId);
    return {
      agentId: s.agentId,
      agentName: s.agentName,
      status: s.status as AuditAgentRow['status'],
      findingsCount: s.findingsCount,
      costUsd: m?.cost_usd ?? 0,
      durationMs: m?.duration_ms ?? 0,
      model: m?.model ?? null,
      startedAt: s.startedAt ?? m?.started_at ?? null,
      completedAt: s.completedAt ?? m?.completed_at ?? null,
      toolCallsCount: m?.tool_uses ?? 0,
    };
  });
}

// ---- Enrich Messages CRUD ----

export interface EnrichMessageRow {
  id: number;
  sessionId: string;
  phase: 'validator' | 'enricher';
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

export function insertEnrichMessage(
  sessionId: string,
  phase: string,
  role: string,
  content: string,
  toolCalls?: Array<{ tool: string; input: unknown }>,
): void {
  db.prepare(`
    INSERT INTO enrich_messages (session_id, phase, role, content, tool_calls)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sessionId,
    phase,
    role,
    content,
    toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
  );
}

export function getEnrichMessages(
  sessionId: string,
  phase?: string,
): EnrichMessageRow[] {
  let rows: Record<string, unknown>[];
  if (phase) {
    rows = db.prepare(`
      SELECT * FROM enrich_messages
      WHERE session_id = ? AND phase = ?
      ORDER BY id ASC
    `).all(sessionId, phase) as Record<string, unknown>[];
  } else {
    rows = db.prepare(`
      SELECT * FROM enrich_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as Record<string, unknown>[];
  }

  return rows.map((row) => ({
    id: row['id'] as number,
    sessionId: row['session_id'] as string,
    phase: row['phase'] as 'validator' | 'enricher',
    role: row['role'] as 'user' | 'assistant',
    content: row['content'] as string,
    toolCalls: row['tool_calls']
      ? (JSON.parse(row['tool_calls'] as string) as Array<{ tool: string; input: unknown }>)
      : null,
    createdAt: row['created_at'] as string,
  }));
}

// ---- Ingest Jobs ----

export function insertIngestJob(job: {
  id: string;
  fileName: string;
  sourceType: string;
  originalPath?: string;
  fileHash?: string;
  totalChunks?: number;
  estimatedCostUsd?: number;
}): void {
  db.prepare(`
    INSERT INTO ingest_jobs (id, file_name, source_type, original_path, file_hash, status, total_chunks, estimated_cost_usd, started_at)
    VALUES (?, ?, ?, ?, ?, 'extracting', ?, ?, ?)
  `).run(
    job.id,
    job.fileName,
    job.sourceType,
    job.originalPath || null,
    job.fileHash || null,
    job.totalChunks || 0,
    job.estimatedCostUsd || null,
    new Date().toISOString(),
  );
}

export function updateIngestJob(id: string, updates: Partial<{
  status: string;
  totalChunks: number;
  processedChunks: number;
  lastProcessedChunk: number;
  notesCreated: number;
  notesUpdated: number;
  estimatedCostUsd: number;
  error: string;
  completedAt: string;
  createdNotePaths: string[];
}>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.totalChunks !== undefined) { sets.push('total_chunks = ?'); vals.push(updates.totalChunks); }
  if (updates.processedChunks !== undefined) { sets.push('processed_chunks = ?'); vals.push(updates.processedChunks); }
  if (updates.lastProcessedChunk !== undefined) { sets.push('last_processed_chunk = ?'); vals.push(updates.lastProcessedChunk); }
  if (updates.notesCreated !== undefined) { sets.push('notes_created = ?'); vals.push(updates.notesCreated); }
  if (updates.notesUpdated !== undefined) { sets.push('notes_updated = ?'); vals.push(updates.notesUpdated); }
  if (updates.estimatedCostUsd !== undefined) { sets.push('estimated_cost_usd = ?'); vals.push(updates.estimatedCostUsd); }
  if (updates.error !== undefined) { sets.push('error = ?'); vals.push(updates.error); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); vals.push(updates.completedAt); }
  if (updates.createdNotePaths !== undefined) { sets.push('created_note_paths = ?'); vals.push(JSON.stringify(updates.createdNotePaths)); }

  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE ingest_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function getIngestJob(id: string): IngestJob | null {
  const row = db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapIngestJobRow(row);
}

export function getIngestJobByHash(fileHash: string): IngestJob | null {
  const row = db.prepare(
    "SELECT * FROM ingest_jobs WHERE file_hash = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1"
  ).get(fileHash) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapIngestJobRow(row);
}

export function getAllIngestJobs(): IngestJob[] {
  const rows = db.prepare('SELECT * FROM ingest_jobs ORDER BY started_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapIngestJobRow);
}

function mapIngestJobRow(row: Record<string, unknown>): IngestJob {
  let createdNotePaths: string[] = [];
  try {
    createdNotePaths = JSON.parse((row['created_note_paths'] as string) || '[]');
  } catch { /* ignore */ }

  return {
    id: row['id'] as string,
    fileName: row['file_name'] as string,
    sourceType: row['source_type'] as string,
    originalPath: row['original_path'] as string | undefined,
    fileHash: row['file_hash'] as string | undefined,
    status: row['status'] as IngestJob['status'],
    totalChunks: row['total_chunks'] as number,
    processedChunks: row['processed_chunks'] as number,
    lastProcessedChunk: row['last_processed_chunk'] as number,
    notesCreated: row['notes_created'] as number,
    notesUpdated: row['notes_updated'] as number,
    estimatedCostUsd: row['estimated_cost_usd'] as number | undefined,
    error: row['error'] as string | undefined,
    startedAt: row['started_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
    createdNotePaths,
  };
}

// ---- Pipeline Phase Metrics ----

export type PipelinePhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';

export interface PipelinePhaseMetricsRow {
  id: number;
  projectId: string;
  phaseNumber: number;
  sprintIndex: number;
  phaseName: string;
  agentId: string | null;
  status: PipelinePhaseStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  messagesCount: number;
  model: string | null;
  runtime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PipelineMessageRow {
  id: number;
  projectId: string;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

export interface PipelineMetrics {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  };
  cloudCost: number;
  localCost: number;
  phases: PipelinePhaseMetricsRow[];
  sprintPhases: PipelinePhaseMetricsRow[];
  /** Map of agent_id -> display name (for UI labels). */
  agentNames: Record<string, string>;
}

function mapPipelinePhaseMetrics(row: Record<string, unknown>): PipelinePhaseMetricsRow {
  return {
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    phaseNumber: row['phase_number'] as number,
    sprintIndex: (row['sprint_index'] as number) ?? -1,
    phaseName: row['phase_name'] as string,
    agentId: (row['agent_id'] as string | null) ?? null,
    status: row['status'] as PipelinePhaseStatus,
    inputTokens: (row['input_tokens'] as number) ?? 0,
    outputTokens: (row['output_tokens'] as number) ?? 0,
    cacheReadTokens: (row['cache_read_tokens'] as number) ?? 0,
    cacheCreationTokens: (row['cache_creation_tokens'] as number) ?? 0,
    costUsd: (row['cost_usd'] as number) ?? 0,
    durationMs: (row['duration_ms'] as number) ?? 0,
    toolUses: (row['tool_uses'] as number) ?? 0,
    apiRequests: (row['api_requests'] as number) ?? 0,
    messagesCount: (row['messages_count'] as number) ?? 0,
    model: (row['model'] as string | null) ?? null,
    runtime: (row['runtime'] as string | null) ?? null,
    startedAt: (row['started_at'] as string | null) ?? null,
    completedAt: (row['completed_at'] as string | null) ?? null,
    metadata: (() => {
      try { return JSON.parse((row['metadata'] as string) || '{}'); } catch { return {}; }
    })(),
    createdAt: row['created_at'] as string,
  };
}

/**
 * Save or update a pipeline phase metrics row.
 * If a row for (projectId, phaseNumber, sprintIndex) already exists, it is replaced.
 * sprintIndex defaults to -1 for non-sprint phases; use >= 0 for per-sprint rows (phases 10, 11).
 * Returns the id of the upserted row.
 */
export function savePipelinePhaseMetrics(data: {
  projectId: string;
  phaseNumber: number;
  phaseName: string;
  agentId?: string;
  status: PipelinePhaseStatus;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  toolUses?: number;
  apiRequests?: number;
  messagesCount?: number;
  model?: string;
  runtime?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  sprintIndex?: number;
}): number {
  const sprintIdx = data.sprintIndex ?? -1;
  const result = db.prepare(`
    INSERT INTO pipeline_phase_metrics
      (project_id, phase_number, sprint_index, phase_name, agent_id, status,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, duration_ms, tool_uses, api_requests, messages_count,
       model, runtime, started_at, completed_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, phase_number, sprint_index) DO UPDATE SET
      phase_name = excluded.phase_name,
      agent_id = excluded.agent_id,
      status = excluded.status,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cost_usd = excluded.cost_usd,
      duration_ms = excluded.duration_ms,
      tool_uses = excluded.tool_uses,
      api_requests = excluded.api_requests,
      messages_count = excluded.messages_count,
      model = excluded.model,
      runtime = excluded.runtime,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      metadata = excluded.metadata
  `).run(
    data.projectId,
    data.phaseNumber,
    sprintIdx,
    data.phaseName,
    data.agentId ?? null,
    data.status,
    data.inputTokens ?? 0,
    data.outputTokens ?? 0,
    data.cacheReadTokens ?? 0,
    data.cacheCreationTokens ?? 0,
    data.costUsd ?? 0,
    data.durationMs ?? 0,
    data.toolUses ?? 0,
    data.apiRequests ?? 0,
    data.messagesCount ?? 0,
    data.model ?? null,
    data.runtime ?? null,
    data.startedAt ?? null,
    data.completedAt ?? null,
    JSON.stringify(data.metadata ?? {}),
  );

  return result.lastInsertRowid as number;
}

/**
 * Append a message to the pipeline_messages table for a given project and phase.
 */
export function savePipelineMessage(data: {
  projectId: string;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown; output?: string; isError?: boolean }>;
  sprintIndex?: number;
  roundIndex?: number;
  agentId?: string;
}): void {
  db.prepare(`
    INSERT INTO pipeline_messages (project_id, phase_number, role, content, tool_calls, sprint_index, round_index, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.projectId,
    data.phaseNumber,
    data.role,
    data.content,
    data.toolCalls && data.toolCalls.length > 0 ? JSON.stringify(data.toolCalls) : null,
    data.sprintIndex ?? null,
    data.roundIndex ?? null,
    data.agentId ?? null,
  );
}

/**
 * List all pipeline messages for a specific sprint (phases 13 and 14),
 * ordered by round_index ASC then created_at ASC.
 */
export function listPipelineMessagesForSprint(
  projectId: string,
  sprintIndex: number,
): Array<{
  id: number;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
  sprintIndex: number | null;
  roundIndex: number | null;
  agentId: string | null;
  createdAt: string;
}> {
  const rows = db.prepare(`
    SELECT id, phase_number, role, content, tool_calls, sprint_index, round_index, agent_id, created_at
    FROM pipeline_messages
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (13, 14)
    ORDER BY round_index ASC, created_at ASC
  `).all(projectId, sprintIndex) as Array<{
    id: number;
    phase_number: number;
    role: string;
    content: string;
    tool_calls: string | null;
    sprint_index: number | null;
    round_index: number | null;
    agent_id: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    phaseNumber: row.phase_number,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    toolCalls: row.tool_calls ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown }>) : undefined,
    sprintIndex: row.sprint_index,
    roundIndex: row.round_index,
    agentId: row.agent_id,
    createdAt: row.created_at,
  }));
}

/**
 * Delete all pipeline_messages for a project where phase_number >= fromPhase.
 */
export function deletePipelineMessagesFromPhase(projectId: string, fromPhase: number): void {
  db.prepare(`
    DELETE FROM pipeline_messages WHERE project_id = ? AND phase_number >= ?
  `).run(projectId, fromPhase);
}

/**
 * Delete all pipeline_phase_metrics for a project where phase_number >= fromPhase.
 */
export function deletePipelinePhaseMetricsFromPhase(projectId: string, fromPhase: number): void {
  db.prepare(`
    DELETE FROM pipeline_phase_metrics WHERE project_id = ? AND phase_number >= ?
  `).run(projectId, fromPhase);
}

/**
 * Delete pipeline_messages for a specific sprint (phases 13 and 14 only).
 */
export function deletePipelineMessagesForSprint(projectId: string, sprintIndex: number): void {
  db.prepare(`
    DELETE FROM pipeline_messages
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (13, 14)
  `).run(projectId, sprintIndex);
}

/**
 * Delete pipeline_phase_metrics for a specific sprint (phases 13 and 14 only).
 */
export function deletePipelinePhaseMetricsForSprint(projectId: string, sprintIndex: number): void {
  db.prepare(`
    DELETE FROM pipeline_phase_metrics
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (13, 14)
  `).run(projectId, sprintIndex);
}

/**
 * Delete all harness_rounds belonging to the sprint identified by projectId + sprintIndex.
 */
export function deleteHarnessRoundsForSprint(projectId: string, sprintIndex: number): void {
  const sprint = db.prepare(
    'SELECT id FROM harness_sprints WHERE project_id = ? AND sprint_index = ?',
  ).get(projectId, sprintIndex) as { id: string } | undefined;
  if (!sprint) return;
  db.prepare('DELETE FROM harness_rounds WHERE sprint_id = ?').run(sprint.id);
}

/**
 * Reset a sprint back to pending status, clearing its verdict.
 */
export function resetHarnessSprintStatus(projectId: string, sprintIndex: number): void {
  db.prepare(`
    UPDATE harness_sprints
    SET status = 'pending', verdict = NULL, updated_at = datetime('now')
    WHERE project_id = ? AND sprint_index = ?
  `).run(projectId, sprintIndex);
}

/**
 * Delete all harness_rounds and harness_sprints belonging to a project.
 */
export function deleteHarnessSprintsForProject(projectId: string): void {
  // Delete rounds first (child table)
  const sprints = db.prepare(
    'SELECT id FROM harness_sprints WHERE project_id = ?',
  ).all(projectId) as Array<{ id: string }>;
  for (const sprint of sprints) {
    db.prepare('DELETE FROM harness_rounds WHERE sprint_id = ?').run(sprint.id);
  }
  db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(projectId);
}

/**
 * Retrieve a single harness sprint by projectId and sprintIndex.
 * Returns null if not found.
 */
export function getHarnessSprintByIndex(projectId: string, sprintIndex: number): HarnessSprint | null {
  const row = db.prepare(
    'SELECT * FROM harness_sprints WHERE project_id = ? AND sprint_index = ?',
  ).get(projectId, sprintIndex) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapHarnessSprint(row);
}

/**
 * Update the pipeline-specific columns on a harness_projects row.
 * These are V31 columns not covered by updateHarnessProject().
 */
export function updateHarnessProjectPipelineMeta(
  projectId: string,
  columns: {
    pipelineCurrentPhase?: number | null;
    pipelineStartPhase?: number | null;
    prdPath?: string | null;
    status?: string;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (columns.pipelineCurrentPhase !== undefined) {
    fields.push('pipeline_current_phase = ?');
    values.push(columns.pipelineCurrentPhase);
  }
  if (columns.pipelineStartPhase !== undefined) {
    fields.push('pipeline_start_phase = ?');
    values.push(columns.pipelineStartPhase);
  }
  if (columns.prdPath !== undefined) {
    fields.push('prd_path = ?');
    values.push(columns.prdPath);
  }
  if (columns.status !== undefined) {
    fields.push('status = ?');
    values.push(columns.status);
  }
  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(projectId);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

/**
 * Read the SecuritySummary stored for a project, or null if none.
 */
export function getSecuritySummaryJson(projectId: string): SecuritySummary | null {
  const row = db
    .prepare('SELECT security_summary_json FROM harness_projects WHERE id = ?')
    .get(projectId) as { security_summary_json: string | null } | undefined;
  if (!row || !row.security_summary_json) return null;
  try {
    return JSON.parse(row.security_summary_json) as SecuritySummary;
  } catch {
    logger.warn({ projectId }, 'getSecuritySummaryJson: failed to parse stored JSON');
    return null;
  }
}

/**
 * Patch do security_summary_json com shallow merge.
 * Objetos aninhados (como bySeverity) sao SUBSTITUIDOS por completo, nao merged.
 * Passe bySeverity sempre com as 4 chaves (critical/high/medium/low) populadas.
 */
export function patchSecuritySummaryJson(
  projectId: string,
  patch: Partial<SecuritySummary>,
): void {
  const existing = getSecuritySummaryJson(projectId) ?? {};
  const merged: SecuritySummary = { ...existing, ...patch };
  db.prepare(
    `UPDATE harness_projects SET security_summary_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(merged), projectId);
}

/**
 * Read all persisted messages for a specific pipeline phase.
 */
export function getPipelinePhaseMessages(projectId: string, phaseNumber: number): Array<{
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
}> {
  const rows = db.prepare(`
    SELECT role, content, tool_calls
    FROM pipeline_messages
    WHERE project_id = ? AND phase_number = ?
    ORDER BY id ASC
  `).all(projectId, phaseNumber) as Array<{ role: string; content: string; tool_calls: string | null }>;

  // Merge consecutive same-role messages (fixes historical fragmented data from GAP-01)
  const merged: Array<{ role: 'user' | 'assistant'; content: string; toolCalls?: Array<{ tool: string; input: unknown }> }> = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    const toolCalls = row.tool_calls ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown }>) : undefined;
    if (last && last.role === row.role) {
      last.content += row.content;
      if (toolCalls) {
        last.toolCalls = [...(last.toolCalls ?? []), ...toolCalls];
      }
    } else {
      merged.push({
        role: row.role as 'user' | 'assistant',
        content: row.content,
        toolCalls,
      });
    }
  }
  return merged;
}

/**
 * Returns the conversation history of a pipeline phase formatted as OpenAI-compatible
 * chat messages (multi-turn with tool_calls + tool results), for use as priorMessages
 * in stateless external API calls.
 *
 * For each saved row in pipeline_messages:
 *  - role 'user': emits a single { role: 'user', content }
 *  - role 'assistant' with tool_calls JSON containing { tool, input, output? }:
 *      emits { role: 'assistant', content: '', tool_calls: [...] }
 *      followed by N { role: 'tool', tool_call_id, content: output } (when output present)
 *      followed by { role: 'assistant', content } if the saved content is non-empty
 *  - role 'assistant' without tool_calls: emits { role: 'assistant', content }
 *
 * tool_call_ids are deterministically generated from row id + index so they are stable
 * across re-reads of the same conversation.
 */
export function getPipelinePhaseMessagesAsChatHistory(
  projectId: string,
  phaseNumber: number,
): Array<{
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}> {
  const rows = db.prepare(`
    SELECT id, role, content, tool_calls
    FROM pipeline_messages
    WHERE project_id = ? AND phase_number = ?
    ORDER BY id ASC
  `).all(projectId, phaseNumber) as Array<{ id: number; role: string; content: string; tool_calls: string | null }>;

  const out: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }> = [];

  for (const row of rows) {
    if (row.role === 'user') {
      out.push({ role: 'user', content: row.content });
      continue;
    }
    if (row.role !== 'assistant') continue;

    const tcRaw = row.tool_calls
      ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown; output?: string; isError?: boolean }>)
      : [];

    if (tcRaw.length === 0) {
      out.push({ role: 'assistant', content: row.content });
      continue;
    }

    const tcWithIds = tcRaw.map((tc, idx) => ({
      id: `call_${row.id}_${idx}`,
      type: 'function' as const,
      function: {
        name: tc.tool,
        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
      },
      output: tc.output,
    }));

    out.push({
      role: 'assistant',
      content: '',
      tool_calls: tcWithIds.map((tc) => ({ id: tc.id, type: tc.type, function: tc.function })),
    });

    for (const tc of tcWithIds) {
      if (tc.output !== undefined) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: tc.output });
      }
    }

    if (row.content && row.content.trim().length > 0) {
      out.push({ role: 'assistant', content: row.content });
    }
  }

  return out;
}

/**
 * Read pipeline metrics for a project exclusively from pipeline_phase_metrics.
 * Returns totals, cloud vs local cost breakdown, all phases sorted by phase_number,
 * and sprintPhases (phases with phase_number 13 or 14).
 *
 * This function is intentionally separate from getHarnessProjectMetrics() which
 * reads from harness_rounds and is kept for legacy/harness projects.
 */
export function getPipelineMetrics(projectId: string): PipelineMetrics {
  const phases = db.prepare(`
    SELECT * FROM pipeline_phase_metrics
    WHERE project_id = ?
    ORDER BY phase_number ASC
  `).all(projectId) as Record<string, unknown>[];

  const mappedPhases = phases.map(mapPipelinePhaseMetrics);

  const totalsRow = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0)        AS total_input,
      COALESCE(SUM(output_tokens), 0)       AS total_output,
      COALESCE(SUM(cache_read_tokens + cache_creation_tokens), 0) AS total_cache,
      COALESCE(SUM(cost_usd), 0)            AS total_cost,
      COALESCE(SUM(duration_ms), 0)         AS total_duration,
      COALESCE(SUM(tool_uses), 0)           AS total_tool_uses,
      COALESCE(SUM(api_requests), 0)        AS total_api_requests
    FROM pipeline_phase_metrics
    WHERE project_id = ?
  `).get(projectId) as Record<string, number>;

  const cloudCostRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS cloud_cost
    FROM pipeline_phase_metrics
    WHERE project_id = ? AND (runtime IS NULL OR runtime != 'local')
  `).get(projectId) as { cloud_cost: number };

  const localCostRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS local_cost
    FROM pipeline_phase_metrics
    WHERE project_id = ? AND runtime = 'local'
  `).get(projectId) as { local_cost: number };

  // Sprint phases: dev pipeline uses 13/14, security pipeline uses 10/11.
  const sprintPhases = mappedPhases.filter(
    (p) => p.phaseNumber === 10 || p.phaseNumber === 11 || p.phaseNumber === 13 || p.phaseNumber === 14,
  );

  // Build agent_id -> display name map for all agents referenced in the metrics
  const agentIds = new Set<string>();
  for (const p of mappedPhases) {
    if (p.agentId) agentIds.add(p.agentId);
  }
  const agentNames: Record<string, string> = {};
  for (const aid of agentIds) {
    const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(aid) as { name: string } | undefined;
    agentNames[aid] = agentRow?.name ?? aid;
  }

  return {
    totals: {
      inputTokens: totalsRow['total_input'] ?? 0,
      outputTokens: totalsRow['total_output'] ?? 0,
      cacheTokens: totalsRow['total_cache'] ?? 0,
      costUsd: totalsRow['total_cost'] ?? 0,
      durationMs: totalsRow['total_duration'] ?? 0,
      toolUses: totalsRow['total_tool_uses'] ?? 0,
      apiRequests: totalsRow['total_api_requests'] ?? 0,
    },
    cloudCost: cloudCostRow['cloud_cost'] ?? 0,
    localCost: localCostRow['local_cost'] ?? 0,
    phases: mappedPhases,
    sprintPhases,
    agentNames,
  };
}

// =============================================================================
// Codex Windows prep consent (V51) — SPEC-codex-windows-fix.md Camada 2
// =============================================================================

/**
 * Versao atual da definicao de "preparar projeto pra Codex no Windows".
 * Bumping aqui invalida consents antigos e re-pede autorizacao ao usuario.
 *
 * v1: git config core.autocrlf false + .gitattributes simples + renormalize
 */
export const CODEX_PREP_VERSION_CURRENT = 1;

export interface CodexWindowsPrepConsent {
  repoRoot: string;
  prepVersion: number;
  action: 'prepared' | 'skip';
  consentedAt: number;
  lastAppliedAt: number | null;
}

export function getCodexWindowsPrepConsent(repoRoot: string): CodexWindowsPrepConsent | null {
  const row = db.prepare(
    `SELECT repo_root, prep_version, action, consented_at, last_applied_at
     FROM codex_windows_prep_consent
     WHERE repo_root = ?`
  ).get(repoRoot) as
    | {
        repo_root: string;
        prep_version: number;
        action: 'prepared' | 'skip';
        consented_at: number;
        last_applied_at: number | null;
      }
    | undefined;

  if (!row) return null;

  return {
    repoRoot: row.repo_root,
    prepVersion: row.prep_version,
    action: row.action,
    consentedAt: row.consented_at,
    lastAppliedAt: row.last_applied_at,
  };
}

export function upsertCodexWindowsPrepConsent(input: {
  repoRoot: string;
  prepVersion: number;
  action: 'prepared' | 'skip';
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO codex_windows_prep_consent (repo_root, prep_version, action, consented_at, last_applied_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(repo_root) DO UPDATE SET
       prep_version = excluded.prep_version,
       action = excluded.action,
       consented_at = excluded.consented_at,
       last_applied_at = NULL`
  ).run(input.repoRoot, input.prepVersion, input.action, now);
}

export function markCodexWindowsPrepApplied(repoRoot: string): void {
  db.prepare(
    `UPDATE codex_windows_prep_consent
     SET last_applied_at = ?
     WHERE repo_root = ?`
  ).run(Date.now(), repoRoot);
}

/**
 * Verifica se existe pelo menos 1 agente ativo com runtime='codex' no DB.
 * Usado pra decidir se o dialog de Windows-prep faz sentido pra este projeto.
 */
export function systemHasActiveCodexAgents(): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM agents WHERE runtime = 'codex' AND is_active = 1`
  ).get() as { c: number };
  return row.c > 0;
}
