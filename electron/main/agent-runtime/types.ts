import type { CanUseTool, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { OllamaChatMessage, OllamaToolCallRecord } from '../ollama-client';
import type { AgentConfig } from '../../../src/types';
import type { CodexSession } from '../codex-bridge';

export type ToolDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface AgentPermissionProfile {
  mode: PermissionMode;
  dangerouslySkipPermissions: boolean;
  canUseTool?: CanUseTool;
}

export interface AgentExecutionRequest {
  agentId: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  permission: AgentPermissionProfile;
  continueSession?: boolean;
  priorMessages?: OllamaChatMessage[];
  /**
   * When set, called with the systemPrompt resolved by agent-config-resolver and its
   * return value is used as the final systemPrompt sent to the executor.
   * Used by the Harness to inject git restrictions into custom DB coders/evaluators
   * without modifying the stored agent record and without re-resolving the config.
   */
  systemPromptTransform?: (resolved: string) => string;
  onText?: (chunk: string) => void;
  /**
   * Cloud runtime only. Called for thinking/reasoning chunks emitted by the SDK.
   * Other runtimes leave it unwired (Ollama/External/Codex don't surface
   * thinking the same way). Optional — callers that ignore it (most pipelines)
   * just don't pass it.
   */
  onThinking?: (chunk: string) => void;
  onToolUse?: (tool: string) => void;
  onToolUseComplete?: (tool: string, input: unknown) => void;
  /**
   * Sinal generico de "evento recebido do runtime" (qualquer evento prova vida).
   * Usado pela watchdog do executeAgent pra resetar o timer mesmo quando o evento
   * nao se traduz em text/thinking/tool. Ver BUGFIXTESTESV1.md Bug #7.
   *
   * Hoje so o codex-executor repassa esse callback. Cloud/Local/External nao
   * precisam porque seus eventos sempre se traduzem em text/thinking/tool.
   */
  onActivity?: () => void;
  /**
   * Called when the agent produces no progress for WATCHDOG_TIMEOUT_MS.
   * Supplied by the caller (e.g. pipeline-engine wraps it with pipeline:stalled IPC).
   */
  onStalled?: (info: { lastChunkAt: number; secondsSinceLastChunk: number }) => void;
  /**
   * Codex runtime only. When provided, codex-executor will use session.reply()
   * instead of creating a new session + session.send(). This enables multi-turn
   * continuation within the same phase (D2 in SPEC).
   *
   * Lifecycle: the pipeline-engine owns the session and is responsible for
   * calling session.close() when the phase ends.
   */
  codexSession?: CodexSession;
  /**
   * Codex runtime only. Called by codex-executor after it creates a new CodexSession.
   * The caller stores the session for subsequent turns within the same phase.
   * When this callback is supplied, the executor does NOT close the session on
   * return — the caller takes ownership of the lifecycle.
   */
  onCodexSessionCreated?: (session: CodexSession) => void;
  /**
   * S4.3 (Onda 4): identifica o projeto pipeline que originou a chamada.
   * Repassado pelo codex-executor pra createCodexSession e dali pro ProcessSlot,
   * permitindo que `resetCodexPool(projectId)` mate apenas slots desse projeto.
   * Quando ausente, o slot fica sem projectId e e afetado por reset global
   * (resetCodexPool sem argumento). Runtimes nao-codex ignoram esse campo.
   */
  projectId?: string;
}

export interface AgentExecutionResult {
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
  toolCalls?: OllamaToolCallRecord[];
  /**
   * Full accumulated text from all text blocks (cloud runtime only).
   * Populated by cloud-executor to enable multi-tier JSON fallback in
   * extractJSON (accumulatedText > result when SDK splits output across blocks).
   * Local/external/codex runtimes leave this undefined.
   */
  accumulatedText?: string;
  /**
   * Individual text block strings in order (cloud runtime only).
   * Walked in reverse as a last-resort fallback when
   * output and accumulatedText both fail to parse.
   * Local/external/codex runtimes leave this undefined.
   */
  textBlocks?: string[];
  /**
   * SPEC-codex-windows-fix.md Camada 4: telemetria namespaced por runtime.
   * Mantido opcional pra nao poluir resultados de runtimes que nao tem o conceito.
   */
  metadata?: {
    codex?: {
      applyPatchFailures?: number;
      applyPatchFailureSamples?: Array<{ source: string; text: string; ts: number }>;
    };
  };
}

export interface RuntimeExecutor {
  run(req: AgentExecutionRequest, config: AgentQueryConfig): Promise<AgentExecutionResult>;
}

/**
 * Lancada quando o pipeline precisa pausar por uma condicao ESPERADA
 * (auth required, abort do usuario, etc) — nao um erro.
 *
 * Antes da Onda 3, o spawnAgent retornava um sentinel "vazio" (output: '',
 * metrics zeradas) quando detectava CodexAuthError, e o caller tinha que
 * confiar que o pipeline ja foi pausado em outro lugar. Isso silenciava
 * abort manual via mascaramento de retorno e gerava metricas falsas.
 *
 * Com PipelinePausedError, o caller deve detectar a excecao e curto-circuitar
 * sem registrar como erro/falha. Quem joga a excecao e responsavel por:
 *   1. Persistir status apropriado via setProjectStatus (paused/aborted)
 *   2. Emitir o IPC correspondente (pipeline:auth-required, etc)
 */
export class PipelinePausedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'codex-auth' | 'user-abort' | 'other',
  ) {
    super(message);
    this.name = 'PipelinePausedError';
  }
}
