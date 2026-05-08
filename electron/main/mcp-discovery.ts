import { createLogger } from './logger';
import { getSetting, setSetting } from './db';

const logger = createLogger('mcp-discovery');

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
}

// In-memory cache of SDK MCP servers
let sdkMcpCache: McpServerStatus[] = [];
let discoveryPromise: Promise<void> | null = null;
let lastDiscoveryAt = 0;

const DISABLED_SDK_MCPS_KEY = 'sdk_mcp_disabled';

/**
 * Discover MCP servers from the Claude Code SDK.
 * Runs a lightweight query to call mcpServerStatus().
 * Results are cached in memory.
 */
export async function discoverSDKMcpServers(): Promise<McpServerStatus[]> {
  // Evitar discovery simultaneo
  if (discoveryPromise) return discoveryPromise.then(() => sdkMcpCache);

  // Cache valido por 5 minutos
  if (Date.now() - lastDiscoveryAt < 5 * 60 * 1000 && sdkMcpCache.length > 0) {
    return sdkMcpCache;
  }

  discoveryPromise = _runDiscovery();
  await discoveryPromise;
  discoveryPromise = null;
  return sdkMcpCache;
}

async function _runDiscovery(): Promise<void> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const abortController = new AbortController();

    /**
     * EXCECAO D6 (SPEC-refactor-pipelines.md linhas 241-257):
     * MCP discovery usa query() direto em vez de executeAgent para listar
     * MCPs do SDK. É uma chamada de descoberta one-shot sem semântica de
     * agente persistente.
     *
     * NÃO migrar para executeAgent.
     */
    const q = query({
      prompt: 'List MCP servers',
      options: {
        model: 'haiku',
        settingSources: ['project', 'user'],
        allowedTools: [],
        maxTurns: 1,
        abortController,
      },
    });

    // Chamar mcpServerStatus() imediatamente
    const statuses = await q.mcpServerStatus();

    sdkMcpCache = statuses as McpServerStatus[];
    lastDiscoveryAt = Date.now();

    logger.info(
      { count: statuses.length, servers: statuses.map((s: McpServerStatus) => s.name) },
      'SDK MCP servers discovered',
    );

    // Abortar a query - nao precisamos da resposta do modelo
    abortController.abort();

    // Consumir o generator pra evitar unhandled rejection
    try {
      for await (const _ of q) {
        /* drain */
      }
    } catch {
      /* abort expected */
    }
  } catch (error) {
    logger.error({ error }, 'MCP discovery failed');
    // Manter cache anterior se existir
  }
}

/**
 * Get cached SDK MCP servers.
 * Returns empty array if discovery hasn't run yet.
 */
export function getCachedSDKMcpServers(): McpServerStatus[] {
  return sdkMcpCache;
}

/**
 * Force refresh the SDK MCP cache.
 */
export async function refreshSDKMcpServers(): Promise<McpServerStatus[]> {
  lastDiscoveryAt = 0;
  return discoverSDKMcpServers();
}

/**
 * Get list of SDK MCP server names that the user has disabled locally.
 */
export function getDisabledSDKMcps(): string[] {
  const raw = getSetting(DISABLED_SDK_MCPS_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Toggle an SDK MCP server on/off locally.
 */
export function setSDKMcpDisabled(serverName: string, disabled: boolean): void {
  const current = new Set(getDisabledSDKMcps());

  if (disabled) {
    current.add(serverName);
  } else {
    current.delete(serverName);
  }

  setSetting(DISABLED_SDK_MCPS_KEY, JSON.stringify([...current]));
  logger.info({ serverName, disabled }, 'SDK MCP toggle updated');
}
