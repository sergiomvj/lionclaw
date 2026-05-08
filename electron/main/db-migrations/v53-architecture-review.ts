import type Database from 'better-sqlite3';
import {
  architectureMapper,
  architectureTargetTriage,
  architectureDiagnostician,
  architectureDecisionInterviewer,
} from '../seed-agents';

/**
 * Migration V53: introduce architecture-review pipeline.
 *
 * Renumbered from V51 → V53 after merge with `windows refactor` (PR b29055e),
 * que ocupou as fatias V51 (codex_windows_prep_consent + codex_patch_failures
 * em harness_rounds) e V52 (remove Write tool dos agents tech-*). A ordem de
 * aplicacao agora e: V51-windows → V52-windows → V53-arch-review →
 * V54-triage-meta → V55-mapper-layers.
 *
 * O que faz:
 *  - INSERT OR IGNORE dos 4 seed agents do architecture-review usando o objeto
 *    seed COMPLETO (incluindo systemPrompt canonico). Importamos diretamente
 *    de `seed-agents/index` para evitar duplicar 200+ linhas de prompt entre
 *    o `.ts` do agente e a migration — a fonte unica fica nos `.ts` (R10 dupla
 *    satisfeita: edit do `.ts` cobre fresh installs E DBs existentes via esta
 *    migration).
 *
 *  - Sem ALTER TABLE: runId e selectedCandidateId vivem em
 *    `harness_projects.config.architectureReview.{runId, selectedCandidateId}`
 *    (decisao §15.1 da SPEC).
 *
 *  - Sem expansao de CHECK constraint: a coluna `pipeline_type` em
 *    `harness_projects` (db.ts:1352) nao tem CHECK, apenas DEFAULT 'development'.
 *
 * Por que NAO confiar so em `ensureAllSeedAgents` para popular o prompt:
 *  - `reconcileSeedAgent` (db.ts:2703-2708) e estritamente INSERT-only por design
 *    (R6/R10 de CLAUDE.md): se a row ja existe, retorna sem UPDATE.
 *  - Se esta migration inserisse prompt vazio, o reconcile depois nao
 *    sobrescreveria, deixando o agent com `systemPrompt=''` para sempre.
 *  - Por isso esta migration ja insere o prompt canonico — mesmo pattern
 *    semantico de V50 (que fez UPDATE direto contra OLD prompt conhecido),
 *    aqui adaptado para INSERT OR IGNORE em row nova.
 *
 * Idempotencia:
 *  - Boot 1 (fresh DB): rows nao existem, INSERT cria com prompt canonico.
 *  - Boot 2+ (DB ja com migration aplicada): INSERT OR IGNORE no-op,
 *    customizacoes do user em `system_prompt` sobrevivem.
 *  - Boot ate algum dia em que o user delete um dos 4 agents: rerun da
 *    migration esta gated em `currentVersion < 53`, entao nao roda. O
 *    fluxo `ensureAllSeedAgents` recria o agent na proxima inicializacao
 *    via reconcileSeedAgent (insert-only, mesmo pattern do resto).
 */

const ARCHITECTURE_REVIEW_SEEDS = [
  architectureMapper,
  architectureTargetTriage,
  architectureDiagnostician,
  architectureDecisionInterviewer,
] as const;

export function applyMigrationV53(db: Database.Database): void {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id,
      name,
      description,
      system_prompt,
      model,
      allowed_tools,
      mcp_servers,
      is_active,
      sort_order,
      effort,
      thinking,
      thinking_budget,
      max_turns,
      skills,
      runtime,
      max_tool_rounds,
      squad
    ) VALUES (
      @id,
      @name,
      @description,
      @system_prompt,
      @model,
      @allowed_tools,
      @mcp_servers,
      @is_active,
      0,
      @effort,
      @thinking,
      @thinking_budget,
      @max_turns,
      @skills,
      @runtime,
      @max_tool_rounds,
      @squad
    )
  `);

  const tx = db.transaction(() => {
    for (const seed of ARCHITECTURE_REVIEW_SEEDS) {
      insertStmt.run({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        system_prompt: seed.systemPrompt,
        model: seed.model,
        allowed_tools: JSON.stringify(seed.allowedTools ?? []),
        mcp_servers: JSON.stringify(seed.mcpServers ?? []),
        is_active: seed.isActive ? 1 : 0,
        effort: seed.effort,
        thinking: seed.thinking,
        thinking_budget: seed.thinkingBudget ?? 0,
        max_turns: seed.maxTurns,
        skills: JSON.stringify(seed.skills ?? []),
        runtime: seed.runtime,
        max_tool_rounds: seed.maxToolRounds,
        squad: seed.squad,
      });
    }
  });
  tx();
}

// Exposed for tests.
export const __V53_INTERNAL = {
  ARCHITECTURE_REVIEW_SEEDS,
};
