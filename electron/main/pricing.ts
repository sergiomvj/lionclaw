// Precos por 1M tokens (em USD)
// Fonte: https://www.anthropic.com/pricing
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
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
};

const WEB_SEARCH_COST_PER_REQUEST = 0.01; // $10 per 1,000 searches

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
    } else {
      pricing = MODEL_PRICING['sonnet'];
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
