/**
 * codex-pool-projectid.test.ts
 *
 * S4.3 (Onda 4): pool de codex isolado por projeto.
 *
 * Cobre:
 *  - createCodexSession marca o slot com opts.projectId
 *  - resetCodexPool(projectId) mata APENAS slots com slot.projectId === projectId
 *  - resetCodexPool() sem argumento mata TODOS os slots vivos (legado)
 *  - slots SEM projectId nao sao afetados por reset com filtro
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ---- Mock logger ----
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
  public killed = false;
  public killSignal: string | undefined;

  constructor() {
    super();
    this.stdin = new FakeStdin();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  pushLine(msg: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
  }
}

let spawnedChildren: FakeChild[] = [];

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild();
    spawnedChildren.push(child);
    return child;
  }),
}));

// ---- Import bridge AFTER mocks ----
import {
  createCodexSession,
  resetCodexPool,
  _resetPoolForTesting,
} from '../codex-bridge';

// ---- Helpers ----

async function waitForSpawn(n: number): Promise<void> {
  await vi.waitFor(() => spawnedChildren.length >= n, { timeout: 3000 });
}

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

async function waitForToolsCall(child: FakeChild): Promise<void> {
  await vi.waitFor(() => {
    const lines = child.stdin.parsedLines();
    return lines.some((l) => l['method'] === 'tools/call');
  }, { timeout: 3000 });
}

/**
 * Cria uma sessao codex com projectId, dispara o spawn (via send),
 * completa o handshake e aguarda a tools/call landar — garantindo que o slot
 * esta vivo (slot.child !== null) quando o teste chama resetCodexPool.
 */
async function spawnLiveSession(projectId: string | undefined, label: string) {
  const session = await createCodexSession({
    model: 'gpt-5.5',
    cwd: `/tmp/${label}`,
    projectId,
  });
  const childCountBefore = spawnedChildren.length;
  // Disparamos send sem await (so queremos que o slot fique vivo)
  void session.send('test prompt', {}).catch(() => { /* tolerate abort/reject */ });
  await waitForSpawn(childCountBefore + 1);
  const child = spawnedChildren[spawnedChildren.length - 1];
  completeHandshake(child);
  await waitForToolsCall(child);
  return { session, child };
}

// ---- Tests ----

describe('codex-bridge S4.3 — pool por projectId', () => {
  beforeEach(() => {
    spawnedChildren = [];
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  // ---------------------------------------------------------------------------
  // resetCodexPool(projectId): mata so slots desse projeto
  // ---------------------------------------------------------------------------

  it('reset com projectId mata so slots desse projeto (3 A + 2 B)', async () => {
    // Cenario: 3 sessoes do projeto A + 2 sessoes do projeto B
    const a1 = await spawnLiveSession('proj_a', 'a1');
    const a2 = await spawnLiveSession('proj_a', 'a2');
    const a3 = await spawnLiveSession('proj_a', 'a3');
    const b1 = await spawnLiveSession('proj_b', 'b1');
    const b2 = await spawnLiveSession('proj_b', 'b2');

    expect(spawnedChildren).toHaveLength(5);
    // Sanity: nenhum killed ainda
    for (const c of [a1.child, a2.child, a3.child, b1.child, b2.child]) {
      expect(c.killed).toBe(false);
    }

    // Reset SO do projeto A
    resetCodexPool('proj_a');

    // Os 3 slots de A devem ter sido kill'd
    expect(a1.child.killed).toBe(true);
    expect(a1.child.killSignal).toBe('SIGTERM');
    expect(a2.child.killed).toBe(true);
    expect(a3.child.killed).toBe(true);

    // Os 2 slots de B devem permanecer vivos
    expect(b1.child.killed).toBe(false);
    expect(b2.child.killed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // resetCodexPool() sem arg: mata TUDO (legado)
  // ---------------------------------------------------------------------------

  it('reset sem projectId mata todos os slots vivos (comportamento legado)', async () => {
    const a1 = await spawnLiveSession('proj_a', 'a1');
    const b1 = await spawnLiveSession('proj_b', 'b1');
    const noproj = await spawnLiveSession(undefined, 'noproj');

    expect(spawnedChildren).toHaveLength(3);

    resetCodexPool();

    expect(a1.child.killed).toBe(true);
    expect(b1.child.killed).toBe(true);
    expect(noproj.child.killed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // reset(projectId) NAO afeta slots sem projectId (undefined !== string)
  // ---------------------------------------------------------------------------

  it('reset com projectId NAO afeta slots sem projectId definido', async () => {
    const noproj = await spawnLiveSession(undefined, 'noproj');
    const withproj = await spawnLiveSession('proj_a', 'a1');

    resetCodexPool('proj_a');

    expect(withproj.child.killed).toBe(true);
    // Slot sem projectId nao deveria ser atingido por filtro com projectId
    expect(noproj.child.killed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // reset(projectId) com pool vazio e no-op
  // ---------------------------------------------------------------------------

  it('reset com projectId quando pool esta vazio e no-op', () => {
    expect(() => resetCodexPool('proj_a')).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // reset(projectId) com filtro que nao matchea nenhum slot e no-op
  // ---------------------------------------------------------------------------

  it('reset(projectId) que nao matchea nenhum slot deixa pool intacto', async () => {
    const a1 = await spawnLiveSession('proj_a', 'a1');
    const b1 = await spawnLiveSession('proj_b', 'b1');

    resetCodexPool('proj_inexistente');

    expect(a1.child.killed).toBe(false);
    expect(b1.child.killed).toBe(false);
  });
});
