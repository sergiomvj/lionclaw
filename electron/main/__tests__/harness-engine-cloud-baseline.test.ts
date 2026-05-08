/**
 * harness-engine-cloud-baseline.test.ts
 *
 * Suite de regressao: path cloud (Claude SDK) produz metricas identicas
 * antes e depois desta SPEC para o mesmo input controlado.
 *
 * STATUS: SKIPPED (todos os testes usam it.skip)
 *
 * POR QUE SKIPPED:
 * harness-engine.ts usa o Agent SDK (@anthropic-ai/claude-agent-sdk) de forma
 * acoplada, exigindo:
 *  1. Um banco SQLite real com schema completo (V1..V44) e dados reais de agentes.
 *  2. Uma ANTHROPIC_API_KEY valida (ou mock completo do SDK que simule streaming SSE).
 *  3. Um BrowserWindow Electron para emitir eventos IPC (window.webContents.send).
 *  4. Acesso ao filesystem para builds e paths do CLI do Agent SDK.
 *
 * Mockar o Agent SDK exige interceptar o transport SSE e simular o protocolo
 * de mensagens completo (message_start, content_block_start, content_block_delta,
 * tool_use, message_delta), o que esta fora do escopo desta sprint.
 *
 * O que cada teste deveria cobrir (documentado para sprint futura):
 *  - Criar sprint com planner/coder/evaluator em runtime 'cloud'
 *  - Capturar metricas (input/output/cache tokens, costUsd) com input controlado
 *  - Comparar metricas com baseline capturado em main branch antes da SPEC
 *  - Verificar que costSource = 'sdk_anthropic' e runtimeUsed = 'cloud'
 *  - Verificar que MCPs configurados no agente sao passados ao query()
 *
 * SPEC secao 0.3 + 7.1 (regressao path cloud).
 */

import { describe, it } from 'vitest';

describe('harness-engine: regressao path cloud', () => {
  it.skip(
    'planner cloud: metricas identicas ao baseline (input/output/cache tokens, costUsd)',
    () => {
      // TODO: Mockar Agent SDK + BrowserWindow + SQLite
      // Baseline: { inputTokens: X, outputTokens: Y, cacheTokens: Z, costUsd: W }
      // Apos mudancas: deve bater identico
    },
  );

  it.skip(
    'coder cloud: metricas identicas ao baseline apos sprint completo',
    () => {
      // TODO: mesma infra que acima
      // Verificar apiRequests >= 1 (SDK pode fazer multiplas chamadas internas)
    },
  );

  it.skip(
    'evaluator cloud: metricas identicas ao baseline',
    () => {
      // TODO: mesma infra que acima
    },
  );

  it.skip(
    'sprint completo cloud (planner->coder->evaluator): costSource = "sdk_anthropic" para todos os rounds',
    () => {
      // TODO: verificar que harness_rounds.cost_source = 'sdk_anthropic'
      // TODO: verificar que harness_rounds.runtime_used = 'cloud'
      // TODO: verificar que harness_rounds.provider_used = 'anthropic'
      // TODO: verificar que harness_rounds.model_used = agent.model
    },
  );

  it.skip(
    'sprint cloud nao ativa MCP servers do path external (mcpServers nunca passado ao SDK)',
    () => {
      // TODO: verificar que setupMCPsForSession nunca e chamado no path cloud
    },
  );
});
