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
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import { processAgentStream } from './stream-processor';
import { ollamaChatWithTools } from './ollama-client';
import type { OllamaToolSchema } from './ollama-client';
import { calculateCost } from './pricing';
import {
  getHarnessProject,
  getAgent,
  getDb,
  savePipelinePhaseMetrics,
  savePipelineMessage,
  getHarnessSprints,
  getPipelineMetrics,
  updateHarnessProject,
  updateHarnessSprint,
  updateHarnessRound,
  deletePipelineMessagesFromPhase,
  deletePipelinePhaseMetricsFromPhase,
  deletePipelineMessagesForSprint,
  deletePipelinePhaseMetricsForSprint,
  deleteHarnessRoundsForSprint,
  resetHarnessSprintStatus,
  deleteHarnessSprintsForProject,
  getHarnessSprintByIndex,
} from './db';
import type { PipelineMetrics } from './db';
import type { PipelineProject, PipelinePhaseNumber } from '../../src/types/pipeline';
import { HarnessEngine } from './harness-engine';
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
} from './seed-agents/index';

const logger = createLogger('pipeline-engine');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Auto-advance phases: these transition to the next phase automatically. */
const AUTO_PHASES = new Set([2, 4, 9, 11]);

/** Loop phases (Coder/Evaluator): only one allowed globally at a time. */
const LOOP_PHASES = new Set([13, 14]);

/** Phases that can be reset by the user. */
const RESETABLE_PHASES = new Set([1, 2, 4, 9, 11, 12]);

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

// Discovery block definitions (Phase 1)
const DISCOVERY_BLOCKS: ReadonlyArray<{
  name: string;
  questions: string;
  section: string;
}> = [
  {
    name: 'Visao',
    questions: 'Q1 (problema), Q2 (usuario principal), Q3 (referencia) e o Pitch validado',
    section: '## Visao',
  },
  {
    name: 'Funcionalidades',
    questions: 'Q4 (core features), Q5 (integracoes)',
    section: '## Funcionalidades',
  },
  {
    name: 'Monetizacao',
    questions: 'Q6 (modelo), Q7 (planos)',
    section: '## Monetizacao',
  },
  {
    name: 'Tecnico',
    questions: 'Q8 (stack), Q9 (plataforma)',
    section: '## Tecnico',
  },
  {
    name: 'Contexto',
    questions: 'Q10 (referencias visuais), Q11 (notas adicionais)',
    section: '## Contexto',
  },
];

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
  /** Accumulated metrics per phase for incremental saving. */
  phaseMetricAccum: Map<number, SpawnAgentResult['metrics'] & { model: string; runtime: 'cloud' | 'local' }>;
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
  runtime: 'cloud' | 'local';
}

/** Options passed to spawnAgent(). */
interface SpawnAgentOptions {
  projectId: string;
  phaseNumber: number;
  cwd: string;
  abortController: AbortController;
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  /** When true, uses continue:true for same-session follow-up turns. */
  continueSession?: boolean;
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
// Helper: resolve Claude Code CLI path (same pattern as harness-engine)
// ---------------------------------------------------------------------------

function getClaudeCodeExecutablePath(): string {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return path.join(path.dirname(sdkEntry), 'cli.js');
  } catch {
    const projectRoot = path.join(__dirname, '..', '..');
    return path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  }
}

// ---------------------------------------------------------------------------
// Helper: convert builtin tool names to OllamaToolSchema stubs
// (duplicated from harness-engine to keep pipeline-engine self-contained)
// ---------------------------------------------------------------------------

function builtinToolsToOllamaSchemas(toolNames: string[]): OllamaToolSchema[] {
  const SCHEMAS: Record<string, OllamaToolSchema> = {
    Read: {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read the contents of a file from the filesystem.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            offset: { type: 'number', description: 'Line offset (0-based).' },
            limit: { type: 'number', description: 'Max lines to read.' },
          },
          required: ['file_path'],
        },
      },
    },
    Write: {
      type: 'function',
      function: {
        name: 'Write',
        description: 'Write content to a file, creating it if necessary.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            content: { type: 'string', description: 'Content to write.' },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    Edit: {
      type: 'function',
      function: {
        name: 'Edit',
        description: 'Replace a substring in a file with new content.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            old_string: { type: 'string', description: 'Exact string to replace.' },
            new_string: { type: 'string', description: 'Replacement string.' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    Glob: {
      type: 'function',
      function: {
        name: 'Glob',
        description: 'Find files matching a glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern to match.' },
            path: { type: 'string', description: 'Base directory path.' },
          },
          required: ['pattern'],
        },
      },
    },
    Grep: {
      type: 'function',
      function: {
        name: 'Grep',
        description: 'Search for a regex pattern in files.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search.' },
            path: { type: 'string', description: 'Directory or file to search.' },
            glob: { type: 'string', description: 'File glob filter.' },
          },
          required: ['pattern'],
        },
      },
    },
    Bash: {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Execute a shell command.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            timeout: { type: 'number', description: 'Timeout in milliseconds.' },
          },
          required: ['command'],
        },
      },
    },
  };

  return toolNames
    .filter((n) => !n.startsWith('mcp__'))
    .map((n) => SCHEMAS[n])
    .filter((s): s is OllamaToolSchema => s !== undefined);
}

// ---------------------------------------------------------------------------
// Global concurrency: at most one loop phase (13/14) running at a time
// ---------------------------------------------------------------------------

let _activeLoopProjectId: string | null = null;

function acquireLoopSlot(projectId: string): boolean {
  if (_activeLoopProjectId !== null && _activeLoopProjectId !== projectId) {
    return false;
  }
  _activeLoopProjectId = projectId;
  return true;
}

function releaseLoopSlot(projectId: string): void {
  if (_activeLoopProjectId === projectId) {
    _activeLoopProjectId = null;
  }
}

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

export class PipelineEngine {
  private getWindow: () => BrowserWindow | null;
  private states: Map<string, PhaseState> = new Map();

  /** HarnessEngine instance reused for phase 11 (Planner). */
  private harnessEngine: HarnessEngine;

  constructor(getWindow: () => BrowserWindow | null, harnessEngine: HarnessEngine) {
    this.getWindow = getWindow;
    this.harnessEngine = harnessEngine;
    this.recoverInterruptedPipelines();
  }

  // -------------------------------------------------------------------------
  // IPC helper
  // -------------------------------------------------------------------------

  private emitIPC(channel: string, data: unknown): void {
    try {
      const wins = BrowserWindow.getAllWindows();
      const win = wins[0] ?? null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Render frame disposed (e.g. GPU crash, window reload)
    }
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
      this.emitIPC('pipeline:project-updated', { projectId, patch });
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
        this.emitIPC('pipeline:agent-completed', { projectId });
        logger.info({ projectId, phase }, 'Agent signaled PHASE_COMPLETE');
      }

      const cleaned = chunk.replace(this.PHASE_COMPLETE_MARKER, '');
      if (cleaned.length > 0) {
        this.emitIPC('pipeline:stream', { projectId, phase, type: 'text', content: cleaned });
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
        phaseMetricAccum: new Map(),
        currentSprintIndex: persistedSprintIndex,
      });
    }
    return this.states.get(projectId)!;
  }

  private isConversationPhase(phase: number): boolean {
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
        this.updateProjectColumns(row.id, { status: 'paused' });
        this.emitIPC('pipeline:phase-changed', {
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

  async startPipeline(projectId: string, startPhase: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    logger.info({ projectId, startPhase }, 'Starting pipeline');

    const state = this.getState(projectId);
    state.abortController = new AbortController();
    state.currentPhase = startPhase;
    state.status = 'running';

    // If starting from phase 1, create discovery-notes.md template
    if (startPhase === 1) {
      const notesPath = path.join(project.projectPath, 'discovery-notes.md');
      if (!fs.existsSync(notesPath)) {
        fs.mkdirSync(project.projectPath, { recursive: true });
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
    const firstPhaseIsConversation = this.isConversationPhase(startPhase);
    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: startPhase,
      phaseName: PHASE_NAMES[startPhase] ?? `Phase ${startPhase}`,
      status: 'started',
      awaitingUser: firstPhaseIsConversation,
    });

    // Auto phases start immediately; conversation phases auto-send greeting
    if (AUTO_PHASES.has(startPhase)) {
      await this.runAutoPhase(projectId, startPhase);
    } else if (firstPhaseIsConversation) {
      // Auto-trigger the first AI message so the agent starts the conversation
      // (e.g. Discovery asks questions, Spec Validator starts analysis, etc.)
      const greetingMsg = this.getConversationGreeting(startPhase, project.name);
      await this.sendMessage(projectId, greetingMsg);
    }
    // Loop phases (13/14) require explicit advancePhase call in normal flow
  }

  /**
   * Returns an initial user-side message to kick off a conversation phase.
   * The agent will then respond with its questions / analysis.
   */
  private getConversationGreeting(phase: number, projectName: string): string {
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

    const nextPhase = state.currentPhase + 1;
    if (nextPhase > 14) {
      logger.info({ projectId }, 'Pipeline complete — no more phases');
      this.updateProjectColumns(projectId, {
        status: 'done',
        pipelineCurrentPhase: null,
      });
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'completed',
        awaitingUser: false,
      });
      return;
    }

    logger.info({ projectId, nextPhase }, 'Advancing pipeline to next phase');

    state.currentPhase = nextPhase;
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: nextPhase,
      status: 'running',
    });

    const isConversation = this.isConversationPhase(nextPhase);
    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: nextPhase,
      phaseName: PHASE_NAMES[nextPhase] ?? `Phase ${nextPhase}`,
      status: 'started',
      awaitingUser: isConversation,
    });

    if (AUTO_PHASES.has(nextPhase)) {
      await this.runAutoPhase(projectId, nextPhase);
    } else if (LOOP_PHASES.has(nextPhase)) {
      if (!acquireLoopSlot(projectId)) {
        logger.warn({ projectId, nextPhase }, 'Cannot start loop phase — another project is running a loop phase');
        this.emitIPC('pipeline:error', {
          projectId,
          phase: nextPhase,
          error: 'Outro projeto esta executando a fase de loop (Coder/Evaluator). Aguarde a conclusao.',
        });
        return;
      }
      // Loop phases are managed externally (HarnessEngine). Emit that we are ready.
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: nextPhase,
        phaseName: PHASE_NAMES[nextPhase] ?? `Phase ${nextPhase}`,
        status: 'loop-ready',
        awaitingUser: false,
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
    if (state.currentPhase !== null && LOOP_PHASES.has(state.currentPhase)) {
      try {
        this.harnessEngine.abort(projectId);
      } catch (err) {
        logger.warn({ err, projectId }, 'harnessEngine.abort during abort failed (non-fatal)');
      }
    }

    releaseLoopSlot(projectId);

    this.updateProjectColumns(projectId, {
      status: 'failed',
    });

    this.emitIPC('pipeline:phase-changed', {
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
    if (phase !== null && LOOP_PHASES.has(phase)) {
      try {
        this.harnessEngine.abort(projectId);
      } catch (err) {
        logger.warn({ err, projectId }, 'harnessEngine.abort during pause failed (non-fatal)');
      }
    }

    // Step 2: mark current auto-phase metrics as interrupted (phases 2, 4, 9, 11)
    if (phase !== null && AUTO_PHASES.has(phase)) {
      const phaseName = PHASE_NAMES[phase] ?? `Phase ${phase}`;
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: phase,
        phaseName,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      });
    }

    // Step 3: mark current sprint round as interrupted for loop phases (13, 14)
    if (phase !== null && LOOP_PHASES.has(phase)) {
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
          updateHarnessRound(roundRow.id, {
            completedAt: new Date().toISOString(),
          });
          logger.info({ projectId, sprintIndex, roundId: roundRow.id }, 'Marked in-progress round as interrupted');
        }
      }
    }

    // Step 4: set status in memory and DB
    state.status = 'paused';
    this.updateProjectColumns(projectId, { status: 'paused' });

    // Step 5: emit paused event — awaitingUser: false (paused is NOT waiting for input)
    this.emitIPC('pipeline:phase-changed', {
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
    const isConversation = this.isConversationPhase(phase);

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
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase,
        phaseName: PHASE_NAMES[phase] ?? `Phase ${phase}`,
        status: 'awaiting-input',
        awaitingUser: true,
      });
      return;
    }

    state.status = 'running';
    state.abortController = new AbortController();
    this.updateProjectColumns(projectId, { status: 'running' });

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName: PHASE_NAMES[phase] ?? `Phase ${phase}`,
      status: 'resumed',
      awaitingUser: false,
    });

    if (AUTO_PHASES.has(phase)) {
      await this.runAutoPhase(projectId, phase);
    } else if (LOOP_PHASES.has(phase)) {
      // Resume loop phase (13/14): restart from the current sprint index
      const sprintIndex = state.currentSprintIndex ?? 0;
      logger.info({ projectId, phase, sprintIndex }, 'Resuming loop phase via runSprint');
      await this.runSprint(projectId, sprintIndex);
    }
  }

  // -------------------------------------------------------------------------
  // Private: spawnAgent — cloud/local routing
  // -------------------------------------------------------------------------

  private async spawnAgent(
    agentId: string,
    prompt: string,
    opts: SpawnAgentOptions,
  ): Promise<SpawnAgentResult> {
    const config = await resolveAgentQueryConfig(agentId);
    const startedAt = Date.now();

    // ---- Local LLM path (Ollama / LM Studio / OpenAI-compatible) ----
    if (config.runtime === 'local') {
      const agentRecord = getAgent(agentId);
      if (!agentRecord?.localConfig) {
        throw new Error(`Agent ${agentId} has runtime=local but no localConfig`);
      }
      const localCfg = agentRecord.localConfig;
      const ollamaTools = builtinToolsToOllamaSchemas(config.allowedTools);

      const ollamaResult = await ollamaChatWithTools(
        localCfg.baseUrl,
        localCfg.model,
        config.systemPrompt,
        prompt,
        ollamaTools,
        {
          cwd: opts.cwd,
          onText: opts.onText,
          onToolUse: (record) => opts.onToolUse?.(record.tool),
          provider: localCfg.provider || 'ollama',
        },
      );

      const durationMs = Date.now() - startedAt;
      const costUsd = calculateCost(
        localCfg.model,
        ollamaResult.promptTokens,
        ollamaResult.tokensUsed,
        0,
        0,
      );

      return {
        output: ollamaResult.content,
        metrics: {
          inputTokens: ollamaResult.promptTokens,
          outputTokens: ollamaResult.tokensUsed,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          toolUses: ollamaResult.toolCalls.length,
          apiRequests: 1,
          costUsd,
          durationMs,
        },
        model: ollamaResult.model,
        runtime: 'local',
      };
    }

    // ---- Cloud SDK path ----
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const cliPath = getClaudeCodeExecutablePath();

    const mcpServersObj = config.mcpServers.length > 0
      ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
      : undefined;

    const phaseNumber = opts.phaseNumber;
    const permissionMode = 'bypassPermissions' as const;

    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: opts.cwd,
        model: config.model,
        systemPrompt: config.systemPrompt || '',
        allowedTools: config.allowedTools,
        permissionMode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: opts.abortController,
        ...(opts.continueSession ? { continue: true as const } : {}),
        ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
        ...(config.effort !== undefined ? { effort: config.effort } : {}),
        ...(config.thinking === 'enabled'
          ? {
              thinking: {
                type: 'enabled' as const,
                ...(config.thinkingBudget !== undefined ? { budgetTokens: config.thinkingBudget } : {}),
              },
            }
          : config.thinking === 'disabled'
            ? { thinking: { type: 'disabled' as const } }
            : {}),
        ...(mcpServersObj ? { mcpServers: mcpServersObj } : {}),
        stderr: (text: string) => {
          logger.info({ agentId, stderr: text.substring(0, 500) }, 'Agent stderr');
        },
      },
    }) as unknown as AsyncIterable<Record<string, unknown>>;

    const { output, metrics } = await processAgentStream(q, {
      shouldAbort: () => opts.abortController.signal.aborted,
      onText: opts.onText,
      onToolUse: opts.onToolUse,
    });

    const durationMs = Date.now() - startedAt;
    const costUsd = calculateCost(
      config.model,
      metrics.inputTokens,
      metrics.outputTokens,
      metrics.cacheReadTokens,
      metrics.cacheCreationTokens,
    );

    return {
      output,
      metrics: {
        ...metrics,
        costUsd,
        durationMs,
      },
      model: config.model,
      runtime: 'cloud',
    };
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
  ): void {
    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName: PHASE_NAMES[phaseNumber] ?? `Phase ${phaseNumber}`,
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

    this.emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber,
      metrics: result.metrics,
      model: result.model,
      runtime: result.runtime,
    });
  }

  // -------------------------------------------------------------------------
  // Private: runAutoPhase — phases 2, 4, 9, 11
  // -------------------------------------------------------------------------

  async runAutoPhase(projectId: string, phaseNumber: number): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const agentId = PHASE_AGENT_IDS[phaseNumber];
    const phaseName = PHASE_NAMES[phaseNumber] ?? `Phase ${phaseNumber}`;
    const state = this.getState(projectId);

    logger.info({ projectId, phaseNumber, phaseName, agentId }, 'Running auto phase');

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

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: phaseNumber,
      phaseName,
      status: 'running',
      awaitingUser: false,
    });

    try {
      if (phaseNumber === 2) {
        await this.runPhase2(projectId, project.projectPath, state);
      } else if (phaseNumber === 4) {
        await this.runPhase4(projectId, project.projectPath, state);
      } else if (phaseNumber === 9) {
        await this.runPhase9(projectId);
      } else if (phaseNumber === 11) {
        await this.runPhase11(projectId, state);
      } else {
        throw new Error(`Unknown auto phase: ${phaseNumber}`);
      }
    } catch (err) {
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

      this.updateProjectColumns(projectId, { status: 'paused' });
      state.status = 'paused';

      this.emitIPC('pipeline:error', { projectId, phase: phaseNumber, error: errorMsg });
      this.emitIPC('pipeline:phase-changed', {
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
    const discoveryNotesPath = path.join(projectPath, 'discovery-notes.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');

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
      onText: (chunk) => {
        phase2Output += chunk;
        this.emitIPC('pipeline:stream', { projectId, phase: 2, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 2, type: 'tool_call', tool: toolName });
      },
    });

    // Save complete assistant message (not per-chunk)
    if (phase2Output) {
      savePipelineMessage({ projectId, phaseNumber: 2, role: 'assistant', content: phase2Output });
    }

    this.collectMetrics(projectId, 2, PRD_GENERATOR_ID, result, 'completed');

    logger.info({ projectId, storiesPath }, 'Phase 2 completed — stories-requisitos.md generated');

    if (fs.existsSync(storiesPath)) {
      this.emitIPC('pipeline:document-updated', {
        projectId,
        path: storiesPath,
        content: fs.readFileSync(storiesPath, 'utf-8'),
      });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 2, type: 'done' });
    this.emitIPC('pipeline:phase-changed', {
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
    const discoveryNotesPath = path.join(projectPath, 'discovery-notes.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');
    const prdPath = path.join(projectPath, 'PRD.md');

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
      onText: (chunk) => {
        phase4Output += chunk;
        this.emitIPC('pipeline:stream', { projectId, phase: 4, type: 'text', content: chunk });
      },
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 4, type: 'tool_call', tool: toolName });
      },
    });

    // Save complete assistant message (not per-chunk)
    if (phase4Output) {
      savePipelineMessage({ projectId, phaseNumber: 4, role: 'assistant', content: phase4Output });
    }

    this.collectMetrics(projectId, 4, PRD_GENERATOR_ID, result, 'completed');

    // Persist PRD path in DB
    this.updateProjectColumns(projectId, { prdPath });

    logger.info({ projectId, prdPath }, 'Phase 4 completed — PRD.md generated');

    if (fs.existsSync(prdPath)) {
      this.emitIPC('pipeline:document-updated', {
        projectId,
        path: prdPath,
        content: fs.readFileSync(prdPath, 'utf-8'),
      });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 4, type: 'done' });
    this.emitIPC('pipeline:phase-changed', {
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

    // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as { projectId?: string; event?: { type?: string; content?: string; tool?: string } };
        if (d.projectId !== projectId || !d.event?.type) return;
        if (d.event.type === 'text' && d.event.content) {
          this.emitIPC('pipeline:stream', { projectId, phase: 11, type: 'text', content: d.event.content });
        } else if (d.event.type === 'tool_use' && d.event.tool) {
          this.emitIPC('pipeline:stream', { projectId, phase: 11, type: 'tool_call', tool: d.event.tool });
        } else if (d.event.type === 'thinking') {
          this.emitIPC('pipeline:stream', { projectId, phase: 11, type: 'thinking' });
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

    // Collect basic metrics for phase 11 (planner metrics are already on the harness_project row)
    const project = getHarnessProject(projectId);
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

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 11,
      phaseName: PHASE_NAMES[11],
      agentId: PHASE_AGENT_IDS[11],
      status: 'completed',
      inputTokens: plannerMetrics.inputTokens,
      outputTokens: plannerMetrics.outputTokens,
      cacheReadTokens: plannerMetrics.cacheReadTokens,
      cacheCreationTokens: plannerMetrics.cacheCreationTokens,
      costUsd: plannerMetrics.costUsd,
      durationMs: plannerMetrics.durationMs,
      toolUses: plannerMetrics.toolUses,
      apiRequests: plannerMetrics.apiRequests,
      model: project?.config.plannerAgentId ?? PHASE_AGENT_IDS[11],
      completedAt: new Date().toISOString(),
    });

    this.emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber: 11,
      metrics: plannerMetrics,
    });

    logger.info({ projectId }, 'Phase 11 (Planner) completed');

    // Emit sprints data so UI can populate the sprint list when entering phase 12
    const sprintsAfterPlan = getHarnessSprints(projectId);
    this.emitIPC('pipeline:sprints-loaded', {
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
      const sprintsJsonPath = projectAfterPlan.sprintsJsonPath
        ?? path.join(projectAfterPlan.projectPath, 'sprints.json');
      if (fs.existsSync(sprintsJsonPath)) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: sprintsJsonPath,
          content: fs.readFileSync(sprintsJsonPath, 'utf-8'),
        });
      }
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 11, type: 'done' });
    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 11,
      phaseName: PHASE_NAMES[11],
      status: 'completed',
      awaitingUser: false,
    });

    // Auto-advance to phase 12 (conversation)
    await this.advanceToNextPhase(projectId, state);
  }

  // -------------------------------------------------------------------------
  // Private: advanceToNextPhase — internal auto-advance helper
  // -------------------------------------------------------------------------

  private async advanceToNextPhase(projectId: string, state: PhaseState): Promise<void> {
    if (state.abortController.signal.aborted || state.status === 'aborted') {
      return;
    }

    const nextPhase = state.currentPhase + 1;
    if (nextPhase > 14) {
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
      });
      return;
    }

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

    const isConversation = this.isConversationPhase(nextPhase);

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: nextPhase,
      phaseName: PHASE_NAMES[nextPhase] ?? `Phase ${nextPhase}`,
      status: 'started',
      awaitingUser: isConversation,
    });

    if (AUTO_PHASES.has(nextPhase)) {
      // Consecutive auto phases chain automatically
      await this.runAutoPhase(projectId, nextPhase);
    } else if (LOOP_PHASES.has(nextPhase)) {
      // Loop phases (13/14): auto-start the sprint from the current sprint index
      const sprintIndex = state.currentSprintIndex ?? 0;
      logger.info({ projectId, nextPhase, sprintIndex }, 'Auto-starting loop phase via runSprint');
      await this.runSprint(projectId, sprintIndex);
    } else if (isConversation) {
      // Auto-trigger the first AI message so the agent starts the conversation
      const project = getHarnessProject(projectId);
      const greetingMsg = this.getConversationGreeting(nextPhase, project?.name ?? projectId);
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
  ): Promise<void> {
    const state = this.getState(projectId);

    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'sendMessage: pipeline aborted');
      return;
    }

    const phase = state.currentPhase;

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

    // Save user message (original text, not the path-enriched version)
    savePipelineMessage({ projectId, phaseNumber: phase, role: 'user', content: message });

    // Emit thinking indicator immediately so the UI shows processing state
    this.emitIPC('pipeline:stream', { projectId, phase, type: 'thinking' });

    try {
      switch (phase) {
        case 1:
          await this.handlePhase1Message(projectId, finalMessage, state);
          break;
        case 3:
          await this.handlePhase3Message(projectId, finalMessage, state);
          break;
        case 5:
          await this.handleTechPhaseMessage(projectId, finalMessage, state, 5, TECH_DATABASE_ID);
          break;
        case 6:
          await this.handleTechPhaseMessage(projectId, finalMessage, state, 6, TECH_BACKEND_ID);
          break;
        case 7:
          await this.handleTechPhaseMessage(projectId, finalMessage, state, 7, TECH_FRONTEND_ID);
          break;
        case 8:
          await this.handleTechPhaseMessage(projectId, finalMessage, state, 8, TECH_SECURITY_ID);
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
    } catch (err) {
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'sendMessage: error');
      this.emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
      this.emitIPC('pipeline:stream', { projectId, phase, type: 'done' });
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

    try {
      switch (phase) {
        case 1:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 3:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 5:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 6:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 7:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 8:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 9:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 10:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        case 12:
          await this.finalizeConversationPhase(projectId, phase, state);
          break;
        default:
          logger.warn({ projectId, phase }, 'approvePhase: no handler for this phase');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        return;
      }
      logger.error({ err, projectId, phase }, 'approvePhase: error');
      this.emitIPC('pipeline:error', { projectId, phase, error: (err as Error).message });
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

    const notesPath = project.discoveryNotesPath ?? path.join(project.projectPath, 'discovery-notes.md');
    const isFirstTurn = !sessionEntry.alive;

    // On first turn, include the notes path context
    const prompt = isFirstTurn
      ? `Arquivo de notas do discovery: ${notesPath}\n\nMensagem do usuario: ${message}`
      : message;

    const previousNotesContent = fs.existsSync(notesPath)
      ? fs.readFileSync(notesPath, 'utf-8')
      : '';

    const phase1Acc = { text: '', completed: false };
    const result = await this.spawnAgent(DISCOVERY_AGENT_ID, prompt, {
      projectId,
      phaseNumber: 1,
      cwd: project.projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      onText: this.makeConversationOnText(projectId, 1, phase1Acc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 1, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;

    // Accumulate metrics
    this.accumulateMetrics(state, 1, result);

    // Check if notes were updated
    if (fs.existsSync(notesPath)) {
      const currentNotesContent = fs.readFileSync(notesPath, 'utf-8');
      if (currentNotesContent !== previousNotesContent) {
        this.emitIPC('pipeline:notes-updated', {
          projectId,
          path: notesPath,
          content: currentNotesContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase1CleanedText = phase1Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase1CleanedText) {
      savePipelineMessage({ projectId, phaseNumber: 1, role: 'assistant', content: phase1CleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 1, type: 'done' });
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
    const discoveryNotesPath = path.join(projectPath, 'discovery-notes.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');
    const reportPath = path.join(projectPath, '.prd-validation-report.md');

    const isFirstTurn = !sessionEntry.alive;

    const previousStoriesContent = fs.existsSync(storiesPath)
      ? fs.readFileSync(storiesPath, 'utf-8')
      : '';

    let prompt: string;
    if (isFirstTurn) {
      // First turn: full analysis with instruction to edit stories-requisitos.md directly
      const prdPath = this.resolvePrdPath(project);
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
    const result = await this.spawnAgent(PRD_VALIDATOR_ID, prompt, {
      projectId,
      phaseNumber: 3,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      onText: this.makeConversationOnText(projectId, 3, phase3Acc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 3, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 3, result);

    if (fs.existsSync(storiesPath)) {
      const currentStoriesContent = fs.readFileSync(storiesPath, 'utf-8');
      if (currentStoriesContent !== previousStoriesContent) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: storiesPath,
          content: currentStoriesContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase3CleanedText = phase3Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase3CleanedText) {
      savePipelineMessage({ projectId, phaseNumber: 3, role: 'assistant', content: phase3CleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 3, type: 'done' });
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
    const notesPath = project.discoveryNotesPath ?? path.join(projectPath, 'discovery-notes.md');
    const prdPath = this.resolvePrdPath(project) ?? path.join(projectPath, 'PRD.md');
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
      onText: this.makeConversationOnText(projectId, phaseNumber, techAcc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, phaseNumber, result);

    if (fs.existsSync(prdPath)) {
      const currentPrdContent = fs.readFileSync(prdPath, 'utf-8');
      if (currentPrdContent !== previousPrdContent) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: prdPath,
          content: currentPrdContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const techCleanedText = techAcc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (techCleanedText) {
      savePipelineMessage({ projectId, phaseNumber, role: 'assistant', content: techCleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: phaseNumber, type: 'done' });
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
    const specPath = project.specPath ?? path.join(projectPath, 'SPEC.md');
    const prdPath = this.resolvePrdPath(project) ?? path.join(projectPath, 'PRD.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');
    const suggestionsPath = path.join(projectPath, '.spec-enricher-suggestions.md');

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
      onText: this.makeConversationOnText(projectId, 10, phase10Acc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 10, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 10, result);

    if (fs.existsSync(specPath)) {
      const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: currentSpecContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase10CleanedText = phase10Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase10CleanedText) {
      savePipelineMessage({ projectId, phaseNumber: 10, role: 'assistant', content: phase10CleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 10, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phase 12: Sprint Validator (session persists across turns for context)
  // -------------------------------------------------------------------------

  private async handlePhase12Message(
    projectId: string,
    message: string,
    state: PhaseState,
  ): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const sessionKey = 'phase12';
    let sessionEntry = state.continueSessions.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = { alive: false };
      state.continueSessions.set(sessionKey, sessionEntry);
    }

    const projectPath = project.projectPath;
    const specPath = project.specPath ?? path.join(projectPath, 'SPEC.md');
    const sprintsPath = project.sprintsJsonPath ?? path.join(projectPath, 'sprints.json');
    const reportPath = path.join(projectPath, '.sprint-validation-report.md');

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
      phaseNumber: 12,
      cwd: projectPath,
      abortController: state.abortController,
      continueSession: sessionEntry.alive,
      onText: this.makeConversationOnText(projectId, 12, phase12Acc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 12, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 12, result);

    if (fs.existsSync(sprintsPath)) {
      const currentSprintsContent = fs.readFileSync(sprintsPath, 'utf-8');
      if (currentSprintsContent !== previousSprintsContent) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: sprintsPath,
          content: currentSprintsContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase12CleanedText = phase12Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase12CleanedText) {
      savePipelineMessage({ projectId, phaseNumber: 12, role: 'assistant', content: phase12CleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 12, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Phase 9: Spec Generation — auto loop spec-builder -> spec-validator
  // -------------------------------------------------------------------------

  async runPhase9(projectId: string): Promise<void> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const state = this.getState(projectId);
    const projectPath = project.projectPath;
    const prdPath = this.resolvePrdPath(project) ?? path.join(projectPath, 'PRD.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');
    const specPath = project.specPath ?? path.join(projectPath, 'SPEC.md');
    const validationReportPath = path.join(projectPath, '.spec-validation-report.md');

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

    this.emitIPC('pipeline:phase-changed', {
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
    let builderRuntime: 'cloud' | 'local' = 'cloud';
    let validatorModel = SPEC_VALIDATOR_ID;
    let validatorRuntime: 'cloud' | 'local' = 'cloud';
    const startedAt = Date.now();

    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (state.abortController.signal.aborted) break;

        this.emitIPC('pipeline:phase-changed', {
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
          onText: (chunk) => {
            builderOutput += chunk;
            this.emitIPC('pipeline:stream', {
              projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-builder', round },
            });
          },
          onToolUse: (toolName) => {
            this.emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
          },
        });

        // Save complete builder message (not per-chunk)
        if (builderOutput) {
          savePipelineMessage({ projectId, phaseNumber: 9, role: 'assistant', content: builderOutput });
        }

        this.mergeMetrics(builderAgg, builderResult.metrics);
        builderModel = builderResult.model;
        builderRuntime = builderResult.runtime;

        if (fs.existsSync(specPath)) {
          this.emitIPC('pipeline:document-updated', {
            projectId,
            path: specPath,
            content: fs.readFileSync(specPath, 'utf-8'),
          });
        }

        if (state.abortController.signal.aborted) break;

        // --- Spec Validator ---
        this.emitIPC('pipeline:phase-changed', {
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
          onText: (chunk) => {
            validatorOutput += chunk;
            this.emitIPC('pipeline:stream', {
              projectId, phase: 9, type: 'text', content: chunk, metadata: { agent: 'spec-validator', round },
            });
          },
          onToolUse: (toolName) => {
            this.emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
          },
        });

        // Save complete validator message (not per-chunk)
        if (validatorOutput) {
          savePipelineMessage({ projectId, phaseNumber: 9, role: 'assistant', content: validatorOutput });
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

    this.emitIPC('pipeline:metrics', {
      projectId,
      phaseNumber: 9,
      metrics: { builder: builderAgg, validator: validatorAgg },
      passed,
    });

    if (lastError) {
      logger.error({ projectId, error: lastError }, 'Phase 9 failed — marking pipeline as failed');
      this.updateProjectColumns(projectId, { status: 'paused' });
      state.status = 'paused';
      this.emitIPC('pipeline:error', { projectId, phase: 9, error: lastError });
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 9,
        phaseName,
        status: 'failed',
        awaitingUser: true,
      });
      return;
    }

    const completionStatus = passed ? 'completed' : 'completed-with-warnings';

    this.emitIPC('pipeline:stream', { projectId, phase: 9, type: 'done' });

    // After the auto loop, enter a conversational review state with the Spec Validator.
    // The user can discuss the SPEC.md with the validator and only DECIDIDO advances to phase 10.
    logger.info({ projectId, passed }, 'Phase 9 auto loop complete — entering spec review conversation');

    this.emitIPC('pipeline:phase-changed', {
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
    const specPath = project.specPath ?? path.join(projectPath, 'SPEC.md');
    const prdPath = this.resolvePrdPath(project) ?? path.join(projectPath, 'PRD.md');
    const storiesPath = path.join(projectPath, 'stories-requisitos.md');
    const validationReportPath = path.join(projectPath, '.spec-validation-report.md');

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
      onText: this.makeConversationOnText(projectId, 9, phase9Acc),
      onToolUse: (toolName) => {
        this.emitIPC('pipeline:stream', { projectId, phase: 9, type: 'tool_call', tool: toolName });
      },
    });

    sessionEntry.alive = true;
    this.accumulateMetrics(state, 91, result);

    if (fs.existsSync(specPath)) {
      const currentSpecContent = fs.readFileSync(specPath, 'utf-8');
      if (currentSpecContent !== previousSpecContent) {
        this.emitIPC('pipeline:document-updated', {
          projectId,
          path: specPath,
          content: currentSpecContent,
        });
      }
    }

    // Save complete assistant message (not per-chunk)
    const phase9CleanedText = phase9Acc.text.replace(this.PHASE_COMPLETE_MARKER, '').trim();
    if (phase9CleanedText) {
      savePipelineMessage({ projectId, phaseNumber: 9, role: 'assistant', content: phase9CleanedText });
    }

    this.emitIPC('pipeline:stream', { projectId, phase: 9, type: 'done' });
  }

  // -------------------------------------------------------------------------
  // Helpers: conversation phase finalize (phases 3, 5, 6, 7, 8, 10, 12)
  // -------------------------------------------------------------------------

  private async finalizeConversationPhase(
    projectId: string,
    phase: number,
    state: PhaseState,
  ): Promise<void> {
    // Flush accumulated metrics for this phase
    const agentId = PHASE_AGENT_IDS[phase] ?? 'unknown';
    this.flushAccumulatedMetrics(projectId, phase, agentId, state, 'completed');

    // Phase 9 also accumulates conversation-turn metrics under key 91 (Spec Validator review)
    if (phase === 9) {
      this.flushAccumulatedMetrics(projectId, 91, SPEC_VALIDATOR_ID, state, 'completed');
    }

    logger.info({ projectId, phase }, 'Conversation phase finalized by user approval');

    // Phase 12 requires explicit user confirmation before starting development (phase 13+)
    if (phase === 12) {
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase,
        phaseName: PHASE_NAMES[phase] ?? `Phase ${phase}`,
        status: 'awaiting-dev-confirmation',
        awaitingUser: true,
      });
      return;
    }

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase,
      phaseName: PHASE_NAMES[phase] ?? `Phase ${phase}`,
      status: 'completed',
      awaitingUser: false,
    });

    await this.advanceToNextPhase(projectId, state);
  }

  async confirmStartDevelopment(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    if (state.status === 'aborted') {
      logger.warn({ projectId }, 'confirmStartDevelopment: pipeline aborted');
      return;
    }

    logger.info({ projectId }, 'User confirmed start of development — advancing from phase 12 to phase 13');

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 12,
      phaseName: PHASE_NAMES[12] ?? 'Phase 12',
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
    this.emitIPC('pipeline:metrics', {
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
  ): void {
    const accum = state.phaseMetricAccum.get(phaseNumber);
    if (!accum) return;

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber,
      phaseName: PHASE_NAMES[phaseNumber] ?? `Phase ${phaseNumber}`,
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
  // Helper: resolve PRD path from project record
  // -------------------------------------------------------------------------

  private resolvePrdPath(project: ReturnType<typeof getHarnessProject>): string | undefined {
    if (!project) return undefined;
    return project.prdPath;
  }

  // -------------------------------------------------------------------------
  // Public: notify loop slot released (called by HarnessEngine when sprint ends)
  // -------------------------------------------------------------------------

  releaseLoopPhase(projectId: string): void {
    releaseLoopSlot(projectId);
    logger.info({ projectId }, 'Loop phase slot released');
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

    const state = this.getState(projectId);
    state.currentSprintIndex = sprintIndex;
    state.currentPhase = 13;
    state.status = 'running';

    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: 13,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    const sprint = sprints[sprintIndex];
    logger.info({ projectId, sprintIndex, sprintName: sprint.name }, 'runSprint: starting coder+evaluator loop');

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 13,
      phaseName: PHASE_NAMES[13],
      status: 'running',
      awaitingUser: false,
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    // Acquire the global loop slot (only one project may run phases 13/14 at a time)
    if (!acquireLoopSlot(projectId)) {
      const errMsg = 'Outro projeto esta executando a fase de loop (Coder/Evaluator). Aguarde a conclusao.';
      logger.warn({ projectId, sprintIndex }, `runSprint: ${errMsg}`);
      this.emitIPC('pipeline:error', { projectId, phase: 13, error: errMsg });
      state.status = 'paused';
      this.updateProjectColumns(projectId, { status: 'paused' });
      return;
    }

    // Bridge: use HarnessEngine's stream bridge API to forward events as pipeline:stream
    this.harnessEngine.setStreamBridge((channel, data) => {
      if (channel === 'harness:agent-stream') {
        const d = data as { projectId?: string; agent?: string; event?: { type?: string; content?: string; tool?: string } };
        if (d.projectId !== projectId || !d.event?.type) return;
        const phase = d.agent === 'evaluator' ? 14 : 13;
        if (d.event.type === 'text' && d.event.content) {
          this.emitIPC('pipeline:stream', { projectId, phase, type: 'text', content: d.event.content });
        } else if (d.event.type === 'tool_use' && d.event.tool) {
          this.emitIPC('pipeline:stream', { projectId, phase, type: 'tool_call', tool: d.event.tool });
        } else if (d.event.type === 'thinking') {
          this.emitIPC('pipeline:stream', { projectId, phase, type: 'thinking' });
        }
      }
    });

    let sprintResult: import('./harness-engine').SprintResult;
    try {
      sprintResult = await this.harnessEngine.runSingleSprint(projectId, sprintIndex);
    } catch (err) {
      this.harnessEngine.clearStreamBridge();
      releaseLoopSlot(projectId);
      if ((err as Error).name === 'AbortError' || state.abortController.signal.aborted) {
        logger.info({ projectId, sprintIndex }, 'runSprint: aborted during coder/evaluator loop');
        return;
      }
      const errMsg = (err as Error).message;
      logger.error({ err, projectId, sprintIndex }, 'runSprint: HarnessEngine.runSingleSprint failed');
      this.emitIPC('pipeline:error', { projectId, phase: 13, error: errMsg });
      state.status = 'paused';
      this.updateProjectColumns(projectId, { status: 'paused' });
      return;
    }

    // Clear bridge
    this.harnessEngine.clearStreamBridge();

    releaseLoopSlot(projectId);

    if (state.abortController.signal.aborted) {
      logger.info({ projectId, sprintIndex }, 'runSprint: aborted after coder/evaluator loop');
      return;
    }

    // Persist aggregated metrics for phase 13 (Coder) and phase 14 (Evaluator).
    // Each sprint gets its own row via the sprint_index column.
    // Use the ACTUAL agent IDs from the sprint config, not generic PHASE_AGENT_IDS.
    const actualCoderAgent = sprint.coderAgentId || PHASE_AGENT_IDS[13];
    const actualEvaluatorAgent = sprint.evaluatorAgentId || PHASE_AGENT_IDS[14];

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 13,
      sprintIndex,
      phaseName: PHASE_NAMES[13],
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
      completedAt: new Date().toISOString(),
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    savePipelinePhaseMetrics({
      projectId,
      phaseNumber: 14,
      sprintIndex,
      phaseName: PHASE_NAMES[14],
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
      completedAt: new Date().toISOString(),
      metadata: { sprintIndex, sprintName: sprint.name },
    });

    this.emitIPC('pipeline:sprint-complete', {
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
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 13,
        phaseName: PHASE_NAMES[13],
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: allSprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      // Last sprint completed — pipeline is done
      state.status = 'idle';
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
        metadata: { totalSprints: allSprints.length },
      });
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

    this.emitIPC('pipeline:sprint-complete', {
      projectId,
      sprintIndex,
      sprintName: sprint.name,
      verdict: 'accepted-with-restrictions',
      rounds: sprint.roundsUsed ?? 0,
      metrics: {},
    });

    // Advance to next sprint or complete the pipeline
    const nextSprintIndex = sprintIndex + 1;
    if (nextSprintIndex < sprints.length) {
      this.updateProjectColumns(projectId, { pipelineSprintIndex: nextSprintIndex, status: 'running' });
      state.status = 'running';
      state.abortController = new AbortController();
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 13,
        phaseName: PHASE_NAMES[13],
        status: 'next-sprint',
        awaitingUser: false,
        metadata: { sprintIndex: nextSprintIndex, sprintName: sprints[nextSprintIndex]?.name },
      });
      await this.runSprint(projectId, nextSprintIndex);
    } else {
      state.status = 'idle';
      this.updateProjectColumns(projectId, { status: 'done', pipelineCurrentPhase: null });
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: null,
        status: 'pipeline-completed',
        awaitingUser: false,
        metadata: { totalSprints: sprints.length },
      });
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

    // Reset sprint to pending so it can be re-executed
    updateHarnessSprint(sprint.id, { status: 'pending', completedAt: null });

    state.status = 'running';
    state.abortController = new AbortController();
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: 13,
      pipelineSprintIndex: sprintIndex,
      status: 'running',
    });

    this.emitIPC('pipeline:phase-changed', {
      projectId,
      phase: 13,
      phaseName: PHASE_NAMES[13],
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
    if (!RESETABLE_PHASES.has(phase)) {
      return { ok: false, error: `Phase ${phase} is not resetable` };
    }

    const project = getHarnessProject(projectId);
    if (!project) return { ok: false, error: 'Project not found' };

    const state = this.getState(projectId);

    // Abort any running execution
    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    // Clear all continue sessions so the next turn starts fresh
    state.continueSessions.clear();

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

    // Delete artifact files
    const mapping = PHASE_ARTIFACT_MAP[phase];
    const projectRoot = project.projectPath;
    for (const file of mapping.files) {
      const fullPath = path.join(projectRoot, file);
      try {
        fs.rmSync(fullPath, { force: true });
      } catch {
        // Ignore — file may not exist yet
      }
    }

    // Delete DB records
    deletePipelineMessagesFromPhase(projectId, mapping.fromPhase);
    deletePipelinePhaseMetricsFromPhase(projectId, mapping.fromPhase);
    if (mapping.wipeSprints) {
      deleteHarnessSprintsForProject(projectId);
    }

    // Release the global loop slot in case it was held by this project
    releaseLoopSlot(projectId);

    // Update project status in DB
    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: phase,
      status: 'idle',
    });

    logger.info({ projectId, phase }, 'Pipeline reset to phase');

    this.emitIPC('pipeline:reset-complete', { projectId, phase });

    // Auto phases restart immediately; conversation phases wait for user input.
    // Kick off in the BACKGROUND so the IPC (ResetConfirmDialog) resolves and
    // the dialog closes - runAutoPhase can be long running, and the UI reacts
    // to streaming events as it progresses.
    if (AUTO_PHASES.has(phase)) {
      void this.runAutoPhase(projectId, phase).catch((err) => {
        logger.error(
          { err, projectId, phase },
          'Background runAutoPhase after resetPhase failed',
        );
        this.emitIPC('pipeline:error', {
          projectId,
          phase,
          error: (err as Error).message,
        });
      });
    }

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

    this.emitIPC('pipeline:sprint-reset', { projectId, sprintIndex });

    // Refresh abort controller and state
    state.abortController = new AbortController();
    state.status = 'running';

    this.updateProjectColumns(projectId, {
      pipelineCurrentPhase: 13,
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
        this.emitIPC('pipeline:error', {
          projectId,
          phase: 13,
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
      const mapping = PHASE_ARTIFACT_MAP[target.phase];
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
