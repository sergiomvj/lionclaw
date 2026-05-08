/**
 * cloud-executor.ts
 *
 * Runs an agent via the @anthropic-ai/claude-agent-sdk (cloud/Anthropic path).
 * Extracted from pipeline-engine.spawnAgent lines 1707-1815.
 *
 * Constraints:
 * - Dynamic import of the SDK stays here (never at module top-level) to match
 *   the original pattern and avoid circular resolution issues.
 * - Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 * - Watchdog callbacks are already injected by execute.ts before calling run().
 */

import fs from 'fs';
import { createLogger } from '../logger';
import { processAgentStream } from '../stream-processor';
import { calculateCost } from '../pricing';
import {
  getClaudeCodeExecutablePath,
  ensureNodeInPath,
  ensureAuthForSDK,
} from '../pipeline-shared/sdk-bootstrap';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';

const logger = createLogger('cloud-executor');

/**
 * Pure builder for the Claude Agent SDK `query()` options object.
 *
 * Extracted so the option assembly — including the new permission-profile
 * wiring (S1.0.2) — can be unit-tested without spawning a real SDK process,
 * mocking the file system, or driving an async stream.
 *
 * Permission-profile semantics (D11 in SPEC-refactor-pipelines.md):
 *  - `permissionMode` and `allowDangerouslySkipPermissions` are taken from
 *    `req.permission` instead of being hardcoded to bypass.
 *  - `canUseTool` is included only when the profile supplies a guard, so
 *    bypass-no-guard profiles do not pin an undefined callback into opts.
 */
export function buildClaudeQueryOptions(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
  cliPath: string,
  childAbort: AbortController,
): Record<string, unknown> {
  const mcpServersObj = config.mcpServers.length > 0
    ? Object.fromEntries(config.mcpServers.flatMap((s) => Object.entries(s)))
    : undefined;

  return {
    pathToClaudeCodeExecutable: cliPath,
    cwd: req.cwd,
    model: config.model,
    systemPrompt: config.systemPrompt || '',
    allowedTools: config.allowedTools,
    permissionMode: req.permission.mode,
    allowDangerouslySkipPermissions: req.permission.dangerouslySkipPermissions,
    ...(req.permission.canUseTool ? { canUseTool: req.permission.canUseTool } : {}),
    includePartialMessages: true,
    abortController: childAbort,
    ...(req.continueSession ? { continue: true as const } : {}),
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
      logger.info({ agentId: req.agentId, stderr: text.substring(0, 500) }, 'Agent stderr');
    },
  };
}

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  // Defensive bootstrap: harness-engine usually does this before calling
  // executeAgent, but cloud-executor is self-contained for callers that
  // don't (workflow-engine, future direct callers, tests). Both helpers
  // are idempotent via internal guards.
  ensureNodeInPath();
  await ensureAuthForSDK();

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cliPath = getClaudeCodeExecutablePath();

  if (!fs.existsSync(cliPath)) {
    throw new Error(`Claude Agent SDK cli.js not found at ${cliPath}. Run npm install.`);
  }

  const startedAt = Date.now();

  // Per-session child AbortController — isolates each session so a sibling
  // completion/abort does not cancel this session (same pattern as original spawnAgent).
  const childAbort = new AbortController();
  const onParentAbort = (): void => {
    if (!childAbort.signal.aborted) childAbort.abort();
  };
  if (req.abortController.signal.aborted) {
    childAbort.abort();
  } else {
    req.abortController.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const cleanupParentListener = (): void => {
    req.abortController.signal.removeEventListener('abort', onParentAbort);
  };

  const q = (query as (opts: Record<string, unknown>) => unknown)({
    prompt: req.prompt,
    options: buildClaudeQueryOptions(req, config, cliPath, childAbort),
  }) as AsyncIterable<Record<string, unknown>>;

  let output: string;
  let streamMetrics: Awaited<ReturnType<typeof processAgentStream>>['metrics'];
  let accumulatedText: string;
  let textBlocks: string[];

  try {
    const result = await processAgentStream(q, {
      shouldAbort: () => childAbort.signal.aborted,
      // Callbacks are already watchdog-wrapped by execute.ts
      onText: req.onText,
      onThinking: req.onThinking,
      onToolUse: req.onToolUse,
      onToolUseComplete: req.onToolUseComplete,
    });
    output = result.output;
    streamMetrics = result.metrics;
    accumulatedText = result.accumulatedText;
    textBlocks = result.textBlocks;
  } finally {
    cleanupParentListener();
  }

  const durationMs = Date.now() - startedAt;
  const costUsd = calculateCost(
    config.model,
    streamMetrics.inputTokens,
    streamMetrics.outputTokens,
    streamMetrics.cacheReadTokens,
    streamMetrics.cacheCreationTokens,
  );

  return {
    output,
    metrics: {
      inputTokens: streamMetrics.inputTokens,
      outputTokens: streamMetrics.outputTokens,
      cacheReadTokens: streamMetrics.cacheReadTokens,
      cacheCreationTokens: streamMetrics.cacheCreationTokens,
      toolUses: streamMetrics.toolUses,
      apiRequests: streamMetrics.apiRequests,
      costUsd,
      durationMs,
    },
    model: config.model,
    runtime: 'cloud',
    provider: 'anthropic',
    accumulatedText,
    textBlocks,
  };
}

export const cloudExecutor: RuntimeExecutor = { run };
