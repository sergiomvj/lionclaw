/**
 * external-http.ts
 *
 * Shared helpers for the external (OpenAI-compatible HTTP) runtime path.
 * Moved here from harness-engine.ts to break the circular dependency:
 *   external-executor.ts -> harness-engine.ts -> agent-runtime/index.ts -> external-executor.ts
 *
 * Both external-executor.ts and harness-engine.ts import from here.
 * This module does NOT import from harness-engine, pipeline-engine, or security-audit-runner.
 */

import { createLogger } from '../logger';
import { ollamaChatWithTools } from '../ollama-client';
import { getSecret } from '../vault-registry';
import type { OllamaChatResult } from '../ollama-client';
import type { ExternalConfig, AgentConfig } from '../../../src/types';

const logger = createLogger('external-http');

/**
 * Resolve os headers de autenticacao para um provider externo a partir do Vault.
 * Chamado no inicio de CADA sprint (nao cacheado), conforme SPEC secao 3.5.2.
 * Spread order: extraHeaders primeiro, Authorization por ultimo para garantir
 * que extraHeaders nunca sobrescreva a Authorization resolvida (SPEC secao 6.2).
 */
export async function resolveExternalAuth(
  config: ExternalConfig,
): Promise<Record<string, string>> {
  const apiKey = await getSecret(config.apiKeyRef);
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

/**
 * Wrapper com retry para HTTP 429 (Rate Limit) e HTTP 5xx (Gateway/Service errors).
 * Aplica-se APENAS ao path external. Cloud e local nao usam.
 *
 * Comportamento:
 *  - 429: usa Retry-After header quando presente, fallback de 30s.
 *  - 5xx (502/503/504): backoff exponencial (2s, 4s, 8s, 16s, capped em 30s).
 *  - Outros erros: relanca imediatamente sem retry.
 *  - Max 5 retries (total de 6 tentativas).
 */
export async function ollamaChatWithRetry(
  ...args: Parameters<typeof ollamaChatWithTools>
): Promise<OllamaChatResult> {
  const MAX_RETRIES = 5;
  const DEFAULT_429_WAIT_MS = 30_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ollamaChatWithTools(...args);
    } catch (err) {
      const errMsg = (err as Error).message || '';
      const is429 = errMsg.includes('HTTP 429');
      const is5xx = /HTTP 5\d\d/.test(errMsg);

      if ((!is429 && !is5xx) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitMs: number;
      if (is429) {
        const retryAfterMatch = errMsg.match(/Retry-After:\s*(\d+)/i);
        waitMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1000
          : DEFAULT_429_WAIT_MS;
      } else {
        // Exponential backoff for 5xx: 2s, 4s, 8s, 16s, 30s.
        waitMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
      }

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          waitMs,
          statusType: is429 ? '429' : '5xx',
          model: args[1],
          errPreview: errMsg.substring(0, 200),
        },
        'External request failed, retrying',
      );

      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  throw new Error('Retry exhausted');
}

/**
 * Computa a chave de pricing correta para o provider externo.
 * OpenRouter usa prefixo "or:" para diferenciar dos precos OpenAI direto.
 * SPEC secao 3.5.3.
 */
export function computePricingKey(extCfg: ExternalConfig): string {
  if (extCfg.provider === 'openrouter') return `or:${extCfg.model}`;
  return extCfg.model;
}

/**
 * Mapeia os campos de effort/thinking do agente para params de reasoning
 * especificos do provider externo. Os campos sao Claude SDK-specific e precisam
 * de traducao por provider/modelo. SPEC secao 3.10.3.
 */
export function mapReasoningParams(
  effort: AgentConfig['effort'] | undefined,
  thinking: AgentConfig['thinking'] | undefined,
  _thinkingBudget: number | undefined,
  provider: ExternalConfig['provider'],
  model: string,
): Partial<Record<string, unknown>> {
  // Clamp 'max' to 'high': OpenAI and OpenRouter only accept 'low' | 'medium' | 'high'
  const reasoningEffort = effort === 'max' ? 'high' : (effort ?? 'medium');

  // OpenAI GPT-5.5, o-series: reasoning_effort
  if (provider === 'openai' && (model.startsWith('gpt-5.5') || model.startsWith('o'))) {
    if (thinking === 'disabled') return {};
    return { reasoning_effort: reasoningEffort };
  }

  // OpenRouter: passa adiante para o upstream baseado no slug do modelo
  if (provider === 'openrouter') {
    // GPT-5.5 via OpenRouter
    if (model.startsWith('openai/gpt-5')) {
      return thinking === 'disabled' ? {} : { reasoning_effort: reasoningEffort };
    }
    // Qwen 3.6 thinking mode
    if (model.startsWith('qwen/qwen3.6') && thinking !== 'disabled') {
      return { thinking: { type: 'enabled' } };
    }
    // Kimi K2 Thinking e DeepSeek-Reasoner: reasoning embutido no slug, sem param adicional
  }

  return {}; // outros providers/modelos: ignora
}

/**
 * Detecta erros de contexto excedido em mensagens de erro de multiplos providers.
 * Usado no catch do bloco external para emitir mensagem clara ao usuario.
 * SPEC secao 5.5.
 */
export function isContextLengthError(errorMessage: string): boolean {
  return /context.*(length|limit|exceed|too long)/i.test(errorMessage)
    || /maximum.*tokens/i.test(errorMessage)
    || /token.*limit.*exceeded/i.test(errorMessage)
    || errorMessage.includes('context_length_exceeded');
}
