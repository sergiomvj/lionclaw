import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { extractJSON } from './json-extractor';
import { ensureNodeInPath } from './pipeline-shared/sdk-bootstrap';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import { setProjectStatus } from './pipeline-shared/status';
import { persistMessage, persistHarnessRound } from './pipeline-shared/persist';

import {
  getHarnessProject,
  updateHarnessProject,
  getHarnessSprints,
  updateHarnessSprint,
  getAgent,
  getAllAgents,
  getDb,
  getEnrichSession,
  updateEnrichSession,
  accumulateEnrichMetrics,
} from './db';
import {
  buildPlannerPrompt,
  buildPlannerMarkdownPrompt,
  buildRegenerationPrompt,
  parsePlannerOutput,
  parsePlannerMarkdown,
  saveSprintsJson,
  readHarnessSprintsJson,
} from './harness-planner';
import type { SprintJsonEntry, SprintsJson } from './harness-planner';
import {
  buildCoderPrompt,
  buildCoderFeedbackPrompt,
  buildValidatorPrompt,
  buildEnricherPrompt,
  buildValidatorFollowUpPrompt,
  buildEnricherFollowUpPrompt,
} from './harness-prompts';
import {
  buildEvaluatorPrompt,
  parseEvaluationOutput,
  validateCriteria,
  updateSpecProgress,
  buildFeedbackFromEvaluation,
} from './harness-evaluator';
import { setActiveEnrichSpecPath, createEnrichPermissionGuard } from './permission-guard';
import { executeAgent } from './agent-runtime';
import type { AgentExecutionResult } from './agent-runtime/types';
import { PERM_BYPASS_NO_GUARD, PERM_DEFAULT_WITH_GUARD } from './agent-runtime/permission-profiles';
import { ollamaChatWithTools } from './ollama-client';
import type { OllamaChatResult } from './ollama-client';
import { getSecret } from './vault-registry';
import type { EvaluationResult, CreateEnrichConfig, EnrichPhase, ExternalConfig, AgentConfig } from '../../src/types';
import { runSmokeTest, writeSmokeTestReport } from './smoke-test-runner';
import {
  getPipelineDocsContext,
  resolveSpecPath,
  resolveSpecProgressPath,
  resolveHarnessSprintsPath,
} from './pipeline-paths';
import { getArchitectureReviewContext } from './architecture-review-paths';

const logger = createLogger('harness-engine');

// ============================================================
// Helpers para path external (Sprint 7)
// Aplicam-se APENAS ao runtime 'external'. Cloud e local nao os usam.
// ============================================================

/**
 * Resolve os headers de autenticacao para um provider externo a partir do Vault.
 * Chamado no inicio de CADA sprint (nao cacheado), conforme SPEC secao 3.5.2.
 * Spread order: extraHeaders primeiro, Authorization por ultimo para garantir
 * que extraHeaders nunca sobrescreva a Authorization resolvida (SPEC secao 6.2).
 */
export async function resolveExternalAuth(
  config: ExternalConfig,
): Promise<Record<string, string>> {
  const apiKey = await getSecret(config.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `API key nao encontrada no Vault para provider "${config.apiKeyRef}". ` +
      `Configure em Configuracoes > Vault.`,
    );
  }
  return {
    ...(config.extraHeaders ?? {}),
    'Authorization': `Bearer ${apiKey}`,
  };
}

/**
 * Wrapper com retry para HTTP 429 (Rate Limit) e HTTP 5xx (Gateway/Service errors).
 * Aplica-se APENAS ao path external. Cloud e local nao usam.
 *
 * Comportamento:
 *  - 429: usa Retry-After header quando presente, fallback de 30s.
 *  - 5xx (502/503/504): backoff exponencial (2s, 4s, 8s, 16s, capped em 30s).
 *  - Outros erros: relanca imediatamente sem retry.
 *  - Max 5 retries (total de 6 tentativas).
 */
export async function ollamaChatWithRetry(
  ...args: Parameters<typeof ollamaChatWithTools>
): Promise<OllamaChatResult> {
  const MAX_RETRIES = 5;
  const DEFAULT_429_WAIT_MS = 30_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ollamaChatWithTools(...args);
    } catch (err) {
      const errMsg = (err as Error).message || '';
      const is429 = errMsg.includes('HTTP 429');
      const is5xx = /HTTP 5\d\d/.test(errMsg);

      if ((!is429 && !is5xx) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitMs: number;
      if (is429) {
        const retryAfterMatch = errMsg.match(/Retry-After:\s*(\d+)/i);
        waitMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1000
          : DEFAULT_429_WAIT_MS;
      } else {
        // Exponential backoff for 5xx: 2s, 4s, 8s, 16s, 30s.
        waitMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
      }

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
          statusType: is429 ? '429' : '5xx',
          model: args[1],
          errPreview: errMsg.substring(0, 200),
        },
        'External request failed, retrying',
      );

      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  throw new Error('Retry exhausted');
}

/**
 * Computa a chave de pricing correta para o provider externo.
 * OpenRouter usa prefixo "or:" para diferenciar dos precos OpenAI direto.
 * SPEC secao 3.5.3.
 */
export function computePricingKey(extCfg: ExternalConfig): string {
  if (extCfg.provider === 'openrouter') return `or:${extCfg.model}`;
  return extCfg.model;
}

/**
 * Mapeia os campos de effort/thinking do agente para params de reasoning
 * especificos do provider externo. Os campos sao Claude SDK-specific e precisam
 * de traducao por provider/modelo. SPEC secao 3.10.3.
 */
export function mapReasoningParams(
  effort: AgentConfig['effort'] | undefined,
  thinking: AgentConfig['thinking'] | undefined,
  _thinkingBudget: number | undefined,
  provider: ExternalConfig['provider'],
  model: string,
): Partial<Record<string, unknown>> {
  // Clamp 'max' to 'high': OpenAI and OpenRouter only accept 'low' | 'medium' | 'high'
  const reasoningEffort = effort === 'max' ? 'high' : (effort ?? 'medium');

  // OpenAI GPT-5.5, o-series: reasoning_effort
  if (provider === 'openai' && (model.startsWith('gpt-5.5') || model.startsWith('o'))) {
    if (thinking === 'disabled') return {};
    return { reasoning_effort: reasoningEffort };
  }

  // OpenRouter: passa adiante para o upstream baseado no slug do modelo
  if (provider === 'openrouter') {
    // GPT-5.5 via OpenRouter
    if (model.startsWith('openai/gpt-5')) {
      return thinking === 'disabled' ? {} : { reasoning_effort: reasoningEffort };
    }
    // Qwen 3.6 thinking mode
    if (model.startsWith('qwen/qwen3.6') && thinking !== 'disabled') {
      return { thinking: { type: 'enabled' } };
    }
    // Kimi K2 Thinking e DeepSeek-Reasoner: reasoning embutido no slug, sem param adicional
  }

  return {}; // outros providers/modelos: ignora
}

/**
 * Detecta erros de contexto excedido em mensagens de erro de multiplos providers.
 * Usado no catch do bloco external para emitir mensagem clara ao usuario.
 * SPEC secao 5.5.
 */
export function isContextLengthError(errorMessage: string): boolean {
  return /context.*(length|limit|exceed|too long)/i.test(errorMessage)
    || /maximum.*tokens/i.test(errorMessage)
    || /token.*limit.*exceeded/i.test(errorMessage)
    || errorMessage.includes('context_length_exceeded');
}

// S1.0/P1.1: removidos resolveMCPsForHarnessAgent e builtinToolsToOllamaSchemas
// — eram usados pelo switch manual de runtime nos 4 metodos planner/regen/coder/evaluator.
// executeAgent agora resolve MCPs via resolveAgentQueryConfig e cada executor monta
// seus tool schemas internamente (ollama-client para local/external, SDK pra cloud).

interface HarnessState {
  status: 'idle' | 'planning' | 'running' | 'paused';
  projectId: string | null;
  currentSprintIndex: number;
  abortController: AbortController | null;
  pauseRequested: boolean;
}

interface ActiveEnrichSession {
  sessionId: string;
  specPath: string;
  phase: EnrichPhase;
  abort: AbortController;
}

export interface SprintMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  model: string | null;
  runtime: 'cloud' | 'local' | 'external' | null;
}

export interface SprintResult {
  verdict: string;
  rounds: number;
  metrics: { coder: SprintMetrics; evaluator: SprintMetrics };
  coderMetrics: SprintMetrics;
  evaluatorMetrics: SprintMetrics;
}

function extractEvaluationJSON(
  result: import('./json-extractor').ExtractJSONSource,
  round: number,
  sprintId: string,
): { evaluation: EvaluationResult; tier: string } {
  const { value, tier } = extractJSON<EvaluationResult>(result, {
    parser: (text, outMeta) => parseEvaluationOutput(text, round, outMeta),
    contextLabel: 'Evaluator',
    round,
    sprintId,
  });
  return { evaluation: value, tier };
}

/**
 * S1.0/P1.1: mapeia o runtime que executou o agente para os campos de auditoria
 * que vao para harness_rounds (cost_source, runtime_used).
 *
 * - cloud   -> sdk_anthropic (cost calculado pelo cloud-executor via calculateCost)
 * - codex   -> reported (codex-executor reporta cost emitido pelo CLI)
 * - local   -> calculated (local-executor calcula via calculateCost com pricing key)
 * - external -> reported quando upstream entrega usage.cost, calculated caso contrario
 *
 * Como a coluna runtime_used no DB ainda esta tipada como
 * 'cloud' | 'local' | 'external' | null (V44), 'codex' eh normalizado para
 * 'cloud' aqui — o codex e funcionalmente cloud-backed via Anthropic API. Quando
 * a coluna for ampliada (futura migration), trocar este map para passar 'codex'
 * adiante.
 */
function mapRuntimeToCostMeta(
  runtime: AgentExecutionResult['runtime'],
): {
  costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
  runtimeUsed: 'cloud' | 'local' | 'external';
} {
  switch (runtime) {
    case 'cloud':
      return { costSource: 'sdk_anthropic', runtimeUsed: 'cloud' };
    case 'codex':
      return { costSource: 'reported', runtimeUsed: 'cloud' };
    case 'local':
      return { costSource: 'calculated', runtimeUsed: 'local' };
    case 'external':
      return { costSource: 'reported', runtimeUsed: 'external' };
  }
}

export class HarnessEngine {
  private getWindow: () => BrowserWindow | null;
  private states: Map<string, HarnessState> = new Map();
  private activeEnrichSession: ActiveEnrichSession | null = null;
  private streamBridge: ((channel: string, data: unknown) => void) | null = null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /** Set a callback that receives all emitIPC calls (used by PipelineEngine to forward stream events). */
  setStreamBridge(bridge: (channel: string, data: unknown) => void): void {
    this.streamBridge = bridge;
  }

  /** Remove the stream bridge callback. */
  clearStreamBridge(): void {
    this.streamBridge = null;
  }

  private getProjectDir(projectId: string): string {
    return path.join(getLionClawHome(), 'harness', 'projects', projectId);
  }

  private ensureProjectDirs(projectId: string): void {
    const projectDir = this.getProjectDir(projectId);
    fs.mkdirSync(path.join(projectDir, 'sprints'), { recursive: true });
  }

  private emitIPC(channel: string, data: unknown): void {
    try {
      if (this.streamBridge) {
        this.streamBridge(channel, data);
      }
    } catch {
      // Bridge target (PipelineEngine) window may have been destroyed
    }
    // Direct window send is now delegated to the shared `emitIPC` helper
    // (electron/main/pipeline-shared/ipc-emitter.ts). The bridge above is kept
    // here because it is HarnessEngine-specific (forwards to PipelineEngine).
    emitIPC(channel, data);
  }

  /**
   * Persist a stream event to a JSONL file for later retrieval.
   * Files: sprints/{sprintId}/round-{n}-{agent}.jsonl
   */
  private persistStreamEvent(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
    event: { type: string; content?: string; tool?: string },
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `round-${round}-${agent}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    } catch {
      // Non-critical - don't break execution
    }
  }

  /**
   * Persist evaluator→coder feedback audit trail.
   * File: sprints/{sprintId}/feedback-audit.jsonl
   */
  private persistFeedbackAudit(
    projectId: string,
    sprintId: string,
    round: number,
    evaluatorVerdict: string,
    evaluatorSummary: string,
    failedCriteria: { description: string; justification: string }[],
    feedbackInjected: string,
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'feedback-audit.jsonl');
      const entry = {
        timestamp: new Date().toISOString(),
        round,
        evaluatorVerdict,
        evaluatorSummary,
        failedCriteria,
        feedbackInjectedIntoCoder: feedbackInjected,
      };
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
  }

  /**
   * Read persisted stream log for a sprint/round/agent.
   */
  getStreamLog(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
  ): { type: string; content?: string; tool?: string }[] {
    const filePath = path.join(
      this.getProjectDir(projectId), 'sprints', sprintId, `round-${round}-${agent}.jsonl`,
    );
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Read the latest stream log for a sprint (most recent round, both agents).
   */
  getLatestStreamLogs(
    projectId: string,
    sprintId: string,
  ): { coder: { type: string; content?: string; tool?: string }[]; evaluator: { type: string; content?: string; tool?: string }[]; round: number } {
    const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
    if (!fs.existsSync(dir)) return { coder: [], evaluator: [], round: 0 };

    // Find the highest round number
    const files = fs.readdirSync(dir).filter(f => f.startsWith('round-') && f.endsWith('.jsonl'));
    let maxRound = 0;
    for (const f of files) {
      const match = f.match(/^round-(\d+)-/);
      if (match) {
        const r = parseInt(match[1], 10);
        if (r > maxRound) maxRound = r;
      }
    }

    if (maxRound === 0) return { coder: [], evaluator: [], round: 0 };

    return {
      coder: this.getStreamLog(projectId, sprintId, maxRound, 'coder'),
      evaluator: this.getStreamLog(projectId, sprintId, maxRound, 'evaluator'),
      round: maxRound,
    };
  }

  private getState(projectId: string): HarnessState {
    if (!this.states.has(projectId)) {
      this.states.set(projectId, {
        status: 'idle',
        projectId,
        currentSprintIndex: -1,
        abortController: null,
        pauseRequested: false,
      });
    }
    return this.states.get(projectId)!;
  }

  /**
   * Run the Planner agent against the project spec and produce sprints.json.
   */
  async plan(projectId: string): Promise<void> {
    ensureNodeInPath();

    const state = this.getState(projectId);
    state.status = 'planning';
    state.abortController = new AbortController();

    this.ensureProjectDirs(projectId);

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    setProjectStatus(projectId, 'planning');
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      // 1. Read spec content (with fallback for legacy projects with empty spec_path).
      const specPath = resolveSpecPath(project);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Spec file not found: ${specPath}`);
      }
      const specContent = fs.readFileSync(specPath, 'utf-8');

      // 2. Get planner agent config
      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      // 3. Get all available agents for the list in the prompt
      const allAgents = getAllAgents();

      // 4. Build the planner prompt (JSON or Markdown based on config)
      const outputFormat = project.config.plannerOutputFormat ?? 'json';
      const prompt = outputFormat === 'markdown'
        ? buildPlannerMarkdownPrompt(specContent, project, allAgents)
        : buildPlannerPrompt(specContent, project, allAgents);

      // 5. Validate cwd exists (spawn ENOENT on missing cwd is misleading)
      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}. Create the directory first.`);
      }

      // S1.0/P1.1: substituido o switch manual por executeAgent — despacho por
      // runtime (cloud/codex/local/external) acontece dentro do agent-runtime.
      // Para o cloud, executeAgent retorna accumulatedText/textBlocks que o
      // extractJSON precisa para os tiers de fallback. Para os outros runtimes
      // esses campos ficam undefined e o parsing cai no fullOutput direto.
      logger.info(
        { projectId, runtime: plannerAgent.runtime, model: plannerAgent.model, cwd: project.projectPath },
        'Spawning Planner via executeAgent',
      );

      if (!state.abortController) {
        state.abortController = new AbortController();
      }
      const abortController = state.abortController;

      const plannerResult = await executeAgent({
        agentId: plannerAgent.id,
        prompt,
        cwd: project.projectPath,
        abortController,
        permission: PERM_BYPASS_NO_GUARD,
        projectId,
        onText: (text) => {
          this.emitIPC('harness:agent-stream', {
            projectId,
            agent: 'planner',
            event: { type: 'text', content: text },
          });
        },
        onThinking: (text) => {
          this.emitIPC('harness:agent-stream', {
            projectId,
            agent: 'planner',
            event: { type: 'thinking', content: text },
          });
        },
        onToolUse: (toolName) => {
          this.emitIPC('harness:agent-stream', {
            projectId,
            agent: 'planner',
            event: { type: 'tool_use', tool: toolName },
          });
        },
      });

      logger.info(
        { projectId, runtime: plannerResult.runtime, model: plannerResult.model },
        'Planner finished via executeAgent',
      );

      const fullOutput = plannerResult.output;
      const inputTokens = plannerResult.metrics.inputTokens;
      const outputTokens = plannerResult.metrics.outputTokens;
      const cacheReadTokens = plannerResult.metrics.cacheReadTokens;
      const cacheCreationTokens = plannerResult.metrics.cacheCreationTokens;
      // Cloud-only fields used by extractJSON for fallback tiers (S1.0.4).
      const plannerExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
        plannerResult.accumulatedText !== undefined && plannerResult.textBlocks !== undefined
          ? {
              output: fullOutput,
              accumulatedText: plannerResult.accumulatedText,
              textBlocks: plannerResult.textBlocks,
            }
          : undefined;

      if (state.abortController?.signal.aborted) {
        // S3 (Onda 3): user-initiated abort during planning is NOT a failure.
        // Pre-V48 the CHECK rejected 'aborted' so we wrote 'failed'. Pos-V48 we
        // record the truth and the UI can distinguish abort from real errors.
        setProjectStatus(projectId, 'aborted');
        this.emitIPC('harness:project-update', { projectId, status: 'aborted' });
        state.status = 'idle';
        return;
      }

      // 7. Parse planner output (JSON or Markdown based on config)
      // TODO: parsePRDValidator / parseSprintValidator not yet extracted as named functions
      let plannerParseTier: string | null = null;
      const sprintsJson = outputFormat === 'markdown'
        ? parsePlannerMarkdown(fullOutput, project)
        : (() => {
            if (plannerExtractSource) {
              const { value, tier } = extractJSON<SprintsJson>(plannerExtractSource, {
                parser: (text, outMeta) => parsePlannerOutput(text, outMeta),
                contextLabel: 'Planner',
              });
              plannerParseTier = tier;
              return value;
            }
            // Fallback: local/external/codex path - only raw output available
            const meta: { repaired?: boolean } = {};
            const value = parsePlannerOutput(fullOutput, meta);
            plannerParseTier = meta.repaired ? 'jsonrepair' : 'result';
            return value;
          })();

      if (plannerParseTier && plannerParseTier !== 'result') {
        logger.info({ projectId, plannerParseTier }, 'Planner JSON extracted from fallback tier');
      }

      // 8. Save sprints.json no path canonical do projeto-alvo (NAO mais ~/.lionclaw/...).
      // Refactor que migrou sprints pra dentro do projeto-alvo ja foi aplicado em readers
      // (pipeline-engine.findHarnessSprintsReadPath, sprint-validator). O writer ficou pra
      // tras usando getProjectDir() legado, que retornava DIRETORIO em vez de FILE -> EISDIR.
      // Ver BUGFIXTESTESV1.md Bug #8.
      const projectFull = getHarnessProject(projectId);
      if (!projectFull) throw new Error(`Project ${projectId} not found when resolving sprints path`);
      // Architecture-review pipeline writes sprints inside the run dir
      // (`<runDir>/sprints-<runId>.json`) so the manifest paths and reset map
      // stay coherent. Other pipelines fall back to the legacy resolver
      // (`docs/sprints.json` or `docs/Docs<id>/sprints<id>.json`).
      let sprintsFilePath: string;
      if (projectFull.pipelineType === 'architecture-review') {
        const ctx = getArchitectureReviewContext(projectFull);
        if (!ctx) {
          throw new Error('architecture-review run context missing when planner ran — fase 1 must have generated runId');
        }
        sprintsFilePath = ctx.sprintsPath;
      } else {
        sprintsFilePath = resolveHarnessSprintsPath(projectFull);
      }
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        sprintsFilePath,
        sprintsJson,
        project.config.evaluatorAgentId,
        outputFormat,
      );

      // 9. Update project in DB
      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      // 10. Emit planning-done
      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
      });

      // 11. Track planner metrics directly on the project record.
      // S1.0/P1.1: usa o costUsd ja calculado pelo executor (D6 — orchestrator
      // segue calculando localmente, harness/pipeline/enrich nao). Recalcular
      // aqui causaria double-count e diverge do que cloud/local/external/codex
      // reportam internamente (cada runtime tem sua logica de pricing).
      const durationMs = Date.now() - startedAt;
      const costUsd = plannerResult.metrics.costUsd;

      updateHarnessProject(projectId, {
        plannerInputTokens: inputTokens,
        plannerOutputTokens: outputTokens,
        plannerCacheTokens: cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: costUsd,
        plannerDurationMs: durationMs,
      });

      logger.info(
        { projectId, totalSprints: sprintsJson.metadata.total_sprints, durationMs, costUsd },
        'Planning completed',
      );

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });

    } catch (err) {
      logger.error({ err, projectId }, 'Planning failed');
      setProjectStatus(projectId, 'failed');
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      state.status = 'idle';
    }
  }

  /**
   * Regenerate sprints.json by re-running the Planner with user feedback.
   */
  async regenerate(projectId: string, feedback: string): Promise<void> {
    const state = this.getState(projectId);
    state.status = 'planning';
    state.abortController = new AbortController();

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    setProjectStatus(projectId, 'planning');
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      // 1. Read current sprints.json (canonical path no projeto-alvo). Ver Bug #8.
      const previousJson = readHarnessSprintsJson(project);
      if (!previousJson) {
        throw new Error('No existing sprints.json found to regenerate from');
      }

      // 2. Read spec content (with fallback for legacy projects with empty spec_path).
      const specPath = resolveSpecPath(project);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Spec file not found: ${specPath}`);
      }
      const specContent = fs.readFileSync(specPath, 'utf-8');

      // 3. Build regeneration prompt
      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      const allAgents = getAllAgents();
      const regenFormat = project.config.plannerOutputFormat ?? 'json';
      const prompt = buildRegenerationPrompt(previousJson, feedback, specContent, allAgents, regenFormat);

      // 4. Validate cwd
      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}`);
      }

      // S1.0/P1.1: substituido o switch manual por executeAgent. Shape FLAT do
      // regenerate preservado por compat historica (snapshot test). O callback
      // onRawEvent (sdk_event) foi removido: nenhum subscriber no renderer.
      logger.info(
        { projectId, runtime: plannerAgent.runtime, model: plannerAgent.model },
        'Spawning Planner (regen) via executeAgent',
      );

      if (!state.abortController) {
        state.abortController = new AbortController();
      }
      const regenAbortController = state.abortController;

      const regenResult = await executeAgent({
        agentId: plannerAgent.id,
        prompt,
        cwd: project.projectPath,
        abortController: regenAbortController,
        permission: PERM_BYPASS_NO_GUARD,
        projectId,
        onText: (text) => {
          this.emitIPC('harness:agent-stream', { projectId, agent: 'planner', type: 'text', content: text });
        },
        onToolUse: (toolName) => {
          this.emitIPC('harness:agent-stream', { projectId, agent: 'planner', type: 'tool_use', tool: toolName });
        },
      });

      const fullOutput = regenResult.output;
      const inputTokens = regenResult.metrics.inputTokens;
      const outputTokens = regenResult.metrics.outputTokens;
      const cacheReadTokens = regenResult.metrics.cacheReadTokens;
      const cacheCreationTokens = regenResult.metrics.cacheCreationTokens;
      const regenExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
        regenResult.accumulatedText !== undefined && regenResult.textBlocks !== undefined
          ? {
              output: fullOutput,
              accumulatedText: regenResult.accumulatedText,
              textBlocks: regenResult.textBlocks,
            }
          : undefined;

      if (state.abortController?.signal.aborted) {
        setProjectStatus(projectId, 'reviewing');
        this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });
        state.status = 'idle';
        return;
      }

      // 5. Delete old sprint records for this project
      const db = getDb();
      db.prepare('DELETE FROM harness_rounds WHERE sprint_id IN (SELECT id FROM harness_sprints WHERE project_id = ?)').run(projectId);
      db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(projectId);

      // 6. Parse and save new version
      // TODO: parsePRDValidator / parseSprintValidator not yet extracted as named functions
      let regenParseTier: string | null = null;
      const sprintsJson = regenFormat === 'markdown'
        ? parsePlannerMarkdown(fullOutput, project)
        : (() => {
            if (regenExtractSource) {
              const { value, tier } = extractJSON<SprintsJson>(regenExtractSource, {
                parser: (text, outMeta) => parsePlannerOutput(text, outMeta),
                contextLabel: 'Planner',
              });
              regenParseTier = tier;
              return value;
            }
            // Fallback: local/external/codex path - only raw output available
            const meta: { repaired?: boolean } = {};
            const value = parsePlannerOutput(fullOutput, meta);
            regenParseTier = meta.repaired ? 'jsonrepair' : 'result';
            return value;
          })();

      if (regenParseTier && regenParseTier !== 'result') {
        logger.info({ projectId, regenParseTier }, 'Regen planner JSON extracted from fallback tier');
      }
      // Salva no canonical do projeto-alvo (mesma logica do plan()). Ver Bug #8.
      const sprintsFilePath = resolveHarnessSprintsPath(project);
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        sprintsFilePath,
        sprintsJson,
        project.config.evaluatorAgentId,
        regenFormat,
      );

      // 7. Update project
      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      // 8. Emit planning-done
      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
        regenerated: true,
      });

      const durationMs = Date.now() - startedAt;
      // S1.0/P1.1: usa o costUsd ja calculado pelo executor (D6).
      const costUsd = regenResult.metrics.costUsd;

      // Accumulate planner metrics (add to existing since regeneration is an additional cost)
      const existingProject = getHarnessProject(projectId);
      updateHarnessProject(projectId, {
        plannerInputTokens: (existingProject?.plannerInputTokens ?? 0) + inputTokens,
        plannerOutputTokens: (existingProject?.plannerOutputTokens ?? 0) + outputTokens,
        plannerCacheTokens: (existingProject?.plannerCacheTokens ?? 0) + cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: (existingProject?.plannerCostUsd ?? 0) + costUsd,
        plannerDurationMs: (existingProject?.plannerDurationMs ?? 0) + durationMs,
      });

      logger.info(
        { projectId, version: sprintsJson.metadata.version, durationMs, costUsd },
        'Regeneration completed',
      );

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });

    } catch (err) {
      logger.error({ err, projectId }, 'Regeneration failed');
      setProjectStatus(projectId, 'failed');
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      state.status = 'idle';
    }
  }

  private async spawnCoder(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
    feedback?: string,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    output: string;
    toolCallsAccum: Array<{ tool: string; input: unknown }>;
    promptUsed: string;
    costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
    runtimeUsed: 'cloud' | 'local' | 'external';
    providerUsed: string;
    modelUsed: string;
  }> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // 1. Get Coder agent config from DB
    const coderAgentId = sprint.coderAgentId;
    if (!coderAgentId) throw new Error(`Sprint ${sprint.id} has no coderAgentId`);
    const coderAgent = getAgent(coderAgentId);
    if (!coderAgent) throw new Error(`Coder agent not found: ${coderAgentId}`);

    // 2. Read SPEC_PROGRESS.md (empty string if first sprint)
    const specProgressPath = resolveSpecProgressPath(project);
    const specProgressContent = fs.existsSync(specProgressPath)
      ? fs.readFileSync(specProgressPath, 'utf-8')
      : '';

    // 3. Build the coder prompt
    const prompt = round === 1 && !feedback
      ? buildCoderPrompt(sprintJson, specProgressContent, project.projectPath)
      : buildCoderFeedbackPrompt(sprintJson, feedback ?? '');

    // 4. Validate cwd
    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();

    // Accumulate tool calls for pipeline_messages persistence
    const coderToolCallsAccum: Array<{ tool: string; input: unknown }> = [];

    // S1.0/P1.1: substituido o switch manual por executeAgent — despacho por
    // runtime (cloud/codex/local/external) acontece dentro do agent-runtime.
    // Stream events mantem o NESTED shape ({ projectId, sprintId, round, agent, event })
    // por compat com o subscriber em ExecutionView/SprintList.
    logger.info(
      { projectId, sprintId: sprint.id, round, runtime: coderAgent.runtime, model: coderAgent.model },
      'Spawning Coder via executeAgent',
    );

    if (!state.abortController) {
      state.abortController = new AbortController();
    }
    const coderAbortController = state.abortController;

    const coderResult = await executeAgent({
      agentId: coderAgent.id,
      prompt,
      cwd: project.projectPath,
      abortController: coderAbortController,
      permission: PERM_BYPASS_NO_GUARD,
      projectId,
      onText: (text) => {
        const evt = { type: 'text', content: text };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
      },
      onToolUse: (toolName) => {
        const evt = { type: 'tool_call', tool: toolName };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
      },
      onToolUseComplete: (toolName, input) => {
        coderToolCallsAccum.push({ tool: toolName, input: input ?? {} });
      },
    });

    const durationMs = Date.now() - startedAt;
    const costUsd = coderResult.metrics.costUsd;
    const { costSource, runtimeUsed } = mapRuntimeToCostMeta(coderResult.runtime);

    logger.info(
      {
        projectId, sprintId: sprint.id, round, durationMs, costUsd,
        toolUses: coderResult.metrics.toolUses,
        apiRequests: coderResult.metrics.apiRequests,
        runtime: coderResult.runtime,
        costSource,
      },
      'Coder finished via executeAgent',
    );

    return {
      inputTokens: coderResult.metrics.inputTokens,
      outputTokens: coderResult.metrics.outputTokens,
      cacheTokens: coderResult.metrics.cacheReadTokens + coderResult.metrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: coderResult.metrics.toolUses,
      apiRequests: coderResult.metrics.apiRequests,
      output: coderResult.output,
      toolCallsAccum: coderToolCallsAccum,
      promptUsed: prompt,
      costSource,
      runtimeUsed,
      providerUsed: coderResult.provider,
      modelUsed: coderResult.model,
      // SPEC Camada 4: propaga telemetria de apply_patch failures (0 pra non-Codex).
      codexPatchFailures: coderResult.metadata?.codex?.applyPatchFailures ?? 0,
    };
  }

  private async spawnEvaluator(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    evaluation: EvaluationResult;
    output: string;
    toolCallsAccum: Array<{ tool: string; input: unknown }>;
    costSource: 'sdk_anthropic' | 'calculated' | 'reported' | 'fallback_zero';
    runtimeUsed: 'cloud' | 'local' | 'external';
    providerUsed: string;
    modelUsed: string;
    parseTier: string;
  }> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // 1. Get Evaluator agent config from DB
    const evaluatorAgentId = sprint.evaluatorAgentId;
    if (!evaluatorAgentId) throw new Error(`Sprint ${sprint.id} has no evaluatorAgentId`);
    const evaluatorAgent = getAgent(evaluatorAgentId);
    if (!evaluatorAgent) throw new Error(`Evaluator agent not found: ${evaluatorAgentId}`);

    // 2. Build evaluator prompt — resolve specPath so the agent reads the right
    // file (security pipeline writes per-pipeline SPEC<docsId>.md, not SPEC.md).
    const evaluatorSpecPath = resolveSpecPath(project);
    const prompt = buildEvaluatorPrompt(sprintJson, project.projectPath, evaluatorSpecPath);

    // 3. Validate cwd
    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();

    // Accumulate tool calls for pipeline_messages persistence
    const evalToolCallsAccum: Array<{ tool: string; input: unknown }> = [];

    // S1.0/P1.1: substituido o switch manual por executeAgent — despacho por
    // runtime (cloud/codex/local/external) acontece dentro do agent-runtime.
    // Stream events mantem o NESTED shape ({ projectId, sprintId, round, agent, event })
    // por compat com o subscriber em ExecutionView.
    logger.info(
      { projectId, sprintId: sprint.id, round, runtime: evaluatorAgent.runtime, model: evaluatorAgent.model },
      'Spawning Evaluator via executeAgent',
    );

    if (!state.abortController) {
      state.abortController = new AbortController();
    }
    const evalAbortController = state.abortController;

    const evalResult = await executeAgent({
      agentId: evaluatorAgent.id,
      prompt,
      cwd: project.projectPath,
      abortController: evalAbortController,
      permission: PERM_BYPASS_NO_GUARD,
      projectId,
      onText: (text) => {
        const evt = { type: 'text', content: text };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
      },
      onToolUse: (toolName) => {
        const evt = { type: 'tool_call', tool: toolName };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
      },
      onToolUseComplete: (toolName, input) => {
        evalToolCallsAccum.push({ tool: toolName, input: input ?? {} });
      },
    });

    const fullOutput = evalResult.output;
    const evalInputTokens = evalResult.metrics.inputTokens;
    const evalOutputTokens = evalResult.metrics.outputTokens;
    const evalCacheTokens = evalResult.metrics.cacheReadTokens + evalResult.metrics.cacheCreationTokens;
    const evalToolUses = evalResult.metrics.toolUses;
    const evalApiRequests = evalResult.metrics.apiRequests;
    const { costSource: evalCostSource, runtimeUsed: evalRuntimeUsed } =
      mapRuntimeToCostMeta(evalResult.runtime);
    const evalProviderUsed = evalResult.provider;
    const evalModelUsed = evalResult.model;

    // Cloud-only fields used by extractEvaluationJSON for fallback tiers.
    const evalExtractSource: import('./json-extractor').ExtractJSONSource | undefined =
      evalResult.accumulatedText !== undefined && evalResult.textBlocks !== undefined
        ? {
            output: fullOutput,
            accumulatedText: evalResult.accumulatedText,
            textBlocks: evalResult.textBlocks,
          }
        : undefined;

    const durationMs = Date.now() - startedAt;
    // S1.0/P1.1: usa o costUsd ja calculado pelo executor (D6).
    const costUsd = evalResult.metrics.costUsd;

    // 5. Parse and validate the evaluation output
    const { evaluation: rawEvaluation, tier: parseTier } = evalExtractSource
      ? extractEvaluationJSON(evalExtractSource, round, sprintJson.id)
      : (() => {
          const meta: { repaired?: boolean } = {};
          const evaluation = parseEvaluationOutput(fullOutput, round, meta);
          return { evaluation, tier: meta.repaired ? 'jsonrepair' : ('result' as const) };
        })();
    let evaluation = rawEvaluation;
    evaluation = validateCriteria(evaluation, sprintJson);

    // 6. Save evaluation.json to filesystem
    const sprintDir = path.join(
      this.getProjectDir(projectId),
      'sprints',
      sprintJson.id,
    );
    fs.mkdirSync(sprintDir, { recursive: true });
    const evalPath = path.join(sprintDir, 'evaluation.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2), 'utf-8');

    logger.info(
      { projectId, sprintId: sprint.id, round, verdict: evaluation.verdict, durationMs, costUsd, toolUses: evalToolUses, apiRequests: evalApiRequests },
      'Evaluator finished',
    );

    return {
      inputTokens: evalInputTokens,
      outputTokens: evalOutputTokens,
      cacheTokens: evalCacheTokens,
      costUsd,
      durationMs,
      toolUses: evalToolUses,
      apiRequests: evalApiRequests,
      evaluation,
      output: fullOutput,
      toolCallsAccum: evalToolCallsAccum,
      costSource: evalCostSource,
      runtimeUsed: evalRuntimeUsed,
      providerUsed: evalProviderUsed,
      modelUsed: evalModelUsed,
      parseTier,
    };
  }

  async run(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    state.status = 'running';
    state.abortController = new AbortController();
    state.pauseRequested = false;

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const sprints = getHarnessSprints(projectId);
    if (sprints.length === 0) throw new Error('No sprints found for project');

    setProjectStatus(projectId, 'running');
    this.emitIPC('harness:project-update', { projectId, status: 'running' });

    for (let i = 0; i < sprints.length; i++) {
      if (state.pauseRequested) {
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        break;
      }

      const sprint = sprints[i];
      if (sprint.status === 'passed' || sprint.status === 'skipped') continue;

      state.currentSprintIndex = i;
      updateHarnessProject(projectId, { currentSprintIndex: i });

      // Mark sprint as running
      updateHarnessSprint(sprint.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

      // Read sprints.json do canonical no projeto-alvo (era getProjectDir legado). Ver Bug #8.
      const sprintsJson = readHarnessSprintsJson(project);
      if (!sprintsJson) {
        logger.error({ projectId, sprintId: sprint.id }, 'No sprints.json found during run');
        updateHarnessSprint(sprint.id, { status: 'failed' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        continue;
      }

      const sprintJson = sprintsJson.sprints.find(s => s.id === sprint.sprintJsonId);
      if (!sprintJson) {
        logger.error({ projectId, sprintId: sprint.id, sprintJsonId: sprint.sprintJsonId }, 'Sprint JSON entry not found');
        updateHarnessSprint(sprint.id, { status: 'failed' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        continue;
      }

      const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
      let lastFeedback: string | undefined;
      let sprintPassed = false;

      for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
        if (state.abortController?.signal.aborted) break;
        if (state.pauseRequested) break;

        logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'Starting coder round');

        // Insert round record
        const roundRecord = persistHarnessRound.insert({
          sprintId: sprint.id,
          roundNumber: roundNum,
        });

        let coderMetrics: Awaited<ReturnType<typeof this.spawnCoder>>;
        try {
          coderMetrics = await this.spawnCoder(
            projectId,
            sprint,
            sprintJson,
            roundNum,
            roundNum > 1 ? lastFeedback : undefined,
          );
        } catch (coderErr) {
          logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
          persistHarnessRound.update(roundRecord.id, {
            verdict: 'fail',
            feedbackSummary: (coderErr as Error).message,
            completedAt: new Date().toISOString(),
          });
          break;
        }

        // Persist coder metrics (verdict will be set by the Evaluator below)
        persistHarnessRound.update(roundRecord.id, {
          coderInputTokens: coderMetrics.inputTokens,
          coderOutputTokens: coderMetrics.outputTokens,
          coderCacheTokens: coderMetrics.cacheTokens,
          coderCostUsd: coderMetrics.costUsd,
          coderDurationMs: coderMetrics.durationMs,
          coderToolUses: coderMetrics.toolUses,
          coderApiRequests: coderMetrics.apiRequests,
          costSource: coderMetrics.costSource,
          runtimeUsed: coderMetrics.runtimeUsed,
          providerUsed: coderMetrics.providerUsed,
          modelUsed: coderMetrics.modelUsed,
        });

        // Update rounds used counter
        updateHarnessSprint(sprint.id, { roundsUsed: roundNum });

        // --- Evaluator phase ---
        let evaluatorMetrics: Awaited<ReturnType<typeof this.spawnEvaluator>>;
        try {
          evaluatorMetrics = await this.spawnEvaluator(
            projectId,
            sprint,
            sprintJson,
            roundNum,
          );
        } catch (evalErr) {
          logger.error(
            { err: evalErr, projectId, sprintId: sprint.id, round: roundNum },
            'Evaluator failed',
          );
          persistHarnessRound.update(roundRecord.id, {
            verdict: 'fail',
            feedbackSummary: (evalErr as Error).message,
            completedAt: new Date().toISOString(),
          });
          break;
        }

        // Persist evaluator metrics + verdict
        persistHarnessRound.update(roundRecord.id, {
          evaluatorInputTokens: evaluatorMetrics.inputTokens,
          evaluatorOutputTokens: evaluatorMetrics.outputTokens,
          evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
          evaluatorCostUsd: evaluatorMetrics.costUsd,
          evaluatorDurationMs: evaluatorMetrics.durationMs,
          evaluatorToolUses: evaluatorMetrics.toolUses,
          evaluatorApiRequests: evaluatorMetrics.apiRequests,
          verdict: evaluatorMetrics.evaluation.verdict,
          feedbackSummary: evaluatorMetrics.evaluation.summary,
          completedAt: new Date().toISOString(),
        });

        this.emitIPC('harness:sprint-update', {
          projectId,
          sprintId: sprint.id,
          round: roundNum,
          verdict: evaluatorMetrics.evaluation.verdict,
          coderMetrics,
          evaluatorMetrics: {
            inputTokens: evaluatorMetrics.inputTokens,
            outputTokens: evaluatorMetrics.outputTokens,
            cacheTokens: evaluatorMetrics.cacheTokens,
            costUsd: evaluatorMetrics.costUsd,
            durationMs: evaluatorMetrics.durationMs,
            toolUses: evaluatorMetrics.toolUses,
            apiRequests: evaluatorMetrics.apiRequests,
          },
        });

        if (evaluatorMetrics.evaluation.verdict === 'pass') {
          // Count completed sprints (this one included)
          const allSprints = getHarnessSprints(projectId);
          const completedCount = allSprints.filter(
            s => s.status === 'passed' || s.id === sprint.id,
          ).length;
          updateSpecProgress(
            project.projectPath,
            project.name,
            sprintJson,
            sprints.length,
            completedCount,
          );
          sprintPassed = true;
          break;
        } else {
          // Set feedback for next round
          lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);

          // Audit trail: persist exactly what the evaluator returned and what will be injected
          this.persistFeedbackAudit(
            projectId,
            sprint.id,
            roundNum,
            evaluatorMetrics.evaluation.verdict,
            evaluatorMetrics.evaluation.summary,
            evaluatorMetrics.evaluation.criteria
              .filter(c => c.result === 'fail')
              .map(c => ({ description: c.description, justification: c.justification })),
            lastFeedback,
          );

          logger.info(
            { projectId, sprintId: sprint.id, round: roundNum, feedbackLen: lastFeedback.length },
            'Sprint failed evaluation, feedback persisted, retrying...',
          );
        }
      }

      if (state.pauseRequested) {
        updateHarnessSprint(sprint.id, { status: 'interrupted' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'interrupted' });
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        // Abort resets sprint to pending so resume can re-execute it
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
        break;
      }

      if (sprintPassed) {
        updateHarnessSprint(sprint.id, {
          status: 'passed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
        logger.info({ projectId, sprintId: sprint.id }, 'Sprint passed');
      } else {
        // Max rounds exhausted with fail - pause for user intervention
        updateHarnessSprint(sprint.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        setProjectStatus(projectId, 'paused');
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        logger.warn(
          { projectId, sprintId: sprint.id, maxRounds },
          'Sprint exhausted max rounds - harness paused for user intervention',
        );
        return;
      }
    }

    if (!state.abortController?.signal.aborted) {
      setProjectStatus(projectId, 'done');
      this.emitIPC('harness:project-update', { projectId, status: 'done' });

      // Smoke Test (informativo, NAO bloqueia)
      try {
        // Le sprints.json do canonical no projeto-alvo. Ver Bug #8.
        const sprintsJson = readHarnessSprintsJson(project);
        const expectedFiles = sprintsJson?.sprints.flatMap(s => s.hints?.existing_files ?? []) ?? [];
        const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
        const reportPath = docsCtx
          ? docsCtx.resolveDocPath('smoke-test.md')
          : path.join(project.projectPath, 'smoke-test.md');
        const smoke = await runSmokeTest(project.projectPath, expectedFiles);
        writeSmokeTestReport(smoke, reportPath);
        logger.info(
          {
            projectId,
            reportPath,
            typecheckOk: smoke.typecheck.ok,
            lintAvailable: smoke.lint.available,
            testsAvailable: smoke.tests.available,
            brokenImports: smoke.brokenImports.length,
            missingFiles: smoke.missingFiles.length,
          },
          'Smoke test completed',
        );
      } catch (smokeErr) {
        logger.warn({ err: smokeErr, projectId }, 'Smoke test failed (non-blocking)');
      }
    }
    state.status = 'idle';
  }

  /**
   * Run a single sprint by index, returning aggregated metrics.
   * Used by PipelineEngine to run sprints one-at-a-time with stream bridging.
   */
  async runSingleSprint(projectId: string, sprintIndex: number): Promise<SprintResult> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (0..${sprints.length - 1})`);
    }

    const sprint = sprints[sprintIndex];
    // Le sprints.json do canonical no projeto-alvo. Ver Bug #8.
    const sprintsJson = readHarnessSprintsJson(project);
    if (!sprintsJson) throw new Error('No sprints.json found');

    const sprintJson = sprintsJson.sprints.find(s => s.id === sprint.sprintJsonId);
    if (!sprintJson) throw new Error(`Sprint JSON entry not found for ${sprint.sprintJsonId}`);

    const state = this.getState(projectId);
    state.status = 'running';
    state.abortController = new AbortController();

    // Mark sprint as running
    updateHarnessSprint(sprint.id, { status: 'running', startedAt: new Date().toISOString() });
    this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

    const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
    let lastFeedback: string | undefined;
    let sprintPassed = false;
    let totalRounds = 0;

    const aggCoder: SprintMetrics = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0, model: null, runtime: null };
    const aggEval: SprintMetrics = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0, model: null, runtime: null };

    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      if (state.abortController?.signal.aborted) break;

      totalRounds = roundNum;
      logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'runSingleSprint: coder round');

      const roundRecord = persistHarnessRound.insert({ sprintId: sprint.id, roundNumber: roundNum });

      if (roundNum > 1) {
        const coderAgentForModel = sprint.coderAgentId ? getAgent(sprint.coderAgentId) : null;
        this.emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 13,
          phaseName: 'Coder',
          status: 'running',
          awaitingUser: false,
          currentModel: coderAgentForModel?.model ?? null,
        });
      }

      // --- Coder ---
      let coderMetrics: Awaited<ReturnType<typeof this.spawnCoder>>;
      try {
        coderMetrics = await this.spawnCoder(projectId, sprint, sprintJson, roundNum, roundNum > 1 ? lastFeedback : undefined);
      } catch (coderErr) {
        logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
        persistHarnessRound.update(roundRecord.id, { verdict: 'fail', feedbackSummary: (coderErr as Error).message, completedAt: new Date().toISOString() });
        break;
      }

      persistHarnessRound.update(roundRecord.id, {
        coderInputTokens: coderMetrics.inputTokens,
        coderOutputTokens: coderMetrics.outputTokens,
        coderCacheTokens: coderMetrics.cacheTokens,
        coderCostUsd: coderMetrics.costUsd,
        coderDurationMs: coderMetrics.durationMs,
        coderToolUses: coderMetrics.toolUses,
        coderApiRequests: coderMetrics.apiRequests,
        costSource: coderMetrics.costSource,
        runtimeUsed: coderMetrics.runtimeUsed,
        providerUsed: coderMetrics.providerUsed,
        modelUsed: coderMetrics.modelUsed,
        // SPEC Camada 4: persistencia da telemetria Codex (sempre 0 para outros runtimes)
        codexPatchFailures: coderMetrics.codexPatchFailures,
      });
      aggCoder.inputTokens += coderMetrics.inputTokens;
      aggCoder.outputTokens += coderMetrics.outputTokens;
      aggCoder.cacheTokens += coderMetrics.cacheTokens;
      aggCoder.costUsd += coderMetrics.costUsd;
      aggCoder.durationMs += coderMetrics.durationMs;
      aggCoder.toolUses += coderMetrics.toolUses;
      aggCoder.apiRequests += coderMetrics.apiRequests;
      aggCoder.model = coderMetrics.modelUsed;
      aggCoder.runtime = coderMetrics.runtimeUsed;

      // Persist coder prompt (user role) and output (assistant role) to pipeline_messages
      try {
        if (coderMetrics.promptUsed) {
          persistMessage(
            {
              kind: 'pipeline',
              projectId,
              phaseNumber: 13,
              sprintIndex,
              roundIndex: roundNum,
              agentId: sprint.coderAgentId ?? 'harness-coder',
            },
            'user',
            coderMetrics.promptUsed,
          );
        }
        if (coderMetrics.output) {
          persistMessage(
            {
              kind: 'pipeline',
              projectId,
              phaseNumber: 13,
              sprintIndex,
              roundIndex: roundNum,
              agentId: sprint.coderAgentId ?? 'harness-coder',
            },
            'assistant',
            coderMetrics.output,
            { toolCalls: coderMetrics.toolCallsAccum.length > 0 ? coderMetrics.toolCallsAccum : undefined },
          );
        }
      } catch (saveErr) {
        logger.warn({ err: saveErr, projectId, sprintId: sprint.id, round: roundNum }, 'Failed to save coder pipeline_message — non-critical');
      }

      updateHarnessSprint(sprint.id, { roundsUsed: roundNum });

      const evaluatorAgentForModel = sprint.evaluatorAgentId ? getAgent(sprint.evaluatorAgentId) : null;
      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 14,
        phaseName: 'Evaluator',
        status: 'running',
        awaitingUser: false,
        currentModel: evaluatorAgentForModel?.model ?? null,
      });

      // --- Evaluator ---
      // Retry 1x quando erro for JSON parse (sonnet as vezes nao emite JSON valido
      // por output truncado, max_tokens hit, ou abort intermitente). Erros nao-parse
      // (network, abort do user, etc) falham direto sem retry.
      const MAX_EVAL_RETRIES = 1;
      let evaluatorMetrics: Awaited<ReturnType<typeof this.spawnEvaluator>> | undefined;
      let evalFinalError: Error | undefined;
      for (let evalAttempt = 0; evalAttempt <= MAX_EVAL_RETRIES; evalAttempt++) {
        try {
          evaluatorMetrics = await this.spawnEvaluator(projectId, sprint, sprintJson, roundNum);
          break;
        } catch (evalErr) {
          const msg = (evalErr as Error).message ?? '';
          const isParseError =
            msg.includes('contains no JSON object') ||
            msg.includes('contains no valid JSON') ||
            msg.includes('Evaluator returned empty output');
          if (isParseError && evalAttempt < MAX_EVAL_RETRIES) {
            logger.warn(
              { projectId, sprintId: sprint.id, round: roundNum, evalAttempt: evalAttempt + 1, totalAttempts: MAX_EVAL_RETRIES + 1 },
              'Evaluator JSON parse falhou — retrying',
            );
            continue;
          }
          evalFinalError = evalErr as Error;
          break;
        }
      }

      if (!evaluatorMetrics) {
        logger.error({ err: evalFinalError, projectId, sprintId: sprint.id, round: roundNum }, 'Evaluator failed (apos retries)');
        persistHarnessRound.update(roundRecord.id, { verdict: 'fail', feedbackSummary: evalFinalError?.message ?? 'Evaluator falhou', completedAt: new Date().toISOString() });
        break;
      }

      persistHarnessRound.update(roundRecord.id, {
        evaluatorInputTokens: evaluatorMetrics.inputTokens,
        evaluatorOutputTokens: evaluatorMetrics.outputTokens,
        evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
        evaluatorCostUsd: evaluatorMetrics.costUsd,
        evaluatorDurationMs: evaluatorMetrics.durationMs,
        evaluatorToolUses: evaluatorMetrics.toolUses,
        evaluatorApiRequests: evaluatorMetrics.apiRequests,
        verdict: evaluatorMetrics.evaluation.verdict,
        feedbackSummary: evaluatorMetrics.evaluation.summary,
        completedAt: new Date().toISOString(),
        metadata: { evaluatorParseTier: evaluatorMetrics.parseTier },
      });
      aggEval.inputTokens += evaluatorMetrics.inputTokens;
      aggEval.outputTokens += evaluatorMetrics.outputTokens;
      aggEval.cacheTokens += evaluatorMetrics.cacheTokens;
      aggEval.costUsd += evaluatorMetrics.costUsd;
      aggEval.durationMs += evaluatorMetrics.durationMs;
      aggEval.toolUses += evaluatorMetrics.toolUses;
      aggEval.apiRequests += evaluatorMetrics.apiRequests;
      aggEval.model = evaluatorMetrics.modelUsed;
      aggEval.runtime = evaluatorMetrics.runtimeUsed;

      // Persist evaluator output (assistant role) to pipeline_messages
      try {
        if (evaluatorMetrics.output) {
          persistMessage(
            {
              kind: 'pipeline',
              projectId,
              phaseNumber: 14,
              sprintIndex,
              roundIndex: roundNum,
              agentId: sprint.evaluatorAgentId ?? 'harness-evaluator',
            },
            'assistant',
            evaluatorMetrics.output,
            { toolCalls: evaluatorMetrics.toolCallsAccum.length > 0 ? evaluatorMetrics.toolCallsAccum : undefined },
          );
        }
      } catch (saveErr) {
        logger.warn({ err: saveErr, projectId, sprintId: sprint.id, round: roundNum }, 'Failed to save evaluator pipeline_message — non-critical');
      }

      this.emitIPC('harness:sprint-update', {
        projectId,
        sprintId: sprint.id,
        round: roundNum,
        verdict: evaluatorMetrics.evaluation.verdict,
        coderMetrics,
        evaluatorMetrics: {
          inputTokens: evaluatorMetrics.inputTokens,
          outputTokens: evaluatorMetrics.outputTokens,
          cacheTokens: evaluatorMetrics.cacheTokens,
          costUsd: evaluatorMetrics.costUsd,
          durationMs: evaluatorMetrics.durationMs,
          toolUses: evaluatorMetrics.toolUses,
          apiRequests: evaluatorMetrics.apiRequests,
        },
      });

      if (evaluatorMetrics.evaluation.verdict === 'pass') {
        const allSprints = getHarnessSprints(projectId);
        const completedCount = allSprints.filter(s => s.status === 'passed' || s.id === sprint.id).length;
        updateSpecProgress(project.projectPath, project.name, sprintJson, sprints.length, completedCount);
        sprintPassed = true;
        break;
      } else {
        lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);
        this.persistFeedbackAudit(
          projectId,
          sprint.id,
          roundNum,
          evaluatorMetrics.evaluation.verdict,
          evaluatorMetrics.evaluation.summary,
          evaluatorMetrics.evaluation.criteria
            .filter(c => c.result === 'fail')
            .map(c => ({ description: c.description, justification: c.justification })),
          lastFeedback,
        );
      }
    }

    const finalVerdict = sprintPassed ? 'pass' : 'fail';

    if (sprintPassed) {
      updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
    } else {
      updateHarnessSprint(sprint.id, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
    }

    state.status = 'idle';

    return {
      verdict: finalVerdict,
      rounds: totalRounds,
      metrics: { coder: aggCoder, evaluator: aggEval },
      coderMetrics: aggCoder,
      evaluatorMetrics: aggEval,
    };
  }

  pause(projectId: string): void {
    const state = this.getState(projectId);
    state.pauseRequested = true;
    logger.info({ projectId }, 'Pause requested');
  }

  resume(projectId: string): void {
    // Check DB status (not in-memory state) since abort() resets state to idle
    const project = getHarnessProject(projectId);
    if (!project) {
      logger.warn({ projectId }, 'Resume: project not found');
      return;
    }

    if (project.status !== 'paused') {
      logger.warn({ projectId, status: project.status }, 'Resume: project is not paused');
      return;
    }

    const state = this.getState(projectId);
    state.pauseRequested = false;
    state.status = 'idle'; // Reset so run() can take over

    // Reset interrupted sprints to pending so they can be re-executed
    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'interrupted') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    this.run(projectId).catch(err => {
      logger.error({ err, projectId }, 'Error resuming harness');
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
    });
  }

  abort(projectId: string): void {
    const state = this.getState(projectId);
    if (state.abortController) {
      state.abortController.abort();
    }

    // Reset any running sprint to pending so it can be re-executed on resume
    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'running') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    state.status = 'idle';
    // Persist 'paused' (not 'aborted'): user can resume from this state. The
    // resume() method explicitly checks for status === 'paused' to re-execute.
    setProjectStatus(projectId, 'paused');
    this.emitIPC('harness:project-update', { projectId, status: 'paused' });
    logger.info({ projectId }, 'Harness aborted - project paused for resume');
  }

  getStatus(projectId: string): HarnessState {
    return this.getState(projectId);
  }

  /** Returns true if an enrich session is currently active. */
  hasActiveEnrichSession(): boolean {
    return this.activeEnrichSession !== null;
  }

  // ---- Enrich Pipeline ----

  /**
   * Internal helper: run one executeAgent() call for an enrich agent and stream
   * events to the renderer. Returns accumulated metrics for the turn.
   *
   * S1.1 refactor: substituiu a antiga implementacao que chamava query() direto
   * do SDK por executeAgent + perfil PERM_DEFAULT_WITH_GUARD com
   * createEnrichPermissionGuard. O guard preserva 100% o comportamento atual:
   * auto-approve em activeEnrichAllowedPaths, delega para o guard padrao em
   * todo o resto.
   *
   * Diferenca vs implementacao anterior: o evento 'thinking' nao e mais emitido
   * porque executeAgent (via cloud-executor) nao expoe onThinking. O renderer
   * hoje so consome text/tool_call/done. Se thinking voltar a ser necessario,
   * sera preciso expor onThinking no AgentExecutionRequest e passa-lo down ate
   * o cloud-executor.
   */
  private async runEnrichExecuteAgent(
    prompt: string,
    agent: import('../../src/types').AgentConfig,
    specPath: string,
    sessionId: string,
    phase: 'validator' | 'enricher',
    isFollowUp?: boolean,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  }> {
    // Use the abort controller from the active enrich session
    const abort = this.activeEnrichSession?.abort ?? new AbortController();

    // Determine cwd: use the parent directory of the SPEC file as context
    const cwd = path.dirname(specPath);

    logger.info(
      { sessionId, phase, agentId: agent.id, model: agent.model, cwd, isFollowUp },
      'Starting enrich agent via executeAgent',
    );

    // Accumulators for persisting the full assistant message after the stream
    let accumulatedText = '';
    const accumulatedToolCalls: Array<{ tool: string; input: unknown }> = [];

    const enrichGuard = createEnrichPermissionGuard(this.getWindow);

    const startedAt = Date.now();

    const result = await executeAgent({
      agentId: agent.id,
      prompt,
      cwd,
      abortController: abort,
      permission: PERM_DEFAULT_WITH_GUARD(enrichGuard),
      onText: (text) => {
        accumulatedText += text;
        this.emitIPC('enrich:stream', {
          type: 'text',
          content: text,
          sessionId,
          phase,
        });
      },
      onThinking: (text) => {
        this.emitIPC('enrich:stream', {
          type: 'thinking',
          content: text,
          sessionId,
          phase,
        });
      },
      onToolUse: (toolName) => {
        this.emitIPC('enrich:stream', {
          type: 'tool_call',
          tool: toolName,
          sessionId,
          phase,
        });
      },
      onToolUseComplete: (toolName, input) => {
        accumulatedToolCalls.push({ tool: toolName, input: input ?? {} });
      },
    });

    // Emit 'done' so the renderer knows the agent has finished its turn.
    // executeAgent has no onResult callback — it only resolves when complete —
    // so we synthesize the 'done' event here.
    if (result.output) {
      this.emitIPC('enrich:stream', {
        type: 'done',
        content: result.output,
        sessionId,
        phase,
      });
    } else {
      this.emitIPC('enrich:stream', {
        type: 'done',
        sessionId,
        phase,
      });
    }
    logger.info({ sessionId, phase }, 'Enrich agent turn completed');

    // Persist the full assistant message to the database
    if (accumulatedText || accumulatedToolCalls.length > 0) {
      try {
        persistMessage(
          { kind: 'enrich', sessionId, phase },
          'assistant',
          accumulatedText,
          { toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined },
        );
      } catch (err) {
        logger.error({ err, sessionId, phase }, 'Failed to persist enrich assistant message');
      }
    }

    const durationMs = Date.now() - startedAt;
    // S1.3: usa o costUsd ja computado pelo executor (cloud-executor chama
    // calculateCost internamente com os mesmos args). Recalcular aqui causaria
    // double-count. Ver JSDoc em pricing.ts:calculateCost para o pattern.
    const costUsd = result.metrics.costUsd;

    logger.info(
      {
        sessionId,
        phase,
        durationMs,
        costUsd,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
      },
      'Enrich executeAgent metrics collected',
    );

    return {
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      cacheCreationTokens: result.metrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: result.metrics.toolUses,
      apiRequests: result.metrics.apiRequests,
    };
  }

  /**
   * Start an enrich session by launching the Validator agent with the
   * initial prompt built from the SPEC file and optional project/PRD paths.
   *
   * The session is CONVERSATIONAL: the agent waits after presenting its
   * report and the user can send follow-up messages via sendEnrichMessage().
   */
  async startEnrichSession(
    config: CreateEnrichConfig & { sessionId: string },
  ): Promise<void> {
    // Concurrency guard: only one enrich session at a time
    if (this.activeEnrichSession !== null) {
      throw new Error(
        'Ja existe uma sessao de enrich ativa. Finalize ou aborte a sessao atual antes de iniciar uma nova.',
      );
    }

    logger.info({ sessionId: config.sessionId }, 'Starting enrich session');

    // 1. Validate SPEC file exists (agent will Read it via tools)
    if (!fs.existsSync(config.specPath)) {
      throw new Error(`SPEC file not found: ${config.specPath}`);
    }

    // 2. Validate PRD file exists if provided (agent will Read it via tools)
    if (config.prdPath && !fs.existsSync(config.prdPath)) {
      throw new Error(`PRD file not found: ${config.prdPath}`);
    }

    // 3. Get validator agent config
    const validatorAgent = getAgent(config.validatorAgentId);
    if (!validatorAgent) {
      throw new Error(`Validator agent not found: ${config.validatorAgentId}`);
    }

    // 4. Build the validator prompt (paths only, agent reads files via Read tool)
    const prompt = buildValidatorPrompt(
      config.specPath,
      config.projectPath,
      config.prdPath,
      config.message,
    );

    // 5. Register the active enrich session
    const abort = new AbortController();
    this.activeEnrichSession = {
      sessionId: config.sessionId,
      specPath: config.specPath,
      phase: 'validator',
      abort,
    };

    // 6. Register the SPEC path so Write/Edit are auto-approved
    setActiveEnrichSpecPath(config.specPath);

    // 7. Update session status to running
    updateEnrichSession(config.sessionId, { status: 'running', phase: 'validator' });

    this.emitIPC('enrich:status', {
      sessionId: config.sessionId,
      phase: 'validator',
      status: 'running',
    });

    try {
      // 8. Persist the initial user prompt as the first message of the session
      try {
        persistMessage({ kind: 'enrich', sessionId: config.sessionId, phase: 'validator' }, 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId: config.sessionId }, 'Failed to persist enrich initial user message');
      }

      // 9. Run the validator agent (first turn)
      const metrics = await this.runEnrichExecuteAgent(
        prompt,
        validatorAgent,
        config.specPath,
        config.sessionId,
        'validator',
      );

      // 9. Accumulate metrics and persist them
      accumulateEnrichMetrics(config.sessionId, 'validator', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      // 10. Emit metrics to renderer
      this.emitIPC('enrich:metrics', {
        sessionId: config.sessionId,
        phase: 'validator',
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      // 11. Session is now waiting for user input
      updateEnrichSession(config.sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'waiting',
      });

      logger.info({ sessionId: config.sessionId }, 'Enrich session started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId: config.sessionId }, 'Enrich session failed during startup');
      updateEnrichSession(config.sessionId, { status: 'idle' });
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'idle',
      });
      throw err;
    }
  }

  /**
   * Send a follow-up message to the active enrich session agent.
   *
   * Each call creates a new query() turn with the user message as the prompt.
   * The Agent SDK maintains conversation history via its session files so
   * the agent has full context of the previous exchange.
   */
  async sendEnrichMessage(sessionId: string, message: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);

    const phase = this.activeEnrichSession.phase;
    const specPath = this.activeEnrichSession.specPath;

    // Determine which agent to use based on current phase
    let agentId: string;
    if (phase === 'validator') {
      agentId = session.validatorAgentId;
    } else if (phase === 'enricher') {
      agentId = session.enricherAgentId;
    } else {
      throw new Error(`Enrich session is in terminal phase: ${phase}`);
    }

    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    logger.info(
      { sessionId, phase, agentId, messageLen: message.length },
      'Sending message to enrich agent',
    );

    // Mark session as running for this turn
    updateEnrichSession(sessionId, { status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase, status: 'running' });

    // Persist the user message before querying the agent
    try {
      persistMessage({ kind: 'enrich', sessionId, phase: phase as 'validator' | 'enricher' }, 'user', message);
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Failed to persist enrich user message');
    }

    // Build a follow-up prompt that tells the agent to read its persistent
    // report/suggestions file for context instead of replaying conversation history.
    const fullPrompt = phase === 'validator'
      ? buildValidatorFollowUpPrompt(specPath, message)
      : buildEnricherFollowUpPrompt(specPath, message);

    try {
      const metrics = await this.runEnrichExecuteAgent(
        fullPrompt,
        agent,
        specPath,
        sessionId,
        phase as 'validator' | 'enricher',
        true,
      );

      // Accumulate metrics for this turn
      accumulateEnrichMetrics(sessionId, phase as 'validator' | 'enricher', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      // Emit updated metrics to renderer
      this.emitIPC('enrich:metrics', {
        sessionId,
        phase,
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      // Return to waiting state for the next user message
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });

      logger.info({ sessionId, phase }, 'Enrich message processed - waiting for next input');
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Enrich message failed');
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });
      throw err;
    }
  }

  /**
   * Transition an enrich session from the validator phase to the enricher
   * phase. Reads the current (now-corrected) SPEC content and launches the
   * Enricher agent.
   */
  async approveEnrichPhase(sessionId: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);
    if (session.phase !== 'validator') {
      throw new Error(`Cannot approve phase transition from phase: ${session.phase}`);
    }

    logger.info({ sessionId }, 'Approving phase transition: validator -> enricher');

    // Abort the current Validator query so it stops processing
    logger.info({ sessionId }, 'Aborting validator abort controller before enricher transition');
    this.activeEnrichSession.abort.abort();

    const enricherAgent = getAgent(session.enricherAgentId);
    if (!enricherAgent) throw new Error(`Enricher agent not found: ${session.enricherAgentId}`);

    // Build prompt with paths only - agent reads files via Read tool
    const prompt = buildEnricherPrompt(
      session.specPath,
      session.projectPath ?? undefined,
    );

    // Update the in-memory session phase
    this.activeEnrichSession.phase = 'enricher';

    // Create a fresh AbortController for the enricher - the old validator one is aborted
    this.activeEnrichSession.abort = new AbortController();
    logger.info({ sessionId }, 'New AbortController created for enricher phase');

    // Persist phase transition
    updateEnrichSession(sessionId, { phase: 'enricher', status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'running' });

    try {
      // Persist the enricher initial prompt as the first user message of the enricher phase
      try {
        persistMessage({ kind: 'enrich', sessionId, phase: 'enricher' }, 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId }, 'Failed to persist enrich enricher initial user message');
      }

      const metrics = await this.runEnrichExecuteAgent(
        prompt,
        enricherAgent,
        session.specPath,
        sessionId,
        'enricher',
      );

      accumulateEnrichMetrics(sessionId, 'enricher', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      this.emitIPC('enrich:metrics', {
        sessionId,
        phase: 'enricher',
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });

      logger.info({ sessionId }, 'Enricher phase started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId }, 'Enricher phase launch failed');
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });
      throw err;
    }
  }

  /**
   * Finalize the enrich session: create the `.enriched.md` copy, mark it as
   * done, clear the active session state so subsequent permission checks no
   * longer auto-approve writes to the SPEC file, and return the final path.
   */
  finalizeEnrichSession(sessionId: string): string {
    logger.info({ sessionId }, 'Finalizing enrich session');

    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) {
      throw new Error(`Enrich session not found: ${sessionId}`);
    }

    // Read final SPEC content (after enricher edits)
    if (!fs.existsSync(session.specPath)) {
      throw new Error(`SPEC file not found at finalization time: ${session.specPath}`);
    }
    const finalContent = fs.readFileSync(session.specPath, 'utf-8');
    logger.info({ sessionId, specPath: session.specPath, size: finalContent.length }, 'Read final SPEC content');

    // Build the enriched copy path: avoid double-suffixing .enriched.md
    const parsed = path.parse(session.specPath);
    let enrichedPath: string;
    if (parsed.name.endsWith('.enriched')) {
      // Already has .enriched in the name - don't double it
      enrichedPath = session.specPath;
      logger.info({ sessionId, enrichedPath }, 'SPEC already has .enriched suffix - using original path');
    } else {
      enrichedPath = path.join(parsed.dir, parsed.name + '.enriched' + parsed.ext);
      logger.info({ sessionId, enrichedPath }, 'Creating enriched copy');
      fs.writeFileSync(enrichedPath, finalContent, 'utf-8');
      logger.info({ sessionId, enrichedPath }, 'Enriched copy written');
    }

    // Update DB: phase = 'done', status = 'done', finalSpecPath = enrichedPath
    updateEnrichSession(sessionId, {
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    // Clear active session and release permission guard override
    setActiveEnrichSpecPath(null);
    this.activeEnrichSession = null;

    // Emit final status to renderer
    this.emitIPC('enrich:status', {
      sessionId,
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    logger.info({ sessionId, enrichedPath }, 'Enrich session finalized successfully');
    return enrichedPath;
  }

  /**
   * Abort the currently active enrich session.
   */
  abortEnrichSession(sessionId: string): void {
    logger.info({ sessionId }, 'Aborting enrich session');

    if (this.activeEnrichSession?.sessionId === sessionId) {
      const phase = this.activeEnrichSession.phase;
      logger.info({ sessionId, phase }, 'Aborting active enrich session abort controller');
      this.activeEnrichSession.abort.abort();
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
    }

    const session = getEnrichSession(sessionId);
    const currentPhase = session?.phase ?? 'validator';

    updateEnrichSession(sessionId, { status: 'idle' });
    this.emitIPC('enrich:status', { sessionId, phase: currentPhase, status: 'idle' });
    logger.info({ sessionId, phase: currentPhase }, 'Enrich session aborted');
  }
}
