/**
 * pipeline-shared/persist.ts
 *
 * Helpers unicos de persistencia. Antes desta extracao (S2.2), 38 sitios
 * chamavam savePipelineMessage / insertEnrichMessage / insertHarnessRound /
 * updateHarnessRound espalhados por pipeline-engine.ts e harness-engine.ts.
 *
 * Como ler:
 * - persistMessage(target, role, content, metadata?) — pra mensagens de
 *   chat/enrich/pipeline. Usa discriminated union pra deixar explicito o
 *   target type.
 * - persistHarnessRound — namespace com .insert() e .update() pra rounds
 *   do harness. Re-exporta as funcoes do db.ts sem wrapping (assinaturas
 *   complexas e identicas), mas centraliza o ponto de import.
 *
 * Restricoes:
 * - NAO altera comportamento das funcoes DB (apenas wrappear / re-exportar).
 * - Apenas este arquivo (e __tests__) deve importar essas funcoes do db.ts
 *   fora do proprio db.ts.
 */

import {
  insertEnrichMessage as dbInsertEnrichMessage,
  insertHarnessRound as dbInsertHarnessRound,
  savePipelineMessage as dbSavePipelineMessage,
  updateHarnessRound as dbUpdateHarnessRound,
} from '../db';

// Discriminated union — explicito por target type.
export type PersistMessageTarget =
  | {
      kind: 'pipeline';
      projectId: string;
      phaseNumber: number;
      sprintIndex?: number;
      roundIndex?: number;
      agentId?: string;
    }
  | {
      kind: 'enrich';
      sessionId: string;
      phase: 'validator' | 'enricher';
    };

export interface PersistMessageMetadata {
  toolCalls?: Array<{
    tool: string;
    input: unknown;
    output?: string;
    isError?: boolean;
  }>;
}

/**
 * Persiste mensagem de chat/pipeline/enrich.
 *
 * - kind 'pipeline': delega pro savePipelineMessage do DB. Suporta
 *   sprintIndex/roundIndex/agentId via target. metadata.toolCalls eh
 *   preservado.
 * - kind 'enrich': delega pro insertEnrichMessage do DB. metadata.toolCalls
 *   (se houver) eh propagado.
 *
 * NAO altera a forma como o DB persiste — eh um helper de chamada.
 */
export function persistMessage(
  target: PersistMessageTarget,
  role: 'user' | 'assistant',
  content: string,
  metadata?: PersistMessageMetadata,
): void {
  if (target.kind === 'pipeline') {
    dbSavePipelineMessage({
      projectId: target.projectId,
      phaseNumber: target.phaseNumber,
      role,
      content,
      toolCalls: metadata?.toolCalls,
      sprintIndex: target.sprintIndex,
      roundIndex: target.roundIndex,
      agentId: target.agentId,
    });
    return;
  }

  if (target.kind === 'enrich') {
    // insertEnrichMessage so aceita toolCalls com {tool, input}, sem
    // output/isError. Strip os campos extras se vierem.
    const enrichToolCalls = metadata?.toolCalls?.map((tc) => ({
      tool: tc.tool,
      input: tc.input,
    }));
    dbInsertEnrichMessage(
      target.sessionId,
      target.phase,
      role,
      content,
      enrichToolCalls,
    );
    return;
  }

  // Exhaustiveness check.
  const _exhaustive: never = target;
  throw new Error(`Unsupported persist target: ${String(_exhaustive)}`);
}

/**
 * Insere ou atualiza um harness round.
 *
 * Re-exporta as funcoes do db.ts sob um namespace, sem wrapping. Decisao:
 * as assinaturas sao complexas (Partial<{...22 campos...}>) e idempotentes
 * com o DB; criar um wrapper trivial seria redundante e duplicaria os
 * tipos. Manter o ponto de import unico ja atende o objetivo do SPEC.
 *
 * Padrao de uso:
 *   const round = persistHarnessRound.insert({ sprintId, roundNumber });
 *   persistHarnessRound.update(round.id, { verdict, ... });
 */
export const persistHarnessRound = {
  insert: dbInsertHarnessRound,
  update: dbUpdateHarnessRound,
};
