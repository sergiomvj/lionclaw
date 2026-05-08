/**
 * pipeline-shared/sdk-bootstrap.ts
 *
 * Helpers compartilhados pra inicializar o ambiente do Claude Agent SDK.
 * Antes desta extracao (Sprint S1.2), esses helpers viviam duplicados em
 * harness-engine.ts e cloud-executor.ts.
 *
 * Exports:
 * - getClaudeCodeExecutablePath: resolve o cli.js do SDK
 * - ensureNodeInPath: garante que o binario node esta no PATH (Electron quirk)
 * - ensureAuthForSDK: garante que API key OU OAuth esta disponivel
 *
 * Notas importantes:
 * - O state interno `_nodePathFixed` agora e compartilhado por modulo entre
 *   todos os callers (harness-engine, cloud-executor). Esse e o comportamento
 *   correto: nao queremos rodar o fixer 2x. Ambas funcoes ensure* sao
 *   idempotentes via guards.
 * - O fallback de `getClaudeCodeExecutablePath` resolve a partir de
 *   `electron/main/pipeline-shared/`, entao precisa subir 3 niveis (`..`,
 *   `..`, `..`) ate a project root.
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import { getApiKey } from '../secrets-vault';

const logger = createLogger('sdk-bootstrap');

/**
 * Resolve the path to the Claude Code CLI executable.
 * The SDK normally resolves this via import.meta.url, but in Electron's
 * main process context the resolution can fail. We resolve it explicitly.
 */
export function getClaudeCodeExecutablePath(): string {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return path.join(path.dirname(sdkEntry), 'cli.js');
  } catch {
    // Fallback: from electron/main/pipeline-shared/, project root is 3 levels up
    const projectRoot = path.join(__dirname, '..', '..', '..');
    return path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  }
}

/**
 * Ensure the `node` binary is reachable from child processes.
 * In Electron, process.execPath is the Electron binary, not Node.js.
 * When Electron is launched from Finder/Dock (not terminal), `node` may
 * not be in PATH, causing spawn('node', ...) inside the SDK to ENOENT.
 * We find node's directory and prepend it to process.env.PATH.
 */
let _nodePathFixed = false;
export function ensureNodeInPath(): void {
  if (_nodePathFixed) return;
  _nodePathFixed = true;

  // Check if node is already reachable
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) {
      logger.info({ nodePath: result.split('\n')[0] }, 'node already in PATH');
      return;
    }
  } catch {
    // node not in PATH, fix it
  }

  // Search common installation paths
  const commonPaths = process.platform === 'darwin'
    ? [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(process.env.HOME ?? '', '.nvm/current/bin'),
        '/usr/bin',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\nodejs',
          path.join(process.env.APPDATA ?? '', 'nvm\\current'),
        ]
      : ['/usr/bin', '/usr/local/bin'];

  const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of commonPaths) {
    if (fs.existsSync(path.join(dir, nodeExe))) {
      const sep = process.platform === 'win32' ? ';' : ':';
      process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`;
      logger.info({ nodeDir: dir }, 'Prepended node directory to PATH');
      return;
    }
  }

  logger.warn('Could not find node binary in common paths');
}

/**
 * Ensure auth is available for the spawned CLI process.
 * Two auth methods are supported:
 * 1. OAuth via Claude Code login (~/.claude/) - uses the user's Claude subscription
 * 2. ANTHROPIC_API_KEY in env - uses API credits
 *
 * If the user has an API key in the Vault, inject it into process.env as fallback.
 * If not, rely on Claude Code OAuth (user must have run `claude login`).
 */
export async function ensureAuthForSDK(): Promise<void> {
  // Already have API key in env? Nothing to do.
  if (process.env.ANTHROPIC_API_KEY) {
    logger.info('Auth: using ANTHROPIC_API_KEY from env');
    return;
  }

  // Check if Claude Code OAuth is available
  const claudeDir = path.join(process.env.HOME ?? '', '.claude');
  if (fs.existsSync(claudeDir)) {
    logger.info({ claudeDir }, 'Auth: found ~/.claude directory (OAuth likely available)');
    // Don't inject API key - let CLI use OAuth
    return;
  }

  // No OAuth found, try to inject API key from Vault as fallback
  try {
    const apiKey = await getApiKey();
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
      logger.info('Auth: injected ANTHROPIC_API_KEY from Vault');
      return;
    }
  } catch {
    // getApiKey may fail if keytar is not available
  }

  logger.warn('Auth: no ANTHROPIC_API_KEY and no ~/.claude found. CLI may fail to authenticate. Run "claude login" or configure API key in Vault.');
}
