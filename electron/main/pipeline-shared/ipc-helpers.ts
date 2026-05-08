import type { HarnessEngine } from '../harness-engine';
import type { PipelineEngine } from '../pipeline-engine';

/**
 * Helper para handlers IPC que precisam de HarnessEngine inicializado.
 * Reduz boilerplate "engine null? error" + try/catch repetido em cada handler.
 *
 * S7.2 da SPEC-refactor-pipelines.md.
 */
export async function withHarnessEngine<T>(
  getEngine: () => HarnessEngine | null,
  fn: (engine: HarnessEngine) => Promise<T> | T,
): Promise<T | { error: string }> {
  const engine = getEngine();
  if (!engine) return { error: 'HarnessEngine nao inicializado' };
  try {
    return await fn(engine);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Helper para handlers IPC que precisam de PipelineEngine inicializado.
 * Mesma logica de withHarnessEngine, especifico pro pipeline.
 */
export async function withPipelineEngine<T>(
  getEngine: () => PipelineEngine | null,
  fn: (engine: PipelineEngine) => Promise<T> | T,
): Promise<T | { error: string }> {
  const engine = getEngine();
  if (!engine) return { error: 'PipelineEngine nao inicializado' };
  try {
    return await fn(engine);
  } catch (err) {
    return { error: (err as Error).message };
  }
}
