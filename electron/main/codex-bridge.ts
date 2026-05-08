import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import which from 'which';
import { createLogger } from './logger';
import { getSetting } from './db';
import { getAppVersion } from './app-version';

const logger = createLogger('codex-bridge');

// ---- Public error classes ----

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

export class CodexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUnavailableError';
  }
}

// ---- Public interfaces ----

export interface CodexBridgeOptions {
  model: string;
  cwd: string;
  systemPrompt?: string;
  approvalPolicy?: 'never' | 'on-request' | 'auto-edit';
  sandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /**
   * S4.3 (Onda 4): identifica o projeto pipeline que dono este slot.
   * Permite que `resetCodexPool(projectId)` mate apenas slots desse projeto,
   * em vez de matar o pool inteiro. Quando ausente, o slot fica sem projectId
   * e e atingido apenas por reset global (resetCodexPool() sem argumento).
   */
  projectId?: string;
}

export interface CodexStreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolUse?: (tool: string) => void;
  onToolUseComplete?: (tool: string, result: unknown) => void;
  /**
   * Sinal generico: bridge chama em TODO evento Codex recebido (incluindo
   * eventos nao tratados explicitamente pelo switch, como `plan_update`).
   * Permite que callers (executeAgent watchdog) saibam que o agente esta vivo
   * mesmo em spans onde nao ha text/reasoning/tool. Ver BUGFIXTESTESV1.md Bug #7.
   */
  onActivity?: () => void;
}

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexPatchFailureSample {
  source: 'tool-output' | 'stderr';
  text: string;
  ts: number;
}

export interface CodexResponse {
  threadId: string;
  content: string;
  filesChanged: string[];
  commandsRun: Array<{ cmd: string; exitCode: number; durationMs: number }>;
  usage: CodexTokenUsage;
  status: 'completed' | 'failed' | 'timeout' | 'auth_required';
  /** SPEC-codex-windows-fix.md Camada 4: total apply_patch verification failures
   *  observados durante esta execucao (via stderr e/ou tool output events). */
  applyPatchFailures: number;
  /** Amostras (max 5) das falhas de apply_patch. Cada entry indica fonte + texto truncado. */
  applyPatchFailureSamples: CodexPatchFailureSample[];
}

export interface CodexSession {
  threadId: string | null;
  send(prompt: string, cb?: CodexStreamCallbacks, abortSignal?: AbortSignal): Promise<CodexResponse>;
  reply(message: string, cb?: CodexStreamCallbacks, abortSignal?: AbortSignal): Promise<CodexResponse>;
  close(): void;
}

// ---- Internal types ----

interface CommandRecord {
  cmd: string;
  exitCode: number;
  durationMs: number;
}

interface InFlightEntry {
  resolve: (res: CodexResponse) => void;
  reject: (err: Error) => void;
  callbacks: CodexStreamCallbacks;
  accumulator: {
    content: string;
    filesChanged: string[];
    commandsRun: CommandRecord[];
    usage: CodexTokenUsage;
    threadId: string;
    settled: boolean;
    // Codex CLI atual emite DOIS canais com mesmo conteudo:
    // `agent_message_delta` E `agent_message_content_delta`. Pra dedupe
    // funcionar em qualquer ORDEM de chegada (race condition real observada),
    // ambos os flags sao verificados RECIPROCAMENTE — o primeiro canal a chegar
    // "ganha" e silencia o outro pelo resto do turno. Sem essa simetria, o
    // primeiro chunk era processado 2x, gerando outputs com tokens iniciais
    // duplicados (ex: "VouVou ...", "{ {", JSON sequencial).
    sawAgentMessageDelta: boolean;
    sawAgentMessageContentDelta: boolean;
    // track pending command by call_id
    pendingCommands: Map<string, { command: string[]; startTime: number }>;
    // track patch tool type by call_id
    pendingPatches: Map<string, string>;
    // SPEC Camada 4: telemetria de apply_patch verification failures
    applyPatchFailures: number;
    applyPatchFailureSamples: CodexPatchFailureSample[];
    /** ts do ultimo registro proveniente de tool-output, usado pra dedupe de stderr (janela 500ms) */
    lastPatchFailureToolOutputTs: number;
  };
  requestId: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  hardTimeoutHandle: ReturnType<typeof setTimeout> | null;
  idleTimeoutHandle: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
}

interface ProcessSlot {
  child: ChildProcess | null;
  inflight: Map<number, InFlightEntry>;
  stdoutBuf: string;
  initialized: boolean;
  dead: boolean;
  pendingInit: Array<() => void>;
  initStarted: boolean;
  initResolver: (() => void) | null;
  initRejecter: ((e: Error) => void) | null;
  /** Number of active sessions currently holding this slot. */
  sessionCount: number;
  /**
   * S4.3 (Onda 4): projectId que originou a sessao mais recente deste slot.
   * Usado por `resetCodexPool(projectId)` pra matar so slots de um projeto.
   * `undefined` quando o slot esta dead/livre ou foi adquirido sem projectId
   * (e.g. mcp ou orchestrator).
   */
  projectId?: string;
}

// ---- Pool constants ----

// Effectively unlimited pool. Each agent run gets its own slot/process; idle slots
// don't consume rate-limit on OpenAI side (only inflight requests count). All slots
// stay alive until pipeline completes (status='done') or aborts; then resetCodexPool()
// kills everything. SPEC D2 (per-agent fresh process) is achieved by never reusing
// slots in practice — pool is large enough to never wrap around in a single pipeline.
const MAX_POOL_SIZE = 100;
const MAX_INFLIGHT_PER_SLOT = 1;
// 2h hard timeout default (override por executor). Coder/Evaluator de sprints
// reais editam 5-15 arquivos, rodam testes/typecheck, podendo levar 30-60min.
// 10min original matava no meio do trabalho.
const DEFAULT_TIMEOUT_MS = 7_200_000;
// 30min idle. Margem realista pra spans longos de raciocinio LLM
// (spec-builder, planner, PRD generators) sem matar processo genuinamente travado.
// Combinado com Bug #4 + Bug #7 (markInflightProgress + onActivity em todo evento),
// idle so dispara em silencio absoluto — nao em raciocinio longo.
const DEFAULT_IDLE_PROGRESS_TIMEOUT_MS = 1_800_000;

// ---- Singleton pool ----

const pool: ProcessSlot[] = [];
let nextRequestId = 100;

for (let i = 0; i < MAX_POOL_SIZE; i++) {
  pool.push({
    child: null,
    inflight: new Map(),
    stdoutBuf: '',
    initialized: false,
    dead: true,
    pendingInit: [],
    initStarted: false,
    initResolver: null,
    initRejecter: null,
    sessionCount: 0,
    projectId: undefined,
  });
}

// Queue for sessions waiting for an available slot
interface QueuedSession {
  resolve: (slotIndex: number) => void;
  reject: (e: Error) => void;
}
const sessionQueue: QueuedSession[] = [];

// ---- Binary detection ----

export async function resolveCodexBinary(): Promise<string | null> {
  try {
    const settingPath = getSetting('codex_binary_path');
    if (settingPath && fs.existsSync(settingPath)) {
      return settingPath;
    }
  } catch {
    // db may not be initialized in tests
  }
  try {
    return await which('codex');
  } catch {
    // Fallback: probe common Windows npm global bin locations
    if (process.platform === 'win32') {
      const candidates: string[] = [];
      const appData = process.env['APPDATA'];
      const userProfile = process.env['USERPROFILE'] ?? os.homedir();
      if (appData) {
        candidates.push(
          path.join(appData, 'npm', 'codex.cmd'),
          path.join(appData, 'npm', 'codex.exe'),
          path.join(appData, 'npm', 'codex'),
        );
      }
      candidates.push(
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.exe'),
        path.join(userProfile, 'AppData', 'Roaming', 'npm', 'codex'),
      );
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
    return null;
  }
}

export async function isCodexAvailable(): Promise<{
  installed: boolean;
  version: string | null;
  authenticated: boolean;
}> {
  const binary = await resolveCodexBinary();

  if (!binary) {
    return { installed: false, version: null, authenticated: false };
  }

  let version: string | null = null;
  try {
    version = await new Promise<string | null>((resolve) => {
      const useShellForVersion = process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd');
      const proc = spawn(binary, ['--version'], {
        shell: useShellForVersion,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve(null);
      }, 5000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });

      proc.on('close', () => {
        clearTimeout(timer);
        const trimmed = out.trim();
        resolve(trimmed || null);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  } catch {
    version = null;
  }

  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  const authenticated = fs.existsSync(authPath);

  return { installed: true, version, authenticated };
}

// ---- Process lifecycle ----

function writeJson(slot: ProcessSlot, msg: unknown): void {
  if (!slot.child?.stdin) return;
  try {
    slot.child.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    logger.error({ err: e }, 'Failed to write to codex stdin');
  }
}

async function ensureSlotAlive(slotIndex: number): Promise<void> {
  const slot = pool[slotIndex];

  if (!slot.dead && slot.initialized) {
    return;
  }

  if (slot.initStarted && !slot.dead) {
    // Wait for ongoing initialization
    return new Promise<void>((resolve, reject) => {
      slot.pendingInit.push(() => resolve());
      // Also need to handle rejection if init fails
      const origRejecter = slot.initRejecter;
      slot.initRejecter = (e) => {
        reject(e);
        origRejecter?.(e);
      };
    });
  }

  // Fresh spawn
  slot.dead = false;
  slot.initialized = false;
  slot.initStarted = true;
  slot.stdoutBuf = '';
  slot.inflight.clear();

  const binary = await resolveCodexBinary();
  if (!binary) {
    slot.dead = true;
    slot.initStarted = false;
    throw new CodexUnavailableError('codex binary not found. Install codex CLI first.');
  }

  logger.info({ slotIndex, binary }, 'Spawning codex mcp-server');

  // On Windows, .cmd files must be spawned with shell:true; elsewhere shell:false is preferred.
  const useShell = process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd');
  const child = spawn(binary, ['mcp-server'], {
    shell: useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  slot.child = child;

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    // SPEC Camada 4: truncate aumentado de 200 -> 500 pra capturar path completo do
    // arquivo afetado em "apply_patch verification failed: Failed to find expected lines in <path>".
    logger.debug({ slotIndex, stderr: text.substring(0, 500) }, 'codex mcp-server stderr');

    // SPEC Camada 4: detector FALLBACK de apply_patch failure via stderr.
    // Detector PRIMARIO esta em handleCodexEvent (tool output / patch_apply_end).
    // Stderr tem dedupe temporal (500ms) pra evitar contagem dupla quando tool-output
    // ja registrou a mesma falha.
    if (text.includes('apply_patch verification failed')) {
      const slot = pool[slotIndex];
      // MAX_INFLIGHT_PER_SLOT = 1 garante no maximo 1 entrada inflight por slot
      for (const [, entry] of slot.inflight) {
        recordPatchFailure(entry, 'stderr', text);
        break;
      }
    }
  });

  child.on('error', (err) => {
    logger.error({ slotIndex, err }, 'codex mcp-server process error');
    killSlot(slotIndex, new CodexUnavailableError(`codex process error: ${err.message}`));
  });

  child.on('exit', (code) => {
    logger.warn({ slotIndex, code }, 'codex mcp-server exited');
    killSlot(slotIndex, new CodexUnavailableError(`codex process exited with code ${code}`));
  });

  (child.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    handleStdoutData(slotIndex, chunk.toString());
  });

  // Perform JSON-RPC handshake
  await new Promise<void>((resolve, reject) => {
    slot.initResolver = resolve;
    slot.initRejecter = reject;

    const timer = setTimeout(() => {
      reject(new CodexUnavailableError('codex mcp-server initialization timeout'));
      slot.dead = true;
      try { child.kill(); } catch { /* ignore */ }
    }, 15000);

    slot.initResolver = () => {
      clearTimeout(timer);
      resolve();
    };
    slot.initRejecter = (e) => {
      clearTimeout(timer);
      reject(e);
    };

    writeJson(slot, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        capabilities: {},
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'lionclaw', version: getAppVersion() },
      },
    });
  });
}

function handleStdoutData(slotIndex: number, data: string): void {
  const slot = pool[slotIndex];
  slot.stdoutBuf += data;

  const lines = slot.stdoutBuf.split('\n');
  slot.stdoutBuf = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn({ slotIndex, raw: trimmed.substring(0, 200) }, 'Non-JSON line from codex mcp-server');
      continue;
    }

    routeMessage(slotIndex, msg);
  }
}

function routeMessage(slotIndex: number, msg: Record<string, unknown>): void {
  const slot = pool[slotIndex];

  const id = msg['id'] as number | undefined;
  const method = msg['method'] as string | undefined;

  // Server-initiated request (approval)
  if (method && id !== undefined && msg['params'] !== undefined && msg['result'] === undefined && msg['error'] === undefined) {
    if (method === 'exec_approval_request' || method === 'apply_patch_approval_request') {
      logger.debug({ slotIndex, method, id }, 'Auto-approving codex approval request');
      writeJson(slot, {
        jsonrpc: '2.0',
        id,
        result: { decision: 'approved' },
      });
      return;
    }
  }

  // Response to a request (has id + result/error, no method)
  if (id !== undefined && !method) {
    // id === 1 is the initialize response
    if (id === 1) {
      handleInitializeResponse(slotIndex, msg);
      return;
    }
    // Other responses go to inflight
    const entry = slot.inflight.get(id);
    if (entry) {
      if (msg['error']) {
        const err = msg['error'] as Record<string, unknown>;
        if (!entry.accumulator.settled) {
          entry.accumulator.settled = true;
          clearInflightTimers(entry);
          entry.reject(new Error(`JSON-RPC error: ${JSON.stringify(err)}`));
        }
      }
      // result for tools/call is handled via notifications; the final result resolves the promise
      // In case the result arrives without prior task_complete (fallback):
      if (msg['result']) {
        const result = msg['result'] as Record<string, unknown>;
        const meta = result['_meta'] as Record<string, unknown> | undefined;
        if (meta?.['threadId'] && !entry.accumulator.settled) {
          entry.accumulator.threadId = meta['threadId'] as string;
        }
      }
    }
    return;
  }

  // Notification (has method, no id OR id is undefined)
  if (method) {
    if (method === 'codex/event') {
      handleCodexEvent(slotIndex, msg);
      return;
    }
    if (method === 'notifications/initialized') {
      // ignore
      return;
    }
    logger.debug({ slotIndex, method }, 'Unknown codex notification');
  }
}

function handleInitializeResponse(slotIndex: number, _msg: Record<string, unknown>): void {
  const slot = pool[slotIndex];

  // Send notifications/initialized
  writeJson(slot, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });

  slot.initialized = true;
  slot.initStarted = false;

  const resolver = slot.initResolver;
  slot.initResolver = null;
  slot.initRejecter = null;

  resolver?.();

  // Drain pending init waiters
  const waiting = slot.pendingInit.splice(0);
  for (const fn of waiting) fn();
}

function handleCodexEvent(slotIndex: number, msg: Record<string, unknown>): void {
  const slot = pool[slotIndex];
  const params = msg['params'] as Record<string, unknown> | undefined;
  if (!params) return;

  const meta = params['_meta'] as Record<string, unknown> | undefined;
  const requestId = meta?.['requestId'] as number | undefined;
  const threadId = meta?.['threadId'] as string | undefined;

  const eventMsg = params['msg'] as Record<string, unknown> | undefined;
  if (!eventMsg) return;

  const eventType = eventMsg['type'] as string | undefined;

  // Find the inflight entry
  let entry: InFlightEntry | undefined;
  if (requestId !== undefined) {
    entry = slot.inflight.get(requestId);
  }

  if (!entry) {
    // Try finding by threadId
    if (threadId) {
      for (const [, e] of slot.inflight) {
        if (e.accumulator.threadId === threadId) {
          entry = e;
          break;
        }
      }
    }
    if (!entry) {
      logger.debug({ slotIndex, eventType, requestId, threadId }, 'Orphaned codex/event');
      return;
    }
  }

  if (entry.accumulator.settled) return;

  // Update threadId from event if not set
  if (threadId && !entry.accumulator.threadId) {
    entry.accumulator.threadId = threadId;
  }

  // Qualquer evento recebido prova que o processo Codex esta vivo e comunicando.
  // Marcar progresso aqui (uma unica vez por evento) cobre TODOS os tipos de evento,
  // inclusive os nao tratados explicitamente (ex: plan_update). Sem isso, spans longos
  // de raciocinio que so emitem eventos no default case do switch fazem o watchdog
  // matar o processo prematuramente. Ver BUGFIXTESTESV1.md Bug #4.
  markInflightProgress(slotIndex, entry);

  // Sinal generico pro caller (executeAgent watchdog). Mesma logica do
  // markInflightProgress mas em outra camada — qualquer evento prova vida.
  // Sem isso, eventos como plan_update reseta a watchdog do bridge mas nao
  // a watchdog externa em execute.ts. Ver Bug #7.
  entry.callbacks.onActivity?.();

  switch (eventType) {
    // Text streaming. Current codex CLI (rust-v0.128+) emits BOTH
    // `agent_message_delta` AND `agent_message_content_delta` carrying the
    // same delta. Dedupe SIMETRICA: o PRIMEIRO canal a chegar pra este turn
    // ganha e silencia o outro pra todos os chunks seguintes. Antes a dedupe
    // era unidirecional (so protegia content_delta quando ja viu delta), o
    // que falhava na ordem inversa (content_delta primeiro, delta depois)
    // duplicando o primeiro chunk — causa raiz dos outputs "VouVou", "{ {",
    // JSON sequencial duplicado.
    case 'agent_message_delta': {
      if (entry.accumulator.sawAgentMessageContentDelta) break;
      entry.accumulator.sawAgentMessageDelta = true;
      const delta = eventMsg['delta'] as string | undefined;
      if (delta) {
        entry.accumulator.content += delta;
        entry.callbacks.onText?.(delta);
      }
      break;
    }
    case 'agent_message_content_delta': {
      if (entry.accumulator.sawAgentMessageDelta) break;
      entry.accumulator.sawAgentMessageContentDelta = true;
      const delta = eventMsg['delta'] as string | undefined;
      if (delta) {
        entry.accumulator.content += delta;
        entry.callbacks.onText?.(delta);
      }
      break;
    }

    case 'reasoning_content_delta':
    case 'reasoning_raw_content_delta':
    case 'agent_reasoning_delta': {
      const delta = eventMsg['delta'] as string | undefined;
      if (delta) {
        entry.callbacks.onReasoning?.(delta);
      }
      break;
    }

    case 'agent_message': {
      // Fallback: use as content if we have no deltas yet (older flow / non-streaming).
      const text = (eventMsg['message'] ?? eventMsg['content']) as string | undefined;
      if (text && !entry.accumulator.content) {
        entry.accumulator.content = text;
      }
      break;
    }

    // Higher-level wrappers in newer codex versions. Each represents a
    // turn-item lifecycle (message, tool call, file change, etc) but the
    // detail-level events (deltas, exec_*, patch_*) carry the actual content
    // we already handle above. So we just acknowledge these to silence the
    // "unhandled" debug log and let the detail events drive callbacks.
    case 'item_started':
    case 'item_completed':
    case 'raw_response_item':
    case 'user_message':
    case 'session_configured':
    case 'task_started':
    case 'mcp_startup_update':
    case 'mcp_startup_complete':
    case 'mcp_list_tools_response':
    case 'terminal_interaction':
    case 'turn_diff':
    // plan_update: agente atualizou seu plano interno. E sinal de vida (ja contado
    // pelo markInflightProgress + onActivity acima), nao precisa traduzir em callback
    // tipado. Tratamos explicitamente so pra evitar log "Unhandled codex event type".
    case 'plan_update':
      break;

    case 'exec_command_begin': {
      const callId = eventMsg['call_id'] as string | undefined;
      const command = eventMsg['command'] as string[] | undefined;
      if (callId && command) {
        entry.accumulator.pendingCommands.set(callId, {
          command,
          startTime: Date.now(),
        });
      }
      // Log temporario do comando real pra rastrear write_stdin/transport-channel-closed.
      // Quando estabilizar pode reduzir pra debug ou remover.
      logger.info(
        { slotIndex, requestId: entry.requestId, callId, command: command?.join(' ') ?? '' },
        'codex exec_command_begin',
      );
      entry.callbacks.onToolUse?.('Bash');
      break;
    }

    case 'exec_command_output_delta': {
      // Badge-only per D5 — ignore streaming output
      break;
    }

    case 'exec_command_end': {
      const callId = eventMsg['call_id'] as string | undefined;
      const exitCode = eventMsg['exit_code'] as number | undefined;
      const durationMs = eventMsg['duration'] as number | undefined;

      const pending = callId ? entry.accumulator.pendingCommands.get(callId) : undefined;
      const cmd = pending ? pending.command.join(' ') : '';
      const elapsed = pending ? Date.now() - pending.startTime : (durationMs ?? 0);

      if (callId) entry.accumulator.pendingCommands.delete(callId);

      const record: CommandRecord = {
        cmd,
        exitCode: exitCode ?? -1,
        durationMs: elapsed,
      };
      entry.accumulator.commandsRun.push(record);
      // Log temporario do exit/duracao com o comando completo.
      logger.info(
        { slotIndex, requestId: entry.requestId, callId, command: cmd, exitCode: exitCode ?? -1, durationMs: elapsed },
        'codex exec_command_end',
      );
      entry.callbacks.onToolUseComplete?.('Bash', {
        command: cmd,
        exitCode: exitCode ?? -1,
        durationMs: elapsed,
      });
      break;
    }

    case 'patch_apply_begin': {
      const callId = eventMsg['call_id'] as string | undefined;
      const changes = eventMsg['changes'] as Record<string, { kind?: string }> | undefined;

      // Determine if any file is new (Write) or modified (Edit)
      let toolType = 'Edit';
      if (changes) {
        const kinds = Object.values(changes).map((c) => c.kind ?? '');
        if (kinds.some((k) => k === 'create' || k === 'new')) {
          toolType = 'Write';
        }
      }

      if (callId) {
        entry.accumulator.pendingPatches.set(callId, toolType);
      }

      entry.callbacks.onToolUse?.(toolType);
      break;
    }

    case 'patch_apply_end': {
      const callId = eventMsg['call_id'] as string | undefined;
      const changes = eventMsg['changes'] as Record<string, unknown> | undefined;

      const toolType = (callId ? entry.accumulator.pendingPatches.get(callId) : undefined) ?? 'Edit';
      if (callId) entry.accumulator.pendingPatches.delete(callId);

      // SPEC Camada 4: detector PRIMARIO de patch failure via evento estruturado.
      // Codex CLI varia o shape — checamos defensivamente os campos conhecidos
      // (success, error, stderr) sem assumir versao especifica. Stderr handler
      // serve de fallback caso o evento nao traga signal de falha.
      const success = eventMsg['success'] as boolean | undefined;
      const errorMsg = eventMsg['error'] as string | undefined;
      const eventStderr = eventMsg['stderr'] as string | undefined;
      const isFailure =
        success === false ||
        (typeof errorMsg === 'string' && errorMsg.length > 0) ||
        (typeof eventStderr === 'string' && eventStderr.includes('verification failed'));

      if (isFailure) {
        recordPatchFailure(entry, 'tool-output', errorMsg ?? eventStderr ?? 'patch_apply_end signaled failure');
      }

      // Accumulate changed file paths
      if (changes) {
        for (const filePath of Object.keys(changes)) {
          if (!entry.accumulator.filesChanged.includes(filePath)) {
            entry.accumulator.filesChanged.push(filePath);
          }
        }
      }

      entry.callbacks.onToolUseComplete?.(toolType, { filesChanged: changes ? Object.keys(changes) : [] });
      break;
    }

    case 'mcp_tool_call_begin': {
      const name = eventMsg['tool_name'] as string | undefined;
      entry.callbacks.onToolUse?.(`mcp:${name ?? 'unknown'}`);
      break;
    }

    case 'mcp_tool_call_end': {
      const name = eventMsg['tool_name'] as string | undefined;
      entry.callbacks.onToolUseComplete?.(`mcp:${name ?? 'unknown'}`, {});
      break;
    }

    case 'web_search_begin': {
      entry.callbacks.onToolUse?.('WebSearch');
      break;
    }

    case 'web_search_end': {
      entry.callbacks.onToolUseComplete?.('WebSearch', {});
      break;
    }

    case 'token_count': {
      const info = eventMsg['info'] as Record<string, unknown> | undefined;
      // Prefer total_token_usage (cumulative for the agentic turn).
      // Fallback to last_token_usage for compatibility with older codex CLI.
      const totalUsage = info?.['total_token_usage'] as Record<string, unknown> | undefined;
      const lastUsage = info?.['last_token_usage'] as Record<string, unknown> | undefined;
      const usage = totalUsage ?? lastUsage;
      if (usage) {
        entry.accumulator.usage = {
          inputTokens: (usage['input_tokens'] as number) ?? 0,
          cachedInputTokens: (usage['cached_input_tokens'] as number) ?? 0,
          outputTokens: (usage['output_tokens'] as number) ?? 0,
          reasoningOutputTokens: (usage['reasoning_output_tokens'] as number) ?? 0,
          totalTokens: (usage['total_tokens'] as number) ?? 0,
        };
      }
      break;
    }

    case 'error': {
      const errorMsg = eventMsg['message'] as string | undefined;
      const codexErrorInfo = eventMsg['codex_error_info'] as string | undefined;

      if (!entry.accumulator.settled) {
        entry.accumulator.settled = true;
        clearInflightTimers(entry);

        // The codex CLI serializes CodexErrorInfo with serde rename_all="snake_case",
        // so values arrive as 'server_overloaded' / 'usage_limit_exceeded' / etc.
        // Normalize defensively in case some build/version sends PascalCase
        // (e.g. 'UsageLimitExceeded' → 'usage_limit_exceeded').
        // Order matters: insert underscores BEFORE lowercasing, otherwise the
        // regex finds nothing to match.
        const errKind = (codexErrorInfo ?? '')
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase();

        if (errKind === 'unauthorized') {
          entry.reject(new CodexAuthError(`Codex auth required: ${errorMsg ?? 'Unauthorized'}`));
        } else if (errKind === 'usage_limit_exceeded') {
          entry.reject(new Error('Limite da sua assinatura ChatGPT foi atingido. Aguarde reset ou faca upgrade do plano.'));
        } else if (errKind === 'context_window_exceeded') {
          entry.reject(new Error('Janela de contexto excedida. Reduza o prompt ou troque pra um modelo com janela maior.'));
        } else if (errKind === 'server_overloaded') {
          entry.reject(new Error('Modelo Codex sobrecarregado nos servidores da OpenAI. Aguarde alguns minutos e tente de novo, ou troque pra gpt-5.4 / gpt-5.4-mini que costumam ter mais capacidade.'));
        } else if (errKind === 'cyber_policy') {
          entry.reject(new Error('Codex bloqueou a requisicao por politica de seguranca da OpenAI.'));
        } else if (errKind === 'bad_request') {
          entry.reject(new Error(`Codex rejeitou a requisicao: ${errorMsg ?? 'BadRequest'}`));
        } else if (errKind.startsWith('http_connection_failed')) {
          entry.reject(new Error(`Falha de conexao HTTP com Codex: ${errorMsg ?? errKind}`));
        } else {
          entry.reject(new Error(`Codex error${codexErrorInfo ? ` [${codexErrorInfo}]` : ''}: ${errorMsg ?? 'unknown error'}`));
        }
      }
      break;
    }

    case 'task_complete':
    case 'turn_complete': {
      if (!entry.accumulator.settled) {
        entry.accumulator.settled = true;
        clearInflightTimers(entry);

        // Fallback: try to get last agent message
        const lastMsg = eventMsg['last_agent_message'] as string | undefined;
        if (lastMsg && !entry.accumulator.content) {
          entry.accumulator.content = lastMsg;
        }

        const accum = entry.accumulator;
        const response: CodexResponse = {
          threadId: accum.threadId,
          content: accum.content,
          filesChanged: accum.filesChanged,
          commandsRun: accum.commandsRun,
          usage: accum.usage,
          status: 'completed',
          applyPatchFailures: accum.applyPatchFailures,
          applyPatchFailureSamples: accum.applyPatchFailureSamples,
        };
        entry.resolve(response);
      }
      break;
    }

    case 'turn_aborted': {
      if (!entry.accumulator.settled) {
        entry.accumulator.settled = true;
        clearInflightTimers(entry);
        entry.reject(new CodexUnavailableError('Codex turn was aborted'));
      }
      break;
    }

    default: {
      logger.debug({ slotIndex, eventType }, 'Unhandled codex event type');
      break;
    }
  }
}

function killSlot(slotIndex: number, err: Error): void {
  const slot = pool[slotIndex];
  slot.dead = true;
  slot.initialized = false;
  slot.initStarted = false;

  // Reject init waiters
  const rejecter = slot.initRejecter;
  slot.initResolver = null;
  slot.initRejecter = null;
  rejecter?.(err);

  const pending = slot.pendingInit.splice(0);
  for (const fn of pending) fn(); // drain with dead state

  // Reject all inflight
  for (const [, entry] of slot.inflight) {
    if (!entry.accumulator.settled) {
      entry.accumulator.settled = true;
      clearInflightTimers(entry);
      entry.reject(err);
    }
  }
  slot.inflight.clear();

  // Kill process
  if (slot.child) {
    try { slot.child.kill('SIGTERM'); } catch { /* ignore */ }
    slot.child = null;
  }

  // Release queued sessions
  drainSessionQueue();
}

function clearInflightTimers(entry: InFlightEntry): void {
  if (entry.hardTimeoutHandle !== null) {
    clearTimeout(entry.hardTimeoutHandle);
    entry.hardTimeoutHandle = null;
  }
  if (entry.idleTimeoutHandle !== null) {
    clearTimeout(entry.idleTimeoutHandle);
    entry.idleTimeoutHandle = null;
  }
  entry.abortCleanup?.();
  entry.abortCleanup = null;
}

function failInflight(slotIndex: number, entry: InFlightEntry, err: Error): void {
  if (entry.accumulator.settled) return;

  entry.accumulator.settled = true;
  clearInflightTimers(entry);

  const slot = pool[slotIndex];
  slot.inflight.delete(entry.requestId);

  // A timed out or aborted codex turn leaves the underlying process state
  // uncertain, so discard the whole slot before resolving the caller.
  killSlot(slotIndex, err);
  entry.reject(err);
}

function startHardTimeout(slotIndex: number, entry: InFlightEntry): void {
  entry.hardTimeoutHandle = setTimeout(() => {
    failInflight(slotIndex, entry, new CodexUnavailableError('Codex request timed out'));
  }, entry.timeoutMs);
}

function resetIdleProgressTimer(slotIndex: number, entry: InFlightEntry): void {
  if (entry.idleTimeoutHandle !== null) {
    clearTimeout(entry.idleTimeoutHandle);
  }
  entry.idleTimeoutHandle = setTimeout(() => {
    failInflight(
      slotIndex,
      entry,
      new CodexUnavailableError(`Codex request stalled: no progress for ${Math.round(entry.idleTimeoutMs / 1000)}s`),
    );
  }, entry.idleTimeoutMs);
}

function markInflightProgress(slotIndex: number, entry: InFlightEntry): void {
  resetIdleProgressTimer(slotIndex, entry);
}

/**
 * SPEC-codex-windows-fix.md Camada 4: registra apply_patch verification failure
 * no accumulator do entry. Dedupe temporal: stderr e ignorado se tool-output
 * registrou nos ultimos 500ms (mesma falha emitida em ambos canais).
 */
const PATCH_FAILURE_DEDUPE_WINDOW_MS = 500;
const MAX_PATCH_FAILURE_SAMPLES = 5;

function recordPatchFailure(entry: InFlightEntry, source: 'tool-output' | 'stderr', text: string): void {
  const now = Date.now();
  const accum = entry.accumulator;

  if (source === 'stderr' && now - accum.lastPatchFailureToolOutputTs < PATCH_FAILURE_DEDUPE_WINDOW_MS) {
    // dedupe: tool-output ja contou esta falha
    return;
  }

  accum.applyPatchFailures++;
  if (accum.applyPatchFailureSamples.length < MAX_PATCH_FAILURE_SAMPLES) {
    accum.applyPatchFailureSamples.push({
      source,
      text: text.substring(0, 500),
      ts: now,
    });
  }
  if (source === 'tool-output') {
    accum.lastPatchFailureToolOutputTs = now;
  }

  logger.warn(
    { requestId: entry.requestId, count: accum.applyPatchFailures, source },
    'codex apply_patch failure',
  );
}

function drainSessionQueue(): void {
  while (sessionQueue.length > 0) {
    const slot = pickAvailableSlot();
    if (slot === -1) break;
    const queued = sessionQueue.shift();
    queued?.resolve(slot);
  }
}

function pickAvailableSlot(): number {
  // Return the first slot whose session count is below the per-slot cap.
  // Returns -1 when every slot already holds MAX_INFLIGHT_PER_SLOT sessions.
  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    if (pool[i].sessionCount < MAX_INFLIGHT_PER_SLOT) {
      return i;
    }
  }
  return -1;
}

async function acquireSlot(): Promise<number> {
  // First pass: find a slot (dead or alive) with capacity
  const slot = pickAvailableSlot();
  if (slot !== -1) return slot;

  // All slots busy — queue
  return new Promise<number>((resolve, reject) => {
    sessionQueue.push({ resolve, reject });
  });
}

// ---- Session implementation ----

class CodexSessionImpl implements CodexSession {
  public threadId: string | null = null;
  private closed = false;

  constructor(
    private slotIndex: number,
    private opts: CodexBridgeOptions,
  ) {}

  async send(prompt: string, cb?: CodexStreamCallbacks, abortSignal?: AbortSignal): Promise<CodexResponse> {
    if (this.closed) {
      throw new CodexUnavailableError('CodexSession is already closed');
    }

    const fullPrompt = this.opts.systemPrompt
      ? `${this.opts.systemPrompt}\n\n${prompt}`
      : prompt;

    const response = await executeRequest(
      this.slotIndex,
      {
        name: 'codex',
        arguments: {
          prompt: fullPrompt,
          model: this.opts.model,
          'approval-policy': this.opts.approvalPolicy ?? 'auto-edit',
          sandbox: this.opts.sandbox ?? 'workspace-write',
          cwd: this.opts.cwd,
          ...(this.opts.reasoningEffort ? { 'reasoning-effort': this.opts.reasoningEffort } : {}),
        },
      },
      cb ?? {},
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      abortSignal,
    );

    this.threadId = response.threadId;
    return response;
  }

  async reply(message: string, cb?: CodexStreamCallbacks, abortSignal?: AbortSignal): Promise<CodexResponse> {
    if (this.closed) {
      throw new CodexUnavailableError('CodexSession is already closed');
    }

    const threadId = this.threadId;
    if (!threadId) {
      throw new CodexUnavailableError('Cannot reply: no active threadId. Call send() first.');
    }

    const response = await executeRequest(
      this.slotIndex,
      {
        name: 'codex-reply',
        arguments: {
          threadId,
          prompt: message,
        },
      },
      cb ?? {},
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      abortSignal,
    );

    this.threadId = response.threadId || threadId;
    return response;
  }

  close(): void {
    this.closed = true;
    const slot = pool[this.slotIndex];
    if (slot.sessionCount > 0) {
      slot.sessionCount--;
    }
    // Process stays alive until resetCodexPool() is called at pipeline completion.
    // Idle codex processes don't consume rate-limit (only inflight requests do),
    // so it's fine to keep them around for the duration of the pipeline.
    drainSessionQueue();
  }
}

/**
 * Force-kill alive codex mcp-server processes in the pool. Sessions are
 * left in their owners' hands (caller is responsible for not using them again),
 * inflight requests are rejected. The next createCodexSession lazily respawns.
 *
 * S4.3 (Onda 4): quando `projectId` e fornecido, mata APENAS os slots cujo
 * `slot.projectId === projectId`. Isso permite que pipelines em projetos
 * diferentes coexistam — uma transicao de fase em um projeto nao afeta o pool
 * de outro projeto. Sem `projectId`, mantem o comportamento legado de matar
 * o pool inteiro (usado por shutdown ou cleanup global).
 *
 * Called by pipeline-engine on phase boundary (D2: fresh state per phase).
 */
export function resetCodexPool(projectId?: string): void {
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    if (!slot.child) continue;
    if (projectId !== undefined && slot.projectId !== projectId) continue;

    logger.info({ slotIndex: i, projectId, slotProjectId: slot.projectId }, 'resetCodexPool: killing codex process');
    // Reject any inflight requests on this slot.
    for (const [, entry] of slot.inflight) {
      if (!entry.accumulator.settled) {
        entry.accumulator.settled = true;
        clearInflightTimers(entry);
        entry.reject(new CodexUnavailableError('Codex pool reset by phase transition'));
      }
    }
    slot.inflight.clear();
    try { slot.child.kill('SIGTERM'); } catch { /* ignore */ }
    slot.child = null;
    slot.dead = true;
    slot.sessionCount = 0;
    slot.projectId = undefined;
  }
  drainSessionQueue();
}

async function executeRequest(
  slotIndex: number,
  toolCall: { name: string; arguments: Record<string, unknown> },
  callbacks: CodexStreamCallbacks,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<CodexResponse> {
  await ensureSlotAlive(slotIndex);

  const slot = pool[slotIndex];
  const reqId = nextRequestId++;

  return new Promise<CodexResponse>((resolve, reject) => {
    const accumulator = {
      content: '',
      filesChanged: [] as string[],
      commandsRun: [] as CommandRecord[],
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      threadId: '',
      settled: false,
      sawAgentMessageDelta: false,
      sawAgentMessageContentDelta: false,
      pendingCommands: new Map<string, { command: string[]; startTime: number }>(),
      pendingPatches: new Map<string, string>(),
      applyPatchFailures: 0,
      applyPatchFailureSamples: [] as CodexPatchFailureSample[],
      lastPatchFailureToolOutputTs: 0,
    };

    // Wrap resolve/reject so the slot is released and the queue is drained
    // as soon as this inflight entry settles.
    const wrappedResolve = (res: CodexResponse): void => {
      slot.inflight.delete(reqId);
      drainSessionQueue();
      resolve(res);
    };
    const wrappedReject = (err: Error): void => {
      slot.inflight.delete(reqId);
      drainSessionQueue();
      reject(err);
    };

    const entry: InFlightEntry = {
      resolve: wrappedResolve,
      reject: wrappedReject,
      callbacks,
      accumulator,
      requestId: reqId,
      timeoutMs,
      idleTimeoutMs: Math.min(timeoutMs, DEFAULT_IDLE_PROGRESS_TIMEOUT_MS),
      hardTimeoutHandle: null,
      idleTimeoutHandle: null,
      abortCleanup: null,
    };

    slot.inflight.set(reqId, entry);
    startHardTimeout(slotIndex, entry);
    resetIdleProgressTimer(slotIndex, entry);

    if (abortSignal) {
      if (abortSignal.aborted) {
        failInflight(slotIndex, entry, new CodexUnavailableError('Codex request aborted'));
        return;
      }

      const onAbort = (): void => {
        failInflight(slotIndex, entry, new CodexUnavailableError('Codex request aborted'));
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      entry.abortCleanup = () => abortSignal.removeEventListener('abort', onAbort);
    }

    writeJson(slot, {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
  });
}

// ---- Public API ----

export async function createCodexSession(opts: CodexBridgeOptions): Promise<CodexSession> {
  const slotIndex = await acquireSlot();
  pool[slotIndex].sessionCount++;
  // S4.3: marca o slot com o projectId da sessao para suportar reset filtrado.
  // Como cada slot suporta apenas 1 sessao concorrente (MAX_INFLIGHT_PER_SLOT=1),
  // o projectId mais recente representa fielmente o owner do slot.
  pool[slotIndex].projectId = opts.projectId;
  return new CodexSessionImpl(slotIndex, opts);
}

export async function shutdownCodexBridge(): Promise<void> {
  logger.info('Shutting down codex bridge');

  const killPromises: Promise<void>[] = [];

  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    const slot = pool[i];
    if (!slot.dead && slot.child) {
      const child = slot.child;
      killPromises.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve();
          }, 1000);

          child.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });

          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }),
      );
      killSlot(i, new CodexUnavailableError('Bridge shutting down'));
    }
  }

  await Promise.all(killPromises);

  // Reject all queued sessions
  const queued = sessionQueue.splice(0);
  for (const q of queued) {
    q.reject(new CodexUnavailableError('Bridge is shutting down'));
  }

  logger.info('Codex bridge shutdown complete');
}

/**
 * FOR TESTING ONLY. Resets the module-level pool to a clean dead state so
 * each test starts fresh without reusing slots from previous tests.
 * Not exported from the public API — only accessible via the named export below.
 */
export function _resetPoolForTesting(): void {
  if (process.env['NODE_ENV'] !== 'test' && !process.env['VITEST']) {
    throw new Error('_resetPoolForTesting can only be called in test environment');
  }
  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    const slot = pool[i];
    // Kill child if alive
    if (slot.child) {
      try { slot.child.kill(); } catch { /* ignore */ }
      slot.child = null;
    }
    // Reject pending inits
    slot.initRejecter?.(new CodexUnavailableError('Test reset'));
    for (const [, entry] of slot.inflight) {
      if (!entry.accumulator.settled) {
        entry.accumulator.settled = true;
        entry.reject(new CodexUnavailableError('Test reset'));
      }
      clearInflightTimers(entry);
    }
    // Clear all state
    slot.inflight.clear();
    slot.pendingInit.length = 0;
    slot.stdoutBuf = '';
    slot.initialized = false;
    slot.dead = true;
    slot.initStarted = false;
    slot.initResolver = null;
    slot.initRejecter = null;
    slot.sessionCount = 0;
    slot.projectId = undefined;
  }
  // Clear session queue
  sessionQueue.splice(0).forEach((q) => q.reject(new CodexUnavailableError('Test reset')));
  nextRequestId = 100;
}
