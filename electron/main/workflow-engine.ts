// @deprecated - migrado para pipeline-engine/pipeline-store
/**
 * Workflow Engine — executa o fluxo BuildPlan via Claude Agent SDK.
 *
 * Responsabilidades:
 * - executeWorkflowChat(): conversa interativa com o workflow agent (discovery)
 * - executeSpecGeneration(): loop spec-builder → spec-validator (max 3 iterações)
 * - detectStageFromNotes(): detecta etapa atual baseado nos ## headers do discovery-notes.md
 *
 * Sessão e flags são completamente independentes do orchestrator principal.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getApiKey } from './secrets-vault';
import {
  getAgent,
  updateWorkflowStage,
} from './db';
import { SPEC_BUILDER_ID, SPEC_VALIDATOR_ID } from './seed-agents';
import { processAgentStream } from './stream-processor';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import type { WorkflowRun } from '../../src/types';

const logger = createLogger('workflow-engine');

// ---- Sessão de workflow — flags independentes do orchestrator ----
let workflowSessionAlive = false;
let specGenerationRunning = false;

export function resetWorkflowSessionState(): void {
  workflowSessionAlive = false;
  specGenerationRunning = false;
}

// ---- Helpers de path/auth (mesmo padrão do harness-engine) ----

function getClaudeCodeExecutablePath(): string {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return path.join(path.dirname(sdkEntry), 'cli.js');
  } catch {
    const projectRoot = path.join(__dirname, '..', '..');
    return path.join(projectRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  }
}

let _nodePathFixed = false;
function ensureNodeInPath(): void {
  if (_nodePathFixed) return;
  _nodePathFixed = true;

  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) return;
  } catch {
    // node não está no PATH, tentar corrigir
  }

  const commonPaths = process.platform === 'darwin'
    ? ['/usr/local/bin', '/opt/homebrew/bin', path.join(process.env.HOME ?? '', '.nvm/current/bin'), '/usr/bin']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\nodejs', path.join(process.env.APPDATA ?? '', 'nvm\\current')]
      : ['/usr/bin', '/usr/local/bin'];

  const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of commonPaths) {
    if (fs.existsSync(path.join(dir, nodeExe))) {
      const sep = process.platform === 'win32' ? ';' : ':';
      process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`;
      logger.info({ nodeDir: dir }, 'workflow-engine: prepended node directory to PATH');
      return;
    }
  }
}

async function ensureAuthForSDK(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;

  const claudeDir = path.join(process.env.HOME ?? '', '.claude');
  if (fs.existsSync(claudeDir)) return;

  try {
    const apiKey = await getApiKey();
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
    }
  } catch {
    // getApiKey pode falhar em alguns ambientes
  }
}

function emitIPC(getWindow: () => BrowserWindow | null, channel: string, data: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// ---- Bootstrap: copia stage files do projeto para runtime ----

/**
 * Copia os arquivos de stage e template do .lionclaw do projeto
 * para ~/.lionclaw (runtime). Deve ser chamado no startup.
 */
export function bootstrapWorkflowFiles(): void {
  // Detectar raiz do projeto (em dev: process.cwd(), em prod: app.getAppPath())
  const projectRoot = path.join(__dirname, '..', '..');
  const sourceDir = path.join(projectRoot, '.lionclaw', 'workflows', 'build-plan');
  const targetDir = path.join(getLionClawHome(), 'workflows', 'build-plan');

  if (!fs.existsSync(sourceDir)) {
    logger.warn({ sourceDir }, 'bootstrapWorkflowFiles: source dir not found');
    return;
  }

  // Copiar stages/
  const sourceStages = path.join(sourceDir, 'stages');
  const targetStages = path.join(targetDir, 'stages');
  if (fs.existsSync(sourceStages)) {
    fs.mkdirSync(targetStages, { recursive: true });
    for (const file of fs.readdirSync(sourceStages)) {
      const src = path.join(sourceStages, file);
      const dst = path.join(targetStages, file);
      // Sempre sobrescrever para pegar atualizacoes
      fs.copyFileSync(src, dst);
    }
    logger.info({ count: fs.readdirSync(sourceStages).length }, 'bootstrapWorkflowFiles: stage files synced');
  }

  // Copiar discovery-notes.md template (se nao existir)
  const sourceTemplate = path.join(sourceDir, 'discovery-notes.md');
  const targetTemplate = path.join(targetDir, 'discovery-notes.md');
  if (fs.existsSync(sourceTemplate) && !fs.existsSync(targetTemplate)) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(sourceTemplate, targetTemplate);
    logger.info('bootstrapWorkflowFiles: discovery-notes template copied');
  }
}

// ---- Diretórios do workflow ----

function getWorkflowBaseDir(): string {
  return path.join(getLionClawHome(), 'workflows', 'build-plan');
}

function getStagesDir(): string {
  return path.join(getWorkflowBaseDir(), 'stages');
}

function getNotesPath(workflowRun: WorkflowRun): string {
  if (workflowRun.notesPath) return workflowRun.notesPath;
  return path.join(getWorkflowBaseDir(), 'discovery-notes.md');
}

function getSpecPath(): string {
  return path.join(getWorkflowBaseDir(), 'SPEC.md');
}

function getValidationReportPath(): string {
  return path.join(getWorkflowBaseDir(), 'validation-report.md');
}

// ---- Carrega prompt de etapa ----

const STAGE_FILES: Record<number, string> = {
  1: '1-discovery.md',
  2: '2-prd.md',
  3: '3-database.md',
  4: '4-backend.md',
  5: '5-frontend.md',
  6: '6-security.md',
  7: '7-generate.md',
};

function loadStagePrompt(stage: number): string {
  const stagesDir = getStagesDir();
  const fileName = STAGE_FILES[stage];

  if (!fileName) {
    logger.warn({ stage }, 'loadStagePrompt: stage number not mapped');
    return `Voce esta na etapa ${stage} do workflow. Continue coletando informacoes e registrando no discovery-notes.md.`;
  }

  const stagePath = path.join(stagesDir, fileName);

  if (fs.existsSync(stagePath)) {
    return fs.readFileSync(stagePath, 'utf-8');
  }

  logger.warn({ stagePath }, 'loadStagePrompt: stage file not found');
  return `Voce esta na etapa ${stage} do workflow. Continue coletando informacoes e registrando no discovery-notes.md.`;
}

// ---- Monta system prompt do workflow ----

function buildWorkflowSystemPrompt(workflowRun: WorkflowRun): string {
  // Carrega APENAS o prompt da etapa atual.
  // Carregar todas as etapas de uma vez faz o LLM pular etapas e preencher tudo de uma vez.
  const currentStagePrompt = loadStagePrompt(workflowRun.currentStage);

  const notesPath = getNotesPath(workflowRun);
  let notesContent = '';
  if (fs.existsSync(notesPath)) {
    notesContent = fs.readFileSync(notesPath, 'utf-8');
  }

  let systemPrompt = currentStagePrompt;

  // Guardrail: forcar o agente a seguir apenas a etapa atual
  systemPrompt += `\n\n---\n\n## REGRA CRITICA\n\nVoce esta na ETAPA ${workflowRun.currentStage}. Foque EXCLUSIVAMENTE nas perguntas e tarefas desta etapa. NAO preencha secoes de etapas futuras no discovery-notes.md. Faca UMA pergunta por vez e espere a resposta do usuario.`;

  if (notesContent) {
    systemPrompt += `\n\n## Estado Atual do Discovery (${notesPath})\n\n${notesContent}`;
  } else {
    systemPrompt += `\n\nO arquivo de notas sera criado em: ${notesPath}`;
  }

  return systemPrompt;
}

// ---- detectStageFromNotes ----

/**
 * Detecta a etapa atual (1-6) com base nos headers ## presentes no discovery-notes.md.
 * Quanto mais seções preenchidas, maior a etapa.
 */
export function detectStageFromNotes(notesContent: string): number {
  if (!notesContent || notesContent.trim() === '') return 1;

  // Checa se uma secao tem conteudo real (nao apenas header + placeholder)
  const hasContent = (sectionHeader: string): boolean => {
    const regex = new RegExp(`^##\\s+${escapeRegex(sectionHeader)}[\\s\\S]*?(?=^## |$)`, 'gm');
    const match = notesContent.match(regex);
    if (!match) return false;
    const sectionBody = match[0].replace(/^##[^\n]+\n/, '').replace(/^>[^\n]+\n/gm, '').trim();
    return sectionBody.length > 0 && !sectionBody.startsWith('[');
  };

  // Checar de tras pra frente (etapa mais avancada primeiro)
  if (hasContent('Security - Decisoes')) return 6;
  if (hasContent('Frontend - Paginas e Componentes') || hasContent('Frontend - Design System')) return 5;
  if (hasContent('Backend - Endpoints e Integracoes') || hasContent('Backend - Agent Graph')) return 4;
  if (hasContent('Database - Entidades e Relacoes')) return 3;
  if (hasContent('PRD - User Stories') || hasContent('PRD - Requisitos Funcionais') || hasContent('PRD - Requisitos Nao-Funcionais')) return 2;

  return 1;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- executeWorkflowChat ----

/**
 * Executa uma mensagem do usuário no contexto do workflow de discovery.
 * Mantém sessão SDK própria (independente do orchestrator).
 * Faz streaming dos resultados via IPC e detecta mudanças no discovery-notes.md.
 */
export async function executeWorkflowChat(
  message: string,
  workflowRun: WorkflowRun,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  ensureNodeInPath();
  await ensureAuthForSDK();

  const cliPath = getClaudeCodeExecutablePath();
  const notesPath = getNotesPath(workflowRun);
  const workflowCwd = getWorkflowBaseDir();

  // Garantir que diretório existe
  fs.mkdirSync(workflowCwd, { recursive: true });

  const systemPrompt = buildWorkflowSystemPrompt(workflowRun);

  // Captura conteúdo anterior das notas para detectar mudanças
  let previousNotesContent = '';
  if (fs.existsSync(notesPath)) {
    previousNotesContent = fs.readFileSync(notesPath, 'utf-8');
  }

  logger.info(
    { workflowRunId: workflowRun.id, stage: workflowRun.currentStage, sessionAlive: workflowSessionAlive },
    'executeWorkflowChat: starting',
  );

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // First call: start a fresh session (no resume - the sessionId is just a DB identifier,
    // not an existing SDK session). Subsequent calls: continue the live session.
    const sessionOpts = workflowSessionAlive
      ? { continue: true as const }
      : {};

    // Try to resolve the discovery agent config if a discovery agent is configured.
    // Fall back to hardcoded defaults if no discovery agent exists (e.g. first run before seed).
    let discoveryAllowedTools: string[] = ['Write', 'Edit', 'Read'];
    let discoveryMcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined;

    // No fixed discovery agent ID exists — we use the workflow system prompt directly.
    // However, if a dedicated workflow discovery agent is found in DB (squad='workflow'),
    // we can use resolveAgentQueryConfig to enrich the config.
    // For now, fallback config is used to preserve existing behaviour exactly.
    // When a workflow-discovery agent is seeded, update this block to call resolveAgentQueryConfig.

    const q = query({
      prompt: message,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: workflowCwd,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code' as const,
          append: systemPrompt,
        },
        allowedTools: discoveryAllowedTools,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        ...(discoveryMcpServers ? { mcpServers: discoveryMcpServers } : {}),
        ...sessionOpts,
      },
    });

    workflowSessionAlive = true;

    await processAgentStream(q as unknown as AsyncIterable<Record<string, unknown>>, {
      onText: (text) => {
        emitIPC(getWindow, 'workflow:stream', { type: 'text', content: text });
      },
      onToolUse: (tool) => {
        emitIPC(getWindow, 'workflow:stream', { type: 'tool_call', tool });
      },
      onMessageStop: () => {
        // CRITICAL: notes change detection — must be preserved exactly
        if (fs.existsSync(notesPath)) {
          const currentNotesContent = fs.readFileSync(notesPath, 'utf-8');
          if (currentNotesContent !== previousNotesContent) {
            emitIPC(getWindow, 'workflow:notes-updated', {
              content: currentNotesContent,
              path: notesPath,
            });

            const newStage = detectStageFromNotes(currentNotesContent);
            if (newStage !== workflowRun.currentStage) {
              logger.info(
                { runId: workflowRun.id, prevStage: workflowRun.currentStage, newStage },
                'Stage changed',
              );
              updateWorkflowStage(workflowRun.id, newStage);
              workflowRun.currentStage = newStage;
              emitIPC(getWindow, 'workflow:stage-changed', { stage: newStage });
            }

            previousNotesContent = currentNotesContent;
          }
        }
      },
    });

    // Verificar notas ao final também (caso message_stop não seja emitido)
    if (fs.existsSync(notesPath)) {
      const finalNotesContent = fs.readFileSync(notesPath, 'utf-8');
      if (finalNotesContent !== previousNotesContent) {
        emitIPC(getWindow, 'workflow:notes-updated', {
          content: finalNotesContent,
          path: notesPath,
        });

        const newStage = detectStageFromNotes(finalNotesContent);
        if (newStage !== workflowRun.currentStage) {
          updateWorkflowStage(workflowRun.id, newStage);
          workflowRun.currentStage = newStage;
          emitIPC(getWindow, 'workflow:stage-changed', { stage: newStage });
        }
      }
    }

    emitIPC(getWindow, 'workflow:stream', { type: 'done' });

  } catch (err) {
    workflowSessionAlive = false;
    logger.error({ err, workflowRunId: workflowRun.id }, 'executeWorkflowChat failed');
    emitIPC(getWindow, 'workflow:stream', {
      type: 'error',
      error: (err as Error).message,
    });
    throw err;
  }
}

// ---- executeSpecGeneration ----

/**
 * Executa o loop spec-builder → spec-validator com máximo de 3 iterações.
 * Faz streaming dos resultados de cada agente via IPC.
 * Guard: rejeita chamadas concorrentes para evitar double-fire.
 */
export async function executeSpecGeneration(
  workflowRun: WorkflowRun,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (specGenerationRunning) {
    logger.warn({ workflowRunId: workflowRun.id }, 'executeSpecGeneration: already running, skipping duplicate call');
    return;
  }
  specGenerationRunning = true;

  try {
    await _executeSpecGenerationInner(workflowRun, getWindow);
  } finally {
    specGenerationRunning = false;
  }
}

async function _executeSpecGenerationInner(
  workflowRun: WorkflowRun,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  ensureNodeInPath();
  await ensureAuthForSDK();

  const cliPath = getClaudeCodeExecutablePath();
  const workflowCwd = getWorkflowBaseDir();
  const notesPath = getNotesPath(workflowRun);
  const specPath = getSpecPath();
  const validationReportPath = getValidationReportPath();

  // Garantir que diretório existe
  fs.mkdirSync(workflowCwd, { recursive: true });

  const builderAgent = getAgent(SPEC_BUILDER_ID);
  const validatorAgent = getAgent(SPEC_VALIDATOR_ID);

  if (!builderAgent) {
    throw new Error(`Agente spec-builder não encontrado (id: ${SPEC_BUILDER_ID})`);
  }
  if (!validatorAgent) {
    throw new Error(`Agente spec-validator não encontrado (id: ${SPEC_VALIDATOR_ID})`);
  }

  const MAX_ROUNDS = 3;
  let passed = false;

  logger.info({ workflowRunId: workflowRun.id, maxRounds: MAX_ROUNDS }, 'executeSpecGeneration: starting');

  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // Resolve enriched configs via resolveAgentQueryConfig.
  // Falls back to agent DB data if resolver throws (e.g. agent not seeded yet).
  let builderAllowedTools: string[] = ['Write', 'Edit', 'Read'];
  let builderModel: string = builderAgent.model;
  let builderSystemPrompt: string = builderAgent.systemPrompt ?? '';
  let builderMcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined;

  let validatorAllowedTools: string[] = ['Write', 'Edit', 'Read'];
  let validatorModel: string = validatorAgent.model;
  let validatorSystemPrompt: string = validatorAgent.systemPrompt ?? '';
  let validatorMcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined;

  try {
    const builderConfig = await resolveAgentQueryConfig(SPEC_BUILDER_ID);
    builderAllowedTools = builderConfig.allowedTools;
    builderModel = builderConfig.model;
    builderSystemPrompt = builderConfig.systemPrompt;
    if (builderConfig.mcpServers.length > 0) {
      builderMcpServers = Object.fromEntries(builderConfig.mcpServers.flatMap((s) => Object.entries(s)));
    }
    logger.info({ agentId: SPEC_BUILDER_ID }, 'Resolved builder config via resolveAgentQueryConfig');
  } catch (resolveErr) {
    logger.warn({ err: resolveErr, agentId: SPEC_BUILDER_ID }, 'resolveAgentQueryConfig failed for spec-builder, using DB fallback');
  }

  try {
    const validatorConfig = await resolveAgentQueryConfig(SPEC_VALIDATOR_ID);
    validatorAllowedTools = validatorConfig.allowedTools;
    validatorModel = validatorConfig.model;
    validatorSystemPrompt = validatorConfig.systemPrompt;
    if (validatorConfig.mcpServers.length > 0) {
      validatorMcpServers = Object.fromEntries(validatorConfig.mcpServers.flatMap((s) => Object.entries(s)));
    }
    logger.info({ agentId: SPEC_VALIDATOR_ID }, 'Resolved validator config via resolveAgentQueryConfig');
  } catch (resolveErr) {
    logger.warn({ err: resolveErr, agentId: SPEC_VALIDATOR_ID }, 'resolveAgentQueryConfig failed for spec-validator, using DB fallback');
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    emitIPC(getWindow, 'workflow:generation-round', { round, max: MAX_ROUNDS });

    logger.info({ round, maxRounds: MAX_ROUNDS }, 'Generation round started');

    // --- Spec Builder ---

    let builderPrompt: string;
    if (round === 1) {
      // Primeira iteração: builder recebe discovery-notes.md como contexto
      const notesContent = fs.existsSync(notesPath)
        ? fs.readFileSync(notesPath, 'utf-8')
        : '';
      builderPrompt = `Gere o SPEC.md a partir do discovery-notes.md abaixo.\n\nSalve o resultado em: ${specPath}\n\n## Discovery Notes\n\n${notesContent}`;
    } else {
      // Iterações seguintes: builder recebe SPEC.md + validation-report para corrigir
      const specContent = fs.existsSync(specPath)
        ? fs.readFileSync(specPath, 'utf-8')
        : '';
      const validationContent = fs.existsSync(validationReportPath)
        ? fs.readFileSync(validationReportPath, 'utf-8')
        : '';
      builderPrompt = `Corrija o SPEC.md com base no validation-report abaixo.\n\nSalve o resultado corrigido em: ${specPath}\n\n## SPEC.md Atual\n\n${specContent}\n\n## Validation Report\n\n${validationContent}`;
    }

    const builderQ = query({
      prompt: builderPrompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: workflowCwd,
        model: builderModel,
        systemPrompt: builderSystemPrompt
          ? { type: 'preset', preset: 'claude_code' as const, append: builderSystemPrompt }
          : { type: 'preset', preset: 'claude_code' as const },
        allowedTools: builderAllowedTools,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        ...(builderMcpServers ? { mcpServers: builderMcpServers } : {}),
      },
    });

    await processAgentStream(builderQ as unknown as AsyncIterable<Record<string, unknown>>, {
      onText: (text) => {
        emitIPC(getWindow, 'workflow:agent-stream', {
          agent: 'spec-builder',
          msg: { type: 'text', content: text },
        });
      },
      onToolUse: (tool) => {
        emitIPC(getWindow, 'workflow:agent-stream', {
          agent: 'spec-builder',
          msg: { type: 'tool_call', tool },
        });
      },
    });

    // --- Spec Validator ---

    const specContent = fs.existsSync(specPath)
      ? fs.readFileSync(specPath, 'utf-8')
      : '';
    const notesContentForValidator = fs.existsSync(notesPath)
      ? fs.readFileSync(notesPath, 'utf-8')
      : '';

    const validatorPrompt = `Valide o SPEC.md abaixo contra o discovery-notes.md.\n\nSalve o relatório de validação em: ${validationReportPath}\n\n## SPEC.md\n\n${specContent}\n\n## Discovery Notes\n\n${notesContentForValidator}`;

    const validatorQ = query({
      prompt: validatorPrompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: workflowCwd,
        model: validatorModel,
        systemPrompt: validatorSystemPrompt
          ? { type: 'preset', preset: 'claude_code' as const, append: validatorSystemPrompt }
          : { type: 'preset', preset: 'claude_code' as const },
        allowedTools: validatorAllowedTools,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        ...(validatorMcpServers ? { mcpServers: validatorMcpServers } : {}),
      },
    });

    await processAgentStream(validatorQ as unknown as AsyncIterable<Record<string, unknown>>, {
      onText: (text) => {
        emitIPC(getWindow, 'workflow:agent-stream', {
          agent: 'spec-validator',
          msg: { type: 'text', content: text },
        });
      },
      onToolUse: (tool) => {
        emitIPC(getWindow, 'workflow:agent-stream', {
          agent: 'spec-validator',
          msg: { type: 'tool_call', tool },
        });
      },
    });

    // --- Verificar resultado da validação ---

    const validationReport = fs.existsSync(validationReportPath)
      ? fs.readFileSync(validationReportPath, 'utf-8')
      : '';

    if (validationReport.includes('## Status: PASS')) {
      passed = true;
      logger.info({ round }, 'Validation PASSED — stopping loop');
      break;
    }

    logger.info({ round, passed: false }, 'Validation FAILED — continuing to next round');
  }

  logger.info({ passed, workflowRunId: workflowRun.id }, 'executeSpecGeneration: finished');

  const specContent = fs.existsSync(specPath)
    ? fs.readFileSync(specPath, 'utf-8')
    : '';
  const validationContent = fs.existsSync(validationReportPath)
    ? fs.readFileSync(validationReportPath, 'utf-8')
    : '';

  emitIPC(getWindow, 'workflow:generation-done', {
    specPath,
    notesPath,
    passed,
    specContent,
    validationContent,
  });
}
