import type Database from 'better-sqlite3';
import { architectureMapper } from '../seed-agents';

/**
 * Migration V55: atualiza systemPrompt do `architecture-mapper` para incluir
 * campos opcionais `layer` e `kind` no schema do JSON do Architecture Map.
 *
 * Renumbered from V53 → V55 after merge with `windows refactor` (PR b29055e),
 * que ocupou as fatias V51 e V52. Roda depois de V53 (que insere o agent
 * architecture-mapper com prompt canonico) e V54 (triage meta exclusions).
 *
 * Motivacao: a UI do MapView (fase 1 do architecture-review) renderiza o mapa
 * em camadas (frontend / ipc / main / data / external / shared). Antes desta
 * migration, o mapper nao sugeria `layer` e a UI dependia 100% de inferencia
 * por path. Agora sugerimos o campo no JSON; UI continua com fallback robusto
 * para mapas antigos sem o campo.
 *
 * Backward compat: campos sao OPCIONAIS. Mapas antigos (sem layer/kind)
 * continuam parseando normalmente. UI infere a layer por path.
 *
 * R10 dupla:
 * - Edit no `.ts` (seed-agents/architecture-mapper.ts) cobre fresh installs.
 * - Esta migration cobre DBs existentes (V53 ja inseriu o agente; V55 atualiza).
 */
export function applyMigrationV55(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = ? WHERE id = 'architecture-mapper'`,
  ).run(architectureMapper.systemPrompt);
}

export const __V55_INTERNAL = {
  newPrompt: architectureMapper.systemPrompt,
};
