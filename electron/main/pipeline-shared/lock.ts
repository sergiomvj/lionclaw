/**
 * pipeline-shared/lock.ts
 *
 * Lock per-projeto, RAM-only (Map zerado em restart).
 *
 * Substitui o mutex global `_activeLoopProjectId` que existia em
 * `pipeline-engine.ts` antes da Onda 4 (S4.1/S4.2). Aquele mutex bloqueava
 * QUALQUER segundo pipeline em QUALQUER projeto. Esse lock e per-projeto:
 *   - Bloqueia tentar iniciar 2 pipelines no mesmo projeto.
 *   - Permite pipelines em projetos diferentes coexistirem.
 *
 * Pos-restart: `recoverInterruptedPipelines` em `pipeline-engine.ts` marca
 * status='interrupted' e libera locks orfaos. Quando o usuario clica
 * Resume/Advance/Retry depois disso, o handler IPC chama `ensureProjectLock`
 * (idempotente) pra readquirir antes de executar.
 *
 * SPEC `SPEC-refactor-pipelines.md` D4 (linhas 195-239) e Sprints S4.1/S4.2.
 */

export interface ProjectLock {
  projectId: string;
  pipelineKind: 'pipeline-engine';
  acquiredAt: Date;
}

const activeLocks = new Map<string, ProjectLock>();

export type AcquireLockResult =
  | { ok: true; lock: ProjectLock }
  | { ok: false; runningPipeline: ProjectLock };

/**
 * Acquire estrito: falha se ja existe lock pra este projeto.
 * Use para entrypoints que iniciam EXECUCAO NOVA (`pipeline:start`).
 */
export function acquireProjectLock(
  projectId: string,
  kind: 'pipeline-engine' = 'pipeline-engine',
): AcquireLockResult {
  const existing = activeLocks.get(projectId);
  if (existing) return { ok: false, runningPipeline: existing };
  const lock: ProjectLock = { projectId, pipelineKind: kind, acquiredAt: new Date() };
  activeLocks.set(projectId, lock);
  return { ok: true, lock };
}

/**
 * Idempotente: adquire se nao existe, no-op se ja tem.
 * Use para entrypoints que continuam execucao (resume, advance, retry pos-restart).
 */
export function ensureProjectLock(
  projectId: string,
  kind: 'pipeline-engine' = 'pipeline-engine',
): { ok: true; lock: ProjectLock } {
  const existing = activeLocks.get(projectId);
  if (existing) return { ok: true, lock: existing };
  const lock: ProjectLock = { projectId, pipelineKind: kind, acquiredAt: new Date() };
  activeLocks.set(projectId, lock);
  return { ok: true, lock };
}

export function releaseProjectLock(projectId: string): void {
  activeLocks.delete(projectId);
}

export function isProjectLocked(projectId: string): boolean {
  return activeLocks.has(projectId);
}

/**
 * FOR TESTING ONLY. Limpa todos os locks. Nao chamar em codigo de producao —
 * o lock e RAM-only e o restart natural do app ja zera tudo.
 */
export function _resetLocksForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetLocksForTesting can only be called in test environment');
  }
  activeLocks.clear();
}
