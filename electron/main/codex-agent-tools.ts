/**
 * codex-agent-tools.ts
 *
 * Companion to local-agent-tools.ts.
 * Generates the system-prompt description of available codex agents
 * so the orchestrator knows when and how to call run_codex_agent.
 */

import { getAllAgents } from './db';
import type { AgentConfig } from '../../src/types';

/**
 * Gera texto descritivo dos agentes codex disponiveis pra incluir
 * no system prompt do orquestrador. O orquestrador usa essa info
 * pra decidir quando chamar run_codex_agent e com qual agentId.
 */
export function getCodexAgentsDescription(): string {
  const agents = getAllAgents().filter(
    (a: AgentConfig) => a.isActive && a.runtime === 'codex' && a.codexConfig,
  );

  if (agents.length === 0) return '';

  const lines = agents.map((a: AgentConfig) =>
    `  - agentId: "${a.id}" | nome: ${a.name} | ${a.description} | modelo: ${a.codexConfig?.model}`,
  );

  return (
    `\n## Agentes Codex Disponiveis (via run_codex_agent)\n\n` +
    `Use a tool run_codex_agent para delegar tarefas a estes agentes.\n` +
    `Eles rodam o OpenAI Codex CLI via OAuth (assinatura ChatGPT). Use codex_agents_health pra checar conexao.\n\n` +
    lines.join('\n') +
    '\n'
  );
}
