import { getAllAgents } from './db';
import { createLogger } from './logger';
import type { AgentConfig } from '../../src/types';

const logger = createLogger('local-tools-registry');

/**
 * Gera texto descritivo dos agentes locais disponiveis pra incluir
 * no system prompt do orquestrador. O orquestrador usa essa info
 * pra decidir quando chamar run_local_agent e com qual agentId.
 */
export function getLocalAgentsDescription(): string {
  const agents = getAllAgents().filter(
    (a: AgentConfig) => a.isActive && a.runtime === 'local' && a.localConfig,
  );

  if (agents.length === 0) return '';

  const providerLabel: Record<string, string> = {
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    'openai-compatible': 'OpenAI-compatible',
  };

  const lines = agents.map((a) => {
    const mode = a.localMode === 'smart' ? 'smart (com tools)' : 'simple (text-only)';
    const tools = a.localMode === 'smart' && a.allowedTools.length > 0
      ? ` | tools: ${a.allowedTools.join(', ')}`
      : '';
    const provider = providerLabel[a.localConfig?.provider || 'ollama'] || 'Local';
    return `  - agentId: "${a.id}" | nome: ${a.name} | ${a.description} | modo: ${mode} | provider: ${provider} | modelo: ${a.localConfig?.model}${tools}`;
  });

  return `\n## Agentes Locais Disponiveis (via run_local_agent)\n\n` +
    `Use a tool run_local_agent para delegar tarefas a estes agentes locais.\n` +
    `Eles rodam em modelos locais (Ollama/LM Studio) na maquina, sem custo de API.\n\n` +
    lines.join('\n') + '\n';
}
