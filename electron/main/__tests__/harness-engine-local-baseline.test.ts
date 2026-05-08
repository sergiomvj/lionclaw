/**
 * harness-engine-local-baseline.test.ts
 *
 * Suite de regressao: path local (Ollama/LM Studio) preserva comportamento
 * identico antes e depois desta SPEC.
 *
 * STATUS: SKIPPED (todos os testes usam it.skip)
 *
 * POR QUE SKIPPED:
 * Para testar o path local de forma realista precisamos de:
 *  1. Uma instancia Ollama rodando localmente (ou mock completo de fetch incluindo
 *     o protocolo NDJSON de streaming do Ollama).
 *  2. Um banco SQLite real com schema completo (V1..V44) e seeds de agentes locais.
 *  3. BrowserWindow Electron para emissao de eventos IPC durante o sprint.
 *  4. Filesystem para cwd das tools (Read, Write, Bash).
 *
 * Mockar ollamaChatWithTools diretamente anularia o valor do teste de regressao:
 * o ponto e verificar que o codigo real do path local se comporta identico ao
 * codigo anterior, nao que o mock e chamado corretamente.
 *
 * O que cada teste deveria cobrir (documentado para sprint futura):
 *  - Sprint completo com coder local e evaluator local
 *  - Verificar apiRequests = 1 HARDCODED (invariante preservado desta SPEC)
 *  - Verificar que mcpServers e IGNORADO no path local (nao passa mcpServers ao chat)
 *  - Verificar costSource = 'calculated' (path local nao tem custo reportado)
 *  - Verificar runtimeUsed = 'local', providerUsed = localCfg.provider
 *  - Comparar tokensUsed e promptTokens com baseline capturado em main branch
 *
 * SPEC secao 0.1 + 0.3 + 7.1 (regressao path local).
 */

import { describe, it } from 'vitest';

describe('harness-engine: regressao path local', () => {
  it.skip(
    'coder local: apiRequests = 1 hardcoded preservado apos migration V43+V44',
    () => {
      // TODO: Verificar que o campo apiRequests sempre e 1 para runtime local
      // Invariante documentado em SPEC 0.1: "gravando apiRequests: 1 hardcoded como hoje"
    },
  );

  it.skip(
    'coder local: mcpServers ignorado silenciosamente (nao passa ao ollamaChatWithTools)',
    () => {
      // TODO: Configurar agente local com mcpServers=['knowledge-base']
      // TODO: Verificar que setupMCPsForSession nunca e chamado
      // TODO: Verificar que ollamaChatWithTools e chamado SEM campo mcpServers
    },
  );

  it.skip(
    'coder local: costSource = "calculated" (path local nunca tem custo reportado)',
    () => {
      // TODO: Verificar harness_rounds.cost_source = 'calculated' para runtime local
    },
  );

  it.skip(
    'coder local: runtimeUsed = "local", providerUsed = localCfg.provider',
    () => {
      // TODO: Verificar harness_rounds.runtime_used = 'local'
      // TODO: Verificar harness_rounds.provider_used = agent.localConfig.provider
    },
  );

  it.skip(
    'sprint completo local: metricas identicas ao baseline de main branch',
    () => {
      // TODO: Capturar baseline de metricas em main branch (antes da SPEC)
      // TODO: Rodar sprint com Ollama mock e comparar metricas bit-a-bit
    },
  );

  it.skip(
    'path local: novos campos OllamaChatResult (apiRequests, cacheHitTokens, reportedCostUsd) nao quebram o path',
    () => {
      // TODO: Verificar que campos novos retornam valores defaults corretos:
      // apiRequests = roundCount, cacheHitTokens = undefined (0 acumulado),
      // reportedCostUsd = undefined (0 acumulado)
    },
  );
});
