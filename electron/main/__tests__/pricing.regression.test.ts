/**
 * pricing.regression.test.ts
 *
 * Suite de regressao obrigatoria para calculateCost e hasKnownPricing.
 * Garante que a pricing de modelos Claude permanece identica antes e apos
 * as mudancas desta SPEC. Este teste e CI gate de merge (SPEC secao 0.3).
 *
 * Todas as entradas de pricing sao snapshots capturados em main branch.
 */

import { describe, it, expect } from 'vitest';
import { calculateCost, hasKnownPricing, MODEL_PRICING } from '../pricing';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function costFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheCreation = 0,
): number {
  return calculateCost(model, inputTokens, outputTokens, cacheRead, cacheCreation);
}

// ---------------------------------------------------------------------------
// 1. Snapshot de pricing dos modelos Claude conhecidos
// ---------------------------------------------------------------------------

describe('pricing.regression: modelos Claude conhecidos', () => {
  // Testa cada modelo com 1M tokens de input e 1M de output para validar os rates
  const CLAUDE_SNAPSHOTS: Array<{
    model: string;
    inputRate: number;
    outputRate: number;
    cacheReadRate: number;
    cacheCreationRate: number;
  }> = [
    // Aliases curtos usados pelo SDK
    { model: 'sonnet',  inputRate: 3.00, outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'opus',    inputRate: 5.00, outputRate: 25.00, cacheReadRate: 0.50, cacheCreationRate: 6.25 },
    { model: 'haiku',   inputRate: 1.00, outputRate: 5.00,  cacheReadRate: 0.10, cacheCreationRate: 1.25 },
    // Modelos datados
    { model: 'claude-opus-4-7',           inputRate: 5.00,  outputRate: 25.00, cacheReadRate: 0.50, cacheCreationRate: 6.25 },
    { model: 'claude-sonnet-4-6',         inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-haiku-4-5-20251001', inputRate: 1.00,  outputRate: 5.00,  cacheReadRate: 0.10, cacheCreationRate: 1.25 },
    { model: 'claude-sonnet-4-5-20250514',inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-sonnet-4-0-20250514',inputRate: 3.00,  outputRate: 15.00, cacheReadRate: 0.30, cacheCreationRate: 3.75 },
    { model: 'claude-opus-4-0-20250514',  inputRate: 15.00, outputRate: 75.00, cacheReadRate: 1.50, cacheCreationRate: 18.75 },
    { model: 'claude-haiku-3-5-20241022', inputRate: 0.80,  outputRate: 4.00,  cacheReadRate: 0.08, cacheCreationRate: 1.00 },
  ];

  for (const snap of CLAUDE_SNAPSHOTS) {
    it(`${snap.model}: input rate = $${snap.inputRate}/1M`, () => {
      // 1M tokens de input puro (sem cache), 0 output
      const cost = costFor(snap.model, 1_000_000, 0, 0, 0);
      expect(cost).toBeCloseTo(snap.inputRate, 4);
    });

    it(`${snap.model}: output rate = $${snap.outputRate}/1M`, () => {
      // 0 input, 1M tokens de output
      const cost = costFor(snap.model, 0, 1_000_000, 0, 0);
      expect(cost).toBeCloseTo(snap.outputRate, 4);
    });

    it(`${snap.model}: cacheRead rate = $${snap.cacheReadRate}/1M`, () => {
      // 1M tokens de cache read, 0 output, 0 pureInput, 0 cacheCreation
      // Para testar a rate de cache read isolada:
      // pureInput = totalInput - cacheRead - cacheCreation = 1M - 1M - 0 = 0
      const cost = costFor(snap.model, 1_000_000, 0, 1_000_000, 0);
      expect(cost).toBeCloseTo(snap.cacheReadRate, 4);
    });

    it(`${snap.model}: cacheCreation rate = $${snap.cacheCreationRate}/1M`, () => {
      // pureInput = totalInput - cacheCreation = 1M - 1M = 0
      const cost = costFor(snap.model, 1_000_000, 0, 0, 1_000_000);
      expect(cost).toBeCloseTo(snap.cacheCreationRate, 4);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Regressao de fallback Claude por keyword
// ---------------------------------------------------------------------------

describe('pricing.regression: fallback Claude por keyword', () => {
  it('modelo com "opus" no slug retorna pricing opus', () => {
    const cost = costFor('claude-experimental-opus-2026-12-01', 1_000_000, 0);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('modelo com "haiku" no slug retorna pricing haiku', () => {
    const cost = costFor('claude-haiku-future-edition', 1_000_000, 0);
    expect(cost).toBeCloseTo(1.00, 4);
  });

  it('modelo com "sonnet" no slug retorna pricing sonnet', () => {
    const cost = costFor('claude-sonnet-future-edition', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.00, 4);
  });

  it('modelo com "claude" no slug (sem opus/haiku/sonnet) retorna pricing sonnet', () => {
    const cost = costFor('claude-experimental-2026-12-01', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.00, 4);
  });

  it('modelo completamente desconhecido retorna custo zero', () => {
    const cost = costFor('unknown-llm-model-xyz', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. hasKnownPricing
// ---------------------------------------------------------------------------

describe('hasKnownPricing', () => {
  it('retorna true para modelos Claude mapeados diretamente', () => {
    expect(hasKnownPricing('claude-sonnet-4-6')).toBe(true);
    expect(hasKnownPricing('claude-opus-4-7')).toBe(true);
    expect(hasKnownPricing('claude-haiku-4-5-20251001')).toBe(true);
    expect(hasKnownPricing('sonnet')).toBe(true);
    expect(hasKnownPricing('opus')).toBe(true);
    expect(hasKnownPricing('haiku')).toBe(true);
  });

  it('retorna true para Claude via fallback keyword', () => {
    expect(hasKnownPricing('claude-experimental-2026-12-01')).toBe(true);
    expect(hasKnownPricing('some-new-claude-opus-model')).toBe(true);
  });

  it('retorna false para modelo desconhecido sem keyword Claude', () => {
    expect(hasKnownPricing('unknown-model-xyz')).toBe(false);
    expect(hasKnownPricing('gpt-999')).toBe(false);
    expect(hasKnownPricing('llama-4-ultra')).toBe(false);
  });

  it('retorna true para OpenAI mapeados (gpt-5.5)', () => {
    expect(hasKnownPricing('gpt-5.5')).toBe(true);
    expect(hasKnownPricing('gpt-5.5-pro')).toBe(true);
  });

  it('retorna true para modelos OpenRouter com prefixo or:', () => {
    expect(hasKnownPricing('or:deepseek/deepseek-v4-pro')).toBe(true);
    expect(hasKnownPricing('or:moonshotai/kimi-k2.6')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Pricing dos modelos OpenRouter com prefixo "or:"
// ---------------------------------------------------------------------------

describe('pricing: modelos OpenRouter (prefixo or:)', () => {
  const OR_SNAPSHOTS: Array<{ key: string; input: number; output: number }> = [
    { key: 'or:deepseek/deepseek-v4-pro',    input: 0.435,  output: 0.87  },
    { key: 'or:deepseek/deepseek-v4-flash',  input: 0.14,   output: 0.28  },
    { key: 'or:moonshotai/kimi-k2.6',        input: 0.7448, output: 4.655 },
    { key: 'or:moonshotai/kimi-k2-thinking', input: 0.60,   output: 2.50  },
    { key: 'or:qwen/qwen3.6-max-preview',    input: 1.04,   output: 6.24  },
    { key: 'or:qwen/qwen3.6-plus',           input: 0.325,  output: 1.95  },
    { key: 'or:minimax/minimax-m2.7',        input: 0.30,   output: 1.20  },
    { key: 'or:minimax/minimax-m1',          input: 0.40,   output: 2.20  },
    // Aliases Claude via OpenRouter
    { key: 'or:anthropic/claude-sonnet-4-5', input: 3.00,  output: 15.00 },
    { key: 'or:anthropic/claude-opus-4',     input: 15.00, output: 75.00 },
    { key: 'or:anthropic/claude-haiku-4-5',  input: 1.00,  output: 5.00  },
  ];

  for (const snap of OR_SNAPSHOTS) {
    it(`${snap.key}: input = $${snap.input}/1M`, () => {
      const cost = calculateCost(snap.key, 1_000_000, 0);
      expect(cost).toBeCloseTo(snap.input, 4);
    });

    it(`${snap.key}: output = $${snap.output}/1M`, () => {
      const cost = calculateCost(snap.key, 0, 1_000_000);
      expect(cost).toBeCloseTo(snap.output, 4);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Pricing GPT-5.5 e GPT-5.5 Pro
// ---------------------------------------------------------------------------

describe('pricing: modelos OpenAI direto', () => {
  it('gpt-5.5: input = $5/1M', () => {
    expect(calculateCost('gpt-5.5', 1_000_000, 0)).toBeCloseTo(5.00, 4);
  });

  it('gpt-5.5: output = $30/1M', () => {
    expect(calculateCost('gpt-5.5', 0, 1_000_000)).toBeCloseTo(30.00, 4);
  });

  it('gpt-5.5: cacheRead = $0.50/1M', () => {
    expect(calculateCost('gpt-5.5', 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(0.50, 4);
  });

  it('gpt-5.5-pro: input = $30/1M', () => {
    expect(calculateCost('gpt-5.5-pro', 1_000_000, 0)).toBeCloseTo(30.00, 4);
  });

  it('gpt-5.5-pro: output = $180/1M', () => {
    expect(calculateCost('gpt-5.5-pro', 0, 1_000_000)).toBeCloseTo(180.00, 4);
  });
});

// ---------------------------------------------------------------------------
// 6. MODEL_PRICING esta completo e imutavel para modelos Claude
// ---------------------------------------------------------------------------

describe('pricing: integridade de MODEL_PRICING', () => {
  const REQUIRED_CLAUDE_KEYS = [
    'sonnet',
    'opus',
    'haiku',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250514',
    'claude-sonnet-4-0-20250514',
    'claude-opus-4-0-20250514',
    'claude-haiku-3-5-20241022',
  ];

  for (const key of REQUIRED_CLAUDE_KEYS) {
    it(`MODEL_PRICING tem entrada para "${key}"`, () => {
      expect(MODEL_PRICING[key]).toBeDefined();
      expect(typeof MODEL_PRICING[key].input).toBe('number');
      expect(typeof MODEL_PRICING[key].output).toBe('number');
      expect(MODEL_PRICING[key].input).toBeGreaterThan(0);
      expect(MODEL_PRICING[key].output).toBeGreaterThan(0);
    });
  }

  it('MODEL_PRICING tem entrada para gpt-5.5', () => {
    expect(MODEL_PRICING['gpt-5.5']).toBeDefined();
  });

  it('MODEL_PRICING tem entrada para gpt-5.5-pro', () => {
    expect(MODEL_PRICING['gpt-5.5-pro']).toBeDefined();
  });

  it('MODEL_PRICING tem 8 entradas OpenRouter com prefixo or:', () => {
    const orKeys = Object.keys(MODEL_PRICING).filter(k => k.startsWith('or:'));
    expect(orKeys.length).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// 7. Calculo composto (input puro + cache + output)
// ---------------------------------------------------------------------------

describe('pricing: calculo composto', () => {
  it('sonnet: 500k input puro + 200k cacheRead + 300k cacheCreation + 100k output', () => {
    // Usando os rates: input=$3, cacheRead=$0.30, cacheCreation=$3.75, output=$15
    // totalInput = 500k + 200k + 300k = 1M. pureInput = 1M - 200k - 300k = 500k
    // inputCost = (500/1000) * 3 + (200/1000) * 0.30 + (300/1000) * 3.75
    //           = 1.50 + 0.06 + 1.125 = 2.685
    // outputCost = (100/1000) * 15 = 1.50
    // total = 4.185
    const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 100_000, 200_000, 300_000);
    expect(cost).toBeCloseTo(4.185, 4);
  });

  it('calculo sem cache usa totalInput como pureInput', () => {
    // Sem cacheReadTokens/cacheCreationTokens => inputCost = inputTokens * rate
    const costWithCache = calculateCost('sonnet', 1_000_000, 0, 0, 0);
    const costWithoutCache = calculateCost('sonnet', 1_000_000, 0);
    // Com cache passado como 0, pureInput = totalInput - 0 - 0 = totalInput => igual
    expect(costWithCache).toBeCloseTo(costWithoutCache, 6);
  });
});
