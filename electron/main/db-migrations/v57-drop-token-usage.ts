import type Database from 'better-sqlite3';

/**
 * Migration V57: drop the legacy `token_usage` table.
 *
 * Por que:
 *  - A tela `Usage` (UsagePage.tsx) foi substituida pelo embed do CodeBurn.
 *  - `token_usage` so era lida pelos handlers `usage:*` e o unico writer era
 *    `insertTokenUsage` chamado pelo orchestrator (chat).
 *  - Pipeline / Harness usam tabelas proprias (`pipeline_phase_metrics`,
 *    `harness_rounds`, `harness_projects.*_tokens`) — NAO tocadas aqui.
 *  - `sessions.input_tokens / output_tokens / cost_usd` (alimentados por
 *    `updateSessionTokens`) tambem NAO sao tocados — continuam alimentando
 *    o counter de tokens do chat na sidebar.
 *
 * Fresh installs:
 *  - V2 ainda cria `token_usage` (nao mexemos em migrations historicas).
 *  - V57 dropa em seguida. Sequencia funciona, custo trivial.
 */
export function applyMigrationV57(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_usage_session;
    DROP INDEX IF EXISTS idx_usage_created;
    DROP INDEX IF EXISTS idx_usage_model;
    DROP TABLE IF EXISTS token_usage;
  `);
}
