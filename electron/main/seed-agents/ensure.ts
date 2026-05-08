/**
 * Unified ensure-pipeline para seed agents.
 *
 * Substitui as 8 funcoes ensure*Agents() historicas (que viviam em db.ts) por
 * uma unica chamada ensureAllSeedAgents() que:
 *
 *   1. Reconcilia o registro do agent no DB via reconcileSeedAgent (insert-only;
 *      preserva customizacoes do user).
 *   2. Materializa um snapshot read-only em .lionclaw/agents/<id>/config.json
 *      a partir do REGISTRO RESOLVIDO via resolveAgentQueryConfig — inclui
 *      todas as customizacoes que o user fez na UI.
 *
 * Boot deve chamar `await ensureAllSeedAgents()` UMA UNICA vez apos initDatabase.
 */

import path from 'path';
import fs from 'fs';
import type { AgentConfig } from '../../../src/types';
import { reconcileSeedAgent } from '../db';
import { getLionClawHome } from '../paths';
import { resolveAgentQueryConfig } from '../agent-config-resolver';
import { createLogger } from '../logger';
import {
  HARNESS_SEED_AGENTS,
  PIPELINE_SPEC_SEED_AGENTS,
  ENRICH_SEED_AGENTS,
  PIPELINE_SEED_AGENTS,
  TECH_SEED_AGENTS,
  SECURITY_SEED_AGENTS,
  FEATURE_SEED_AGENTS,
  DEV_SEED_AGENTS,
  SKILL_CREATOR_AGENTS,
  ARCHITECTURE_REVIEW_SEED_AGENTS,
} from './index';

const logger = createLogger('seed-agents-ensure');

type SeedAgent = Omit<AgentConfig, 'sortOrder'>;

/**
 * Reconcila um seed agent no DB e materializa o snapshot config.json.
 *
 * O snapshot reflete o registro RESOLVIDO (DB + RULES.md + tooling), portanto
 * preserva qualquer customizacao do user. NUNCA serve de fonte de verdade —
 * apenas referencia/debug.
 */
export async function ensureSeedAgent(seed: SeedAgent): Promise<void> {
  const squad = seed.squad ?? 'unknown';
  reconcileSeedAgent(seed, squad);

  const dir = path.join(getLionClawHome(), 'agents', seed.id);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const resolved = await resolveAgentQueryConfig(seed.id);
    const snapshot = {
      _comment: 'AUTO-GENERATED snapshot from DB. Edit via UI; this file is overwritten on every boot.',
      ...resolved,
    };
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(snapshot, null, 2),
      'utf8',
    );
  } catch (err) {
    logger.warn({ agentId: seed.id, err }, 'Failed to materialize agent config snapshot');
  }
}

/**
 * Reconcila TODOS os seed agents conhecidos no DB e materializa snapshots.
 * Substitui as 8 funcoes ensure*Agents() antigas por uma unica chamada de boot.
 */
export async function ensureAllSeedAgents(): Promise<void> {
  const allSeeds: SeedAgent[] = [
    ...SKILL_CREATOR_AGENTS,
    ...HARNESS_SEED_AGENTS,
    ...PIPELINE_SPEC_SEED_AGENTS,
    ...ENRICH_SEED_AGENTS,
    ...DEV_SEED_AGENTS,
    ...PIPELINE_SEED_AGENTS,
    ...TECH_SEED_AGENTS,
    ...SECURITY_SEED_AGENTS,
    ...FEATURE_SEED_AGENTS,
    ...ARCHITECTURE_REVIEW_SEED_AGENTS,
  ];
  for (const seed of allSeeds) {
    await ensureSeedAgent(seed);
  }
  logger.info({ count: allSeeds.length }, 'Ensured all seed agents');
}
