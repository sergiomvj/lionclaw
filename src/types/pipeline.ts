// ---- Pipeline Phase Numbers ----

export type PipelinePhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

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
  groupId?: 'tech';
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
  specPath: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted';
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
    }
  | {
      type: 'tool_call';
      projectId: string;
      phase: number;
      tool: string;
      input?: unknown;
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
  sprintIndex: number;
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

export interface PipelineMetricsResult {
  totals: PipelineMetricsTotals;
  cloudCost: number;
  localCost: number;
  phases: PipelinePhaseMetrics[];
  sprintPhases: PipelinePhaseMetrics[];
  /** Map of agent_id -> display name (for UI labels). */
  agentNames: Record<string, string>;
}
