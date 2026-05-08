// Precos por 1M tokens (em USD)
// Fonte: https://www.anthropic.com/pricing
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  // Claude (Anthropic SDK): valores INTOCADOS
  'sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'opus': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'haiku': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheCreation: 1.25 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheCreation: 1.25 },
  // legacy (deprecado, retire em Jun/2026)
  'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-sonnet-4-0-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-opus-4-0-20250514': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheCreation: 1.00 },

  // OpenAI direto (10 curated models, Sprint 2)
  'gpt-5.5':       { input: 5.00,  output: 30.00,  cacheRead: 0.50,   cacheCreation: 0 },
  'gpt-5.5-pro':   { input: 30.00, output: 180.00, cacheRead: 3.00,   cacheCreation: 0 },
  // Codex CLI models — fonte: developers.openai.com/api/docs/pricing (Maio/2026)
  // Cached input = 10% do input em toda familia gpt-5.x.
  'gpt-5.4':       { input: 2.50,  output: 15.00,  cacheRead: 0.25,   cacheCreation: 0 },
  'gpt-5.4-mini':  { input: 0.75,  output: 4.50,   cacheRead: 0.075,  cacheCreation: 0 },
  'gpt-5.3-codex': { input: 1.75,  output: 14.00,  cacheRead: 0.175,  cacheCreation: 0 },
  'gpt-5.2':       { input: 1.75,  output: 14.00,  cacheRead: 0.175,  cacheCreation: 0 },

  // OpenRouter curated models (prefixo "or:")
  'or:deepseek/deepseek-v4-pro':    { input: 0.435,  output: 0.87,  cacheRead: 0.10,  cacheCreation: 0 },
  'or:deepseek/deepseek-v4-flash':  { input: 0.14,   output: 0.28,  cacheRead: 0.04,  cacheCreation: 0 },
  'or:moonshotai/kimi-k2.6':        { input: 0.7448, output: 4.655, cacheRead: 0,     cacheCreation: 0 },
  'or:moonshotai/kimi-k2-thinking': { input: 0.60,   output: 2.50,  cacheRead: 0,     cacheCreation: 0 },
  'or:qwen/qwen3.6-max-preview':    { input: 1.04,   output: 6.24,  cacheRead: 0,     cacheCreation: 0 },
  'or:qwen/qwen3.6-plus':           { input: 0.325,  output: 1.95,  cacheRead: 0,     cacheCreation: 0 },
  'or:minimax/minimax-m2.7':        { input: 0.30,   output: 1.20,  cacheRead: 0.059, cacheCreation: 0 },
  'or:minimax/minimax-m2.5':        { input: 0.15,   output: 1.15,  cacheRead: 0,     cacheCreation: 0 },
  'or:minimax/minimax-m1':          { input: 0.40,   output: 2.20,  cacheRead: 0,     cacheCreation: 0 },
  'or:z-ai/glm-4.7':                { input: 0.38,   output: 1.74,  cacheRead: 0,     cacheCreation: 0 },
  'or:z-ai/glm-4.7-flash':          { input: 0.06,   output: 0.40,  cacheRead: 0,     cacheCreation: 0 },

  // Defensive aliases: Claude via OpenRouter (rare but possible)
  'or:anthropic/claude-sonnet-4-5': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  'or:anthropic/claude-opus-4':     { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  'or:anthropic/claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheCreation: 1.25 },
};

const WEB_SEARCH_COST_PER_REQUEST = 0.01; // $10 per 1,000 searches

/**
 * Compute cost in USD for a model call given token usage.
 *
 * **Funcao canonica de calculo de custo do LionClaw.**
 *
 * **Prefira `result.metrics.costUsd` retornado pelo `executeAgent` quando o
 * fluxo passa pelos executors unificados.** O `cloud-executor.ts` (e demais
 * executors) ja chama esta funcao internamente e expoe o valor pronto em
 * `result.metrics.costUsd`. Recalcular do lado do caller causa double-count
 * (S0.4 corrigiu esse bug no planner regen e S1.1 alinhou o enrich helper).
 *
 * Excecoes legitimas que continuam chamando `calculateCost` diretamente
 * (auditadas em S1.3 e mantidas conscientemente):
 * - `orchestrator.ts` -> chat usa `query()` direto fora do executor unificado
 *   (decisao D5/D6 da SPEC: chat tem fluxo proprio).
 * - `harness-engine.ts` paths local/external -> `ollamaChatWithTools` /
 *   `ollamaChatWithRetry` retornam tokens crus (sem costUsd embutido).
 * - `harness-engine.ts` paths cloud direct (planner/coder/evaluator) -> ainda
 *   usam `query()` + `processAgentStream` direto, sem passar pelo
 *   `executeAgent`. Sprint futura migra esses callsites para o executor
 *   unificado e ai sim eles passam a ler `result.metrics.costUsd`.
 * - Pipeline phases que agregam custo de varias chamadas separadas.
 *
 * @param model - Identificador do modelo (ex: 'claude-sonnet-4-6', 'or:z-ai/glm-4.7')
 * @param inputTokens - Tokens de input totais (incluindo cache; a funcao subtrai)
 * @param outputTokens - Tokens de output
 * @param cacheReadTokens - Tokens lidos do cache (opcional)
 * @param cacheCreationTokens - Tokens gravados no cache (opcional)
 * @param webSearchRequests - Numero de chamadas a web_search (opcional)
 * @returns Custo em USD arredondado a 6 casas decimais
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
  webSearchRequests?: number,
): number {
  const normalizedModel = model.toLowerCase();

  let pricing = MODEL_PRICING[normalizedModel];

  if (!pricing) {
    if (normalizedModel.includes('opus')) {
      pricing = MODEL_PRICING['opus'];
    } else if (normalizedModel.includes('haiku')) {
      pricing = MODEL_PRICING['haiku'];
    } else if (normalizedModel.includes('sonnet') || normalizedModel.includes('claude')) {
      pricing = MODEL_PRICING['sonnet'];
    } else {
      // Fallback final: zero cost for unknown non-Claude models.
      // The UI uses hasKnownPricing() to show "Custo nao estimado" in this case.
      pricing = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    }
  }

  let inputCost: number;
  if (cacheReadTokens !== undefined || cacheCreationTokens !== undefined) {
    const pureInput = inputTokens - (cacheReadTokens || 0) - (cacheCreationTokens || 0);
    inputCost = (pureInput / 1_000_000) * pricing.input
      + ((cacheReadTokens || 0) / 1_000_000) * pricing.cacheRead
      + ((cacheCreationTokens || 0) / 1_000_000) * pricing.cacheCreation;
  } else {
    inputCost = (inputTokens / 1_000_000) * pricing.input;
  }

  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const webCost = (webSearchRequests || 0) * WEB_SEARCH_COST_PER_REQUEST;

  return Math.round((inputCost + outputCost + webCost) * 1_000_000) / 1_000_000;
}

/**
 * Returns true when the model has a known pricing entry or can be matched via
 * Claude keyword fallback (opus / haiku / sonnet / claude).
 * The UI uses this to decide between showing a formatted cost or "Custo nao estimado".
 */
export function hasKnownPricing(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  if (MODEL_PRICING[normalizedModel]) return true;
  if (
    normalizedModel.includes('opus') ||
    normalizedModel.includes('haiku') ||
    normalizedModel.includes('sonnet') ||
    normalizedModel.includes('claude')
  ) {
    return true;
  }
  return false;
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}
