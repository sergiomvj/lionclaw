const ANTHROPIC_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  'claude-sonnet-4': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-haiku-4-5': 'haiku',
  'claude-haiku-4': 'haiku',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4': 'opus',
  'sonnet': 'sonnet',
  'haiku': 'haiku',
  'opus': 'opus',
};

export function shortenModel(model: string | null | undefined): string {
  if (!model) return '';
  if (ANTHROPIC_ALIASES[model]) return ANTHROPIC_ALIASES[model];
  if (model.includes('/')) {
    const parts = model.split('/');
    const last = parts[parts.length - 1];
    return ANTHROPIC_ALIASES[last] ?? last;
  }
  return model;
}

const EXTERNAL_DISPLAY: Record<string, { name: string; ctx: string }> = {
  // DeepSeek
  'deepseek/deepseek-r4': { name: 'DeepSeek R4', ctx: '1M' },
  'deepseek/deepseek-r1': { name: 'DeepSeek R1', ctx: '128k' },
  'deepseek/deepseek-chat': { name: 'DeepSeek Chat', ctx: '128k' },
  'deepseek/deepseek-v3': { name: 'DeepSeek V3', ctx: '128k' },

  // MiniMax
  'minimax/minimax-m2.7': { name: 'MiniMax 2.7', ctx: '196k' },
  'minimax/minimax-m2': { name: 'MiniMax 2', ctx: '196k' },
  'minimax/minimax-text-01': { name: 'MiniMax Text 01', ctx: '4M' },

  // Qwen
  'qwen/qwen3.6-max-preview': { name: 'Qwen 3.6 Max', ctx: '200k' },
  'qwen/qwen3-max': { name: 'Qwen 3 Max', ctx: '128k' },
  'qwen/qwen-2.5-72b-instruct': { name: 'Qwen 2.5 72B', ctx: '128k' },

  // Kimi (Moonshot)
  'moonshotai/kimi-k2': { name: 'Kimi K2', ctx: '200k' },
  'moonshotai/kimi-k1.5': { name: 'Kimi K1.5', ctx: '128k' },

  // GLM
  'thudm/glm-4.6': { name: 'GLM 4.6', ctx: '200k' },

  // Anthropic via OpenRouter
  'anthropic/claude-sonnet-4-5': { name: 'Sonnet 4.5', ctx: '200k' },
  'anthropic/claude-sonnet-4-6': { name: 'Sonnet 4.6', ctx: '200k' },
  'anthropic/claude-haiku-4-5': { name: 'Haiku 4.5', ctx: '200k' },
  'anthropic/claude-opus-4-7': { name: 'Opus 4.7', ctx: '200k' },
};

/**
 * Returns a friendly display label for external/openrouter models.
 * Format: "Name CTX" (ex: "DeepSeek R4 1M", "MiniMax 2.7 196k").
 * Falls back to shortenModel() for unknown slugs.
 */
export function displayModelWithContext(model: string | null | undefined): string {
  if (!model) return '';
  const meta = EXTERNAL_DISPLAY[model];
  if (meta) return `${meta.name} ${meta.ctx}`;
  return shortenModel(model);
}
