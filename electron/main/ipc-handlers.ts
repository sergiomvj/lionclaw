import { ipcMain, BrowserWindow, shell, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import crypto from 'crypto';
import {
  getAllSessions,
  getSessionMessages,
  deleteSessionById,
  trashSession,
  getScheduledSessions,
  deleteScheduledSessions,
  updateSessionStatus,
  getActiveSession,
  getUsageStats,
  getSessionTokens,
  getUsageByAgent,
  getTaskExecutions,
  getAllAgents,
  getAgent,
  insertAgent,
  updateAgent,
  deleteAgent,
  queryAuditLog,
  getSetting,
  setSetting,
  seedDefaultAgents,
  getDailySummaries,
  clearAllSessions,
  getToolSettings,
  setToolEnabled,
  getEnabledTools,
  createSession,
  getSession,
  insertWorkflowRun,
  getActiveWorkflowRun,
  cancelWorkflowRun,
  completeWorkflowRun,
  setWorkflowRunGenerating,
  setWorkflowRunActive,
} from './db';
import {
  executeWorkflowChat,
  executeSpecGeneration,
  resetWorkflowSessionState,
} from './workflow-engine';
import { handleDiscoveryMessage, resetDiscoverySessionState } from './discovery-harness';
import { submitMessage, stopCurrentQuery, resetSdkSessionState } from './orchestrator';
import { resolveConfirmation } from './permission-guard';
import { resolveAskQuestion } from './ask-question';
import { runCompaction, searchSemanticMemories, archiveConversation } from './memory-pipeline';
import { listSkills, getSkill, createSkill, updateSkill, updateSkillRaw, deleteSkill } from './skills';
import type { SkillCreateInput } from './skills';
import {
  getAllScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  getTaskRuns,
  reviewTaskRun,
  getPendingReviewCount,
  getActivities,
  getActivityStats,
  getAllTags,
} from './scheduler';
import {
  getAllMCPServers,
  createMCPServer,
  updateMCPServer,
  deleteMCPServer,
  testServer,
  restartServer,
  startServer,
  stopServer,
  discoverAndSaveMCPTools,
} from './mcp-manager';
import {
  discoverSDKMcpServers,
  refreshSDKMcpServers,
  getCachedSDKMcpServers,
  getDisabledSDKMcps,
  setSDKMcpDisabled,
} from './mcp-discovery';
import * as auth from './auth';
import { transcribeAudio, generateSpeech } from './voice-engine';
import { generateImage, editImage } from './image-engine';
import { runOAuthFlow, getGoogleAuthStatus, revokeGoogleAuth } from './google-auth';
import {
  getVaultEntries,
  setVaultSecret,
  deleteVaultSecret,
  checkVaultSecret,
} from './vault-registry';
import { getAllChannels, getChannel, upsertChannel, toggleChannel } from './channels-db';
import { startTelegramBot, stopTelegramBot, isTelegramRunning, onTelegramSessionCompacted } from './telegram-bridge';
import TelegramBot from 'node-telegram-bot-api';
import { loadSoul, saveSoul, loadUser, saveUser } from './prompt-builder';
import { checkOllamaAvailable } from './ollama-client';
import {
  ingestDocument,
  reprocessDocument,
  hybridKnowledgeSearch,
} from './knowledge-engine';
import { runBenchmarkPipeline } from './knowledge-benchmark';
import {
  getAllTasks,
  getTask,
  insertTask,
  updateTask as updateTaskDb,
  deleteTask as deleteTaskDb,
  getTaskCategories,
  getPendingTasksDueCount,
} from './db';
import {
  getKnowledgeSources,
  getKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeAgentConfig,
  upsertKnowledgeAgentConfig,
  insertKnowledgeBenchmark,
  getKnowledgeBenchmark,
  updateKnowledgeBenchmark,
} from './db';
import type { AppSettings, LogFilters, AskQuestionResponse } from '../../src/types';
import {
  buildGraphData,
  readVaultNote,
  searchVault,
  createVaultStructure,
  getVaultStats,
  seedVault,
  listNotesByType,
  findBacklinks,
  deleteVaultNote,
} from './mgraph-engine';
import {
  ingestFile,
  ingestUrl,
  ingestText,
  resumeIngestJob,
  cancelIngest,
  discardPartialJob,
  acceptPartialJob,
  getIngestHistory,
  estimateIngestFile,
} from './graph-ingest';
import {
  insertHarnessProject,
  updateHarnessProject,
  getHarnessProject,
  listHarnessProjects,
  deleteHarnessProject,
  getHarnessSprints,
  getHarnessRounds,
  getHarnessSprintAggregateMetrics,
  getHarnessProjectMetrics,
  getHarnessSprintByIndex,
  insertEnrichSession,
  getEnrichSession,
  listEnrichSessions,
  getEnrichMessages,
  deleteEnrichSession,
  getPipelinePhaseMessages,
  updateHarnessProjectPipelineMeta,
  listPipelineMessagesForSprint,
} from './db';
import type { HarnessEngine } from './harness-engine';
import { readLatestSprintsJson } from './harness-planner';
import type { EnrichSessionRow } from './db';
import type { EnrichSession } from '../../src/types';
import type { PipelineEngine } from './pipeline-engine';
import { getPipelineMetrics } from './db';
import { generatePipelineReport, exportReport as exportPipelineReport } from './pipeline-report';

function mapEnrichSessionRowToApi(row: EnrichSessionRow): EnrichSession {
  return {
    id: row.id,
    name: row.name,
    specPath: row.specPath,
    projectPath: row.projectPath ?? undefined,
    prdPath: row.prdPath ?? undefined,
    userMessage: row.userMessage ?? undefined,
    validatorAgentId: row.validatorAgentId,
    enricherAgentId: row.enricherAgentId,
    phase: row.phase,
    status: row.status,
    finalSpecPath: row.finalSpecPath ?? undefined,
    validatorMetrics: {
      inputTokens: row.validatorInputTokens,
      outputTokens: row.validatorOutputTokens,
      cacheReadTokens: row.validatorCacheReadTokens,
      cacheCreationTokens: row.validatorCacheCreationTokens,
      costUsd: row.validatorCostUsd,
      durationMs: row.validatorDurationMs,
      toolUses: row.validatorToolUses,
      apiRequests: row.validatorApiRequests,
      messages: row.validatorMessages,
    },
    enricherMetrics: {
      inputTokens: row.enricherInputTokens,
      outputTokens: row.enricherOutputTokens,
      cacheReadTokens: row.enricherCacheReadTokens,
      cacheCreationTokens: row.enricherCacheCreationTokens,
      costUsd: row.enricherCostUsd,
      durationMs: row.enricherDurationMs,
      toolUses: row.enricherToolUses,
      apiRequests: row.enricherApiRequests,
      messages: row.enricherMessages,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const logger = createLogger('ipc');

interface RebuiltMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

function rebuildMessagesFromNotes(notesContent: string): RebuiltMessage[] {
  const messages: RebuiltMessage[] = [];
  const lines = notesContent.split('\n');
  let id = 1;

  for (const line of lines) {
    const fieldMatch = line.match(/^\*\*(.+?)\*\*:\s*(.+)/);
    if (fieldMatch && fieldMatch[2] && fieldMatch[2] !== '[pendente - usuario nao definiu]') {
      messages.push({ id: id++, role: 'assistant', content: `Sobre **${fieldMatch[1]}**:` });
      messages.push({ id: id++, role: 'user', content: fieldMatch[2] });
    }
  }

  return messages;
}

const KB_PROMPT_MARKER = '<!-- kb-agent-id-instruction -->';

function injectKbInstruction(agentId: string, updates: Record<string, unknown>): Record<string, unknown> {
  const mcpServers = updates['mcpServers'] as string[] | undefined;
  if (!Array.isArray(mcpServers)) return updates;

  const hasKb = mcpServers.includes('knowledge-base');
  const currentPrompt = (updates['systemPrompt'] as string) || '';
  const alreadyInjected = currentPrompt.includes(KB_PROMPT_MARKER);

  if (hasKb && !alreadyInjected) {
    const instruction = `\n${KB_PROMPT_MARKER}\nAo chamar knowledge_base_search, SEMPRE passe agent_id="${agentId}" como parametro.`;
    return { ...updates, systemPrompt: currentPrompt + instruction };
  }

  if (!hasKb && alreadyInjected) {
    // Remove a instrução se knowledge-base foi removido
    const cleaned = currentPrompt.replace(new RegExp(`\\n${KB_PROMPT_MARKER}\\n.*`), '');
    return { ...updates, systemPrompt: cleaned };
  }

  return updates;
}

function getLionClawPath(): string {
  return getLionClawHome();
}

/**
 * Limpa os arquivos JSONL de sessao do Agent SDK (~/.claude/projects/{path}/*.jsonl)
 * para que `continue: true` nao retome a conversa anterior.
 * Usado em: compaction manual, clear session, factory reset.
 */
function clearSDKSessionFiles(): void {
  const os = require('os');
  const homedir = os.homedir();
  const possibleCwds = [
    process.cwd(),
    getLionClawHome(),
    homedir,
  ];
  for (const cwd of possibleCwds) {
    const sanitized = cwd.replace(/\//g, '-').replace(/^-/, '-');
    const projectDir = path.join(homedir, '.claude', 'projects', sanitized);
    if (fs.existsSync(projectDir)) {
      for (const file of fs.readdirSync(projectDir)) {
        if (file.endsWith('.jsonl')) {
          fs.unlinkSync(path.join(projectDir, file));
          logger.info({ file }, 'Cleared SDK session file');
        }
      }
    }
  }
}

function factoryResetOnboarding(): void {
  const lionclawPath = getLionClawHome();

  // 1. Reset DB setting
  setSetting('onboarding_completed', 'false');

  // 2. Reset .md files to clean defaults (onboarding-ready)
  const cleanUser = '# Sobre o Usuario\n\nNenhuma informacao coletada ainda. Execute o onboarding para conhecer o usuario.\n';
  const cleanMemory = '# Memoria de Trabalho\n\nNenhum contexto ativo. A memoria sera preenchida automaticamente conforme as conversas.\n';

  fs.writeFileSync(path.join(lionclawPath, 'USER.md'), cleanUser, 'utf-8');
  fs.writeFileSync(path.join(lionclawPath, 'MEMORY.md'), cleanMemory, 'utf-8');
  // SOUL.md NAO reseta - sera reescrito pelo onboarding
  // RULES.md NAO reseta - regras de seguranca devem persistir

  // 3. Limpar session files do SDK
  const sessionsDir = path.join(lionclawPath, 'data', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      const filePath = path.join(sessionsDir, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    }
  }

  // 4. Limpar auto-memory do Claude Code (~/.claude/projects/{path}/memory/)
  const os = require('os');
  const homedir = os.homedir();
  const possibleCwds = [
    process.cwd(),
    getLionClawHome(),
    homedir,
  ];
  for (const cwd of possibleCwds) {
    const sanitized = cwd.replace(/\//g, '-').replace(/^-/, '-');
    const projectDir = path.join(homedir, '.claude', 'projects', sanitized);
    const autoMemoryDir = path.join(projectDir, 'memory');
    if (fs.existsSync(autoMemoryDir)) {
      for (const file of fs.readdirSync(autoMemoryDir)) {
        fs.unlinkSync(path.join(autoMemoryDir, file));
      }
      logger.info({ dir: autoMemoryDir }, 'Cleared Claude Code auto-memory');
    }
  }

  // 5. Limpar session files do SDK (JSONL)
  clearSDKSessionFiles();
  resetSdkSessionState();

  // 6. Limpar sessoes e mensagens no DB
  clearAllSessions();

  logger.info('Factory reset completed - ready for fresh onboarding');
}

async function createWorkflowRun(getMainWindow: () => BrowserWindow | null): Promise<{ workflowRunId: string; notesPath: string }> {
  // Cancel any active/generating workflows before creating a new one
  const existing = getActiveWorkflowRun();
  if (existing) {
    cancelWorkflowRun(existing.id);
    resetWorkflowSessionState();
    resetDiscoverySessionState();
    logger.info({ oldRunId: existing.id }, 'Cancelled previous active workflow before creating new one');
  }

  const runId = crypto.randomUUID();
  const workflowBaseDir = path.join(getLionClawHome(), 'workflows', 'build-plan');
  const outputDir = path.join(workflowBaseDir, 'output', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  const templatePath = path.join(workflowBaseDir, 'discovery-notes.md');
  const notesPath = path.join(outputDir, 'discovery-notes.md');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, notesPath);
  }

  insertWorkflowRun({
    id: runId,
    workflowId: 'build-plan',
    sessionId: crypto.randomUUID(),
    currentStage: 1,
    notesPath,
    status: 'active',
  });

  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('workflow:activated', { workflowRunId: runId, notesPath });
  }

  // Auto-send initial message so the workflow agent starts with Q1
  const activeRun = getActiveWorkflowRun();
  if (activeRun) {
    // Small delay to let renderer mount BuildPlanPage and subscribe to events
    setTimeout(() => {
      handleDiscoveryMessage(
        'Comece o discovery. Faca a primeira pergunta.',
        activeRun,
        getMainWindow,
      ).catch((err) => logger.error({ err }, 'createWorkflowRun: auto-send failed'));
    }, 500);
  }

  return { workflowRunId: runId, notesPath };
}

let workflowUIActive = false;

export function registerIPCHandlers(
  getMainWindow: () => BrowserWindow | null,
  getHarnessEngine: () => HarnessEngine | null = () => null,
  getPipelineEngine: () => PipelineEngine | null = () => null,
): void {
  // Log workflows ativos de sessoes anteriores (NAO cancelar - BuildPlan deve persistir entre restarts)
  const existingRun = getActiveWorkflowRun();
  if (existingRun && existingRun.status === 'active') {
    logger.info({ workflowRunId: existingRun.id }, 'Found active workflow from previous session, preserving for resume');
  }

  // ---- Workflow UI flag ----
  ipcMain.handle('workflow:ui-active', (_event, active: boolean) => {
    workflowUIActive = active;
  });

  // ---- Chat (via Orchestrator) ----
  ipcMain.handle('chat:send', async (_event, message: string, options?: { sessionId?: string; agentId?: string; attachments?: Array<{ id: string; type: string; filename: string; mimeType: string; data: string; size: number }> }) => {
    // Roteamento: /BuildPlan inicia o workflow
    if (message.trim() === '/BuildPlan') {
      return createWorkflowRun(getMainWindow);
    }

    // Roteamento: se ha workflow ativo E o usuario esta na tela de BuildPlan
    const activeRun = getActiveWorkflowRun();
    if (activeRun && activeRun.status === 'active' && workflowUIActive) {
      // Discovery phase: harness controls the flow
      handleDiscoveryMessage(message, activeRun, getMainWindow);
      return;
    }

    // Fluxo normal via submitMessage()
    submitMessage(message, options || {}, getMainWindow);
  });

  ipcMain.handle('chat:stop', () => {
    stopCurrentQuery();
  });

  ipcMain.handle('chat:confirm-response', (_event, id: string, approved: boolean) => {
    resolveConfirmation(id, approved);
  });

  ipcMain.handle('chat:ask-response', (_event, response: AskQuestionResponse) => {
    resolveAskQuestion(response);
  });

  ipcMain.handle('chat:get-sessions', () => {
    return getAllSessions();
  });

  ipcMain.handle('chat:get-messages', (_event, sessionId: string) => {
    return getSessionMessages(sessionId);
  });

  ipcMain.handle('chat:delete-session', (_event, sessionId: string) => {
    try {
      const result = trashSession(sessionId);
      if (!result.success) {
        logger.warn({ sessionId, error: result.error }, 'Trash session rejected');
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, sessionId }, 'Failed to trash session');
      return { success: false, error: message };
    }
  });

  ipcMain.handle('chat:archive-session', (_event, sessionId: string) => {
    updateSessionStatus(sessionId, 'archived');
    return true;
  });

  ipcMain.handle('chat:get-active-session', () => {
    return getActiveSession();
  });

  ipcMain.handle('chat:compact-session', async () => {
    const activeSession = getActiveSession();
    if (!activeSession) {
      logger.warn('No active session to compact');
      return { success: false, reason: 'no_active_session' };
    }

    const totalTokens = activeSession.inputTokens + activeSession.outputTokens;
    logger.info({ sessionId: activeSession.id, totalTokens }, 'Manual compaction triggered');

    // Run compaction BEFORE marking session - so messages are still findable
    let compactionError: string | undefined;
    try {
      await runCompaction(new Date(activeSession.createdAt), new Date(), activeSession.id);
    } catch (err) {
      compactionError = err instanceof Error ? err.message : String(err);
      logger.error({ err: compactionError }, 'Manual compaction failed');
      // Don't mark as compacted or create new session if compaction failed
      return { success: false, reason: 'compaction_failed', error: compactionError };
    }

    // Mark session as compacted AFTER compaction succeeds
    updateSessionStatus(activeSession.id, 'compacted');

    // Limpar session files do SDK (JSONL) para que `continue: true` nao retome sessao antiga
    clearSDKSessionFiles();
    resetSdkSessionState();

    const newSessionId = crypto.randomUUID();
    const fullActiveSession = getSession(activeSession.id);
    createSession(newSessionId, '', fullActiveSession?.subagent, {
      type: fullActiveSession?.type,
      taskId: fullActiveSession?.taskId,
    });

    if (fullActiveSession?.type === 'telegram') {
      onTelegramSessionCompacted(activeSession.id, newSessionId);
    }

    return { success: true, newSessionId };
  });

  ipcMain.handle('chat:clear-session', async () => {
    const activeSession = getActiveSession();
    if (!activeSession) {
      logger.warn('No active session to clear');
      return { success: false, reason: 'no_active_session' };
    }

    logger.info({ sessionId: activeSession.id }, 'Session clear triggered (no compaction)');

    updateSessionStatus(activeSession.id, 'archived');

    // Limpar session files do SDK (JSONL) para que a proxima conversa comece do zero
    clearSDKSessionFiles();
    resetSdkSessionState();

    const newSessionId = crypto.randomUUID();
    createSession(newSessionId, '');

    return { success: true, newSessionId };
  });

  // ---- Usage ----
  ipcMain.handle('usage:get-stats', (_event, filter: { from?: string; to?: string; model?: string }) => {
    return getUsageStats(filter || {});
  });

  ipcMain.handle('usage:get-session-stats', (_event, sessionId: string) => {
    return getSessionTokens(sessionId);
  });

  ipcMain.handle('usage:get-agent-stats', (_event, filter: { from?: string; to?: string }) => {
    return getUsageByAgent(filter || {});
  });

  ipcMain.handle('usage:get-task-executions', (_event, filter: { sessionId?: string; agentId?: string; from?: string; to?: string }) => {
    return getTaskExecutions(filter || {});
  });

  // ---- Agents ----
  ipcMain.handle('agents:list', () => {
    return getAllAgents();
  });

  ipcMain.handle('agents:get', (_event, id: string) => {
    return getAgent(id);
  });

  ipcMain.handle('agents:create', (_event, agent) => {
    const withKbInstruction = injectKbInstruction(agent.id, agent);
    return insertAgent(withKbInstruction);
  });

  ipcMain.handle('agents:update', (_event, id: string, updates) => {
    const withKbInstruction = injectKbInstruction(id, updates);
    return updateAgent(id, withKbInstruction);
  });

  ipcMain.handle('agents:delete', (_event, id: string) => {
    deleteAgent(id);
  });

  // ---- Skills ----
  ipcMain.handle('skills:list', () => {
    return listSkills();
  });

  ipcMain.handle('skills:get', (_event, name: string) => {
    return getSkill(name);
  });

  ipcMain.handle('skills:create', (_event, skill: SkillCreateInput) => {
    return createSkill(skill);
  });

  ipcMain.handle('skills:update', (_event, name: string, skill: SkillCreateInput) => {
    return updateSkill(name, skill);
  });

  ipcMain.handle('skills:update-raw', (_event, name: string, content: string) => {
    return updateSkillRaw(name, content);
  });

  ipcMain.handle('skills:delete', (_event, name: string) => {
    deleteSkill(name);
  });

  // ---- MCP Servers ----
  ipcMain.handle('mcp:list', () => {
    return getAllMCPServers();
  });

  ipcMain.handle('mcp:create', (_event, config) => {
    return createMCPServer(config);
  });

  ipcMain.handle('mcp:update', (_event, id: string, updates) => {
    return updateMCPServer(id, updates);
  });

  ipcMain.handle('mcp:delete', (_event, id: string) => {
    deleteMCPServer(id);
  });

  ipcMain.handle('mcp:test', async (_event, id: string) => {
    return testServer(id);
  });

  ipcMain.handle('mcp:restart', async (_event, id: string) => {
    await restartServer(id);
  });

  ipcMain.handle('mcp:toggle', async (_event, id: string, active: boolean) => {
    const updated = updateMCPServer(id, { isActive: active });
    if (active) {
      await restartServer(id);
    } else {
      stopServer(id);
    }
    return updated;
  });

  // ---- MCP SDK Discovery ----
  ipcMain.handle('mcp:list-sdk', async () => {
    let servers = getCachedSDKMcpServers();
    if (servers.length === 0) {
      servers = await discoverSDKMcpServers();
    }
    const disabled = new Set(getDisabledSDKMcps());
    return servers.map((s) => ({
      ...s,
      isDisabledLocally: disabled.has(s.name),
    }));
  });

  ipcMain.handle('mcp:refresh-sdk', async () => {
    return refreshSDKMcpServers();
  });

  ipcMain.handle('mcp:toggle-sdk', (_event, serverName: string, enabled: boolean) => {
    setSDKMcpDisabled(serverName, !enabled);
  });

  ipcMain.handle('mcp:discover-tools', async (_event, serverId: string) => {
    return discoverAndSaveMCPTools(serverId);
  });

  // ---- Scheduler ----
  ipcMain.handle('scheduler:list', () => {
    return getAllScheduledTasks();
  });

  ipcMain.handle('scheduler:create', (_event, task) => {
    return createScheduledTask(task);
  });

  ipcMain.handle('scheduler:update', (_event, id: string, updates) => {
    return updateScheduledTask(id, updates);
  });

  ipcMain.handle('scheduler:delete', (_event, id: string) => {
    deleteScheduledTask(id);
  });

  ipcMain.handle('scheduler:pause', (_event, id: string) => {
    return updateScheduledTask(id, { status: 'paused' });
  });

  ipcMain.handle('scheduler:resume', (_event, id: string) => {
    return updateScheduledTask(id, { status: 'active' });
  });

  ipcMain.handle('scheduler:get-runs', (_event, taskId: string) => {
    return getTaskRuns(taskId);
  });

  ipcMain.handle('scheduler:review-run', (_event, runId: number, status: 'validated' | 'rejected', note?: string) => {
    reviewTaskRun(runId, status, note);
  });

  ipcMain.handle('scheduler:pending-count', () => {
    return getPendingReviewCount();
  });

  ipcMain.handle('scheduler:get-sessions', () => {
    return getScheduledSessions();
  });

  ipcMain.handle('scheduler:delete-session', (_event, sessionId: string) => {
    deleteSessionById(sessionId);
  });

  ipcMain.handle('scheduler:cleanup-sessions', () => {
    deleteScheduledSessions();
  });

  // ---- Activity Board ----
  ipcMain.handle('scheduler:get-activities', (_event, filters: {
    from: string;
    to: string;
    subagent?: string;
    status?: string;
    tags?: string[];
  }) => {
    return getActivities(filters);
  });

  ipcMain.handle('scheduler:get-activity-stats', (_event, from: string, to: string) => {
    return getActivityStats(from, to);
  });

  ipcMain.handle('scheduler:get-all-tags', () => {
    return getAllTags();
  });

  // ---- Logs ----
  ipcMain.handle('logs:query', (_event, filters: LogFilters) => {
    return queryAuditLog(filters);
  });

  ipcMain.handle('logs:export-csv', async (_event, filters: LogFilters) => {
    // Query all matching audit entries (no limit)
    const entries = queryAuditLog({ ...filters, limit: 10000, offset: 0 });
    // Convert to CSV string
    const headers = ['ID', 'Timestamp', 'Session', 'SubAgent', 'Event Type', 'Tool', 'Input', 'Output', 'Duration (ms)', 'Approved'];
    const rows = entries.map(e => [
      e.id,
      e.createdAt,
      e.sessionId || '',
      e.subagent || '',
      e.eventType,
      e.toolName || '',
      (e.input || '').replace(/"/g, '""'),
      (e.output || '').replace(/"/g, '""'),
      e.durationMs ?? '',
      e.approved !== undefined ? (e.approved ? 'Yes' : 'No') : '',
    ].map(v => `"${v}"`).join(','));
    return [headers.join(','), ...rows].join('\n');
  });

  ipcMain.handle('logs:export-json', async (_event, filters: LogFilters) => {
    const entries = queryAuditLog({ ...filters, limit: 10000, offset: 0 });
    return JSON.stringify(entries, null, 2);
  });

  // ---- Memory ----
  ipcMain.handle('memory:get-working', () => {
    const filePath = path.join(getLionClawPath(), 'MEMORY.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('memory:update-working', (_event, content: string) => {
    const filePath = path.join(getLionClawPath(), 'MEMORY.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  ipcMain.handle('memory:search-semantic', async (_event, query: string, limit?: number) => {
    return searchSemanticMemories(query, limit);
  });

  ipcMain.handle('memory:get-summaries', (_event, from?: string, to?: string) => {
    return getDailySummaries(from, to);
  });

  ipcMain.handle('memory:trigger-compaction', async () => {
    // Deprecated - uses active session dates instead of arbitrary 24h window
    const activeSession = getActiveSession();
    if (!activeSession) return;

    await runCompaction(new Date(activeSession.createdAt), new Date(), activeSession.id);
    updateSessionStatus(activeSession.id, 'compacted');

    const newSessionId = crypto.randomUUID();
    createSession(newSessionId, '');
  });

  ipcMain.handle('memory:archive-conversation', async (_event, sessionId: string) => {
    return archiveConversation(sessionId);
  });

  // ---- Tools ----
  ipcMain.handle('tools:getSettings', () => {
    return getToolSettings();
  });

  ipcMain.handle('tools:setEnabled', (_e, tool: string, enabled: boolean) => {
    setToolEnabled(tool, enabled);
    return getToolSettings();
  });

  ipcMain.handle('tools:getEnabled', () => {
    return getEnabledTools();
  });

  // ---- Settings ----
  ipcMain.handle('settings:get', async (): Promise<AppSettings> => {
    return {
      defaultModel: getSetting('default_model') || 'sonnet',
      theme: (getSetting('theme') as AppSettings['theme']) || 'dark',
      language: 'pt-BR',
      sessionTimeoutMinutes: parseInt(getSetting('session_timeout') || '60', 10),
      compactionSchedule: getSetting('compaction_schedule') || '0 23 * * *',
      maxWorkingMemoryTokens: parseInt(getSetting('max_memory_tokens') || '2000', 10),
      rawMessageRetentionDays: parseInt(getSetting('message_retention_days') || '7', 10),
      maxSessionTokens: parseInt(getSetting('max_session_tokens') || '200000', 10),
      voiceResponseEnabled: getSetting('voice_response_enabled') === 'true',
      voiceId: getSetting('voice_id') || undefined,
      ollamaEnabled: getSetting('ollama_enabled') === 'true',
      ollamaBaseUrl: getSetting('ollama_base_url') || 'http://localhost:11434',
      ollamaEmbeddingModel: getSetting('ollama_embedding_model') || 'nomic-embed-text',
      ollamaCompactionModel: getSetting('ollama_compaction_model') || '',
      mgraphMode: getSetting('mgraph_mode') === 'true',
    };
  });

  ipcMain.handle('settings:update', async (_event, settings: Partial<AppSettings>) => {
    if (settings.defaultModel) setSetting('default_model', settings.defaultModel);
    if (settings.theme) setSetting('theme', settings.theme);
    if (settings.sessionTimeoutMinutes) setSetting('session_timeout', String(settings.sessionTimeoutMinutes));
    if (settings.compactionSchedule) setSetting('compaction_schedule', settings.compactionSchedule);
    if (settings.maxWorkingMemoryTokens) setSetting('max_memory_tokens', String(settings.maxWorkingMemoryTokens));
    if (settings.rawMessageRetentionDays) setSetting('message_retention_days', String(settings.rawMessageRetentionDays));
    if ((settings as Record<string, unknown>).maxSessionTokens !== undefined) {
      setSetting('max_session_tokens', String((settings as Record<string, unknown>).maxSessionTokens));
    }
    if (settings.voiceResponseEnabled !== undefined) {
      setSetting('voice_response_enabled', settings.voiceResponseEnabled ? 'true' : 'false');
    }
    if (settings.voiceId !== undefined) {
      setSetting('voice_id', settings.voiceId || '');
    }
    if (settings.ollamaEnabled !== undefined) {
      setSetting('ollama_enabled', settings.ollamaEnabled ? 'true' : 'false');
    }
    if (settings.ollamaBaseUrl !== undefined) {
      setSetting('ollama_base_url', settings.ollamaBaseUrl);
    }
    if (settings.ollamaEmbeddingModel !== undefined) {
      setSetting('ollama_embedding_model', settings.ollamaEmbeddingModel);
    }
    if (settings.ollamaCompactionModel !== undefined) {
      setSetting('ollama_compaction_model', settings.ollamaCompactionModel);
    }
    if (settings.mgraphMode !== undefined) {
      setSetting('mgraph_mode', settings.mgraphMode ? 'true' : 'false');
    }
  });

  ipcMain.handle('settings:set-api-key', async (_event, key: string) => {
    const { setApiKey } = await import('./secrets-vault');
    await setApiKey(key);
  });

  // ---- Auth ----
  ipcMain.handle('auth:login', async (_event, password: string, totpCode?: string) => {
    return auth.login(password, totpCode);
  });

  ipcMain.handle('auth:logout', () => {
    auth.logout();
  });

  ipcMain.handle('auth:is-authenticated', () => {
    return auth.isAuthenticated();
  });

  ipcMain.handle('auth:is-first-run', () => {
    return auth.isFirstRun();
  });

  ipcMain.handle('auth:setup-password', async (_event, password: string) => {
    await auth.setupPassword(password);
    seedDefaultAgents();
  });

  ipcMain.handle('auth:enable-totp', () => {
    return auth.enableTOTP();
  });

  ipcMain.handle('auth:verify-totp', (_event, code: string) => {
    return auth.verifyTOTP(code);
  });

  // ---- Soul ----
  ipcMain.handle('soul:get', () => {
    return loadSoul();
  });

  ipcMain.handle('soul:update', (_event, content: string) => {
    saveSoul(content);
    return true;
  });

  // ---- User Profile ----
  ipcMain.handle('user:get', () => {
    return loadUser();
  });

  ipcMain.handle('user:update', (_event, content: string) => {
    saveUser(content);
    return true;
  });

  // ---- Rules ----
  ipcMain.handle('rules:get-global', () => {
    const filePath = path.join(getLionClawPath(), 'RULES.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('rules:update-global', (_event, content: string) => {
    const filePath = path.join(getLionClawPath(), 'RULES.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  ipcMain.handle('rules:get-agent', (_event, agentId: string) => {
    const filePath = path.join(getLionClawPath(), 'agents', agentId, 'RULES.md');
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  });

  ipcMain.handle('rules:update-agent', (_event, agentId: string, content: string) => {
    const dirPath = path.join(getLionClawPath(), 'agents', agentId);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'RULES.md'), content, 'utf-8');
  });

  // ---- Onboarding ----
  ipcMain.handle('onboarding:is-completed', () => {
    return getSetting('onboarding_completed') === 'true';
  });

  ipcMain.handle('onboarding:mark-completed', () => {
    setSetting('onboarding_completed', 'true');
  });

  ipcMain.handle('onboarding:reset', () => {
    factoryResetOnboarding();
  });

  // ---- Vault ----
  ipcMain.handle('vault:list', async () => {
    return getVaultEntries();
  });

  ipcMain.handle('vault:set', async (_event, key: string, value: string) => {
    await setVaultSecret(key, value);
  });

  ipcMain.handle('vault:delete', async (_event, key: string) => {
    await deleteVaultSecret(key);
  });

  ipcMain.handle('vault:check', async (_event, key: string) => {
    return checkVaultSecret(key);
  });

  // ---- Image ----
  ipcMain.handle('image:generate', async (_event, prompt: string, options?: { aspectRatio?: string }) => {
    return generateImage(prompt, options as { aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' });
  });

  ipcMain.handle('image:edit', async (_event, prompt: string, imageBase64: string, imageMimeType: string, options?: { aspectRatio?: string }) => {
    return editImage(prompt, imageBase64, imageMimeType, options as { aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' });
  });

  // ---- Voice ----
  ipcMain.handle('voice:transcribe', async (_event, audioBase64: string) => {
    return transcribeAudio(audioBase64);
  });

  ipcMain.handle('voice:speak', async (_event, text: string, voiceId?: string) => {
    const result = await generateSpeech(text, voiceId);
    return result;
  });

  ipcMain.handle('voice:list-voices', async () => {
    const apiKey = await (await import('./secrets-vault')).getSecret('ELEVENLABS_API_KEY');
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY nao configurada');

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) throw new Error(`ElevenLabs failed: ${response.status}`);

    const data = await response.json() as { voices: Array<{ voice_id: string; name: string; category: string; labels: Record<string, string>; preview_url: string }> };
    return data.voices.map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels || {},
      preview_url: v.preview_url || '',
    }));
  });

  ipcMain.handle('voice:read-audio-file', async (_event, filePath: string) => {
    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  });

  // ---- Google OAuth ----
  ipcMain.handle('google:setup', async (_event, config: { clientId: string; clientSecret: string }) => {
    const { setSecret } = await import('./secrets-vault');
    await setSecret('GOOGLE_CLIENT_ID', config.clientId);
    await setSecret('GOOGLE_CLIENT_SECRET', config.clientSecret);
    return { success: true };
  });

  ipcMain.handle('google:authenticate', async () => {
    const result = await runOAuthFlow();

    if (result.success) {
      const googleMcps = ['google-gmail', 'google-drive', 'google-sheets'];
      for (const id of googleMcps) {
        try {
          updateMCPServer(id, { isActive: true });
          await startServer(id);
        } catch (err) {
          logger.warn({ id, err }, 'Failed to start Google MCP after OAuth');
        }
      }
    }

    return result;
  });

  ipcMain.handle('google:status', async () => {
    return getGoogleAuthStatus();
  });

  ipcMain.handle('google:revoke', async () => {
    const googleMcps = ['google-gmail', 'google-drive', 'google-sheets'];
    for (const id of googleMcps) {
      stopServer(id);
      updateMCPServer(id, { isActive: false });
    }
    await revokeGoogleAuth();
  });

  // ---- Channels (Telegram, etc.) ----
  ipcMain.handle('channels:list', () => {
    return getAllChannels();
  });

  ipcMain.handle('channels:get', (_event, type: string) => {
    return getChannel(type);
  });

  ipcMain.handle('channels:save-telegram', async (_event, config: {
    botToken: string;
    allowedUserId: number;
    allowedUserName: string;
    notifyOnSchedulerTasks: boolean;
  }) => {
    if (config.botToken && config.botToken !== '__keep__') {
      const { setSecret } = await import('./secrets-vault');
      await setSecret('TELEGRAM_BOT_TOKEN', config.botToken);
    }

    upsertChannel('telegram', {
      allowedUserId: config.allowedUserId,
      allowedUserName: config.allowedUserName,
      sessionMode: 'continuous',
      notifyOnSchedulerTasks: config.notifyOnSchedulerTasks,
    });

    await stopTelegramBot();
    await startTelegramBot(getMainWindow);

    return getChannel('telegram');
  });

  ipcMain.handle('channels:toggle', async (_event, type: string, active: boolean) => {
    toggleChannel(type, active);
    if (type === 'telegram') {
      await stopTelegramBot();
      if (active) await startTelegramBot(getMainWindow);
    }
  });

  ipcMain.handle('channels:test-telegram', async () => {
    const { getSecret } = await import('./secrets-vault');
    const token = await getSecret('TELEGRAM_BOT_TOKEN');
    if (!token) return { success: false, error: 'Token nao configurado' };

    try {
      const testBot = new TelegramBot(token, { polling: false });
      const me = await testBot.getMe();
      return {
        success: true,
        botUsername: me.username,
        botName: me.first_name,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('channels:telegram-status', () => {
    return { running: isTelegramRunning() };
  });

  // ---- Local LLM (Ollama / LM Studio / OpenAI-compatible) ----
  ipcMain.handle('ollama:check', async (_event, baseUrl: string, model: string, provider?: string) => {
    return checkOllamaAvailable(baseUrl, model, (provider as 'ollama' | 'lmstudio' | 'openai-compatible') || 'ollama');
  });

  ipcMain.handle('ollama:listModels', async (_event, provider: string, baseUrl: string) => {
    try {
      if (provider === 'ollama') {
        const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
        const json = (await res.json()) as { models?: Array<{ name: string }> };
        return { models: (json.models || []).map((m) => m.name) };
      } else {
        const res = await fetch(`${baseUrl}/v1/models`, { method: 'GET', signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        return { models: (json.data || []).map((m) => m.id) };
      }
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : 'Erro desconhecido' };
    }
  });

  // ---- Knowledge Base ----
  ipcMain.handle('knowledge:upload', async (_event, payload: {
    agentId: string;
    filePath: string;
    config: { strategy: string; chunkSize: number; chunkOverlap: number; title?: string };
  }) => {
    const win = getMainWindow();
    const emitProgress = (data: { sourceId: string; stage: string; progress: number }) => {
      win?.webContents.send('knowledge:ingestion:progress', data);
    };
    return ingestDocument({
      ...payload,
      config: {
        ...payload.config,
        strategy: payload.config.strategy as 'recursive' | 'semantic' | 'page' | 'markdown' | 'csv' | 'agentic',
      },
    }, emitProgress);
  });

  ipcMain.handle('knowledge:reprocess', async (_event, payload: {
    sourceId: string;
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
  }) => {
    const win = getMainWindow();
    const emitProgress = (data: { sourceId: string; stage: string; progress: number }) => {
      win?.webContents.send('knowledge:ingestion:progress', data);
    };
    await reprocessDocument(
      payload.sourceId,
      payload.strategy as 'recursive' | 'semantic' | 'page' | 'markdown' | 'csv' | 'agentic',
      payload.chunkSize,
      payload.chunkOverlap,
      emitProgress,
    );
    return getKnowledgeSource(payload.sourceId);
  });

  ipcMain.handle('knowledge:delete', async (_event, payload: { sourceId: string }) => {
    deleteKnowledgeSource(payload.sourceId);
    return { success: true };
  });

  ipcMain.handle('knowledge:list', async (_event, payload: { agentId: string }) => {
    return getKnowledgeSources(payload.agentId);
  });

  ipcMain.handle('knowledge:search', async (_event, payload: { agentId: string; query: string }) => {
    return hybridKnowledgeSearch(payload.agentId, payload.query);
  });

  ipcMain.handle('knowledge:benchmark:start', async (_event, payload: {
    sourceIds: string[];
    agentId: string;
    config: { totalQuestions: number; modelJudge: 'sonnet' | 'opus'; threshold: number };
  }) => {
    const benchmarkId = crypto.randomUUID();
    // Create benchmark record
    insertKnowledgeBenchmark({
      id: benchmarkId,
      sourceId: payload.sourceIds[0],
      agentId: payload.agentId,
      status: 'running',
      totalQuestions: payload.config.totalQuestions,
      modelJudge: payload.config.modelJudge,
      questions: [],
      results: {},
    });

    // Fire and forget - runs in background
    const win = getMainWindow();
    runBenchmarkPipeline(benchmarkId, payload, win).catch((err) => {
      logger.error({ err, benchmarkId }, 'Benchmark pipeline failed');
      updateKnowledgeBenchmark(benchmarkId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      win?.webContents.send('knowledge:benchmark:progress', {
        benchmarkId,
        stage: `Erro: ${err instanceof Error ? err.message : String(err)}`,
        current: 0,
        total: 0,
        done: true,
      });
    });

    return { benchmarkId };
  });

  ipcMain.handle('knowledge:benchmark:status', async (_event, payload: { benchmarkId: string }) => {
    const benchmark = getKnowledgeBenchmark(payload.benchmarkId);
    if (!benchmark) return { status: 'failed', progress: 0, currentStage: 'not_found' };
    return {
      status: benchmark.status,
      progress: benchmark.status === 'completed' ? 100 : 0,
      currentStage: benchmark.status,
      result: benchmark.status === 'completed' ? benchmark.results : undefined,
    };
  });

  ipcMain.handle('knowledge:config:get', async (_event, payload: { agentId: string }) => {
    const config = getKnowledgeAgentConfig(payload.agentId);
    if (!config) {
      return {
        agentId: payload.agentId,
        hydeEnabled: true,
        hydeThreshold: 0.50,
        minScore: 0.40,
        defaultStrategy: 'recursive',
        rerankEnabled: true,
        rerankTopK: 3,
        searchTopK: 20,
      };
    }
    return config;
  });

  ipcMain.handle('knowledge:config:update', async (_event, payload: {
    agentId: string;
    config: Partial<{
      hydeEnabled: boolean;
      hydeThreshold: number;
      minScore: number;
      defaultStrategy: string;
      rerankEnabled: boolean;
      rerankTopK: number;
      searchTopK: number;
    }>;
  }) => {
    upsertKnowledgeAgentConfig(payload.agentId, payload.config);
    return getKnowledgeAgentConfig(payload.agentId);
  });

  // ---- Personal Tasks ----
  ipcMain.handle('tasks:list', (_event, filters?: { status?: string; category?: string; priority?: string; period?: 'last30' | 'last90' | 'all' }) => {
    return getAllTasks(filters);
  });

  ipcMain.handle('tasks:get', (_event, id: string) => {
    return getTask(id);
  });

  ipcMain.handle('tasks:create', (_event, task: { title: string; description?: string; category?: string; priority?: string; due_date?: string }) => {
    return insertTask(task);
  });

  ipcMain.handle('tasks:update', (_event, id: string, updates: Record<string, unknown>) => {
    return updateTaskDb(id, updates);
  });

  ipcMain.handle('tasks:delete', (_event, id: string) => {
    deleteTaskDb(id);
  });

  ipcMain.handle('tasks:categories', () => {
    return getTaskCategories();
  });

  ipcMain.handle('tasks:pending-due-count', () => {
    return getPendingTasksDueCount();
  });

  // ---- Harness ----
  ipcMain.handle('harness:create-project', async (_event, data: {
    name: string;
    description?: string;
    projectPath: string;
    specText?: string;
    specFilePath?: string;
    config: {
      maxRoundsPerSprint: number;
      usePlaywright: boolean;
      evaluatorAgentId: string;
      plannerAgentId: string;
      stack: string[];
      plannerOutputFormat?: 'json' | 'markdown';
    };
  }) => {
    // Validate project path exists before creating
    if (!fs.existsSync(data.projectPath)) {
      throw new Error(`Caminho do projeto nao existe: ${data.projectPath}. Crie o diretorio primeiro.`);
    }

    // Resolve spec content: from file path or inline text
    let specContent: string;
    if (data.specFilePath) {
      if (!fs.existsSync(data.specFilePath)) {
        throw new Error(`Arquivo da SPEC nao encontrado: ${data.specFilePath}`);
      }
      specContent = fs.readFileSync(data.specFilePath, 'utf-8');
    } else if (data.specText) {
      specContent = data.specText;
    } else {
      throw new Error('Informe o caminho do arquivo da SPEC ou o conteudo da SPEC.');
    }

    const project = insertHarnessProject({
      name: data.name,
      description: data.description,
      projectPath: data.projectPath,
      specPath: '',
      config: data.config,
    });

    const projectDir = path.join(getLionClawPath(), 'harness', 'projects', project.id);
    fs.mkdirSync(projectDir, { recursive: true });
    const specPath = path.join(projectDir, 'spec.md');
    fs.writeFileSync(specPath, specContent, 'utf-8');

    updateHarnessProject(project.id, { specPath });

    return { projectId: project.id };
  });

  ipcMain.handle('harness:plan', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.plan(projectId).catch(err => {
      logger.error({ err, projectId }, 'Plan failed');
    });
  });

  ipcMain.handle('harness:approve-sprints', (_event, projectId: string) => {
    updateHarnessProject(projectId, { status: 'ready' });
    // Automatically start execution after approval
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.run(projectId).catch(err => {
      logger.error({ err, projectId }, 'Run after approval failed');
    });
  });

  ipcMain.handle('harness:regenerate-sprints', (_event, projectId: string, feedback: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.regenerate(projectId, feedback).catch(err => {
      logger.error({ err, projectId }, 'Regenerate failed');
    });
  });

  ipcMain.handle('harness:run', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.run(projectId).catch(err => {
      logger.error({ err, projectId }, 'Run failed');
    });
  });

  ipcMain.handle('harness:pause', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.pause(projectId);
  });

  ipcMain.handle('harness:resume', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.resume(projectId);
  });

  ipcMain.handle('harness:abort', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (!engine) throw new Error('HarnessEngine not initialized');
    engine.abort(projectId);
  });

  ipcMain.handle('harness:delete-project', (_event, projectId: string) => {
    // Abort if running
    const engine = getHarnessEngine();
    if (engine) {
      try { engine.abort(projectId); } catch { /* not running, that's fine */ }
    }
    // Delete from DB (rounds, sprints, project)
    deleteHarnessProject(projectId);
    // Delete filesystem artifacts
    const projectDir = path.join(getLionClawPath(), 'harness', 'projects', projectId);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    logger.info({ projectId }, 'Harness project deleted via IPC');
  });

  ipcMain.handle('harness:get-project', (_event, projectId: string) => {
    return getHarnessProject(projectId);
  });

  ipcMain.handle('harness:list-projects', () => {
    return listHarnessProjects();
  });

  ipcMain.handle('harness:get-sprints', (_event, projectId: string) => {
    return getHarnessSprints(projectId);
  });

  ipcMain.handle('harness:get-rounds', (_event, sprintId: string) => {
    return getHarnessRounds(sprintId);
  });

  ipcMain.handle('harness:get-evaluation', (_event, projectId: string, sprintId: string) => {
    const evalPath = path.join(
      getLionClawPath(), 'harness', 'projects', projectId, 'sprints', sprintId, 'evaluation.json'
    );
    try {
      const content = fs.readFileSync(evalPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  ipcMain.handle('harness:get-sprint-json', (_event, projectId: string, sprintJsonId: string) => {
    const projectDir = path.join(getLionClawPath(), 'harness', 'projects', projectId);
    const sprintsJson = readLatestSprintsJson(projectDir);
    if (!sprintsJson) return null;
    const sprint = sprintsJson.sprints.find((s: { id: string }) => s.id === sprintJsonId);
    return sprint ?? null;
  });

  ipcMain.handle('harness:get-sprints-json', (_event, projectId: string) => {
    const projectDir = path.join(getLionClawPath(), 'harness', 'projects', projectId);
    return readLatestSprintsJson(projectDir);
  });

  ipcMain.handle('harness:get-metrics', (_event, projectId: string) => {
    return getHarnessProjectMetrics(projectId);
  });

  ipcMain.handle('harness:get-stream-log', (_event, projectId: string, sprintId: string) => {
    const engine = getHarnessEngine();
    if (!engine) return { coder: [], evaluator: [], round: 0 };
    return engine.getLatestStreamLogs(projectId, sprintId);
  });

  ipcMain.handle('harness:get-feedback-audit', (_event, projectId: string, sprintId: string) => {
    const projectDir = path.join(getLionClawPath(), 'harness', 'projects', projectId, 'sprints', sprintId);
    const filePath = path.join(projectDir, 'feedback-audit.jsonl');
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  });

  // ---- Workflow (BuildPlan) ----

  ipcMain.handle('workflow:start', async () => {
    return createWorkflowRun(getMainWindow);
  });

  ipcMain.handle('workflow:approve', async (_event, workflowRunId: string) => {
    const run = getActiveWorkflowRun();
    if (!run || run.id !== workflowRunId) {
      throw new Error(`Workflow run ${workflowRunId} not found or not active`);
    }
    setWorkflowRunGenerating(workflowRunId);
    // Fire-and-forget: retorna imediatamente para o renderer montar o
    // SpecGenerationView ANTES dos eventos de streaming comecarem.
    // Sem isso, o await segura o IPC invoke ate a geracao terminar,
    // e o componente so monta depois que todos os eventos ja foram emitidos.
    executeSpecGeneration(run, getMainWindow)
      .then(() => completeWorkflowRun(workflowRunId))
      .catch((err) => {
        logger.error({ err, workflowRunId }, 'executeSpecGeneration failed');
        setWorkflowRunActive(workflowRunId);
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('workflow:agent-stream', {
            agent: 'spec-builder',
            msg: { type: 'error', content: (err as Error).message },
          });
        }
      });
  });

  ipcMain.handle('workflow:cancel', async (_event, workflowRunId: string) => {
    cancelWorkflowRun(workflowRunId);
    resetWorkflowSessionState();
    resetDiscoverySessionState();
  });

  ipcMain.handle('workflow:get-active', async () => {
    const activeRun = getActiveWorkflowRun();
    if (!activeRun) return null;

    let notesContent = '';
    if (activeRun.notesPath) {
      try {
        notesContent = fs.readFileSync(activeRun.notesPath, 'utf-8');
      } catch { /* arquivo pode nao existir ainda */ }
    }

    const messages = rebuildMessagesFromNotes(notesContent);

    return {
      workflowRunId: activeRun.id,
      currentStage: activeRun.currentStage,
      currentQuestion: activeRun.currentQuestion ?? 'Q1',
      notesPath: activeRun.notesPath,
      status: activeRun.status,
      notesContent,
      messages,
    };
  });

  // ---- Shell (Finder integration) ----

  ipcMain.handle('shell:show-in-folder', async (_event, filePath: string) => {
    const resolved = path.resolve(filePath);
    const lionclawDir = getLionClawPath();
    if (!resolved.startsWith(path.resolve(lionclawDir))) {
      throw new Error('Path fora do diretorio permitido');
    }
    if (!fs.existsSync(resolved)) {
      throw new Error('Arquivo nao encontrado');
    }
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle('shell:open-path', async (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    const lionclawDir = getLionClawPath();
    if (!resolved.startsWith(path.resolve(lionclawDir))) {
      throw new Error('Path fora do diretorio permitido');
    }
    await shell.openPath(resolved);
  });

  // ---- Dialog (native file/folder pickers) ----

  ipcMain.handle('dialog:open-file', async (_event, args: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const win = BrowserWindow.getFocusedWindow();
    const filters = args?.filters ?? [{ name: 'Documents', extensions: ['md', 'json', 'txt'] }];
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:open-directory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Selecionar pasta do projeto',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // ---- Enrich Pipeline ----

  ipcMain.handle('enrich:start', async (_event, config: {
    name: string;
    specPath: string;
    projectPath?: string;
    prdPath?: string;
    message?: string;
    validatorAgentId: string;
  }) => {
    if (!config || typeof config.name !== 'string' || !config.name.trim()) {
      return { error: 'Campo name e obrigatorio' };
    }
    if (typeof config.specPath !== 'string' || !config.specPath.trim()) {
      return { error: 'Campo specPath e obrigatorio' };
    }
    if (typeof config.validatorAgentId !== 'string' || !config.validatorAgentId.trim()) {
      return { error: 'Campo validatorAgentId e obrigatorio' };
    }
    if (!fs.existsSync(config.specPath)) {
      return { error: `Arquivo de spec nao encontrado: ${config.specPath}` };
    }

    // Concurrency check: reject if another session is already active
    const engine = getHarnessEngine();
    if (!engine) {
      logger.error({}, 'HarnessEngine not initialized - cannot start enrich session');
      return { error: 'HarnessEngine nao inicializado' };
    }

    if (engine.hasActiveEnrichSession()) {
      logger.warn({ name: config.name }, 'Enrich start rejected: another session already active');
      return {
        error: 'already_active',
        message: 'Ja existe uma sessao de enrich ativa. Finalize ou aborte a sessao atual antes de iniciar uma nova.',
      };
    }

    const sessionId = crypto.randomUUID();

    try {
      const session = insertEnrichSession({
        id: sessionId,
        name: config.name.trim(),
        specPath: config.specPath,
        projectPath: config.projectPath,
        prdPath: config.prdPath,
        userMessage: config.message,
        validatorAgentId: config.validatorAgentId,
      });
      logger.info({ sessionId, name: config.name }, 'Enrich session created - launching engine');

      // Fire-and-forget: the engine streams back to the renderer via IPC
      engine.startEnrichSession({
        sessionId: session.id,
        name: config.name.trim(),
        specPath: config.specPath,
        projectPath: config.projectPath,
        prdPath: config.prdPath,
        message: config.message,
        validatorAgentId: config.validatorAgentId,
      }).catch(err => {
        logger.error({ err, sessionId }, 'Enrich session failed');
      });

      return { sessionId: session.id };
    } catch (err) {
      logger.error({ err, config }, 'Failed to create enrich session');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('enrich:send', async (_event, args: { sessionId: string; message: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }
    if (typeof args.message !== 'string' || !args.message.trim()) {
      return { error: 'Campo message e obrigatorio' };
    }

    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
    }

    const engine = getHarnessEngine();
    if (!engine) {
      return { error: 'HarnessEngine nao inicializado' };
    }

    logger.info({ sessionId: args.sessionId, messageLen: args.message.length }, 'Enrich message received');

    // Fire-and-forget: engine streams the response back via IPC
    engine.sendEnrichMessage(args.sessionId, args.message).catch(err => {
      logger.error({ err, sessionId: args.sessionId }, 'Enrich sendMessage failed');
    });

    return { ok: true };
  });

  ipcMain.handle('enrich:approve-phase', async (_event, args: { sessionId: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }

    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
    }
    if (session.phase !== 'validator') {
      return { error: `Fase invalida para aprovacao. Fase atual: ${session.phase}` };
    }

    const engine = getHarnessEngine();
    if (!engine) {
      return { error: 'HarnessEngine nao inicializado' };
    }

    logger.info({ sessionId: args.sessionId }, 'Enrich phase approved - transitioning to enricher');

    // Fire-and-forget: engine handles the phase transition and streams back
    engine.approveEnrichPhase(args.sessionId).catch(err => {
      logger.error({ err, sessionId: args.sessionId }, 'Enrich approvePhase failed');
    });

    return { ok: true };
  });

  ipcMain.handle('enrich:finalize', async (_event, args: { sessionId: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }

    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
    }
    if (session.phase !== 'enricher') {
      return { error: `Fase invalida para finalizacao. Fase atual: ${session.phase}` };
    }

    const engine = getHarnessEngine();
    if (!engine) {
      return { error: 'HarnessEngine nao inicializado' };
    }

    logger.info({ sessionId: args.sessionId }, 'Enrich finalize requested');

    try {
      const finalSpecPath = engine.finalizeEnrichSession(args.sessionId);
      logger.info({ sessionId: args.sessionId, finalSpecPath }, 'Enrich session finalized');
      return { ok: true, finalSpecPath };
    } catch (err) {
      logger.error({ err, sessionId: args.sessionId }, 'Enrich finalize failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('enrich:get-spec', (_event, args: { sessionId: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }

    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: `Sessao enrich nao encontrada: ${args.sessionId}` };
    }

    return { finalSpecPath: session.finalSpecPath };
  });

  ipcMain.handle('enrich:list-sessions', () => {
    return listEnrichSessions().map(mapEnrichSessionRowToApi);
  });

  ipcMain.handle('enrich:abort', async (_event, args: { sessionId: string }) => {
    if (!args?.sessionId) {
      return { error: 'sessionId obrigatorio' };
    }
    const engine = getHarnessEngine();
    if (!engine) {
      return { error: 'Engine nao inicializada' };
    }
    try {
      engine.abortEnrichSession(args.sessionId);
      logger.info({ sessionId: args.sessionId }, 'Enrich session aborted via IPC');
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, sessionId: args.sessionId }, 'Failed to abort enrich session');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('enrich:delete', async (_event, args: { sessionId: string }) => {
    if (!args?.sessionId) {
      return { error: 'sessionId obrigatorio' };
    }
    const engine = getHarnessEngine();
    // If this session is active, abort it first
    if (engine) {
      try {
        engine.abortEnrichSession(args.sessionId);
      } catch {
        // Not active, that's fine
      }
    }
    try {
      deleteEnrichSession(args.sessionId);
      logger.info({ sessionId: args.sessionId }, 'Enrich session deleted');
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, sessionId: args.sessionId }, 'Failed to delete enrich session');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('enrich:open-spec', async (_event, args: { sessionId: string }) => {
    if (!args?.sessionId) {
      return { error: 'sessionId obrigatorio' };
    }
    const session = getEnrichSession(args.sessionId);
    if (!session) {
      return { error: 'Sessao nao encontrada' };
    }
    const targetPath = session.finalSpecPath || session.specPath;
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      return { error: 'Arquivo nao encontrado' };
    }
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle('enrich:get-messages', (_event, args: { sessionId: string; phase?: string }) => {
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim()) {
      return { error: 'Campo sessionId e obrigatorio' };
    }
    return getEnrichMessages(args.sessionId, args.phase);
  });

  // ---- Memory Graph (conditional) ----
  if (getSetting('mgraph_mode') === 'true') {

    ipcMain.handle('mgraph:graph', () => {
      try {
        return buildGraphData();
      } catch (err) {
        logger.error({ err }, 'mgraph:graph failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:read', (_event, notePath: string) => {
      try {
        return readVaultNote(notePath);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:search', (_event, query: string) => {
      try {
        return searchVault(query);
      } catch (err) {
        logger.error({ err }, 'mgraph:search failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:seed', async (_event, forceReseed?: boolean) => {
      const win = getMainWindow();
      try {
        const result = await seedVault(win, forceReseed === true);
        logger.info({ notes: result.notes, connections: result.connections }, 'Vault seed completed');
      } catch (err) {
        logger.error({ err }, 'Vault seed failed');
        if (win && !win.isDestroyed()) {
          win.webContents.send('mgraph:seed-progress', {
            processed: 0,
            total: 0,
            notesCreated: 0,
          });
        }
      }
    });

    ipcMain.handle('mgraph:stats', () => {
      try {
        return getVaultStats();
      } catch (err) {
        logger.error({ err }, 'mgraph:stats failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:list-notes', (_event, type: string) => {
      try {
        return listNotesByType(type);
      } catch (err) {
        logger.error({ err }, 'mgraph:list-notes failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:delete-note', (_event, notePath: string, options?: { force?: boolean }) => {
      try {
        return deleteVaultNote(notePath, options);
      } catch (err) {
        logger.error({ err }, 'mgraph:delete-note failed');
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('mgraph:note-backlinks', (_event, notePath: string) => {
      try {
        return findBacklinks(notePath);
      } catch (err) {
        logger.error({ err }, 'mgraph:note-backlinks failed');
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    // ---- Ingest ----

    ipcMain.handle('mgraph:ingest-file', async (_event, filePath: string, fileName: string) => {
      try {
        return await ingestFile(filePath, fileName);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-file failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-url', async (_event, url: string) => {
      try {
        return await ingestUrl(url);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-url failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-text', async (_event, text: string, title?: string) => {
      try {
        return await ingestText(text, title);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-text failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-resume', async (_event, jobId: string) => {
      try {
        return await resumeIngestJob(jobId);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-resume failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-history', () => {
      try {
        return getIngestHistory();
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-history failed');
        return [];
      }
    });

    ipcMain.handle('mgraph:ingest-cancel', (_event, jobId: string) => {
      cancelIngest(jobId);
    });

    ipcMain.handle('mgraph:ingest-estimate', async (_event, filePath: string) => {
      try {
        return await estimateIngestFile(filePath);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-estimate failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-discard', (_event, jobId: string) => {
      try {
        discardPartialJob(jobId);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-discard failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-accept', (_event, jobId: string) => {
      try {
        acceptPartialJob(jobId);
      } catch (err) {
        logger.error({ err }, 'mgraph:ingest-accept failed');
        throw err;
      }
    });

    ipcMain.handle('mgraph:ingest-settings', () => {
      return {
        visionModel: (getSetting('ingest_vision_model') as string) || 'claude-sonnet-4-6',
        extractionModel: (getSetting('ingest_extraction_model') as string) || 'claude-sonnet-4-6',
        sttProvider: (getSetting('ingest_stt_provider') as string) || 'whisper',
        maxFileSizeMb: Number(getSetting('ingest_max_file_size_mb')) || 100,
        maxChunks: Number(getSetting('ingest_max_chunks')) || 30,
        autoConfirm: getSetting('ingest_auto_confirm') === 'true',
        pdfExtractor: (getSetting('ingest_pdf_extractor') as string) || 'auto',
        urlLevel: Number(getSetting('ingest_url_level')) || 3,
      };
    });

    ipcMain.handle('mgraph:ingest-settings-update', (_event, settings: Record<string, string>) => {
      for (const [key, value] of Object.entries(settings)) {
        const settingKey = `ingest_${key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`;
        setSetting(settingKey, String(value));
      }
    });

    // Ensure vault structure exists
    createVaultStructure();
    logger.info('Memory Graph handlers registered');
  }

  // ---- Pipeline ----

  ipcMain.handle('pipeline:start', async (_event, projectId: string, startPhase: number) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.startPipeline(projectId, startPhase);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:start failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:advance', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.advancePhase(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:advance failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:abort', (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      engine.abortPipeline(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:abort failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:pause', (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      engine.pausePipeline(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:pause failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:resume', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.resumePipeline(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:resume failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:send', async (_event, projectId: string, message: string, attachments?: Array<{ id: string; type: string; filename: string; mimeType: string; data: string; size: number }>) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.sendMessage(projectId, message, attachments);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:send failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:approve', async (_event, projectId: string, metadata?: Record<string, unknown>) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.approvePhase(projectId, metadata);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:approve failed');
      return { error: (err as Error).message };
    }
  });


  ipcMain.handle('pipeline:metrics', (_event, projectId: string) => {
    try {
      return getPipelineMetrics(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:metrics failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:report', (_event, projectId: string) => {
    try {
      return { report: generatePipelineReport(projectId) };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:report failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:export-report', (_event, projectId: string, format: 'md') => {
    try {
      const reportPath = exportPipelineReport(projectId, format);
      return { ok: true as const, reportPath };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:export-report failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:accept-sprint', async (_event, projectId: string, sprintIndex: number) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.acceptSprint(projectId, sprintIndex);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId, sprintIndex }, 'pipeline:accept-sprint failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:reject-sprint', async (_event, projectId: string, sprintIndex: number) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.rejectSprint(projectId, sprintIndex);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId, sprintIndex }, 'pipeline:reject-sprint failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:decided', async (_event, projectId: string, blockId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.approvePhase(projectId, { blockId });
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId, blockId }, 'pipeline:decided failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:conclude', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.approvePhase(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:conclude failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:confirm-development', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      await engine.confirmStartDevelopment(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:confirm-development failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:retry', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      const project = getHarnessProject(projectId);
      if (!project) return { error: 'Project not found' };
      const phase = project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? 1;
      await engine.startPipeline(projectId, phase);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:retry failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:list-projects', () => {
    try {
      const projects = listHarnessProjects();
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        specPath: p.specPath,
        status: p.status as 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted',
        currentPhase: (p.pipelineCurrentPhase ?? null) as number | null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        metadata: {
          startPhase: p.pipelineStartPhase ?? 1,
          totalSprints: p.totalSprints > 0 ? p.totalSprints : null,
          totalFeatures: p.totalFeatures > 0 ? p.totalFeatures : null,
          currentSprintIndex: p.pipelineSprintIndex ?? null,
          totalSprintsCount: p.totalSprints > 0 ? p.totalSprints : null,
        },
      }));
    } catch (err) {
      logger.error({ err }, 'pipeline:list-projects failed');
      return [];
    }
  });

  ipcMain.handle('pipeline:create-project', async (_event, data: {
    name: string;
    description: string;
    projectPath: string;
    startPhase: number;
    specPath?: string;
    prdPath?: string;
  }) => {
    try {
      const project = insertHarnessProject({
        name: data.name,
        description: data.description ?? '',
        projectPath: data.projectPath,
        specPath: data.specPath ?? '',
        config: {
          maxRoundsPerSprint: 3,
          usePlaywright: false,
          evaluatorAgentId: 'harness-evaluator',
          plannerAgentId: 'harness-planner',
          stack: [],
        },
      });
      updateHarnessProjectPipelineMeta(project.id, {
        pipelineStartPhase: data.startPhase,
        pipelineCurrentPhase: data.startPhase,
        prdPath: data.prdPath ?? null,
        status: 'idle',
      });
      return { id: project.id };
    } catch (err) {
      logger.error({ err, data }, 'pipeline:create-project failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:delete-project', async (_event, projectId: string) => {
    try {
      deleteHarnessProject(projectId);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:delete-project failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:get-project', (_event, projectId: string) => {
    try {
      const p = getHarnessProject(projectId);
      if (!p) return { error: 'Project not found' };
      const sprints = getHarnessSprints(projectId);
      const currentPhase = (p.pipelineCurrentPhase ?? null) as number | null;

      // Conversation phases (1, 3, 5-10, 12) await user input when the project
      // is reopened (there is no active stream at that moment). This is the
      // rehydration counterpart of the pipeline:phase-changed event — without
      // it, after a main-process restart the frontend keeps awaitingUser=false
      // and the "Aprovar" button stays hidden even though the phase is
      // effectively waiting on the user. See BUG-19.
      const CONVERSATION_PHASES = new Set([1, 3, 5, 6, 7, 8, 9, 10, 12]);
      const awaitingUser =
        currentPhase !== null &&
        CONVERSATION_PHASES.has(currentPhase) &&
        p.status !== 'done' &&
        p.status !== 'failed';

      return {
        id: p.id,
        name: p.name,
        specPath: p.specPath,
        status: p.status as 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted',
        currentPhase,
        awaitingUser,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        sprints: sprints.map((s) => ({
          index: s.sprintIndex,
          name: s.name,
          status: s.verdict ?? s.status,
          coderAgentId: s.coderAgentId,
          evaluatorAgentId: s.evaluatorAgentId,
          sprintJsonId: s.sprintJsonId,
          sprintId: s.id,
          rounds: s.roundsUsed,
          metrics: getHarnessSprintAggregateMetrics(s.id),
        })),
      };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:get-project failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:get-phase-messages', (_event, projectId: string, phase: number) => {
    try {
      return getPipelinePhaseMessages(projectId, phase);
    } catch (err) {
      logger.error({ err, projectId, phase }, 'pipeline:get-phase-messages failed');
      return [];
    }
  });

  ipcMain.handle('pipeline:read-phase-document', (_event, projectId: string, phase: number) => {
    try {
      const project = getHarnessProject(projectId);
      if (!project) return { error: 'Project not found' };

      // Map phase number to the appropriate file path on the project (14-phase numbering)
      let filePath: string | null = null;
      if (phase === 1) {
        filePath = project.discoveryNotesPath ?? null;
      } else if (phase === 2 || phase === 3) {
        // User stories / requisitos (generated in phase 2, reviewed in phase 3)
        filePath = project.projectPath
          ? path.join(project.projectPath, 'stories-requisitos.md')
          : null;
      } else if (phase === 4 || phase === 5 || phase === 6 || phase === 7 || phase === 8) {
        // PRD Completo (phase 4) and tech decision phases (5-8) all reference the PRD
        filePath = project.prdPath ?? null;
      } else if (phase === 9 || phase === 10) {
        // SPEC (Spec Generation phase 9, Spec Enricher phase 10)
        filePath = project.specPath ?? null;
      } else if (phase === 11 || phase === 12 || phase === 13 || phase === 14) {
        // Sprints JSON (Planner phase 11, Sprint Validator phase 12, Coder/Evaluator phases 13-14)
        filePath = project.sprintsJsonPath ?? null;
      }

      if (!filePath) {
        return { error: `Nenhum documento disponivel para a Fase ${phase}` };
      }
      if (!fs.existsSync(filePath)) {
        return { error: `Arquivo nao encontrado: ${filePath}` };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      return { path: filePath, content };
    } catch (err) {
      logger.error({ err, projectId, phase }, 'pipeline:read-phase-document failed');
      return { error: (err as Error).message };
    }
  });

  // ---- Pipeline: Reset / Sprint History / Artifact Read ----

  ipcMain.handle('pipeline:reset-phase', async (_event, projectId: string, phase: number) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      return await engine.resetPhase(projectId, phase);
    } catch (err) {
      logger.error({ err, projectId, phase }, 'pipeline:reset-phase failed');
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:reset-sprint', async (_event, projectId: string, sprintIndex: number) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    try {
      return await engine.resetSprint(projectId, sprintIndex);
    } catch (err) {
      logger.error({ err, projectId, sprintIndex }, 'pipeline:reset-sprint failed');
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:get-reset-preview', (_event, projectId: string, target: { phase?: number; sprintIndex?: number }) => {
    const engine = getPipelineEngine();
    if (!engine) return { filesToDelete: [], messagesToDelete: 0, metricsToDelete: 0, sprintsAffected: [] };
    try {
      return engine.getResetPreview(projectId, target);
    } catch (err) {
      logger.error({ err, projectId, target }, 'pipeline:get-reset-preview failed');
      return { filesToDelete: [], messagesToDelete: 0, metricsToDelete: 0, sprintsAffected: [] };
    }
  });

  ipcMain.handle('pipeline:read-phase-artifact', (_event, projectId: string, phase: number) => {
    try {
      const project = getHarnessProject(projectId);
      if (!project) return { error: 'Project not found' };

      // Phase 11: return sprint list from DB
      if (phase === 11) {
        const sprints = getHarnessSprints(projectId);
        return { type: 'sprints' as const, sprints };
      }

      // File-based phases
      let filePath: string | null = null;
      if (phase === 2) {
        filePath = project.projectPath ? path.join(project.projectPath, 'stories-requisitos.md') : null;
      } else if (phase === 4) {
        filePath = project.projectPath ? path.join(project.projectPath, 'PRD.md') : null;
      } else if (phase === 9) {
        filePath = project.specPath ?? path.join(project.projectPath, 'SPEC.md');
      }

      if (!filePath) return { type: 'markdown' as const, content: '' };

      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        // File does not exist yet - return empty content
      }
      return { type: 'markdown' as const, content };
    } catch (err) {
      logger.error({ err, projectId, phase }, 'pipeline:read-phase-artifact failed');
      return { type: 'markdown' as const, content: '' };
    }
  });

  ipcMain.handle('pipeline:get-sprint-history', (_event, projectId: string, sprintIndex: number) => {
    try {
      return listPipelineMessagesForSprint(projectId, sprintIndex);
    } catch (err) {
      logger.error({ err, projectId, sprintIndex }, 'pipeline:get-sprint-history failed');
      return [];
    }
  });

  ipcMain.handle('pipeline:list-sprints', (_event, projectId: string) => {
    try {
      return getHarnessSprints(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:list-sprints failed');
      return [];
    }
  });

  ipcMain.handle('pipeline:get-sprint-detail', (_event, projectId: string, sprintIndex: number) => {
    try {
      const sprint = getHarnessSprintByIndex(projectId, sprintIndex);
      if (!sprint) return { error: 'Sprint not found' };
      return { sprint };
    } catch (err) {
      logger.error({ err }, 'pipeline:get-sprint-detail error');
      return { error: String(err) };
    }
  });

  logger.info('All IPC handlers registered');
}

