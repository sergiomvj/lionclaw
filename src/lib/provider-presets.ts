// Provider presets and curated model catalog for external API providers.
// All data lives here in source code (zero DB seeding required).
// Updated by shipping a new app version.

export const PROVIDER_PRESETS: Record<string, {
  label: string;
  baseUrl: string;
  modelsEndpoint: string;
  testEndpoint?: string;
  defaultModel: string;
  requiresApiKey: boolean;
  extraHeaders?: Record<string, string>;
  pricingUrl?: string;
  vaultKey: string;
}> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsEndpoint: '/models',
    testEndpoint: '/auth/key',
    defaultModel: 'deepseek/deepseek-v4-pro',
    requiresApiKey: true,
    extraHeaders: {
      'HTTP-Referer': 'https://lionclaw.app',
      'X-Title': 'LionClaw',
    },
    pricingUrl: 'https://openrouter.ai/models',
    vaultKey: 'HARNESS_OPENROUTER_KEY',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelsEndpoint: '/models',
    defaultModel: 'gpt-5.5',
    requiresApiKey: true,
    pricingUrl: 'https://openai.com/api/pricing/',
    vaultKey: 'HARNESS_OPENAI_KEY',
  },
};

// Custom (openai-compatible) is intentionally absent from PROVIDER_PRESETS
// because it depends entirely on user configuration.

export interface CatalogedModel {
  id: string;
  label: string;
  pricingKey: string;
  supportsTools: boolean;
  contextWindow: number;
  notes?: string;
}

// Label naming convention: `<Brand> <Variant> CTX <window>` — clean, no
// subjective qualifiers (no barato/caro/Frontier/etc). Only model identity
// and context window. Capabilities/quirks live in the `notes` field, surfaced
// as hover/help text rather than in the dropdown label.
export const MODEL_CATALOG: Record<string, CatalogedModel[]> = {
  openai: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5 CTX 1M',
      pricingKey: 'gpt-5.5',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Atencao: input >272k cobra 2x e output 1.5x pelo restante da sessao.',
    },
    {
      id: 'gpt-5.5-pro',
      label: 'GPT-5.5 Pro CTX 1M',
      pricingKey: 'gpt-5.5-pro',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Reasoning extra. Custo opus-level. Use apenas quando precisa qualidade maxima.',
    },
  ],
  openrouter: [
    // DeepSeek
    {
      id: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro CTX 1M',
      pricingKey: 'or:deepseek/deepseek-v4-pro',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Frontier custo-beneficio. Bom Coder default.',
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash CTX 1M',
      pricingKey: 'or:deepseek/deepseek-v4-flash',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Rapido e barato. Bom Evaluator.',
    },

    // Moonshot Kimi
    {
      id: 'moonshotai/kimi-k2.6',
      label: 'Kimi K2.6 CTX 256K',
      pricingKey: 'or:moonshotai/kimi-k2.6',
      supportsTools: true,
      contextWindow: 256_000,
      notes: 'Treinado pra long-horizon coding multi-agent.',
    },
    {
      id: 'moonshotai/kimi-k2-thinking',
      label: 'Kimi K2 Thinking CTX 256K',
      pricingKey: 'or:moonshotai/kimi-k2-thinking',
      supportsTools: true,
      contextWindow: 256_000,
      notes: 'Reasoning explicito. Bom Planner.',
    },

    // Qwen
    {
      id: 'qwen/qwen3.6-max-preview',
      label: 'Qwen 3.6 Max Preview CTX 262K',
      pricingKey: 'or:qwen/qwen3.6-max-preview',
      supportsTools: true,
      contextWindow: 262_000,
      notes: 'Thinking mode integrado + tool use forte.',
    },
    {
      id: 'qwen/qwen3.6-plus',
      label: 'Qwen 3.6 Plus CTX 262K',
      pricingKey: 'or:qwen/qwen3.6-plus',
      supportsTools: true,
      contextWindow: 262_000,
    },

    // MiniMax
    {
      id: 'minimax/minimax-m2.7',
      label: 'MiniMax M2.7 CTX 196K',
      pricingKey: 'or:minimax/minimax-m2.7',
      supportsTools: true,
      contextWindow: 196_608,
      notes: 'Excelente custo-beneficio. Forte em SWE-Pro e Terminal Bench. Cache nativo $0.059/1M.',
    },
    {
      id: 'minimax/minimax-m2.5',
      label: 'MiniMax M2.5 CTX 196K',
      pricingKey: 'or:minimax/minimax-m2.5',
      supportsTools: true,
      contextWindow: 196_608,
      notes: 'Output ate 131K tokens. Bom pra geracoes longas.',
    },
    {
      id: 'minimax/minimax-m1',
      label: 'MiniMax M1 CTX 1M',
      pricingKey: 'or:minimax/minimax-m1',
      supportsTools: true,
      contextWindow: 1_000_000,
      notes: 'Contexto enorme. Output limitado a 40k tokens.',
    },

    // Z.ai GLM
    {
      id: 'z-ai/glm-4.7',
      label: 'GLM 4.7 CTX 202K',
      pricingKey: 'or:z-ai/glm-4.7',
      supportsTools: true,
      contextWindow: 202_752,
      notes: 'Z.ai newest. Forte em agent frameworks e tool use.',
    },
    {
      id: 'z-ai/glm-4.7-flash',
      label: 'GLM 4.7 Flash CTX 202K',
      pricingKey: 'or:z-ai/glm-4.7-flash',
      supportsTools: true,
      contextWindow: 202_752,
      notes: '30B-class SOTA. $0.06 input. Output limitado a 16K tokens.',
    },
  ],
};

// Total: 13 curated models (2 OpenAI direct + 11 OpenRouter).
// For Custom (openai-compatible), there is no catalog: user types the slug manually.
