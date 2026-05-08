/**
 * execute.ts
 *
 * Central dispatch for all agent execution runtimes.
 * Resolves the agent config, creates the watchdog, injects watchdog-wrapped
 * callbacks into the request, and dispatches to the correct executor via an
 * exhaustive switch.
 *
 * When a new runtime (e.g. 'codex') is added to AgentConfig['runtime'], TypeScript
 * will produce a compile error at the `default: never` branch, forcing the developer
 * to add the corresponding case. This is the exhaustiveness guarantee.
 *
 * Constraints:
 * - Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 */

import { createLogger } from '../logger';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { createWatchdog, WATCHDOG_TIMEOUT_MS } from './watchdog';
import { cloudExecutor } from './cloud-executor';
import { localExecutor } from './local-executor';
import { externalExecutor } from './external-executor';
import { codexExecutor } from './codex-executor';
import type { AgentExecutionRequest, AgentExecutionResult } from './types';

const logger = createLogger('execute-agent');

/**
 * Execute an agent by delegating to the correct runtime executor.
 *
 * The watchdog is created here and wraps the onText / onToolUse callbacks
 * before passing them to the executor. The caller's `onStalled` handler
 * (e.g. pipeline-engine wrapping pipeline:stalled IPC) is used as the stall
 * callback so agent-runtime stays decoupled from IPC.
 *
 * @param req - The execution request, including agentId, prompt, and callbacks.
 * @returns The execution result with output, metrics, and runtime metadata.
 */
export async function executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
  let config = await resolveAgentQueryConfig(req.agentId);

  // Apply caller-supplied systemPrompt transform (e.g. Harness injecting git guardrails
  // into custom DB coders without mutating the stored agent record).
  // The transform receives the fully-resolved systemPrompt (RULES.md + agent.systemPrompt
  // + skills) and returns the final value used by the executor.
  if (req.systemPromptTransform !== undefined) {
    config = { ...config, systemPrompt: req.systemPromptTransform(config.systemPrompt) };
  }

  const watchdog = createWatchdog(WATCHDOG_TIMEOUT_MS, (info) => {
    logger.warn(
      { agentId: req.agentId, runtime: config.runtime, ...info },
      'executeAgent: agent stalled — no progress for 3min',
    );
    req.onStalled?.(info);
  });

  // Inject watchdog wrapping into the callbacks so every progress signal resets it.
  // IMPORTANTE: todos os 4 sinais sao "prova de vida" do agente. Reasoning
  // (onThinking) e tool completion (onToolUseComplete) sao tao validos quanto
  // text/toolUse — sem wrappear esses dois, agentes que passam muito tempo
  // raciocinando ou executando tools longos sao mortos prematuramente. Ver
  // BUGFIXTESTESV1.md Bug #5.
  // NOTA: o codex-executor mapeia `onReasoning` (do bridge) -> `onThinking`
  // (canonical) pra que o reasoning do Codex tambem reset a watchdog aqui.
  const wrappedReq: AgentExecutionRequest = {
    ...req,
    onText: watchdog.wrapOnText(req.onText),
    onThinking: watchdog.wrapOnThinking(req.onThinking),
    onToolUse: watchdog.wrapOnToolUse(req.onToolUse),
    onToolUseComplete: watchdog.wrapOnToolUseComplete(req.onToolUseComplete),
    onActivity: watchdog.wrapOnActivity(req.onActivity),
  };

  try {
    switch (config.runtime) {
      case 'cloud':
        return await cloudExecutor.run(wrappedReq, config);

      case 'local':
        return await localExecutor.run(wrappedReq, config);

      case 'external':
        return await externalExecutor.run(wrappedReq, config);

      case 'codex':
        return await codexExecutor.run(wrappedReq, config);

      default: {
        // Exhaustiveness guard: if a new runtime is added to AgentConfig['runtime']
        // but not handled here, TypeScript will produce a compile error.
        const _exhaustive: never = config.runtime;
        throw new Error(`Runtime nao suportado: ${String(_exhaustive)}`);
      }
    }
  } finally {
    watchdog.stop();
  }
}
