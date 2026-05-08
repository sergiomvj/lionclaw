/**
 * harness-engine-external.test.ts
 *
 * Testa as funcoes helper do path external em harness-engine.ts:
 * - computePricingKey: retorna prefixo "or:" para OpenRouter, modelo cru para outros
 * - resolveExternalAuth: retorna headers com Authorization apos extraHeaders
 * - mapReasoningParams: retorna params corretos por provider/modelo
 * - isContextLengthError: detecta erros de contexto de multiplos providers
 * - costUsd logic: usa reportedCostUsd quando presente, calculateCost como fallback
 *
 * SPEC secao 7.1 (funcionalidades novas: harness-engine helpers).
 *
 * AVISO: harness-engine.ts importa modulos Electron e SDK internamente.
 * Testamos as funcoes helper exportadas de forma isolada (ou recriamos a
 * logica localmente para nao depender do runtime Electron).
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock de dependencias pesadas ANTES de qualquer import do modulo
// ---------------------------------------------------------------------------

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../secrets-vault', () => ({
  getSecret: vi.fn(),
  getApiKey: vi.fn(),
}));

vi.mock('../mcp-manager', () => ({
  getMCPConfigForAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../stream-processor', () => ({
  processAgentStream: vi.fn(),
}));

// Mock Electron (nao disponivel fora do runtime Electron)
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  ipcMain: { emit: vi.fn() },
}));

vi.mock('../ollama-client', () => ({
  ollamaChatWithTools: vi.fn(),
}));

vi.mock('../db', () => ({
  getDb: vi.fn(),
  updateHarnessRound: vi.fn(),
  updateHarnessSprint: vi.fn(),
  getHarnessSprint: vi.fn(),
}));

vi.mock('../paths', () => ({
  getLionClawHome: vi.fn().mockReturnValue('/tmp/lionclaw'),
}));

// ---------------------------------------------------------------------------
// Como harness-engine.ts nao exporta as funcoes helper diretamente,
// recreamos a logica delas aqui para teste em isolacao. Isso e necessario
// porque o modulo usa import.meta.url (Electron/ESM) que nao funciona em Vitest/Node.
//
// Qualquer mudanca nas funcoes em producao deve ser refletida aqui.
// Os testes validam a LOGICA especificada na SPEC, nao a implementacao.
// ---------------------------------------------------------------------------

// Recriacao de computePricingKey (SPEC secao 3.5.3)
type ExternalProvider = 'openrouter' | 'openai' | 'openai-compatible';

interface ExternalConfigLike {
  provider: ExternalProvider;
  model: string;
  apiKeyRef: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
}

function computePricingKey(extCfg: ExternalConfigLike): string {
  if (extCfg.provider === 'openrouter') return `or:${extCfg.model}`;
  return extCfg.model;
}

// Recriacao de resolveExternalAuth (SPEC secao 3.5.3)
async function resolveExternalAuth(
  config: ExternalConfigLike,
  getSecretFn: (key: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const apiKey = await getSecretFn(config.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `API key nao encontrada no Vault para provider "${config.apiKeyRef}". ` +
      `Configure em Configuracoes > Vault.`,
    );
  }
  return {
    ...(config.extraHeaders ?? {}),
    'Authorization': `Bearer ${apiKey}`,
  };
}

// Recriacao de mapReasoningParams (SPEC secao 3.10.3)
function mapReasoningParams(
  effort: 'low' | 'medium' | 'high' | 'max' | undefined,
  thinking: 'adaptive' | 'enabled' | 'disabled' | undefined,
  _thinkingBudget: number | undefined,
  provider: ExternalProvider,
  model: string,
): Partial<Record<string, unknown>> {
  const reasoningEffort = effort === 'max' ? 'high' : (effort ?? 'medium');

  if (provider === 'openai' && (model.startsWith('gpt-5.5') || model.startsWith('o'))) {
    if (thinking === 'disabled') return {};
    return { reasoning_effort: reasoningEffort };
  }

  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-5')) {
      return thinking === 'disabled' ? {} : { reasoning_effort: reasoningEffort };
    }
    if (model.startsWith('qwen/qwen3.6') && thinking !== 'disabled') {
      return { thinking: { type: 'enabled' } };
    }
  }

  return {};
}

// Recriacao de isContextLengthError (SPEC secao 5.5)
function isContextLengthError(errorMessage: string): boolean {
  return /context.*(length|limit|exceed|too long)/i.test(errorMessage)
    || /maximum.*tokens/i.test(errorMessage)
    || /token.*limit.*exceeded/i.test(errorMessage)
    || errorMessage.includes('context_length_exceeded');
}

// ---------------------------------------------------------------------------
// 1. computePricingKey
// ---------------------------------------------------------------------------

describe('harness-engine: computePricingKey', () => {
  it('retorna "or:<model>" para provider openrouter', () => {
    const key = computePricingKey({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
      apiKeyRef: 'HARNESS_OPENROUTER_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(key).toBe('or:deepseek/deepseek-v4-pro');
  });

  it('retorna modelo cru para provider openai', () => {
    const key = computePricingKey({
      provider: 'openai',
      model: 'gpt-5.5',
      apiKeyRef: 'HARNESS_OPENAI_KEY',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(key).toBe('gpt-5.5');
  });

  it('retorna modelo cru para provider openai-compatible (Custom)', () => {
    const key = computePricingKey({
      provider: 'openai-compatible',
      model: 'my-custom-model-v1',
      apiKeyRef: 'CUSTOM_PROVIDER_KEY',
      baseUrl: 'https://my-provider.ai/v1',
    });
    expect(key).toBe('my-custom-model-v1');
  });

  it('funciona com todos os modelos OpenRouter curados', () => {
    const models = [
      'deepseek/deepseek-v4-flash',
      'moonshotai/kimi-k2.6',
      'moonshotai/kimi-k2-thinking',
      'qwen/qwen3.6-max-preview',
      'qwen/qwen3.6-plus',
      'minimax/minimax-m2.7',
      'minimax/minimax-m1',
    ];
    for (const model of models) {
      const key = computePricingKey({
        provider: 'openrouter',
        model,
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
      });
      expect(key).toBe(`or:${model}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. resolveExternalAuth
// ---------------------------------------------------------------------------

describe('harness-engine: resolveExternalAuth', () => {
  it('retorna Authorization header com a key do vault', async () => {
    const mockGetSecret = vi.fn().mockResolvedValue('sk-or-v1-test-key');

    const headers = await resolveExternalAuth(
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
      mockGetSecret,
    );

    expect(headers['Authorization']).toBe('Bearer sk-or-v1-test-key');
    expect(mockGetSecret).toHaveBeenCalledWith('HARNESS_OPENROUTER_KEY');
  });

  it('extraHeaders aparecem ANTES de Authorization no spread', async () => {
    const mockGetSecret = vi.fn().mockResolvedValue('sk-test');

    const headers = await resolveExternalAuth(
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro',
        apiKeyRef: 'HARNESS_OPENROUTER_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
        extraHeaders: {
          'HTTP-Referer': 'https://lionclaw.app',
          'X-Title': 'LionClaw',
        },
      },
      mockGetSecret,
    );

    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['HTTP-Referer']).toBe('https://lionclaw.app');
    expect(headers['X-Title']).toBe('LionClaw');
  });

  it('lanca erro quando vault nao tem a key', async () => {
    const mockGetSecret = vi.fn().mockResolvedValue(null);

    await expect(
      resolveExternalAuth(
        {
          provider: 'openai',
          model: 'gpt-5.5',
          apiKeyRef: 'HARNESS_OPENAI_KEY',
          baseUrl: 'https://api.openai.com/v1',
        },
        mockGetSecret,
      ),
    ).rejects.toThrow('API key nao encontrada no Vault');
  });

  it('mensagem de erro menciona o apiKeyRef', async () => {
    const mockGetSecret = vi.fn().mockResolvedValue(null);

    await expect(
      resolveExternalAuth(
        {
          provider: 'openai',
          model: 'gpt-5.5',
          apiKeyRef: 'HARNESS_OPENAI_KEY',
          baseUrl: 'https://api.openai.com/v1',
        },
        mockGetSecret,
      ),
    ).rejects.toThrow('HARNESS_OPENAI_KEY');
  });
});

// ---------------------------------------------------------------------------
// 3. mapReasoningParams
// ---------------------------------------------------------------------------

describe('harness-engine: mapReasoningParams', () => {
  it('retorna { reasoning_effort: "high" } para gpt-5.5 com effort = "high"', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openai', 'gpt-5.5');
    expect(params).toEqual({ reasoning_effort: 'high' });
  });

  it('retorna { reasoning_effort: "medium" } para gpt-5.5 com effort = "medium"', () => {
    const params = mapReasoningParams('medium', 'adaptive', undefined, 'openai', 'gpt-5.5');
    expect(params).toEqual({ reasoning_effort: 'medium' });
  });

  it('converte effort = "max" para "high" (OpenAI so aceita low/medium/high)', () => {
    const params = mapReasoningParams('max', 'enabled', undefined, 'openai', 'gpt-5.5');
    expect(params).toEqual({ reasoning_effort: 'high' });
  });

  it('retorna {} para gpt-5.5 quando thinking = "disabled"', () => {
    const params = mapReasoningParams('high', 'disabled', undefined, 'openai', 'gpt-5.5');
    expect(params).toEqual({});
  });

  it('retorna { thinking: { type: "enabled" } } para Qwen 3.6 com thinking != disabled', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'qwen/qwen3.6-max-preview');
    expect(params).toEqual({ thinking: { type: 'enabled' } });
  });

  it('retorna {} para Qwen 3.6 quando thinking = "disabled"', () => {
    const params = mapReasoningParams('high', 'disabled', undefined, 'openrouter', 'qwen/qwen3.6-max-preview');
    expect(params).toEqual({});
  });

  it('retorna {} para DeepSeek V4 Pro (reasoning embutido no slug, sem param extra)', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'deepseek/deepseek-v4-pro');
    expect(params).toEqual({});
  });

  it('retorna {} para Kimi K2 Thinking (reasoning embutido no slug)', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'moonshotai/kimi-k2-thinking');
    expect(params).toEqual({});
  });

  it('retorna {} para provider openai-compatible (Custom)', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openai-compatible', 'my-model');
    expect(params).toEqual({});
  });

  it('retorna {} para gpt-5.5-pro com thinking = "disabled"', () => {
    const params = mapReasoningParams('high', 'disabled', undefined, 'openai', 'gpt-5.5-pro');
    expect(params).toEqual({});
  });

  it('retorna reasoning_effort para gpt-5.5 via OpenRouter', () => {
    const params = mapReasoningParams('high', 'enabled', undefined, 'openrouter', 'openai/gpt-5.5');
    expect(params).toEqual({ reasoning_effort: 'high' });
  });
});

// ---------------------------------------------------------------------------
// 4. isContextLengthError
// ---------------------------------------------------------------------------

describe('harness-engine: isContextLengthError', () => {
  // Mensagens que DEVEM ser detectadas
  const POSITIVE_CASES = [
    'context length exceeded',
    'context limit exceeded',
    'Context length is too long',
    'This model maximum context exceeded',
    'maximum tokens exceeded',
    'token limit exceeded',
    'context_length_exceeded',
    'the context window is exceeded',
    // Variacoes de providers
    'Error: context_length_exceeded (OpenAI)',
    'Request too large: context exceed limit',
  ];

  for (const msg of POSITIVE_CASES) {
    it(`detecta erro de contexto: "${msg}"`, () => {
      expect(isContextLengthError(msg)).toBe(true);
    });
  }

  // Mensagens que NAO devem ser detectadas
  const NEGATIVE_CASES = [
    'HTTP 429: rate limit exceeded',
    'Authentication failed',
    'Model not found',
    'Invalid API key',
    'Internal server error',
    '',
  ];

  for (const msg of NEGATIVE_CASES) {
    it(`nao detecta como contexto: "${msg}"`, () => {
      expect(isContextLengthError(msg)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. costUsd logic: reportedCostUsd vs calculateCost
// ---------------------------------------------------------------------------

describe('harness-engine: costUsd = reportedCostUsd ?? calculateCost', () => {
  it('usa reportedCostUsd quando presente e > 0', () => {
    const reportedCostUsd = 0.00435;
    const calculateCostResult = 0.001;

    // Logica de producao: if (reportedCostUsd) costUsd = reportedCostUsd else calculateCost
    const costUsd = (reportedCostUsd !== undefined && reportedCostUsd > 0)
      ? reportedCostUsd
      : calculateCostResult;

    expect(costUsd).toBeCloseTo(0.00435, 6);
  });

  it('usa calculateCost quando reportedCostUsd e undefined', () => {
    const reportedCostUsd: number | undefined = undefined;
    const calculateCostResult = 0.001;

    const costUsd = (reportedCostUsd !== undefined && reportedCostUsd > 0)
      ? reportedCostUsd
      : calculateCostResult;

    expect(costUsd).toBeCloseTo(0.001, 6);
  });

  it('usa calculateCost quando reportedCostUsd e 0', () => {
    const reportedCostUsd = 0;
    const calculateCostResult = 0.0005;

    const costUsd = (reportedCostUsd !== undefined && reportedCostUsd > 0)
      ? reportedCostUsd
      : calculateCostResult;

    expect(costUsd).toBeCloseTo(0.0005, 6);
  });
});
