/**
 * PipelineEngine — Unified orchestrator for the full product development pipeline.
 *
 * Phase map:
 *  1  = Discovery (conversation)
 *  2  = PRD Generator mode 1 (auto) — generates stories-requisitos.md
 *  3  = PRD Validator (conversation)
 *  4  = PRD Generator mode 2 (auto) — generates PRD.md
 *  5  = Tech: Database (conversation) — tech-database agent discusses DB decisions
 *  6  = Tech: Backend (conversation) — tech-backend agent discusses backend decisions
 *  7  = Tech: Frontend (conversation) — tech-frontend agent discusses frontend decisions
 *  8  = Tech: Security (conversation) — tech-security agent discusses security decisions
 *  9  = Spec Generation (auto) — builder+validator loop generates SPEC.md from PRD.md + stories-requisitos.md
 * 10  = Spec Enricher (conversation)
 * 11  = Planner (auto)
 * 12  = Sprint Validator (conversation)
 * 13  = Coder (loop)
 * 14  = Evaluator (loop)
 */

import { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../logger';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { setProjectStatus } from '../pipeline-shared/status';
import { persistMessage, persistHarnessRound } from '../pipeline-shared/persist';
import {
  ensureProjectLock,
  releaseProjectLock,
} from '../pipeline-shared/lock';
import { PipelinePausedError } from '../agent-runtime/types';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../ollama-client';
import { executeAgent } from '../agent-runtime';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import {
  type CodexSession,
  CodexAuthError,
  CodexUnavailableError,
  shutdownCodexBridge,
  resetCodexPool,
} from '../codex-bridge';
import {
  getHarnessProject,
  getAgent,
  getDb,
  getPipelinePhaseMessagesAsChatHistory,
  savePipelinePhaseMetrics,
  getHarnessSprints,
  getPipelineMetrics,
  updateHarnessProject,
  updateHarnessSprint,
  deletePipelineMessagesFromPhase,
  deletePipelinePhaseMetricsFromPhase,
  deletePipelineMessagesForSprint,
  deletePipelinePhaseMetricsForSprint,
  deleteHarnessRoundsForSprint,
  resetHarnessSprintStatus,
  deleteHarnessSprintsForProject,
  getHarnessSprintByIndex,
  patchSecuritySummaryJson,
  getSecuritySummaryJson,
} from '../db';
import type { PipelineMetrics } from '../db';
import type { PipelineProject, PipelinePhaseNumber, PhaseDefinition } from '../../../src/types/pipeline';
import type { AgentConfig } from '../../../src/types';
import {
  SECURITY_PIPELINE_PHASES,
  PIPELINE_PHASES,
  FEATURE_PIPELINE_PHASES,
  ARCHITECTURE_REVIEW_PIPELINE_PHASES,
} from '../../../src/types/pipeline';
import { HarnessEngine } from '../harness-engine';
import {
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  SPRINT_VALIDATOR_ID,
  SPEC_ENRICHER_ID,
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
  TECH_DATABASE_ID,
  TECH_BACKEND_ID,
  TECH_FRONTEND_ID,
  TECH_SECURITY_ID,
  RESOLUTION_TRACKER_ID,
  FEAT_DISCOVERY_ID,
  FEAT_PRD_GENERATOR_ID,
  FEAT_PRD_VALIDATOR_ID,
  FEAT_PRD_COMPLETO_ID,
  FEAT_TECH_DATABASE_ID,
  FEAT_TECH_BACKEND_ID,
  FEAT_TECH_FRONTEND_ID,
  FEAT_TECH_SECURITY_ID,
  ARCHITECTURE_MAPPER_ID,
  ARCHITECTURE_TARGET_TRIAGE_ID,
  ARCHITECTURE_DIAGNOSTICIAN_ID,
  ARCHITECTURE_DECISION_INTERVIEWER_ID,
} from '../seed-agents/index';
import { SecurityAuditRunner } from '../security-audit-runner';
import { runRepoProfiler } from '../repo-profiler';
import type { PhaseCallbacks } from '../repo-profiler';
import { parseSecurityFindings } from '../security-findings-parser';
import {
  generatePipelineDocsId,
  getPipelineDocsContext,
  migrateLegacyDocsToFolder,
  findConsolidatedSecurityReport,
  findHarnessSprintsReadPath,
  migrateHarnessSprintsToPipelineDocs,
  resolveHarnessSprintsPath,
  resolvePrdPath,
} from '../pipeline-paths';
import {
  ensureArchitectureReviewContext,
  getArchitectureReviewContext,
  patchArchitectureReviewManifest,
} from '../architecture-review-paths';

const logger = createLogger('pipeline-engine');

/**
 * Returns the model identifier that the agent will actually use at execution
 * time. For codex/local/external runtimes the user-facing `agent.model` field
 * is irrelevant (it's a leftover from when the agent was cloud) — the real
 * model lives in the runtime-specific config block. UI surfaces (badges,
 * footers) should call this so they don't display stale 'opus' / 'sonnet'
 * when a seed agent has been switched to a different runtime.
 */
function resolveModelForAgent(agent: AgentConfig | undefined | null): string | null {
  if (!agent) return null;
  if (agent.runtime === 'codex' && agent.codexConfig?.model) return agent.codexConfig.model;
  if (agent.runtime === 'local' && agent.localConfig?.model) return agent.localConfig.model;
  if (agent.runtime === 'external' && agent.externalConfig?.model) return agent.externalConfig.model;
  return agent.model ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conversation phases in the security pipeline (sendMessage is valid only in these). */
export const SECURITY_CONVERSATION_PHASES = new Set([4, 5, 7, 9]);
export const ARCHITECTURE_CONVERSATION_PHASES = new Set([2, 4, 6, 7, 9]);

/** Conversation phases in the dev/feature pipeline (sendMessage is valid only in these). */
export const DEV_CONVERSATION_PHASES = new Set([1, 3, 5, 6, 7, 8, 9, 10, 12]);

/** Auto-advance phases: these transition to the next phase automatically. */
const AUTO_PHASES = new Set([2, 4, 9, 11]);

/** Loop phases (Coder/Evaluator): only one allowed globally at a time. */
const LOOP_PHASES = new Set([13, 14]);

/** Phases that can be reset by the user. */
const RESETABLE_PHASES = new Set([1, 2, 4, 9, 11, 12]);

// ---------------------------------------------------------------------------
// Security pipeline derived constants
// ---------------------------------------------------------------------------

/** Phases in the security pipeline that auto-advance. */
const SECURITY_AUTO_PHASES = new Set([1, 2, 3, 6, 8]);

/** Loop phases in the security pipeline (Coder=10, Evaluator=11). */
const SECURITY_LOOP_PHASES = new Set([10, 11]);

/** Phases in the security pipeline that can be reset by the user. */
const SECURITY_RESETABLE_PHASES = new Set([1, 2, 3, 6, 8, 9]);

/** Phase number -> human-readable name (security pipeline). */
const SECURITY_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  SECURITY_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

/** Phase number -> agent ID (security pipeline). */
const SECURITY_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  SECURITY_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

/**
 * Artifact map for security pipeline reset.
 * Files paths are relative to project.projectPath.
 */
const SECURITY_PHASE_ARTIFACT_MAP: Record<
  number,
  { files: string[]; fromPhase: number; wipeSprints: boolean }
> = {
  1: { files: ['.lionclaw/manifest.json'], fromPhase: 1, wipeSprints: true },
  2: { files: [], fromPhase: 2, wipeSprints: true },
  3: { files: [], fromPhase: 3, wipeSprints: true },
  6: { files: [], fromPhase: 6, wipeSprints: true },
  8: { files: [], fromPhase: 8, wipeSprints: true },
  9: { files: [], fromPhase: 9, wipeSprints: false },
};

// ---------------------------------------------------------------------------
// Feature pipeline derived constants
// ---------------------------------------------------------------------------

/** Phases in the feature pipeline that auto-advance. */
const FEATURE_AUTO_PHASES = new Set([2, 4, 9, 11]);

/** Loop phases in the feature pipeline (Coder=13, Evaluator=14). */
const FEATURE_LOOP_PHASES = new Set([13, 14]);

/** Phases in the feature pipeline that can be reset by the user. */
const FEATURE_RESETABLE_PHASES = new Set([1, 2, 4, 9, 11, 12]);

/** Phase number -> human-readable name (feature pipeline). */
const FEATURE_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  FEATURE_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

/** Phase number -> agent ID (feature pipeline). */
const FEATURE_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  FEATURE_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

/**
 * Artifact map para reset da feature pipeline.
 * Caminhos de arquivo relativos a project.projectPath.
 * O arquivo feature-discovery-notes tem nome dinamico (timestamp), por isso
 * o reset da fase 1 nao pode deletar o arquivo pelo nome, deleta apenas mensagens do DB.
 */
const FEATURE_PHASE_ARTIFACT_MAP: Record<
  number,
  { files: string[]; fromPhase: number; wipeSprints: boolean }
> = {
  1: { files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'], fromPhase: 1, wipeSprints: true },
  2: { files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'], fromPhase: 2, wipeSprints: true },
  4: { files: ['PRD.md', 'SPEC.md'], fromPhase: 4, wipeSprints: true },
  9: { files: ['SPEC.md'], fromPhase: 9, wipeSprints: true },
  11: { files: [], fromPhase: 11, wipeSprints: true },
  12: { files: [], fromPhase: 12, wipeSprints: false },
};

// ---------------------------------------------------------------------------
// Architecture-review pipeline derived constants
// ---------------------------------------------------------------------------

/** Phases in the architecture-review pipeline that auto-advance. */
const ARCHITECTURE_AUTO_PHASES = new Set([1, 3, 5, 8]);

/** Loop phases in the architecture-review pipeline (Coder=10, Evaluator=11). */
const ARCHITECTURE_LOOP_PHASES = new Set([10, 11]);

/** Phases in the architecture-review pipeline that can be reset by the user. */
const ARCHITECTURE_RESETABLE_PHASES = new Set([1, 2, 3, 4, 5, 8, 9]);

/** Phase number -> human-readable name (architecture-review pipeline). */
const ARCHITECTURE_PHASE_NAMES: Record<number, string> = Object.fromEntries(
  ARCHITECTURE_REVIEW_PIPELINE_PHASES.map((p) => [p.number, p.name]),
);

/** Phase number -> agent ID (architecture-review pipeline). */
const ARCHITECTURE_PHASE_AGENT_IDS: Record<number, string> = Object.fromEntries(
  ARCHITECTURE_REVIEW_PIPELINE_PHASES.map((p) => [p.number, p.agentId]),
);

/**
 * Artifact map for architecture-review pipeline reset (per SPEC §9 reset table).
 * Files are paths *relative to the runDir* — handler do reset combina com
 * `<runDir>` resolvido via `getArchitectureReviewContext`.
 *
 * Convencao: o nome literal aqui e o stem do basename (sem `<runId>`),
 * porque o reset handler interpola `<runId>` real ao apagar.
 *
 * Reset rules:
 *  - Reset fase 1: deleta tudo do runDir (representado por '*' aqui).
 *  - Reset fase N: deleta artefatos de N..MAX (em §9 da SPEC).
 */
const ARCHITECTURE_PHASE_ARTIFACT_MAP: Record<
  number,
  { files: string[]; fromPhase: number; wipeSprints: boolean }
> = {
  1: { files: ['*'],                                                                                                  fromPhase: 1, wipeSprints: true  },
  2: { files: ['ArchitectureCandidates', 'ArchitectureDiagnosis', 'ArchitectureDecisions', 'SPEC', 'sprints'],         fromPhase: 2, wipeSprints: true  },
  3: { files: ['ArchitectureDiagnosis', 'ArchitectureDecisions', 'SPEC', 'sprints'],                                   fromPhase: 3, wipeSprints: true  },
  4: { files: ['ArchitectureDecisions', 'SPEC', 'sprints'],                                                            fromPhase: 4, wipeSprints: true  },
  5: { files: ['SPEC', 'sprints'],                                                                                     fromPhase: 5, wipeSprints: true  },
  8: { files: ['sprints'],                                                                                             fromPhase: 8, wipeSprints: true  },
  9: { files: [],                                                                                                      fromPhase: 9, wipeSprints: false },
};

// ---------------------------------------------------------------------------
// Architecture-review phase 4 — decision validation helpers
// ---------------------------------------------------------------------------

/**
 * Minimo de decisoes "fechadas" pro gate da fase 4 deixar avancar pra SPEC.
 * Veio do prompt do interviewer (heuristica de "cobriu o essencial" >= 3) — mais
 * baixo que isso geralmente indica entrevista atropelada e SPEC pobre adiante.
 */
const ARCHITECTURE_PHASE4_MIN_DECISIONS = 3;

/**
 * Campos obrigatorios em cada secao `## DN`. Labels canonicos vem do prompt
 * do `architecture-decision-interviewer`. Sinonimos abaixo sao tolerantes
 * (variantes acentuadas + traducoes mais comuns) pra evitar false-fail quando
 * o agente diverge ligeiramente do template.
 */
type DecisionField = 'pergunta' | 'decisao' | 'razao' | 'implica';

const DECISION_FIELD_LABEL: Record<DecisionField, string> = {
  pergunta: 'Pergunta',
  decisao:  'Decisao',
  razao:    'Razao',
  implica:  'Implica',
};

const DECISION_FIELD_PATTERNS: Record<DecisionField, RegExp> = {
  // **Pergunta:** ...  /  Pergunta: ...  /  - **Questao:** ... / Question: ...
  pergunta: /^[\s>*-]*\**\s*(?:Pergunta|Questa(?:o|ão)|Question|Quest(?:a|ã)o)\s*:\s*\**\s*\S/im,
  // Decisao / Decisão / Decision / Escolha
  decisao:  /^[\s>*-]*\**\s*(?:Decis(?:a|ã)o|Decision|Escolha|Choice)\s*:\s*\**\s*\S/im,
  // Razao / Razão / Motivo / Justificativa / Reason / Rationale
  razao:    /^[\s>*-]*\**\s*(?:Raz(?:a|ã)o|Motivo|Justificativa|Reason|Rationale)\s*:\s*\**\s*\S/im,
  // Implica / Implicacao / Implicação / Implies / Implication
  implica:  /^[\s>*-]*\**\s*(?:Implica(?:c(?:a|ã)o|tion)?s?|Implies|Consequencia|Consequência)s?\s*:\s*\**\s*\S/im,
};

interface DecisionGap {
  decisionN: number;
  title: string;
  missing: DecisionField[];
}

interface DecisionValidation {
  count: number;
  gaps: DecisionGap[];
}

/**
 * Le decisions.md e devolve {count, gaps}. Gap = decisao com pelo menos 1
 * campo obrigatorio ausente. Caller decide o que fazer com isso (gate).
 *
 * Regex de header: `^##\s*D<N>\s*[—\-:]?\s*<titulo>$` — mesma do
 * `parseDecisionsMd` no renderer (ArchitectureReviewArtifactView).
 */
export function validateDecisionsMd(md: string): DecisionValidation {
  const headerRe = /^##\s*D(\d+)\s*[—\-:]?\s*(.+?)$/gm;
  const matches = Array.from(md.matchAll(headerRe));
  const gaps: DecisionGap[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const n = parseInt(m[1]!, 10);
    const title = (m[2] ?? '').trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? md.length) : md.length;
    const body = md.slice(start, end);

    const missing: DecisionField[] = [];
    (Object.keys(DECISION_FIELD_PATTERNS) as DecisionField[]).forEach((field) => {
      if (!DECISION_FIELD_PATTERNS[field].test(body)) missing.push(field);
    });
    if (missing.length > 0) gaps.push({ decisionN: n, title, missing });
  }

  return { count: matches.length, gaps };
}

// ---------------------------------------------------------------------------
// Dynamic phase resolution helpers
// ---------------------------------------------------------------------------

/**
 * Returns the phase definitions array for the given project.
 * Security projects use SECURITY_PIPELINE_PHASES; feature projects use FEATURE_PIPELINE_PHASES;
 * architecture-review projects use ARCHITECTURE_REVIEW_PIPELINE_PHASES; all others use PIPELINE_PHASES.
 */
function getPhasesForProject(project: { pipelineType?: string }): readonly PhaseDefinition[] {
  if (project.pipelineType === 'security') return SECURITY_PIPELINE_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_PIPELINE_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_REVIEW_PIPELINE_PHASES;
  return PIPELINE_PHASES;
}

/** Returns the auto-advance phase set for the given project. */
function getAutoPhases(project: { pipelineType?: string }): Set<number> {
  if (project.pipelineType === 'security') return SECURITY_AUTO_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_AUTO_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_AUTO_PHASES;
  return AUTO_PHASES;
}

/** Returns the loop phase set for the given project. */
function getLoopPhases(project: { pipelineType?: string }): Set<number> {
  if (project.pipelineType === 'security') return SECURITY_LOOP_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_LOOP_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_LOOP_PHASES;
  return LOOP_PHASES;
}

/** Returns the resetable phase set for the given project. */
function getResetablePhases(project: { pipelineType?: string }): Set<number> {
  if (project.pipelineType === 'security') return SECURITY_RESETABLE_PHASES;
  if (project.pipelineType === 'feature') return FEATURE_RESETABLE_PHASES;
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_RESETABLE_PHASES;
  return RESETABLE_PHASES;
}

/** Returns the human-readable name for a phase in the context of the given project. */
function getPhaseName(phaseNumber: number, project: { pipelineType?: string } | undefined): string | undefined {
  if (!project) return PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'security') return SECURITY_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_NAMES[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_NAMES[phaseNumber];
  return PHASE_NAMES[phaseNumber];
}

/**
 * Resolve a phase number by agentId for the project's pipeline type.
 * Returns undefined if no phase uses that agent.
 *
 * Use this instead of hardcoding phase numbers like `pipelineType === 'security' ? 8 : 11`.
 * Single source of truth: the *_PIPELINE_PHASES arrays in src/types/pipeline.ts.
 */
function getPhaseNumberForAgent(
  project: { pipelineType?: string },
  agentId: string,
): number | undefined {
  return getPhasesForProject(project).find((p) => p.agentId === agentId)?.number;
}

/** Returns the agent ID for a phase in the context of the given project. */
function getPhaseAgentId(phaseNumber: number, project: { pipelineType?: string }): string | undefined {
  if (project.pipelineType === 'security') return SECURITY_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_AGENT_IDS[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_AGENT_IDS[phaseNumber];
  return PHASE_AGENT_IDS[phaseNumber];
}

/** Returns the artifact map entry for a phase in the context of the given project. */
function getPhaseArtifactMap(
  phaseNumber: number,
  project: { pipelineType?: string },
): { files: string[]; fromPhase: number; wipeSprints: boolean } | undefined {
  if (project.pipelineType === 'security') return SECURITY_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'feature') return FEATURE_PHASE_ARTIFACT_MAP[phaseNumber];
  if (project.pipelineType === 'architecture-review') return ARCHITECTURE_PHASE_ARTIFACT_MAP[phaseNumber];
  return PHASE_ARTIFACT_MAP[phaseNumber];
}

/** Returns the maximum phase number for the given project type. */
function getMaxPhase(project: { pipelineType?: string }): number {
  if (project.pipelineType === 'security') return 11;
  if (project.pipelineType === 'architecture-review') return 11;
  // feature and development both end on phase 14
  return 14;
}

/**
 * Mapping from a resetable phase number to the artifact files it produced,
 * the minimum phase_number to delete from the DB tables, and whether all
 * harness_sprints for the project should be wiped.
 *
 * File paths are relative to project.projectPath.
 */
const PHASE_ARTIFACT_MAP: Record<
  number,
  { files: string[]; fromPhase: number; wipeSprints: boolean }
> = {
  1: {
    files: ['discovery-notes.md', 'stories-requisitos.md', 'PRD.md', 'SPEC.md'],
    fromPhase: 1,
    wipeSprints: true,
  },
  2: {
    files: ['stories-requisitos.md', 'PRD.md', 'SPEC.md'],
    fromPhase: 2,
    wipeSprints: true,
  },
  4: {
    files: ['PRD.md', 'SPEC.md'],
    fromPhase: 4,
    wipeSprints: true,
  },
  9: {
    files: ['SPEC.md'],
    fromPhase: 9,
    wipeSprints: true,
  },
  11: {
    files: [],
    fromPhase: 11,
    wipeSprints: true,
  },
  12: {
    files: [],
    fromPhase: 12,
    wipeSprints: false,
  },
};

/** Phase number -> human-readable name. */
const PHASE_NAMES: Record<number, string> = {
  1: 'Discovery',
  2: 'PRD Generator (Modo 1)',
  3: 'PRD Validator',
  4: 'PRD Generator (Modo 2)',
  5: 'Tech: Database',
  6: 'Tech: Backend',
  7: 'Tech: Frontend',
  8: 'Tech: Security',
  9: 'Spec Generation',
  91: 'Spec Generation (Validator)',
  10: 'Spec Enricher',
  11: 'Planner',
  12: 'Sprint Validator',
  13: 'Coder',
  14: 'Evaluator',
};

/** Phase number -> agent id used for that phase. */
const PHASE_AGENT_IDS: Record<number, string> = {
  1: DISCOVERY_AGENT_ID,
  2: PRD_GENERATOR_ID,
  3: PRD_VALIDATOR_ID,
  4: PRD_GENERATOR_ID,
  5: TECH_DATABASE_ID,
  6: TECH_BACKEND_ID,
  7: TECH_FRONTEND_ID,
  8: TECH_SECURITY_ID,
  9: SPEC_BUILDER_ID,
  91: SPEC_VALIDATOR_ID,
  10: SPEC_ENRICHER_ID,
  11: 'harness-planner',
  12: SPRINT_VALIDATOR_ID,
  13: 'harness-coder',
  14: 'harness-evaluator',
};

/** Template for discovery-notes.md created at pipeline start. */
const DISCOVERY_NOTES_TEMPLATE = `# Discovery Notes

## Visao

### Problema
<!-- Qual problema esse produto resolve? -->

### Usuario principal
<!-- Quem eh o usuario principal? -->

### Referencia
<!-- Tem algum produto parecido como referencia? -->

### Pitch
<!-- Pitch do produto validado pelo usuario (2-3 frases) -->

## Funcionalidades

### Core features
<!-- As 3 funcionalidades principais -->

### Integracoes
<!-- Integracoes com sistemas externos -->

## Monetizacao

### Modelo
<!-- Como pretende monetizar? -->

### Planos
<!-- Quantos planos e o que diferencia cada um (se aplicavel) -->

## Tecnico

### Stack
<!-- Preferencias de tecnologia -->

### Plataforma
<!-- Mobile? Web? -->

### Database
<!-- Preferencias de banco de dados -->

### Backend
<!-- Preferencias de backend -->

### Frontend
<!-- Preferencias de frontend -->

### Security
<!-- Requisitos de seguranca -->

## Contexto

### Referencias visuais
<!-- Wireframes, links de Figma, referencias visuais -->

### Notas adicionais
<!-- Qualquer outra informacao relevante -->
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Session state for continue:true phases. */
interface ContinueSessionState {
  /** Whether the SDK session is still alive (continue:true). */
  alive: boolean;
}

/** Internal state for a single project's pipeline execution. */
interface PhaseState {
  projectId: string;
  currentPhase: number;
  status: 'idle' | 'running' | 'paused' | 'aborted';
  abortController: AbortController;
  /** @deprecated Phase 1 blocks removed — kept for compat. */
  discoveryBlock: number;
  /** Conversation phases: SDK session continuity within the phase. */
  continueSessions: Map<string, ContinueSessionState>;
  /**
   * Codex runtime: live CodexSession handles keyed by `${agentId}:${phaseNumber}`.
   * Enables multi-turn continuation within the same phase (D2 in SPEC). Sessions
   * are closed and cleared on phase transition, abort, pause, and reset.
   * Pipeline-engine owns the lifecycle; codex-executor does not close these.
   */
  codexSessions: Map<string, CodexSession>;
  /** Accumulated metrics per phase for incremental saving. */
  phaseMetricAccum: Map<number, SpawnAgentResult['metrics'] & { model: string; runtime: AgentConfig['runtime'] }>;
  /** Phases 13-14: current sprint being executed (0-based index). */
  currentSprintIndex: number;
}

/** Normalized result from spawnAgent(). */
interface SpawnAgentResult {
  output: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
    costUsd: number;
    durationMs: number;
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
  /**
   * Per-turn tool call records (only populated for external runtime).
   * Used to persist full tool history (input + output) so subsequent turns
   * can rehydrate the conversation faithfully. Cloud SDK manages its own
   * session via continueSession and does not populate this field.
   */
  toolCalls?: OllamaToolCallRecord[];
}

/** Options passed to spawnAgent(). */
interface SpawnAgentOptions {
  projectId: string;
  phaseNumber: number;
  cwd: string;
  abortController: AbortController;
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onToolUseComplete?: (toolName: string, input: unknown) => void;
  /** When true, uses continue:true for same-session follow-up turns. */
  continueSession?: boolean;
  /**
   * For external runtime (HTTP stateless): explicit prior conversation history
   * to inject between system prompt and current user prompt. Cloud SDK ignores
   * this and uses continueSession instead. Local runtime currently ignores it.
   */
  priorMessages?: OllamaChatMessage[];
  /**
   * Optional docs directory (from PipelineDocsContext) to inject into the
   * PROJECT ROOT prompt block so agents know where to write pipeline documents.
   */
  docsDir?: string;
  /**
   * When true, the prompt is passed verbatim without prepending PROJECT ROOT
   * boilerplate. Useful for agents whose prompt template already contains
   * filesystem context (e.g. audit agents via buildAuditPrompt).
   */
  skipProjectRootInjection?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: direct SQL update for pipeline columns (not in updateHarnessProject)
// ---------------------------------------------------------------------------

function updateHarnessProjectPipelineColumns(
  projectId: string,
  columns: {
    pipelineCurrentPhase?: number | null;
    pipelineStartPhase?: number | null;
    discoveryNotesPath?: string | null;
    prdPath?: string | null;
    status?: string;
    pipelineSprintIndex?: number;
    pipelineDiscoveryBlock?: number;
  },
): void {
  const db = getDb();
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
  if (columns.discoveryNotesPath !== undefined) {
    fields.push('discovery_notes_path = ?');
    values.push(columns.discoveryNotesPath);
  }
  if (columns.prdPath !== undefined) {
    fields.push('prd_path = ?');
    values.push(columns.prdPath);
  }
  if (columns.status !== undefined) {
    fields.push('status = ?');
    values.push(columns.status);
  }
  if (columns.pipelineSprintIndex !== undefined) {
    fields.push('pipeline_sprint_index = ?');
    values.push(columns.pipelineSprintIndex);
  }
  if (columns.pipelineDiscoveryBlock !== undefined) {
    fields.push('pipeline_discovery_block = ?');
    values.push(columns.pipelineDiscoveryBlock);
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(projectId);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

// ---------------------------------------------------------------------------
// Concurrency: project lock per-project (S4.2 — Onda 4)
//
// O mutex global `_activeLoopProjectId` foi DELETADO. A regra atual e:
//   - 2 pipelines em projetos diferentes: rodam em paralelo livremente
//   - 2 pipelines no MESMO projeto: o segundo bate em `acquireProjectLock`
//     e recebe falha imediata
// Adquire/libera via helpers em `pipeline-shared/lock.ts` (R7 + D4 da SPEC).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

export class PipelineEngine {
  private states: Map<string, PhaseState> = new Map();

  /** HarnessEngine instance reused for phase 11 (Planner). */
  private harnessEngine: HarnessEngine;

  constructor(_getWindow: () => BrowserWindow | null, harnessEngine: HarnessEngine) {
    this.harnessEngine = harnessEngine;
    this.recoverInterruptedPipelines();
  }

  // -------------------------------------------------------------------------
  // Project column updater (BUG-21)
  // -------------------------------------------------------------------------

  /**
   * Writes `columns` to harness_projects and emits `pipeline:project-updated`
   * so the renderer can patch its in-memory `PipelineProject` and keep the
   * status / currentPhase fields in sync.
   *
   * This is the single entry-point every phase/sprint handler must use to
   * mutate the project row. Direct calls to `updateHarnessProjectPipelineColumns`
   * from within PipelineEngine are forbidden: they would silently desync the
   * UI and reintroduce BUG-21 (duplicate "Pausado" + "Processando" badges).
   */
  private updateProjectColumns(
    projectId: string,
    columns: {
      pipelineCurrentPhase?: number | null;
      pipelineStartPhase?: number | null;
      discoveryNotesPath?: string | null;
      prdPath?: string | null;
      status?: PipelineProject['status'];
      pipelineSprintIndex?: number;
      pipelineDiscoveryBlock?: number;
    },
  ): void {
    updateHarnessProjectPipelineColumns(projectId, columns);

    const patch: {
      status?: PipelineProject['status'];
      currentPhase?: PipelinePhaseNumber | null;
    } = {};
    if (columns.status !== undefined) {
      patch.status = columns.status;
    }
    if (columns.pipelineCurrentPhase !== undefined) {
      patch.currentPhase = columns.pipelineCurrentPhase as PipelinePhaseNumber | null;
    }
    if (Object.keys(patch).length > 0) {
      emitIPC('pipeline:project-updated', { projectId, patch });
    }
  }

  // -------------------------------------------------------------------------
  // Phase complete detection
  // -------------------------------------------------------------------------

  private readonly PHASE_COMPLETE_MARKER = '[PHASE_COMPLETE]';

  /**
   * Returns an onText callback that strips [PHASE_COMPLETE] from streamed text,
   * emits pipeline:agent-completed when the marker is found, and forwards
   * cleaned text to the stream IPC channel.
   */
  /**
   * Wraps a task prompt with explicit PROJECT ROOT context. External runtime
   * agents (OpenRouter / openai-compatible) do not have implicit cwd awareness
   * like the Claude SDK and may hallucinate paths to other projects on the
   * filesystem. The Cloud SDK follows enriched prompts gracefully so the same
   * wrapping is safe to apply uniformly.
   *
   * Used together with the path sandbox in local-tool-executor.ts that rejects
   * Read/Write/Edit/Glob/Grep targeting paths outside cwd.
   */
  private withProjectRoot(projectPath: string, taskPrompt: string, docsDir?: string): string {
    return (
      `## PROJECT ROOT (raiz absoluta do projeto onde voce deve operar)\n` +
      `${projectPath}\n\n` +
      (docsDir
        ? `## DOCS DIR (onde voce DEVE gravar todos os documentos desta execucao)\n${docsDir}\n\n`
        : '') +
      `## REGRAS CRITICAS DE FILESYSTEM\n` +
      `- TODOS os paths em Read, Write, Edit, Glob e Grep DEVEM ser absolutos comecando com PROJECT ROOT acima.\n` +
      (docsDir
        ? `- TODA gravacao de documento (PRD, SPEC, stories, etc) DEVE ir para DOCS DIR acima.\n`
        : '') +
      `- NUNCA leia, escreva ou liste arquivos fora dessa raiz. Tentativas serao rejeitadas com erro.\n` +
      `- Se o prompt referenciar um caminho relativo, prefixe com PROJECT ROOT.\n\n` +
      `## TAREFA\n` +
      taskPrompt
    );
  }

  private makeConversationOnText(
    projectId: string,
    phase: number,
    accumulatedRef: { text: string; completed: boolean },
  ): (chunk: string) => void {
    return (chunk: string) => {
      const combined = accumulatedRef.text + chunk;
      accumulatedRef.text = combined;

      if (!accumulatedRef.completed && combined.includes(this.PHASE_COMPLETE_MARKER)) {
        accumulatedRef.completed = true;
        emitIPC('pipeline:agent-completed', { projectId });
        logger.info({ projectId, phase }, 'Agent signaled PHASE_COMPLETE');
      }

      const cleaned = chunk.replace(this.PHASE_COMPLETE_MARKER, '');
      if (cleaned.length > 0) {
        emitIPC('pipeline:stream', { projectId, phase, type: 'text', content: cleaned });
      }
    };
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private getState(projectId: string): PhaseState {
    if (!this.states.has(projectId)) {
      // Rehydrate from DB on cold start (e.g. after app restart). If the DB has
      // a persisted pipeline_current_phase, we restore it in-memory so that
      // approvePhase / sendMessage can correctly route to the right phase
      // handler even when the Electron main process was just restarted.
      //
      // NOTE: continueSessions (SDK session continuity) cannot be rehydrated,
      // so any ongoing conversation starts a fresh SDK session on the next
      // user message. approvePhase does not depend on continueSessions.
      let persistedPhase = 0;
      let persistedStatus: PhaseState['status'] = 'idle';
      let persistedSprintIndex = 0;
      try {
        const project = getHarnessProject(projectId);
        if (project) {
          persistedPhase = project.pipelineCurrentPhase ?? 0;
          // Map DB status to in-memory status. DB 'running' becomes in-memory
          // 'paused' because the main process was just restarted and nothing
          // is actually executing. 'done'/'failed' collapse to 'idle'.
          if (project.status === 'paused' || project.status === 'running') {
            persistedStatus = 'paused';
          } else {
            persistedStatus = 'idle';
          }
          persistedSprintIndex = project.pipelineSprintIndex ?? 0;
        }
      } catch (err) {
        logger.warn({ err, projectId }, 'getState: failed to rehydrate from DB, using defaults');
      }

      this.states.set(projectId, {
        projectId,
        currentPhase: persistedPhase,
        status: persistedStatus,
        abortController: new AbortController(),
        discoveryBlock: 1,
        continueSessions: new Map(),
        codexSessions: new Map(),
        phaseMetricAccum: new Map(),
        currentSprintIndex: persistedSprintIndex,
      });
    }
    return this.states.get(projectId)!;
  }

  private isConversationPhase(phase: number, project?: { pipelineType?: string }): boolean {
    if (project) {
      return !getAutoPhases(project).has(phase) && !getLoopPhases(project).has(phase);
    }
    return !AUTO_PHASES.has(phase) && !LOOP_PHASES.has(phase);
  }

  // -------------------------------------------------------------------------
  // Crash recovery: on boot, mark any 'running' pipelines as 'interrupted'
  // -------------------------------------------------------------------------

  private recoverInterruptedPipelines(): void {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT id FROM harness_projects WHERE status = 'running' AND pipeline_current_phase IS NOT NULL`,
      ).all() as { id: string }[];

      for (const row of rows) {
        logger.warn({ projectId: row.id }, 'Recovering interrupted pipeline — marking as interrupted');
        // S4.2: libera lock orfao (RAM-only, mas em re-init da PipelineEngine
        // dentro do mesmo process — se houver — e tambem por simetria com a
        // semantica de recovery on boot do D4 da SPEC).
        releaseProjectLock(row.id);
        // S3 (Onda 3): pos-V48 the CHECK constraint accepts 'interrupted'.
        // Pre-V48 we wrote 'paused' but emitted 'interrupted' over IPC — gambiarra.
        // Now the persisted status equals the truth so DB and UI agree.
        setProjectStatus(row.id, 'interrupted');
        emitIPC('pipeline:phase-changed', {
          projectId: row.id,
          phase: null,
          status: 'interrupted',
          awaitingUser: true,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to recover interrupted pipelines');
    }
  }

  // -------------------------------------------------------------------------
  // Public API: startPipeline
  // -------------------------------------------------------------------------

  async startPipeline(projectId: string, startPhase: number): Promise<{ error: string } | void> {
    const existingState = this.states.get(projectId);
    if (existingState && existingState.status === 'running') {
      logger.warn({ projectId }, 'startPipeline: pipeline ja esta rodando para este projeto, ignorando');
      return { error: 'Pipeline ja esta rodando para este projeto' };
    }

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Lazy migration: feature/security projects without pipelineDocsId gain a new ID
    // and their legacy root-level docs are moved into docs/Docs<id>/
    if (
      (project.pipelineType === 'feature' || project.pipelineType === 'security') &&
      !project.pipelineDocsId
    ) {
      const newId = generatePipelineDocsId();
      const result = migrateLegacyDocsToFolder(project.projectPath, newId);
      const ctx = getPipelineDocsContext(project.projectPath, newId);
      const updates: Record<string, unknown> = { pipelineDocsId: newId };
      if (ctx) {
        if (project.specPath && project.specPath.endsWith('/SPEC.md')) {
          updates['specPath'] = ctx.resolveDocPath('SPEC.md');
        }
        if (project.prdPath && project.prdPath.endsWith('/PRD.md')) {
          updates['prdPath'] = ctx.resolveDocPath('PRD.md');
        }
        if (project.sprintsJsonPath && project.sprintsJsonPath.endsWith('/sprints.json')) {
          const sprintsMigration = migrateHarnessSprintsToPipelineDocs(project, newId);
          updates['sprintsJsonPath'] = sprintsMigration.pathToPersist;
          logger.info(
            { projectId, newDocsId: newId, sprintsMigration },
            'Lazy migration for sprints JSON to docs/Docs<id>/ folder applied',
          );
        }
      }
      updateHarnessProject(projectId, updates as never);
      logger.info(
        { projectId, newDocsId: newId, migrated: result.migrated, errors: result.errors },
        'Lazy migration to docs/Docs<id>/ folder applied',
      );
    }

    logger.info({ projectId, startPhase }, 'Starting pipeline');

    const state = this.getState(projectId);
    state.abortController = new AbortController();
    state.currentPhase = startPhase;
    state.status = 'running';

    // If starting from phase 1, create discovery-notes.md template
    if (startPhase === 1) {
      const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
      const notesPath = docsCtx
        ? docsCtx.resolveDocPath('discovery.md')
        : path.join(project.projectPath, 'discovery-notes.md');
      if (!fs.existsSync(notesPath)) {
        fs.mkdirSync(docsCtx ? docsCtx.docsDir : project.projectPath, { recursive: true });
        fs.writeFileSync(notesPath, DISCOVERY_NOTES_TEMPLATE, 'utf-8');
        logger.info({ notesPath }, 'Created discovery-notes.md template');
      }
      this.updateProjectColumns(projectId, {
        discoveryNotesPath: notesPath,
      });
    }

    // Persist phase pointers
    this.updateProjectColumns(projectId, {
      pipelineStartPhase: startPhase,
      pipelineCurrentPhase: startPhase,
      status: 'running',
    });

    // Emit phase-changed for the first phase
    const firstPhaseIsConversation = this.isConversationPhase(startPhase, project);
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: startPhase,
      phaseName: getPhaseName(startPhase, project) ?? `Phase ${startPhase}`,
      status: 'started',
      awaitingUser: firstPhaseIsConversation,
      currentModel: this.resolveCurrentModelForPhase(project, startPhase),
    });

    // Auto phases start immediately; conversation phases auto-send greeting
    if (getAutoPhases(project).has(startPhase)) {
      await this.runAutoPhase(projectId, startPhase);
    } else if (firstPhaseIsConversation) {
      // Auto-trigger the first AI message so the agent starts the conversation
      // (e.g. Discovery asks questions, Spec Validator starts analysis, etc.)
      const greetingMsg = this.getConversationGreeting(startPhase, project.name, project);
      await this.sendMessage(projectId, greetingMsg);
    }
    // Loop phases require explicit advancePhase call in normal flow
  }

  /**
   * Returns an initial user-side message to kick off a conversation phase.
   * The agent will then respond with its questions / analysis.
   * Accepts an optional project to handle security pipeline phases.
   */
  private getConversationGreeting(phase: number, projectName: string, project?: { pipelineType?: string }): string {
    // Security pipeline conversation phases
    if (project?.pipelineType === 'security') {
      switch (phase) {
        case 4:
          // Skeptic Security: validates which findings are genuine security issues
          return (
            `Projeto "${projectName}". Se apresente brevemente como o Validador Cetico de Seguranca, ` +
            `explique que vai revisar o relatorio com ceticismo focado em seguranca (falsos positivos, ` +
            `priorizacao por impacto de negocio, quais corrigir ja vs deferir) e comece a analise. ` +
            `Ao final, peca ao usuario confirmacao ou ajustes antes de avancar para o Skeptic Quality.`
          );
        case 5:
          // Skeptic Quality: validates quality/coverage of the (already skeptic-security-reviewed) report
          return (
            `Projeto "${projectName}". Se apresente brevemente como o Validador Cetico de Qualidade, ` +
            `explique que o Skeptic Security ja revisou os findings e voce agora foca em qualidade: ` +
            `informacoes suficientes para implementar, gaps de cobertura, qualidade das solucoes. ` +
            `Ao final, peca ao usuario confirmacao ou ajustes antes de avancar para geracao de SPEC.`
          );
        case 7:
          return (
            `Projeto "${projectName}". Se apresente brevemente como o enriquecedor de SPEC de seguranca, ` +
            `explique que vai analisar a spec de correcoes buscando gaps, edge cases e melhorias, ` +
            `e comece a analise.`
          );
        case 9:
          return (
            `Projeto "${projectName}". Se apresente brevemente como o validador de sprints, ` +
            `explique que vai revisar o plano de sprints verificando coerencia e completude, ` +
            `e comece a revisao.`
          );
        default:
          return `Inicie a fase ${phase} do projeto "${projectName}".`;
      }
    }

    // Feature pipeline conversation phases
    if (project?.pipelineType === 'feature') {
      if (phase === 1) {
        return (
          `Projeto "${projectName}" (feature em repositorio existente). ` +
          `Se apresente de forma breve como o Feature Discovery Agent. ` +
          `Antes de qualquer pergunta, faca a analise inicial obrigatoria do repositorio: ` +
          `verifique se existe CLAUDE.md (gere se nao existir), identifique a stack e a estrutura, ` +
          `e leia os arquivos chave para entender as convencoes do projeto. ` +
          `Em seguida, conduza uma conversa exploratoria livre sobre a feature que o usuario quer construir, ` +
          `aprofundando em escopo, integracao com o codigo existente, edge cases e impacto. ` +
          `NAO use o roteiro de 11 perguntas do Discovery padrao (esse pipeline e para projetos do zero, nao para features). ` +
          `Ao final, gere um feature-discovery-notes-{timestamp}.md com tudo o que foi conversado.`
        );
      }
      // Other feature conversation phases (PRD Validator, Tech, etc) reuse the development greetings below.
      // Phase 2 is auto for both dev and feature pipelines (no greeting).
    }

    // Development pipeline conversation phases (original behavior)
    switch (phase) {
      case 1:
        return (
          `Estou iniciando o projeto "${projectName}". ` +
          `Se apresente de forma breve e amigavel, explique que voce vai conduzir o Discovery ` +
          `fazendo 11 perguntas divididas em 5 blocos (Visao, Funcionalidades, Monetizacao, Tecnico e Contexto), ` +
          `e ja faca a primeira pergunta (Q1).`
        );
      case 3:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o validador de PRD, ` +
          `explique que vai analisar o documento em busca de gaps e inconsistencias, ` +
          `e comece a analise.`
        );
      case 5:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o especialista em Database, ` +
          `explique que vai conduzir as decisoes tecnicas de banco de dados para o projeto, ` +
          `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre as escolhas de database. ` +
          `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
        );
      case 6:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o especialista em Backend, ` +
          `explique que vai conduzir as decisoes tecnicas de backend para o projeto, ` +
          `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre a arquitetura e stack de backend. ` +
          `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
        );
      case 7:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o especialista em Frontend, ` +
          `explique que vai conduzir as decisoes tecnicas de frontend para o projeto, ` +
          `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre a stack e abordagem de frontend. ` +
          `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
        );
      case 8:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o especialista em Security, ` +
          `explique que vai conduzir as decisoes tecnicas de seguranca para o projeto, ` +
          `leia o stories-requisitos.md e o PRD.md, e comece a discussao sobre requisitos e estrategias de seguranca. ` +
          `Quando o usuario confirmar as decisoes com APROVAR, a fase esta concluida.`
        );
      case 10:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o enriquecedor de SPEC, ` +
          `explique que vai analisar a spec buscando gaps, edge cases e melhorias, ` +
          `e comece a analise.`
        );
      case 12:
        return (
          `Projeto "${projectName}". Se apresente brevemente como o validador de sprints, ` +
          `explique que vai revisar o plano de sprints verificando coerencia e completude, ` +
          `e comece a revisao.`
        );
      default:
        return `Inicie a fase ${phase} do projeto "${projectName}".`;
    }
  }

  // -------------------------------------------------------------------------
  // Public API: advancePhase
  // -------------------------------------------------------------------------

  async advancePhase(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'Cannot advance aborted pipeline');
      return;
    }

    // Feature pipeline: quando a fase 1 eh aprovada, detecta o arquivo feature-discovery-notes
    // gerado pelo agente feat-discovery e persiste o caminho para as fases seguintes localizarem.
    const advancingProject = getHarnessProject(projectId);
    if (advancingProject?.pipelineType === 'feature' && state.currentPhase === 1) {
      try {
        const projectPath = advancingProject.projectPath;
        if (projectPath && fs.existsSync(projectPath)) {
          const docsCtx = getPipelineDocsContext(projectPath, advancingProject.pipelineDocsId ?? null);
          // Search in docsDir first (new path), then fall back to projectPath root (legacy)
          const searchDir = docsCtx ? docsCtx.docsDir : projectPath;
          const matches = fs.existsSync(searchDir)
            ? fs
                .readdirSync(searchDir)
                .filter((f) => f.startsWith('feature-discovery-notes-') && f.endsWith('.md'))
                .sort()
                .reverse()
            : [];
          if (matches.length > 0) {
            const notesPath = path.join(searchDir, matches[0]);
            this.updateProjectColumns(projectId, { discoveryNotesPath: notesPath });
            logger.info({ projectId, notesPath }, 'Detected feature-discovery-notes path');
          } else {
            // Also check docsCtx canonical path
            if (docsCtx) {
              const canonicalPath = docsCtx.resolveDocPath('discovery.md');
              if (fs.existsSync(canonicalPath)) {
                this.updateProjectColumns(projectId, { discoveryNotesPath: canonicalPath });
                logger.info({ projectId, notesPath: canonicalPath }, 'Detected feature-discovery-notes path (canonical)');
              } else {
                logger.warn({ projectId, projectPath }, 'No feature-discovery-notes-*.md file found after phase 1');
              }
            } else {
              logger.warn({ projectId, projectPath }, 'No feature-discovery-notes-*.md file found in projectPath after phase 1');
            }
          }
        }
      } catch (err) {
        logger.warn({ err, projectId }, 'Failed to detect feature-discovery-notes path');
      }
    }

    const project = getHarnessProject(projectId);
    const maxPhase = project ? getMaxPhase(project) : 14;

    const nextPhase = state.currentPhase + 1;
    if (nextPhase > maxPhase) {
      logger.info({ projectId }, 'Pipeline complete — no more phases');
      // Pipeline finished successfully — kill all codex processes.
      this.closeCodexSessions(state);
      this.updateProjectColumns(projectId, {
        status: 'done',
        pipelineCurrentPhase: null,
      });
      // S4.2: terminal state (done) — libera lock per-projeto.
      releaseProjectLock(projectId);
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'completed',
        awaitingUser: false,
      });
      return;
    }

    logger.info({ projectId, nextPhase }, 'Advancing pipeline to next phase');

    // Note: codex sessions are NOT killed on phase transition. Idle codex processes
    // don't consume rate-limit, and keeping them alive avoids re-spawning between
    // phases. Cleanup happens only when status becomes 'done' (pipeline complete)
    // or 'aborted' (abortPipeline).

    state.currentPhase = nextPhase;
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: nextPhase,
      status: 'running',
    });

    const isConversation = this.isConversationPhase(nextPhase, project ?? undefined);
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: nextPhase,
      phaseName: (project ? getPhaseName(nextPhase, project) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`,
      status: 'started',
      awaitingUser: isConversation,
      currentModel: project ? this.resolveCurrentModelForPhase(project, nextPhase) : null,
    });

    const autoPhases = project ? getAutoPhases(project) : AUTO_PHASES;
    const loopPhases = project ? getLoopPhases(project) : LOOP_PHASES;

    if (autoPhases.has(nextPhase)) {
      await this.runAutoPhase(projectId, nextPhase);
    } else if (loopPhases.has(nextPhase)) {
      // S4.2: o lock ja foi adquirido em pipeline:start. ensureProjectLock e
      // idempotente — no-op pra esse projeto. Pipelines de OUTROS projetos podem
      // rodar loop phases em paralelo (cross-project livre per R7/D4).
      ensureProjectLock(projectId, 'pipeline-engine');
      // Loop phases are managed externally (HarnessEngine). Emit that we are ready.
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: nextPhase,
        phaseName: (project ? getPhaseName(nextPhase, project) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`,
        status: 'loop-ready',
        awaitingUser: false,
        currentModel: project ? this.resolveCurrentModelForPhase(project, nextPhase) : null,
      });
    }
    // Conversation phases: awaitingUser already emitted above
  }

  // -------------------------------------------------------------------------
  // Public API: abortPipeline
  // -------------------------------------------------------------------------

  abortPipeline(projectId: string): void {
    const state = this.getState(projectId);
    logger.info({ projectId, currentPhase: state.currentPhase }, 'Aborting pipeline');

    state.abortController.abort();
    state.status = 'aborted';

    // If in a loop phase, the HarnessEngine has its own AbortController inside
    // runSingleSprint that is NOT signaled by aborting the pipeline controller.
    // We must explicitly abort the harness engine to actually stop the Coder/Evaluator.
    {
      const abortProject = getHarnessProject(projectId);
      const loopSet = abortProject ? getLoopPhases(abortProject) : LOOP_PHASES;
      if (state.currentPhase !== null && loopSet.has(state.currentPhase)) {
        try {
          this.harnessEngine.abort(projectId);
        } catch (err) {
          logger.warn({ err, projectId }, 'harnessEngine.abort during abort failed (non-fatal)');
        }
      }
    }

    // S4.2: lock per-projeto liberado em transicao terminal (aborted).
    releaseProjectLock(projectId);

    // Close any live Codex sessions so processes are not leaked.
    this.closeCodexSessions(state);

    // S3 (Onda 3): persist the truth — user aborted intentionally, this is
    // NOT a failure. Pre-V48 the CHECK rejected 'aborted' so we wrote 'failed'
    // and emitted 'aborted' over IPC (gambiarra). Pos-V48 the CHECK accepts
    // 'aborted' so DB and UI now agree.
    setProjectStatus(projectId, 'aborted');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: state.currentPhase,
      status: 'aborted',
      awaitingUser: false,
    });
  }

  // -------------------------------------------------------------------------
  // Public API: pausePipeline
  // -------------------------------------------------------------------------

  pausePipeline(projectId: string): void {
    const state = this.getState(projectId);
    logger.info({ projectId, currentPhase: state.currentPhase }, 'Pausing pipeline');

    // Step 1: abort the running agent immediately
    if (!state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    const phase = state.currentPhase;

    // Step 1b: if in a loop phase (Coder/Evaluator), the HarnessEngine runs with its
    // OWN AbortController created inside runSingleSprint. The pipeline controller has
    // no effect there — we must explicitly abort the harness engine to actually stop
    // the running Coder/Evaluator.
    const pauseProject = getHarnessProject(projectId);
    const pauseLoopSet = pauseProject ? getLoopPhases(pauseProject) : LOOP_PHASES;
    const pauseAutoSet = pauseProject ? getAutoPhases(pauseProject) : AUTO_PHASES;

    if (phase !== null && pauseLoopSet.has(phase)) {
      try {
        this.harnessEngine.abort(projectId);
      } catch (err) {
        logger.warn({ err, projectId }, 'harnessEngine.abort during pause failed (non-fatal)');
      }
    }

    // Step 2: mark current auto-phase metrics as interrupted
    if (phase !== null && pauseAutoSet.has(phase)) {
      const phaseName = (pauseProject ? getPhaseName(phase, pauseProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`;
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: phase,
        phaseName,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      });
    }

    // Step 3: mark current sprint round as interrupted for loop phases
    if (phase !== null && pauseLoopSet.has(phase)) {
      const sprintIndex = state.currentSprintIndex ?? 0;
      const sprints = getHarnessSprints(projectId);
      const sprint = sprints[sprintIndex];
      if (sprint) {
        const db = getDb();
        // Mark the most recent in-progress round for this sprint as interrupted
        // (no verdict = aborted mid-run)
        const roundRow = db.prepare(
          `SELECT id FROM harness_rounds
           WHERE sprint_id = ?
             AND (completed_at IS NULL OR completed_at = '')
           ORDER BY round_number DESC
           LIMIT 1`,
        ).get(sprint.id) as { id: string } | undefined;
        if (roundRow) {
          persistHarnessRound.update(roundRow.id, {
            completedAt: new Date().toISOString(),
          });
          logger.info({ projectId, sprintIndex, roundId: roundRow.id }, 'Marked in-progress round as interrupted');
        }
      }
    }

    // Step 4: set status in memory and DB
    state.status = 'paused';
    setProjectStatus(projectId, 'paused');

    // Note: codex sessions are NOT killed on pause. The user may resume; idle codex
    // processes are harmless. Cleanup happens only on status='done' or status='aborted'.

    // Step 5: emit paused event — awaitingUser: false (paused is NOT waiting for input)
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      status: 'paused',
      awaitingUser: false,
    });
  }

  // -------------------------------------------------------------------------
  // Public API: resumePipeline
  // -------------------------------------------------------------------------

  async resumePipeline(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'Cannot resume aborted pipeline');
      return;
    }

    if (state.status === 'running') {
      logger.warn({ projectId }, 'Pipeline already running, ignoring duplicate resume');
      return;
    }

    // Hydrate currentPhase and additional state fields from DB if state was lost (app restart)
    if (state.currentPhase === 0) {
      const project = getHarnessProject(projectId);
      if (project?.pipelineCurrentPhase && project.pipelineCurrentPhase > 0) {
        state.currentPhase = project.pipelineCurrentPhase;
        state.currentSprintIndex = project.pipelineSprintIndex ?? 0;
        state.discoveryBlock = project.pipelineDiscoveryBlock ?? 1;
        logger.info(
          {
            projectId,
            restoredPhase: state.currentPhase,
            sprintIndex: state.currentSprintIndex,
          },
          'Restored pipeline state from DB after app restart',
        );
      } else {
        logger.warn({ projectId }, 'Cannot resume pipeline: no phase found in DB');
        return;
      }
    }

    logger.info({ projectId, currentPhase: state.currentPhase }, 'Resuming pipeline');

    const phase = state.currentPhase;
    const resumeProject = getHarnessProject(projectId);
    const isConversation = this.isConversationPhase(phase, resumeProject ?? undefined);

    // BUG-20 fix: Conversation phases have no background work to resume.
    // They are driven by user input (chat messages) and advance via approval.
    // Flipping status to 'running' here made the pipeline appear active while
    // nothing was actually happening, and subsequent clicks hit the
    // 'already running' guard. Instead, stay in 'paused' and just re-emit the
    // phase-changed event so the frontend can reidentar awaitingUser state.
    if (isConversation) {
      logger.info(
        { projectId, phase },
        'Resume no-op on conversation phase: awaiting user input (BUG-20)',
      );
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase,
        phaseName: (resumeProject ? getPhaseName(phase, resumeProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`,
        status: 'awaiting-input',
        awaitingUser: true,
      });
      return;
    }

    state.status = 'running';
    state.abortController = new AbortController();
    setProjectStatus(projectId, 'running');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName: (resumeProject ? getPhaseName(phase, resumeProject) : PHASE_NAMES[phase]) ?? `Phase ${phase}`,
      status: 'resumed',
      awaitingUser: false,
    });

    const resumeAutoSet = resumeProject ? getAutoPhases(resumeProject) : AUTO_PHASES;
    const resumeLoopSet = resumeProject ? getLoopPhases(resumeProject) : LOOP_PHASES;

    if (resumeAutoSet.has(phase)) {
      await this.runAutoPhase(projectId, phase);
    } else if (resumeLoopSet.has(phase)) {
      // Resume loop phase: restart from the current sprint index
      const sprintIndex = state.currentSprintIndex ?? 0;
      logger.info({ projectId, phase, sprintIndex }, 'Resuming loop phase via runSprint');
      await this.runSprint(projectId, sprintIndex);
    }
  }

  // -------------------------------------------------------------------------
  // Public API: resumeAfterAuth — called when user re-logs into Codex CLI
  // and wants to continue a paused pipeline that stopped due to CodexAuthError.
  //
  // Flow (SPEC §12.3, §12.4):
  // 1. Verify auth is back via isCodexAvailable().
  // 2. Kill all bridge processes so the next call re-spawns with fresh auth.json.
  // 3. Clear stale codexSessions (they hold dead thread IDs).
  // 4. Delegate to the existing resumePipeline() which handles auto/loop/convo.
  // -------------------------------------------------------------------------

  async resumeAfterAuth(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const { isCodexAvailable } = await import('../codex-bridge');
    const status = await isCodexAvailable();
    if (!status.authenticated) {
      return { ok: false, message: 'Codex ainda nao autenticado. Rode `codex login` e tente novamente.' };
    }

    logger.info({ projectId }, 'resumeAfterAuth: auth verified, respawning bridge');

    // Kill all live bridge processes. The next createCodexSession call will
    // lazy-spawn fresh processes that read the updated auth.json (SPEC §12.1 caveat).
    await shutdownCodexBridge();

    // Clear stale codex sessions — thread IDs from the old process are invalid.
    const state = this.getState(projectId);
    this.closeCodexSessions(state);

    // Reset abort controller in case it was aborted when the auth error hit.
    state.abortController = new AbortController();
    state.status = 'paused'; // resumePipeline expects paused

    logger.info({ projectId }, 'resumeAfterAuth: resuming pipeline');
    await this.resumePipeline(projectId);

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Private: spawnAgent — thin wrapper that injects PROJECT ROOT context
  // and delegates to the unified agent-runtime module (executeAgent).
  //
  // All runtime-specific logic (cloud/local/external) lives in:
  //   electron/main/agent-runtime/{cloud,local,external}-executor.ts
  // The watchdog is also centralised there (agent-runtime/watchdog.ts).
  // -------------------------------------------------------------------------

  public async spawnAgent(
    agentId: string,
    rawPrompt: string,
    opts: SpawnAgentOptions,
  ): Promise<SpawnAgentResult> {
    // Inject PROJECT ROOT explicitly so external runtime agents (no implicit cwd)
    // cannot wander outside the project. Skip when caller already embedded
    // filesystem context (e.g. audit agents via buildAuditPrompt).
    const prompt = opts.skipProjectRootInjection
      ? rawPrompt
      : this.withProjectRoot(opts.cwd, rawPrompt, opts.docsDir);

    // Codex session reuse: look up an existing CodexSession for this agent+phase
    // when continueSession=true, so the executor calls reply() instead of send().
    const state = this.states.get(opts.projectId);
    const codexSessionKey = `${agentId}:${opts.phaseNumber}`;
    const existingCodexSession = (opts.continueSession && state)
      ? state.codexSessions.get(codexSessionKey)
      : undefined;

    // NOTE: do NOT close other cached codex sessions here.
    // The security audit pipeline spawns up to 3 codex agents IN PARALLEL via
    // Promise.all. Closing "all other sessions" on each new spawn would race-kill
    // those concurrent siblings mid-execution. Cleanup of stale sessions happens
    // at deterministic transition hooks (closePhaseCodexSessions, advancePhase,
    // sprint round boundaries) — never as a side-effect of spawnAgent.

    try {
      const result = await executeAgent({
        agentId,
        prompt,
        cwd: opts.cwd,
        abortController: opts.abortController,
        permission: PERM_BYPASS_NO_GUARD,
        continueSession: opts.continueSession,
        priorMessages: opts.priorMessages,
        // S4.3 (Onda 4): propaga projectId pra codex-executor isolar pool por projeto.
        projectId: opts.projectId,
        onText: opts.onText,
        onToolUse: opts.onToolUse,
        onToolUseComplete: opts.onToolUseComplete,
        // Pass existing session for multi-turn reuse (codex only; ignored by other runtimes).
        codexSession: existingCodexSession,
        // When creating a new session, store it in the phase state for future turns.
        onCodexSessionCreated: state
          ? (session: CodexSession) => {
              state.codexSessions.set(codexSessionKey, session);
              logger.debug(
                { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId },
                'spawnAgent: new CodexSession stored for phase',
              );
            }
          : undefined,
        // pipeline:stalled IPC stays here — agent-runtime emits only a generic onStalled callback.
        onStalled: (info) => {
          logger.warn(
            { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, ...info },
            'spawnAgent: agent stalled — no progress for 3min',
          );
          emitIPC('pipeline:stalled', {
            projectId: opts.projectId,
            phase: opts.phaseNumber,
            agentId,
            ...info,
          });
        },
      });

      logger.info(
        { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, durationMs: result.metrics.durationMs, outputLen: result.output.length, toolUses: result.metrics.toolUses },
        'spawnAgent: completed',
      );

      return result;
    } catch (err) {
      // Codex auth error: pause pipeline and notify frontend with a modal trigger.
      // Do NOT rethrow — the pipeline remains paused, waiting for user to re-login.
      if (err instanceof CodexAuthError) {
        logger.warn(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: (err as Error).message },
          'spawnAgent: CodexAuthError — pausing pipeline',
        );
        emitIPC('pipeline:auth-required', {
          projectId: opts.projectId,
          phaseNumber: opts.phaseNumber,
          agentId,
          message: (err as Error).message,
        });
        // S3 (Onda 3): persist 'paused' via setProjectStatus and throw
        // PipelinePausedError so the calling phase short-circuits cleanly.
        // Replaces the pre-S3 "zeroed sentinel" return that silently
        // hid CodexAuthError from callers and produced bogus zero metrics.
        setProjectStatus(opts.projectId, 'paused');
        if (state) state.status = 'paused';
        throw new PipelinePausedError(
          (err as Error).message || 'Codex auth required',
          'codex-auth',
        );
      }

      // Codex unavailable: emit pipeline:error event and rethrow so the pipeline
      // marks the phase as failed (D8 — no fallback).
      if (err instanceof CodexUnavailableError) {
        logger.error(
          { agentId, phaseNumber: opts.phaseNumber, projectId: opts.projectId, message: (err as Error).message },
          'spawnAgent: CodexUnavailableError — pipeline will fail',
        );
        emitIPC('pipeline:error', {
          projectId: opts.projectId,
          phase: opts.phaseNumber,
          title: 'CODEX FALHOU',
          detail: (err as Error).message,
          error: (err as Error).message,
        });
        throw err;
      }

      // All other errors propagate normally.
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private: closeCodexSessions — close and clear all live Codex sessions
  // for the given project state. Called on phase transition, abort, pause,
  // and reset so sessions are never leaked across phase boundaries (D2).
  // -------------------------------------------------------------------------

  private closeCodexSessions(state: PhaseState): void {
    if (state.codexSessions.size === 0) {
      // Even when no sessions are tracked in this state, force a pool reset
      // on phase transitions so any leftover codex processes from previous
      // runs get killed. SPEC D2: fresh state per phase.
      // S4.3 (Onda 4): reset escopado pelo projeto pra nao matar slots de outros
      // projetos rodando em paralelo (R7/D8).
      resetCodexPool(state.projectId);
      return;
    }
    logger.debug(
      { projectId: state.projectId, count: state.codexSessions.size },
      'Closing Codex sessions for phase transition',
    );
    for (const session of state.codexSessions.values()) {
      try {
        session.close();
      } catch (err) {
        logger.warn({ err, projectId: state.projectId }, 'Error closing CodexSession (non-fatal)');
      }
    }
    state.codexSessions.clear();
    // Belt-and-suspenders: ensure codex pool processes deste projeto sao mortos
    // pra que a proxima fase sempre comece com filhos recem-spawned. session.close()
    // ja mata o processo do slot quando ocioso, mas um reset forcado cobre edge
    // cases (race conditions, estado acumulado).
    // S4.3: escopado por projectId — nao afeta pipelines de outros projetos.
    resetCodexPool(state.projectId);
  }

  // -------------------------------------------------------------------------
  // Private: collectMetrics — save phase metrics to DB
  // -------------------------------------------------------------------------

  private collectMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    result: SpawnAgentResult,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
  ): void {
    const phaseNameStr = (projectCtx ? getPhaseName(phaseNumber, projectCtx) : PHASE_NAMES[phaseNumber]) ?? `Phase ${phaseNumber}`;
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName: phaseNameStr,
      agentId,
      status,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      cacheCreationTokens: result.metrics.cacheCreationTokens,
      costUsd: result.metrics.costUsd,
      durationMs: result.metrics.durationMs,
      toolUses: result.metrics.toolUses,
      apiRequests: result.metrics.apiRequests,
      model: result.model,
      runtime: result.runtime,
      completedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber,
      metrics: result.metrics,
      model: result.model,
      runtime: result.runtime,
    });
  }

  // -------------------------------------------------------------------------
  // Private: runAutoPhase — routes to correct phase handler for dev or security
  // -------------------------------------------------------------------------

  async runAutoPhase(projectId: string, phaseNumber: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const agentId = getPhaseAgentId(phaseNumber, project) ?? 'unknown';
    const phaseName = getPhaseName(phaseNumber, project) ?? `Phase ${phaseNumber}`;
    const state = this.getState(projectId);

    logger.info({ projectId, phaseNumber, phaseName, agentId, pipelineType: project.pipelineType }, 'Running auto phase');

    // BUG-21: force project.status='running' and currentPhase at entry so that
    // when resetPhase / approvePhase kicks this off in the background, the
    // frontend cannot linger on status='paused'. updateProjectColumns emits
    // pipeline:project-updated so the UI patches the project immediately.
    this.updateProjectColumns(projectId, {
      status: 'running',
      pipelineCurrentPhase: phaseNumber,
    });

    // Create initial metrics row with status 'running'
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName,
      agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: phaseNumber,
      phaseName,
      status: 'running',
      awaitingUser: false,
      currentModel: this.resolveCurrentModelForPhase(project, phaseNumber),
    });

    try {
      // ---- Architecture-review pipeline dispatch ----
      if (project.pipelineType === 'architecture-review') {
        if (phaseNumber === 1) {
          await this.runArchitecturePhase1Map(projectId, project, state);
        } else if (phaseNumber === 3) {
          await this.runArchitecturePhase3Diagnosis(projectId, project, state);
        } else if (phaseNumber === 5) {
          await this.runArchitecturePhase5Spec(projectId, project, state);
        } else if (phaseNumber === 8) {
          await this.runPhase11(projectId, state); // Planner: shared agent across pipelines
        } else {
          throw new Error(`Unknown architecture-review auto phase: ${phaseNumber}`);
        }
      } else if (project.pipelineType === 'security') {
        if (phaseNumber === 1) {
          await this.runSecurityPhase1(projectId, project.projectPath, state);
        } else if (phaseNumber === 2) {
          await this.runSecurityPhase2(projectId, project, state);
        } else if (phaseNumber === 3) {
          await this.runSecurityPhase3(projectId, project.projectPath, state);
        } else if (phaseNumber === 6) {
          await this.runSecurityPhase6(projectId, project, state);
        } else if (phaseNumber === 8) {
          await this.runPhase11(projectId, state); // Planner is the same in both pipelines
        } else {
          throw new Error(`Unknown security auto phase: ${phaseNumber}`);
        }
      } else {
        const isFeature = project.pipelineType === 'feature';
        // Development / Feature pipeline dispatch.
        // Feature pipeline reuses runPhase9/runPhase11 (shared agents) but has
        // its own runPhase4Feature for PRD Completo using FEAT_PRD_COMPLETO_ID.
        // Phase 2 only reaches this dispatch in dev pipeline (feature has it as conversation).
        if (phaseNumber === 2) {
          if (isFeature) {
            await this.runPhase2Feature(projectId, project.projectPath, state);
          } else {
            await this.runPhase2(projectId, project.projectPath, state);
          }
        } else if (phaseNumber === 4) {
          if (isFeature) {
            await this.runPhase4Feature(projectId, project.projectPath, state);
          } else {
            await this.runPhase4(projectId, project.projectPath, state);
          }
        } else if (phaseNumber === 9) {
          await this.runPhase9(projectId);
        } else if (phaseNumber === 11) {
          await this.runPhase11(projectId, state);
        } else {
          throw new Error(`Unknown auto phase: ${phaseNumber}`);
        }
      }
    } catch (err) {
      // S3 (Onda 3): PipelinePausedError signals an EXPECTED pause (codex-auth,
      // user-abort). spawnAgent already persisted status + emitted the user-facing
      // IPC; the phase just stops here without recording it as a failure.
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phaseNumber, reason: err.reason },
          'Auto phase paused (PipelinePausedError) — short-circuiting',
        );
        savePipelinePhaseMetrics({
          projectId,
          phaseNumber,
          phaseName,
          agentId,
          status: 'interrupted',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId, phaseNumber }, 'Auto phase aborted');
        savePipelinePhaseMetrics({
          projectId,
          phaseNumber,
          phaseName,
          agentId,
          status: 'interrupted',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      const errorMsg = (err as Error).message;
      logger.error({ err, projectId, phaseNumber }, 'Auto phase failed');

      savePipelinePhaseMetrics({
        projectId,
        phaseNumber,
        phaseName,
        agentId,
        status: 'failed',
        completedAt: new Date().toISOString(),
      });

      setProjectStatus(projectId, 'paused');
      state.status = 'paused';

      emitIPC('pipeline:error', { projectId, phase: phaseNumber, error: errorMsg });
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: phaseNumber,
        phaseName,
        status: 'failed',
        awaitingUser: true,
      });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: PRD Generator mode 1 — user stories and requirements
  // -------------------------------------------------------------------------

  private async runPhase2(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    const project2 = getHarnessProject(projectId);
    const docsCtx = getPipelineDocsContext(projectPath, project2?.pipelineDocsId ?? null);
    const discoveryNotesPath = docsCtx
      ? docsCtx.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md');
    const storiesPath = docsCtx
      ? docsCtx.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');

    if (!fs.existsSync(discoveryNotesPath)) {
      throw new Error(`discovery-notes.md not found at ${discoveryNotesPath}`);
    }

    const prompt =
      `Leia ${discoveryNotesPath}. ` +
      `Gere user stories, requisitos funcionais (RF) e requisitos nao-funcionais (RNF) detalhados a partir das notas de discovery. ` +
      `Salve o resultado em ${storiesPath}.`;

    let phase2Output = '';
    const result = await this.spawnAgent(PRD_GENERATOR_ID, prompt, {
      projectId,
      phaseNumber: 2,
      cwd: projectPath,
      abortController: state.abortController,
      docsDir: docsCtx?.docsDir,
      onText: (chunk) => {
        phase2Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'tool_call', tool: toolName });
      },
    });

    // Save complete assistant message (not per-chunk)
    if (phase2Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', phase2Output);
    }

    this.collectMetrics(projectId, 2, PRD_GENERATOR_ID, result, 'completed');

    logger.info({ projectId, storiesPath }, 'Phase 2 completed — stories-requisitos.md generated');

    if (fs.existsSync(storiesPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: storiesPath,
        content: fs.readFileSync(storiesPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 2,
      phaseName: PHASE_NAMES[2],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to phase 3 (conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Phase 4: PRD Generator mode 2 — full PRD document
  // -------------------------------------------------------------------------

  private async runPhase4(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    const project4 = getHarnessProject(projectId);
    const docsCtx = getPipelineDocsContext(projectPath, project4?.pipelineDocsId ?? null);
    const discoveryNotesPath = docsCtx
      ? docsCtx.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md');
    const storiesPath = docsCtx
      ? docsCtx.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const prdPath = docsCtx
      ? docsCtx.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md');

    if (!fs.existsSync(discoveryNotesPath)) {
      throw new Error(`discovery-notes.md not found at ${discoveryNotesPath}`);
    }

    const prompt =
      `Leia ${discoveryNotesPath} para contexto do discovery e ${storiesPath} para as user stories e requisitos aprovados. ` +
      `Gere o documento PRD completo com resumo executivo, personas, user stories, requisitos funcionais, ` +
      `requisitos nao-funcionais, metricas de sucesso, escopo negativo e dependencias/riscos. ` +
      `Salve em ${prdPath}.`;

    let phase4Output = '';
    const result = await this.spawnAgent(PRD_GENERATOR_ID, prompt, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      docsDir: docsCtx?.docsDir,
      onText: (chunk) => {
        phase4Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 4, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    // Save complete assistant message (not per-chunk)
    if (phase4Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', phase4Output);
    }

    this.collectMetrics(projectId, 4, PRD_GENERATOR_ID, result, 'completed');

    // Persist PRD path in DB
    this.updateProjectColumns(projectId, { prdPath });

    logger.info({ projectId, prdPath }, 'Phase 4 completed — PRD.md generated');

    if (fs.existsSync(prdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: prdPath,
        content: fs.readFileSync(prdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 4,
      phaseName: PHASE_NAMES[4],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to phase 5 (conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Phase 2 (FEATURE pipeline only): PRD Generator (auto) via FEAT_PRD_GENERATOR_ID.
  //
  // Mirrors runPhase2 (dev pipeline) but uses the feature-specific agent and
  // the feature-discovery-notes file detected at the end of phase 1. Agent
  // analyses the existing repo + notes and writes stories-requisitos.md.
  // -------------------------------------------------------------------------

  private async runPhase2Feature(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    const docsCtxF2 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
    const notesPath = (project?.discoveryNotesPath || (docsCtxF2
      ? docsCtxF2.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md')));
    const storiesPath = docsCtxF2
      ? docsCtxF2.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');

    if (!fs.existsSync(notesPath)) {
      throw new Error(`Feature notes not found at ${notesPath}`);
    }

    const prompt =
      `Leia ${notesPath}. ` +
      `Analise o codigo existente do projeto (cwd: ${projectPath}) usando Glob, Grep e Read para entender ` +
      `componentes, modulos e patterns relevantes para a feature. ` +
      `Gere user stories, requisitos funcionais (RF) e requisitos nao-funcionais (RNF) detalhados, ` +
      `referenciando arquivos e modulos existentes quando aplicavel. ` +
      `Salve o resultado em ${storiesPath}.`;

    let phase2Output = '';
    const result = await this.spawnAgent(FEAT_PRD_GENERATOR_ID, prompt, {
      projectId,
      phaseNumber: 2,
      cwd: projectPath,
      abortController: state.abortController,
      docsDir: docsCtxF2?.docsDir,
      onText: (chunk) => {
        phase2Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'tool_call', tool: toolName });
      },
    });

    if (phase2Output || (result.toolCalls && result.toolCalls.length > 0)) {
      persistMessage(
        { kind: 'pipeline', projectId, phaseNumber: 2 },
        'assistant',
        phase2Output,
        { toolCalls: result.toolCalls },
      );
    }

    this.collectMetrics(projectId, 2, FEAT_PRD_GENERATOR_ID, result, 'completed');

    logger.info({ projectId, storiesPath }, 'Phase 2 (feature) completed — stories-requisitos.md generated');

    if (fs.existsSync(storiesPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: storiesPath,
        content: fs.readFileSync(storiesPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 2,
      phaseName: getPhaseName(2, project ?? undefined) ?? 'PRD Generator',
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Phase 4 (FEATURE pipeline only): PRD Completo via FEAT_PRD_COMPLETO_ID.
  //
  // Mirrors runPhase4 but uses the feature-specific agent and the feature
  // discovery notes file (feature-discovery-notes-{timestamp}.md) detected
  // and persisted by the feature pipeline at the end of phase 1.
  // -------------------------------------------------------------------------

  private async runPhase4Feature(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    const docsCtxF4 = getPipelineDocsContext(projectPath, project?.pipelineDocsId ?? null);
    const notesPath = (project?.discoveryNotesPath || (docsCtxF4
      ? docsCtxF4.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md')));
    const storiesPath = docsCtxF4
      ? docsCtxF4.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const prdPath = docsCtxF4
      ? docsCtxF4.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md');

    if (!fs.existsSync(notesPath)) {
      throw new Error(`Feature notes not found at ${notesPath}`);
    }

    const prompt =
      `Leia ${notesPath} para contexto da feature e ${storiesPath} para as user stories e requisitos aprovados. ` +
      `Gere o documento PRD completo da feature com resumo executivo, integracao com codigo existente, ` +
      `user stories, requisitos funcionais, requisitos nao-funcionais, metricas de sucesso, escopo negativo, ` +
      `dependencias e riscos. Salve em ${prdPath}.`;

    let phase4Output = '';
    const result = await this.spawnAgent(FEAT_PRD_COMPLETO_ID, prompt, {
      projectId,
      phaseNumber: 4,
      cwd: projectPath,
      abortController: state.abortController,
      docsDir: docsCtxF4?.docsDir,
      onText: (chunk) => {
        phase4Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 4, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    if (phase4Output || (result.toolCalls && result.toolCalls.length > 0)) {
      persistMessage(
        { kind: 'pipeline', projectId, phaseNumber: 4 },
        'assistant',
        phase4Output,
        { toolCalls: result.toolCalls },
      );
    }

    this.collectMetrics(projectId, 4, FEAT_PRD_COMPLETO_ID, result, 'completed');

    this.updateProjectColumns(projectId, { prdPath });

    logger.info({ projectId, prdPath }, 'Phase 4 (feature) completed — PRD.md generated');

    if (fs.existsSync(prdPath)) {
      emitIPC('pipeline:document-updated', {
        projectId,
        path: prdPath,
        content: fs.readFileSync(prdPath, 'utf-8'),
      });
    }

    emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 4,
      phaseName: getPhaseName(4, project ?? undefined) ?? 'PRD Completo',
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Phase 11: Planner — delegates to HarnessEngine.plan()
  // -------------------------------------------------------------------------

  private async runPhase11(
    projectId: string,
    state: PhaseState,
  ): Promise<void> {
    const startedAt = Date.now();

    // Fallback: patch empty agent IDs on existing projects created before the fix
    const projectBeforePlan = getHarnessProject(projectId);
    if (projectBeforePlan) {
      const cfg = projectBeforePlan.config;
      let needsPatch = false;
      if (!cfg.plannerAgentId) {
        cfg.plannerAgentId = 'harness-planner';
        needsPatch = true;
      }
      if (!cfg.evaluatorAgentId) {
        cfg.evaluatorAgentId = 'harness-evaluator';
        needsPatch = true;
      }
      if (needsPatch) {
        logger.warn({ projectId }, 'Patching empty planner/evaluator agent IDs on existing project');
        updateHarnessProject(projectId, { config: cfg });
      }
    }

    // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream.
    // Phase number resolved via PIPELINE_PHASES (security=8, dev/feature=11) — nao hardcodar.
    const bridgeProject = getHarnessProject(projectId);
    const bridgePhase = (bridgeProject ? getPhaseNumberForAgent(bridgeProject, 'harness-planner') : undefined) ?? 11;
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as { projectId?: string; event?: { type?: string; content?: string; tool?: string } };
        if (d.projectId !== projectId || !d.event?.type) return;
        if (d.event.type === 'text' && d.event.content) {
          emitIPC('pipeline:stream', { projectId, phase: bridgePhase, type: 'text', content: d.event.content });
        } else if ((d.event.type === 'tool_use' || d.event.type === 'tool_call') && d.event.tool) {
          emitIPC('pipeline:stream', { projectId, phase: bridgePhase, type: 'tool_call', tool: d.event.tool });
        } else if (d.event.type === 'thinking') {
          emitIPC('pipeline:stream', { projectId, phase: bridgePhase, type: 'thinking' });
        }
      }
    });

    await this.harnessEngine.plan(projectId);

    // Clear bridge
    this.harnessEngine.clearStreamBridge();

    if (state.abortController.signal.aborted) {
      return;
    }

    const durationMs = Date.now() - startedAt;

    // Collect basic metrics for Planner phase (works for both dev phase 11 and security phase 8)
    const project = getHarnessProject(projectId);
    const plannerPhaseNumber = (project ? getPhaseNumberForAgent(project, 'harness-planner') : undefined) ?? 11;
    const plannerPhaseName = (project ? getPhaseName(plannerPhaseNumber, project) : PHASE_NAMES[11]) ?? `Phase ${plannerPhaseNumber}`;
    const plannerMetrics = {
      inputTokens: project?.plannerInputTokens ?? 0,
      outputTokens: project?.plannerOutputTokens ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 1,
      costUsd: project?.plannerCostUsd ?? 0,
      durationMs: project?.plannerDurationMs ?? durationMs,
    };

    const plannerAgentId = (project ? getPhaseAgentId(plannerPhaseNumber, project) : PHASE_AGENT_IDS[11]) ?? 'harness-planner';
    const plannerAgentRecord = getAgent(plannerAgentId);
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: plannerPhaseNumber,
      phaseName: plannerPhaseName,
      agentId: plannerAgentId,
      status: 'completed',
      inputTokens: plannerMetrics.inputTokens,
      outputTokens: plannerMetrics.outputTokens,
      cacheReadTokens: plannerMetrics.cacheReadTokens,
      cacheCreationTokens: plannerMetrics.cacheCreationTokens,
      costUsd: plannerMetrics.costUsd,
      durationMs: plannerMetrics.durationMs,
      toolUses: plannerMetrics.toolUses,
      apiRequests: plannerMetrics.apiRequests,
      model: plannerAgentRecord?.model ?? undefined,
      runtime: plannerAgentRecord?.runtime ?? 'cloud',
      completedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber: plannerPhaseNumber,
      metrics: plannerMetrics,
    });

    logger.info({ projectId, plannerPhaseNumber }, 'Planner phase completed');

    // Emit sprints data so UI can populate the sprint list when entering the Sprint Validator phase
    const sprintsAfterPlan = getHarnessSprints(projectId);
    emitIPC('pipeline:sprints-loaded', {
      projectId,
      sprints: sprintsAfterPlan.map((s, i) => ({
        index: i,
        name: s.name,
        status: s.status,
        coderAgentId: s.coderAgentId,
        evaluatorAgentId: s.evaluatorAgentId,
        sprintJsonId: s.sprintJsonId,
        sprintId: s.id,
      })),
    });

    const projectAfterPlan = getHarnessProject(projectId);
    if (projectAfterPlan) {
      const sprintsJsonPath = findHarnessSprintsReadPath(projectAfterPlan);
      if (sprintsJsonPath) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: sprintsJsonPath,
          content: fs.readFileSync(sprintsJsonPath, 'utf-8'),
        });
      }
    }

    emitIPC('pipeline:stream', { projectId, phase: plannerPhaseNumber, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: plannerPhaseNumber,
      phaseName: plannerPhaseName,
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to next phase (Sprint Validator conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Private: advanceToNextPhase — internal auto-advance helper
  // -------------------------------------------------------------------------

  private async advanceToNextPhase(projectId: string, state: PhaseState): Promise<void> {
    if (state.abortController.signal.aborted || state.status === 'aborted') {
      return;
    }

    const advProject = getHarnessProject(projectId);
    const maxPhase = advProject ? getMaxPhase(advProject) : 14;

    const nextPhase = state.currentPhase + 1;
    if (nextPhase > maxPhase) {
      this.closeCodexSessions(state);
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      // S4.2: terminal state (done) — libera lock per-projeto.
      releaseProjectLock(projectId);
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
      });
      return;
    }

    // Note: codex sessions are NOT killed on phase transition. Idle processes
    // don't consume rate-limit. Cleanup happens only at status='done' / 'aborted'.

    state.currentPhase = nextPhase;
    state.status = 'running';
    // BUG-20 fix: advanceToNextPhase must sanitize project.status in the DB.
    // Previously it only updated pipelineCurrentPhase, so a stale 'paused'
    // (e.g. from recoverInterruptedPipelines after an app restart) would
    // remain in the DB. That left the frontend with isPaused=true and a
    // locked chat input even though the pipeline had just started a fresh
    // conversation phase and the agent was actively awaiting input.
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: nextPhase,
      status: 'running',
    });

    const isConversation = this.isConversationPhase(nextPhase, advProject ?? undefined);
    const nextPhaseName = (advProject ? getPhaseName(nextPhase, advProject) : PHASE_NAMES[nextPhase]) ?? `Phase ${nextPhase}`;

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: nextPhase,
      phaseName: nextPhaseName,
      status: 'started',
      awaitingUser: isConversation,
    });

    const advAutoSet = advProject ? getAutoPhases(advProject) : AUTO_PHASES;
    const advLoopSet = advProject ? getLoopPhases(advProject) : LOOP_PHASES;

    if (advAutoSet.has(nextPhase)) {
      // Consecutive auto phases chain automatically
      await this.runAutoPhase(projectId, nextPhase);
    } else if (advLoopSet.has(nextPhase)) {
      // Loop phases: auto-start the sprint from the current sprint index
      const sprintIndex = state.currentSprintIndex ?? 0;
      logger.info({ projectId, nextPhase, sprintIndex }, 'Auto-starting loop phase via runSprint');
      await this.runSprint(projectId, sprintIndex);
    } else if (isConversation) {
      // Auto-trigger the first AI message so the agent starts the conversation
      const greetingMsg = this.getConversationGreeting(nextPhase, advProject?.name ?? projectId, advProject ?? undefined);
      await this.sendMessage(projectId, greetingMsg);
    }
  }

  // -------------------------------------------------------------------------
  // Public API: sendMessage — routes to active conversation phase handler
  // -------------------------------------------------------------------------

  async sendMessage(
    projectId: string,
    message: string,
    attachments?: Array<{ id: string; type: string; filename: string; mimeType: string; data: string; size: number }>,
  ): Promise<{ error: string } | void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'sendMessage: pipeline aborted');
      return;
    }

    const phase = state.currentPhase;

    // Auto-resume if the previous run aborted (pause) but the user is sending a
    // new message. Without this, spawnAgent would inherit the already-aborted
    // controller and throw AbortError immediately — the catch below swallows
    // that and the frontend never gets a 'done' event, leaving isStreaming stuck.
    if (state.abortController.signal.aborted) {
      state.abortController = new AbortController();
      state.status = 'running';
      setProjectStatus(projectId, 'running');
      logger.info({ projectId, phase }, 'sendMessage: auto-resuming from paused state');
    }

    // Process attachments: write base64 data to temp files and prepend path refs
    let finalMessage = message;
    if (attachments && attachments.length > 0) {
      const mediaRefs: string[] = [];
      for (const att of attachments) {
        if (att.type === 'image') {
          const ext = att.mimeType.split('/')[1] || 'png';
          const tmpPath = path.join(os.tmpdir(), `lionclaw-pipeline-img-${Date.now()}-${att.id}.${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
          mediaRefs.push(`[Imagem: ${tmpPath}]`);
        } else if (att.type === 'audio') {
          const ext = att.mimeType.split('/')[1] || 'webm';
          const tmpPath = path.join(os.tmpdir(), `lionclaw-pipeline-audio-${Date.now()}-${att.id}.${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
          mediaRefs.push(`[Audio: ${tmpPath}]`);
        }
      }
      if (mediaRefs.length > 0) {
        const refs = mediaRefs.join('\n');
        finalMessage = `${refs}\n\n${message || 'O usuario enviou midia. Use a ferramenta Read para visualizar e responda sobre o conteudo.'}`;
      }
    }

    // Resolve project type for routing
    const msgProject = getHarnessProject(projectId);
    const isSecurity = msgProject?.pipelineType === 'security';

    // Validate that the current phase accepts manual messages (reject auto-phases).
    if (phase !== null) {
      const conversationPhases =
        msgProject?.pipelineType === 'architecture-review'
          ? ARCHITECTURE_CONVERSATION_PHASES
          : isSecurity
            ? SECURITY_CONVERSATION_PHASES
            : DEV_CONVERSATION_PHASES;
      if (!conversationPhases.has(phase)) {
        logger.warn({ projectId, phase }, 'sendMessage: rejected — auto-phase');
        emitIPC('pipeline:stream', {
          projectId,
          phase,
          type: 'error',
          message: 'Esta fase nao aceita mensagens manuais (auto-phase). Aguarde o agente terminar.',
        });
        return { error: 'Auto-phase nao aceita mensagens manuais' };
      }
    }

    // Save user message (original text, not the path-enriched version)
    persistMessage({ kind: 'pipeline', projectId, phaseNumber: phase }, 'user', message);

    // Emit thinking indicator immediately so the UI shows processing state
    emitIPC('pipeline:stream', { projectId, phase, type: 'thinking' });

    try {
      const isArchitectureReviewMsg = msgProject?.pipelineType === 'architecture-review';
      if (isArchitectureReviewMsg) {
        // Architecture-review pipeline conversation phase routing
        switch (phase) {
          case 2:
            await this.handleArchitecturePhase2TriageMessage(projectId, finalMessage, state, msgProject!);
            break;
          case 4:
            await this.handleArchitecturePhase4DecisionMessage(projectId, finalMessage, state, msgProject!);
            break;
          case 6:
            await this.handleArchitecturePhase6SpecValidationMessage(projectId, finalMessage, state, msgProject!);
            break;
          case 7:
            await this.handleArchitecturePhase7SpecEnricherMessage(projectId, finalMessage, state, msgProject!);
            break;
          case 9:
            await this.handlePhase12Message(projectId, finalMessage, state, 9); // Sprint Validator shared, phaseNumber=9 in architecture-review
            break;
          default:
            logger.warn({ projectId, phase }, 'sendMessage: no architecture-review handler for this phase');
        }
      } else if (isSecurity) {
        // Security pipeline conversation phase routing
        switch (phase) {
          case 4:
            await this.handleSecurityPhase4Message(projectId, finalMessage, state, msgProject!);
            break;
          case 5:
            await this.handleSecurityPhase5Message(projectId, finalMessage, state, msgProject!);
            break;
          case 7:
            await this.handleSecurityPhase7Message(projectId, finalMessage, state, msgProject!);
            break;
          case 9:
            await this.handleSecurityPhase9Message(projectId, finalMessage, state, msgProject!);
            break;
          default:
            logger.warn({ projectId, phase }, 'sendMessage: no security handler for this phase');
        }
      } else {
        const isFeature = msgProject?.pipelineType === 'feature';
        // Development / Feature pipeline conversation phase routing.
        // Feature pipeline reuses the same handlers but with feat-* agent IDs.
        switch (phase) {
          case 1:
            await this.handlePhase1Message(projectId, finalMessage, state);
            break;
          case 3:
            await this.handlePhase3Message(projectId, finalMessage, state);
            break;
          case 5:
            await this.handleTechPhaseMessage(projectId, finalMessage, state, 5, isFeature ? FEAT_TECH_DATABASE_ID : TECH_DATABASE_ID);
            break;
          case 6:
            await this.handleTechPhaseMessage(projectId, finalMessage, state, 6, isFeature ? FEAT_TECH_BACKEND_ID : TECH_BACKEND_ID);
            break;
          case 7:
            await this.handleTechPhaseMessage(projectId, finalMessage, state, 7, isFeature ? FEAT_TECH_FRONTEND_ID : TECH_FRONTEND_ID);
            break;
          case 8:
            await this.handleTechPhaseMessage(projectId, finalMessage, state, 8, isFeature ? FEAT_TECH_SECURITY_ID : TECH_SECURITY_ID);
            break;
          case 9:
            await this.handlePhase9Message(projectId, finalMessage, state);
            break;
          case 10:
            await this.handlePhase10Message(projectId, finalMessage, state);
            break;
          case 12:
            await this.handlePhase12Message(projectId, finalMessage, state);
            break;
          default:
            logger.warn({ projectId, phase }, 'sendMessage: no handler for this phase');
        }
      }
    } catch (err) {
      // S3 (Onda 3): expected pause — spawnAgent already persisted state and
      // emitted the user-facing IPC. Just close the stream gracefully.
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phase, reason: err.reason },
          'sendMessage: PipelinePausedError — short-circuiting',
        );
        emitIPC('pipeline:stream', { projectId, phase, type: 'done' });
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        // Always emit 'done' on abort so the frontend unlocks isStreaming.
        // Previously we returned silently, leaving the UI stuck on "Processando".
        emitIPC('pipeline:stream', { projectId, phase, type: 'done' });
        return;
      }
      logger.error({ err, projectId, phase }, 'sendMessage: error');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
      emitIPC('pipeline:stream', { projectId, phase, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Public API: approvePhase — user clicked "Decidido" / "Aprovar"
  // -------------------------------------------------------------------------

  async approvePhase(projectId: string, metadata?: Record<string, unknown>): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'approvePhase: pipeline aborted');
      return;
    }

    const phase = state.currentPhase;
    const approveProject = getHarnessProject(projectId);
    const isSecurity = approveProject?.pipelineType === 'security';
    const isArchitectureReview = approveProject?.pipelineType === 'architecture-review';

    try {
      // ----------------------------------------------------------------
      // Architecture Review pipeline approval routing
      // ----------------------------------------------------------------
      if (isArchitectureReview) {
        // Conversation phases per ARCHITECTURE_REVIEW_PIPELINE_PHASES:
        //   2 (Triagem),  4 (Decisao),  6 (SpecValidation),  7 (SpecEnricher),  9 (SprintValidator)
        //
        // Phase 2 has a special payload: { selectedCandidateId } — must be
        // validated against the JSON of candidates and persisted before advancing.
        if (phase === 2) {
          const selectedCandidateId = metadata?.['selectedCandidateId'];
          if (typeof selectedCandidateId !== 'string' || selectedCandidateId.length === 0) {
            const errMsg = 'pipeline:approve fase 2 (architecture-review) requer { selectedCandidateId: string }';
            logger.warn({ projectId, phase, metadata }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          // Validate the candidate exists in the JSON.
          const ctx = approveProject ? getArchitectureReviewContext(approveProject) : null;
          if (!ctx) {
            throw new Error('architecture-review context not found — cannot validate candidate');
          }
          if (!fs.existsSync(ctx.candidatesJsonPath)) {
            throw new Error(`Candidates JSON not found at ${ctx.candidatesJsonPath}`);
          }
          let candidates: Array<{ id?: string }> = [];
          try {
            const parsed = JSON.parse(fs.readFileSync(ctx.candidatesJsonPath, 'utf-8'));
            candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
          } catch (err) {
            throw new Error(`Invalid candidates JSON: ${(err as Error).message}`);
          }
          if (!candidates.some((c) => c.id === selectedCandidateId)) {
            const errMsg = `invalid candidate id "${selectedCandidateId}" — not found in candidates JSON`;
            logger.warn({ projectId, selectedCandidateId, knownIds: candidates.map((c) => c.id) }, errMsg);
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          // Persist in BOTH the DB config and the manifest.
          // ORDER: DB first (more failure modes — locks, constraints), manifest after.
          // If DB throws, manifest is untouched and the user can retry approve. If manifest
          // throws after DB succeeds, the DB is the source of truth (manifest is rebuilt
          // from project.config on the next read via getArchitectureReviewContext).
          updateHarnessProject(projectId, {
            config: {
              ...approveProject.config,
              architectureReview: {
                ...(approveProject.config.architectureReview ?? {}),
                selectedCandidateId,
              },
            },
          });
          patchArchitectureReviewManifest(approveProject, {
            selectedCandidateId,
          });
          // Fase 3 (Diagnosis) é auto com opus — pode rodar 5-10min via spawnAgent.
          // Se awaitassemos finalizeConversationPhase aqui, o IPC `pipeline:approve`
          // ficaria bloqueado pelo tempo todo do Diagnosis — o user clica "Atacar este alvo"
          // e fica vendo "Aprovando..." por minutos achando que travou.
          // Solução: persistência já feita acima (síncrono), advance roda em background.
          // O frontend recebe pipeline:phase-changed events conforme a fase 3 progride.
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 4) {
          // Phase 4 (Decision Interview) gate: precisa de >=N decisoes "fechadas"
          // (## DN com Pergunta + Decisao + Razao + Implica). Mensagem de erro
          // detalhada permite o usuario corrigir manualmente ou pedir ao agente
          // pra completar a decisao incompleta antes de tentar avancar de novo.
          const ctx = approveProject ? getArchitectureReviewContext(approveProject) : null;
          if (!ctx) {
            throw new Error('architecture-review context not found — cannot validate decisions');
          }
          if (!fs.existsSync(ctx.decisionsMdPath)) {
            const errMsg = `A entrevista ainda nao tem decisoes registradas. Registre pelo menos ${ARCHITECTURE_PHASE4_MIN_DECISIONS} decisoes (D1/D2/D3) com Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          const decisionsContent = fs.readFileSync(ctx.decisionsMdPath, 'utf-8');
          const validation = validateDecisionsMd(decisionsContent);
          if (validation.count < ARCHITECTURE_PHASE4_MIN_DECISIONS) {
            const errMsg = `A entrevista ainda nao tem decisoes suficientes (atual: ${validation.count}, minimo: ${ARCHITECTURE_PHASE4_MIN_DECISIONS}). Registre pelo menos ${ARCHITECTURE_PHASE4_MIN_DECISIONS} decisoes (D1/D2/D3) com Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          if (validation.gaps.length > 0) {
            const detalhes = validation.gaps
              .map((g) => `D${g.decisionN}${g.title ? ` (${g.title})` : ''}: falta ${g.missing.map((f) => DECISION_FIELD_LABEL[f]).join(', ')}`)
              .join('; ');
            const errMsg = `Decisoes incompletas: ${detalhes}. Cada decisao precisa ter Pergunta, Decisao, Razao e Implica antes de gerar a SPEC.`;
            emitIPC('pipeline:error', { projectId, phase, error: errMsg });
            throw new Error(errMsg);
          }
          // Fase 5 (Spec Generation) é auto opus — também roda em background.
          this.runFinalizeInBackground(projectId, phase, state, approveProject ?? undefined);
        } else if (phase === 6 || phase === 7 || phase === 9) {
          // Fase 7 e 9 vão para conversation/loop sem auto longo no meio.
          // Fase 6 vai para fase 7 (conversation) — também rápido.
          await this.finalizeConversationPhase(projectId, phase, state, approveProject ?? undefined);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no architecture-review handler for this phase');
        }
      } else if (isSecurity) {
        // Security pipeline conversation phases: 4 (Skeptic Security), 5 (Skeptic Quality),
        // 7 (SPEC Enricher), 9 (Sprint Validator).
        if (phase === 4 || phase === 5 || phase === 7 || phase === 9) {
          // Write Site 2: after the second skeptic (phase 5) is approved, re-parse the
          // consolidated Security file to capture confirmedFindings and removedByValidator.
          if (phase === 5 && approveProject) {
            const projectPath = (approveProject as { projectPath: string }).projectPath;
            const securityDir = path.join(projectPath, '.lionclaw', 'Security');
            const consolidatedFiles = fs.existsSync(securityDir)
              ? fs.readdirSync(securityDir).filter((f) => /^Security-\d{8}-\d{4}\.md$/.test(f)).sort()
              : [];
            const securityReportPath = consolidatedFiles.length > 0
              ? path.join(securityDir, consolidatedFiles[consolidatedFiles.length - 1]!)
              : null;
            if (securityReportPath) {
              try {
                const reParsed = parseSecurityFindings(securityReportPath);
                const existingSummary = getSecuritySummaryJson(projectId);
                const originalTotal = existingSummary?.totalFindings ?? reParsed.total;
                patchSecuritySummaryJson(projectId, {
                  bySeverity: reParsed.bySeverity,
                  confirmedFindings: reParsed.total,
                  removedByValidator: Math.max(0, originalTotal - reParsed.total),
                });
                logger.info(
                  { projectId, confirmed: reParsed.total, removed: originalTotal - reParsed.total },
                  'SecuritySummary: confirmedFindings + removedByValidator written after phase 5 approval',
                );
              } catch (err) {
                logger.warn({ err, projectId }, 'SecuritySummary: failed to re-parse findings after phase 5, skipping');
              }
            }
          }
          await this.finalizeConversationPhase(projectId, phase, state, approveProject ?? undefined);
        } else {
          logger.warn({ projectId, phase }, 'approvePhase: no security handler for this phase');
        }
      } else {
        // Development pipeline approval routing
        switch (phase) {
          case 1:
          case 3:
          case 5:
          case 6:
          case 7:
          case 8:
          case 9:
          case 10:
          case 12:
            await this.finalizeConversationPhase(projectId, phase, state);
            break;
          default:
            logger.warn({ projectId, phase }, 'approvePhase: no handler for this phase');
        }
      }
    } catch (err) {
      // S3 (Onda 3): expected pause — spawnAgent already persisted state and
      // emitted the user-facing IPC. Just exit silently without an error toast.
      if (err instanceof PipelinePausedError) {
        logger.info(
          { projectId, phase, reason: err.reason },
          'approvePhase: PipelinePausedError — short-circuiting',
        );
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'approvePhase: error');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
      // Rethrow so the IPC handler returns { error } via withPipelineEngine
      // instead of { ok: true }. Without this, the frontend receives a fake
      // success and the UI looks like it approved when actually it failed
      // (e.g. invalid candidate id, missing decisions, etc).
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: Discovery conversation handlers (continue:true within block)
  // -------------------------------------------------------------------------

  private async handlePhase1Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = 'phase1';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const docsCtxP1 = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
    const notesPath = (project.discoveryNotesPath || (docsCtxP1
      ? docsCtxP1.resolveDocPath('discovery.md')
      : path.join(project.projectPath, 'discovery-notes.md')));
    const isFirstTurn = !sessionEntry.alive;

    // On first turn, include the notes path context
    const prompt = isFirstTurn
      ? `Arquivo de notas do discovery: ${notesPath}\n\nMensagem do usuario: ${message}`
      : message;

    const previousNotesContent = fs.existsSync(notesPath)
      ? fs.readFileSync(notesPath, 'utf-8')
      : '';

    const phase1Acc = { text: '', completed: false };
    const phase1AgentId = project.pipelineType === 'feature' ? FEAT_DISCOVERY_ID : DISCOVERY_AGENT_ID;
    // External runtime is stateless HTTP: pass prior turns (OpenAI multi-turn format
    // with tool_calls and tool results) so the agent does not re-invoke tools it already
    // executed. Cloud SDK uses continueSession instead and ignores priorMessages.
    const phase1Prior = sessionEntry.alive
      ? getPipelinePhaseMessagesAsChatHistory(projectId, 1).map((m) => ({
          ...m,
          tool_calls: m.tool_calls?.map((tc) => ({
            id: tc.id,
            function: {
              name: tc.function.name,
              // OllamaChatMessage espera arguments como objeto; o DB persiste como string JSON.
              arguments: (() => {
                try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
                catch { return {}; }
              })(),
            },
          })),
        }))
      : undefined;
    const result = await this.spawnAgent(phase1AgentId, prompt, {
      projectId,
      phaseNumber: 1,
      cwd: project.projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      priorMessages: phase1Prior,
      docsDir: docsCtxP1?.docsDir,
      onText: this.makeConversationOnText(projectId, 1, phase1Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 1, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;

    // Accumulate metrics
    this.accumulateMetrics(state, 1, result);

    // Check if notes were updated
    if (fs.existsSync(notesPath)) {
      const currentNotesContent = fs.readFileSync(notesPath, 'utf-8');
      if (currentNotesContent !== previousNotesContent) {
        emitIPC('pipeline:notes-updated', {
          projectId,
          path: notesPath,
          content: currentNotesContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase1CleanedText = phase1Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    const phase1ToolCalls = result.toolCalls;
    if (phase1CleanedText || (phase1ToolCalls && phase1ToolCalls.length > 0)) {
      persistMessage(
        { kind: 'pipeline', projectId, phaseNumber: 1 },
        'assistant',
        phase1CleanedText,
        { toolCalls: phase1ToolCalls },
      );
    }

    emitIPC('pipeline:stream', { projectId, phase: 1, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phase 3: PRD Validator (persistent file memory, fresh query each turn)
  // -------------------------------------------------------------------------

  private async handlePhase3Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = 'phase3';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const docsCtxP3 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const discoveryNotesPath = docsCtxP3
      ? docsCtxP3.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md');
    const storiesPath = docsCtxP3
      ? docsCtxP3.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const reportPath = docsCtxP3
      ? docsCtxP3.resolveDocPath('prd-validation.md')
      : path.join(projectPath, '.prd-validation-report.md');

    const isFirstTurn = !sessionEntry.alive;

    const previousStoriesContent = fs.existsSync(storiesPath)
      ? fs.readFileSync(storiesPath, 'utf-8')
      : '';

    let prompt: string;
    if (isFirstTurn) {
      // First turn: full analysis with instruction to edit stories-requisitos.md directly
      const prdPath = (project ? resolvePrdPath(project) : null);
      prompt =
        `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
        `## Discovery Notes\nCaminho: ${discoveryNotesPath}\n\n` +
        `## User Stories e Requisitos\nCaminho: ${storiesPath}\n\n` +
        (prdPath && fs.existsSync(prdPath) ? `## PRD\nCaminho: ${prdPath}\n\n` : '') +
        `## Instrucao importante\n` +
        `Apos identificar problemas e discutir com o usuario, edite ${storiesPath} diretamente ` +
        `usando Write ou Edit quando o usuario aprovar uma correcao. Nao peca permissao para editar: edite imediatamente apos o usuario concordar.\n\n` +
        `## Mensagem do usuario\n${message}`;
    } else {
      // Follow-up turns: just the user message (agent already has full context from the session)
      prompt = message;
    }

    const phase3Acc = { text: '', completed: false };
    const phase3AgentId = project.pipelineType === 'feature' ? FEAT_PRD_VALIDATOR_ID : PRD_VALIDATOR_ID;
    const result = await this.spawnAgent(phase3AgentId, prompt, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxP3?.docsDir,
      onText: this.makeConversationOnText(projectId, 3, phase3Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 3, result);

    if (fs.existsSync(storiesPath)) {
      const currentStoriesContent = fs.readFileSync(storiesPath, 'utf-8');
      if (currentStoriesContent !== previousStoriesContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: storiesPath,
          content: currentStoriesContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase3CleanedText = phase3Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase3CleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3CleanedText);
    }

    emitIPC('pipeline:stream', { projectId, phase: 3, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phases 5-8: Tech conversation phases (Database, Backend, Frontend, Security)
  // Each phase uses its own dedicated agent and session key.
  // -------------------------------------------------------------------------

  private async handleTechPhaseMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number,
    agentId: string,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = `phase${phaseNumber}`;
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const docsCtxTech = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const notesPath = (project.discoveryNotesPath || (docsCtxTech
      ? docsCtxTech.resolveDocPath('discovery.md')
      : path.join(projectPath, 'discovery-notes.md')));
    const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxTech
      ? docsCtxTech.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md')));
    const isFirstTurn = !sessionEntry.alive;

    const prompt = isFirstTurn
      ? `Discovery Notes: ${notesPath}\n` +
        `PRD: ${prdPath}\n\n` +
        `Leia os documentos acima para entender o contexto do projeto antes de iniciar a discussao. ` +
        `Conduza a discussao tecnica com o usuario, proponha abordagens e registre as decisoes aprovadas no PRD.md. ` +
        `IMPORTANTE: NAO altere o discovery-notes.md em hipotese alguma, ele e somente leitura para contexto.\n\n` +
        `Mensagem do usuario: ${message}`
      : message;

    const previousPrdContent = fs.existsSync(prdPath)
      ? fs.readFileSync(prdPath, 'utf-8')
      : '';

    const techAcc = { text: '', completed: false };
    const result = await this.spawnAgent(agentId, prompt, {
      projectId,
      phaseNumber,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxTech?.docsDir,
      onText: this.makeConversationOnText(projectId, phaseNumber, techAcc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, phaseNumber, result);

    if (fs.existsSync(prdPath)) {
      const currentPrdContent = fs.readFileSync(prdPath, 'utf-8');
      if (currentPrdContent !== previousPrdContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: prdPath,
          content: currentPrdContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const techCleanedText = techAcc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (techCleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', techCleanedText);
    }

    emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phase 10: Spec Enricher (session persists across turns for context)
  // -------------------------------------------------------------------------

  private async handlePhase10Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = 'phase10';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const docsCtxP10 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const specPath = (project.specPath || (docsCtxP10
      ? docsCtxP10.resolveDocPath('SPEC.md')
      : path.join(projectPath, 'SPEC.md')));
    const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP10
      ? docsCtxP10.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md')));
    const storiesPath = docsCtxP10
      ? docsCtxP10.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const suggestionsPath = docsCtxP10
      ? docsCtxP10.resolveDocPath('enrich-suggestions.md')
      : path.join(projectPath, '.spec-enricher-suggestions.md');

    const isFirstTurn = !sessionEntry.alive;

    const previousSpecContent = fs.existsSync(specPath)
      ? fs.readFileSync(specPath, 'utf-8')
      : '';

    let prompt: string;
    if (isFirstTurn) {
      prompt =
        `## Arquivo da SPEC\nCaminho: ${specPath}\n\n` +
        `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
        (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
        `## Arquivo de sugestoes persistente\nCaminho: ${suggestionsPath}\n\n` +
        `## Instrucao importante\n` +
        `Compare a SPEC.md contra o PRD.md. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
        `Apresente suas sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.\n\n` +
        `## Mensagem do usuario\n${message}`;
    } else {
      // Follow-up turns: just the user message (agent has full context from session)
      prompt = message;
    }

    const phase10Acc = { text: '', completed: false };
    const result = await this.spawnAgent(SPEC_ENRICHER_ID, prompt, {
      projectId,
      phaseNumber: 10,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxP10?.docsDir,
      onText: this.makeConversationOnText(projectId, 10, phase10Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 10, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 10, result);

    if (fs.existsSync(specPath)) {
      const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: currentSpecContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase10CleanedText = phase10Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase10CleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 10 }, 'assistant', phase10CleanedText);
    }

    emitIPC('pipeline:stream', { projectId, phase: 10, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phase 12: Sprint Validator (session persists across turns for context)
  // -------------------------------------------------------------------------

  private async handlePhase12Message(
    projectId: string,
    message: string,
    state: PhaseState,
    phaseNumber: number = 12,
  ): Promise<void> {
    // Sprint Validator handler. Used by both:
    //   - dev/feature pipelines on phase 12 (default)
    //   - architecture-review pipeline on phase 9 (passed by caller)
    // The phaseNumber parameter is propagated to spawnAgent / persistMessage /
    // emit IPC so the UI sees messages on the correct channel.
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = `sprint-validator-phase${phaseNumber}`;
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const docsCtxP12 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const specPath = (project.specPath || (docsCtxP12
      ? docsCtxP12.resolveDocPath('SPEC.md')
      : path.join(projectPath, 'SPEC.md')));
    const sprintsPath = findHarnessSprintsReadPath(project) ?? resolveHarnessSprintsPath(project);
    const reportPath = docsCtxP12
      ? docsCtxP12.resolveDocPath('sprint-validation.md')
      : path.join(projectPath, '.sprint-validation-report.md');

    const isFirstTurn = !sessionEntry.alive;

    const previousSprintsContent = fs.existsSync(sprintsPath)
      ? fs.readFileSync(sprintsPath, 'utf-8')
      : '';

    let prompt: string;
    if (isFirstTurn) {
      prompt =
        `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
        `## SPEC\nCaminho: ${specPath}\n\n` +
        `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
        `## Instrucao principal\n` +
        `Compare a SPEC.md com as sprints geradas. Identifique features da SPEC nao cobertas nas sprints. ` +
        `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.\n\n` +
        `## Mensagem do usuario\n${message}`;
    } else {
      // Follow-up turns: just the user message (agent has full context from session)
      prompt = message;
    }

    const phase12Acc = { text: '', completed: false };
    const result = await this.spawnAgent(SPRINT_VALIDATOR_ID, prompt, {
      projectId,
      phaseNumber,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxP12?.docsDir,
      onText: this.makeConversationOnText(projectId, phaseNumber, phase12Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, phaseNumber, result);

    if (fs.existsSync(sprintsPath)) {
      const currentSprintsContent = fs.readFileSync(sprintsPath, 'utf-8');
      if (currentSprintsContent !== previousSprintsContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: sprintsPath,
          content: currentSprintsContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase12CleanedText = phase12Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase12CleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber }, 'assistant', phase12CleanedText);
    }

    emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'done' });
  }

  // =========================================================================
  // Security Pipeline Auto Phases
  // =========================================================================

  // -------------------------------------------------------------------------
  // Security Phase 1: Repo Profiler (deterministic, no LLM)
  // -------------------------------------------------------------------------

  private async runSecurityPhase1(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    logger.info({ projectId, projectPath }, 'Security Phase 1: Repo Profiler starting');

    const startedAt = Date.now();

    const callbacks: PhaseCallbacks = {
      onText: (chunk) => {
        emitIPC('pipeline:stream', { projectId, phase: 1, type: 'text', content: chunk });
      },
      onDone: () => {
        emitIPC('pipeline:stream', { projectId, phase: 1, type: 'done' });
      },
    };

    const manifest = await runRepoProfiler(projectPath, callbacks);

    logger.info(
      { projectId, totalFiles: manifest.totalFiles, classifiedFiles: manifest.classifiedFiles },
      'Security Phase 1: Repo Profiler completed',
    );

    // Persist completion metrics so the UI stops showing phase 1 as "running".
    // runAutoPhase created a 'running' row at entry; this call upserts it to 'completed'.
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 1,
      phaseName: SECURITY_PHASE_NAMES[1] ?? 'Repo Profiler',
      agentId: 'repo-profiler',
      status: 'completed',
      durationMs: Date.now() - startedAt,
      runtime: 'local',
      completedAt: new Date().toISOString(),
      metadata: {
        totalFiles: manifest.totalFiles,
        classifiedFiles: manifest.classifiedFiles,
        language: manifest.language,
        framework: manifest.framework,
      },
    });

    emitIPC('pipeline:manifest', { projectId, manifest });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 1,
      phaseName: SECURITY_PHASE_NAMES[1],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to Phase 2 (Security Audit)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 2: Security Audit (parallel multi-agent via SecurityAuditRunner)
  // -------------------------------------------------------------------------

  private async runSecurityPhase2(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    logger.info({ projectId }, 'Security Phase 2: Security Audit starting');

    const startedAt = Date.now();
    const runner = new SecurityAuditRunner(this);

    const callbacks: PhaseCallbacks = {
      onText: (chunk) => {
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'text', content: chunk });
      },
      onDone: () => {
        emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
      },
    };

    const consolidatedPath = await runner.run(
      // HarnessProject e superset de PipelineProject pros campos usados pelo runner.
      // Cast via unknown porque os types tem signatures de sobreposicao parcial.
      project as unknown as Parameters<SecurityAuditRunner['run']>[0],
      state.abortController,
      callbacks,
      (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    );

    // Bug #12: emit document-updated with the raw consolidated report from phase 2
    if (consolidatedPath && fs.existsSync(consolidatedPath)) {
      try {
        const content = fs.readFileSync(consolidatedPath, 'utf-8');
        emitIPC('pipeline:document-updated', {
          projectId,
          path: consolidatedPath,
          content,
        });
      } catch (err) {
        logger.warn({ err, consolidatedPath }, 'Failed to emit consolidated document for phase 2');
      }
    }

    if (state.abortController.signal.aborted) return;

    logger.info({ projectId }, 'Security Phase 2: Security Audit completed');

    // Mark the phase-level metrics row (sprint_index=-1) as completed. The runner
    // writes per-agent rows (sprint_index=1..7); without this upsert the phase
    // aggregate stays stuck on 'running' from runAutoPhase's initial insert.
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 2,
      phaseName: SECURITY_PHASE_NAMES[2] ?? 'Security Audit',
      agentId: 'multi-agent',
      status: 'completed',
      durationMs: Date.now() - startedAt,
      runtime: 'cloud',
      completedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 2,
      phaseName: SECURITY_PHASE_NAMES[2],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to Phase 3 (Deduplicador)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 3: Deduplicador (auto, single agent)
  // -------------------------------------------------------------------------

  private async runSecurityPhase3(
    projectId: string,
    projectPath: string,
    state: PhaseState,
  ): Promise<void> {
    logger.info({ projectId }, 'Security Phase 3: Deduplicador starting');

    // Resolve consolidated security report path via canonical helper.
    const project3 = getHarnessProject(projectId);
    const consolidatedPath = findConsolidatedSecurityReport(
      projectPath,
      project3?.pipelineDocsId ?? null,
    );
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');

    const prompt = consolidatedPath
      ? `Leia o relatorio de seguranca consolidado em: ${consolidatedPath}\n` +
        `Deduplique os findings: remova entradas identicas ou muito similares, mantendo a mais detalhada.\n` +
        `Renumere os findings deduplicados sequencialmente por severidade.\n` +
        `Salve o resultado deduplicado sobrescrevendo o arquivo: ${consolidatedPath}`
      : `Nao foi encontrado relatorio de seguranca consolidado em ${securityDir}. Por favor verifique a execucao da fase anterior.`;

    let phase3Output = '';
    const result = await this.spawnAgent('security-deduplicator', prompt, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        phase3Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 3, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    if (phase3Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3Output);
    }

    this.collectMetrics(projectId, 3, 'security-deduplicator', result, 'completed', { pipelineType: 'security' });

    logger.info({ projectId }, 'Security Phase 3: Deduplicador completed');

    // Write Site 1: populate totalFindings + bySeverity after deduplication.
    if (consolidatedPath) {
      try {
        const parsed = parseSecurityFindings(consolidatedPath);
        patchSecuritySummaryJson(projectId, {
          totalFindings: parsed.total,
          bySeverity: parsed.bySeverity,
        });
        logger.info({ projectId, total: parsed.total }, 'SecuritySummary: totalFindings written after phase 3');
      } catch (err) {
        logger.warn({ err, projectId }, 'SecuritySummary: failed to parse findings after phase 3, skipping');
      }
    }

    emitIPC('pipeline:stream', { projectId, phase: 3, type: 'done' });

    // Bug #12: emit document-updated with the dedup output so the viewer
    // reflects the post-deduplication state immediately.
    if (consolidatedPath && fs.existsSync(consolidatedPath)) {
      try {
        const content = fs.readFileSync(consolidatedPath, 'utf-8');
        emitIPC('pipeline:document-updated', {
          projectId,
          path: consolidatedPath,
          content,
        });
      } catch (err) {
        logger.warn({ err, consolidatedPath }, 'Failed to emit dedup document for phase 3');
      }
    }

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 3,
      phaseName: SECURITY_PHASE_NAMES[3],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to Phase 4 (Validador Cetico — conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Security Phase 6: SPEC Generator (auto with security prompt injection)
  // -------------------------------------------------------------------------

  private async runSecurityPhase6(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    logger.info({ projectId }, 'Security Phase 6: SPEC Generator starting');

    // Find consolidated Security report via canonical helper
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');
    const securityReportPath = findConsolidatedSecurityReport(
      projectPath,
      (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    );

    // Derive scan ID from the file name for the SPEC output path (legacy basename pattern only)
    const scanIdMatch = securityReportPath
      ? path.basename(securityReportPath).match(/Security[-_]?(\d{8}[-_]\d{4,6})\.md/)
      : null;
    const scanId = scanIdMatch ? scanIdMatch[1] : 'unknown';
    const specOutputPath = path.join(securityDir, `SPECsecurity-${scanId}.md`);

    const securityContextPrompt = securityReportPath
      ? `\n\nINFORMACAO IMPORTANTE: Este projeto e um security audit pipeline.\n` +
        `O INPUT para voce NAO e um PRD, mas um relatorio de auditoria de seguranca consolidado.\n` +
        `Leia o relatorio em: ${securityReportPath}\n` +
        `Gere um SPEC tecnico que descreva como corrigir cada finding listado no relatorio.\n` +
        `Cada finding deve se tornar uma feature na SPEC com criterios de aceite claros e passos de implementacao.\n` +
        `Salve o SPEC em: ${specOutputPath}`
      : `\n\nINFORMACAO IMPORTANTE: Este projeto e um security audit pipeline.\n` +
        `Nenhum relatorio de seguranca foi encontrado em ${securityDir}. Verifique a fase anterior.\n` +
        `Salve o SPEC em: ${specOutputPath}`;

    const prompt =
      `Gere um SPEC completo a partir do relatorio de auditoria de seguranca.${securityContextPrompt}`;

    let phase6Output = '';
    const result = await this.spawnAgent(SPEC_BUILDER_ID, prompt, {
      projectId,
      phaseNumber: 6,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        phase6Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 6, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 6, type: 'tool_call', tool: toolName });
      },
    });

    if (phase6Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', phase6Output);
    }

    this.collectMetrics(projectId, 6, SPEC_BUILDER_ID, result, 'completed', { pipelineType: 'security' });

    // Update project's specPath to point to the security SPEC
    if (fs.existsSync(specOutputPath)) {
      const db = getDb();
      db.prepare(`UPDATE harness_projects SET spec_path = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(specOutputPath, projectId);

      emitIPC('pipeline:document-updated', {
        projectId,
        path: specOutputPath,
        content: fs.readFileSync(specOutputPath, 'utf-8'),
      });
    }

    logger.info({ projectId, specOutputPath }, 'Security Phase 6: SPEC Generator completed');

    emitIPC('pipeline:stream', { projectId, phase: 6, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 6,
      phaseName: SECURITY_PHASE_NAMES[6],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to Phase 7 (SPEC Enricher — conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // =========================================================================
  // Security Pipeline Conversation Phases
  // =========================================================================

  // -------------------------------------------------------------------------
  // Security Phase 4: Validador Cetico
  // First runs security-skeptic-security then security-skeptic-quality automatically,
  // then opens human chat (awaitingUser=true).
  // -------------------------------------------------------------------------

  private async handleSecurityPhase4Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'security-phase4';
    let sessionEntry = state.continueSessions.get(sessionKey);

    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    // First message (greeting): run security skeptic once, then wait for user.
    if (!sessionEntry.alive) {
      const securityDir = path.join(projectPath, '.lionclaw', 'Security');
      const securityReportPath = findConsolidatedSecurityReport(
        projectPath,
        (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
      );

      const reportContext = securityReportPath
        ? `Relatorio de seguranca consolidado: ${securityReportPath}`
        : `Nenhum relatorio consolidado encontrado em ${securityDir}.`;

      if (securityReportPath && fs.existsSync(securityReportPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: securityReportPath,
          content: fs.readFileSync(securityReportPath, 'utf-8'),
        });
      } else {
        logger.warn({ projectId, securityDir }, 'Security Phase 4: consolidated report not found, skipping document-updated emit');
      }

      logger.info({ projectId }, 'Security Phase 4: running security-skeptic-security');
      const secPrompt = `Voce e o Validador Cetico de Seguranca nesta fase de VALIDACAO.\n\n` +
        `## Entrada\n` +
        `${reportContext}\n\n` +
        `## Seu escopo\n` +
        `- Para cada finding das secoes 01 (Secrets), 02 (Auth), 03 (Isolation), 07 (OWASP):\n` +
        `  marcar como CONFIRMADO, REMOVIDO ou REBAIXADO (com justificativa curta).\n` +
        `- Atualizar o proprio Security-*.md removendo falsos positivos das suas secoes\n` +
        `  e adicionando "Validacao Cetica de Seguranca - Sumario Parcial" ao final.\n\n` +
        `## Fora do escopo (NAO faca)\n` +
        `- Nao discuta geracao de SPEC. Outro agente cuida disso em fase posterior.\n` +
        `- Nao enriqueca solucoes sugeridas. Nao proponha estrategias de implementacao.\n` +
        `- Nao decida prioridades de negocio, timing ("imediato vs deferido") nem roadmap.\n` +
        `- Nao pergunte "prefere X ou Y" sobre proximas fases.\n\n` +
        `## Como terminar\n` +
        `Quando concluir a validacao, apresente:\n` +
        `1. Totais: X confirmados, Y removidos, Z rebaixados\n` +
        `2. Resumo curto das mudancas feitas no Security-*.md\n` +
        `3. UMA UNICA mensagem final ao usuario: "Se quiser ajustar algum finding especifico, me diga. Senao, clique em APROVAR para passar ao Skeptic Quality."\n\n` +
        `Se o usuario pedir ajustes em findings especificos, faca as alteracoes e atualize o sumario. ` +
        `Nunca abra discussao sobre SPEC, implementacao, priorizacao de negocio ou proximas fases.\n\n` +
        `Mensagem do usuario: ${message}`;

      let secOutput = '';
      const secResult = await this.spawnAgent('security-skeptic-security', secPrompt, {
        projectId,
        phaseNumber: 4,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          secOutput += chunk;
          emitIPC('pipeline:stream', { projectId, phase: 4, type: 'text', content: chunk });
        },
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
        },
      });

      if (secOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', secOutput);
      }
      this.accumulateMetrics(state, 4, secResult);

      sessionEntry.alive = true;

      logger.info({ projectId }, 'Security Phase 4: skeptic-security done, entering human chat');

      // agent-completed signals the UI to surface the Aprovar button
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    } else {
      // Follow-up turns: continue conversation with skeptic-security
      const phase4Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent('security-skeptic-security', message, {
        projectId,
        phaseNumber: 4,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        onText: this.makeConversationOnText(projectId, 4, phase4Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 4, followupResult);

      const cleanedText = phase4Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
      }
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Security Phase 5: Skeptic Quality conversation
  // Runs the quality-focused skeptic once on first turn, then opens human chat.
  // -------------------------------------------------------------------------

  private async handleSecurityPhase5Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'security-phase5';
    let sessionEntry = state.continueSessions.get(sessionKey);

    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    if (!sessionEntry.alive) {
      const securityDir = path.join(projectPath, '.lionclaw', 'Security');
      const securityReportPath = findConsolidatedSecurityReport(
        projectPath,
        (project as unknown as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
      );

      const reportContext = securityReportPath
        ? `Relatorio de seguranca consolidado (ja revisado pelo Skeptic Security): ${securityReportPath}`
        : `Nenhum relatorio consolidado encontrado em ${securityDir}.`;

      if (securityReportPath && fs.existsSync(securityReportPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: securityReportPath,
          content: fs.readFileSync(securityReportPath, 'utf-8'),
        });
      }

      logger.info({ projectId }, 'Security Phase 5: running security-skeptic-quality');
      const qualPrompt = `Voce e o Validador Cetico de Qualidade nesta fase de VALIDACAO. O Skeptic Security ja revisou as secoes 01, 02, 03, 07; voce agora valida as secoes de QUALIDADE.\n\n` +
        `## Entrada\n` +
        `${reportContext}\n\n` +
        `## Seu escopo\n` +
        `- Para cada finding das secoes 04 (Duplication), 05 (Logic), 06 (Standards):\n` +
        `  marcar como CONFIRMADO, REMOVIDO ou REBAIXADO (com justificativa curta).\n` +
        `- Atualizar o proprio Security-*.md removendo falsos positivos das suas secoes\n` +
        `  e adicionando "Validacao Cetica de Qualidade - Sumario Parcial" ao final.\n\n` +
        `## Fora do escopo (NAO faca)\n` +
        `- Nao discuta geracao de SPEC. Outro agente cuida disso em fase posterior.\n` +
        `- Nao enriqueca solucoes sugeridas. Nao proponha estrategias de implementacao.\n` +
        `- Nao inclua gaps de cobertura como novos findings. Apenas registre observacoes no sumario se for relevante.\n` +
        `- Nao pergunte "prefere X ou Y" sobre proximas fases nem sobre como implementar.\n\n` +
        `## Como terminar\n` +
        `Quando concluir a validacao, apresente:\n` +
        `1. Totais: X confirmados, Y removidos, Z rebaixados\n` +
        `2. Resumo curto das mudancas feitas no Security-*.md\n` +
        `3. UMA UNICA mensagem final ao usuario: "Se quiser ajustar algum finding especifico, me diga. Senao, clique em APROVAR para o gerador de SPEC continuar."\n\n` +
        `Se o usuario pedir ajustes em findings especificos, faca as alteracoes e atualize o sumario. ` +
        `Nunca abra discussao sobre SPEC, implementacao, decisoes tecnicas ou proximas fases.\n\n` +
        `Mensagem do usuario: ${message}`;

      let qualOutput = '';
      const qualResult = await this.spawnAgent('security-skeptic-quality', qualPrompt, {
        projectId,
        phaseNumber: 5,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          qualOutput += chunk;
          emitIPC('pipeline:stream', { projectId, phase: 5, type: 'text', content: chunk });
        },
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 5, type: 'tool_call', tool: toolName });
        },
      });

      if (qualOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', qualOutput);
      }
      this.accumulateMetrics(state, 5, qualResult);

      sessionEntry.alive = true;

      logger.info({ projectId }, 'Security Phase 5: skeptic-quality done, entering human chat');

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 5, type: 'done' });
    } else {
      const phase5Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent('security-skeptic-quality', message, {
        projectId,
        phaseNumber: 5,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        onText: this.makeConversationOnText(projectId, 5, phase5Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 5, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 5, followupResult);

      const cleanedText = phase5Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', cleanedText);
      }
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 5, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Security Phase 7: SPEC Enricher conversation
  // -------------------------------------------------------------------------

  private async handleSecurityPhase7Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'security-phase7';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const docsCtxSec7 = getPipelineDocsContext(projectPath, (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null);

    // Resolve specPath (the SPECsecurity-*.md generated in Phase 5)
    const specPath = (project as { specPath?: string }).specPath
      || (docsCtxSec7 ? docsCtxSec7.resolveDocPath('SPEC.md') : path.join(projectPath, '.lionclaw', 'Security', 'SPECsecurity-unknown.md'));

    const isFirstTurn = !sessionEntry.alive;
    const previousSpecContent = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf-8') : '';

    const prompt = isFirstTurn
      ? `## Arquivo da SPEC de seguranca\nCaminho: ${specPath}\n\n` +
        `## Instrucao importante\n` +
        `Compare a SPEC de correcoes de seguranca. Identifique lacunas, inconsistencias e oportunidades de enriquecimento. ` +
        `Verifique se cada finding tem criterios de aceite claros e implementaveis. ` +
        `Apresente sugestoes, discuta com o usuario e edite ${specPath} diretamente usando Write ou Edit apos aprovacao.\n\n` +
        `## Mensagem do usuario\n${message}`
      : message;

    const phase7Acc = { text: '', completed: false };
    const result = await this.spawnAgent(SPEC_ENRICHER_ID, prompt, {
      projectId,
      phaseNumber: 7,
      cwd: projectPath,
      docsDir: docsCtxSec7?.docsDir,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      onText: this.makeConversationOnText(projectId, 7, phase7Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 7, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 7, result);

    if (fs.existsSync(specPath)) {
      const currentContent = fs.readFileSync(specPath, 'utf-8');
      if (currentContent !== previousSpecContent) {
        emitIPC('pipeline:document-updated', { projectId, path: specPath, content: currentContent });
      }
    }

    const cleanedText = phase7Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitIPC('pipeline:stream', { projectId, phase: 7, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Security Phase 9: Sprint Validator conversation
  // -------------------------------------------------------------------------

  private async handleSecurityPhase9Message(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'security-phase9';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const docsCtxSec9 = getPipelineDocsContext(projectPath, (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null);
    const specPath = (project as { specPath?: string }).specPath || (docsCtxSec9
      ? docsCtxSec9.resolveDocPath('SPEC.md')
      : path.join(projectPath, 'SPEC.md'));
    const sprintsPath = findHarnessSprintsReadPath({
      id: (project as { id: string }).id,
      projectPath,
      pipelineDocsId: (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
      sprintsJsonPath: (project as { sprintsJsonPath?: string }).sprintsJsonPath,
    }) ?? resolveHarnessSprintsPath({
      id: (project as { id: string }).id,
      projectPath,
      pipelineDocsId: (project as { pipelineDocsId?: string | null }).pipelineDocsId ?? null,
    });
    const reportPath = docsCtxSec9
      ? docsCtxSec9.resolveDocPath('sprint-validation.md')
      : path.join(projectPath, '.sprint-validation-report.md');

    const isFirstTurn = !sessionEntry.alive;
    const previousSprintsContent = fs.existsSync(sprintsPath) ? fs.readFileSync(sprintsPath, 'utf-8') : '';

    const prompt = isFirstTurn
      ? `## Arquivo de relatorio persistente\nCaminho: ${reportPath}\n\n` +
        `## SPEC de correcoes de seguranca\nCaminho: ${specPath}\n\n` +
        `## Plano de Sprints\nCaminho: ${sprintsPath}\n\n` +
        `## Instrucao principal\n` +
        `Compare a SPEC com as sprints geradas. Verifique se cada finding de seguranca esta coberto por ao menos uma sprint. ` +
        `Sugira ajustes. Apos concordancia com o usuario, edite o arquivo de sprints diretamente em ${sprintsPath}.\n\n` +
        `## Mensagem do usuario\n${message}`
      : message;

    const phase9Acc = { text: '', completed: false };
    const result = await this.spawnAgent(SPRINT_VALIDATOR_ID, prompt, {
      projectId,
      phaseNumber: 9,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxSec9?.docsDir,
      onText: this.makeConversationOnText(projectId, 9, phase9Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 9, result);

    if (fs.existsSync(sprintsPath)) {
      const currentContent = fs.readFileSync(sprintsPath, 'utf-8');
      if (currentContent !== previousSprintsContent) {
        emitIPC('pipeline:document-updated', { projectId, path: sprintsPath, content: currentContent });
      }
    }

    const cleanedText = phase9Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (cleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', cleanedText);
    }

    emitIPC('pipeline:agent-completed', { projectId });
    emitIPC('pipeline:stream', { projectId, phase: 9, type: 'done' });
  }

  // =========================================================================
  // Security Resolution Tracker (post-pipeline, feat-026)
  // =========================================================================

  private async runResolutionTracker(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    logger.info({ projectId }, 'Resolution Tracker: starting post-pipeline scan');

    // Find the original Security-*.md consolidated report
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');
    const consolidatedFiles = fs.existsSync(securityDir)
      ? fs.readdirSync(securityDir).filter((f) => /^Security-\d{8}-\d{4}\.md$/.test(f)).sort()
      : [];
    const securityReportPath = consolidatedFiles.length > 0
      ? path.join(securityDir, consolidatedFiles[consolidatedFiles.length - 1]!)
      : null;

    if (!securityReportPath) {
      logger.warn({ projectId }, 'Resolution Tracker: no Security report found — skipping');
      return;
    }

    const scanIdMatch = securityReportPath.match(/Security-(\d{8}-\d{4})\.md$/);
    const scanId = scanIdMatch ? scanIdMatch[1] : 'unknown';
    const outputPath = path.join(securityDir, `SecurityScan-${scanId}.json`);

    const prompt =
      `Voce e o Resolution Tracker de seguranca. Seu trabalho e verificar se os findings do relatorio de seguranca foram corrigidos.\n\n` +
      `Relatorio original: ${securityReportPath}\n` +
      `Diretorio do projeto: ${projectPath}\n\n` +
      `Para cada finding no relatorio:\n` +
      `1. Leia o(s) arquivo(s) mencionados no finding\n` +
      `2. Verifique se o problema foi corrigido\n` +
      `3. Classifique como: resolved, partially_resolved, ou unresolved\n\n` +
      `Gere um arquivo JSON em: ${outputPath}\n` +
      `Formato do JSON:\n` +
      `{\n` +
      `  "id": "${scanId}",\n` +
      `  "project": "${projectPath}",\n` +
      `  "date": "<ISO timestamp>",\n` +
      `  "totalFindings": <number>,\n` +
      `  "resolved": <number>,\n` +
      `  "partiallyResolved": <number>,\n` +
      `  "unresolved": <number>,\n` +
      `  "findings": [\n` +
      `    { "findingId": "CRITICO-001", "title": "...", "severity": "CRITICO", "files": ["..."], "status": "resolved", "resolution": "..." },\n` +
      `    ...\n` +
      `  ]\n` +
      `}`;

    const trackerAbort = new AbortController();
    let trackerOutput = '';

    try {
      await this.spawnAgent(RESOLUTION_TRACKER_ID, prompt, {
        projectId,
        phaseNumber: 0, // Not a formal phase
        cwd: projectPath,
        abortController: trackerAbort,
        onText: (chunk) => {
          trackerOutput += chunk;
        },
      });
    } catch (err) {
      logger.error({ err, projectId }, 'Resolution Tracker: agent failed');
      emitIPC('pipeline:resolution-tracker-complete', {
        projectId,
        success: false,
        error: (err as Error).message,
      });
      return;
    }

    // Parse summary from generated JSON
    let summary: { resolved: number; partiallyResolved: number; unresolved: number } = {
      resolved: 0,
      partiallyResolved: 0,
      unresolved: 0,
    };

    try {
      if (fs.existsSync(outputPath)) {
        const jsonContent = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as {
          resolved?: number;
          partiallyResolved?: number;
          unresolved?: number;
        };
        summary = {
          resolved: jsonContent.resolved ?? 0,
          partiallyResolved: jsonContent.partiallyResolved ?? 0,
          unresolved: jsonContent.unresolved ?? 0,
        };
      }
    } catch {
      logger.warn({ projectId, outputPath }, 'Resolution Tracker: failed to parse JSON output');
    }

    // Write Site 3: persist resolved / partiallyResolved / unresolved in metadata.
    try {
      patchSecuritySummaryJson(projectId, {
        resolved: summary.resolved,
        partiallyResolved: summary.partiallyResolved,
        unresolved: summary.unresolved,
      });
      logger.info({ projectId, summary }, 'SecuritySummary: resolution fields written after tracker');
    } catch (err) {
      logger.warn({ err, projectId }, 'SecuritySummary: failed to write resolution fields, skipping');
    }

    // The authoritative record is the SecurityScan-{id}.json on disk.
    // Emit the summary in the IPC event so the frontend can update its store.
    logger.info({ projectId, summary, outputPath }, 'Resolution Tracker: completed');

    emitIPC('pipeline:resolution-tracker-complete', {
      projectId,
      success: true,
      outputPath,
      summary,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 9: Spec Generation — auto loop spec-builder -> spec-validator
  // -------------------------------------------------------------------------

  async runPhase9(projectId: string): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const state = this.getState(projectId);
    const projectPath = project.projectPath;
    const docsCtxP9 = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP9
      ? docsCtxP9.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md')));
    const storiesPath = docsCtxP9
      ? docsCtxP9.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const specPath = (project.specPath || (docsCtxP9
      ? docsCtxP9.resolveDocPath('SPEC.md')
      : path.join(projectPath, 'SPEC.md')));
    const validationReportPath = docsCtxP9
      ? docsCtxP9.resolveDocPath('spec-validation.md')
      : path.join(projectPath, '.spec-validation-report.md');

    const phaseName = PHASE_NAMES[9];

    logger.info({ projectId, prdPath, storiesPath, specPath }, 'Phase 9: Spec Generation starting');

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 9,
      phaseName,
      agentId: SPEC_BUILDER_ID,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 9,
      phaseName,
      status: 'running',
      awaitingUser: false,
    });

    const MAX_ROUNDS = 3;
    let passed = false;
    let lastError: string | undefined;

    // Aggregate metrics separately for builder and validator across rounds
    const builderAgg = this.createEmptyMetrics();
    const validatorAgg = this.createEmptyMetrics();
    let builderModel = SPEC_BUILDER_ID;
    let builderRuntime: AgentConfig['runtime'] = 'cloud';
    let validatorModel = SPEC_VALIDATOR_ID;
    let validatorRuntime: AgentConfig['runtime'] = 'cloud';
    const startedAt = Date.now();

    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (state.abortController.signal.aborted) break;

        emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 9,
          phaseName,
          status: 'spec-builder-running',
          awaitingUser: false,
          metadata: { round, maxRounds: MAX_ROUNDS },
        });

        // --- Spec Builder ---
        let builderPrompt: string;
        if (round === 1) {
          builderPrompt =
            `Gere o SPEC.md completo a partir do PRD.md e stories-requisitos.md.\n\n` +
            `PRD: ${prdPath}\n` +
            `User Stories: ${storiesPath}\n` +
            `Salve em: ${specPath}`;
        } else {
          const validationContent = fs.existsSync(validationReportPath)
            ? fs.readFileSync(validationReportPath, 'utf-8')
            : '';
          builderPrompt =
            `Corrija o SPEC.md com base no relatorio de validacao abaixo.\n\n` +
            `Salve o resultado corrigido em: ${specPath}\n\n` +
            `SPEC atual: ${specPath}\n` +
            `Validation Report:\n${validationContent}`;
        }

        let builderOutput = '';
        const builderResult = await this.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
          projectId,
          phaseNumber: 9,
          cwd: projectPath,
          abortController: state.abortController,
          docsDir: docsCtxP9?.docsDir,
          onText: (chunk) => {
            builderOutput += chunk;
            emitIPC('pipeline:stream', {
              projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-builder', round },
            });
          },
          onToolUse: (toolName) => {
            emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
          },
        });

        // Save complete builder message (not per-chunk)
        if (builderOutput) {
          persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', builderOutput);
        }

        this.mergeMetrics(builderAgg, builderResult.metrics);
        builderModel = builderResult.model;
        builderRuntime = builderResult.runtime;

        if (fs.existsSync(specPath)) {
          emitIPC('pipeline:document-updated', {
            projectId,
            path: specPath,
            content: fs.readFileSync(specPath, 'utf-8'),
          });
        }

        if (state.abortController.signal.aborted) break;

        // --- Spec Validator ---
        emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 9,
          phaseName,
          status: 'spec-validator-running',
          awaitingUser: false,
          metadata: { round, maxRounds: MAX_ROUNDS },
        });

        const validatorPrompt =
          `Valide o SPEC.md contra o PRD.md e stories-requisitos.md.\n\n` +
          `SPEC: ${specPath}\n` +
          `PRD: ${prdPath}\n` +
          `User Stories: ${storiesPath}\n` +
          `Salve o relatorio de validacao em: ${validationReportPath}`;

        let validatorOutput = '';
        const validatorResult = await this.spawnAgent(SPEC_VALIDATOR_ID, validatorPrompt, {
          projectId,
          phaseNumber: 9,
          cwd: projectPath,
          abortController: state.abortController,
          docsDir: docsCtxP9?.docsDir,
          onText: (chunk) => {
            validatorOutput += chunk;
            emitIPC('pipeline:stream', {
              projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-validator', round },
            });
          },
          onToolUse: (toolName) => {
            emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
          },
        });

        // Save complete validator message (not per-chunk)
        if (validatorOutput) {
          persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', validatorOutput);
        }

        this.mergeMetrics(validatorAgg, validatorResult.metrics);
        validatorModel = validatorResult.model;
        validatorRuntime = validatorResult.runtime;

        // Check validation result
        const validationReport = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';

        if (validationReport.includes('## Status: PASS')) {
          passed = true;
          logger.info({ projectId, round }, 'Phase 9: Spec validation PASSED');
          break;
        }

        logger.info({ projectId, round }, 'Phase 9: Spec validation FAILED — continuing');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId }, 'Phase 9 aborted');
        return;
      }
      lastError = (err as Error).message;
      logger.error({ err, projectId }, 'Phase 9 error');
    }

    const durationMs = Date.now() - startedAt;

    // Save 2 aggregated metric rows: builder + validator
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 9,
      phaseName: `${phaseName} (Builder)`,
      agentId: SPEC_BUILDER_ID,
      status: lastError ? 'failed' : 'completed',
      inputTokens: builderAgg.inputTokens,
      outputTokens: builderAgg.outputTokens,
      cacheReadTokens: builderAgg.cacheReadTokens,
      cacheCreationTokens: builderAgg.cacheCreationTokens,
      costUsd: builderAgg.costUsd,
      durationMs,
      toolUses: builderAgg.toolUses,
      apiRequests: builderAgg.apiRequests,
      model: builderModel,
      runtime: builderRuntime,
      completedAt: new Date().toISOString(),
    });

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 91, // sub-row for validator within phase 9
      phaseName: `${phaseName} (Validator)`,
      agentId: SPEC_VALIDATOR_ID,
      status: lastError ? 'failed' : 'completed',
      inputTokens: validatorAgg.inputTokens,
      outputTokens: validatorAgg.outputTokens,
      cacheReadTokens: validatorAgg.cacheReadTokens,
      cacheCreationTokens: validatorAgg.cacheCreationTokens,
      costUsd: validatorAgg.costUsd,
      durationMs,
      toolUses: validatorAgg.toolUses,
      apiRequests: validatorAgg.apiRequests,
      model: validatorModel,
      runtime: validatorRuntime,
      completedAt: new Date().toISOString(),
    });

    emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber: 9,
      metrics: { builder: builderAgg, validator: validatorAgg },
      passed,
    });

    if (lastError) {
      logger.error({ projectId, error: lastError }, 'Phase 9 failed — marking pipeline as failed');
      setProjectStatus(projectId, 'paused');
      state.status = 'paused';
      emitIPC('pipeline:error', { projectId, phase: 9, error: lastError });
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 9,
        phaseName,
        status: 'failed',
        awaitingUser: true,
      });
      return;
    }

    // Persist specPath in DB now that the builder has written it.
    // Use updateHarnessProject directly because updateProjectColumns is scoped to
    // pipeline_* columns; specPath lives in the base harness_projects schema.
    updateHarnessProject(projectId, { specPath });

    emitIPC('pipeline:stream', { projectId, phase: 9, type: 'done' });

    // After the auto loop, enter a conversational review state with the Spec Validator.
    // The user can discuss the SPEC.md with the validator and only DECIDIDO advances to phase 10.
    logger.info({ projectId, passed }, 'Phase 9 auto loop complete — entering spec review conversation');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 9,
      phaseName,
      status: 'awaiting-spec-review',
      awaitingUser: true,
      metadata: { passed },
    });

    // Auto-trigger the Spec Validator greeting so it presents its analysis
    const greetingProject = getHarnessProject(projectId);
    const greetingMsg =
      `Projeto "${greetingProject?.name ?? projectId}". ` +
      `O loop de geracao automatica foi concluido${passed ? ' e a SPEC passou na validacao automatica' : ' (com alertas de validacao)'}. ` +
      `Apresente um resumo da SPEC.md gerada, destaque pontos fortes e eventuais ressalvas, e pergunte ao usuario se deseja ajustes antes de avancar.`;

    try {
      await this.handlePhase9Message(projectId, greetingMsg, state);
    } catch (greetErr) {
      logger.error({ err: greetErr, projectId }, 'Phase 9: failed to start spec review conversation');
      // Non-fatal: the conversational state is already emitted; user can still type
    }
  }

  // =========================================================================
  // Architecture Review pipeline handlers (phases 1-7)
  // =========================================================================
  //
  // Phase 1 (Map):                runArchitecturePhase1Map           — auto
  // Phase 2 (Triage):             handleArchitecturePhase2TriageMessage — conversation
  // Phase 3 (Diagnosis):          runArchitecturePhase3Diagnosis     — auto (Sprint 5)
  // Phase 4 (Decision Interview): handleArchitecturePhase4DecisionMessage — conversation (Sprint 5)
  // Phase 5 (Spec Generation):    runArchitecturePhase5Spec          — auto (Sprint 6)
  // Phase 6 (Spec Validation):    handleArchitecturePhase6SpecValidationMessage — conversation (Sprint 6)
  // Phase 7 (Spec Enricher):      handleArchitecturePhase7SpecEnricherMessage   — conversation (Sprint 6)
  //
  // Phases 8-11 reuse harness handlers (Planner / Sprint Validator / Coder / Evaluator).
  // =========================================================================

  // -------------------------------------------------------------------------
  // Architecture Review Phase 1: Mapeamento Arquitetural (auto)
  // -------------------------------------------------------------------------

  private async runArchitecturePhase1Map(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;

    // Ensure run context exists (create runId + dir + manifest if missing).
    // Idempotent — safe to re-run on phase 1 reset.
    const { context: ctx, runIdGenerated } = ensureArchitectureReviewContext(project);

    // Persist runId in DB so subsequent phases (and reboots) can resolve the
    // same run. Without this, getArchitectureReviewContext returns null on the
    // next call. Critical: this is the gating write — without it the rest of
    // the pipeline cannot find the run dir.
    if (runIdGenerated) {
      updateHarnessProject(projectId, {
        config: {
          ...project.config,
          architectureReview: {
            ...(project.config.architectureReview ?? {}),
            runId: ctx.runId,
          },
        },
      });
      logger.info(
        { projectId, runId: ctx.runId, runDir: ctx.runDir },
        'Architecture Phase 1: runId persisted in DB',
      );
    }

    const prompt =
      `Mapeie a arquitetura top-level do projeto em: ${projectPath}\n\n` +
      `Voce e o Architecture Mapper do pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: NAO modifique nenhum arquivo do projeto-alvo. ` +
      `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
      `  ${ctx.runDir}\n\n` +
      `Outputs obrigatorios (escreva ambos):\n` +
      `  - Markdown: ${ctx.mapMdPath}\n` +
      `  - JSON:     ${ctx.mapJsonPath}\n\n` +
      `Use Read/Glob/Grep/Bash para inspecionar a codebase. NAO use Write/Edit ` +
      `em nenhum path fora do diretorio acima.\n\n` +
      `Siga o processo descrito no seu systemPrompt: reconhecimento inicial, ` +
      `mapeamento top-level, hotspots e honestidade sobre o que nao foi mapeado.`;

    // Snapshot runId in-memory; if spawnAgent fails before it returns, the next
    // run (after user reset/retry) will read the persisted runId and reuse the
    // same dir — no orphan run dirs accumulate.

    let phase1Output = '';
    const result = await this.spawnAgent(ARCHITECTURE_MAPPER_ID, prompt, {
      projectId,
      phaseNumber: 1,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        phase1Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 1, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 1, type: 'tool_call', tool: toolName });
      },
    });

    if (phase1Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 1 }, 'assistant', phase1Output);
    }

    this.collectMetrics(projectId, 1, ARCHITECTURE_MAPPER_ID, result, 'completed', {
      pipelineType: 'architecture-review',
    });

    // Hard-fail: agente DEVE ter escrito ambos MD e JSON. Sem isso, fase 2 cai
    // em "Architecture Map not found" — erro tardio confuso para o user.
    if (!fs.existsSync(ctx.mapMdPath) || !fs.existsSync(ctx.mapJsonPath)) {
      throw new Error(
        `architecture-mapper did not produce required artefacts. ` +
        `Expected both:\n  - ${ctx.mapMdPath}\n  - ${ctx.mapJsonPath}\n` +
        `Reset phase 1 and try again.`,
      );
    }
    // Validate JSON is parseable (catches LLM emitting malformed JSON early).
    try {
      JSON.parse(fs.readFileSync(ctx.mapJsonPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `architecture-mapper produced invalid JSON at ${ctx.mapJsonPath}: ${(err as Error).message}`,
      );
    }

    emitIPC('pipeline:document-updated', {
      projectId,
      path: ctx.mapMdPath,
      content: fs.readFileSync(ctx.mapMdPath, 'utf-8'),
    });

    emitIPC('pipeline:stream', { projectId, phase: 1, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 1,
      phaseName: ARCHITECTURE_PHASE_NAMES[1],
      status: 'completed',
      awaitingUser: false,
    });

    logger.info({ projectId, runId: ctx.runId }, 'Architecture Phase 1 (Map) completed');

    // Auto-advance to phase 2 (Triage conversation).
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 2: Triagem de Alvos (conversation)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase2TriageMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'architecture-phase2';
    let sessionEntry = state.continueSessions.get(sessionKey);

    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error(
        'architecture-review run context not found — phase 1 must have generated runId in config.architectureReview.runId before phase 2 starts',
      );
    }
    if (!fs.existsSync(ctx.mapMdPath)) {
      throw new Error(`Architecture Map not found at ${ctx.mapMdPath} — phase 1 must complete first`);
    }

    if (!sessionEntry.alive) {
      // First turn: build candidates from the map.
      const triagePrompt =
        `Voce e o Architecture Target Triage do pipeline architecture-review.\n` +
        `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
        `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
        `  ${ctx.runDir}\n\n` +
        `## Entrada\n` +
        `- Architecture Map: ${ctx.mapMdPath}\n` +
        `- Project root: ${projectPath}\n\n` +
        `## Outputs obrigatorios (escreva ambos)\n` +
        `- Markdown: ${ctx.candidatesMdPath}\n` +
        `- JSON:     ${ctx.candidatesJsonPath}\n\n` +
        `## Glossario arquitetural canonico (use esses termos exatamente)\n` +
        `- Module: qualquer coisa com interface + implementacao\n` +
        `- Interface: tudo que o chamador precisa saber (tipos, invariantes, ordenacao, modos de erro)\n` +
        `- Implementation: corpo interno do module\n` +
        `- Depth: leverage por unidade de interface; deep = muito comportamento atras de interface pequena\n` +
        `- Seam: lugar onde a interface existe e o comportamento pode mudar sem editar in-place\n` +
        `- Adapter: coisa concreta que satisfaz uma interface em um seam\n` +
        `- Leverage: ganho dos chamadores quando um module e deep\n` +
        `- Locality: ganho dos mantenedores; bugs/mudancas concentrados num lugar\n` +
        `- Deletion test: deletar este module concentra a complexidade ou apenas a move?\n\n` +
        `## Tarefa\n` +
        `1. Le o Map.\n` +
        `2. Reexplora areas relevantes do projeto via Read/Glob/Grep.\n` +
        `3. Aplica deletion test e produz lista numerada de 3-7 candidatos de aprofundamento.\n` +
        `4. Recomenda 1 candidato (maior payoff/risco) com justificativa de 2-3 frases.\n` +
        `5. Escreve MD + JSON na estrutura definida no seu systemPrompt. IDs no JSON DEVEM ser strings (ex: "C1", "C2").\n\n` +
        `## Restricoes\n` +
        `- NAO proponha interface final ainda.\n` +
        `- NAO invente candidatos sem evidencia em files reais.\n\n` +
        `## Mensagem do usuario\n${message}`;

      let triageOutput = '';
      const triageResult = await this.spawnAgent(ARCHITECTURE_TARGET_TRIAGE_ID, triagePrompt, {
        projectId,
        phaseNumber: 2,
        cwd: projectPath,
        abortController: state.abortController,
        onText: (chunk) => {
          triageOutput += chunk;
          emitIPC('pipeline:stream', { projectId, phase: 2, type: 'text', content: chunk });
        },
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 2, type: 'tool_call', tool: toolName });
        },
      });

      if (triageOutput) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', triageOutput);
      }
      this.accumulateMetrics(state, 2, triageResult);
      sessionEntry.alive = true;

      if (fs.existsSync(ctx.candidatesMdPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.candidatesMdPath,
          content: fs.readFileSync(ctx.candidatesMdPath, 'utf-8'),
        });
      }

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
    } else {
      // Follow-up: continue conversation. The agent may re-explore code or
      // refine candidates; on each turn we re-emit the candidates document if
      // it changed (heuristic: re-emit always — frontend de-dupes).
      const phase2Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent(ARCHITECTURE_TARGET_TRIAGE_ID, message, {
        projectId,
        phaseNumber: 2,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        priorMessages: this.buildPriorMessagesForPhase(projectId, 2),
        onText: this.makeConversationOnText(projectId, 2, phase2Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 2, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 2, followupResult);

      const cleanedText = phase2Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 2 }, 'assistant', cleanedText);
      }

      if (fs.existsSync(ctx.candidatesMdPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.candidatesMdPath,
          content: fs.readFileSync(ctx.candidatesMdPath, 'utf-8'),
        });
      }

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phases 3-7: stubs implemented in Sprints 5-6
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Architecture Review Phase 3: Diagnostico Arquitetural (auto)
  // -------------------------------------------------------------------------

  private async runArchitecturePhase3Diagnosis(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error(
        'architecture-review run context not found — phase 1 must have generated runId before phase 3 starts',
      );
    }

    const selectedCandidateId = project.config.architectureReview?.selectedCandidateId;
    if (!selectedCandidateId) {
      throw new Error(
        'no selectedCandidateId in config.architectureReview — phase 2 must be approved with { selectedCandidateId } before phase 3 starts',
      );
    }
    if (!fs.existsSync(ctx.mapMdPath) || !fs.existsSync(ctx.candidatesMdPath)) {
      throw new Error(
        `Architecture Map or Candidates MD missing at ${ctx.runDir} — phases 1 and 2 must complete first`,
      );
    }

    const prompt =
      `Voce e o Architecture Diagnostician do pipeline architecture-review.\n` +
      `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
      `Voce DEVE escrever EXCLUSIVAMENTE dentro de:\n` +
      `  ${ctx.runDir}\n\n` +
      `## Candidato escolhido pelo usuario\n` +
      `selectedCandidateId: ${selectedCandidateId}\n\n` +
      `## Entradas\n` +
      `- Map:        ${ctx.mapMdPath}\n` +
      `- Candidates: ${ctx.candidatesMdPath}\n` +
      `- Project root: ${projectPath}\n\n` +
      `## Outputs obrigatorios (escreva ambos)\n` +
      `- Markdown: ${ctx.diagnosisMdPath}\n` +
      `- JSON:     ${ctx.diagnosisJsonPath}\n\n` +
      `## Tarefa\n` +
      `1. Leia Map e Candidates. Localize a entrada do candidato escolhido.\n` +
      `2. Reexplore arquivos citados do candidato (Read).\n` +
      `3. PROVE a friccao com evidencias concretas: arquivo:linhas + finding + impact.\n` +
      `4. Identifique a causa raiz arquitetural em 1-3 frases.\n` +
      `5. Liste seams atuais e seams ausentes.\n` +
      `6. Classifique dependencias (in-process / local-substitutable / remote-owned / external).\n` +
      `7. Indique impacto em testabilidade/manutencao/performance e riscos do nao-fazer.\n` +
      `8. Escreva MD + JSON na estrutura definida no seu systemPrompt. ` +
      `O campo \`candidateId\` no JSON DEVE ser exatamente "${selectedCandidateId}".\n\n` +
      `## Restricoes\n` +
      `- NAO invente evidencias. Cada evidencia deve citar path:lines real.\n` +
      `- Esta fase NAO corrige bugs — apenas diagnostica friccao arquitetural.`;

    let phase3Output = '';
    const result = await this.spawnAgent(ARCHITECTURE_DIAGNOSTICIAN_ID, prompt, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      onText: (chunk) => {
        phase3Output += chunk;
        emitIPC('pipeline:stream', { projectId, phase: 3, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    if (phase3Output) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 3 }, 'assistant', phase3Output);
    }

    this.collectMetrics(projectId, 3, ARCHITECTURE_DIAGNOSTICIAN_ID, result, 'completed', {
      pipelineType: 'architecture-review',
    });

    // Hard-fail: agente DEVE ter escrito ambos MD e JSON. Fase 4/5 dependem
    // do diagnosis; sem ele o erro vira tardio e confuso.
    if (!fs.existsSync(ctx.diagnosisMdPath) || !fs.existsSync(ctx.diagnosisJsonPath)) {
      throw new Error(
        `architecture-diagnostician did not produce required artefacts. ` +
        `Expected both:\n  - ${ctx.diagnosisMdPath}\n  - ${ctx.diagnosisJsonPath}\n` +
        `Reset phase 3 and try again.`,
      );
    }
    try {
      JSON.parse(fs.readFileSync(ctx.diagnosisJsonPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `architecture-diagnostician produced invalid JSON at ${ctx.diagnosisJsonPath}: ${(err as Error).message}`,
      );
    }

    emitIPC('pipeline:document-updated', {
      projectId,
      path: ctx.diagnosisMdPath,
      content: fs.readFileSync(ctx.diagnosisMdPath, 'utf-8'),
    });

    // Bump manifest updatedAt so UI sees fresh activity timestamp.
    patchArchitectureReviewManifest(project, {});

    emitIPC('pipeline:stream', { projectId, phase: 3, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 3,
      phaseName: ARCHITECTURE_PHASE_NAMES[3],
      status: 'completed',
      awaitingUser: false,
    });

    logger.info({ projectId, runId: ctx.runId, selectedCandidateId }, 'Architecture Phase 3 (Diagnosis) completed');

    // Auto-advance to phase 4 (Decision Interview conversation).
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 4: Entrevista de Decisao (conversation, append-only)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase4DecisionMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const sessionKey = 'architecture-phase4';
    let sessionEntry = state.continueSessions.get(sessionKey);

    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error('architecture-review run context not found — phases 1-3 must complete first');
    }

    const selectedCandidateId = project.config.architectureReview?.selectedCandidateId;
    if (!selectedCandidateId) {
      throw new Error('no selectedCandidateId in config — phase 2 approval missing');
    }

    if (!sessionEntry.alive) {
      // First turn: ENGINE bootstrap the decision file header (if not exists).
      // The agent NEVER writes the header — engine owns it. Agent only APPENDS ## DN.
      if (!fs.existsSync(ctx.decisionsMdPath)) {
        const header =
          `# Architecture Decisions: ${path.basename(projectPath)}/${ctx.runId}\n\n` +
          `## Context\n` +
          `- **Selected candidate:** ${selectedCandidateId}\n` +
          `- **Source files:**\n` +
          `  - ${ctx.mapMdPath}\n` +
          `  - ${ctx.candidatesMdPath}\n` +
          `  - ${ctx.diagnosisMdPath}\n\n` +
          `---\n\n`;
        fs.writeFileSync(ctx.decisionsMdPath, header, 'utf-8');
        logger.info({ projectId, decisionsMdPath: ctx.decisionsMdPath }, 'Architecture Phase 4: created decisions.md header');
      }

      // Compute next decision number from current file (monotonic, anti-duplicate).
      const decisionsContent = fs.readFileSync(ctx.decisionsMdPath, 'utf-8');
      const decisionMatches = decisionsContent.match(/^##\s*D(\d+)/gm) ?? [];
      const nextDecisionN = decisionMatches.length + 1;

      const interviewPrompt =
        `Voce e o Architecture Decision Interviewer do pipeline architecture-review.\n` +
        `INFORMACAO IMPORTANTE: NAO modifique codigo do projeto-alvo. ` +
        `Escreva EXCLUSIVAMENTE em ${ctx.decisionsMdPath} via Edit (append-only).\n\n` +
        `## Contexto da entrevista\n` +
        `- selectedCandidateId: ${selectedCandidateId}\n` +
        `- Map:        ${ctx.mapMdPath}\n` +
        `- Candidates: ${ctx.candidatesMdPath}\n` +
        `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
        `- Decisions:  ${ctx.decisionsMdPath}  (fonte de verdade — releia a CADA turno)\n\n` +
        `## Estado do arquivo de decisoes\n` +
        `- Cabecalho: JA CRIADO pelo engine. NAO escreva cabecalho novamente.\n` +
        `- Decisoes ja apendadas: ${decisionMatches.length}\n` +
        `- Proxima decisao DEVE ser: D${nextDecisionN}\n\n` +
        `## Regra de continuidade\n` +
        `Antes de fazer qualquer pergunta, LEIA o arquivo de decisions atual via Read. ` +
        `Decisoes nao persistidas ali nao existem para a SPEC.\n\n` +
        `## Tarefa neste turno\n` +
        `1. Leia o decisions.md (Read).\n` +
        `2. Leia Map+Candidates+Diagnosis se ainda nao houver ## DN no decisions.\n` +
        `3. Faca UMA pergunta arquitetural ao usuario sobre o candidato, com SUA recomendacao.\n` +
        `4. Quando o usuario fechar uma decisao, APENDE \`## D${nextDecisionN} — <titulo>\` no decisions.md ` +
        `via Edit (formato: Pergunta / Opcoes consideradas / Decisao / Razao / Implica / Timestamp). ` +
        `Sequencial. NUNCA renumere ou duplique decisoes anteriores.\n\n` +
        `## Quando sugerir fechar\n` +
        `Se ja ha 3+ decisoes apendadas e a ultima resposta nao gerou nova pergunta substantiva, ` +
        `SUGIRA (sem forcar): "Acho que cobrimos os pontos principais. Quer fechar e gerar a SPEC?". ` +
        `O fechamento de fase eh por botao na UI — voce so sugere.\n\n` +
        `## Mensagem do usuario\n${message}`;

      const phase4Acc = { text: '', completed: false };
      const interviewResult = await this.spawnAgent(ARCHITECTURE_DECISION_INTERVIEWER_ID, interviewPrompt, {
        projectId,
        phaseNumber: 4,
        cwd: projectPath,
        abortController: state.abortController,
        onText: this.makeConversationOnText(projectId, 4, phase4Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
        },
      });

      const cleanedText = phase4Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
      }
      this.accumulateMetrics(state, 4, interviewResult);
      sessionEntry.alive = true;

      if (fs.existsSync(ctx.decisionsMdPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.decisionsMdPath,
          content: fs.readFileSync(ctx.decisionsMdPath, 'utf-8'),
        });
      }

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    } else {
      // Follow-up turn: continueSession. Agent must re-read decisions.md per the
      // continuity rule (it sees the system prompt + this user message).
      const phase4Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent(ARCHITECTURE_DECISION_INTERVIEWER_ID, message, {
        projectId,
        phaseNumber: 4,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        priorMessages: this.buildPriorMessagesForPhase(projectId, 4),
        onText: this.makeConversationOnText(projectId, 4, phase4Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 4, followupResult);

      const cleanedText = phase4Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 4 }, 'assistant', cleanedText);
      }

      if (fs.existsSync(ctx.decisionsMdPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.decisionsMdPath,
          content: fs.readFileSync(ctx.decisionsMdPath, 'utf-8'),
        });
      }

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 5: Spec Generation (auto LOOP builder ↔ validator)
  //
  // Pattern espelhado de runPhase9 (dev/feature):
  // - Loop ate MAX_ROUNDS=3 alternando spec-builder e spec-validator.
  // - Round 1: builder gera SPEC do zero a partir dos 4 artefatos arquiteturais.
  // - Round 2-3: builder corrige a SPEC baseado no `validation-report.md` do round anterior.
  // - Validator sempre escreve `## Status: PASS` ou `## Status: FAIL` no relatorio.
  // - Se PASS, sai do loop. Se FAIL no ultimo round, avanca mesmo assim — fase 6
  //   (conversation) e o gate humano onde o usuario aprova ou pede mais ajustes.
  //
  // R6 ADR: spec-builder e spec-validator sao COMPARTILHADOS entre pipelines.
  // O contexto arquitetural vive no user message do handler, nao em fork de agente.
  // -------------------------------------------------------------------------

  private async runArchitecturePhase5Spec(
    projectId: string,
    project: ReturnType<typeof getHarnessProject> & object,
    state: PhaseState,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error('architecture-review run context not found — phases 1-4 must complete first');
    }

    for (const [label, p] of [
      ['Map', ctx.mapMdPath],
      ['Candidates', ctx.candidatesMdPath],
      ['Diagnosis', ctx.diagnosisMdPath],
      ['Decisions', ctx.decisionsMdPath],
    ] as const) {
      if (!fs.existsSync(p)) {
        throw new Error(`Architecture ${label} MD missing at ${p} — phases 1-4 must complete first`);
      }
    }

    // Validation report path lives inside the run dir (canonical area).
    const validationReportPath = path.join(ctx.runDir, `spec-validation-${ctx.runId}.md`);

    const phaseName = ARCHITECTURE_PHASE_NAMES[5] ?? 'Spec Generation';
    const MAX_ROUNDS = 3;
    let passed = false;

    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (state.abortController.signal.aborted) break;

        emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 5,
          phaseName,
          status: 'spec-builder-running',
          awaitingUser: false,
          metadata: { round, maxRounds: MAX_ROUNDS },
        });

        // ---- Spec Builder ----
        let builderPrompt: string;
        if (round === 1) {
          builderPrompt =
            `Gere o SPEC implementavel para o pipeline architecture-review.\n\n` +
            `INFORMACAO IMPORTANTE: Este projeto e um architecture review pipeline.\n` +
            `O INPUT para voce NAO e um PRD. Suas fontes sao quatro artefatos arquiteturais:\n\n` +
            `- Map:        ${ctx.mapMdPath}\n` +
            `- Candidates: ${ctx.candidatesMdPath}\n` +
            `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
            `- Decisions:  ${ctx.decisionsMdPath}  (FONTE PRIMARIA — nao invente decisoes ausentes)\n\n` +
            `## Regras\n` +
            `- Use Decisions como fonte primaria. Nao invente decisoes ausentes.\n` +
            `- Use Diagnosis como fonte de evidencias.\n` +
            `- Reexplore a codebase em ${projectPath} para confirmar paths e assinaturas atuais.\n` +
            `- Se houver drift relevante, registre no topo da SPEC.\n` +
            `- Se algo nao foi decidido, registre em "Open Questions" (NAO chute).\n` +
            `- Inclua TODAS as secoes: Goal, Context, Decisions (tabela), Module Map, ` +
            `Interface Changes, File-Level Changes (executavel), Migration Strategy, ` +
            `Tests, Rollback, **Riscos**, Acceptance Criteria, Open Questions.\n\n` +
            `## Output\n` +
            `Salve o SPEC em: ${ctx.specPath}`;
        } else {
          const validationContent = fs.existsSync(validationReportPath)
            ? fs.readFileSync(validationReportPath, 'utf-8')
            : '';
          builderPrompt =
            `Corrija o SPEC com base no relatorio de validacao abaixo.\n\n` +
            `Salve o resultado corrigido em: ${ctx.specPath}\n\n` +
            `SPEC atual: ${ctx.specPath}\n` +
            `Fontes arquiteturais (consulte se precisar):\n` +
            `- Map:        ${ctx.mapMdPath}\n` +
            `- Candidates: ${ctx.candidatesMdPath}\n` +
            `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
            `- Decisions:  ${ctx.decisionsMdPath}\n\n` +
            `Validation Report:\n${validationContent}\n\n` +
            `Use Edit para mudancas cirurgicas, nao reescreva o doc inteiro.`;
        }

        let builderOutput = '';
        const builderResult = await this.spawnAgent(SPEC_BUILDER_ID, builderPrompt, {
          projectId,
          phaseNumber: 5,
          cwd: projectPath,
          abortController: state.abortController,
          onText: (chunk) => {
            builderOutput += chunk;
            emitIPC('pipeline:stream', {
              projectId, phase: 5, type: 'text', content: chunk, metadata: { agent: 'spec-builder', round },
            });
          },
          onToolUse: (toolName) => {
            emitIPC('pipeline:stream', { projectId, phase: 5, type: 'tool_call', tool: toolName });
          },
        });

        if (builderOutput) {
          persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', builderOutput);
        }
        // 'completed' (nao 'running'): cada round do builder e uma execucao
        // de agente que terminou. O UPSERT em (projectId, phase, sprint=-1)
        // sobrescreve a row a cada chamada — a ultima call dentro do loop
        // (validator do round que passou ou ultimo round) define o status
        // visivel na ProgressBar. Isso evita o bug visual de fase 5 ficando
        // "running" pra sempre mesmo apos a fase 6/7 terem rodado.
        this.collectMetrics(projectId, 5, SPEC_BUILDER_ID, builderResult, 'completed', {
          pipelineType: 'architecture-review',
        });

        if (!fs.existsSync(ctx.specPath)) {
          throw new Error(
            `spec-builder did not write SPEC at expected path ${ctx.specPath} ` +
            `(round ${round}). Reset phase 5 and try again.`,
          );
        }

        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.specPath,
          content: fs.readFileSync(ctx.specPath, 'utf-8'),
        });

        if (state.abortController.signal.aborted) break;

        // ---- Spec Validator ----
        emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 5,
          phaseName,
          status: 'spec-validator-running',
          awaitingUser: false,
          metadata: { round, maxRounds: MAX_ROUNDS },
        });

        const validatorPrompt =
          `Valide a SPEC contra os 4 artefatos arquiteturais.\n\n` +
          `INFORMACAO IMPORTANTE: O INPUT NAO e PRD/discovery. Sao 4 artefatos arquiteturais.\n\n` +
          `## Documentos\n` +
          `- SPEC:       ${ctx.specPath}\n` +
          `- Map:        ${ctx.mapMdPath}\n` +
          `- Candidates: ${ctx.candidatesMdPath}\n` +
          `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
          `- Decisions:  ${ctx.decisionsMdPath}  (fonte primaria — toda decisao DEVE aparecer na SPEC)\n\n` +
          `## Validacoes obrigatorias\n` +
          `- Cada decisao do decisions.md aparece na SPEC.\n` +
          `- Nenhuma decisao foi inventada na SPEC.\n` +
          `- Cada File-Level Change referencia paths reais (use Read/Glob para verificar).\n` +
          `- Cada mudanca tem criterio de aceite verificavel.\n` +
          `- Estrategia de testes cruza a interface correta do module.\n` +
          `- **Riscos** e **Rollback** existem.\n` +
          `- Open Questions existem quando uma decisao nao foi fechada.\n\n` +
          `## Output\n` +
          `Salve o relatorio em: ${validationReportPath}\n` +
          `O relatorio DEVE comecar com \`# Validation Report\` e ter \`## Status: PASS\` ou \`## Status: FAIL\` ` +
          `na primeira secao apos o titulo. Use tags [MISS] e [CONFLICT] conforme seu systemPrompt.`;

        let validatorOutput = '';
        const validatorResult = await this.spawnAgent(SPEC_VALIDATOR_ID, validatorPrompt, {
          projectId,
          phaseNumber: 5,
          cwd: projectPath,
          abortController: state.abortController,
          onText: (chunk) => {
            validatorOutput += chunk;
            emitIPC('pipeline:stream', {
              projectId, phase: 5, type: 'text', content: chunk, metadata: { agent: 'spec-validator', round },
            });
          },
          onToolUse: (toolName) => {
            emitIPC('pipeline:stream', { projectId, phase: 5, type: 'tool_call', tool: toolName });
          },
        });

        if (validatorOutput) {
          persistMessage({ kind: 'pipeline', projectId, phaseNumber: 5 }, 'assistant', validatorOutput);
        }
        this.collectMetrics(projectId, 5, SPEC_VALIDATOR_ID, validatorResult, 'completed', {
          pipelineType: 'architecture-review',
        });

        const validationReport = fs.existsSync(validationReportPath)
          ? fs.readFileSync(validationReportPath, 'utf-8')
          : '';
        if (validationReport.includes('## Status: PASS')) {
          passed = true;
          logger.info({ projectId, round }, 'Architecture Phase 5: Spec validation PASSED');
          break;
        }
        logger.info({ projectId, round }, 'Architecture Phase 5: Spec validation FAILED — continuing');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId }, 'Architecture Phase 5 aborted');
        return;
      }
      logger.error({ err, projectId }, 'Architecture Phase 5 error');
      throw err;
    }

    // Persist specPath in DB so subsequent phases find it.
    const db = getDb();
    db.prepare(`UPDATE harness_projects SET spec_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(ctx.specPath, projectId);

    patchArchitectureReviewManifest(project, {});

    emitIPC('pipeline:stream', { projectId, phase: 5, type: 'done' });
    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 5,
      phaseName,
      status: 'completed',
      awaitingUser: false,
      metadata: { passed },
    });

    logger.info(
      { projectId, runId: ctx.runId, specPath: ctx.specPath, passed },
      `Architecture Phase 5 (Spec Generation) completed (validation: ${passed ? 'PASS' : 'FAIL after ' + MAX_ROUNDS + ' rounds'})`,
    );

    // Auto-advance to phase 6 (Spec Validation conversation — user reviews + approves).
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 6: Spec Validation (conversation, reuses spec-validator)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase6SpecValidationMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error('architecture-review context missing — phase 5 must complete first');
    }
    if (!fs.existsSync(ctx.specPath)) {
      throw new Error(`SPEC not found at ${ctx.specPath} — phase 5 must complete first`);
    }

    const sessionKey = 'architecture-phase6';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    if (!sessionEntry.alive) {
      const validatorPrompt =
        `Voce e o Spec Validator deste pipeline architecture-review.\n` +
        `INFORMACAO IMPORTANTE: O INPUT NAO e um PRD/discovery — sao 4 artefatos arquiteturais ` +
        `que devem ser cruzados contra a SPEC gerada.\n\n` +
        `## Documentos\n` +
        `- SPEC:       ${ctx.specPath}\n` +
        `- Map:        ${ctx.mapMdPath}\n` +
        `- Candidates: ${ctx.candidatesMdPath}\n` +
        `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
        `- Decisions:  ${ctx.decisionsMdPath}  (fonte primaria — toda decisao DEVE aparecer na SPEC)\n\n` +
        `## Validacoes obrigatorias\n` +
        `- Cada decisao do decisions.md aparece na SPEC.\n` +
        `- Nenhuma decisao foi inventada na SPEC (sem fonte em decisions/diagnosis).\n` +
        `- Cada File-Level Change referencia paths reais (use Read/Glob para verificar).\n` +
        `- Cada mudanca tem criterio de aceite verificavel.\n` +
        `- Estrategia de testes cruza a interface correta do module.\n` +
        `- Riscos e Rollback existem.\n` +
        `- Open Questions existem quando uma decisao nao foi fechada.\n\n` +
        `## Tarefa\n` +
        `Reporte tags [MISS] (algo do decisions/diagnosis nao apareceu na SPEC) e [CONFLICT] ` +
        `(SPEC contradiz decisions ou paths reais). Se TUDO ok, reporte PASS.\n` +
        `Apos primeira analise, fica disponivel para responder duvidas do usuario sobre a SPEC. ` +
        `O usuario aprova a fase via botao na UI.\n\n` +
        `## Mensagem do usuario\n${message}`;

      const phase6Acc = { text: '', completed: false };
      const result = await this.spawnAgent(SPEC_VALIDATOR_ID, validatorPrompt, {
        projectId,
        phaseNumber: 6,
        cwd: projectPath,
        abortController: state.abortController,
        onText: this.makeConversationOnText(projectId, 6, phase6Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 6, type: 'tool_call', tool: toolName });
        },
      });

      const cleanedText = phase6Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', cleanedText);
      }
      this.accumulateMetrics(state, 6, result);
      sessionEntry.alive = true;

      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 6, type: 'done' });
    } else {
      const phase6Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent(SPEC_VALIDATOR_ID, message, {
        projectId,
        phaseNumber: 6,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        priorMessages: this.buildPriorMessagesForPhase(projectId, 6),
        onText: this.makeConversationOnText(projectId, 6, phase6Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 6, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 6, followupResult);

      const cleanedText = phase6Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 6 }, 'assistant', cleanedText);
      }
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 6, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Architecture Review Phase 7: Spec Enricher (conversation, reuses spec-enricher)
  // -------------------------------------------------------------------------

  private async handleArchitecturePhase7SpecEnricherMessage(
    projectId: string,
    message: string,
    state: PhaseState,
    project: ReturnType<typeof getHarnessProject> & object,
  ): Promise<void> {
    const projectPath = (project as { projectPath: string }).projectPath;
    const ctx = getArchitectureReviewContext(project);
    if (!ctx) {
      throw new Error('architecture-review context missing — phase 5 must complete first');
    }
    if (!fs.existsSync(ctx.specPath)) {
      throw new Error(`SPEC not found at ${ctx.specPath} — phase 5 must complete first`);
    }

    const sessionKey = 'architecture-phase7';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    if (!sessionEntry.alive) {
      const enricherPrompt =
        `Voce e o Spec Enricher deste pipeline architecture-review.\n` +
        `INFORMACAO IMPORTANTE: A SPEC ja foi validada na fase anterior. ` +
        `Sua tarefa e enriquecer a SPEC com edge cases, UI states, paths alternativos, ` +
        `permissoes — usando os 4 artefatos arquiteturais como contexto extra.\n\n` +
        `## Documentos\n` +
        `- SPEC (alvo de edicao): ${ctx.specPath}\n` +
        `- Map:        ${ctx.mapMdPath}\n` +
        `- Candidates: ${ctx.candidatesMdPath}\n` +
        `- Diagnosis:  ${ctx.diagnosisMdPath}\n` +
        `- Decisions:  ${ctx.decisionsMdPath}\n\n` +
        `## Tarefa\n` +
        `1. Releia a SPEC + Decisions.\n` +
        `2. Identifique gaps: cenarios extremos nao cobertos, estados de erro, ` +
        `caminhos alternativos, permissoes implicitas.\n` +
        `3. Edite a SPEC via Edit (NAO reescreva — adicione secoes/itens).\n` +
        `4. Apresente o que adicionou e fica disponivel para conversa multi-turn.\n` +
        `5. NUNCA contradiga decisoes ja fechadas. Em caso de conflito, registre em Open Questions.\n\n` +
        `## Mensagem do usuario\n${message}`;

      const phase7Acc = { text: '', completed: false };
      const result = await this.spawnAgent(SPEC_ENRICHER_ID, enricherPrompt, {
        projectId,
        phaseNumber: 7,
        cwd: projectPath,
        abortController: state.abortController,
        onText: this.makeConversationOnText(projectId, 7, phase7Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 7, type: 'tool_call', tool: toolName });
        },
      });

      const cleanedText = phase7Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
      }
      this.accumulateMetrics(state, 7, result);
      sessionEntry.alive = true;

      if (fs.existsSync(ctx.specPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.specPath,
          content: fs.readFileSync(ctx.specPath, 'utf-8'),
        });
      }
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 7, type: 'done' });
    } else {
      const phase7Acc = { text: '', completed: false };
      const followupResult = await this.spawnAgent(SPEC_ENRICHER_ID, message, {
        projectId,
        phaseNumber: 7,
        cwd: projectPath,
        abortController: state.abortController,
        continueSession: true,
        priorMessages: this.buildPriorMessagesForPhase(projectId, 7),
        onText: this.makeConversationOnText(projectId, 7, phase7Acc),
        onToolUse: (toolName) => {
          emitIPC('pipeline:stream', { projectId, phase: 7, type: 'tool_call', tool: toolName });
        },
      });

      this.accumulateMetrics(state, 7, followupResult);

      const cleanedText = phase7Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
      if (cleanedText) {
        persistMessage({ kind: 'pipeline', projectId, phaseNumber: 7 }, 'assistant', cleanedText);
      }

      if (fs.existsSync(ctx.specPath)) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: ctx.specPath,
          content: fs.readFileSync(ctx.specPath, 'utf-8'),
        });
      }
      emitIPC('pipeline:agent-completed', { projectId });
      emitIPC('pipeline:stream', { projectId, phase: 7, type: 'done' });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 9: Spec Validator conversation (post auto-loop review)
  // -------------------------------------------------------------------------

  private async handlePhase9Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = 'phase9-validator';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const docsCtxP9Conv = getPipelineDocsContext(projectPath, project.pipelineDocsId ?? null);
    const specPath = (project.specPath || (docsCtxP9Conv
      ? docsCtxP9Conv.resolveDocPath('SPEC.md')
      : path.join(projectPath, 'SPEC.md')));
    const prdPath = ((project ? resolvePrdPath(project) : null) || (docsCtxP9Conv
      ? docsCtxP9Conv.resolveDocPath('PRD.md')
      : path.join(projectPath, 'PRD.md')));
    const storiesPath = docsCtxP9Conv
      ? docsCtxP9Conv.resolveDocPath('stories-requisitos.md')
      : path.join(projectPath, 'stories-requisitos.md');
    const validationReportPath = docsCtxP9Conv
      ? docsCtxP9Conv.resolveDocPath('spec-validation.md')
      : path.join(projectPath, '.spec-validation-report.md');

    const isFirstTurn = !sessionEntry.alive;

    const previousSpecContent = fs.existsSync(specPath)
      ? fs.readFileSync(specPath, 'utf-8')
      : '';

    let prompt: string;
    if (isFirstTurn) {
      prompt =
        `## SPEC.md\nCaminho: ${specPath}\n\n` +
        `## PRD de referencia\nCaminho: ${prdPath}\n\n` +
        (fs.existsSync(storiesPath) ? `## User Stories de referencia\nCaminho: ${storiesPath}\n\n` : '') +
        (fs.existsSync(validationReportPath) ? `## Relatorio de validacao automatica\nCaminho: ${validationReportPath}\n\n` : '') +
        `## Instrucao importante\n` +
        `Voce e o Spec Validator. Leia os arquivos acima, apresente um resumo da SPEC.md, aponte pontos fortes e ressalvas do relatorio de validacao. ` +
        `Se o usuario pedir ajustes, edite ${specPath} diretamente usando Write ou Edit. ` +
        `Quando o usuario estiver satisfeito ele clicara em Aprovar para avancar.\n\n` +
        `## Mensagem do usuario\n${message}`;
    } else {
      // Follow-up turns: just the user message (agent has full context from session)
      prompt = message;
    }

    const phase9Acc = { text: '', completed: false };
    const result = await this.spawnAgent(SPEC_VALIDATOR_ID, prompt, {
      projectId,
      phaseNumber: 9,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      docsDir: docsCtxP9Conv?.docsDir,
      onText: this.makeConversationOnText(projectId, 9, phase9Acc),
      onToolUse: (toolName) => {
        emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 91, result);

    if (fs.existsSync(specPath)) {
      const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: currentSpecContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase9CleanedText = phase9Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase9CleanedText) {
      persistMessage({ kind: 'pipeline', projectId, phaseNumber: 9 }, 'assistant', phase9CleanedText);
    }

    emitIPC('pipeline:stream', { projectId, phase: 9, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Helpers: conversation phase finalize (all pipelines)
  // -------------------------------------------------------------------------

  private async finalizeConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
    projectCtx?: { pipelineType?: string },
  ): Promise<void> {
    // Flush accumulated metrics for this phase
    const agentId = (projectCtx ? getPhaseAgentId(phase, projectCtx) : PHASE_AGENT_IDS[phase]) ?? 'unknown';
    this.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed', projectCtx);

    // Dev pipeline phase 9 also accumulates conversation-turn metrics under key 91 (Spec Validator review)
    if (phase === 9 && projectCtx?.pipelineType !== 'security') {
      this.flushAccumulatedMetrics(projectId, 91, SPEC_VALIDATOR_ID, state, 'completed');
    }

    logger.info({ projectId, phase }, 'Conversation phase finalized by user approval');

    const phaseName = (projectCtx ? getPhaseName(phase, projectCtx) : PHASE_NAMES[phase]) ?? `Phase ${phase}`;

    // Sprint Validator gate — requires explicit user confirmation before
    // starting the Coder/Evaluator loop. Phase number depends on pipelineType:
    //   - security:            phase 9
    //   - architecture-review: phase 9
    //   - dev / feature:       phase 12
    const isSprintValidatorPhase =
      (projectCtx?.pipelineType === 'security' && phase === 9) ||
      (projectCtx?.pipelineType === 'architecture-review' && phase === 9) ||
      (projectCtx?.pipelineType !== 'security' &&
        projectCtx?.pipelineType !== 'architecture-review' &&
        phase === 12);

    if (isSprintValidatorPhase) {
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase,
        phaseName,
        status: 'awaiting-dev-confirmation',
        awaitingUser: true,
      });
      return;
    }

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName,
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  /**
   * Build priorMessages array for a conversation follow-up turn.
   *
   * Why: cloud SDK and Codex maintain server-side conversation state, so
   * `continueSession: true` is enough. But local (Ollama) and external
   * (HTTP) runtimes are stateless — they need the full chat history
   * passed in `priorMessages` to maintain context across turns. Without
   * this, those runtimes "forget" everything between turns.
   *
   * The cloud/Codex executors ignore `priorMessages` (they prefer the
   * server-side session), so passing it is harmless on every runtime.
   */
  private buildPriorMessagesForPhase(
    projectId: string,
    phaseNumber: number,
  ): ReturnType<typeof getPipelinePhaseMessagesAsChatHistory> | undefined {
    try {
      const history = getPipelinePhaseMessagesAsChatHistory(projectId, phaseNumber);
      return history.length > 0
        ? history.map((m) => ({
            ...m,
            tool_calls: m.tool_calls?.map((tc) => ({
              id: tc.id,
              function: {
                name: tc.function.name,
                arguments: (() => {
                  try {
                    return JSON.parse(tc.function.arguments) as Record<string, unknown>;
                  } catch {
                    return {};
                  }
                })(),
              },
            })),
          }))
        : undefined;
    } catch (err) {
      logger.warn({ err, projectId, phaseNumber }, 'buildPriorMessagesForPhase: failed to load history');
      return undefined;
    }
  }

  /**
   * Run finalizeConversationPhase in background, returning IMMEDIATELY.
   *
   * Use case: approval transitions where the next phase is `auto` and may run
   * a long agent (opus, 5-10min). Without this, the `pipeline:approve` IPC
   * blocks for the entire duration, leaving the UI in an "Aprovando..." state
   * that looks like a freeze. The frontend instead listens to subsequent
   * `pipeline:phase-changed` / `pipeline:stream` events as the next phase
   * progresses.
   *
   * Errors are caught and emitted via `pipeline:error` so the frontend still
   * surfaces failures (just decoupled from the original IPC).
   */
  private runFinalizeInBackground(
    projectId: string,
    phase: number,
    state: PhaseState,
    project: NonNullable<ReturnType<typeof getHarnessProject>> | undefined,
  ): void {
    void this.finalizeConversationPhase(projectId, phase, state, project).catch((err) => {
      if (err instanceof PipelinePausedError) {
        logger.info({ projectId, phase, reason: err.reason }, 'Background finalize: PipelinePausedError — short-circuiting');
        return;
      }
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'Background finalizeConversationPhase failed');
      emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
    });
  }

  async confirmStartDevelopment(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'confirmStartDevelopment: pipeline aborted');
      return;
    }

    const confirmProject = getHarnessProject(projectId);
    // For security pipeline, the Sprint Validator is phase 8; for dev pipeline it is phase 12.
    const sprintValidatorPhase = (confirmProject ? getPhaseNumberForAgent(confirmProject, 'sprint-validator') : undefined) ?? 12;
    const sprintValidatorName = (confirmProject ? getPhaseName(sprintValidatorPhase, confirmProject) : PHASE_NAMES[12]) ?? `Phase ${sprintValidatorPhase}`;

    logger.info({ projectId, sprintValidatorPhase }, 'User confirmed start of development — advancing from Sprint Validator to Coder/Evaluator');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: sprintValidatorPhase,
      phaseName: sprintValidatorName,
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Helpers: metric accumulation across turns
  // -------------------------------------------------------------------------

  private createEmptyMetrics(): SpawnAgentResult['metrics'] {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 0,
      costUsd: 0,
      durationMs: 0,
    };
  }

  private mergeMetrics(
    accum: SpawnAgentResult['metrics'],
    result: SpawnAgentResult['metrics'],
  ): void {
    accum.inputTokens += result.inputTokens;
    accum.outputTokens += result.outputTokens;
    accum.cacheReadTokens += result.cacheReadTokens;
    accum.cacheCreationTokens += result.cacheCreationTokens;
    accum.toolUses += result.toolUses;
    accum.apiRequests += result.apiRequests;
    accum.costUsd += result.costUsd;
    accum.durationMs += result.durationMs;
  }

  private accumulateMetrics(
    state: PhaseState,
    phaseNumber: number,
    result: SpawnAgentResult,
  ): void {
    let accum = state.phaseMetricAccum.get(phaseNumber);
    if (!accum) {
      accum = { ...this.createEmptyMetrics(), model: result.model, runtime: result.runtime };
      state.phaseMetricAccum.set(phaseNumber, accum);
    }
    this.mergeMetrics(accum, result.metrics);
    accum.model = result.model;
    accum.runtime = result.runtime;

    // Emit incremental metrics IPC
    emitIPC('pipeline:metrics', {
      projectId: state.projectId,
      phaseNumber,
      metrics: { ...accum },
      model: result.model,
      runtime: result.runtime,
    });
  }

  private flushAccumulatedMetrics(
    projectId: string,
    phaseNumber: number,
    agentId: string,
    state: PhaseState,
    status: 'completed' | 'failed',
    projectCtx?: { pipelineType?: string },
  ): void {
    const accum = state.phaseMetricAccum.get(phaseNumber);
    if (!accum) return;

    const phaseName = (projectCtx ? getPhaseName(phaseNumber, projectCtx) : PHASE_NAMES[phaseNumber]) ?? `Phase ${phaseNumber}`;

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName,
      agentId,
      status,
      inputTokens: accum.inputTokens,
      outputTokens: accum.outputTokens,
      cacheReadTokens: accum.cacheReadTokens,
      cacheCreationTokens: accum.cacheCreationTokens,
      costUsd: accum.costUsd,
      durationMs: accum.durationMs,
      toolUses: accum.toolUses,
      apiRequests: accum.apiRequests,
      model: accum.model,
      runtime: accum.runtime,
      completedAt: new Date().toISOString(),
    });

    state.phaseMetricAccum.delete(phaseNumber);
  }

  // -------------------------------------------------------------------------
  // Private: resolve the model name for a given phase (for pipeline:phase-changed)
  // -------------------------------------------------------------------------

  private resolveCurrentModelForPhase(
    project: NonNullable<ReturnType<typeof getHarnessProject>>,
    phaseNumber: number,
    sprintIndex?: number,
  ): string | null {
    // Sprint execution phases: 10/13 = Coder, 11/14 = Evaluator
    if (sprintIndex !== undefined && [10, 11, 13, 14].includes(phaseNumber)) {
      const sprint = getHarnessSprintByIndex(project.id, sprintIndex);
      if (!sprint) return null;
      const agentId =
        phaseNumber === 10 || phaseNumber === 13
          ? sprint.coderAgentId
          : sprint.evaluatorAgentId;
      if (!agentId) return null;
      const agent = getAgent(agentId);
      return resolveModelForAgent(agent);
    }
    // All other phases: resolve via the phase-to-agent mapping
    const agentId = getPhaseAgentId(phaseNumber, project) ?? null;
    if (!agentId) return null;
    const agent = getAgent(agentId);
    return resolveModelForAgent(agent);
  }

  // -------------------------------------------------------------------------
  // Public: notify loop phase released (called by HarnessEngine when sprint ends)
  //
  // S4.2: NAO libera o lock per-projeto aqui. O lock so e liberado quando o
  // pipeline atinge estado terminal (done/failed/aborted) ou no recovery on
  // boot. Sprints intermediarios continuam segurando o lock pra impedir
  // segundo `pipeline:start` no mesmo projeto.
  // -------------------------------------------------------------------------

  releaseLoopPhase(projectId: string): void {
    logger.debug({ projectId }, 'releaseLoopPhase called (no-op pos-S4.2 — lock held until terminal state)');
  }

  // -------------------------------------------------------------------------
  // Public: get current phase state (for IPC queries)
  // -------------------------------------------------------------------------

  getCurrentPhase(projectId: string): { phase: number; status: string } | null {
    if (!this.states.has(projectId)) return null;
    const s = this.states.get(projectId)!;
    return { phase: s.currentPhase, status: s.status };
  }

  // -------------------------------------------------------------------------
  // Public API: runSprint — phases 13+14 loop
  // -------------------------------------------------------------------------

  /**
   * Run the Coder+Evaluator loop (phases 13/14) for a single sprint,
   * then automatically advance to the next sprint or mark the pipeline complete.
   *
   * Called by the IPC layer / HarnessEngine integration after the sprint plan
   * has been validated (phase 12 approved).
   */
  async runSprint(projectId: string, sprintIndex: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    // Resolve coder/evaluator phase numbers per pipelineType from the canonical
    // phases array (single source of truth). Hardcoded 10/11/13/14 was wrong for
    // architecture-review (coder=10, evaluator=11).
    const coderPhase = getPhaseNumberForAgent(project, 'harness-coder')
      ?? (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 10 : 13);
    const evaluatorPhase = getPhaseNumberForAgent(project, 'harness-evaluator')
      ?? (project.pipelineType === 'security' || project.pipelineType === 'architecture-review' ? 11 : 14);
    const coderPhaseName = getPhaseName(coderPhase, project) ?? `Phase ${coderPhase}`;

    const state = this.getState(projectId);
    state.currentSprintIndex = sprintIndex;
    state.currentPhase = coderPhase;
    state.status = 'running';

    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: coderPhase,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    const sprint = sprints[sprintIndex];
    logger.info({ projectId, sprintIndex, sprintName: sprint.name, coderPhase }, 'runSprint: starting coder+evaluator loop');

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: coderPhase,
      phaseName: coderPhaseName,
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    // S4.2: o lock per-projeto ja foi adquirido em pipeline:start. ensureProjectLock
    // e idempotente — no-op pra esse projeto. Pipelines de OUTROS projetos podem
    // rodar loops Coder/Evaluator em paralelo (cross-project livre per R7/D4).
    ensureProjectLock(projectId, 'pipeline-engine');

    // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream.
    // External runtime emits BOTH 'text_delta' (per-token chunks) and 'text' (full final
    // assistant response). Forward 'text_delta' so the UI sees streaming live, and SKIP
    // the final 'text' to avoid duplicating content already streamed via deltas.
    // Local/cloud paths only emit 'text' (no deltas), so 'text' continues being forwarded
    // for those — we detect external by presence of any earlier 'text_delta' for the same
    // (sprintId, round) tuple.
    const seenDeltas = new Set<string>();
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as { projectId?: string; agent?: string; sprintId?: string; round?: number; event?: { type?: string; content?: string; tool?: string } };
        if (d.projectId !== projectId || !d.event?.type) return;
        const phase = d.agent === 'evaluator' ? evaluatorPhase : coderPhase;
        const tupleKey = `${d.sprintId ?? ''}:${d.round ?? 0}:${d.agent ?? ''}`;

        if (d.event.type === 'text_delta' && d.event.content) {
          seenDeltas.add(tupleKey);
          emitIPC('pipeline:stream', { projectId, phase, type: 'text', content: d.event.content });
        } else if (d.event.type === 'text' && d.event.content) {
          // Skip final 'text' if we already streamed deltas for this round (external runtime).
          // For local/cloud (no deltas), forward as before.
          if (!seenDeltas.has(tupleKey)) {
            emitIPC('pipeline:stream', { projectId, phase, type: 'text', content: d.event.content });
          }
        } else if ((d.event.type === 'tool_use' || d.event.type === 'tool_call') && d.event.tool) {
          emitIPC('pipeline:stream', { projectId, phase, type: 'tool_call', tool: d.event.tool });
        } else if (d.event.type === 'thinking') {
          emitIPC('pipeline:stream', { projectId, phase, type: 'thinking' });
        }
      }
    });

    let sprintResult: import('../harness-engine').SprintResult;
    try {
      sprintResult = await this.harnessEngine.runSingleSprint(projectId, sprintIndex);
    } catch (err) {
      this.harnessEngine.clearStreamBridge();
      // S4.2: NAO libera o lock per-projeto aqui. O sprint falhou mas o pipeline
      // entra em 'paused' aguardando user — paused mantem o lock ativo (R7/D4).
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId, sprintIndex }, 'runSprint: aborted during coder/evaluator loop');
        return;
      }
      const errMsg = (err as Error).message;
      logger.error({ err, projectId, sprintIndex }, 'runSprint: HarnessEngine.runSingleSprint failed');
      emitIPC('pipeline:error', { projectId, phase: coderPhase, error: errMsg });
      state.status = 'paused';
      setProjectStatus(projectId, 'paused');
      return;
    }

    // Clear bridge
    this.harnessEngine.clearStreamBridge();

    // S4.2: NAO libera o lock per-projeto aqui. O loop terminou mas o pipeline
    // continua (proximo sprint ou advance). Lock so libera em terminal state
    // (done/failed/aborted) ou recovery on boot.

    if (state.abortController.signal.aborted) {
      logger.info({ projectId, sprintIndex }, 'runSprint: aborted after coder/evaluator loop');
      return;
    }

    // Persist aggregated metrics for Coder and Evaluator phases.
    // Each sprint gets its own row via the sprint_index column.
    // Use the ACTUAL agent IDs from the sprint config.
    const actualCoderAgent = sprint.coderAgentId || (getPhaseAgentId(coderPhase, project) ?? 'harness-coder');
    const actualEvaluatorAgent = sprint.evaluatorAgentId || (getPhaseAgentId(evaluatorPhase, project) ?? 'harness-evaluator');

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: coderPhase,
      sprintIndex,
      phaseName: getPhaseName(coderPhase, project) ?? `Phase ${coderPhase}`,
      agentId: actualCoderAgent,
      status: 'completed',
      inputTokens: sprintResult.coderMetrics.inputTokens,
      outputTokens: sprintResult.coderMetrics.outputTokens,
      cacheReadTokens: sprintResult.coderMetrics.cacheTokens,
      cacheCreationTokens: 0,
      costUsd: sprintResult.coderMetrics.costUsd,
      durationMs: sprintResult.coderMetrics.durationMs,
      toolUses: sprintResult.coderMetrics.toolUses,
      apiRequests: sprintResult.coderMetrics.apiRequests,
      model: sprintResult.coderMetrics.model ?? undefined,
      runtime: sprintResult.coderMetrics.runtime ?? undefined,
      completedAt: new Date().toISOString(),
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: evaluatorPhase,
      sprintIndex,
      phaseName: getPhaseName(evaluatorPhase, project) ?? `Phase ${evaluatorPhase}`,
      agentId: actualEvaluatorAgent,
      status: 'completed',
      inputTokens: sprintResult.evaluatorMetrics.inputTokens,
      outputTokens: sprintResult.evaluatorMetrics.outputTokens,
      cacheReadTokens: sprintResult.evaluatorMetrics.cacheTokens,
      cacheCreationTokens: 0,
      costUsd: sprintResult.evaluatorMetrics.costUsd,
      durationMs: sprintResult.evaluatorMetrics.durationMs,
      toolUses: sprintResult.evaluatorMetrics.toolUses,
      apiRequests: sprintResult.evaluatorMetrics.apiRequests,
      model: sprintResult.evaluatorMetrics.model ?? undefined,
      runtime: sprintResult.evaluatorMetrics.runtime ?? undefined,
      completedAt: new Date().toISOString(),
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: sprintResult.verdict,
      rounds: sprintResult.rounds,
      metrics: sprintResult.metrics,
    });

    logger.info(
      { projectId, sprintIndex, verdict: sprintResult.verdict, rounds: sprintResult.rounds },
      'runSprint: coder+evaluator loop done — advancing to next sprint or completing pipeline',
    );

    // Automatically advance to next sprint or mark pipeline as complete
    const allSprints = getHarnessSprints(projectId);
    const nextSprintIndex = sprintIndex + 1;

    if (nextSprintIndex < allSprints.length) {
      // More sprints remaining — advance automatically
      this.updateProjectColumns(projectId, { pipelineSprintIndex: nextSprintIndex });
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: coderPhase,
        phaseName: coderPhaseName,
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: allSprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      // Last sprint completed — pipeline is done. Kill all codex processes.
      this.closeCodexSessions(state);
      state.status = 'idle';
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      // S4.2: terminal state (done) — libera lock per-projeto.
      releaseProjectLock(projectId);
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
        metadata: { totalSprints: allSprints.length },
      });

      // ---- feat-026: Resolution Tracker (security pipeline only) ----
      if (project.pipelineType === 'security') {
        void this.runResolutionTracker(projectId, project).catch((err) => {
          logger.error({ err, projectId }, 'Resolution Tracker failed (non-fatal)');
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API: acceptSprint / rejectSprint — user decision after max loops
  // -------------------------------------------------------------------------

  /**
   * Accept the current sprint with restrictions after max loops were exhausted.
   * Marks the sprint as accepted and advances to the next sprint (or completes
   * the pipeline if this was the last sprint).
   */
  async acceptSprint(projectId: string, sprintIndex: number): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId, sprintIndex }, 'acceptSprint: pipeline aborted');
      return;
    }

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    const sprint = sprints[sprintIndex];
    logger.info({ projectId, sprintIndex, sprintName: sprint.name }, 'acceptSprint: user accepted sprint with restrictions');

    // Mark sprint as accepted (treat as passed despite failing evaluator)
    updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });

    emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: 'accepted-with-restrictions',
      rounds: sprint.roundsUsed ?? 0,
      metrics: {},
    });

    // Advance to next sprint or complete the pipeline
    const acceptProject = getHarnessProject(projectId);
    const acceptCoderPhase = (acceptProject ? getPhaseNumberForAgent(acceptProject, 'harness-coder') : undefined) ?? 13;
    const acceptCoderName = (acceptProject ? getPhaseName(acceptCoderPhase, acceptProject) : PHASE_NAMES[13]) ?? `Phase ${acceptCoderPhase}`;

    const nextSprintIndex = sprintIndex + 1;
    if (nextSprintIndex < sprints.length) {
      this.updateProjectColumns(projectId, { pipelineSprintIndex: nextSprintIndex, status: 'running' });
      state.status = 'running';
      state.abortController = new AbortController();
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: acceptCoderPhase,
        phaseName: acceptCoderName,
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: sprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      // Last sprint completed — pipeline is done. Kill all codex processes.
      this.closeCodexSessions(state);
      state.status = 'idle';
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      // S4.2: terminal state (done) — libera lock per-projeto.
      releaseProjectLock(projectId);
      emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
        metadata: { totalSprints: sprints.length },
      });

      // Resolution Tracker for security pipeline
      if (acceptProject?.pipelineType === 'security') {
        void this.runResolutionTracker(projectId, acceptProject).catch((err) => {
          logger.error({ err, projectId }, 'Resolution Tracker failed (non-fatal)');
        });
      }
    }
  }

  /**
   * Reject the current sprint after max loops were exhausted and re-run it.
   * Resets the sprint status and reruns the coder+evaluator loop from scratch.
   * The sprintIndex parameter identifies which sprint to retry.
   */
  async rejectSprint(projectId: string, sprintIndex: number): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId, sprintIndex }, 'rejectSprint: pipeline aborted');
      return;
    }

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (project has ${sprints.length} sprints)`);
    }

    const sprint = sprints[sprintIndex];
    logger.info({ projectId, sprintIndex, sprintName: sprint.name }, 'rejectSprint: user rejected sprint — retrying');

    const rejectProject = getHarnessProject(projectId);
    const rejectCoderPhase = (rejectProject ? getPhaseNumberForAgent(rejectProject, 'harness-coder') : undefined) ?? 13;
    const rejectCoderName = (rejectProject ? getPhaseName(rejectCoderPhase, rejectProject) : PHASE_NAMES[13]) ?? `Phase ${rejectCoderPhase}`;

    // Reset sprint to pending so it can be re-executed
    updateHarnessSprint(sprint.id, { status: 'pending', completedAt: null });

    state.status = 'running';
    state.abortController = new AbortController();
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: rejectCoderPhase,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    emitIPC('pipeline:phase-changed', {
      projectId,
      phase: rejectCoderPhase,
      phaseName: rejectCoderName,
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name, retrying: true },
    });

    await this.runSprint(projectId, sprintIndex);
  }

  // -------------------------------------------------------------------------
  // Public API: getPipelineReport — metrics summary at any point in time
  // -------------------------------------------------------------------------

  /**
   * Return aggregated pipeline metrics from the DB for a project.
   * Safe to call at any point in the pipeline execution.
   */
  getPipelineReport(projectId: string): PipelineMetrics {
    return getPipelineMetrics(projectId);
  }

  // -------------------------------------------------------------------------
  // Public API: resetPhase — reset a phase and everything after it
  // -------------------------------------------------------------------------

  /**
   * Reset the pipeline to a given phase.
   *
   * Only phases in RESETABLE_PHASES (1, 2, 4, 9, 11, 12) can be reset.
   * The method:
   *   1. Validates the phase is resetable.
   *   2. Aborts any in-flight execution for this project.
   *   3. Deletes artifact files produced from that phase onwards.
   *   4. Deletes DB rows (pipeline_messages, pipeline_phase_metrics, harness_sprints) from the phase.
   *   5. Updates the project status to idle at the reset phase.
   *   6. Emits pipeline:reset-complete to the renderer.
   *   7. If the phase is an AUTO phase, restarts it immediately.
   */
  async resetPhase(projectId: string, phase: number): Promise<{ ok: boolean; error?: string }> {
    const project = getHarnessProject(projectId);
    if (!project) return { ok: false, error: 'Project not found' };

    const resetablePhases = getResetablePhases(project);
    if (!resetablePhases.has(phase)) {
      return { ok: false, error: `Phase ${phase} is not resetable` };
    }

    const state = this.getState(projectId);

    // Abort any running execution
    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    // Clear all continue sessions so the next turn starts fresh
    state.continueSessions.clear();

    // Clear stale codex session refs. We do NOT kill the underlying codex processes
    // here — they're harmless when idle and only get killed at pipeline completion
    // (status='done') or abort. The threadIds in the Map are invalid after reset
    // anyway, so simply forgetting them is enough.
    state.codexSessions.clear();

    // Clear accumulated metrics for phases being reset
    for (const [phaseNum] of state.phaseMetricAccum) {
      if (phaseNum >= phase) {
        state.phaseMetricAccum.delete(phaseNum);
      }
    }

    // Refresh the abort controller so the engine can run again
    state.abortController = new AbortController();
    state.status = 'idle';
    state.currentPhase = phase;

    // Total reset (back to phase 1): rotate pipelineDocsId for feature/security projects.
    // The old Docs<id>/ folder is preserved on disk as historical record (Option A).
    if (
      phase === 1 &&
      (project.pipelineType === 'feature' || project.pipelineType === 'security') &&
      project.pipelineDocsId
    ) {
      const oldDocsId = project.pipelineDocsId;
      const newDocsId = generatePipelineDocsId();
      updateHarnessProject(projectId, {
        pipelineDocsId: newDocsId,
        specPath: null,
        prdPath: null,
        sprintsJsonPath: null,
      } as never);
      logger.info(
        { projectId, oldDocsId, newDocsId, pipelineType: project.pipelineType },
        'Total pipeline reset: rotated pipelineDocsId, old docs folder preserved',
      );
    }

    // Delete artifact files using project-type-appropriate map.
    const mapping = getPhaseArtifactMap(phase, project);
    if (!mapping) {
      return { ok: false, error: `No artifact map for phase ${phase}` };
    }

    // Architecture-review: paths in mapping.files are basename stems (e.g.
    // 'ArchitectureCandidates') OR the literal '*' meaning "delete all run dir".
    // Resolve them against the run dir (not the project root).
    if (project.pipelineType === 'architecture-review') {
      const ctx = getArchitectureReviewContext(project);
      if (ctx) {
        if (mapping.files.includes('*')) {
          // Total reset of phase 1: nuke the entire run dir AND clear runId so a
          // new fase 1 generates a fresh runId. selectedCandidateId also clears.
          try {
            fs.rmSync(ctx.runDir, { recursive: true, force: true });
            logger.info({ projectId, runDir: ctx.runDir }, 'Architecture reset phase 1: deleted runDir');
          } catch (err) {
            logger.warn({ err, projectId, runDir: ctx.runDir }, 'Failed to delete architecture runDir');
          }
          updateHarnessProject(projectId, {
            specPath: '',
            sprintsJsonPath: null,
            config: {
              ...project.config,
              architectureReview: {
                selectedCandidateId: null,
                // runId intentionally omitted so next ensureArchitectureReviewContext
                // generates a fresh one.
              },
            },
          });
        } else {
          // Partial reset: delete files that match the basename stems for this run.
          // Stems map to files like ArchitectureCandidates-<runId>.{md,json}, SPEC-<runId>.md,
          // sprints-<runId>.json. Use the manifest's documents map to resolve canonical paths.
          const stemToPaths: Record<string, string[]> = {
            ArchitectureCandidates: [ctx.candidatesMdPath, ctx.candidatesJsonPath],
            ArchitectureDiagnosis:  [ctx.diagnosisMdPath, ctx.diagnosisJsonPath],
            ArchitectureDecisions:  [ctx.decisionsMdPath, ctx.decisionsJsonPath],
            SPEC:                   [ctx.specPath, ctx.specSourcePath],
            sprints:                [ctx.sprintsPath],
          };
          for (const stem of mapping.files) {
            const paths = stemToPaths[stem] ?? [];
            for (const p of paths) {
              try {
                fs.rmSync(p, { force: true });
              } catch {
                // ignore — file may not exist
              }
            }
          }
          // If SPEC was deleted, clear spec_path in DB so fase 5 regenerates.
          if (mapping.files.includes('SPEC')) {
            updateHarnessProject(projectId, { specPath: '' });
          }
        }
      }
    } else {
      const projectRoot = project.projectPath;
      for (const file of mapping.files) {
        const fullPath = path.join(projectRoot, file);
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {
          // Ignore — file may not exist yet
        }
      }
    }

    // Delete DB records
    deletePipelineMessagesFromPhase(projectId, mapping.fromPhase);
    deletePipelinePhaseMetricsFromPhase(projectId, mapping.fromPhase);
    if (mapping.wipeSprints) {
      deleteHarnessSprintsForProject(projectId);
    }

    // Update project status in DB
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: phase,
      status: 'idle',
    });

    logger.info({ projectId, phase, pipelineType: project.pipelineType }, 'Pipeline reset to phase');

    emitIPC('pipeline:reset-complete', { projectId, phase });

    // R7 estrito: pipeline pos-reset (auto OU conversation) ainda eh "pipeline em
    // andamento" do ponto de vista do projeto — conversation aguarda user input
    // mas continua sendo o pipeline ativo deste projeto. Manter lock ate atingir
    // estado terminal (done/failed/aborted) ou novo reset.
    const autoPhases = getAutoPhases(project);
    if (autoPhases.has(phase)) {
      // Auto phase: kick off em background (IPC resolve e dialog fecha).
      // runAutoPhase libera o lock quando atingir done/failed/aborted.
      void this.runAutoPhase(projectId, phase).catch((err) => {
        logger.error(
          { err, projectId, phase },
          'Background runAutoPhase after resetPhase failed',
        );
        // Liberar lock se a fase em background morrer antes de terminal.
        releaseProjectLock(projectId);
        emitIPC('pipeline:error', {
          projectId,
          phase,
          error: (err as Error).message,
        });
      });
    }
    // Conversation phase: lock fica retido ate user enviar a primeira mensagem
    // (pipeline:send) ou avancar (pipeline:approve), garantindo que ninguem
    // inicie outro pipeline no mesmo projeto enquanto este aguarda input.

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Public API: resetSprint — reset a single sprint and re-run from it
  // -------------------------------------------------------------------------

  /**
   * Reset a specific sprint by index.
   *
   * Deletes the round data, messages, and metrics for that sprint, resets its
   * status to pending, and then re-runs it followed by any remaining pending
   * sprints.
   */
  async resetSprint(projectId: string, sprintIndex: number): Promise<{ ok: boolean; error?: string }> {
    const sprint = getHarnessSprintByIndex(projectId, sprintIndex);
    if (!sprint) {
      return { ok: false, error: `Sprint ${sprintIndex} not found` };
    }

    const state = this.getState(projectId);

    // Abort if this sprint is currently running
    if (state.currentSprintIndex === sprintIndex && !state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    // Delete all data associated with this sprint
    deleteHarnessRoundsForSprint(projectId, sprintIndex);
    deletePipelineMessagesForSprint(projectId, sprintIndex);
    deletePipelinePhaseMetricsForSprint(projectId, sprintIndex);

    // Reset sprint back to pending
    resetHarnessSprintStatus(projectId, sprintIndex);

    logger.info({ projectId, sprintIndex }, 'Sprint reset to pending');

    emitIPC('pipeline:sprint-reset', { projectId, sprintIndex });

    // Refresh abort controller and state
    state.abortController = new AbortController();
    state.status = 'running';

    const resetSprintProject = getHarnessProject(projectId);
    const resetCoderPhase = (resetSprintProject ? getPhaseNumberForAgent(resetSprintProject, 'harness-coder') : undefined) ?? 13;

    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: resetCoderPhase,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    // Pick the first pending sprint (which may be the reset one or an earlier one)
    // and kick it off in the BACKGROUND. We intentionally do NOT await: runSprint
    // drives the Coder+Evaluator loop which can run for minutes, and the caller
    // (IPC -> ResetConfirmDialog "Resetando..." button) needs the promise to
    // resolve immediately so the dialog closes. The UI reacts to streaming
    // events (pipeline:phase-changed, pipeline:stream, pipeline:sprint-reset)
    // as the sprint progresses.
    const allSprints = getHarnessSprints(projectId);
    const nextPending = allSprints.find((s) => s.status === 'pending');
    if (nextPending) {
      void this.runSprint(projectId, nextPending.sprintIndex).catch((err) => {
        logger.error(
          { err, projectId, sprintIndex: nextPending.sprintIndex },
          'Background runSprint after resetSprint failed',
        );
        emitIPC('pipeline:error', {
          projectId,
          phase: resetCoderPhase,
          error: (err as Error).message,
        });
      });
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Public API: getResetPreview — preview what will be deleted on reset
  // -------------------------------------------------------------------------

  /**
   * Return a preview of what a reset operation would delete, without
   * performing any destructive action.
   *
   * Accepts either `phase` or `sprintIndex` in the `target` object.
   */
  getResetPreview(
    projectId: string,
    target: { phase?: number; sprintIndex?: number },
  ): {
    filesToDelete: string[];
    messagesToDelete: number;
    metricsToDelete: number;
    sprintsAffected: number[];
  } {
    const empty = {
      filesToDelete: [] as string[],
      messagesToDelete: 0,
      metricsToDelete: 0,
      sprintsAffected: [] as number[],
    };

    const project = getHarnessProject(projectId);
    if (!project) return empty;

    const db = getDb();

    if (target.phase !== undefined) {
      const mapping = getPhaseArtifactMap(target.phase, project);
      if (!mapping) return empty;

      const projectRoot = project.projectPath;
      const filesToDelete = mapping.files
        .map((f) => path.join(projectRoot, f))
        .filter((f) => fs.existsSync(f));

      const msgRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pipeline_messages WHERE project_id = ? AND phase_number >= ?`,
        )
        .get(projectId, mapping.fromPhase) as { cnt: number };

      const metricRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pipeline_phase_metrics WHERE project_id = ? AND phase_number >= ?`,
        )
        .get(projectId, mapping.fromPhase) as { cnt: number };

      const sprintsAffected = mapping.wipeSprints
        ? getHarnessSprints(projectId).map((s) => s.sprintIndex)
        : [];

      return {
        filesToDelete,
        messagesToDelete: msgRow.cnt,
        metricsToDelete: metricRow.cnt,
        sprintsAffected,
      };
    }

    if (target.sprintIndex !== undefined) {
      const si = target.sprintIndex;

      const msgRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pipeline_messages WHERE project_id = ? AND sprint_index = ?`,
        )
        .get(projectId, si) as { cnt: number };

      const metricRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pipeline_phase_metrics WHERE project_id = ? AND sprint_index = ?`,
        )
        .get(projectId, si) as { cnt: number };

      return {
        filesToDelete: [],
        messagesToDelete: msgRow.cnt,
        metricsToDelete: metricRow.cnt,
        sprintsAffected: [si],
      };
    }

    return empty;
  }
}
