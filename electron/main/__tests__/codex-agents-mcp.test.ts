/**
 * codex-agents-mcp.test.ts
 *
 * Unit tests for codex-agents-mcp.ts (run_codex_agent + codex_agents_health tools)
 * and codex-agent-tools.ts (getCodexAgentsDescription).
 *
 * All external dependencies are mocked. No real codex process is spawned.
 *
 * Tests:
 * 1. run_codex_agent happy path
 * 2. run_codex_agent agent not found
 * 3. run_codex_agent wrong runtime
 * 4. run_codex_agent executeAgent throws
 * 5. codex_agents_health
 * 6. getCodexAgentsDescription — empty (no codex agents)
 * 7. getCodexAgentsDescription — populated (2 codex agents)
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

// ---- Mock db ----
vi.mock('../db', () => ({
  getAgent: vi.fn(),
  getAllAgents: vi.fn(),
}));

// ---- Mock agent-runtime ----
vi.mock('../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));

// ---- Mock codex-bridge ----
vi.mock('../codex-bridge', () => ({
  isCodexAvailable: vi.fn(),
}));

// ---- Mock @anthropic-ai/claude-agent-sdk ----
// We mock createSdkMcpServer and tool so the module can be imported without
// the real SDK. The tool handler is extracted from the call arguments and
// invoked directly in each test.
const capturedTools: Array<{
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string; version?: string; tools?: unknown[] }) => {
    // Return a minimal fake McpSdkServerConfigWithInstance shape
    return { type: 'sdk', name: opts.name, instance: {} };
  },
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    capturedTools.push({ name, handler });
    return { name, handler };
  },
}));

// ---- Imports after mocks ----
import { getAgent, getAllAgents } from '../db';
import { executeAgent } from '../agent-runtime';
import { isCodexAvailable } from '../codex-bridge';

// Import the module under test. The server is built lazily via
// getCodexAgentsServer() — calling it triggers the mocked createSdkMcpServer
// and populates capturedTools.
import { getCodexAgentsServer } from '../codex-agents-mcp';
import { getCodexAgentsDescription } from '../codex-agent-tools';

// Build the server once (cached internally) so capturedTools is populated for
// all tests below.
await getCodexAgentsServer();

// ---- Helper: find a tool handler by name ----
function getToolHandler(toolName: string) {
  const entry = capturedTools.find((t) => t.name === toolName);
  if (!entry) throw new Error(`Tool "${toolName}" not captured — check mock setup`);
  return entry.handler;
}

// ---- Synthetic data ----

function makeSyntheticResult() {
  return {
    output: 'Feature implemented successfully.',
    model: 'gpt-5.5',
    runtime: 'codex' as const,
    provider: 'openai-codex',
    metrics: {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
      toolUses: 3,
      apiRequests: 1,
      costUsd: 0.0042,
      durationMs: 1500,
    },
  };
}

function makeCodexAgent(id = 'coder-codex') {
  return {
    id,
    name: 'Codex Coder',
    description: 'Agente coder usando OpenAI Codex',
    runtime: 'codex' as const,
    isActive: true,
    codexConfig: { model: 'gpt-5.5', sandbox: 'workspace-write', reasoningEffort: 'high' },
  };
}

// ---- Tests ----

describe('codex-agents-mcp: run_codex_agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Happy path: response has output text and metadata block; executeAgent called with correct args', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    const syntheticResult = makeSyntheticResult();
    (executeAgent as Mock).mockResolvedValue(syntheticResult);

    const handler = getToolHandler('run_codex_agent');
    const result = await handler({ agentId: 'coder-codex', prompt: 'Implement feature X' }) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe('Feature implemented successfully.');
    expect(result.content[1].text).toContain('[codex-agent-metadata]');
    expect(result.content[1].text).toContain('"runtime":"codex"');
    expect(result.content[1].text).toContain('"model":"gpt-5.5"');

    expect(executeAgent).toHaveBeenCalledOnce();
    const [req] = (executeAgent as Mock).mock.calls[0] as [{ agentId: string; prompt: string; cwd: string }];
    expect(req.agentId).toBe('coder-codex');
    expect(req.prompt).toBe('Implement feature X');
    expect(req.cwd).toBe(process.cwd());
  });

  it('1b. Context is prepended to prompt when provided', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    (executeAgent as Mock).mockResolvedValue(makeSyntheticResult());

    const handler = getToolHandler('run_codex_agent');
    await handler({ agentId: 'coder-codex', prompt: 'Do the task', context: 'File content: ...' });

    const [req] = (executeAgent as Mock).mock.calls[0] as [{ prompt: string }];
    expect(req.prompt).toBe('File content: ...\n\nDo the task');
  });

  it('2. Agent not found: isError true and message mentions agent id', async () => {
    (getAgent as Mock).mockReturnValue(undefined);

    const handler = getToolHandler('run_codex_agent');
    const result = await handler({ agentId: 'missing-agent', prompt: 'Do something' }) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing-agent');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('3. Wrong runtime: isError true and message mentions runtime mismatch', async () => {
    (getAgent as Mock).mockReturnValue({
      id: 'cloud-agent',
      runtime: 'cloud',
      isActive: true,
    });

    const handler = getToolHandler('run_codex_agent');
    const result = await handler({ agentId: 'cloud-agent', prompt: 'Do something' }) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cloud');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('4. executeAgent throws: isError true with error message', async () => {
    const agent = makeCodexAgent();
    (getAgent as Mock).mockReturnValue(agent);
    (executeAgent as Mock).mockRejectedValue(new Error('bridge timeout'));

    const handler = getToolHandler('run_codex_agent');
    const result = await handler({ agentId: 'coder-codex', prompt: 'Do something' }) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bridge timeout');
  });
});

describe('codex-agents-mcp: codex_agents_health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5. Returns JSON string with installed, version, authenticated fields', async () => {
    const healthStatus = { installed: true, version: '1.0.0', authenticated: true };
    (isCodexAvailable as Mock).mockResolvedValue(healthStatus);

    const handler = getToolHandler('codex_agents_health');
    const result = await handler({}) as { content: Array<{ text: string }> };

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.installed).toBe(true);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.authenticated).toBe(true);
  });
});

describe('getCodexAgentsDescription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('6. Returns empty string when no codex agents exist', () => {
    (getAllAgents as Mock).mockReturnValue([
      { id: 'cloud-1', runtime: 'cloud', isActive: true },
      { id: 'local-1', runtime: 'local', isActive: true, localConfig: { model: 'llama3' } },
    ]);

    const result = getCodexAgentsDescription();
    expect(result).toBe('');
  });

  it('7. Returns description string with both codex agents listed', () => {
    (getAllAgents as Mock).mockReturnValue([
      {
        id: 'codex-coder',
        name: 'Codex Coder',
        description: 'Implementa codigo com Codex',
        runtime: 'codex',
        isActive: true,
        codexConfig: { model: 'gpt-5.5' },
      },
      {
        id: 'codex-reviewer',
        name: 'Codex Reviewer',
        description: 'Revisa pull requests',
        runtime: 'codex',
        isActive: true,
        codexConfig: { model: 'gpt-5.4-mini' },
      },
      // Inactive agent — must be excluded
      {
        id: 'codex-inactive',
        name: 'Codex Inactive',
        description: 'Inativo',
        runtime: 'codex',
        isActive: false,
        codexConfig: { model: 'gpt-5.5' },
      },
      // Cloud agent — must be excluded
      {
        id: 'cloud-1',
        name: 'Cloud Agent',
        description: 'Cloud',
        runtime: 'cloud',
        isActive: true,
      },
    ]);

    const result = getCodexAgentsDescription();

    expect(result).not.toBe('');
    expect(result).toContain('Agentes Codex Disponiveis');
    expect(result).toContain('run_codex_agent');
    expect(result).toContain('"codex-coder"');
    expect(result).toContain('gpt-5.5');
    expect(result).toContain('"codex-reviewer"');
    expect(result).toContain('gpt-5.4-mini');
    // Inactive and cloud agents must NOT appear
    expect(result).not.toContain('"codex-inactive"');
    expect(result).not.toContain('"cloud-1"');
  });
});
