/**
 * Watchdog — detects agents that stall (no output progress for WATCHDOG_TIMEOUT_MS)
 * and notifies the caller via onStalled.
 *
 * Extracted from pipeline-engine.spawnAgent (was inline at lines 1506-1538).
 * The pipeline-engine's `pipeline:stalled` IPC emission stays in pipeline-engine;
 * it wraps onStalled from the AgentExecutionRequest.
 */

export const WATCHDOG_TIMEOUT_MS = 180_000; // 3 minutes

export interface WatchdogHandle {
  reset(): void;
  stop(): void;
  /** Wraps an onText callback so every text chunk resets the watchdog. */
  wrapOnText(cb?: (chunk: string) => void): (chunk: string) => void;
  /**
   * Wraps an onThinking callback so every reasoning chunk resets the watchdog.
   * Critical for agents that spend long spans in reasoning before emitting text
   * or tool calls (e.g. Codex spec-builder, Cloud planner with extended thinking).
   * NOTA: todos os executors devem rotear reasoning/thinking via `req.onThinking`
   * pra que esse wrapper seja efetivo (Codex faz mapping de `onReasoning` -> `onThinking`
   * em codex-executor.ts).
   */
  wrapOnThinking(cb?: (chunk: string) => void): (chunk: string) => void;
  /** Wraps an onToolUse callback so every tool use resets the watchdog. */
  wrapOnToolUse(cb?: (toolName: string) => void): (toolName: string) => void;
  /** Wraps an onToolUseComplete callback so every tool completion resets the watchdog. */
  wrapOnToolUseComplete(cb?: (tool: string, input: unknown) => void): (tool: string, input: unknown) => void;
  /**
   * Wraps an onActivity callback so any "agent is alive" signal resets the watchdog.
   * Usado especialmente pelo codex-bridge: alguns eventos do Codex CLI (ex: plan_update)
   * nao se traduzem em text/thinking/tool callbacks, mas SAO prova de vida do agente.
   * Ver BUGFIXTESTESV1.md Bug #7.
   */
  wrapOnActivity(cb?: () => void): () => void;
}

/**
 * Create a watchdog timer that fires `onStalled` if `reset()` is not called
 * within `timeoutMs` milliseconds.
 *
 * The caller must call `stop()` in a `finally` block to clean up the timer.
 */
export function createWatchdog(
  timeoutMs: number,
  onStalled: (info: { lastChunkAt: number; secondsSinceLastChunk: number }) => void,
): WatchdogHandle {
  let lastChunkAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      const secondsSinceLastChunk = Math.round((Date.now() - lastChunkAt) / 1000);
      onStalled({ lastChunkAt, secondsSinceLastChunk });
    }, timeoutMs);
  };

  const reset = (): void => {
    lastChunkAt = Date.now();
    scheduleTimer();
  };

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const wrapOnText = (cb?: (chunk: string) => void) =>
    (chunk: string): void => {
      reset();
      cb?.(chunk);
    };

  const wrapOnThinking = (cb?: (chunk: string) => void) =>
    (chunk: string): void => {
      reset();
      cb?.(chunk);
    };

  const wrapOnToolUse = (cb?: (toolName: string) => void) =>
    (toolName: string): void => {
      reset();
      cb?.(toolName);
    };

  const wrapOnToolUseComplete = (cb?: (tool: string, input: unknown) => void) =>
    (tool: string, input: unknown): void => {
      reset();
      cb?.(tool, input);
    };

  const wrapOnActivity = (cb?: () => void) =>
    (): void => {
      reset();
      cb?.();
    };

  scheduleTimer();

  return { reset, stop, wrapOnText, wrapOnThinking, wrapOnToolUse, wrapOnToolUseComplete, wrapOnActivity };
}
