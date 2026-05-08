/**
 * external-executor.ts
 *
 * Runs an agent via an external OpenAI-compatible HTTP API
 * (OpenRouter, OpenAI direct, or any compatible endpoint).
 * Extracted from pipeline-engine.spawnAgent lines 1609-1705.
 *
 * Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 * Watchdog callbacks are already injected by execute.ts before calling run().
 */

import { createLogger } from '../logger';
import {
  resolveExternalAuth,
  ollamaChatWithRetry,
  computePricingKey,
  mapReasoningParams,
  isContextLengthError,
} from './external-http';
import { calculateCost } from '../pricing';
import { getAgent } from '../db';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { builtinToolsToOllamaSchemas } from './tool-schemas';

const logger = createLogger('external-executor');

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  const agentRecord = getAgent(req.agentId);
  if (!agentRecord?.externalConfig) {
    throw new Error(`Agent ${req.agentId} has runtime=external but no externalConfig`);
  }

  const extCfg = agentRecord.externalConfig;
  const authHeaders = await resolveExternalAuth(extCfg);
  const reasoningParams = mapReasoningParams(
    config.effort,
    config.thinking,
    config.thinkingBudget,
    extCfg.provider,
    extCfg.model,
  );
  const ollamaTools = builtinToolsToOllamaSchemas(config.allowedTools);
  const startedAt = Date.now();

  logger.info(
    { agentId: req.agentId, provider: extCfg.provider, model: extCfg.model },
    'external-executor: running agent',
  );

  let extResult: Awaited<ReturnType<typeof ollamaChatWithRetry>>;
  try {
    extResult = await ollamaChatWithRetry(
      extCfg.baseUrl,
      extCfg.model,
      config.systemPrompt,
      req.prompt,
      ollamaTools,
      {
        cwd: req.cwd,
        // Callbacks are already watchdog-wrapped by execute.ts
        onText: req.onText,
        onTextDelta: req.onText,
        onToolUse: (record) => {
          req.onToolUse?.(record.tool);
          let parsedInput: unknown = record.input;
          if (typeof record.input === 'string') {
            try { parsedInput = JSON.parse(record.input); } catch { parsedInput = null; }
          }
          req.onToolUseComplete?.(record.tool, parsedInput);
        },
        provider: extCfg.provider,
        authHeaders,
        maxTokens: extCfg.maxTokens,
        streaming: true,
        extraBodyParams: reasoningParams,
        maxRounds: agentRecord.maxToolRounds ?? 50,
        priorMessages: req.priorMessages,
      },
    );
  } catch (err) {
    const errMsg = (err as Error).message || '';
    if (isContextLengthError(errMsg)) {
      throw new Error(
        `Contexto excedido para modelo ${extCfg.model}. Considere usar um modelo com janela maior.`,
      );
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  const pricingKey = computePricingKey(extCfg);

  let costUsd: number;
  const reportedCostUsd = extResult.reportedCostUsd;
  if (reportedCostUsd !== undefined && reportedCostUsd > 0) {
    costUsd = reportedCostUsd;
  } else {
    costUsd = calculateCost(
      pricingKey,
      extResult.promptTokens,
      extResult.tokensUsed,
      extResult.cacheHitTokens ?? 0,
      0,
    );
  }

  return {
    output: extResult.content,
    metrics: {
      inputTokens: extResult.promptTokens,
      outputTokens: extResult.tokensUsed,
      cacheReadTokens: extResult.cacheHitTokens ?? 0,
      cacheCreationTokens: 0,
      toolUses: extResult.toolCalls.length,
      apiRequests: extResult.apiRequests,
      costUsd,
      durationMs,
    },
    model: extCfg.model,
    runtime: 'external',
    provider: extCfg.provider ?? 'unknown',
    toolCalls: extResult.toolCalls,
  };
}

export const externalExecutor: RuntimeExecutor = { run };
