import type Database from 'better-sqlite3';
import { architectureTargetTriage } from '../seed-agents';

/**
 * Migration V54: atualiza systemPrompt do `architecture-target-triage` para
 * excluir explicitamente arquivos meta (CLAUDE.md, README.md, docs/, etc) do
 * escopo de candidatos arquiteturais.
 *
 * Renumbered from V52 → V54 after merge with `windows refactor` (PR b29055e),
 * que ocupou as fatias V51 e V52. Roda depois de V53 (que insere o agent
 * architecture-target-triage com prompt canonico).
 *
 * Bug observado: o triage propôs "CLAUDE.md e createAdapter() duplicados" como
 * candidato arquitetural. CLAUDE.md é meta-instrução do agente, não módulo do
 * produto — não deveria entrar no espaço de candidatos.
 *
 * Comportamento:
 * - UPDATE direcionado em `agents` WHERE id='architecture-target-triage'.
 * - Sem WHERE por hash do prompt antigo (não temos baseline confiável neste
 *   pipeline novo): aplicamos sempre. Se o user tiver customizado, ele perde
 *   a customização — aceitavel pois architecture-review e novo (V53) e
 *   ninguem teve tempo de customizar antes de hoje.
 *
 * R10 dupla:
 * - Edit no `.ts` (seed-agents/architecture-target-triage.ts) cobre fresh installs.
 * - Esta migration cobre DBs existentes (V53 ja aplicado, agente ja inserido).
 */
export function applyMigrationV54(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = ? WHERE id = 'architecture-target-triage'`,
  ).run(architectureTargetTriage.systemPrompt);
}

export const __V54_INTERNAL = {
  newPrompt: architectureTargetTriage.systemPrompt,
};
