import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * R8 regression test: garante que os callers de executeAgent continuam
 * usando o perfil correto.
 *
 * Esse teste NAO executa o caller — apenas le o source. Se alguem trocar
 * o perfil sem passar por code review, esse teste falha.
 *
 * S1.1: enrich migrado pra executeAgent + PERM_DEFAULT_WITH_GUARD em
 * 3 callsites no harness-engine (validator-start, validator-message,
 * enricher-start).
 *
 * Sprints S1.0 + outras (planner/coder/evaluator -> PERM_BYPASS_NO_GUARD)
 * ainda nao foram aplicadas no HEAD; quando forem, atualizar a entry de
 * harness-engine para incluir PERM_BYPASS_NO_GUARD com a contagem certa.
 */

interface CallerExpectation {
  file: string;
  expectedExecuteAgentCalls: number;
  expectedProfile: 'PERM_BYPASS_NO_GUARD' | 'PERM_DEFAULT_WITH_GUARD' | 'PERM_DEFAULT_NO_BYPASS';
}

const CALLERS: CallerExpectation[] = [
  {
    file: 'electron/main/harness-engine.ts',
    // 5 callsites de executeAgent apos P1.1 (Onda pos-validacao):
    // - planner (plan)
    // - planner-regen (regenerate)
    // - coder (spawnCoder)
    // - evaluator (spawnEvaluator)
    // - enrich helper (runEnrichExecuteAgent)
    // Os 4 primeiros usam PERM_BYPASS_NO_GUARD; enrich usa PERM_DEFAULT_WITH_GUARD.
    // expectedProfile aqui e o DOMINANTE (validacao secundaria checa o outro).
    expectedExecuteAgentCalls: 5,
    expectedProfile: 'PERM_BYPASS_NO_GUARD',
  },
  {
    file: 'electron/main/pipeline-engine/index.ts',
    expectedExecuteAgentCalls: 1,
    expectedProfile: 'PERM_BYPASS_NO_GUARD',
  },
  {
    file: 'electron/main/codex-agents-mcp.ts',
    expectedExecuteAgentCalls: 1,
    expectedProfile: 'PERM_BYPASS_NO_GUARD',
  },
];

const repoRoot = path.resolve(__dirname, '../../..');

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

describe('R8 caller permission snapshot — pipeline-engine, harness-engine, codex-agents-mcp', () => {
  for (const caller of CALLERS) {
    it(`${caller.file} calls executeAgent ${caller.expectedExecuteAgentCalls}x with ${caller.expectedProfile}`, () => {
      const fullPath = path.join(repoRoot, caller.file);
      const source = readFileSync(fullPath, 'utf-8');

      const executeAgentCalls = countOccurrences(source, 'executeAgent({');
      const profileUses = countOccurrences(source, caller.expectedProfile);

      expect(executeAgentCalls).toBe(caller.expectedExecuteAgentCalls);
      // Pelo menos 2 usos do perfil dominante (1 import + 1 callsite).
      // harness-engine eh hibrido (4 BYPASS + 1 WITH_GUARD pra enrich), entao
      // nao da pra exigir >=N+1 — apenas que o dominante exista.
      expect(profileUses).toBeGreaterThanOrEqual(2);
    });
  }

  it('S1.1 enrich uses PERM_DEFAULT_WITH_GUARD + createEnrichPermissionGuard in harness-engine', () => {
    const source = readFileSync(path.join(repoRoot, 'electron/main/harness-engine.ts'), 'utf-8');
    const guardUses = countOccurrences(source, 'PERM_DEFAULT_WITH_GUARD');
    // 1 import + 1 callsite no helper runEnrichExecuteAgent = >=2.
    expect(guardUses, 'harness-engine should reference PERM_DEFAULT_WITH_GUARD at least 2x (1 import + 1 callsite)').toBeGreaterThanOrEqual(2);
    expect(source.includes("import { setActiveEnrichSpecPath, createEnrichPermissionGuard } from './permission-guard'"), 'harness-engine should import createEnrichPermissionGuard').toBe(true);
    expect(countOccurrences(source, 'createEnrichPermissionGuard('), 'harness-engine should call createEnrichPermissionGuard()').toBeGreaterThanOrEqual(1);
  });

  it('no caller uses PERM_DEFAULT_NO_BYPASS by mistake (D11:339-342)', () => {
    for (const caller of CALLERS) {
      const fullPath = path.join(repoRoot, caller.file);
      const source = readFileSync(fullPath, 'utf-8');
      const wrongProfile = countOccurrences(source, 'PERM_DEFAULT_NO_BYPASS');
      expect(wrongProfile, `${caller.file} should NOT use PERM_DEFAULT_NO_BYPASS`).toBe(0);
    }
  });
});
