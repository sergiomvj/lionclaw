import { ChildProcess, spawn } from 'child_process';
import { getDb } from './db';
import { getSecret } from './secrets-vault';
import { createLogger } from './logger';
import type { MCPServerConfig } from '../../src/types';
import { Readable } from 'stream';
import { getAppVersion } from './app-version';

const logger = createLogger('mcp');

const runningServers = new Map<string, ChildProcess>();

/**
 * Start all active MCP servers on app launch.
 */
export async function startActiveMCPServers(): Promise<void> {
  const servers = getAllMCPServers().filter((s) => s.isActive);

  for (const server of servers) {
    try {
      await startServer(server.id);
    } catch (error) {
      logger.error({ id: server.id, error }, 'Failed to start MCP server');
    }
  }

  logger.info({ count: servers.length }, 'MCP servers started');

  // Fire-and-forget: populate the tool registry in the background.
  // Errors are handled inside discoverAllActiveMCPTools.
  discoverAllActiveMCPTools().catch((err) => {
    logger.error({ err }, 'Background MCP tool discovery failed unexpectedly');
  });
}

/**
 * Stop all running MCP servers.
 */
export function stopAllMCPServers(): void {
  for (const [id, proc] of runningServers) {
    proc.kill();
    logger.info({ id }, 'MCP server stopped');
  }
  runningServers.clear();
}

/**
 * Start a single MCP server by ID.
 */
export async function startServer(id: string): Promise<void> {
  if (runningServers.has(id)) {
    logger.warn({ id }, 'Server already running');
    return;
  }

  const config = getMCPServer(id);
  if (!config) throw new Error(`MCP server not found: ${id}`);

  // Resolve environment variables from secrets vault
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of config.envKeys) {
    const value = await getSecret(key);
    if (value) {
      env[key] = value;
    } else {
      logger.warn({ id, key }, 'Secret not found for MCP server env var');
    }
  }

  const proc = spawn(config.command, config.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (data: Buffer) => {
    logger.debug({ id, stdout: data.toString().substring(0, 200) }, 'MCP stdout');
  });

  proc.stderr?.on('data', (data: Buffer) => {
    logger.warn({ id, stderr: data.toString().substring(0, 200) }, 'MCP stderr');
  });

  proc.on('exit', (code) => {
    runningServers.delete(id);
    logger.info({ id, code }, 'MCP server exited');
  });

  proc.on('error', (error) => {
    runningServers.delete(id);
    logger.error({ id, error }, 'MCP server error');
  });

  runningServers.set(id, proc);
  logger.info({ id, command: config.command }, 'MCP server started');
}

/**
 * Stop a single MCP server.
 */
export function stopServer(id: string): void {
  const proc = runningServers.get(id);
  if (proc) {
    proc.kill();
    runningServers.delete(id);
    logger.info({ id }, 'MCP server stopped');
  }
}

/**
 * Restart a server (stop then start).
 */
export async function restartServer(id: string): Promise<void> {
  stopServer(id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await startServer(id);
}

/**
 * Test if a server can start and respond.
 */
export async function testServer(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const config = getMCPServer(id);
    if (!config) return { success: false, error: 'Server not found' };

    // Try to spawn and wait for first output or timeout
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const key of config.envKeys) {
      const value = await getSecret(key);
      if (value) env[key] = value;
    }

    return new Promise((resolve) => {
      const proc = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: true }); // If it didn't crash in 3s, consider it working
      }, 3000);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          resolve({ success: false, error: `Exited with code ${code}` });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get server status for UI.
 */
export function getServerStatus(id: string): 'running' | 'stopped' | 'error' {
  return runningServers.has(id) ? 'running' : 'stopped';
}

/**
 * Build MCP config object for Agent SDK.
 */
export async function getMCPConfigForAgent(agentId?: string): Promise<Record<string, { command: string; args: string[]; env?: Record<string, string> }> | undefined> {
  const db = getDb();

  let serverIds: string[] = [];
  if (agentId) {
    const agent = db.prepare('SELECT mcp_servers FROM agents WHERE id = ?').get(agentId) as { mcp_servers: string } | undefined;
    if (agent) {
      serverIds = JSON.parse(agent.mcp_servers);
    }
  }

  // If called for a specific agent with no MCPs selected, respect that — return nothing.
  // Only fall back to all active MCPs when no agentId (i.e. main orchestrator).
  if (serverIds.length === 0) {
    if (agentId) return undefined;
    const servers = getAllMCPServers().filter((s) => s.isActive);
    serverIds = servers.map((s) => s.id);
  }

  if (serverIds.length === 0) return undefined;

  const config: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const id of serverIds) {
    const server = getMCPServer(id);
    if (server) {
      const entry: { command: string; args: string[]; env?: Record<string, string> } = {
        command: server.command,
        args: server.args,
      };

      // Resolve env keys from vault for the Agent SDK to inject
      if (server.envKeys.length > 0) {
        const env: Record<string, string> = {};
        for (const key of server.envKeys) {
          const value = await getSecret(key);
          if (value) {
            env[key] = value;
          }
        }
        if (Object.keys(env).length > 0) {
          entry.env = env;
        }
      }

      config[id] = entry;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Build MCP spec for a specific list of server IDs (used by AgentDefinition).
 * Returns array of named MCP configs compatible with AgentMcpServerSpec[].
 * Each item is Record<string, McpStdioServerConfig>.
 */
export function buildMCPSpecForAgent(serverIds: string[]): Array<Record<string, { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>> | undefined {
  if (serverIds.length === 0) return undefined;
  const specs: Array<Record<string, { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }>> = [];
  for (const id of serverIds) {
    const server = getMCPServer(id);
    if (server) {
      const entry: { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } = {
        command: server.command,
        args: server.args,
      };
      specs.push({ [id]: entry });
    }
  }
  return specs.length > 0 ? specs : undefined;
}

// ---- MCP Tool Registry ----

/**
 * Persist the tools reported by an MCP server into the registry table.
 * Uses INSERT OR REPLACE so re-discovery always reflects the current state.
 */
export function saveMCPToolsToRegistry(mcpId: string, toolNames: string[]): void {
  const db = getDb();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO mcp_tool_registry (mcp_id, tool_name) VALUES (?, ?)',
  );
  const deleteOld = db.prepare('DELETE FROM mcp_tool_registry WHERE mcp_id = ?');

  const run = db.transaction(() => {
    deleteOld.run(mcpId);
    for (const name of toolNames) {
      insert.run(mcpId, name);
    }
  });
  run();
  logger.info({ mcpId, count: toolNames.length }, 'Saved MCP tools to registry');
}

/**
 * Return all registered tool names for the given server IDs, formatted as
 * `mcp__<serverId>__<toolName>` — the format the Agent SDK expects.
 */
export function getMCPToolsFromRegistry(serverIds: string[]): string[] {
  if (serverIds.length === 0) return [];
  const db = getDb();
  const placeholders = serverIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT mcp_id, tool_name FROM mcp_tool_registry WHERE mcp_id IN (${placeholders})`)
    .all(...serverIds) as Array<{ mcp_id: string; tool_name: string }>;

  return rows.map((r) => `mcp__${r.mcp_id}__${r.tool_name}`);
}

/**
 * Spawn a temporary MCP process, negotiate via JSON-RPC initialize + tools/list,
 * persist the result in the registry and return the raw tool names.
 *
 * The process is killed as soon as discovery completes (or times out after 8 s).
 */
export async function discoverAndSaveMCPTools(serverId: string): Promise<string[]> {
  const config = getMCPServer(serverId);
  if (!config) throw new Error(`MCP server not found: ${serverId}`);

  // Resolve secrets the same way startServer does
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of config.envKeys) {
    const value = await getSecret(key);
    if (value) {
      env[key] = value;
    } else {
      logger.warn({ serverId, key }, 'Secret not found during tool discovery');
    }
  }

  return new Promise<string[]>((resolve, reject) => {
    const proc = spawn(config.command, config.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const TIMEOUT_MS = 8000;
    let settled = false;
    let stdoutBuf = '';

    const finish = (toolNames: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already dead */ }
      saveMCPToolsToRegistry(serverId, toolNames);
      resolve(toolNames);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already dead */ }
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Tool discovery timed out for server: ${serverId}`));
    }, TIMEOUT_MS);

    proc.on('error', (err) => fail(err));

    // Track whether we have already sent the tools/list request
    let initializeDone = false;

    (proc.stdout as Readable).on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // Not JSON — ignore (e.g. debug output)
        }

        // Response to initialize (id === 1) — now send tools/list
        if (!initializeDone && (msg['id'] as number) === 1 && msg['result'] !== undefined) {
          initializeDone = true;
          const toolsListRequest = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          });
          proc.stdin?.write(toolsListRequest + '\n');
        }

        // Response to tools/list (id === 2)
        if ((msg['id'] as number) === 2) {
          const result = msg['result'] as Record<string, unknown> | undefined;
          const rawTools = result?.['tools'];
          const toolNames: string[] = Array.isArray(rawTools)
            ? rawTools.map((t: unknown) => {
                const tool = t as Record<string, unknown>;
                return (tool['name'] as string) ?? '';
              }).filter(Boolean)
            : [];
          finish(toolNames);
        }
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        logger.warn({ serverId, code }, 'MCP process exited before discovery completed');
        finish([]);
      }
    });

    // Send initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lionclaw', version: getAppVersion() },
      },
    });
    proc.stdin?.write(initRequest + '\n');
  });
}

/**
 * Run discovery for every active MCP server.
 * Errors per server are swallowed so a single bad server cannot block the others.
 */
export async function discoverAllActiveMCPTools(): Promise<void> {
  const servers = getAllMCPServers().filter((s) => s.isActive);
  logger.info({ count: servers.length }, 'Starting MCP tool discovery for all active servers');

  for (const server of servers) {
    try {
      const tools = await discoverAndSaveMCPTools(server.id);
      logger.info({ serverId: server.id, toolCount: tools.length }, 'Tool discovery completed');
    } catch (err) {
      logger.error({ serverId: server.id, err }, 'Tool discovery failed for server');
    }
  }
}

// ---- CRUD ----

export function getAllMCPServers(): MCPServerConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mcp_servers').all() as Array<Record<string, unknown>>;
  return rows.map(mapServer);
}

function getMCPServer(id: string): MCPServerConfig | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapServer(row) : undefined;
}

export function createMCPServer(config: Omit<MCPServerConfig, 'status'>): MCPServerConfig {
  const db = getDb();
  db.prepare(`
    INSERT INTO mcp_servers (id, name, command, args, env_keys, is_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(config.id, config.name, config.command, JSON.stringify(config.args), JSON.stringify(config.envKeys), config.isActive ? 1 : 0);
  return { ...config, status: 'stopped' };
}

export function updateMCPServer(id: string, updates: Partial<MCPServerConfig>): MCPServerConfig {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command); }
  if (updates.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(updates.args)); }
  if (updates.envKeys !== undefined) { fields.push('env_keys = ?'); values.push(JSON.stringify(updates.envKeys)); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const server = getMCPServer(id);
  return { ...server!, status: getServerStatus(id) };
}

export function deleteMCPServer(id: string): void {
  stopServer(id);
  const db = getDb();
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

function mapServer(row: Record<string, unknown>): MCPServerConfig {
  const id = row['id'] as string;
  return {
    id,
    name: row['name'] as string,
    description: (row['description'] as string) || undefined,
    command: row['command'] as string,
    args: JSON.parse((row['args'] as string) || '[]'),
    envKeys: JSON.parse((row['env_keys'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
    status: getServerStatus(id),
  };
}
