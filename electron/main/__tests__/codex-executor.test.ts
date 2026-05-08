/**
 * codex-executor.test.ts
 *
 * Unit tests for agent-runtime/codex-executor.ts.
 * All external dependencies (codex-bridge, db, pricing) are mocked.
 * No real codex process is spawned.
 *
 * Test coverage:
 * 1. Happy path — result shape, metrics, model, runtime, provider; session.close() called
 * 2. Missing codexConfig — throws descriptive error
 * 3. Auth error propagation — CodexAuthError bubbles without wrapping
 * 4. Bridge unavailable — CodexUnavailableError propagates from createCodexSession
 * 5. Callbacks pass-through — onText, onToolUse, onToolUseComplete forwarded to session.send
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ---- Mock logger ----
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---- Mock pricing ----
vi.mock('../pricing', () => ({
  calculateCost: vi.fn().mockReturnValue(0.0015),
}));

// ---- Mock db ----
vi.mock('../db', () => ({
  getAgent: vi.fn(),
}));

// ---- Mock codex-bridge ----
vi.mock('../codex-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-bridge')>();
  return {
    ...actual,
    createCodexSession: vi.fn(),
  };
});

// ---- Imports after mocks ----
import { codexExecutor } from '../agent-runtime/codex-executor';
import { CodexAuthError, CodexUnavailableError, createCodexSession } from '../codex-bridge';
import { getAgent } from '../db';
import { calculateCost } from '../pricing';
import { PERM_BYPASS_NO_GUARD } from '../agent-runtime/permission-profiles';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';

// ---- Helpers ----

function makeReq(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    agentId: 'test-codex-agent',
    prompt: 'Implement the feature',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission: PERM_BYPASS_NO_GUARD,
    onText: vi.fn(),
    onToolUse: vi.fn(),
    onToolUseComplete: vi.fn(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    systemPrompt: 'You are a helpful coding agent.',
    runtime: 'codex',
    effort: 'high',
    thinking: 'disabled',
    allowedTools: [],
    mcpServers: [],
    ...overrides,
  } as AgentQueryConfig;
}

function makeSyntheticResponse() {
  return {
    threadId: 'thread-abc-123',
    content: 'Feature implemented successfully.',
    filesChanged: ['src/feature.ts', 'src/feature.test.ts'],
    commandsRun: [{ cmd: 'npm test', exitCode: 0, durationMs: 1200 }],
    usage: {
      inputTokens: 500,
      cachedInputTokens: 100,
      outputTokens: 300,
      reasoningOutputTokens: 0,
      totalTokens: 800,
    },
    status: 'completed' as const,
  };
}

function makeSession(response: ReturnType<typeof makeSyntheticResponse>) {
  return {
    threadId: null as string | null,
    send: vi.fn().mockResolvedValue(response),
    reply: vi.fn(),
    close: vi.fn(),
  };
}

// ---- Tests ----

describe('codex-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Happy path: returns correct AgentExecutionResult', async () => {
    const response = makeSyntheticResponse();
    const session = makeSession(response);

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: {
        model: 'gpt-5.5',
        sandbox: 'workspace-write',
        reasoningEffort: 'high',
      },
    });
    (createCodexSession as Mock).mockResolvedValue(session);
    (calculateCost as Mock).mockReturnValue(0.0042);

    const result = await codexExecutor.run(makeReq(), makeConfig());

    // Identity checks
    expect(result.runtime).toBe('codex');
    expect(result.provider).toBe('openai-codex');
    expect(result.model).toBe('gpt-5.5');

    // Output
    expect(result.output).toBe('Feature implemented successfully.');

    // Metrics
    expect(result.metrics.inputTokens).toBe(500);
    expect(result.metrics.outputTokens).toBe(300);
    expect(result.metrics.cacheReadTokens).toBe(100);
    expect(result.metrics.cacheCreationTokens).toBe(0);
    // toolUses = commandsRun.length (1) + filesChanged.length (2) = 3
    expect(result.metrics.toolUses).toBe(3);
    expect(result.metrics.apiRequests).toBe(1);
    expect(result.metrics.costUsd).toBeGreaterThan(0);
    expect(result.metrics.costUsd).toBe(0.0042);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);

    // session.close() must always be called (finally block)
    expect(session.close).toHaveBeenCalledOnce();
    expect(createCodexSession).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Regras de terminal Codex'),
    }));
  });

  it('2. Missing codexConfig: throws descriptive error', async () => {
    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      // no codexConfig field
    });

    await expect(
      codexExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(/codexConfig/);
  });

  it('3. Auth error propagation: CodexAuthError bubbles unwrapped', async () => {
    const authErr = new CodexAuthError('Codex auth required: Unauthorized');
    const session = {
      threadId: null,
      send: vi.fn().mockRejectedValue(authErr),
      reply: vi.fn(),
      close: vi.fn(),
    };

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (createCodexSession as Mock).mockResolvedValue(session);

    await expect(
      codexExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(CodexAuthError);

    // session.close() must still be called (finally block)
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('4. Bridge unavailable: CodexUnavailableError propagates from createCodexSession', async () => {
    const unavailableErr = new CodexUnavailableError('codex binary not found. Install codex CLI first.');

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (createCodexSession as Mock).mockRejectedValue(unavailableErr);

    await expect(
      codexExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(CodexUnavailableError);

    await expect(
      codexExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow('codex binary not found');
  });

  it('5. Callbacks pass-through: onText, onToolUse, onToolUseComplete forwarded to session.send', async () => {
    const response = makeSyntheticResponse();
    const session = makeSession(response);

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (createCodexSession as Mock).mockResolvedValue(session);

    const onText = vi.fn();
    const onToolUse = vi.fn();
    const onToolUseComplete = vi.fn();

    const req = makeReq({ onText, onToolUse, onToolUseComplete });
    await codexExecutor.run(req, makeConfig());

    // session.send must have been called with the exact callback references
    expect(session.send).toHaveBeenCalledOnce();
    const [, callbacks, abortSignal] = (session.send as Mock).mock.calls[0] as [
      string,
      { onText: unknown; onToolUse: unknown; onToolUseComplete: unknown },
      AbortSignal,
    ];

    expect(callbacks.onText).toBe(onText);
    expect(callbacks.onToolUse).toBe(onToolUse);
    expect(callbacks.onToolUseComplete).toBe(onToolUseComplete);
    expect(abortSignal).toBe(req.abortController.signal);
  });

  // ---- Sprint 9: session reuse tests ----

  it('6. Session reuse: when req.codexSession provided, calls reply() not send(), does NOT close session', async () => {
    const response = makeSyntheticResponse();
    const existingSession = {
      threadId: 'existing-thread-id',
      send: vi.fn(),
      reply: vi.fn().mockResolvedValue(response),
      close: vi.fn(),
    };

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (calculateCost as Mock).mockReturnValue(0.001);

    // Pass codexSession directly — no createCodexSession should be called
    const req = makeReq({ codexSession: existingSession });
    const result = await codexExecutor.run(req, makeConfig());

    // reply() used, not send()
    expect(existingSession.reply).toHaveBeenCalledOnce();
    expect(existingSession.reply).toHaveBeenCalledWith(
      req.prompt,
      expect.objectContaining({
        onText: req.onText,
        onToolUse: req.onToolUse,
        onToolUseComplete: req.onToolUseComplete,
      }),
      req.abortController.signal,
    );
    expect(existingSession.send).not.toHaveBeenCalled();

    // createCodexSession must NOT be called when a session is provided
    expect(createCodexSession).not.toHaveBeenCalled();

    // session.close() must NOT be called — caller owns lifecycle
    expect(existingSession.close).not.toHaveBeenCalled();

    // Result should still be well-formed
    expect(result.runtime).toBe('codex');
    expect(result.output).toBe('Feature implemented successfully.');
  });

  it('7. Session creation callback: onCodexSessionCreated called with new session; close() NOT called', async () => {
    const response = makeSyntheticResponse();
    const session = makeSession(response);

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (createCodexSession as Mock).mockResolvedValue(session);
    (calculateCost as Mock).mockReturnValue(0.001);

    const onCodexSessionCreated = vi.fn();
    const req = makeReq({ onCodexSessionCreated });
    await codexExecutor.run(req, makeConfig());

    // Callback must be called with the created session
    expect(onCodexSessionCreated).toHaveBeenCalledOnce();
    expect(onCodexSessionCreated).toHaveBeenCalledWith(session);

    // send() (not reply()) since no prior session was passed
    expect(session.send).toHaveBeenCalledOnce();

    // close() must NOT be called — caller claimed ownership via the callback
    expect(session.close).not.toHaveBeenCalled();
  });

  it('8. No callback and no prior session: shouldClose=true, session.close() called after success', async () => {
    const response = makeSyntheticResponse();
    const session = makeSession(response);

    (getAgent as Mock).mockReturnValue({
      id: 'test-codex-agent',
      runtime: 'codex',
      codexConfig: { model: 'gpt-5.5' },
    });
    (createCodexSession as Mock).mockResolvedValue(session);
    (calculateCost as Mock).mockReturnValue(0.001);

    // No codexSession, no onCodexSessionCreated — standalone mode
    await codexExecutor.run(makeReq(), makeConfig());

    // session.close() must be called (executor owns the lifecycle in standalone mode)
    expect(session.close).toHaveBeenCalledOnce();
  });
});
