// ---- Pipeline Type ----

export type PipelineType = 'development' | 'security' | 'feature' | 'architecture-review';

// ---- Pipeline Phase Numbers ----

export type PipelinePhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

// ---- Security Pipeline Phase Number ----

export type SecurityPipelinePhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

// ---- Pipeline Phase Status ----

export type PipelinePhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'interrupted';

// ---- Pipeline Phase Type ----

export type PipelinePhaseType = 'conversation' | 'auto' | 'loop';

// ---- Discovery Block IDs ----

export type DiscoveryBlockId = 'vision' | 'features' | 'monetization' | 'technical' | 'context';

// ---- Agent Effort ----

export type AgentEffort = 'low' | 'medium' | 'high';

// ---- Phase Definition ----

export interface PhaseDefinition {
  number: PipelinePhaseNumber;
  name: string;
  type: PipelinePhaseType;
  agentId: string;
  abbreviation: string;
  stage: number;
  stageName: string;
  groupId?: 'tech' | 'skeptic';
  groupLabel?: string;
  resetable: boolean;
}

// ---- PIPELINE_PHASES const ----

export const PIPELINE_PHASES: PhaseDefinition[] = [
  { number: 1,  name: 'Discovery',        type: 'conversation', agentId: 'discovery-agent',  abbreviation: 'Disc',   stage: 1, stageName: 'Discovery',  resetable: true  },
  { number: 2,  name: 'PRD Generator',    type: 'auto',         agentId: 'prd-generator',    abbreviation: 'PRD',    stage: 2, stageName: 'PRD',        resetable: true  },
  { number: 3,  name: 'PRD Validator',    type: 'conversation', agentId: 'prd-validator',    abbreviation: 'Val',    stage: 2, stageName: 'PRD',        resetable: false },
  { number: 4,  name: 'PRD Completo',     type: 'auto',         agentId: 'prd-generator',    abbreviation: 'PRD+',   stage: 2, stageName: 'PRD',        resetable: true  },
  { number: 5,  name: 'Database',         type: 'conversation', agentId: 'tech-database',    abbreviation: 'DB',     stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 6,  name: 'Backend',          type: 'conversation', agentId: 'tech-backend',     abbreviation: 'BE',     stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 7,  name: 'Frontend',         type: 'conversation', agentId: 'tech-frontend',    abbreviation: 'FE',     stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 8,  name: 'Security',         type: 'conversation', agentId: 'tech-security',    abbreviation: 'SEC',    stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 9,  name: 'Spec Generation',  type: 'auto',         agentId: 'spec-builder',     abbreviation: 'Spec',   stage: 4, stageName: 'Spec',       resetable: true  },
  { number: 10, name: 'Spec Enricher',    type: 'conversation', agentId: 'spec-enricher',    abbreviation: 'Enrich', stage: 4, stageName: 'Spec',       resetable: false },
  { number: 11, name: 'Planner',          type: 'auto',         agentId: 'harness-planner',  abbreviation: 'Plan',   stage: 5, stageName: 'Execution',  resetable: true  },
  { number: 12, name: 'Sprint Validator', type: 'conversation', agentId: 'sprint-validator', abbreviation: 'SVal',   stage: 5, stageName: 'Execution',  resetable: true  },
  { number: 13, name: 'Coder',            type: 'loop',         agentId: 'harness-coder',    abbreviation: 'Code',   stage: 5, stageName: 'Execution',  resetable: false },
  { number: 14, name: 'Evaluator',        type: 'loop',         agentId: 'harness-evaluator', abbreviation: 'Eval',  stage: 5, stageName: 'Execution',  resetable: false },
];

// ---- SECURITY_PIPELINE_PHASES const ----

export const SECURITY_PIPELINE_PHASES: PhaseDefinition[] = [
  { number: 1,  name: 'Repo Profiler',    type: 'auto',         agentId: 'repo-profiler',              abbreviation: 'Prof',   stage: 1, stageName: 'Scan',      resetable: true  },
  { number: 2,  name: 'Security Audit',   type: 'auto',         agentId: 'multi-agent',                abbreviation: 'Audit',  stage: 1, stageName: 'Scan',      resetable: true  },
  { number: 3,  name: 'Deduplicador',     type: 'auto',         agentId: 'security-deduplicator',      abbreviation: 'Dedup',  stage: 1, stageName: 'Scan',      resetable: true  },
  { number: 4,  name: 'Skeptic Security', type: 'conversation', agentId: 'security-skeptic-security',  abbreviation: 'Sec',    stage: 2, stageName: 'Validacao', groupId: 'skeptic', groupLabel: 'VALIDAÇÃO', resetable: false },
  { number: 5,  name: 'Skeptic Quality',  type: 'conversation', agentId: 'security-skeptic-quality',   abbreviation: 'Qual',   stage: 2, stageName: 'Validacao', groupId: 'skeptic', groupLabel: 'VALIDAÇÃO', resetable: false },
  { number: 6,  name: 'SPEC Generator',   type: 'auto',         agentId: 'spec-builder',               abbreviation: 'Spec',   stage: 3, stageName: 'Spec',      resetable: true  },
  { number: 7,  name: 'SPEC Enricher',    type: 'conversation', agentId: 'spec-enricher',              abbreviation: 'Enrich', stage: 3, stageName: 'Spec',      resetable: false },
  { number: 8,  name: 'Planner',          type: 'auto',         agentId: 'harness-planner',            abbreviation: 'Plan',   stage: 4, stageName: 'Execucao',  resetable: true  },
  { number: 9,  name: 'Sprint Validator', type: 'conversation', agentId: 'sprint-validator',           abbreviation: 'SVal',   stage: 4, stageName: 'Execucao',  resetable: true  },
  { number: 10, name: 'Coder',            type: 'loop',         agentId: 'harness-coder',              abbreviation: 'Code',   stage: 4, stageName: 'Execucao',  resetable: false },
  { number: 11, name: 'Evaluator',        type: 'loop',         agentId: 'harness-evaluator',          abbreviation: 'Eval',   stage: 4, stageName: 'Execucao',  resetable: false },
];

// ---- FEATURE_PIPELINE_PHASES const ----

export const FEATURE_PIPELINE_PHASES: PhaseDefinition[] = [
  { number: 1,  name: 'Feature Discovery',  type: 'conversation', agentId: 'feat-discovery',       abbreviation: 'FDisc', stage: 1, stageName: 'Discovery',  resetable: true  },
  { number: 2,  name: 'PRD Generator',      type: 'auto',         agentId: 'feat-prd-generator',   abbreviation: 'PRD',   stage: 2, stageName: 'PRD',        resetable: true  },
  { number: 3,  name: 'PRD Validator',      type: 'conversation', agentId: 'feat-prd-validator',   abbreviation: 'Val',   stage: 2, stageName: 'PRD',        resetable: false },
  { number: 4,  name: 'PRD Completo',       type: 'auto',         agentId: 'feat-prd-completo',    abbreviation: 'PRD+',  stage: 2, stageName: 'PRD',        resetable: true  },
  { number: 5,  name: 'Database',           type: 'conversation', agentId: 'feat-tech-database',   abbreviation: 'DB',    stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 6,  name: 'Backend',            type: 'conversation', agentId: 'feat-tech-backend',    abbreviation: 'BE',    stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 7,  name: 'Frontend',           type: 'conversation', agentId: 'feat-tech-frontend',   abbreviation: 'FE',    stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 8,  name: 'Security',           type: 'conversation', agentId: 'feat-tech-security',   abbreviation: 'SEC',   stage: 3, stageName: 'Tech',       groupId: 'tech', groupLabel: 'TECH', resetable: false },
  { number: 9,  name: 'Spec Generation',    type: 'auto',         agentId: 'spec-builder',         abbreviation: 'Spec',  stage: 4, stageName: 'Spec',       resetable: true  },
  { number: 10, name: 'Spec Enricher',      type: 'conversation', agentId: 'spec-enricher',        abbreviation: 'Enrich',stage: 4, stageName: 'Spec',       resetable: false },
  { number: 11, name: 'Planner',            type: 'auto',         agentId: 'harness-planner',      abbreviation: 'Plan',  stage: 5, stageName: 'Execution',  resetable: true  },
  { number: 12, name: 'Sprint Validator',   type: 'conversation', agentId: 'sprint-validator',     abbreviation: 'SVal',  stage: 5, stageName: 'Execution',  resetable: true  },
  { number: 13, name: 'Coder',              type: 'loop',         agentId: 'harness-coder',        abbreviation: 'Code',  stage: 5, stageName: 'Execution',  resetable: false },
  { number: 14, name: 'Evaluator',          type: 'loop',         agentId: 'harness-evaluator',    abbreviation: 'Eval',  stage: 5, stageName: 'Execution',  resetable: false },
];

// ---- ARCHITECTURE_REVIEW_PIPELINE_PHASES const ----

export const ARCHITECTURE_REVIEW_PIPELINE_PHASES: PhaseDefinition[] = [
  { number: 1,  name: 'Mapeamento Arquitetural',   type: 'auto',         agentId: 'architecture-mapper',                abbreviation: 'Map',    stage: 1, stageName: 'Review',    resetable: true  },
  { number: 2,  name: 'Triagem de Alvos',          type: 'conversation', agentId: 'architecture-target-triage',         abbreviation: 'Target', stage: 1, stageName: 'Review',    resetable: true  },
  { number: 3,  name: 'Diagnostico Arquitetural',  type: 'auto',         agentId: 'architecture-diagnostician',         abbreviation: 'Diag',   stage: 2, stageName: 'Evidence',  resetable: true  },
  { number: 4,  name: 'Entrevista de Decisao',     type: 'conversation', agentId: 'architecture-decision-interviewer',  abbreviation: 'Decide', stage: 3, stageName: 'Decision',  resetable: true  },
  { number: 5,  name: 'Spec Generation',           type: 'auto',         agentId: 'spec-builder',                       abbreviation: 'Spec',   stage: 4, stageName: 'Spec',      resetable: true  },
  { number: 6,  name: 'Spec Validation',           type: 'conversation', agentId: 'spec-validator',                     abbreviation: 'Val',    stage: 4, stageName: 'Spec',      resetable: false },
  { number: 7,  name: 'Spec Enricher',             type: 'conversation', agentId: 'spec-enricher',                      abbreviation: 'Enrich', stage: 4, stageName: 'Spec',      resetable: false },
  { number: 8,  name: 'Planner',                   type: 'auto',         agentId: 'harness-planner',                    abbreviation: 'Plan',   stage: 5, stageName: 'Execution', resetable: true  },
  { number: 9,  name: 'Sprint Validator',          type: 'conversation', agentId: 'sprint-validator',                   abbreviation: 'SVal',   stage: 5, stageName: 'Execution', resetable: true  },
  { number: 10, name: 'Coder',                     type: 'loop',         agentId: 'harness-coder',                      abbreviation: 'Code',   stage: 5, stageName: 'Execution', resetable: false },
  { number: 11, name: 'Evaluator',                 type: 'loop',         agentId: 'harness-evaluator',                  abbreviation: 'Eval',   stage: 5, stageName: 'Execution', resetable: false },
];

// ---- Security Agent Status ----

export interface SecurityAgentStatus {
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount: number;
  error?: string;
}

// ---- Phase Action Button Config ----

export interface PhaseActionButtonConfig {
  label: string;
  variant: 'primary' | 'secondary' | 'danger' | 'warning' | 'success';
  action: string;
  disabled?: boolean;
  tooltip?: string;
}

// ---- Thinking Config ----

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
}

// ---- MCP Server Config (pipeline-specific) ----

export interface McpServerConfigPipeline {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ---- Agent Query Config ----

export interface AgentQueryConfig {
  agentId: string;
  model: string;
  effort: AgentEffort;
  maxTurns: number;
  maxToolRounds: number;
  thinking?: ThinkingConfig;
  mcpServers?: McpServerConfigPipeline[];
  allowedTools?: string[];
}

// ---- Harness Config Pipeline Extension ----

export interface HarnessConfigPipelineExtension {
  maxRounds: number;
  maxSprints?: number;
  stopOnFirstFailure?: boolean;
}

// ---- Pipeline Project ----

export interface PipelineProject {
  id: string;
  name: string;
  projectPath: string;
  specPath: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  currentPhase: PipelinePhaseNumber | null;
  /**
   * Whether the pipeline is currently awaiting user input. Derived server-side
   * in `pipeline:get-project` for conversation phases (1, 3, 5-10, 12) so that
   * the frontend can rehydrate the "Aprovar" button state after a main-process
   * restart (see BUG-19).
   */
  awaitingUser?: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  pipelineType?: PipelineType;
  // pipeline:get-project handler enriquece com sprints; pipeline:list-projects nao.
  sprints?: Array<{
    index: number;
    name: string;
    status?: string;
    coderAgentId?: string;
    evaluatorAgentId?: string;
    sprintJsonId?: string;
    sprintId?: string;
    rounds?: number;
    metrics?: Record<string, unknown>;
  }>;
}

// ---- Pipeline Message ----

export interface PipelineMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
  attachments?: import('./index').ChatAttachment[];
  metadata?: Record<string, unknown>;
  sprintIndex?: number;
  roundIndex?: number;
  agentId?: string;
}

// ---- Pipeline Sprint Message (returned by getSprintHistory) ----

export interface PipelineSprintMessage {
  id: number;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
  sprintIndex: number | null;
  roundIndex: number | null;
  agentId: string | null;
  createdAt: string;
}

// ---- Pipeline Reset Preview ----

export interface PipelineResetPreview {
  filesToDelete: string[];
  messagesToDelete: number;
  metricsToDelete: number;
  sprintsAffected: number[];
}

// ---- Pipeline Stream Chunk (discriminated union) ----

export type PipelineStreamChunk =
  | {
      type: 'thinking';
      projectId: string;
      phase: number;
    }
  | {
      type: 'text';
      projectId: string;
      phase: number;
      content: string;
      auditAgentId?: string;
      auditAgentSlug?: string;
    }
  | {
      type: 'tool_call';
      projectId: string;
      phase: number;
      tool: string;
      input?: unknown;
      auditAgentId?: string;
      auditAgentSlug?: string;
    }
  | {
      type: 'tool_result';
      projectId: string;
      phase: number;
      tool: string;
      content?: string;
      isError?: boolean;
    }
  | {
      type: 'done';
      projectId: string;
      phase: number;
    }
  | {
      type: 'error';
      projectId: string;
      phase: number;
      message: string;
    }
  | {
      type: 'usage';
      projectId: string;
      phase: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'phase_changed';
      projectId: string;
      phase: number;
      phaseName?: string;
      status: string;
      awaitingUser: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'sprint_complete';
      projectId: string;
      phase: number;
      sprintIndex: number;
      sprintName: string;
      verdict: string;
      reportPath?: string;
      rounds?: number;
      metrics?: Record<string, unknown>;
    };

// ---- Pipeline Event Types ----

export interface PipelinePhaseChangedEvent {
  projectId: string;
  phase: number | null;
  phaseName?: string;
  status: string;
  awaitingUser: boolean;
  metadata?: Record<string, unknown>;
  currentModel?: string | null;
}

export interface PipelineNotesUpdatedEvent {
  projectId: string;
  path: string;
  content: string;
}

export interface PipelineSprintCompleteEvent {
  projectId: string;
  sprintIndex: number;
  sprintName: string;
  verdict: string;
  reportPath?: string;
  rounds?: number;
  metrics?: Record<string, unknown>;
}

// ---- Pipeline Project Updated Event ----

/**
 * Emitted whenever the engine mutates a harness_projects row through
 * `updateProjectColumns`. Carries only the fields that changed so the
 * frontend can patch the project in its store without a full refetch.
 *
 * Introduced by BUG-21 fix: keeps `project.status` and `project.currentPhase`
 * in sync with backend reality so the UI can derive a single mutually
 * exclusive state (streaming | awaiting-input | paused | done | failed | idle).
 */
export interface PipelineProjectUpdatedEvent {
  projectId: string;
  patch: {
    status?: PipelineProject['status'];
    currentPhase?: PipelinePhaseNumber | null;
  };
}

// ---- Pipeline Metrics ----

export interface PipelineMetricsTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
}

export interface PipelinePhaseMetrics {
  id: number;
  projectId: string;
  phaseNumber: number;
  sprintIndex?: number;
  phaseName: string;
  agentId: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  model: string | null;
  runtime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RoundDetail {
  roundNumber: number;
  verdict: string | null;
  feedbackSummary: string | null;
  coderModel: string | null;
  evaluatorModel: string | null;
  coderInputTokens: number;
  coderOutputTokens: number;
  coderCostUsd: number;
  coderDurationMs: number;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PipelineMetricsResult {
  totals: PipelineMetricsTotals;
  cloudCost: number;
  localCost: number;
  phases: PipelinePhaseMetrics[];
  sprintPhases: PipelinePhaseMetrics[];
  /** Map of agent_id -> display name (for UI labels). */
  agentNames: Record<string, string>;
}

// ---- RepoManifest ----
// Copia do tipo definido em electron/main/repo-profiler.ts.
// O renderer nao pode importar de electron/main, entao mantemos uma copia aqui.

export interface RepoManifest {
  /** Caminho absoluto do projeto auditado. */
  projectPath: string;
  /** Linguagem principal detectada. */
  language: string;
  /** Framework detectado. */
  framework: string;
  /** Timestamp ISO da varredura. */
  scannedAt: string;
  /** Total de arquivos encontrados (incluindo skippados por tamanho). */
  totalFiles: number;
  /** Arquivos que receberam ao menos uma role. */
  classifiedFiles: number;
  /** Diretorios que foram ignorados durante a varredura. */
  ignoredDirs: string[];
  /** Mapa de role -> array de caminhos relativos ao projectPath. */
  filesByRole: Record<string, string[]>;
  /** Path absoluto do SecurityScan-*.json mais recente, ou null. */
  previousScan: string | null;
  /** Arquivos ignorados por excederem o limite de tamanho configurado. */
  skippedLargeFiles?: Array<{ path: string; sizeBytes: number }>;
}

// ---- Pipeline Audit Agent Progress Event ----

export interface PipelineAuditAgentProgressEvent {
  projectId: string;
  agentId: string;
  slug: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
  costUsd: number;
  durationMs: number;
  findingsCount?: number;
  model?: string | null;
  agentName?: string;
  runtime?: 'cloud' | 'local' | 'external' | 'codex' | null;
}

// ---- Audit Agent State (multi-panel security audit) ----

export interface AuditAgentState {
  agentId: string;
  slug: string;
  name: string;
  model: string | null;
  runtime?: 'cloud' | 'local' | 'external' | 'codex' | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  streamContent: string;
  toolCalls: Array<{ tool: string; input: unknown }>;
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
  costUsd: number;
  durationMs: number;
  findingsCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export type AuditPanelSlots = readonly [string | null, string | null, string | null];

// ---- Role + ROLE_METADATA ----
// Copia do tipo definido em electron/main/repo-profiler.ts.

export type Role =
  | 'auth'
  | 'query'
  | 'crypto'
  | 'route'
  | 'middleware'
  | 'template'
  | 'async'
  | 'error-handling'
  | 'config'
  | 'migration';

export const ROLE_METADATA: Record<Role, {
  label: string;
  description: string;
  threshold: number;
  samplePatterns: string[];
}> = {
  auth: { label: 'Auth', description: 'Arquivos com logica de autenticacao', threshold: 2, samplePatterns: ['session', 'token', 'jwt.verify', 'bcrypt'] },
  query: { label: 'Query', description: 'Arquivos com queries de banco', threshold: 1, samplePatterns: ['SELECT', '.query(', 'prisma.', 'findOne'] },
  crypto: { label: 'Crypto', description: 'Arquivos com operacoes criptograficas', threshold: 2, samplePatterns: ['crypto.', 'createHash', 'encrypt', 'pbkdf2'] },
  route: { label: 'Route', description: 'Arquivos de rotas/handlers HTTP', threshold: 2, samplePatterns: ['router.', 'app.get(', '@Get(', '@Post('] },
  middleware: { label: 'Middleware', description: 'Arquivos com middlewares ou interceptors', threshold: 2, samplePatterns: ['middleware', 'next()', 'cors(', 'helmet('] },
  template: { label: 'Template', description: 'Arquivos de template/render HTML', threshold: 1, samplePatterns: ['innerHTML', 'dangerouslySetInnerHTML', '<%', '{{'] },
  async: { label: 'Async', description: 'Arquivos com codigo assincrono pesado', threshold: 5, samplePatterns: ['async', 'await', 'Promise.', 'setTimeout'] },
  'error-handling': { label: 'Error Handling', description: 'Arquivos com try/catch ou throw. NAO significa arquivos com bugs.', threshold: 3, samplePatterns: ['try {', 'catch (', 'throw new', 'Error('] },
  config: { label: 'Config', description: 'Arquivos de configuracao (env, config, settings)', threshold: 1, samplePatterns: ['.env', 'config.json', 'settings.json'] },
  migration: { label: 'Migration', description: 'Arquivos de migration de banco', threshold: 1, samplePatterns: ['migrations/', 'CREATE TABLE', 'ALTER TABLE'] },
};

// ---- SecurityAgentStatusEvent ----

export interface SecurityAgentStatusEvent {
  projectId: string;
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount?: number;
  error?: string;
}

// ---- SecuritySummary ----

export interface SecuritySummary {
  totalFindings?: number;
  bySeverity?: {
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
  };
  removedByValidator?: number;
  confirmedFindings?: number;
  resolved?: number;
  partiallyResolved?: number;
  unresolved?: number;
}
