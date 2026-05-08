/**
 * provider-presets.test.ts
 *
 * Testa PROVIDER_PRESETS e MODEL_CATALOG para garantir que os valores
 * batem com a SPEC (secao 3.1 + 3.2).
 *
 * SPEC secao 7.1 (funcionalidades novas: provider-presets).
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, MODEL_CATALOG } from '../provider-presets';
import type { CatalogedModel } from '../provider-presets';

// ---------------------------------------------------------------------------
// 1. PROVIDER_PRESETS
// ---------------------------------------------------------------------------

describe('PROVIDER_PRESETS: openrouter', () => {
  it('tem entry para openrouter', () => {
    expect(PROVIDER_PRESETS['openrouter']).toBeDefined();
  });

  it('openrouter.label = "OpenRouter"', () => {
    expect(PROVIDER_PRESETS['openrouter'].label).toBe('OpenRouter');
  });

  it('openrouter.baseUrl correto', () => {
    expect(PROVIDER_PRESETS['openrouter'].baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('openrouter.vaultKey = "HARNESS_OPENROUTER_KEY"', () => {
    expect(PROVIDER_PRESETS['openrouter'].vaultKey).toBe('HARNESS_OPENROUTER_KEY');
  });

  it('openrouter.requiresApiKey = true', () => {
    expect(PROVIDER_PRESETS['openrouter'].requiresApiKey).toBe(true);
  });

  it('openrouter.defaultModel e definido', () => {
    expect(PROVIDER_PRESETS['openrouter'].defaultModel).toBeTruthy();
  });

  it('openrouter.extraHeaders tem HTTP-Referer e X-Title', () => {
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders).toBeDefined();
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders?.['HTTP-Referer']).toBe('https://lionclaw.app');
    expect(PROVIDER_PRESETS['openrouter'].extraHeaders?.['X-Title']).toBe('LionClaw');
  });

  it('openrouter.testEndpoint esta definido', () => {
    expect(PROVIDER_PRESETS['openrouter'].testEndpoint).toBeTruthy();
  });
});

describe('PROVIDER_PRESETS: openai', () => {
  it('tem entry para openai', () => {
    expect(PROVIDER_PRESETS['openai']).toBeDefined();
  });

  it('openai.label = "OpenAI"', () => {
    expect(PROVIDER_PRESETS['openai'].label).toBe('OpenAI');
  });

  it('openai.baseUrl correto', () => {
    expect(PROVIDER_PRESETS['openai'].baseUrl).toBe('https://api.openai.com/v1');
  });

  it('openai.vaultKey = "HARNESS_OPENAI_KEY"', () => {
    expect(PROVIDER_PRESETS['openai'].vaultKey).toBe('HARNESS_OPENAI_KEY');
  });

  it('openai.requiresApiKey = true', () => {
    expect(PROVIDER_PRESETS['openai'].requiresApiKey).toBe(true);
  });

  it('openai.defaultModel = "gpt-5.5"', () => {
    expect(PROVIDER_PRESETS['openai'].defaultModel).toBe('gpt-5.5');
  });
});

describe('PROVIDER_PRESETS: Custom (openai-compatible) NAO esta no preset', () => {
  it('nao tem entry "openai-compatible" em PROVIDER_PRESETS', () => {
    expect(PROVIDER_PRESETS['openai-compatible']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. MODEL_CATALOG: OpenAI
// ---------------------------------------------------------------------------

describe('MODEL_CATALOG: openai', () => {
  it('tem 2 modelos OpenAI curados', () => {
    expect(MODEL_CATALOG['openai']).toHaveLength(2);
  });

  it('contem gpt-5.5', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model).toBeDefined();
  });

  it('contem gpt-5.5-pro', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5-pro');
    expect(model).toBeDefined();
  });

  it('gpt-5.5: supportsTools = true', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.supportsTools).toBe(true);
  });

  it('gpt-5.5: contextWindow = 1_000_000', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.contextWindow).toBe(1_000_000);
  });

  it('gpt-5.5: pricingKey = "gpt-5.5"', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5');
    expect(model?.pricingKey).toBe('gpt-5.5');
  });

  it('gpt-5.5-pro: contextWindow = 1_000_000', () => {
    const model = MODEL_CATALOG['openai'].find((m: CatalogedModel) => m.id === 'gpt-5.5-pro');
    expect(model?.contextWindow).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 3. MODEL_CATALOG: OpenRouter (8 modelos curados)
// ---------------------------------------------------------------------------

describe('MODEL_CATALOG: openrouter', () => {
  it('tem exatamente 8 modelos OpenRouter curados', () => {
    expect(MODEL_CATALOG['openrouter']).toHaveLength(8);
  });

  const OPENROUTER_MODELS: Array<{ id: string; contextWindow: number; pricingKey: string }> = [
    { id: 'deepseek/deepseek-v4-pro',    contextWindow: 1_000_000, pricingKey: 'or:deepseek/deepseek-v4-pro' },
    { id: 'deepseek/deepseek-v4-flash',  contextWindow: 1_000_000, pricingKey: 'or:deepseek/deepseek-v4-flash' },
    { id: 'moonshotai/kimi-k2.6',        contextWindow: 256_000,   pricingKey: 'or:moonshotai/kimi-k2.6' },
    { id: 'moonshotai/kimi-k2-thinking', contextWindow: 256_000,   pricingKey: 'or:moonshotai/kimi-k2-thinking' },
    { id: 'qwen/qwen3.6-max-preview',    contextWindow: 262_000,   pricingKey: 'or:qwen/qwen3.6-max-preview' },
    { id: 'qwen/qwen3.6-plus',           contextWindow: 262_000,   pricingKey: 'or:qwen/qwen3.6-plus' },
    { id: 'minimax/minimax-m2.7',        contextWindow: 196_608,   pricingKey: 'or:minimax/minimax-m2.7' },
    { id: 'minimax/minimax-m1',          contextWindow: 1_000_000, pricingKey: 'or:minimax/minimax-m1' },
  ];

  for (const expected of OPENROUTER_MODELS) {
    it(`contem ${expected.id}`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model).toBeDefined();
    });

    it(`${expected.id}: contextWindow = ${expected.contextWindow}`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.contextWindow).toBe(expected.contextWindow);
    });

    it(`${expected.id}: pricingKey = "${expected.pricingKey}"`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.pricingKey).toBe(expected.pricingKey);
    });

    it(`${expected.id}: supportsTools = true`, () => {
      const model = MODEL_CATALOG['openrouter'].find((m: CatalogedModel) => m.id === expected.id);
      expect(model?.supportsTools).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Integridade geral do catalog
// ---------------------------------------------------------------------------

describe('MODEL_CATALOG: integridade geral', () => {
  it('total de modelos curados = 10 (2 OpenAI + 8 OpenRouter)', () => {
    const openaiCount = MODEL_CATALOG['openai']?.length ?? 0;
    const openrouterCount = MODEL_CATALOG['openrouter']?.length ?? 0;
    expect(openaiCount + openrouterCount).toBe(10);
  });

  it('todos os modelos tem id, label, pricingKey, supportsTools, contextWindow', () => {
    const allModels = [
      ...(MODEL_CATALOG['openai'] ?? []),
      ...(MODEL_CATALOG['openrouter'] ?? []),
    ];

    for (const model of allModels) {
      expect(model.id).toBeTruthy();
      expect(model.label).toBeTruthy();
      expect(model.pricingKey).toBeTruthy();
      expect(typeof model.supportsTools).toBe('boolean');
      expect(typeof model.contextWindow).toBe('number');
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it('modelos OpenRouter tem pricingKey com prefixo "or:"', () => {
    for (const model of MODEL_CATALOG['openrouter'] ?? []) {
      expect(model.pricingKey.startsWith('or:')).toBe(true);
    }
  });

  it('modelos OpenAI NAO tem pricingKey com prefixo "or:"', () => {
    for (const model of MODEL_CATALOG['openai'] ?? []) {
      expect(model.pricingKey.startsWith('or:')).toBe(false);
    }
  });
});
