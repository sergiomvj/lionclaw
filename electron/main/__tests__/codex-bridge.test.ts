/**
 * codex-bridge.test.ts
 *
 * Unit tests for codex-bridge.ts. All child_process.spawn calls are mocked.
 * No real codex binary is spawned.
 *
 * Test coverage:
 * - happy path: send receives deltas, exec events, token_count, task_complete
 * - multi-turn: send then reply on same session uses same threadId
 * - auth error: error event with Unauthorized rejects with CodexAuthError
 * - usage limit error: error event with UsageLimitExceeded rejects with Error containing 'LIMITE'
 * - approval auto-respond: apply_patch_approval_request gets approved immediately
 * - process death: child exit before task_complete rejects with CodexUnavailableError
 * - pool: 4 concurrent sessions — 4th queues until one closes
 * - timeout: send with no events → reject with CodexUnavailableError after timeout
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ---- Mock logger before imports ----
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---- Mock db getSetting ----
vi.mock('../db', () => ({
  getSetting: vi.fn().mockReturnValue(undefined),
}));

// ---- Mock which ----
vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/local/bin/codex'),
}));

// ---- Mock fs ----
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
  existsSync: vi.fn().mockReturnValue(true),
}));

// ---- Fake child process ----

class FakeStdin {
  public written: string[] = [];
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  /** Parse all written JSON lines */
  parsedLines(): Array<Record<string, unknown>> {
    return this.written
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
}

class FakeChild extends EventEmitter {
  stdin: FakeStdin;
  stdout: EventEmitter;
  stderr: EventEmitter;

  constructor() {
    super();
    this.stdin = new FakeStdin();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(_signal?: string): boolean {
    return true;
  }

  /** Push a JSON-RPC message line to stdout */
  pushLine(msg: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
  }

  /** Simulate process exit */
  die(code: number | null = 1): void {
    this.emit('exit', code);
  }
}

// Store spawned children for test control
let spawnedChildren: FakeChild[] = [];

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, _args: string[]) => {
    const child = new FakeChild();
    spawnedChildren.push(child);
    return child;
  }),
}));

// ---- Import bridge after mocks ----
import {
  createCodexSession,
  isCodexAvailable,
  shutdownCodexBridge,
  CodexAuthError,
  CodexUnavailableError,
  _resetPoolForTesting,
} from '../codex-bridge';

// ---- Helpers ----

/** Wait until at least N children have been spawned */
async function waitForSpawn(n: number): Promise<void> {
  await vi.waitFor(() => spawnedChildren.length >= n, { timeout: 3000 });
}

/** Complete the initialize handshake for a child */
function completeHandshake(child: FakeChild): void {
  child.pushLine({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'codex-mcp-server', version: '0.1.0' },
    },
  });
}

/** Wait until the child stdin has at least one tools/call message */
async function waitForToolsCall(child: FakeChild): Promise<void> {
  await vi.waitFor(() => {
    const lines = child.stdin.parsedLines();
    return lines.some((l) => l['method'] === 'tools/call');
  }, { timeout: 3000 });
}

/** Find the requestId of the last tools/call in child stdin */
function findLastRequestId(child: FakeChild): number {
  const lines = child.stdin.parsedLines();
  const toolsCalls = lines.filter((l) => l['method'] === 'tools/call');
  if (toolsCalls.length === 0) throw new Error('No tools/call found in stdin');
  const last = toolsCalls[toolsCalls.length - 1] as { id: number };
  return last.id;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Build a codex/event notification */
function makeCodexEvent(
  requestId: number,
  threadId: string,
  msgType: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    jsonrpc: '2.0',
    method: 'codex/event',
    params: {
      _meta: { requestId, threadId },
      id: `evt_${Math.random().toString(36).slice(2)}`,
      msg: { type: msgType, thread_id: threadId, ...extra },
    },
  };
}

/**
 * Setup helper: spawn session, wait for child, complete handshake, wait for
 * the tools/call to appear in stdin.
 * Returns { session, child, reqId, threadId }.
 */
async function setupSession(
  threadId = 'thread_test',
  opts: Parameters<typeof createCodexSession>[0] = { model: 'gpt-5.5', cwd: '/tmp/test' },
) {
  const session = await createCodexSession(opts);
  const childCountBefore = spawnedChildren.length;
  const responsePromise = session.send('test prompt', {});

  // Wait for spawn
  await waitForSpawn(childCountBefore + 1);
  const child = spawnedChildren[spawnedChildren.length - 1];

  // Complete handshake so ensureSlotAlive resolves
  completeHandshake(child);

  // Wait for the tools/call to land in stdin
  await waitForToolsCall(child);

  const reqId = findLastRequestId(child);
  return { session, child, reqId, threadId, responsePromise };
}

// ---- Tests ----

describe('codex-bridge', () => {
  beforeEach(() => {
    spawnedChildren = [];
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  // ---------------------------------------------------------------------------
  // happy path
  // ---------------------------------------------------------------------------

  it('happy path: send receives deltas, exec events, token_count, task_complete', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });

    const onText = vi.fn();
    const onToolUse = vi.fn();
    const onToolUseComplete = vi.fn();

    const responsePromise = session.send('Write a hello world', { onText, onToolUse, onToolUseComplete });

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_abc123';

    // 3 text deltas
    child.pushLine(makeCodexEvent(reqId, threadId, 'agent_message_content_delta', { delta: 'Hello' }));
    child.pushLine(makeCodexEvent(reqId, threadId, 'agent_message_content_delta', { delta: ' World' }));
    child.pushLine(makeCodexEvent(reqId, threadId, 'agent_message_content_delta', { delta: '!' }));

    // exec events
    child.pushLine(makeCodexEvent(reqId, threadId, 'exec_command_begin', {
      call_id: 'cmd_1',
      command: ['echo', 'hello'],
      cwd: '/tmp',
    }));
    child.pushLine(makeCodexEvent(reqId, threadId, 'exec_command_end', {
      call_id: 'cmd_1',
      exit_code: 0,
      duration: 50,
      status: 'completed',
    }));

    // token_count — total_token_usage present; bridge must prefer it over last_token_usage
    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_output_tokens: 5,
          total_tokens: 170,
        },
        last_token_usage: {
          input_tokens: 1,
          cached_input_tokens: 1,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 3,
        },
      },
    }));

    // task_complete
    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;

    expect(response.content).toBe('Hello World!');
    expect(response.status).toBe('completed');
    expect(response.threadId).toBe(threadId);
    expect(response.commandsRun).toHaveLength(1);
    expect(response.commandsRun[0].cmd).toBe('echo hello');
    expect(response.commandsRun[0].exitCode).toBe(0);
    // Must use total_token_usage values (100/20/50/170), NOT last_token_usage (1/1/1/3)
    expect(response.usage.inputTokens).toBe(100);
    expect(response.usage.cachedInputTokens).toBe(20);
    expect(response.usage.outputTokens).toBe(50);
    expect(response.usage.totalTokens).toBe(170);

    expect(onText).toHaveBeenCalledTimes(3);
    expect(onText).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onText).toHaveBeenNthCalledWith(2, ' World');
    expect(onText).toHaveBeenNthCalledWith(3, '!');

    expect(onToolUse).toHaveBeenCalledWith('Bash');
    expect(onToolUseComplete).toHaveBeenCalledWith('Bash', expect.objectContaining({
      command: 'echo hello',
      exitCode: 0,
    }));
  });

  // ---------------------------------------------------------------------------
  // patch_apply events
  // ---------------------------------------------------------------------------

  it('patch_apply events: filesChanged populated', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Edit a file', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_patch';

    child.pushLine(makeCodexEvent(reqId, threadId, 'patch_apply_begin', {
      call_id: 'patch_1',
      auto_approved: true,
      changes: { 'src/foo.ts': { kind: 'modify' } },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'patch_apply_end', {
      call_id: 'patch_1',
      success: true,
      status: 'applied',
      changes: { 'src/foo.ts': {} },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;
    expect(response.filesChanged).toContain('src/foo.ts');
  });

  // ---------------------------------------------------------------------------
  // multi-turn
  // ---------------------------------------------------------------------------

  it('multi-turn: reply uses same threadId as send', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const firstResponsePromise = session.send('First message', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const firstReqId = findLastRequestId(child);
    const threadId = 'thread_multiturn';

    child.pushLine(makeCodexEvent(firstReqId, threadId, 'agent_message_content_delta', { delta: 'First response' }));
    child.pushLine(makeCodexEvent(firstReqId, threadId, 'task_complete', {}));

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.threadId).toBe(threadId);
    expect(session.threadId).toBe(threadId);

    // Reply
    const replyPromise = session.reply('Follow up', {});

    await vi.waitFor(() => {
      const lines = child.stdin.parsedLines();
      return lines.filter((l) => {
        const params = l['params'] as Record<string, unknown> | undefined;
        return l['method'] === 'tools/call' && params?.['name'] === 'codex-reply';
      }).length > 0;
    }, { timeout: 3000 });

    const replyLines = child.stdin.parsedLines().filter((l) => {
      const params = l['params'] as Record<string, unknown> | undefined;
      return l['method'] === 'tools/call' && params?.['name'] === 'codex-reply';
    });

    expect(replyLines).toHaveLength(1);
    const replyCall = replyLines[0] as {
      id: number;
      params: { name: string; arguments: { threadId: string; prompt: string } };
    };
    expect(replyCall.params.arguments.threadId).toBe(threadId);
    expect(replyCall.params.arguments.prompt).toBe('Follow up');

    const replyReqId = replyCall.id;
    child.pushLine(makeCodexEvent(replyReqId, threadId, 'agent_message_content_delta', { delta: 'Second response' }));
    child.pushLine(makeCodexEvent(replyReqId, threadId, 'task_complete', {}));

    const replyResponse = await replyPromise;
    expect(replyResponse.content).toBe('Second response');
    expect(replyResponse.threadId).toBe(threadId);
  });

  // ---------------------------------------------------------------------------
  // auth error
  // ---------------------------------------------------------------------------

  it('auth error: error event with Unauthorized rejects with CodexAuthError', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Do something', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_auth';

    child.pushLine(makeCodexEvent(reqId, threadId, 'error', {
      message: 'Invalid authentication credentials',
      codex_error_info: 'Unauthorized',
    }));

    await expect(responsePromise).rejects.toBeInstanceOf(CodexAuthError);
  });

  // ---------------------------------------------------------------------------
  // usage limit error
  // ---------------------------------------------------------------------------

  it('usage limit error: error event with UsageLimitExceeded rejects with Error containing limite', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Do something', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_limit';

    child.pushLine(makeCodexEvent(reqId, threadId, 'error', {
      message: 'Usage limit exceeded',
      codex_error_info: 'UsageLimitExceeded',
    }));

    // Case-insensitive: production message uses "Limite" (Portuguese capitalization).
    await expect(responsePromise).rejects.toThrow(/limite/i);
  });

  // ---------------------------------------------------------------------------
  // approval auto-respond
  // ---------------------------------------------------------------------------

  it('approval auto-respond: apply_patch_approval_request gets approved immediately', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Apply patch', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_approval';

    // Server sends approval request (JSON-RPC request with method + id)
    child.pushLine({
      jsonrpc: '2.0',
      id: 999,
      method: 'apply_patch_approval_request',
      params: { call_id: 'patch_x', changes: {} },
    });

    // Bridge must have written { id: 999, result: { decision: 'approved' } }
    await vi.waitFor(() => {
      const lines = child.stdin.parsedLines();
      return lines.some((l) => {
        const result = l['result'] as Record<string, unknown> | undefined;
        return l['id'] === 999 && result?.['decision'] === 'approved';
      });
    }, { timeout: 3000 });

    const approvalResponse = child.stdin.parsedLines().find((l) => {
      const result = l['result'] as Record<string, unknown> | undefined;
      return l['id'] === 999 && result?.['decision'] === 'approved';
    });
    expect(approvalResponse).toBeDefined();

    // Complete the request
    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));
    await responsePromise;
  });

  // ---------------------------------------------------------------------------
  // exec_approval_request auto-respond
  // ---------------------------------------------------------------------------

  it('approval auto-respond: exec_approval_request gets approved immediately', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Run a command', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_exec_approval';

    // Server sends exec approval request (JSON-RPC request with method + id)
    child.pushLine({
      jsonrpc: '2.0',
      id: 888,
      method: 'exec_approval_request',
      params: { call_id: 'exec_x', command: ['rm', '-rf', '/tmp/safe'] },
    });

    // Bridge must have written { id: 888, result: { decision: 'approved' } }
    await vi.waitFor(() => {
      const lines = child.stdin.parsedLines();
      return lines.some((l) => {
        const result = l['result'] as Record<string, unknown> | undefined;
        return l['id'] === 888 && result?.['decision'] === 'approved';
      });
    }, { timeout: 3000 });

    const approvalResponse = child.stdin.parsedLines().find((l) => {
      const result = l['result'] as Record<string, unknown> | undefined;
      return l['id'] === 888 && result?.['decision'] === 'approved';
    });
    expect(approvalResponse).toBeDefined();

    // Verify no callback was invoked (no text/tool events yet)
    const onText = vi.fn();
    // Complete the request normally
    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));
    await responsePromise;
    // onText was never registered so nothing to assert beyond no throw
    void onText;
  });

  // ---------------------------------------------------------------------------
  // process death
  // ---------------------------------------------------------------------------

  it('process death: child exit before task_complete rejects with CodexUnavailableError', async () => {
    const session = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/test' });
    const responsePromise = session.send('Something', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    // Kill the process before task_complete
    child.die(1);

    await expect(responsePromise).rejects.toBeInstanceOf(CodexUnavailableError);
  });

  // ---------------------------------------------------------------------------
  // pool: 4th session queues
  // ---------------------------------------------------------------------------

  it('pool: 4+ concurrent sessions each spawn their own process (unlimited pool model)', async () => {
    // With MAX_POOL_SIZE=100, 4 concurrent sessions spawn 4 processes — no queueing.
    // Idle processes are kept alive until pipeline completion (status='done') / abort.
    const s1 = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/1' });
    const s2 = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/2' });
    const s3 = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/3' });
    const s4 = await createCodexSession({ model: 'gpt-5.5', cwd: '/tmp/4' });

    // Trigger spawns by initiating sends. Each send awaits its slot's handshake.
    void s1.send('req1', {}).catch(() => {});
    void s2.send('req2', {}).catch(() => {});
    void s3.send('req3', {}).catch(() => {});
    void s4.send('req4', {}).catch(() => {});

    // All 4 spawn — no queueing, each on its own slot/process.
    await waitForSpawn(4);
    expect(spawnedChildren.length).toBe(4);

    // Cleanup
    s1.close();
    s2.close();
    s3.close();
    s4.close();
  });

  // ---------------------------------------------------------------------------
  // timeout
  // ---------------------------------------------------------------------------

  it('timeout: request with no events rejects with CodexUnavailableError after timeoutMs', async () => {
    const session = await createCodexSession({
      model: 'gpt-5.5',
      cwd: '/tmp/test',
      timeoutMs: 100,
    });

    const responsePromise = session.send('Timeout test', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    // Do NOT send any events — wait for the 100ms timeout
    await expect(responsePromise).rejects.toBeInstanceOf(CodexUnavailableError);

    void child;
  }, 10000);

  it('timeout: terminal_interaction does not keep a request alive', async () => {
    const session = await createCodexSession({
      model: 'gpt-5.5',
      cwd: '/tmp/test',
      timeoutMs: 140,
    });

    const responsePromise = session.send('Terminal interaction loop', {});

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    const reqId = findLastRequestId(child);
    const threadId = 'thread_terminal_loop';

    setTimeout(() => child.pushLine(makeCodexEvent(reqId, threadId, 'terminal_interaction', {})), 40);
    setTimeout(() => child.pushLine(makeCodexEvent(reqId, threadId, 'terminal_interaction', {})), 80);
    setTimeout(() => child.pushLine(makeCodexEvent(reqId, threadId, 'terminal_interaction', {})), 120);

    const outcome = await Promise.race([
      responsePromise.then(() => 'resolved').catch((err) => err instanceof CodexUnavailableError ? 'rejected' : 'other-error'),
      delay(240).then(() => 'pending'),
    ]);

    expect(outcome).toBe('rejected');
  }, 10000);

  it('abortSignal: abort rejects inflight request', async () => {
    const session = await createCodexSession({
      model: 'gpt-5.5',
      cwd: '/tmp/test',
      timeoutMs: 5000,
    });
    const controller = new AbortController();

    const responsePromise = session.send('Abort test', {}, controller.signal);

    await waitForSpawn(1);
    const child = spawnedChildren[0];
    completeHandshake(child);
    await waitForToolsCall(child);

    controller.abort();

    await expect(responsePromise).rejects.toThrow(/aborted/);
  }, 10000);

  // ---------------------------------------------------------------------------
  // isCodexAvailable
  // ---------------------------------------------------------------------------

  it('isCodexAvailable: returns installed=true when binary found and auth.json exists', async () => {
    const { spawn: spawnFn } = await import('child_process');
    const spawnMock = spawnFn as ReturnType<typeof vi.fn>;

    // Override for --version call
    spawnMock.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('codex 0.1.0\n'));
        child.emit('close', 0);
      });
      return child;
    });

    const result = await isCodexAvailable();
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
  });

  it('isCodexAvailable: returns installed=false when which throws', async () => {
    const whichModule = await import('which');
    const whichMock = whichModule.default as ReturnType<typeof vi.fn>;
    whichMock.mockRejectedValueOnce(new Error('not found'));

    const result = await isCodexAvailable();
    expect(result.installed).toBe(false);
    expect(result.version).toBeNull();
    expect(result.authenticated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // shutdownCodexBridge
  // ---------------------------------------------------------------------------

  it('shutdownCodexBridge: resolves without error even with no active processes', async () => {
    await expect(shutdownCodexBridge()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // token_count: total_token_usage preferred over last_token_usage
  // ---------------------------------------------------------------------------

  it('token_count: uses total_token_usage when both fields present', async () => {
    const { child, reqId, threadId, responsePromise } = await setupSession();

    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 80,
          output_tokens: 300,
          reasoning_output_tokens: 20,
          total_tokens: 900,
        },
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 8,
          reasoning_output_tokens: 0,
          total_tokens: 20,
        },
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;
    // total_token_usage values must win
    expect(response.usage.inputTokens).toBe(500);
    expect(response.usage.cachedInputTokens).toBe(80);
    expect(response.usage.outputTokens).toBe(300);
    expect(response.usage.reasoningOutputTokens).toBe(20);
    expect(response.usage.totalTokens).toBe(900);
  });

  // ---------------------------------------------------------------------------
  // token_count: fallback to last_token_usage when total absent
  // ---------------------------------------------------------------------------

  it('token_count: fallback to last_token_usage when total_token_usage absent', async () => {
    const { child, reqId, threadId, responsePromise } = await setupSession();

    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        last_token_usage: {
          input_tokens: 200,
          cached_input_tokens: 30,
          output_tokens: 120,
          reasoning_output_tokens: 0,
          total_tokens: 350,
        },
        // total_token_usage intentionally absent
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;
    // Must still work using last_token_usage
    expect(response.usage.inputTokens).toBe(200);
    expect(response.usage.cachedInputTokens).toBe(30);
    expect(response.usage.outputTokens).toBe(120);
    expect(response.usage.totalTokens).toBe(350);
  });

  // ---------------------------------------------------------------------------
  // token_count: multiple sequential events — last one wins (no manual sum)
  // ---------------------------------------------------------------------------

  it('token_count: multiple events — accumulator holds value from last event', async () => {
    const { child, reqId, threadId, responsePromise } = await setupSession();

    // Three sequential token_count events with growing cumulative totals
    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 0,
          total_tokens: 150,
        },
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 150,
          reasoning_output_tokens: 0,
          total_tokens: 250,
        },
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 240,
          reasoning_output_tokens: 5,
          total_tokens: 355,
        },
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;
    // Final event values are used — not a manual sum (not 100+100+100 = 300)
    expect(response.usage.outputTokens).toBe(240);
    expect(response.usage.totalTokens).toBe(355);
    expect(response.usage.reasoningOutputTokens).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // token_count: reasoning_output_tokens propagated correctly
  // ---------------------------------------------------------------------------

  it('token_count: reasoning_output_tokens propagated into accumulator', async () => {
    const { child, reqId, threadId, responsePromise } = await setupSession();

    child.pushLine(makeCodexEvent(reqId, threadId, 'token_count', {
      info: {
        total_token_usage: {
          input_tokens: 400,
          cached_input_tokens: 0,
          output_tokens: 600,
          reasoning_output_tokens: 150,
          total_tokens: 1150,
        },
      },
    }));

    child.pushLine(makeCodexEvent(reqId, threadId, 'task_complete', {}));

    const response = await responsePromise;
    expect(response.usage.reasoningOutputTokens).toBe(150);
    expect(response.usage.outputTokens).toBe(600);
    expect(response.usage.totalTokens).toBe(1150);
  });
});
