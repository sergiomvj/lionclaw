/**
 * mcp-tool-bridge.ts
 *
 * Modulo responsavel por fazer spawn/discovery/teardown de MCP servers para
 * sessoes do path external, e converter tools MCP para o formato OpenAI
 * (OllamaToolSchema).
 *
 * IMPORTANTE: Este modulo e usado EXCLUSIVAMENTE pelo path external
 * (ollamaChatWithTools com opcao mcpServers). O path local (Ollama/LM Studio)
 * e o path cloud (Claude SDK) nunca chamam este modulo.
 *
 * Todos os servers recebem spawn por sessao (incluindo globais). Ver comentario
 * em setupMCPsForSession para detalhes.
 */

import { ChildProcess, spawn } from 'child_process';
import { Readable } from 'stream';
import { createLogger } from './logger';
import type { OllamaToolSchema } from './ollama-client';
import { getAppVersion } from './app-version';

const logger = createLogger('mcp-tool-bridge');

// ============================================================
// Tipos publicos
// ============================================================

/** Spec de um MCP server recebida do agente (mesmo formato que o SDK Claude usa) */
export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Schema de uma tool retornada pelo tools/list do MCP (JSON-RPC response) */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Conexao JSON-RPC com um unico MCP server (stdio) */
interface McpServerConnection {
  /** ID/nome do servidor (chave do Record<string, McpServerSpec>) */
  serverId: string;
  /** Processo filho spawned para esta sessao */
  proc: ChildProcess | undefined;
  /** Flag: true quando o processo foi spawned por esta sessao e deve ser morto no teardown */
  ownedBySession: boolean;
  /** Buffer de leitura de stdout nao processada ainda */
  stdoutBuf: string;
  /** Mapa de callbacks aguardando resposta JSON-RPC: requestId -> resolve/reject */
  pending: Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>;
  /** Proximo ID de request JSON-RPC */
  nextId: number;
  /** Referencia ao stdin do processo (pode ser de proc local ou de processo global recuperado) */
  stdin: NodeJS.WritableStream | null;
}

/**
 * Client de sessao MCP: encapsula todas as conexoes abertas para esta chamada
 * de ollamaChatWithTools. Passado como referencia opaca entre setupMCPsForSession,
 * callMCPTool e teardownMCPsForSession.
 */
export interface McpSessionClient {
  connections: McpServerConnection[];
}

// ============================================================
// Constantes
// ============================================================

const JSONRPC_TIMEOUT_MS = 10_000;
const INIT_TIMEOUT_MS = 8_000;

// ============================================================
// Helpers JSON-RPC internos
// ============================================================

/**
 * Registra o listener de stdout no processo para despachar respostas JSON-RPC
 * aos callbacks pendentes da conexao.
 */
function attachStdoutListener(conn: McpServerConnection, readable: Readable): void {
  (readable as Readable).on('data', (chunk: Buffer) => {
    conn.stdoutBuf += chunk.toString();
    const lines = conn.stdoutBuf.split('\n');
    conn.stdoutBuf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Linha nao e JSON (debug output do servidor): ignora
        continue;
      }

      const id = msg['id'] as number | undefined;
      if (id !== undefined) {
        const cb = conn.pending.get(id);
        if (cb) {
          conn.pending.delete(id);
          if (msg['error']) {
            const errObj = msg['error'] as Record<string, unknown>;
            cb.reject(new Error(`MCP JSON-RPC error: ${errObj['message'] ?? JSON.stringify(errObj)}`));
          } else {
            cb.resolve(msg);
          }
        }
      }
    }
  });
}

/**
 * Envia uma requisicao JSON-RPC ao servidor e aguarda a resposta.
 * Rejeita apos JSONRPC_TIMEOUT_MS ms sem resposta.
 */
function sendJsonRpc(
  conn: McpServerConnection,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (!conn.stdin) {
      reject(new Error(`MCP server ${conn.serverId}: stdin nao disponivel`));
      return;
    }

    const id = conn.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP server ${conn.serverId}: timeout aguardando resposta para ${method}`));
    }, JSONRPC_TIMEOUT_MS);

    conn.pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });

    conn.stdin.write(request + '\n');
  });
}

/**
 * Realiza o handshake initialize + tools/list em uma conexao ja aberta.
 * Retorna a lista de tools descriptors.
 */
async function initializeAndDiscoverTools(conn: McpServerConnection): Promise<McpToolDescriptor[]> {
  // initialize
  await sendJsonRpc(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lionclaw', version: getAppVersion() },
  });

  // notifications/initialized: obrigatorio pelo protocolo MCP antes de tools/list.
  // Notifications nao tem id e nao esperam resposta, portanto nao usar sendJsonRpc.
  conn.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // tools/list
  const toolsResponse = await sendJsonRpc(conn, 'tools/list', {});
  const result = toolsResponse['result'] as Record<string, unknown> | undefined;
  const rawTools = result?.['tools'];

  if (!Array.isArray(rawTools)) return [];

  return rawTools.map((t: unknown) => {
    const tool = t as Record<string, unknown>;
    return {
      name: (tool['name'] as string) ?? '',
      description: (tool['description'] as string) ?? undefined,
      inputSchema: tool['inputSchema'] as McpToolDescriptor['inputSchema'] ?? undefined,
    };
  }).filter((t) => t.name !== '');
}

// ============================================================
// Conversao de schema MCP para formato OpenAI
// ============================================================

/**
 * Converte um descriptor de tool MCP para o formato OllamaToolSchema
 * (identico ao OpenAI function-calling schema).
 *
 * Convencao de nomes: `mcp__<serverId>__<toolName>`
 * Isso permite que callMCPTool extraia o serverId e o toolName do prefixo.
 */
export function mcpToolToOpenAISchema(
  serverId: string,
  mcpTool: McpToolDescriptor,
): OllamaToolSchema {
  const properties = mcpTool.inputSchema?.properties ?? {};
  const required = mcpTool.inputSchema?.required;

  const schema: OllamaToolSchema = {
    type: 'function',
    function: {
      name: `mcp__${serverId}__${mcpTool.name}`,
      description: mcpTool.description ?? `Tool ${mcpTool.name} do servidor MCP ${serverId}`,
      parameters: {
        type: 'object',
        properties,
        ...(required && required.length > 0 ? { required } : {}),
      },
    },
  };

  return schema;
}

// ============================================================
// spawn de MCP server por sessao
// ============================================================

/**
 * Spawna um processo MCP para esta sessao. O processo e marcado como
 * ownedBySession e sera morto no teardown.
 *
 * Aguarda o stdout ficar disponivel antes de retornar (com timeout INIT_TIMEOUT_MS).
 */
async function spawnTemporaryMCPServer(
  serverId: string,
  spec: McpServerSpec,
): Promise<McpServerConnection> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(spec.env ?? {}) };

  const proc = spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const conn: McpServerConnection = {
    serverId,
    proc,
    ownedBySession: true,
    stdoutBuf: '',
    pending: new Map(),
    nextId: 1,
    stdin: proc.stdin,
  };

  proc.stderr?.on('data', (data: Buffer) => {
    logger.warn({ serverId, stderr: data.toString().substring(0, 200) }, 'MCP server stderr');
  });

  proc.on('error', (err) => {
    logger.error({ serverId, err }, 'MCP temporary process error');
    // Rejeita todos os pendentes
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP server ${serverId} process error: ${err.message}`));
    }
    conn.pending.clear();
  });

  proc.on('exit', (code) => {
    logger.info({ serverId, code }, 'MCP temporary process exited');
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP server ${serverId} exited unexpectedly (code ${code})`));
    }
    conn.pending.clear();
  });

  if (!proc.stdout) {
    proc.kill();
    throw new Error(`MCP server ${serverId}: stdout nao disponivel apos spawn`);
  }

  attachStdoutListener(conn, proc.stdout as Readable);

  // Aguarda processo iniciar com timeout. Se falhar, mata o processo antes de relancar.
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP server ${serverId}: timeout aguardando inicio do processo`));
      }, INIT_TIMEOUT_MS);

      proc.on('spawn', () => {
        clearTimeout(timer);
        resolve();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    proc.kill();
    throw err;
  }

  logger.info({ serverId, command: spec.command }, 'MCP temporary server spawned');
  return conn;
}

// ============================================================
// API publica: setupMCPsForSession
// ============================================================

// NOTE: spawn por sessao mesmo para servers globais. Reuso real requer multiplexer JSON-RPC em mcp-manager.ts (fora do escopo Sprint 6). Servers globais persistentes nao sao afetados pelo teardown da sessao.

/**
 * Setup de MCP servers para uma sessao de ollamaChatWithTools.
 *
 * Spawna uma instancia por sessao para cada servidor em `servers`.
 * Retorna um McpSessionClient com todas as conexoes abertas e a lista de
 * OllamaToolSchema ja prontas para ser mescladas com as builtin tools.
 */
export async function setupMCPsForSession(
  servers: Record<string, McpServerSpec>,
): Promise<{ client: McpSessionClient; tools: OllamaToolSchema[] }> {
  const serverEntries = Object.entries(servers);
  if (serverEntries.length === 0) {
    return { client: { connections: [] }, tools: [] };
  }

  const connections: McpServerConnection[] = [];
  const allTools: OllamaToolSchema[] = [];

  for (const [serverId, spec] of serverEntries) {
    try {
      logger.info({ serverId }, 'Setting up MCP server for session');

      const conn = await spawnTemporaryMCPServer(serverId, spec);

      connections.push(conn);

      // Discover tools via JSON-RPC
      const tools = await initializeAndDiscoverTools(conn);
      logger.info({ serverId, toolCount: tools.length }, 'MCP tools discovered');

      for (const tool of tools) {
        allTools.push(mcpToolToOpenAISchema(serverId, tool));
      }
    } catch (err) {
      logger.error({ serverId, err }, 'Failed to setup MCP server for session, skipping');
      // Falha em um servidor nao deve impedir os demais
    }
  }

  const client: McpSessionClient = { connections };
  logger.info(
    { serverCount: connections.length, toolCount: allTools.length },
    'MCP session setup complete',
  );

  return { client, tools: allTools };
}

// ============================================================
// API publica: teardownMCPsForSession
// ============================================================

/**
 * Teardown de todos os processos spawned para esta sessao.
 *
 * Mata processos com ownedBySession=true.
 * Nao toca nos processos globais gerenciados pelo mcp-manager.ts.
 */
export async function teardownMCPsForSession(client: McpSessionClient): Promise<void> {
  for (const conn of client.connections) {
    if (conn.ownedBySession && conn.proc) {
      try {
        conn.proc.kill();
        logger.info({ serverId: conn.serverId }, 'MCP session process killed');
      } catch (err) {
        logger.warn({ serverId: conn.serverId, err }, 'Error killing MCP session process');
      }
    }
    // Rejeita qualquer pendente remanescente
    for (const [, cb] of conn.pending) {
      cb.reject(new Error(`MCP session torn down: ${conn.serverId}`));
    }
    conn.pending.clear();
  }

  logger.info({ count: client.connections.length }, 'MCP session teardown complete');
}

// ============================================================
// API publica: callMCPTool
// ============================================================

/**
 * Roteia uma tool call para o MCP server correto via JSON-RPC tools/call.
 *
 * Espera que toolName siga o formato `mcp__<serverId>__<toolName>`.
 * Extrai o serverId e toolName do prefixo e localiza a conexao no client.
 */
export async function callMCPTool(
  client: McpSessionClient,
  toolName: string,
  args: unknown,
): Promise<unknown> {
  // Formato esperado: mcp__<serverId>__<actualToolName>
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    throw new Error(`callMCPTool: nome de tool invalido (esperado mcp__<server>__<tool>): ${toolName}`);
  }

  const serverId = parts[1];
  // O nome real da tool pode ter '__' nele mesmo (remonta tudo apos o segundo segmento)
  const actualToolName = parts.slice(2).join('__');

  const conn = client.connections.find((c) => c.serverId === serverId);
  if (!conn) {
    throw new Error(`callMCPTool: nenhuma conexao ativa para servidor ${serverId}`);
  }

  logger.info({ serverId, toolName: actualToolName }, 'Calling MCP tool');

  const response = await sendJsonRpc(conn, 'tools/call', {
    name: actualToolName,
    arguments: args ?? {},
  });

  const result = response['result'] as Record<string, unknown> | undefined;

  // Resultado pode ser texto plano, array de content blocks, ou qualquer estrutura.
  // Retornamos o result tal como veio do servidor. Se ausente, retorna null para
  // evitar injetar o envelope JSON-RPC completo no contexto do LLM.
  return result ?? null;
}
