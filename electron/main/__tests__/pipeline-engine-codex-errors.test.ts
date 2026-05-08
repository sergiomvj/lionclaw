/**
 * pipeline-engine-codex-errors.test.ts
 *
 * Unit tests for Sprint 9 additions to PipelineEngine.spawnAgent:
 * 1. CodexAuthError pauses pipeline, emits pipeline:auth-required, returns sentinel result.
 * 2. CodexUnavailableError emits pipeline:error AND rethrows.
 * 3. Non-codex errors propagate unchanged (no regression).
 * 4. codexSessions map is populated via onCodexSessionCreated callback.
 * 5. closeCodexSessions clears the map and calls close() on each session.
 *
 * All heavy deps (executeAgent, DB, BrowserWindow) are mocked.
 * No real codex process is spawned.
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

// ---- Captured IPC events (shared across tests) ----
const capturedEvents: Array<{ channel: string; data: unknown }> = [];

// ---- Mock BrowserWindow ----
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{
      isDestroyed: () => false,
      webContents: { send: (channel: string, data: unknown) => capturedEvents.push({ channel, data }) },
    }]),
  },
  app: { on: vi.fn() },
}));

// ---- Mock fs / path / os ----
vi.mock('fs', () => ({ default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('') }));
vi.mock('path', () => ({ default: { join: (...args: string[]) => args.join('/') }, join: (...args: string[]) => args.join('/') }));
vi.mock('os', () => ({ default: { homedir: () => '/home/user' }, homedir: () => '/home/user' }));

// ---- Mock db ----
vi.mock('../db', () => ({
  getHarnessProject: vi.fn(),
  getAgent: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(), get: vi.fn() })) })),
  savePipelinePhaseMetrics: vi.fn(),
  savePipelineMessage: vi.fn(),
  getPipelinePhaseMessages: vi.fn().mockReturnValue([]),
  getPipelinePhaseMessagesAsChatHistory: vi.fn().mockReturnValue([]),
  getPipelineMetrics: vi.fn().mockReturnValue({ phases: [] }),
  getHarnessSprints: vi.fn().mockReturnValue([]),
  updateHarnessProject: vi.fn(),
  updateHarnessSprint: vi.fn(),
  // S3 (Onda 3): persist.ts eagerly reads insertHarnessRound/updateHarnessRound
  // when the module is imported. Both must be in the mock or pipeline-engine
  // import fails before any test runs.
  insertHarnessRound: vi.fn(),
  updateHarnessRound: vi.fn(),
  deletePipelineMessagesFromPhase: vi.fn(),
  deletePipelinePhaseMetricsFromPhase: vi.fn(),
  deletePipelineMessagesForSprint: vi.fn(),
  deletePipelinePhaseMetricsForSprint: vi.fn(),
  deleteHarnessRoundsForSprint: vi.fn(),
  resetHarnessSprintStatus: vi.fn(),
  deleteHarnessSprintsForProject: vi.fn(),
  getHarnessSprintByIndex: vi.fn(),
  patchSecuritySummaryJson: vi.fn(),
  getSecuritySummaryJson: vi.fn(),
  getSecurityAgentStatuses: vi.fn().mockReturnValue([]),
}));

// ---- Mock agent-runtime executeAgent ----
vi.mock('../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));

// ---- Mock codex-bridge ----
vi.mock('../codex-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-bridge')>();
  return {
    ...actual,
    shutdownCodexBridge: vi.fn().mockResolvedValue(undefined),
  };
});

// ---- Mock heavy deps to prevent import side effects ----
vi.mock('../harness-engine', () => {
  const HarnessEngine = vi.fn();
  HarnessEngine.prototype.abort = vi.fn();
  HarnessEngine.prototype.runSingleSprint = vi.fn();
  return { HarnessEngine };
});
vi.mock('../security-audit-runner', () => ({ SecurityAuditRunner: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../repo-profiler', () => ({ runRepoProfiler: vi.fn() }));
vi.mock('../security-findings-parser', () => ({ parseSecurityFindings: vi.fn() }));
vi.mock('../pipeline-paths', () => ({
  generatePipelineDocsId: vi.fn(() => 'docs-id'),
  getPipelineDocsContext: vi.fn(() => null),
  migrateLegacyDocsToFolder: vi.fn(),
  findConsolidatedSecurityReport: vi.fn(),
}));
vi.mock('../pipeline-report', () => ({ generatePipelineReport: vi.fn(), exportPipelineReport: vi.fn() }));
vi.mock('../pipeline-metrics-report', () => ({}));

// ---- Imports after mocks ----
import { PipelineEngine } from '../pipeline-engine';
import { executeAgent } from '../agent-runtime';
import { CodexAuthError, CodexUnavailableError } from '../codex-bridge';
import { HarnessEngine } from '../harness-engine';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { CodexSession } from '../codex-bridge';

// ---- Helpers ----

function makeEngine() {
  // HarnessEngine is mocked as a class with prototype methods
  const harnessInstance = new HarnessEngine({} as never, {} as never);
  return new PipelineEngine(() => null, harnessInstance as never);
}

function makeSuccessResult(): AgentExecutionResult {
  return {
    output: 'done',
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      toolUses: 2,
      apiRequests: 1,
      costUsd: 0.001,
      durationMs: 500,
    },
    model: 'gpt-5.5',
    runtime: 'codex',
    provider: 'openai-codex',
  };
}

function makeSpawnOpts(projectId = 'proj-test') {
  return {
    projectId,
    phaseNumber: 2,
    cwd: '/tmp/project',
    abortController: new AbortController(),
  };
}

// ---- Tests ----

describe('PipelineEngine.spawnAgent — Codex error handling (Sprint 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEvents.length = 0;
  });

  it('1. CodexAuthError: pipeline is paused, pipeline:auth-required emitted, PipelinePausedError thrown', async () => {
    // S3 (Onda 3): the old "sentinel result" contract was replaced by an
    // explicit PipelinePausedError throw. Callers detect the exception and
    // short-circuit cleanly instead of pretending the agent succeeded.
    const { PipelinePausedError } = await import('../agent-runtime/types');

    const authErr = new CodexAuthError('Codex OAuth expirado. Rode `codex login`.');
    (executeAgent as Mock).mockRejectedValue(authErr);

    // Provide a stub project so setProjectStatus does not crash
    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 2,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    // MUST throw PipelinePausedError (no sentinel return anymore)
    let caught: unknown;
    try {
      await engine.spawnAgent('my-codex-agent', 'do stuff', opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelinePausedError);
    expect((caught as InstanceType<typeof PipelinePausedError>).reason).toBe('codex-auth');

    // pipeline:auth-required emitted before the throw
    const authEvent = capturedEvents.find((e) => e.channel === 'pipeline:auth-required');
    expect(authEvent).toBeDefined();
    expect((authEvent!.data as { projectId: string }).projectId).toBe('proj-test');
    expect((authEvent!.data as { phaseNumber: number }).phaseNumber).toBe(2);
    expect((authEvent!.data as { message: string }).message).toContain('expirado');

    // pipeline:project-updated emitted with patch.status='paused' (via setProjectStatus)
    const updateEvent = capturedEvents.find((e) => e.channel === 'pipeline:project-updated');
    expect(updateEvent).toBeDefined();
    expect((updateEvent!.data as { patch: { status: string } }).patch.status).toBe('paused');
  });

  it('2. CodexUnavailableError: pipeline:error emitted with title CODEX FALHOU, error rethrown', async () => {
    const unavailErr = new CodexUnavailableError('codex binary not found.');
    (executeAgent as Mock).mockRejectedValue(unavailErr);

    const { getHarnessProject } = await import('../db');
    (getHarnessProject as Mock).mockReturnValue({
      id: 'proj-test',
      status: 'running',
      pipelineCurrentPhase: 3,
      pipelineType: 'dev',
    });

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    // MUST throw
    await expect(
      engine.spawnAgent('my-codex-agent', 'do stuff', opts),
    ).rejects.toThrow(CodexUnavailableError);

    // pipeline:error emitted with title
    const errorEvent = capturedEvents.find((e) => e.channel === 'pipeline:error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { title: string }).title).toBe('CODEX FALHOU');
    expect((errorEvent!.data as { detail: string }).detail).toContain('not found');
  });

  it('3. Non-codex errors propagate without special handling', async () => {
    const genericErr = new Error('Some generic error');
    (executeAgent as Mock).mockRejectedValue(genericErr);

    const engine = makeEngine();
    const opts = makeSpawnOpts();

    await expect(
      engine.spawnAgent('my-cloud-agent', 'do stuff', opts),
    ).rejects.toThrow('Some generic error');

    // No auth-required emitted
    expect(capturedEvents.find((e) => e.channel === 'pipeline:auth-required')).toBeUndefined();
  });

  it('4. codexSessions map is populated when onCodexSessionCreated is invoked', async () => {
    let createdSession: CodexSession | undefined;

    (executeAgent as Mock).mockImplementation(async (req) => {
      // Simulate executor calling the callback with a new session
      if (req.onCodexSessionCreated) {
        const fakeSession: CodexSession = { threadId: 'thread-new', send: vi.fn(), reply: vi.fn(), close: vi.fn() };
        req.onCodexSessionCreated(fakeSession);
        createdSession = fakeSession;
      }
      return makeSuccessResult();
    });

    const engine = makeEngine();
    // Pre-warm the state so states.get() in spawnAgent finds the entry
    const getStateInternal = (engine as unknown as { getState: (id: string) => { codexSessions: Map<string, CodexSession> } }).getState.bind(engine);
    const state = getStateInternal('proj-test');

    const opts = makeSpawnOpts();
    await engine.spawnAgent('my-codex-agent', 'first turn', opts);

    // The session must be stored in the state map
    expect(state).toBeDefined();
    expect(state.codexSessions.size).toBe(1);
    expect(createdSession).toBeDefined();
    expect(state.codexSessions.get('my-codex-agent:2')).toBe(createdSession);
  });

  it('5. closeCodexSessions closes all sessions and clears the map', async () => {
    const session1: CodexSession = { threadId: 'th1', send: vi.fn(), reply: vi.fn(), close: vi.fn() };
    const session2: CodexSession = { threadId: 'th2', send: vi.fn(), reply: vi.fn(), close: vi.fn() };

    const engine = makeEngine();
    // Pre-warm state and seed sessions
    const getStateInternal = (engine as unknown as { getState: (id: string) => { codexSessions: Map<string, CodexSession> } }).getState.bind(engine);
    const state = getStateInternal('proj-test');
    state.codexSessions.set('agent-a:3', session1);
    state.codexSessions.set('agent-b:3', session2);

    // Call private method via cast
    (engine as unknown as { closeCodexSessions: (s: typeof state) => void }).closeCodexSessions(state);

    expect(session1.close).toHaveBeenCalledOnce();
    expect(session2.close).toHaveBeenCalledOnce();
    expect(state.codexSessions.size).toBe(0);
  });
});
