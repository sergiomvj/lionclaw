// Agent display helpers (used by the renderer: AgentForm, ContextWindowDisplay, etc.)
// Intentionally kept in src/lib so both renderer and main process can import via relative path.

import { MODEL_CATALOG } from './provider-presets';
import type { AgentConfig } from '../types/index';

/**
 * Resolves the context window (in tokens) for an agent configured with runtime 'external'.
 *
 * Rules (per SPEC section 3.9.1 item 6):
 * - Returns null for any non-external agent.
 * - For provider 'openai-compatible' (Custom): returns the manual value stored in
 *   externalConfig.contextWindow, or null if the user has not set one.
 * - For curated providers (openrouter, openai): looks up MODEL_CATALOG[provider]
 *   and returns the cataloged contextWindow, or null when the model is not in the catalog.
 */
export function resolveContextWindow(agent: AgentConfig): number | null {
  if (agent.runtime !== 'external' || !agent.externalConfig) return null;

  const { provider, model, contextWindow } = agent.externalConfig;

  // Custom provider: use the value the user typed manually.
  if (provider === 'openai-compatible') {
    return contextWindow ?? null;
  }

  // Curated providers (openrouter, openai): look up from MODEL_CATALOG.
  const catalogedModel = MODEL_CATALOG[provider]?.find(m => m.id === model);
  return catalogedModel?.contextWindow ?? null;
}

/**
 * Formats a context window token count into a human-readable string.
 *
 * Examples (per SPEC section 3.9.1 acceptance criteria):
 *   formatContextWindow(1_000_000) === '1M tokens'
 *   formatContextWindow(1_500_000) === '1.5M tokens'
 *   formatContextWindow(256_000)   === '256k tokens'
 *   formatContextWindow(196_608)   === '197k tokens'  (rounds to nearest k)
 *   formatContextWindow(512)       === '512 tokens'
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m === Math.floor(m) ? `${m}M tokens` : `${m.toFixed(1)}M tokens`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k tokens`;
  }
  return `${tokens} tokens`;
}
