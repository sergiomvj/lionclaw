/**
 * pipeline-shared/status.ts
 *
 * Tipos canonicos de status do pipeline + helpers.
 *
 * Por que isso existe (S3 — refactor de pipelines):
 *
 * Antes da Onda 3, o status do projeto era escrito em N lugares com N variacoes
 * de string. O CHECK constraint no DB nao permitia 'aborted' nem 'interrupted',
 * entao recoverInterruptedPipelines salvava 'paused' mas emitia 'interrupted'
 * em IPC (gambiarra), e abortPipeline persistia 'failed' mesmo quando era abort
 * voluntario do usuario (informacao perdida pra UI).
 *
 * Pos-V48 (migration que expande o CHECK):
 * - 'aborted' = usuario apertou parar (intencional, nao e erro)
 * - 'interrupted' = pipeline recuperado de crash (queda do main process)
 * - 'failed' = falha real (excecao, max-rounds esgotado, etc)
 *
 * UIStatus e um superset que inclui 3 estados derivados em tempo de runtime
 * (nunca persistidos): 'streaming' (chunk chegando agora), 'awaiting-user' (fase
 * conversacional aguardando input), 'pipeline-completed' (todas as fases ok).
 */

import { emitIPC } from './ipc-emitter';
import { updateHarnessProject } from '../db';
import { createLogger } from '../logger';

const logger = createLogger('status-helper');

/**
 * Status persistido em harness_projects.status. Coberto pelo CHECK constraint
 * pos-V48. NUNCA inclua valores UI-only aqui — TS impede que callers passem
 * 'streaming' / 'awaiting-user' / 'pipeline-completed' pra setProjectStatus.
 */
export type HarnessProjectStatus =
  | 'idle'
  | 'planning'
  | 'reviewing'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted';

/**
 * Status apresentado ao usuario. Superset de HarnessProjectStatus com 3 valores
 * derivados em runtime que NAO ficam no DB:
 * - 'streaming': agente esta emitindo chunks AGORA (real-time)
 * - 'awaiting-user': fase conversacional pediu input do usuario
 * - 'pipeline-completed': todas as fases concluidas com sucesso
 */
export type UIStatus =
  | HarnessProjectStatus
  | 'streaming'
  | 'awaiting-user'
  | 'pipeline-completed';

/**
 * Deriva o status apresentado ao usuario a partir do status persistido + flags
 * de runtime. Pure function (sem side-effects, sem DB, sem IPC).
 *
 * Ordem de precedencia:
 *  1. pipelineComplete  -> 'pipeline-completed'
 *  2. isStreaming       -> 'streaming'
 *  3. awaitingUser      -> 'awaiting-user'
 *  4. fallback          -> domain status (do DB)
 */
export function deriveUIStatus(
  domain: HarnessProjectStatus,
  flags: {
    isStreaming?: boolean;
    awaitingUser?: boolean;
    pipelineComplete?: boolean;
  },
): UIStatus {
  if (flags.pipelineComplete) return 'pipeline-completed';
  if (flags.isStreaming) return 'streaming';
  if (flags.awaitingUser) return 'awaiting-user';
  return domain;
}

/**
 * Helper pra mudancas PURAS de status do projeto. Atualiza a coluna `status`
 * em harness_projects e emite `pipeline:project-updated` pra renderer
 * sincronizar a UI sem refetch.
 *
 * QUANDO usar:
 * - Voce so quer mudar o status (sem outros campos).
 *
 * QUANDO NAO usar (use updateHarnessProject diretamente):
 * - Atualizacao composta (status + currentSprintIndex, status + tokens, etc).
 *   Manter como uma chamada SQL preserva atomicidade e dispara um unico UPDATE.
 *
 * O parametro `status` e tipado como HarnessProjectStatus pra impedir, em tempo
 * de compilacao, que callers passem valores UI-only ('streaming', etc).
 */
export function setProjectStatus(
  projectId: string,
  status: HarnessProjectStatus,
  opts?: { reason?: string },
): void {
  updateHarnessProject(projectId, { status });
  emitIPC('pipeline:project-updated', {
    projectId,
    patch: { status },
  });
  // Audit trail: registra toda mudanca pura de status. Util pra entender no log
  // quem/quando passou de running pra paused, etc. Reason eh opcional.
  logger.info(
    { projectId, status, ...(opts?.reason ? { reason: opts.reason } : {}) },
    'Project status changed',
  );
}
