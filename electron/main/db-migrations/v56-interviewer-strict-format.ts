import type Database from 'better-sqlite3';
import { architectureDecisionInterviewer } from '../seed-agents';

/**
 * Migration V56: atualiza systemPrompt do `architecture-decision-interviewer`
 * para deixar explicito que os 4 labels (Pergunta/Decisao/Razao/Implica) sao
 * obrigatorios em cada `## DN`. Sem isso, o gate reforcado da fase 4 (engine)
 * passa a rejeitar decisoes que o agente teria escrito antes em formato livre.
 *
 * Motivacao: o gate antigo (`>=1 ## DN`) deixava decisoes incompletas passarem
 * adiante e o spec-builder gerava SPEC pobre. Novo gate exige >=3 decisoes,
 * cada uma com os 4 campos canonicos. Pra evitar false-fail (agente escrevendo
 * "Question:"/"Reason:" em ingles), o engine usa regex tolerante COM sinonimos
 * mas o prompt agora amarra o formato canonico em PT-BR pra o caso comum.
 *
 * R10 dupla:
 * - Edit no `.ts` (seed-agents/architecture-decision-interviewer.ts) cobre fresh installs.
 * - Esta migration cobre DBs existentes (V53 ja inseriu o agente; V56 atualiza o prompt).
 */
export function applyMigrationV56(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = ? WHERE id = 'architecture-decision-interviewer'`,
  ).run(architectureDecisionInterviewer.systemPrompt);
}

export const __V56_INTERNAL = {
  newPrompt: architectureDecisionInterviewer.systemPrompt,
};
