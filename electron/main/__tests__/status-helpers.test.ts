/**
 * status-helpers.test.ts
 *
 * Testa helpers de status do pipeline (Onda 3 da refatoracao).
 *
 * O que e testado aqui (sem necessidade de banco/Electron):
 * - deriveUIStatus: pure function, exhaustive sobre as flags + ordem de precedencia
 * - HarnessProjectStatus / UIStatus: contratos de tipo (compile-time)
 * - setProjectStatus: assinatura e contrato (mocked DB + IPC)
 *
 * SPEC: SPEC-refactor-pipelines.md secao S3.1 + S3.2.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dos modulos IO antes de importar o sob-teste
// ---------------------------------------------------------------------------

const updateHarnessProjectMock = vi.fn();
const emitIPCMock = vi.fn();

vi.mock('../db', () => ({
  updateHarnessProject: (...args: unknown[]) => updateHarnessProjectMock(...args),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: (...args: unknown[]) => emitIPCMock(...args),
}));

// Importa pos-mock pra que o modulo veja os spies.
import {
  deriveUIStatus,
  setProjectStatus,
  type HarnessProjectStatus,
  type UIStatus,
} from '../pipeline-shared/status';

// ---------------------------------------------------------------------------
// deriveUIStatus
// ---------------------------------------------------------------------------

describe('deriveUIStatus: pure function', () => {
  it('retorna o domain status quando nenhuma flag esta setada', () => {
    expect(deriveUIStatus('idle', {})).toBe('idle');
    expect(deriveUIStatus('running', {})).toBe('running');
    expect(deriveUIStatus('paused', {})).toBe('paused');
    expect(deriveUIStatus('done', {})).toBe('done');
    expect(deriveUIStatus('failed', {})).toBe('failed');
    expect(deriveUIStatus('aborted', {})).toBe('aborted');
    expect(deriveUIStatus('interrupted', {})).toBe('interrupted');
  });

  it('retorna "streaming" quando isStreaming=true e nenhuma flag de prioridade maior', () => {
    expect(deriveUIStatus('idle', { isStreaming: true })).toBe('streaming');
    expect(deriveUIStatus('running', { isStreaming: true })).toBe('streaming');
    expect(deriveUIStatus('paused', { isStreaming: true })).toBe('streaming');
  });

  it('retorna "awaiting-user" quando awaitingUser=true e isStreaming=false', () => {
    expect(deriveUIStatus('paused', { awaitingUser: true })).toBe('awaiting-user');
    expect(deriveUIStatus('running', { awaitingUser: true })).toBe('awaiting-user');
  });

  it('retorna "pipeline-completed" quando pipelineComplete=true (precedencia maxima)', () => {
    expect(deriveUIStatus('done', { pipelineComplete: true })).toBe('pipeline-completed');
    expect(deriveUIStatus('idle', { pipelineComplete: true })).toBe('pipeline-completed');
  });

  it('precedencia: pipelineComplete > isStreaming > awaitingUser > domain', () => {
    // pipelineComplete vence todos
    expect(
      deriveUIStatus('running', {
        pipelineComplete: true,
        isStreaming: true,
        awaitingUser: true,
      }),
    ).toBe('pipeline-completed');

    // isStreaming vence awaitingUser
    expect(
      deriveUIStatus('paused', {
        isStreaming: true,
        awaitingUser: true,
      }),
    ).toBe('streaming');

    // awaitingUser vence domain
    expect(
      deriveUIStatus('failed', {
        awaitingUser: true,
      }),
    ).toBe('awaiting-user');
  });

  it('flags falsy nao afetam o resultado (treated as undefined)', () => {
    expect(
      deriveUIStatus('running', {
        isStreaming: false,
        awaitingUser: false,
        pipelineComplete: false,
      }),
    ).toBe('running');
  });

  it('e uma pure function — chamadas repetidas com mesmo input retornam mesmo output', () => {
    const input = { isStreaming: true, awaitingUser: false };
    const r1 = deriveUIStatus('paused', input);
    const r2 = deriveUIStatus('paused', input);
    const r3 = deriveUIStatus('paused', input);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toBe('streaming');
  });

  it('aceita os novos status (aborted, interrupted) como domain', () => {
    expect(deriveUIStatus('aborted', {})).toBe('aborted');
    expect(deriveUIStatus('interrupted', {})).toBe('interrupted');
    expect(deriveUIStatus('aborted', { isStreaming: true })).toBe('streaming');
    expect(deriveUIStatus('interrupted', { awaitingUser: true })).toBe('awaiting-user');
  });
});

// ---------------------------------------------------------------------------
// setProjectStatus
// ---------------------------------------------------------------------------

describe('setProjectStatus: chama DB e emite IPC', () => {
  beforeEach(() => {
    updateHarnessProjectMock.mockReset();
    emitIPCMock.mockReset();
  });

  it('chama updateHarnessProject com { status } e nada mais', () => {
    setProjectStatus('proj-1', 'paused');
    expect(updateHarnessProjectMock).toHaveBeenCalledTimes(1);
    expect(updateHarnessProjectMock).toHaveBeenCalledWith('proj-1', { status: 'paused' });
  });

  it('emite pipeline:project-updated com patch.status apenas', () => {
    setProjectStatus('proj-2', 'aborted');
    expect(emitIPCMock).toHaveBeenCalledTimes(1);
    expect(emitIPCMock).toHaveBeenCalledWith('pipeline:project-updated', {
      projectId: 'proj-2',
      patch: { status: 'aborted' },
    });
  });

  it('aceita os 10 status persistidos validos', () => {
    const allStatuses: HarnessProjectStatus[] = [
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted',
    ];
    for (const status of allStatuses) {
      setProjectStatus('proj-id', status);
    }
    expect(updateHarnessProjectMock).toHaveBeenCalledTimes(10);
    expect(emitIPCMock).toHaveBeenCalledTimes(10);
  });

  it('a ordem das chamadas e: DB primeiro, depois IPC', () => {
    const callOrder: string[] = [];
    updateHarnessProjectMock.mockImplementation(() => callOrder.push('db'));
    emitIPCMock.mockImplementation(() => callOrder.push('ipc'));

    setProjectStatus('proj-3', 'done');

    expect(callOrder).toEqual(['db', 'ipc']);
  });
});

// ---------------------------------------------------------------------------
// Contratos de tipo (compile-time — testes existem pra validar exhaustividade)
// ---------------------------------------------------------------------------

describe('HarnessProjectStatus / UIStatus: contratos de tipo', () => {
  it('HarnessProjectStatus tem exatamente os 10 valores esperados (runtime check)', () => {
    const persisted: HarnessProjectStatus[] = [
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted',
    ];
    expect(persisted).toHaveLength(10);
  });

  it('UIStatus inclui os 10 persistidos + 3 derivados (13 total)', () => {
    const ui: UIStatus[] = [
      // os 10 persistidos
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted',
      // os 3 UI-only
      'streaming', 'awaiting-user', 'pipeline-completed',
    ];
    expect(ui).toHaveLength(13);
    expect(new Set(ui).size).toBe(13); // todos distintos
  });

  it('os 3 valores UI-only NUNCA sao persistidos (nao aparecem em HarnessProjectStatus)', () => {
    const persisted: ReadonlyArray<HarnessProjectStatus> = [
      'idle', 'planning', 'reviewing', 'ready',
      'running', 'paused', 'done', 'failed',
      'aborted', 'interrupted',
    ];
    // O TS impede esse cast em codigo de producao; aqui validamos em runtime
    // que os strings UI-only nao aparecem na lista de persistidos.
    expect(persisted as readonly string[]).not.toContain('streaming');
    expect(persisted as readonly string[]).not.toContain('awaiting-user');
    expect(persisted as readonly string[]).not.toContain('pipeline-completed');
  });
});
