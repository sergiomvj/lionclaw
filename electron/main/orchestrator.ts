import { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';
import { getAllAgents, getAgent, insertMessage, insertAuditEntry, createSession, getSetting, insertTokenUsage, updateSessionTokens, getActiveSession, getSession, getEnabledTools, getSessionMessages, insertTaskExecution } from './db';
import { setActiveAgentId } from './knowledge-state';
import { extractAndProcessOnboardingData } from './onboarding';
import { calculateCost } from './pricing';
import { getApiKey } from './secrets-vault';
import { createPermissionGuard } from './permission-guard';
import { getMCPConfigForAgent } from './mcp-manager';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import { getDisabledSDKMcps } from './mcp-discovery';
import { captureToolUse, captureToolResult, resetArtifactDetector } from './artifact-detector';
import { buildSystemPrompt } from './prompt-builder';
import { getAgentCwd, getLionClawHome } from './paths';
import { getLocalAgentsDescription } from './local-agent-tools';
import crypto from 'crypto';
import type { StreamChunk, AuditEntry, AgentConfig, ArtifactData } from '../../src/types';
import { generateSessionTitle } from './title-generator';
import { messageQueue } from './message-queue';
import type { QueuedMessage } from './message-queue';

const logger = createLogger('orchestrator');

let currentAbortController: AbortController | null = null;

// Flag em memoria: true quando o SDK tem a sessao carregada no processo atual.
// Morre naturalmente quando o Electron reinicia.
let sdkSessionAlive = false;

/** Reset SDK session state. Called by ipc-handlers after clearing session files. */
export function resetSdkSessionState(): void {
  sdkSessionAlive = false;
}

// ---- Message Queue Integration ----

/**
 * Public entry point: enqueues a message and starts processing if idle.
 * Returns immediately - the queue processes in the background.
 */
export function submitMessage(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): void {
  messageQueue.enqueue({
    message,
    options,
    enqueuedAt: Date.now(),
  });

  if (!messageQueue.isProcessing) {
    processQueue(getWindow);
  }
}

async function processQueue(getWindow: () => BrowserWindow | null): Promise<void> {
  if (messageQueue.isProcessing) return;
  messageQueue.isProcessing = true;

  try {
    while (messageQueue.length > 0) {
      const item = messageQueue.dequeue()!;
      logger.info(
        { queueLength: messageQueue.length, message: item.message.substring(0, 80) },
        'Processing queued message',
      );
      await executeQuery(item.message, item.options, getWindow);
    }
  } finally {
    messageQueue.isProcessing = false;
  }
}

async function buildAgentDefinitions(): Promise<Record<string, Record<string, unknown>>> {
  // Only CLOUD agents become SDK subagents. Local agents are accessed via run_local_agent MCP tool.
  const agents = getAllAgents().filter(
    (a: AgentConfig) => a.isActive && a.runtime !== 'local',
  );
  const definitions: Record<string, Record<string, unknown>> = {};

  for (const agent of agents) {
    const config = await resolveAgentQueryConfig(agent.id);

    definitions[agent.id] = {
      description: agent.description,
      tools: config.allowedTools.length > 0 ? config.allowedTools : undefined,
      prompt: config.systemPrompt || undefined,
      model: agent.model !== 'default' ? agent.model : undefined,
      maxTurns: config.maxTurns || undefined,
      mcpServers: config.mcpServers.length > 0 ? config.mcpServers : [],
    };
  }

  return definitions;
}

export interface QueryOptions {
  sessionId?: string;
  agentId?: string;
  model?: string;
  silent?: boolean;
  /** When set, this text is saved to the DB instead of the full message.
   *  Useful for Telegram where system context is prepended but should not be visible. */
  displayMessage?: string;
  /** Force a fresh SDK session (skip resume). Used internally for retry after EPIPE. */
  _forceNewSession?: boolean;
  attachments?: Array<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    data: string;
    size: number;
  }>;
}

export async function executeQuery(
  message: string,
  options: QueryOptions,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    sendStream(getWindow, options.silent, { type: 'error', error: 'API key nao configurada. Va em Settings.' });
    return;
  }

  // ---- Session management ----
  let sessionId = options.sessionId;
  let shouldContinueSession = false;

  if (!sessionId) {
    const activeSession = getActiveSession();

    if (activeSession) {
      sessionId = activeSession.id;
      // Existing active session: continue the SDK conversation
      shouldContinueSession = true;
    } else {
      sessionId = crypto.randomUUID();
      createSession(sessionId, '');
      // Brand new session: don't continue
      shouldContinueSession = false;
    }
  } else {
    // SessionId was passed explicitly (follow-up message)
    // Only continue if session already has messages (not freshly created after compaction/clear)
    const existingMessages = getSessionMessages(sessionId);
    shouldContinueSession = existingMessages.length > 0;
    if (options._forceNewSession) {
      shouldContinueSession = false;
      logger.info({ sessionId }, 'Forced fresh SDK session (retry after resume failure)');
    } else if (!shouldContinueSession) {
      logger.info({ sessionId }, 'Session has no messages, starting fresh SDK session (post-compaction)');
    }
  }

  // Inform renderer which session is active
  sendStream(getWindow, options.silent, { type: 'session', content: sessionId });

  // Wrapper que inclui sessionId em todos os chunks
  const sendSessionStream = (chunk: StreamChunk) => {
    sendStream(getWindow, options.silent, { ...chunk, sessionId });
  };

  // Skip inserting user message on retry (already inserted in the first attempt)
  if (!options._forceNewSession) {
    insertMessage(sessionId, 'user', options.displayMessage ?? message);
  }

  const agent = options.agentId ? getAllAgents().find((a) => a.id === options.agentId) : undefined;
  const model = agent?.model || options.model || getSetting('default_model') || 'sonnet';

  // Track which agent is active so the knowledge-base MCP subprocess can resolve the agent scope
  if (options.agentId) {
    setActiveAgentId(options.agentId);
  }

  // Build system prompt with modular architecture
  const isOnboarding = getSetting('onboarding_completed') !== 'true';
  const fullSystemPrompt = buildSystemPrompt(options.agentId, {
    mode: 'full',
    isOnboarding,
  });

  const permissionGuard = createPermissionGuard(getWindow, { isOnboarding });
  currentAbortController = new AbortController();

  // Process image attachments
  let finalMessage = message;
  if (options.attachments && options.attachments.length > 0) {
    const imagePaths: string[] = [];
    for (const att of options.attachments) {
      if (att.type === 'image') {
        const ext = att.mimeType.split('/')[1] || 'png';
        const tmpPath = path.join(os.tmpdir(), `lionclaw-img-${att.id}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(att.data, 'base64'));
        imagePaths.push(tmpPath);
      }
    }
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map((p, i) =>
        `[Imagem ${i + 1}: ${p}]`
      ).join('\n');
      finalMessage = `${imageRefs}\n\n${message || 'O usuario enviou estas imagens. Use a ferramenta Read para visualizar cada uma e responda sobre elas.'}`;
    }
  }

  if (isOnboarding) {
    logger.info({ promptLength: fullSystemPrompt.length, hasTools: false }, 'Onboarding: text-only prompt, no tools');
  }

  // Resolve MCP server config for this agent (or all active servers if no agentId)
  let mcpServers = await getMCPConfigForAgent(options.agentId);

  // Auto-inject local-agents MCP server when any agent uses local runtime
  const hasLocalAgent = getAllAgents().some((a: AgentConfig) => a.isActive && a.runtime === 'local');
  if (hasLocalAgent) {
    const localAgentsPath = path.join(__dirname, '../../mcp-servers/local-agents/dist/index.js');
    const resolvedPath = fs.existsSync(localAgentsPath)
      ? localAgentsPath
      : path.join(process.cwd(), 'mcp-servers/local-agents/dist/index.js');

    const lionclawHome = getLionClawHome();

    if (mcpServers) {
      if (!mcpServers['local-agents']) {
        mcpServers['local-agents'] = {
          command: 'node',
          args: [resolvedPath],
          env: { LIONCLAW_HOME: lionclawHome },
        };
      }
    } else {
      mcpServers = {
        'local-agents': {
          command: 'node',
          args: [resolvedPath],
          env: { LIONCLAW_HOME: lionclawHome },
        },
      };
    }
  }

  // Pre-compute subagent definitions before entering the SDK query (async-safe).
  const agentDefinitions = isOnboarding ? {} : await buildAgentDefinitions();

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    resetArtifactDetector();

    let assistantContent = '';
    let inTool = false;
    let currentToolName: string | null = null;
    // Collect artifacts so they can be persisted alongside the message in SQLite
    const collectedArtifacts: ArtifactData[] = [];
    // Token tracking (input includes cache_read + cache_creation)
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnCacheReadTokens = 0;
    let turnCacheCreationTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    // Subagent token tracking: tool_use_id -> accumulated tokens
    const subagentTokens = new Map<string, {
      agentId: string | null;
      agentName: string | null;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      requestCount: number;
    }>();

    // Task lifecycle: tool_use_id -> task metadata
    const taskMap = new Map<string, {
      taskId: string;
      description: string;
      agentId: string | null;
    }>();

    // Bridge variable between SubagentStart hook and task_started event
    let pendingAgentId: string | null = null;

    const q = query({
      prompt: finalMessage,
      options: {
        cwd: getAgentCwd(isOnboarding),
        model,
        includePartialMessages: true,
        systemPrompt: isOnboarding
          ? fullSystemPrompt
          : {
              type: 'preset',
              preset: 'claude_code' as const,
              append: fullSystemPrompt,
            },
        ...(isOnboarding
          ? {
              allowedTools: [],
              settingSources: [],
              env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
            }
          : {
              // Tools come from user settings (configurable in Settings > Ferramentas)
              allowedTools: getEnabledTools(),
              permissionMode: 'bypassPermissions' as const,
              allowDangerouslySkipPermissions: true,
              settingSources: ['project', 'user'],
              canUseTool: (tool: string, input: Record<string, unknown>) => permissionGuard(tool, input),
              agents: agentDefinitions,
              hooks: {
                SubagentStart: [{
                  hooks: [async (input: Record<string, unknown>) => {
                    pendingAgentId = (input as { agent_id: string }).agent_id;
                    return { continue: true };
                  }],
                }],
              },
            }
        ),
        ...(shouldContinueSession && sdkSessionAlive
          ? { continue: true }
          : shouldContinueSession && !sdkSessionAlive
            ? { resume: sessionId }
            : { sessionId }),
        abortController: currentAbortController,
        ...(!isOnboarding && mcpServers ? { mcpServers } : {}),
      },
    });

    // Toggle off SDK MCPs that the user disabled locally
    // Also disable Claude SDK Excalidraw when our own MCP is active
    if (!isOnboarding) {
      const disabledSdkMcps = getDisabledSDKMcps();

      // Auto-disable Claude SDK Excalidraw if our builtin Excalidraw MCP is registered
      const hasBuiltinExcalidraw = mcpServers && Object.keys(mcpServers).includes('excalidraw');
      if (hasBuiltinExcalidraw) {
        disabledSdkMcps.push('claude_ai_Excalidraw');
      }

      for (const name of disabledSdkMcps) {
        try {
          await q.toggleMcpServer(name, false);
        } catch {
          // Server may not exist anymore, ignore
        }
      }
    }

    for await (const sdkMessage of q) {
      if (sdkMessage.type === 'stream_event') {
        const event = sdkMessage.event as Record<string, unknown>;

        if (event.type === 'content_block_start') {
          const contentBlock = event.content_block as Record<string, unknown>;
          if (contentBlock.type === 'tool_use') {
            currentToolName = contentBlock.name as string;
            inTool = true;
            sendSessionStream({
              type: 'tool_call',
              tool: currentToolName,
              input: {},
            });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === 'text_delta' && !inTool) {
            const text = delta.text as string;
            assistantContent += text;
            sendSessionStream({ type: 'text', content: text });
          }
        } else if (event.type === 'content_block_stop') {
          if (inTool && currentToolName) {
            inTool = false;
            currentToolName = null;
          }
        } else if (event.type === 'message_start') {
          // Check if this message belongs to a subagent
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as string | null | undefined;

          // Accumulate previous turn before starting new one
          totalInputTokens += turnInputTokens;
          totalOutputTokens += turnOutputTokens;
          totalCacheReadTokens += turnCacheReadTokens;
          totalCacheCreationTokens += turnCacheCreationTokens;
          turnOutputTokens = 0;
          turnCacheReadTokens = 0;
          turnCacheCreationTokens = 0;

          const msg = event.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, number> | undefined;
          if (usage) {
            const inputBase = usage.input_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;
            turnInputTokens = inputBase + cacheRead + cacheCreation;
            turnCacheReadTokens = cacheRead;
            turnCacheCreationTokens = cacheCreation;

            // Track subagent tokens separately when parent_tool_use_id is set
            if (parentToolUseId) {
              const msgModel = (msg?.model as string) || model;
              logger.debug({ parentToolUseId, msgModel, inputBase, cacheRead, cacheCreation }, 'Subagent stream_event message_start');
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.inputTokens += turnInputTokens;
                existing.cacheReadTokens += cacheRead;
                existing.cacheCreationTokens += cacheCreation;
                existing.requestCount += 1;
                if (msgModel && !existing.model) {
                  existing.model = msgModel;
                }
              } else {
                subagentTokens.set(parentToolUseId, {
                  agentId: null,
                  agentName: null,
                  model: msgModel,
                  inputTokens: turnInputTokens,
                  outputTokens: 0,
                  cacheReadTokens: cacheRead,
                  cacheCreationTokens: cacheCreation,
                  requestCount: 1,
                });
              }
            }

            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: totalInputTokens + turnInputTokens,
                outputTokens: totalOutputTokens,
                cacheReadTokens: totalCacheReadTokens + cacheRead,
                cacheCreationTokens: totalCacheCreationTokens + cacheCreation,
              },
            });
          }
        } else if (event.type === 'message_delta') {
          const parentToolUseId = (sdkMessage as Record<string, unknown>).parent_tool_use_id as string | null | undefined;
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            turnOutputTokens = usage.output_tokens || 0;

            // Accumulate subagent output tokens
            if (parentToolUseId) {
              const existing = subagentTokens.get(parentToolUseId);
              if (existing) {
                existing.outputTokens += turnOutputTokens;
              }
            }

            sendSessionStream({
              type: 'usage',
              usage: {
                inputTokens: totalInputTokens + turnInputTokens,
                outputTokens: totalOutputTokens + turnOutputTokens,
                cacheReadTokens: totalCacheReadTokens + turnCacheReadTokens,
                cacheCreationTokens: totalCacheCreationTokens + turnCacheCreationTokens,
              },
            });
          }
        }

      } else if (sdkMessage.type === 'assistant') {
        // Complete assistant message - use for audit log and tool call details
        // Log all block types for debugging
        const blockTypes = sdkMessage.message.content.map((b: Record<string, unknown>) => b.type);
        logger.info({ blockTypes }, 'Assistant message block types');

        for (const block of sdkMessage.message.content) {
          const blockAny = block as Record<string, unknown>;

          // Capture both tool_use and mcp_tool_use for artifact detection
          if (block.type === 'tool_use' || blockAny.type === 'mcp_tool_use') {
            const toolName = (blockAny.name as string) || '';
            const toolInput = (blockAny.input as Record<string, unknown>) || {};
            const toolId = (blockAny.id as string) || crypto.randomUUID();

            logger.info({ blockType: blockAny.type, toolName, toolId }, 'Captured tool_use/mcp_tool_use block');

            const toolCallEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
              sessionId,
              subagent: options.agentId,
              eventType: 'tool_call',
              toolName,
              input: JSON.stringify(toolInput).substring(0, 1000),
            };
            insertAuditEntry(toolCallEntry);
            sendLogEntry(getWindow, toolCallEntry);

            // Detect artifact from tool input
            const artifact = captureToolUse(toolId, toolName, toolInput);
            if (artifact) {
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }

          // Capture MCP tool results for pending artifacts
          if (blockAny.type === 'mcp_tool_result' || blockAny.type === 'tool_result') {
            const resultContent = typeof blockAny.content === 'string'
              ? blockAny.content
              : Array.isArray(blockAny.content)
                ? (blockAny.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                : '';
            logger.info(
              { toolUseId: blockAny.tool_use_id, isError: blockAny.is_error, contentLength: resultContent.length, contentSnippet: resultContent.substring(0, 200) },
              'Captured mcp_tool_result block',
            );
            const artifact = captureToolResult(
              blockAny.tool_use_id as string,
              resultContent,
              blockAny.is_error as boolean,
            );
            if (artifact) {
              logger.info({ artifactType: artifact.type, artifactTitle: artifact.title }, 'Artifact created, sending to renderer');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        // Fallback: if we missed any text deltas, send what's missing
        const fullText = sdkMessage.message.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { type: string; text?: string }) => b.text || '')
          .join('');
        if (fullText && fullText.length > assistantContent.length) {
          const missing = fullText.slice(assistantContent.length);
          if (missing) {
            sendSessionStream({ type: 'text', content: missing });
          }
          assistantContent = fullText;
        }

      } else if (sdkMessage.type === 'user') {
        // Tool results arrive in user-role messages, not assistant messages.
        // This is where mcp_tool_result and tool_result blocks actually live.
        // The SDK shape mirrors the assistant message: sdkMessage.message.content[].
        const userMsg = sdkMessage.message as { content?: Array<Record<string, unknown>> };
        const userContent = Array.isArray(userMsg?.content) ? userMsg.content : [];
        for (const block of userContent) {
          if (block.type === 'mcp_tool_result' || block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<{ text?: string }>).map((b) => b.text || '').join('')
                : '';
            logger.info(
              { toolUseId: block.tool_use_id, isError: block.is_error, contentLength: resultContent.length, contentSnippet: resultContent.substring(0, 200) },
              'Captured tool_result from user message',
            );
            const artifact = captureToolResult(
              block.tool_use_id as string,
              resultContent,
              block.is_error as boolean,
            );
            if (artifact) {
              logger.info({ artifactType: artifact.type, artifactTitle: artifact.title }, 'Artifact created from user tool_result, sending to renderer');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }

      } else if (sdkMessage.type === 'result') {
        // Detect ARQUIVO_AUDIO in assistant text (fallback for MCP tool results
        // that don't appear as mcp_tool_result blocks in assistant messages)
        if (assistantContent.includes('ARQUIVO_AUDIO:')) {
          const audioMatches = assistantContent.matchAll(/ARQUIVO_AUDIO:\s*(.+?)(?:\n|$)/g);
          for (const match of audioMatches) {
            const audioPath = match[1].trim();
            const artifact = captureToolResult('text-detect', `ARQUIVO_AUDIO: ${audioPath}`, false);
            if (artifact) {
              logger.info({ artifactType: artifact.type, audioPath }, 'Audio artifact detected from assistant text');
              collectedArtifacts.push(artifact);
              sendSessionStream({ type: 'artifact', artifact });
            }
          }
        }
        sendSessionStream({ type: 'done', content: sessionId });
      } else {
        // Detectar eventos de sistema do SDK (compactacao, status, task lifecycle)
        const msgAny = sdkMessage as Record<string, unknown>;
        if (msgAny.type === 'system') {
          const subtype = msgAny.subtype as string;

          if (subtype === 'status') {
            const status = msgAny.status as string | null;
            if (status === 'compacting') {
              sendSessionStream({ type: 'compacting', isCompacting: true });
              logger.info({ sessionId }, 'SDK compaction started');
            } else if (status === null) {
              sendSessionStream({ type: 'compacting', isCompacting: false });
              logger.info({ sessionId }, 'SDK compaction finished');
            }
          }

          if (subtype === 'compact_boundary') {
            const metadata = msgAny.compact_metadata as { trigger: string; pre_tokens: number };
            logger.info(
              { sessionId, trigger: metadata.trigger, preTokens: metadata.pre_tokens },
              'SDK compact boundary',
            );
            insertAuditEntry({
              sessionId,
              eventType: 'tool_call',
              toolName: 'system:sdk_compaction',
              output: `Compactacao ${metadata.trigger}: ${metadata.pre_tokens} tokens antes`,
            });
          }

          if (subtype === 'task_started') {
            const taskId = msgAny.task_id as string;
            const toolUseId = msgAny.tool_use_id as string;
            const description = (msgAny.description as string) || '';
            const taskType = (msgAny.task_type as string) || '';

            // Resolve agent_id with multiple strategies:
            // 1. pendingAgentId from SubagentStart hook
            // 2. task_type field (SDK may pass agent key here)
            // 3. Validate against agents table to avoid storing SDK internal IDs
            const capturedAgentId = pendingAgentId;
            pendingAgentId = null;

            let resolvedId: string | null = null;
            let resolvedName: string | null = null;

            // Try pendingAgentId first (from hook)
            if (capturedAgentId) {
              const agentRecord = getAgent(capturedAgentId);
              if (agentRecord) {
                resolvedId = capturedAgentId;
                resolvedName = agentRecord.name;
              }
            }

            // Try task_type as agent key
            if (!resolvedId && taskType) {
              const agentRecord = getAgent(taskType);
              if (agentRecord) {
                resolvedId = taskType;
                resolvedName = agentRecord.name;
              }
            }

            // If no real agent found, use description as display name
            if (!resolvedName) {
              resolvedName = description || taskId;
            }

            taskMap.set(toolUseId, {
              taskId,
              description,
              agentId: resolvedId,
            });

            // Link the agentId to any subagent token entry already started for this toolUseId
            const tokenEntry = subagentTokens.get(toolUseId);
            if (tokenEntry) {
              tokenEntry.agentId = resolvedId;
              tokenEntry.agentName = resolvedName;
            }

            logger.info({ taskId, toolUseId, agentId: resolvedId, agentName: resolvedName, taskType, description, capturedHookAgentId: capturedAgentId }, 'Task started');
          }

          if (subtype === 'task_notification') {
            const toolUseId = msgAny.tool_use_id as string;
            const taskId = (msgAny.task_id as string) || '';
            const taskStatus = (msgAny.status as string) || 'completed';
            const summary = (msgAny.summary as string) || '';
            const notifUsage = msgAny.usage as Record<string, number> | undefined;

            const taskMeta = taskMap.get(toolUseId);

            // Try multiple keys to find token entry:
            // The parent_tool_use_id on stream_events may differ from the tool_use_id on task events.
            // SDK may use toolUseId, taskId, or taskMeta.taskId as the parent_tool_use_id.
            const tokenEntry = subagentTokens.get(toolUseId)
              || (taskId ? subagentTokens.get(taskId) : undefined)
              || (taskMeta?.taskId ? subagentTokens.get(taskMeta.taskId) : undefined);

            // Also scan all entries for ones that match this task but were keyed differently
            // This handles the case where parent_tool_use_id is a completely different ID
            let fallbackTokenEntry: typeof tokenEntry | undefined;
            if (!tokenEntry && subagentTokens.size > 0) {
              // Find any unmatched entry that has no agentId (orphaned)
              for (const [key, entry] of subagentTokens) {
                if (!taskMap.has(key) && (entry.inputTokens > 0 || entry.outputTokens > 0)) {
                  fallbackTokenEntry = entry;
                  logger.info({ key, toolUseId, taskId }, 'Using fallback orphaned token entry for task_notification');
                  subagentTokens.delete(key);
                  break;
                }
              }
            }

            const effectiveTokens = tokenEntry || fallbackTokenEntry;

            // Resolve agent info
            const resolvedAgentId = taskMeta?.agentId ?? effectiveTokens?.agentId ?? null;
            let resolvedAgentName = effectiveTokens?.agentName ?? taskMeta?.description ?? '';
            if (!resolvedAgentName && resolvedAgentId) {
              const agentRecord = getAgent(resolvedAgentId);
              resolvedAgentName = agentRecord?.name ?? resolvedAgentId;
            }
            if (!resolvedAgentName) {
              resolvedAgentName = summary || taskId || toolUseId;
            }

            const resolvedModel = effectiveTokens?.model || model;
            const inputTokens = effectiveTokens?.inputTokens ?? 0;
            const outputTokens = effectiveTokens?.outputTokens ?? 0;
            const cacheReadTokens = effectiveTokens?.cacheReadTokens ?? 0;
            const cacheCreationTokens = effectiveTokens?.cacheCreationTokens ?? 0;
            const apiRequests = effectiveTokens?.requestCount ?? 0;
            const toolUsesCount = notifUsage?.tool_uses ?? 0;
            const durationMs = notifUsage?.duration_ms ?? 0;

            const costUsd = calculateCost(resolvedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);

            try {
              insertTaskExecution({
                sessionId,
                taskId: taskMeta?.taskId ?? toolUseId,
                toolUseId,
                agentId: resolvedAgentId,
                agentName: resolvedAgentName,
                model: resolvedModel,
                description: taskMeta?.description ?? '',
                status: taskStatus,
                summary,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
                costUsd,
                apiRequests,
                toolUses: toolUsesCount,
                durationMs,
              });

              insertAuditEntry({
                sessionId,
                subagent: resolvedAgentId ?? undefined,
                eventType: 'tool_call',
                toolName: 'system:task_execution',
                output: `Tarefa concluida (${taskStatus}): ${summary || taskMeta?.description || toolUseId} | tokens: ${inputTokens}in/${outputTokens}out | custo: $${costUsd.toFixed(6)}`,
              });

              logger.info(
                { taskId: taskMeta?.taskId, toolUseId, agentId: resolvedAgentId, agentName: resolvedAgentName, inputTokens, outputTokens, costUsd, taskStatus },
                'Task execution recorded',
              );
            } catch (err) {
              logger.error({ err, toolUseId }, 'Failed to insert task execution');
            }

            // Cleanup tracking maps for this task
            taskMap.delete(toolUseId);
            subagentTokens.delete(toolUseId);
            if (taskId) subagentTokens.delete(taskId);
            if (taskMeta?.taskId) subagentTokens.delete(taskMeta.taskId);
          }
        }
      }
    }

    // SDK session is now alive in this process: future messages can use continue: true
    sdkSessionAlive = true;

    // Accumulate final turn
    totalInputTokens += turnInputTokens;
    totalOutputTokens += turnOutputTokens;
    totalCacheReadTokens += turnCacheReadTokens;
    totalCacheCreationTokens += turnCacheCreationTokens;

    // Record token usage, separating main agent from subagents
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      // Calculate tokens consumed by subagents (those already recorded as task_executions)
      let subagentInputTokens = 0;
      let subagentOutputTokens = 0;
      let subagentCacheReadTokens = 0;
      let subagentCacheCreationTokens = 0;

      // Sum up any remaining (not yet task_notification-completed) subagent entries
      for (const entry of subagentTokens.values()) {
        subagentInputTokens += entry.inputTokens;
        subagentOutputTokens += entry.outputTokens;
        subagentCacheReadTokens += entry.cacheReadTokens;
        subagentCacheCreationTokens += entry.cacheCreationTokens;
      }

      // Main agent tokens = total minus subagent tokens
      const mainInputTokens = Math.max(0, totalInputTokens - subagentInputTokens);
      const mainOutputTokens = Math.max(0, totalOutputTokens - subagentOutputTokens);
      const mainCacheReadTokens = Math.max(0, totalCacheReadTokens - subagentCacheReadTokens);
      const mainCacheCreationTokens = Math.max(0, totalCacheCreationTokens - subagentCacheCreationTokens);

      const cost = calculateCost(model, mainInputTokens, mainOutputTokens, mainCacheReadTokens, mainCacheCreationTokens);
      insertTokenUsage({
        sessionId,
        model,
        inputTokens: mainInputTokens,
        outputTokens: mainOutputTokens,
        cacheReadTokens: mainCacheReadTokens,
        cacheCreationTokens: mainCacheCreationTokens,
        costUsd: cost,
        subagent: options.agentId,
      });

      // Record any remaining subagent entries that didn't receive task_notification
      for (const [toolUseId, entry] of subagentTokens.entries()) {
        const subCost = calculateCost(entry.model, entry.inputTokens, entry.outputTokens, entry.cacheReadTokens, entry.cacheCreationTokens);
        insertTokenUsage({
          sessionId,
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          costUsd: subCost,
          subagent: entry.agentId ?? undefined,
        });
        logger.info({ toolUseId, agentId: entry.agentId, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }, 'Recorded orphaned subagent token_usage');
      }

      // updateSessionTokens uses the full total (includes all subagent costs already captured)
      const totalCost = calculateCost(model, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens);
      updateSessionTokens(sessionId, totalInputTokens, totalOutputTokens, totalCost);
      sendSessionStream({
        type: 'usage',
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          cacheCreationTokens: totalCacheCreationTokens,
        },
      });
    }

    if (assistantContent) {
      // Process onboarding data if present, strip marker before saving
      const cleaned = extractAndProcessOnboardingData(assistantContent, {
        sendStream: sendSessionStream,
        onAudit: ({ toolName, input, output }) => {
          insertAuditEntry({ sessionId, eventType: 'tool_call', toolName, input, output });
          sendLogEntry(getWindow, { sessionId, eventType: 'tool_call', toolName, input, output });
        },
      });
      if (cleaned !== null) assistantContent = cleaned;

      const messageMetadata = collectedArtifacts.length > 0
        ? JSON.stringify({ artifacts: collectedArtifacts })
        : undefined;
      insertMessage(sessionId, 'assistant', assistantContent, options.agentId, messageMetadata);
    }

    // Auto-generate session title (fire and forget)
    // Must run AFTER insertMessage so getSessionMessages finds both user + assistant messages
    if (sessionId) {
      const session = getSession(sessionId);
      if (session
        && session.type !== 'scheduled'
        && session.type !== 'telegram'
        && !session.title
      ) {
        const msgs = getSessionMessages(session.id);
        if (msgs.length >= 2) {
          generateSessionTitle(session.id).catch((err) => {
            logger.error({ err, sessionId }, 'Title generation failed');
          });
        }
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      sendSessionStream({ type: 'done', content: sessionId });
      return;
    }
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error({ error, shouldContinueSession, sdkSessionAlive }, 'Orchestrator query failed');

    // If we were trying to resume/continue a session and it failed (EPIPE, subprocess crash),
    // retry once with a fresh SDK session. This preserves the resume feature for the main chat
    // while preventing infinite EPIPE loops when session files are missing/corrupted.
    if (shouldContinueSession && !sdkSessionAlive) {
      sdkSessionAlive = false;
      logger.warn({ sessionId }, 'Resume failed — retrying with fresh SDK session');
      try {
        currentAbortController = null;
        await executeQuery(message, { ...options, sessionId, _forceNewSession: true }, getWindow);
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : 'Erro desconhecido';
        logger.error({ retryErr }, 'Retry with fresh session also failed');
        sendSessionStream({ type: 'error', error: retryMsg });
        const errorEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
          sessionId,
          eventType: 'error',
          output: `Resume failed, retry failed: ${retryMsg}`,
        };
        insertAuditEntry(errorEntry);
        sendLogEntry(getWindow, errorEntry);
        return;
      }
    }

    // Reset session state on any failure to avoid stale continue attempts
    if (shouldContinueSession) {
      sdkSessionAlive = false;
    }

    sendSessionStream({ type: 'error', error: errorMsg });
    const errorEntry: Omit<AuditEntry, 'id' | 'createdAt'> = {
      sessionId,
      eventType: 'error',
      output: errorMsg,
    };
    insertAuditEntry(errorEntry);
    sendLogEntry(getWindow, errorEntry);
  } finally {
    currentAbortController = null;
  }
}

export function stopCurrentQuery(): void {
  // Clear the queue first so no pending messages are processed after abort
  messageQueue.clear();
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

function sendStream(getWindow: () => BrowserWindow | null, silent: boolean | undefined, chunk: StreamChunk): void {
  if (silent) return;
  // Inject queueRemaining into 'done' chunks so the renderer knows
  // whether more queued messages are about to be processed
  const finalChunk = chunk.type === 'done' && messageQueue.length > 0
    ? { ...chunk, queueRemaining: messageQueue.length }
    : chunk;
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:stream', finalChunk);
    }
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}

function sendLogEntry(
  getWindow: () => BrowserWindow | null,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
): void {
  try {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const liveEntry: AuditEntry = {
        id: -1,
        createdAt: new Date().toISOString(),
        ...entry,
      };
      win.webContents.send('logs:entry', liveEntry);
    }
  } catch {
    // Render frame disposed (e.g. GPU crash, window reload)
  }
}
