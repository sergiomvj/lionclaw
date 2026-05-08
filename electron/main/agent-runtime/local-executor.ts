/**
 * local-executor.ts
 *
 * Runs an agent via Ollama / LM Studio / any OpenAI-compatible local HTTP endpoint.
 * Extracted from pipeline-engine.spawnAgent lines 1541-1606.
 *
 * Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 * Watchdog callbacks are already injected by execute.ts before calling run().
 */

import { createLogger } from '../logger';
import { ollamaChatWithTools } from '../ollama-client';
import type { LocalLLMProvider } from '../ollama-client';
import { calculateCost } from '../pricing';
import { getAgent } from '../db';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { builtinToolsToOllamaSchemas } from './tool-schemas';

const logger = createLogger('local-executor');

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  const agentRecord = getAgent(req.agentId);
  if (!agentRecord?.localConfig) {
    throw new Error(`Agent ${req.agentId} has runtime=local but no localConfig`);
  }

  const localCfg = agentRecord.localConfig;
  const ollamaTools = builtinToolsToOllamaSchemas(config.allowedTools);
  const startedAt = Date.now();

  logger.info(
    { agentId: req.agentId, provider: localCfg.provider, model: localCfg.model },
    'local-executor: running agent',
  );

  const ollamaResult = await ollamaChatWithTools(
    localCfg.baseUrl,
    localCfg.model,
    config.systemPrompt,
    req.prompt,
    ollamaTools,
    {
      cwd: req.cwd,
      // Callbacks are already watchdog-wrapped by execute.ts
      onText: req.onText,
      onToolUse: (record) => {
        req.onToolUse?.(record.tool);
        let parsedInput: unknown = record.input;
        if (typeof record.input === 'string') {
          try { parsedInput = JSON.parse(record.input); } catch { parsedInput = null; }
        }
        req.onToolUseComplete?.(record.tool, parsedInput);
      },
      provider: (localCfg.provider || 'ollama') as LocalLLMProvider,
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
    provider: localCfg.provider || 'ollama',
  };
}

export const localExecutor: RuntimeExecutor = { run };
