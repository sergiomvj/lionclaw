/**
 * codex-agents-mcp.ts
 *
 * In-process SDK MCP server for the codex runtime.
 * Exposes two tools to the orchestrator:
 *   - run_codex_agent: delegate a task to a codex agent via executeAgent
 *   - codex_agents_health: check codex binary and OAuth status
 *
 * Lives in the main process — zero IPC, zero extra npm package, zero child process.
 * Auto-injected by orchestrator.ts when any codex agent is active.
 *
 * NOTE: @anthropic-ai/claude-agent-sdk is ESM-only. We cannot static-import it from
 * a CommonJS-compiled main process. Instead, the server is built lazily via
 * `getCodexAgentsServer()` which uses `await import(...)` — the same pattern the
 * orchestrator uses for `query()`. The result is cached after first call.
 */
import { z } from 'zod';
import { getAgent } from './db';
import { executeAgent } from './agent-runtime';
import { PERM_BYPASS_NO_GUARD } from './agent-runtime/permission-profiles';
import { isCodexAvailable } from './codex-bridge';
import { createLogger } from './logger';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

const logger = createLogger('codex-agents-mcp');

let cachedServer: McpSdkServerConfigWithInstance | null = null;

export async function getCodexAgentsServer(): Promise<McpSdkServerConfigWithInstance> {
  if (cachedServer) return cachedServer;

  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

  cachedServer = createSdkMcpServer({
    name: 'codex-agents',
    version: '1.0.0',
    tools: [
      tool(
        'run_codex_agent',
        'Executa um agente Codex (OpenAI via OAuth) com tool use nativo. Use para delegar tarefas a agentes com runtime=codex. Suporta multi-turn dentro da mesma chamada via threadId interno.',
        {
          agentId: z.string().describe('ID do agente codex (ex: "coder-codex")'),
          prompt: z.string().describe('A tarefa ou pergunta para o agente'),
          context: z.string().optional().describe('Contexto adicional: dados de arquivos lidos, resultados de buscas, etc.'),
        },
        async ({ agentId, prompt, context }) => {
          try {
            const agent = getAgent(agentId);
            if (!agent) {
              return {
                content: [{ type: 'text' as const, text: `Erro: agente "${agentId}" nao encontrado` }],
                isError: true,
              };
            }
            if (agent.runtime !== 'codex') {
              return {
                content: [{ type: 'text' as const, text: `Erro: agente "${agentId}" nao tem runtime=codex (e ${agent.runtime})` }],
                isError: true,
              };
            }
            if (!agent.codexConfig) {
              return {
                content: [{ type: 'text' as const, text: `Erro: agente "${agentId}" tem runtime=codex mas sem codexConfig` }],
                isError: true,
              };
            }

            const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
            const abortController = new AbortController();
            const result = await executeAgent({
              agentId,
              prompt: fullPrompt,
              cwd: process.cwd(),
              abortController,
              permission: PERM_BYPASS_NO_GUARD,
            });

            const metadata = {
              model: result.model,
              inputTokens: result.metrics.inputTokens,
              outputTokens: result.metrics.outputTokens,
              totalTokens: result.metrics.inputTokens + result.metrics.outputTokens,
              costUsd: result.metrics.costUsd,
              durationMs: result.metrics.durationMs,
              toolUses: result.metrics.toolUses,
              runtime: 'codex',
            };

            return {
              content: [
                { type: 'text' as const, text: result.output },
                { type: 'text' as const, text: `\n---\n[codex-agent-metadata]: ${JSON.stringify(metadata)}` },
              ],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ agentId, error: msg }, 'run_codex_agent failed');
            return {
              content: [{ type: 'text' as const, text: `Erro ao executar agente codex "${agentId}": ${msg}` }],
              isError: true,
            };
          }
        },
      ),
      tool(
        'codex_agents_health',
        'Verifica status do binario codex e auth OAuth. Retorna installed, version, authenticated.',
        {},
        async () => {
          const status = await isCodexAvailable();
          return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] };
        },
      ),
    ],
  });

  return cachedServer;
}
