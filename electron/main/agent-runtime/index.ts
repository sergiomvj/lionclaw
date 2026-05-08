/**
 * agent-runtime/index.ts — barrel export
 *
 * Public API of the agent-runtime module.
 * All pipeline consumers (pipeline-engine, harness-engine, security-audit-runner)
 * import exclusively from here.
 */

export { executeAgent } from './execute';
export type { AgentExecutionRequest, AgentExecutionResult, RuntimeExecutor } from './types';
export { WATCHDOG_TIMEOUT_MS } from './watchdog';
export { codexExecutor } from './codex-executor';
