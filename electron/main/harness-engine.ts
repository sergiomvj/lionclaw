import { BrowserWindow } from 'electron';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getApiKey } from './secrets-vault';
import { getMCPConfigForAgent } from './mcp-manager';
import { processAgentStream } from './stream-processor';

/**
 * Resolve the path to the Claude Code CLI executable.
 * The SDK normally resolves this via import.meta.url, but in Electron's
 * main process context the resolution can fail. We resolve it explicitly.
 */
function getClaudeCodeExecutablePath(): string {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return path.join(path.dirname(sdkEntry), 'cli.js');
  } catch {
    // Fallback: resolve from project root
    const projectRoot = path.join(__dirname, '..', '..');
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
function ensureNodeInPath(): void {
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
async function ensureAuthForSDK(): Promise<void> {
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

import {
  getHarnessProject,
  updateHarnessProject,
  getHarnessSprints,
  updateHarnessSprint,
  getAgent,
  getAllAgents,
  insertHarnessRound,
  updateHarnessRound,
  getDb,
  getEnrichSession,
  updateEnrichSession,
  accumulateEnrichMetrics,
  insertEnrichMessage,
  savePipelineMessage,
} from './db';
import { calculateCost } from './pricing';
import {
  buildPlannerPrompt,
  buildPlannerMarkdownPrompt,
  buildRegenerationPrompt,
  parsePlannerOutput,
  parsePlannerMarkdown,
  saveSprintsJson,
  readLatestSprintsJson,
} from './harness-planner';
import type { SprintJsonEntry } from './harness-planner';
import {
  buildCoderPrompt,
  buildCoderFeedbackPrompt,
  buildValidatorPrompt,
  buildEnricherPrompt,
  buildValidatorFollowUpPrompt,
  buildEnricherFollowUpPrompt,
} from './harness-prompts';
import {
  buildEvaluatorPrompt,
  parseEvaluationOutput,
  validateCriteria,
  updateSpecProgress,
  buildFeedbackFromEvaluation,
} from './harness-evaluator';
import { setActiveEnrichSpecPath } from './permission-guard';
import { ollamaChatWithTools } from './ollama-client';
import type { OllamaToolSchema, LocalLLMProvider } from './ollama-client';
import type { EvaluationResult, CreateEnrichConfig, EnrichPhase } from '../../src/types';

const logger = createLogger('harness-engine');

/**
 * Resolve mcpServers config for a harness agent query() call.
 * Uses the same function as the orchestrator (getMCPConfigForAgent)
 * which returns the Record<string, McpConfig> format that query() expects.
 */
async function resolveMCPsForHarnessAgent(agentId: string): Promise<Record<string, { command: string; args: string[]; env?: Record<string, string> }> | undefined> {
  return getMCPConfigForAgent(agentId);
}

// ---------------------------------------------------------------------------
// Helper: convert builtin tool names to OllamaToolSchema for local runtime
// ---------------------------------------------------------------------------

function builtinToolsToOllamaSchemas(toolNames: string[]): OllamaToolSchema[] {
  const SCHEMAS: Record<string, OllamaToolSchema> = {
    Read: {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read the contents of a file from the filesystem.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            offset: { type: 'number', description: 'Line offset (0-based).' },
            limit: { type: 'number', description: 'Max lines to read.' },
          },
          required: ['file_path'],
        },
      },
    },
    Write: {
      type: 'function',
      function: {
        name: 'Write',
        description: 'Write content to a file, creating it if necessary.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            content: { type: 'string', description: 'Content to write.' },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    Edit: {
      type: 'function',
      function: {
        name: 'Edit',
        description: 'Replace a substring in a file with new content.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file.' },
            old_string: { type: 'string', description: 'Exact string to replace.' },
            new_string: { type: 'string', description: 'Replacement string.' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    Glob: {
      type: 'function',
      function: {
        name: 'Glob',
        description: 'Find files matching a glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern to match.' },
            path: { type: 'string', description: 'Base directory path.' },
          },
          required: ['pattern'],
        },
      },
    },
    Grep: {
      type: 'function',
      function: {
        name: 'Grep',
        description: 'Search for a regex pattern in files.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search.' },
            path: { type: 'string', description: 'Directory or file to search.' },
            glob: { type: 'string', description: 'File glob filter.' },
          },
          required: ['pattern'],
        },
      },
    },
    Bash: {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Execute a shell command.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            timeout: { type: 'number', description: 'Timeout in milliseconds.' },
          },
          required: ['command'],
        },
      },
    },
  };

  return toolNames
    .filter((n) => !n.startsWith('mcp__'))
    .map((n) => SCHEMAS[n])
    .filter((s): s is OllamaToolSchema => s !== undefined);
}

interface HarnessState {
  status: 'idle' | 'planning' | 'running' | 'paused';
  projectId: string | null;
  currentSprintIndex: number;
  abortController: AbortController | null;
  pauseRequested: boolean;
}

interface ActiveEnrichSession {
  sessionId: string;
  specPath: string;
  phase: EnrichPhase;
  abort: AbortController;
}

export interface SprintMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
}

export interface SprintResult {
  verdict: string;
  rounds: number;
  metrics: { coder: SprintMetrics; evaluator: SprintMetrics };
  coderMetrics: SprintMetrics;
  evaluatorMetrics: SprintMetrics;
}

export class HarnessEngine {
  private getWindow: () => BrowserWindow | null;
  private states: Map<string, HarnessState> = new Map();
  private activeEnrichSession: ActiveEnrichSession | null = null;
  private streamBridge: ((channel: string, data: unknown) => void) | null = null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /** Set a callback that receives all emitIPC calls (used by PipelineEngine to forward stream events). */
  setStreamBridge(bridge: (channel: string, data: unknown) => void): void {
    this.streamBridge = bridge;
  }

  /** Remove the stream bridge callback. */
  clearStreamBridge(): void {
    this.streamBridge = null;
  }

  private getProjectDir(projectId: string): string {
    return path.join(getLionClawHome(), 'harness', 'projects', projectId);
  }

  private ensureProjectDirs(projectId: string): void {
    const projectDir = this.getProjectDir(projectId);
    fs.mkdirSync(path.join(projectDir, 'sprints'), { recursive: true });
  }

  private emitIPC(channel: string, data: unknown): void {
    try {
      if (this.streamBridge) {
        this.streamBridge(channel, data);
      }
    } catch {
      // Bridge target (PipelineEngine) window may have been destroyed
    }
    try {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Render frame disposed (e.g. GPU crash, window reload)
    }
  }

  /**
   * Persist a stream event to a JSONL file for later retrieval.
   * Files: sprints/{sprintId}/round-{n}-{agent}.jsonl
   */
  private persistStreamEvent(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
    event: { type: string; content?: string; tool?: string },
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `round-${round}-${agent}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
    } catch {
      // Non-critical - don't break execution
    }
  }

  /**
   * Persist evaluator→coder feedback audit trail.
   * File: sprints/{sprintId}/feedback-audit.jsonl
   */
  private persistFeedbackAudit(
    projectId: string,
    sprintId: string,
    round: number,
    evaluatorVerdict: string,
    evaluatorSummary: string,
    failedCriteria: { description: string; justification: string }[],
    feedbackInjected: string,
  ): void {
    try {
      const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'feedback-audit.jsonl');
      const entry = {
        timestamp: new Date().toISOString(),
        round,
        evaluatorVerdict,
        evaluatorSummary,
        failedCriteria,
        feedbackInjectedIntoCoder: feedbackInjected,
      };
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
  }

  /**
   * Read persisted stream log for a sprint/round/agent.
   */
  getStreamLog(
    projectId: string,
    sprintId: string,
    round: number,
    agent: string,
  ): { type: string; content?: string; tool?: string }[] {
    const filePath = path.join(
      this.getProjectDir(projectId), 'sprints', sprintId, `round-${round}-${agent}.jsonl`,
    );
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Read the latest stream log for a sprint (most recent round, both agents).
   */
  getLatestStreamLogs(
    projectId: string,
    sprintId: string,
  ): { coder: { type: string; content?: string; tool?: string }[]; evaluator: { type: string; content?: string; tool?: string }[]; round: number } {
    const dir = path.join(this.getProjectDir(projectId), 'sprints', sprintId);
    if (!fs.existsSync(dir)) return { coder: [], evaluator: [], round: 0 };

    // Find the highest round number
    const files = fs.readdirSync(dir).filter(f => f.startsWith('round-') && f.endsWith('.jsonl'));
    let maxRound = 0;
    for (const f of files) {
      const match = f.match(/^round-(\d+)-/);
      if (match) {
        const r = parseInt(match[1], 10);
        if (r > maxRound) maxRound = r;
      }
    }

    if (maxRound === 0) return { coder: [], evaluator: [], round: 0 };

    return {
      coder: this.getStreamLog(projectId, sprintId, maxRound, 'coder'),
      evaluator: this.getStreamLog(projectId, sprintId, maxRound, 'evaluator'),
      round: maxRound,
    };
  }

  private getState(projectId: string): HarnessState {
    if (!this.states.has(projectId)) {
      this.states.set(projectId, {
        status: 'idle',
        projectId,
        currentSprintIndex: -1,
        abortController: null,
        pauseRequested: false,
      });
    }
    return this.states.get(projectId)!;
  }

  /**
   * Run the Planner agent against the project spec and produce sprints.json.
   */
  async plan(projectId: string): Promise<void> {
    ensureNodeInPath();

    const state = this.getState(projectId);
    state.status = 'planning';
    state.abortController = new AbortController();

    this.ensureProjectDirs(projectId);

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    updateHarnessProject(projectId, { status: 'planning' });
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      // 1. Read spec content
      if (!fs.existsSync(project.specPath)) {
        throw new Error(`Spec file not found: ${project.specPath}`);
      }
      const specContent = fs.readFileSync(project.specPath, 'utf-8');

      // 2. Get planner agent config
      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      // 3. Get all available agents for the list in the prompt
      const allAgents = getAllAgents();

      // 4. Build the planner prompt (JSON or Markdown based on config)
      const outputFormat = project.config.plannerOutputFormat ?? 'json';
      const prompt = outputFormat === 'markdown'
        ? buildPlannerMarkdownPrompt(specContent, project, allAgents)
        : buildPlannerPrompt(specContent, project, allAgents);

      // 5. Validate cwd exists (spawn ENOENT on missing cwd is misleading)
      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}. Create the directory first.`);
      }

      let fullOutput: string;
      let inputTokens: number;
      let outputTokens: number;
      let cacheReadTokens: number;
      let cacheCreationTokens: number;

      const plannerToolNames = ['Read', 'Glob', 'Grep', 'WebSearch'];

      // ---- Local LLM path (Ollama / LM Studio / OpenAI-compatible) ----
      if (plannerAgent.runtime === 'local' && plannerAgent.localConfig) {
        const localCfg = plannerAgent.localConfig;
        const localTools = builtinToolsToOllamaSchemas(plannerToolNames);

        logger.info(
          { projectId, provider: localCfg.provider, model: localCfg.model },
          'Spawning Planner via local LLM',
        );

        const localResult = await ollamaChatWithTools(
          localCfg.baseUrl,
          localCfg.model,
          plannerAgent.systemPrompt || '',
          prompt,
          localTools,
          {
            cwd: project.projectPath,
            provider: (localCfg.provider || 'ollama') as LocalLLMProvider,
            onText: (text) => {
              this.emitIPC('harness:agent-stream', {
                projectId,
                agent: 'planner',
                event: { type: 'text', content: text },
              });
            },
            onToolUse: (record) => {
              this.emitIPC('harness:agent-stream', {
                projectId,
                agent: 'planner',
                event: { type: 'tool_use', tool: record.tool },
              });
            },
          },
        );

        fullOutput = localResult.content;
        inputTokens = localResult.promptTokens;
        outputTokens = localResult.tokensUsed;
        cacheReadTokens = 0;
        cacheCreationTokens = 0;

        logger.info('Planner finished (local)');
      } else {
        // ---- Cloud SDK path ----
        const cliPath = getClaudeCodeExecutablePath();
        if (!fs.existsSync(cliPath)) {
          throw new Error(`Claude Agent SDK cli.js not found at ${cliPath}. Run npm install.`);
        }

        await ensureAuthForSDK();

        logger.info({ cwd: project.projectPath, cliPath }, 'Spawning planner agent');

        const { query } = await import('@anthropic-ai/claude-agent-sdk');

        const plannerMcps = await resolveMCPsForHarnessAgent(project.config.plannerAgentId);
        const q = query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: cliPath,
            cwd: project.projectPath,
            model: plannerAgent.model,
            systemPrompt: plannerAgent.systemPrompt || '',
            allowedTools: plannerToolNames,
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true,
            abortController: state.abortController,
            ...(plannerMcps ? { mcpServers: plannerMcps } : {}),
            stderr: (text: string) => {
              logger.info({ stderr: text.substring(0, 500) }, 'Planner stderr');
            },
          },
        });

        logger.info('Planner query created, starting stream iteration...');

        const { output: plannerOutput, metrics: planMetrics } = await processAgentStream(q, {
          shouldAbort: () => state.abortController?.signal.aborted ?? false,
          onText: (text) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'text', content: text },
            });
          },
          onThinking: (text) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'thinking', content: text },
            });
          },
          onToolUse: (toolName) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'tool_use', tool: toolName },
            });
          },
          onResult: (resultText) => {
            logger.info({ outputLen: resultText.length }, 'Planner result received');
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              event: { type: 'text', content: '\n[Planner concluiu - processando resultado...]\n' },
            });
          },
        });

        logger.info('Planner stream finished');

        fullOutput = plannerOutput;
        inputTokens = planMetrics.inputTokens;
        outputTokens = planMetrics.outputTokens;
        cacheReadTokens = planMetrics.cacheReadTokens;
        cacheCreationTokens = planMetrics.cacheCreationTokens;
      }

      if (state.abortController?.signal.aborted) {
        updateHarnessProject(projectId, { status: 'failed' });
        this.emitIPC('harness:project-update', { projectId, status: 'failed' });
        state.status = 'idle';
        return;
      }

      // 7. Parse planner output (JSON or Markdown based on config)
      const sprintsJson = outputFormat === 'markdown'
        ? parsePlannerMarkdown(fullOutput, project)
        : parsePlannerOutput(fullOutput);

      // 8. Save sprints.json + create DB sprint records
      const projectDir = this.getProjectDir(projectId);
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        projectDir,
        sprintsJson,
        project.config.evaluatorAgentId,
        outputFormat,
      );

      // 9. Update project in DB
      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      // 10. Emit planning-done
      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
      });

      // 11. Track planner metrics directly on the project record
      const durationMs = Date.now() - startedAt;
      const costUsd = calculateCost(
        plannerAgent.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      );

      updateHarnessProject(projectId, {
        plannerInputTokens: inputTokens,
        plannerOutputTokens: outputTokens,
        plannerCacheTokens: cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: costUsd,
        plannerDurationMs: durationMs,
      });

      logger.info(
        { projectId, totalSprints: sprintsJson.metadata.total_sprints, durationMs, costUsd },
        'Planning completed',
      );

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });

    } catch (err) {
      logger.error({ err, projectId }, 'Planning failed');
      updateHarnessProject(projectId, { status: 'failed' });
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      state.status = 'idle';
    }
  }

  /**
   * Regenerate sprints.json by re-running the Planner with user feedback.
   */
  async regenerate(projectId: string, feedback: string): Promise<void> {
    const state = this.getState(projectId);
    state.status = 'planning';
    state.abortController = new AbortController();

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    updateHarnessProject(projectId, { status: 'planning' });
    this.emitIPC('harness:project-update', { projectId, status: 'planning' });

    const startedAt = Date.now();

    try {
      // 1. Read current sprints.json
      const projectDir = this.getProjectDir(projectId);
      const previousJson = readLatestSprintsJson(projectDir);
      if (!previousJson) {
        throw new Error('No existing sprints.json found to regenerate from');
      }

      // 2. Read spec content
      if (!fs.existsSync(project.specPath)) {
        throw new Error(`Spec file not found: ${project.specPath}`);
      }
      const specContent = fs.readFileSync(project.specPath, 'utf-8');

      // 3. Build regeneration prompt
      const plannerAgent = getAgent(project.config.plannerAgentId);
      if (!plannerAgent) {
        throw new Error(`Planner agent not found: ${project.config.plannerAgentId}`);
      }

      const allAgents = getAllAgents();
      const regenFormat = project.config.plannerOutputFormat ?? 'json';
      const prompt = buildRegenerationPrompt(previousJson, feedback, specContent, allAgents, regenFormat);

      // 4. Validate cwd
      if (!fs.existsSync(project.projectPath)) {
        throw new Error(`Project path does not exist: ${project.projectPath}`);
      }

      let fullOutput: string;
      let inputTokens: number;
      let outputTokens: number;
      let cacheReadTokens: number;
      let cacheCreationTokens: number;

      const replanToolNames = ['Read', 'Glob', 'Grep', 'WebSearch'];

      // ---- Local LLM path ----
      if (plannerAgent.runtime === 'local' && plannerAgent.localConfig) {
        const localCfg = plannerAgent.localConfig;
        const localTools = builtinToolsToOllamaSchemas(replanToolNames);

        const localResult = await ollamaChatWithTools(
          localCfg.baseUrl,
          localCfg.model,
          plannerAgent.systemPrompt || '',
          prompt,
          localTools,
          {
            cwd: project.projectPath,
            provider: (localCfg.provider || 'ollama') as LocalLLMProvider,
            onText: (text) => {
              this.emitIPC('harness:agent-stream', { projectId, agent: 'planner', type: 'text', content: text });
            },
          },
        );

        fullOutput = localResult.content;
        inputTokens = localResult.promptTokens;
        outputTokens = localResult.tokensUsed;
        cacheReadTokens = 0;
        cacheCreationTokens = 0;
      } else {
        // ---- Cloud SDK path ----
        const cliPath = getClaudeCodeExecutablePath();
        await ensureAuthForSDK();

        const { query } = await import('@anthropic-ai/claude-agent-sdk');

        const replanMcps = await resolveMCPsForHarnessAgent(project.config.plannerAgentId);
        const q = query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: cliPath,
            cwd: project.projectPath,
            model: plannerAgent.model,
            systemPrompt: plannerAgent.systemPrompt || '',
            allowedTools: replanToolNames,
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true,
            abortController: state.abortController,
            ...(replanMcps ? { mcpServers: replanMcps } : {}),
          },
        });

        const { output: replanOutput, metrics: regenMetrics } = await processAgentStream(q, {
          shouldAbort: () => state.abortController?.signal.aborted ?? false,
          onText: (text) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              type: 'text',
              content: text,
            });
          },
          onRawEvent: (event) => {
            this.emitIPC('harness:agent-stream', {
              projectId,
              agent: 'planner',
              type: 'sdk_event',
              event,
            });
          },
        });

        fullOutput = replanOutput;
        inputTokens = regenMetrics.inputTokens;
        outputTokens = regenMetrics.outputTokens;
        cacheReadTokens = regenMetrics.cacheReadTokens;
        cacheCreationTokens = regenMetrics.cacheCreationTokens;
      }

      if (state.abortController?.signal.aborted) {
        updateHarnessProject(projectId, { status: 'reviewing' });
        this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });
        state.status = 'idle';
        return;
      }

      // 5. Delete old sprint records for this project
      const db = getDb();
      db.prepare('DELETE FROM harness_rounds WHERE sprint_id IN (SELECT id FROM harness_sprints WHERE project_id = ?)').run(projectId);
      db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(projectId);

      // 6. Parse and save new version
      const sprintsJson = regenFormat === 'markdown'
        ? parsePlannerMarkdown(fullOutput, project)
        : parsePlannerOutput(fullOutput);
      const { path: sprintsPath } = saveSprintsJson(
        projectId,
        projectDir,
        sprintsJson,
        project.config.evaluatorAgentId,
        regenFormat,
      );

      // 7. Update project
      updateHarnessProject(projectId, {
        sprintsJsonPath: sprintsPath,
        status: 'reviewing',
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
      });

      // 8. Emit planning-done
      this.emitIPC('harness:planning-done', {
        projectId,
        sprintsPath,
        totalSprints: sprintsJson.metadata.total_sprints,
        totalFeatures: sprintsJson.metadata.total_features,
        version: sprintsJson.metadata.version,
        regenerated: true,
      });

      const durationMs = Date.now() - startedAt;
      const costUsd = calculateCost(
        plannerAgent.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      );

      // Accumulate planner metrics (add to existing since regeneration is an additional cost)
      const existingProject = getHarnessProject(projectId);
      updateHarnessProject(projectId, {
        plannerInputTokens: (existingProject?.plannerInputTokens ?? 0) + inputTokens,
        plannerOutputTokens: (existingProject?.plannerOutputTokens ?? 0) + outputTokens,
        plannerCacheTokens: (existingProject?.plannerCacheTokens ?? 0) + cacheReadTokens + cacheCreationTokens,
        plannerCostUsd: (existingProject?.plannerCostUsd ?? 0) + costUsd,
        plannerDurationMs: (existingProject?.plannerDurationMs ?? 0) + durationMs,
      });

      logger.info(
        { projectId, version: sprintsJson.metadata.version, durationMs, costUsd },
        'Regeneration completed',
      );

      this.emitIPC('harness:project-update', { projectId, status: 'reviewing' });

    } catch (err) {
      logger.error({ err, projectId }, 'Regeneration failed');
      updateHarnessProject(projectId, { status: 'failed' });
      this.emitIPC('harness:project-update', { projectId, status: 'failed' });
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
      throw err;
    } finally {
      state.status = 'idle';
    }
  }

  private async spawnCoder(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
    feedback?: string,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    output: string;
    toolCallsAccum: Array<{ tool: string; input: unknown }>;
    promptUsed: string;
  }> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // 1. Get Coder agent config from DB
    const coderAgentId = sprint.coderAgentId;
    if (!coderAgentId) throw new Error(`Sprint ${sprint.id} has no coderAgentId`);
    const coderAgent = getAgent(coderAgentId);
    if (!coderAgent) throw new Error(`Coder agent not found: ${coderAgentId}`);

    // 2. Read SPEC_PROGRESS.md (empty string if first sprint)
    const specProgressPath = path.join(project.projectPath, 'SPEC_PROGRESS.md');
    const specProgressContent = fs.existsSync(specProgressPath)
      ? fs.readFileSync(specProgressPath, 'utf-8')
      : '';

    // 3. Build the coder prompt
    const prompt = round === 1 && !feedback
      ? buildCoderPrompt(sprintJson, specProgressContent, project.projectPath)
      : buildCoderFeedbackPrompt(sprintJson, feedback ?? '');

    // 4. Validate cwd
    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();

    // Accumulate tool calls for pipeline_messages persistence
    const coderToolCallsAccum: Array<{ tool: string; input: unknown }> = [];

    // ---- Local LLM path (Ollama / LM Studio / OpenAI-compatible) ----
    if (coderAgent.runtime === 'local' && coderAgent.localConfig) {
      const localCfg = coderAgent.localConfig;
      const localTools = builtinToolsToOllamaSchemas(coderAgent.allowedTools);

      logger.info(
        { projectId, sprintId: sprint.id, round, provider: localCfg.provider, model: localCfg.model },
        'Spawning Coder via local LLM',
      );

      const localResult = await ollamaChatWithTools(
        localCfg.baseUrl,
        localCfg.model,
        coderAgent.systemPrompt || '',
        prompt,
        localTools,
        {
          cwd: project.projectPath,
          provider: (localCfg.provider || 'ollama') as LocalLLMProvider,
          onText: (text) => {
            const evt = { type: 'text', content: text };
            this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
            this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
          },
          onToolUse: (record) => {
            const evt = { type: 'tool_call', tool: record.tool };
            this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
            this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
            coderToolCallsAccum.push({ tool: record.tool, input: record.input ?? {} });
          },
        },
      );

      const durationMs = Date.now() - startedAt;
      const costUsd = calculateCost(localCfg.model, localResult.promptTokens, localResult.tokensUsed, 0, 0);

      logger.info(
        { projectId, sprintId: sprint.id, round, durationMs, costUsd, toolUses: localResult.toolCalls.length, runtime: 'local' },
        'Coder finished (local)',
      );

      return {
        inputTokens: localResult.promptTokens,
        outputTokens: localResult.tokensUsed,
        cacheTokens: 0,
        costUsd,
        durationMs,
        toolUses: localResult.toolCalls.length,
        apiRequests: 1,
        output: localResult.content,
        toolCallsAccum: coderToolCallsAccum,
        promptUsed: prompt,
      };
    }

    // ---- Cloud SDK path ----
    const cliPath = getClaudeCodeExecutablePath();
    await ensureAuthForSDK();

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const coderMcps = await resolveMCPsForHarnessAgent(coderAgentId);

    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: project.projectPath,
        model: coderAgent.model,
        systemPrompt: coderAgent.systemPrompt || '',
        allowedTools: coderAgent.allowedTools,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: state.abortController ?? undefined,
        ...(coderMcps ? { mcpServers: coderMcps } : {}),
      },
    });

    const { output: fullOutput, metrics: coderMetrics } = await processAgentStream(q, {
      shouldAbort: () => state.abortController?.signal.aborted ?? false,
      onText: (text) => {
        const evt = { type: 'text', content: text };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
      },
      onToolUse: (toolName) => {
        const evt = { type: 'tool_call', tool: toolName };
        this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'coder', event: evt });
        this.persistStreamEvent(projectId, sprint.id, round, 'coder', evt);
        coderToolCallsAccum.push({ tool: toolName, input: {} });
      },
    });

    const durationMs = Date.now() - startedAt;
    const costUsd = calculateCost(
      coderAgent.model,
      coderMetrics.inputTokens,
      coderMetrics.outputTokens,
      coderMetrics.cacheReadTokens,
      coderMetrics.cacheCreationTokens,
    );

    logger.info(
      { projectId, sprintId: sprint.id, round, durationMs, costUsd, toolUses: coderMetrics.toolUses, apiRequests: coderMetrics.apiRequests },
      'Coder finished',
    );

    return {
      inputTokens: coderMetrics.inputTokens,
      outputTokens: coderMetrics.outputTokens,
      cacheTokens: coderMetrics.cacheReadTokens + coderMetrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: coderMetrics.toolUses,
      apiRequests: coderMetrics.apiRequests,
      output: fullOutput,
      toolCallsAccum: coderToolCallsAccum,
      promptUsed: prompt,
    };
  }

  private async spawnEvaluator(
    projectId: string,
    sprint: import('../../src/types').HarnessSprint,
    sprintJson: SprintJsonEntry,
    round: number,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    evaluation: EvaluationResult;
    output: string;
    toolCallsAccum: Array<{ tool: string; input: unknown }>;
  }> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // 1. Get Evaluator agent config from DB
    const evaluatorAgentId = sprint.evaluatorAgentId;
    if (!evaluatorAgentId) throw new Error(`Sprint ${sprint.id} has no evaluatorAgentId`);
    const evaluatorAgent = getAgent(evaluatorAgentId);
    if (!evaluatorAgent) throw new Error(`Evaluator agent not found: ${evaluatorAgentId}`);

    // 2. Build evaluator prompt
    const prompt = buildEvaluatorPrompt(sprintJson, project.projectPath);

    // 3. Validate cwd
    if (!fs.existsSync(project.projectPath)) {
      throw new Error(`Project path does not exist: ${project.projectPath}`);
    }

    const state = this.getState(projectId);
    const startedAt = Date.now();
    const evalToolNames = evaluatorAgent.allowedTools.length > 0
      ? evaluatorAgent.allowedTools
      : ['Read', 'Glob', 'Grep', 'Bash'];

    let fullOutput: string;
    let evalInputTokens: number;
    let evalOutputTokens: number;
    let evalCacheTokens: number;
    let evalToolUses: number;
    let evalApiRequests: number;

    // Accumulate tool calls for pipeline_messages persistence
    const evalToolCallsAccum: Array<{ tool: string; input: unknown }> = [];

    // ---- Local LLM path (Ollama / LM Studio / OpenAI-compatible) ----
    if (evaluatorAgent.runtime === 'local' && evaluatorAgent.localConfig) {
      const localCfg = evaluatorAgent.localConfig;
      const localTools = builtinToolsToOllamaSchemas(evalToolNames);

      logger.info(
        { projectId, sprintId: sprint.id, round, provider: localCfg.provider, model: localCfg.model },
        'Spawning Evaluator via local LLM',
      );

      const localResult = await ollamaChatWithTools(
        localCfg.baseUrl,
        localCfg.model,
        evaluatorAgent.systemPrompt || '',
        prompt,
        localTools,
        {
          cwd: project.projectPath,
          provider: (localCfg.provider || 'ollama') as LocalLLMProvider,
          onText: (text) => {
            const evt = { type: 'text', content: text };
            this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
            this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
          },
          onToolUse: (record) => {
            const evt = { type: 'tool_call', tool: record.tool };
            this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
            this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
            evalToolCallsAccum.push({ tool: record.tool, input: record.input ?? {} });
          },
        },
      );

      fullOutput = localResult.content;
      evalInputTokens = localResult.promptTokens;
      evalOutputTokens = localResult.tokensUsed;
      evalCacheTokens = 0;
      evalToolUses = localResult.toolCalls.length;
      evalApiRequests = 1;
    } else {
      // ---- Cloud SDK path ----
      const cliPath = getClaudeCodeExecutablePath();
      await ensureAuthForSDK();

      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const evalMcps = await resolveMCPsForHarnessAgent(evaluatorAgentId);

      const q = query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: cliPath,
          cwd: project.projectPath,
          model: evaluatorAgent.model,
          systemPrompt: evaluatorAgent.systemPrompt || '',
          allowedTools: evalToolNames,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          abortController: state.abortController ?? undefined,
          ...(evalMcps ? { mcpServers: evalMcps } : {}),
        },
      });

      const streamResult = await processAgentStream(q, {
        shouldAbort: () => state.abortController?.signal.aborted ?? false,
        onText: (text) => {
          const evt = { type: 'text', content: text };
          this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
          this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
        },
        onToolUse: (toolName) => {
          const evt = { type: 'tool_call', tool: toolName };
          this.emitIPC('harness:agent-stream', { projectId, sprintId: sprint.id, round, agent: 'evaluator', event: evt });
          this.persistStreamEvent(projectId, sprint.id, round, 'evaluator', evt);
          evalToolCallsAccum.push({ tool: toolName, input: {} });
        },
      });

      fullOutput = streamResult.output;
      evalInputTokens = streamResult.metrics.inputTokens;
      evalOutputTokens = streamResult.metrics.outputTokens;
      evalCacheTokens = streamResult.metrics.cacheReadTokens + streamResult.metrics.cacheCreationTokens;
      evalToolUses = streamResult.metrics.toolUses;
      evalApiRequests = streamResult.metrics.apiRequests;
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = calculateCost(
      evaluatorAgent.model,
      evalInputTokens,
      evalOutputTokens,
      evaluatorAgent.runtime === 'local' ? 0 : evalCacheTokens,
      0,
    );

    // 5. Parse and validate the evaluation output
    let evaluation = parseEvaluationOutput(fullOutput, round);
    evaluation = validateCriteria(evaluation, sprintJson);

    // 6. Save evaluation.json to filesystem
    const sprintDir = path.join(
      this.getProjectDir(projectId),
      'sprints',
      sprintJson.id,
    );
    fs.mkdirSync(sprintDir, { recursive: true });
    const evalPath = path.join(sprintDir, 'evaluation.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2), 'utf-8');

    logger.info(
      { projectId, sprintId: sprint.id, round, verdict: evaluation.verdict, durationMs, costUsd, toolUses: evalToolUses, apiRequests: evalApiRequests },
      'Evaluator finished',
    );

    return {
      inputTokens: evalInputTokens,
      outputTokens: evalOutputTokens,
      cacheTokens: evalCacheTokens,
      costUsd,
      durationMs,
      toolUses: evalToolUses,
      apiRequests: evalApiRequests,
      evaluation,
      output: fullOutput,
      toolCallsAccum: evalToolCallsAccum,
    };
  }

  async run(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    state.status = 'running';
    state.abortController = new AbortController();
    state.pauseRequested = false;

    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const sprints = getHarnessSprints(projectId);
    if (sprints.length === 0) throw new Error('No sprints found for project');

    updateHarnessProject(projectId, { status: 'running' });
    this.emitIPC('harness:project-update', { projectId, status: 'running' });

    for (let i = 0; i < sprints.length; i++) {
      if (state.pauseRequested) {
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        break;
      }

      const sprint = sprints[i];
      if (sprint.status === 'passed' || sprint.status === 'skipped') continue;

      state.currentSprintIndex = i;
      updateHarnessProject(projectId, { currentSprintIndex: i });

      // Mark sprint as running
      updateHarnessSprint(sprint.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

      // Read sprints.json to find the matching SprintJsonEntry
      const projectDir = this.getProjectDir(projectId);
      const sprintsJson = readLatestSprintsJson(projectDir);
      if (!sprintsJson) {
        logger.error({ projectId, sprintId: sprint.id }, 'No sprints.json found during run');
        updateHarnessSprint(sprint.id, { status: 'failed' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        continue;
      }

      const sprintJson = sprintsJson.sprints.find(s => s.id === sprint.sprintJsonId);
      if (!sprintJson) {
        logger.error({ projectId, sprintId: sprint.id, sprintJsonId: sprint.sprintJsonId }, 'Sprint JSON entry not found');
        updateHarnessSprint(sprint.id, { status: 'failed' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        continue;
      }

      const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
      let lastFeedback: string | undefined;
      let sprintPassed = false;

      for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
        if (state.abortController?.signal.aborted) break;
        if (state.pauseRequested) break;

        logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'Starting coder round');

        // Insert round record
        const roundRecord = insertHarnessRound({
          sprintId: sprint.id,
          roundNumber: roundNum,
        });

        let coderMetrics: Awaited<ReturnType<typeof this.spawnCoder>>;
        try {
          coderMetrics = await this.spawnCoder(
            projectId,
            sprint,
            sprintJson,
            roundNum,
            roundNum > 1 ? lastFeedback : undefined,
          );
        } catch (coderErr) {
          logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
          updateHarnessRound(roundRecord.id, {
            verdict: 'fail',
            feedbackSummary: (coderErr as Error).message,
            completedAt: new Date().toISOString(),
          });
          break;
        }

        // Persist coder metrics (verdict will be set by the Evaluator below)
        updateHarnessRound(roundRecord.id, {
          coderInputTokens: coderMetrics.inputTokens,
          coderOutputTokens: coderMetrics.outputTokens,
          coderCacheTokens: coderMetrics.cacheTokens,
          coderCostUsd: coderMetrics.costUsd,
          coderDurationMs: coderMetrics.durationMs,
          coderToolUses: coderMetrics.toolUses,
          coderApiRequests: coderMetrics.apiRequests,
        });

        // Update rounds used counter
        updateHarnessSprint(sprint.id, { roundsUsed: roundNum });

        // --- Evaluator phase ---
        let evaluatorMetrics: Awaited<ReturnType<typeof this.spawnEvaluator>>;
        try {
          evaluatorMetrics = await this.spawnEvaluator(
            projectId,
            sprint,
            sprintJson,
            roundNum,
          );
        } catch (evalErr) {
          logger.error(
            { err: evalErr, projectId, sprintId: sprint.id, round: roundNum },
            'Evaluator failed',
          );
          updateHarnessRound(roundRecord.id, {
            verdict: 'fail',
            feedbackSummary: (evalErr as Error).message,
            completedAt: new Date().toISOString(),
          });
          break;
        }

        // Persist evaluator metrics + verdict
        updateHarnessRound(roundRecord.id, {
          evaluatorInputTokens: evaluatorMetrics.inputTokens,
          evaluatorOutputTokens: evaluatorMetrics.outputTokens,
          evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
          evaluatorCostUsd: evaluatorMetrics.costUsd,
          evaluatorDurationMs: evaluatorMetrics.durationMs,
          evaluatorToolUses: evaluatorMetrics.toolUses,
          evaluatorApiRequests: evaluatorMetrics.apiRequests,
          verdict: evaluatorMetrics.evaluation.verdict,
          feedbackSummary: evaluatorMetrics.evaluation.summary,
          completedAt: new Date().toISOString(),
        });

        this.emitIPC('harness:sprint-update', {
          projectId,
          sprintId: sprint.id,
          round: roundNum,
          verdict: evaluatorMetrics.evaluation.verdict,
          coderMetrics,
          evaluatorMetrics: {
            inputTokens: evaluatorMetrics.inputTokens,
            outputTokens: evaluatorMetrics.outputTokens,
            cacheTokens: evaluatorMetrics.cacheTokens,
            costUsd: evaluatorMetrics.costUsd,
            durationMs: evaluatorMetrics.durationMs,
            toolUses: evaluatorMetrics.toolUses,
            apiRequests: evaluatorMetrics.apiRequests,
          },
        });

        if (evaluatorMetrics.evaluation.verdict === 'pass') {
          // Count completed sprints (this one included)
          const allSprints = getHarnessSprints(projectId);
          const completedCount = allSprints.filter(
            s => s.status === 'passed' || s.id === sprint.id,
          ).length;
          updateSpecProgress(
            project.projectPath,
            project.name,
            sprintJson,
            sprints.length,
            completedCount,
          );
          sprintPassed = true;
          break;
        } else {
          // Set feedback for next round
          lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);

          // Audit trail: persist exactly what the evaluator returned and what will be injected
          this.persistFeedbackAudit(
            projectId,
            sprint.id,
            roundNum,
            evaluatorMetrics.evaluation.verdict,
            evaluatorMetrics.evaluation.summary,
            evaluatorMetrics.evaluation.criteria
              .filter(c => c.result === 'fail')
              .map(c => ({ description: c.description, justification: c.justification })),
            lastFeedback,
          );

          logger.info(
            { projectId, sprintId: sprint.id, round: roundNum, feedbackLen: lastFeedback.length },
            'Sprint failed evaluation, feedback persisted, retrying...',
          );
        }
      }

      if (state.pauseRequested) {
        updateHarnessSprint(sprint.id, { status: 'interrupted' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'interrupted' });
        updateHarnessProject(projectId, { status: 'paused', currentSprintIndex: i });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        return;
      }

      if (state.abortController?.signal.aborted) {
        // Abort resets sprint to pending so resume can re-execute it
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
        break;
      }

      if (sprintPassed) {
        updateHarnessSprint(sprint.id, {
          status: 'passed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
        logger.info({ projectId, sprintId: sprint.id }, 'Sprint passed');
      } else {
        // Max rounds exhausted with fail - pause for user intervention
        updateHarnessSprint(sprint.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
        updateHarnessProject(projectId, { status: 'paused' });
        this.emitIPC('harness:project-update', { projectId, status: 'paused' });
        state.status = 'paused';
        logger.warn(
          { projectId, sprintId: sprint.id, maxRounds },
          'Sprint exhausted max rounds - harness paused for user intervention',
        );
        return;
      }
    }

    if (!state.abortController?.signal.aborted) {
      updateHarnessProject(projectId, { status: 'done' });
      this.emitIPC('harness:project-update', { projectId, status: 'done' });
    }
    state.status = 'idle';
  }

  /**
   * Run a single sprint by index, returning aggregated metrics.
   * Used by PipelineEngine to run sprints one-at-a-time with stream bridging.
   */
  async runSingleSprint(projectId: string, sprintIndex: number): Promise<SprintResult> {
    const project = getHarnessProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const sprints = getHarnessSprints(projectId);
    if (sprintIndex < 0 || sprintIndex >= sprints.length) {
      throw new Error(`Sprint index ${sprintIndex} out of range (0..${sprints.length - 1})`);
    }

    const sprint = sprints[sprintIndex];
    const projectDir = this.getProjectDir(projectId);
    const sprintsJson = readLatestSprintsJson(projectDir);
    if (!sprintsJson) throw new Error('No sprints.json found');

    const sprintJson = sprintsJson.sprints.find(s => s.id === sprint.sprintJsonId);
    if (!sprintJson) throw new Error(`Sprint JSON entry not found for ${sprint.sprintJsonId}`);

    const state = this.getState(projectId);
    state.status = 'running';
    state.abortController = new AbortController();

    // Mark sprint as running
    updateHarnessSprint(sprint.id, { status: 'running', startedAt: new Date().toISOString() });
    this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'running' });

    const maxRounds = sprint.maxRounds ?? project.config.maxRoundsPerSprint;
    let lastFeedback: string | undefined;
    let sprintPassed = false;
    let totalRounds = 0;

    const aggCoder: SprintMetrics = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 };
    const aggEval: SprintMetrics = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, durationMs: 0, toolUses: 0, apiRequests: 0 };

    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      if (state.abortController?.signal.aborted) break;

      totalRounds = roundNum;
      logger.info({ projectId, sprintId: sprint.id, round: roundNum }, 'runSingleSprint: coder round');

      const roundRecord = insertHarnessRound({ sprintId: sprint.id, roundNumber: roundNum });

      if (roundNum > 1) {
        this.emitIPC('pipeline:phase-changed', {
          projectId,
          phase: 13,
          phaseName: 'Coder',
          status: 'running',
          awaitingUser: false,
        });
      }

      // --- Coder ---
      let coderMetrics: Awaited<ReturnType<typeof this.spawnCoder>>;
      try {
        coderMetrics = await this.spawnCoder(projectId, sprint, sprintJson, roundNum, roundNum > 1 ? lastFeedback : undefined);
      } catch (coderErr) {
        logger.error({ err: coderErr, projectId, sprintId: sprint.id, round: roundNum }, 'Coder failed');
        updateHarnessRound(roundRecord.id, { verdict: 'fail', feedbackSummary: (coderErr as Error).message, completedAt: new Date().toISOString() });
        break;
      }

      updateHarnessRound(roundRecord.id, {
        coderInputTokens: coderMetrics.inputTokens,
        coderOutputTokens: coderMetrics.outputTokens,
        coderCacheTokens: coderMetrics.cacheTokens,
        coderCostUsd: coderMetrics.costUsd,
        coderDurationMs: coderMetrics.durationMs,
        coderToolUses: coderMetrics.toolUses,
        coderApiRequests: coderMetrics.apiRequests,
      });
      aggCoder.inputTokens += coderMetrics.inputTokens;
      aggCoder.outputTokens += coderMetrics.outputTokens;
      aggCoder.cacheTokens += coderMetrics.cacheTokens;
      aggCoder.costUsd += coderMetrics.costUsd;
      aggCoder.durationMs += coderMetrics.durationMs;
      aggCoder.toolUses += coderMetrics.toolUses;
      aggCoder.apiRequests += coderMetrics.apiRequests;

      // Persist coder prompt (user role) and output (assistant role) to pipeline_messages
      try {
        if (coderMetrics.promptUsed) {
          savePipelineMessage({
            projectId,
            phaseNumber: 13,
            role: 'user',
            content: coderMetrics.promptUsed,
            sprintIndex,
            roundIndex: roundNum,
            agentId: sprint.coderAgentId ?? 'harness-coder',
          });
        }
        if (coderMetrics.output) {
          savePipelineMessage({
            projectId,
            phaseNumber: 13,
            role: 'assistant',
            content: coderMetrics.output,
            toolCalls: coderMetrics.toolCallsAccum.length > 0 ? coderMetrics.toolCallsAccum : undefined,
            sprintIndex,
            roundIndex: roundNum,
            agentId: sprint.coderAgentId ?? 'harness-coder',
          });
        }
      } catch (saveErr) {
        logger.warn({ err: saveErr, projectId, sprintId: sprint.id, round: roundNum }, 'Failed to save coder pipeline_message — non-critical');
      }

      updateHarnessSprint(sprint.id, { roundsUsed: roundNum });

      this.emitIPC('pipeline:phase-changed', {
        projectId,
        phase: 14,
        phaseName: 'Evaluator',
        status: 'running',
        awaitingUser: false,
      });

      // --- Evaluator ---
      let evaluatorMetrics: Awaited<ReturnType<typeof this.spawnEvaluator>>;
      try {
        evaluatorMetrics = await this.spawnEvaluator(projectId, sprint, sprintJson, roundNum);
      } catch (evalErr) {
        logger.error({ err: evalErr, projectId, sprintId: sprint.id, round: roundNum }, 'Evaluator failed');
        updateHarnessRound(roundRecord.id, { verdict: 'fail', feedbackSummary: (evalErr as Error).message, completedAt: new Date().toISOString() });
        break;
      }

      updateHarnessRound(roundRecord.id, {
        evaluatorInputTokens: evaluatorMetrics.inputTokens,
        evaluatorOutputTokens: evaluatorMetrics.outputTokens,
        evaluatorCacheTokens: evaluatorMetrics.cacheTokens,
        evaluatorCostUsd: evaluatorMetrics.costUsd,
        evaluatorDurationMs: evaluatorMetrics.durationMs,
        evaluatorToolUses: evaluatorMetrics.toolUses,
        evaluatorApiRequests: evaluatorMetrics.apiRequests,
        verdict: evaluatorMetrics.evaluation.verdict,
        feedbackSummary: evaluatorMetrics.evaluation.summary,
        completedAt: new Date().toISOString(),
      });
      aggEval.inputTokens += evaluatorMetrics.inputTokens;
      aggEval.outputTokens += evaluatorMetrics.outputTokens;
      aggEval.cacheTokens += evaluatorMetrics.cacheTokens;
      aggEval.costUsd += evaluatorMetrics.costUsd;
      aggEval.durationMs += evaluatorMetrics.durationMs;
      aggEval.toolUses += evaluatorMetrics.toolUses;
      aggEval.apiRequests += evaluatorMetrics.apiRequests;

      // Persist evaluator output (assistant role) to pipeline_messages
      try {
        if (evaluatorMetrics.output) {
          savePipelineMessage({
            projectId,
            phaseNumber: 14,
            role: 'assistant',
            content: evaluatorMetrics.output,
            toolCalls: evaluatorMetrics.toolCallsAccum.length > 0 ? evaluatorMetrics.toolCallsAccum : undefined,
            sprintIndex,
            roundIndex: roundNum,
            agentId: sprint.evaluatorAgentId ?? 'harness-evaluator',
          });
        }
      } catch (saveErr) {
        logger.warn({ err: saveErr, projectId, sprintId: sprint.id, round: roundNum }, 'Failed to save evaluator pipeline_message — non-critical');
      }

      this.emitIPC('harness:sprint-update', {
        projectId,
        sprintId: sprint.id,
        round: roundNum,
        verdict: evaluatorMetrics.evaluation.verdict,
        coderMetrics,
        evaluatorMetrics: {
          inputTokens: evaluatorMetrics.inputTokens,
          outputTokens: evaluatorMetrics.outputTokens,
          cacheTokens: evaluatorMetrics.cacheTokens,
          costUsd: evaluatorMetrics.costUsd,
          durationMs: evaluatorMetrics.durationMs,
          toolUses: evaluatorMetrics.toolUses,
          apiRequests: evaluatorMetrics.apiRequests,
        },
      });

      if (evaluatorMetrics.evaluation.verdict === 'pass') {
        const allSprints = getHarnessSprints(projectId);
        const completedCount = allSprints.filter(s => s.status === 'passed' || s.id === sprint.id).length;
        updateSpecProgress(project.projectPath, project.name, sprintJson, sprints.length, completedCount);
        sprintPassed = true;
        break;
      } else {
        lastFeedback = buildFeedbackFromEvaluation(evaluatorMetrics.evaluation);
        this.persistFeedbackAudit(
          projectId,
          sprint.id,
          roundNum,
          evaluatorMetrics.evaluation.verdict,
          evaluatorMetrics.evaluation.summary,
          evaluatorMetrics.evaluation.criteria
            .filter(c => c.result === 'fail')
            .map(c => ({ description: c.description, justification: c.justification })),
          lastFeedback,
        );
      }
    }

    const finalVerdict = sprintPassed ? 'pass' : 'fail';

    if (sprintPassed) {
      updateHarnessSprint(sprint.id, { status: 'passed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'passed' });
    } else {
      updateHarnessSprint(sprint.id, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'failed' });
    }

    state.status = 'idle';

    return {
      verdict: finalVerdict,
      rounds: totalRounds,
      metrics: { coder: aggCoder, evaluator: aggEval },
      coderMetrics: aggCoder,
      evaluatorMetrics: aggEval,
    };
  }

  pause(projectId: string): void {
    const state = this.getState(projectId);
    state.pauseRequested = true;
    logger.info({ projectId }, 'Pause requested');
  }

  resume(projectId: string): void {
    // Check DB status (not in-memory state) since abort() resets state to idle
    const project = getHarnessProject(projectId);
    if (!project) {
      logger.warn({ projectId }, 'Resume: project not found');
      return;
    }

    if (project.status !== 'paused') {
      logger.warn({ projectId, status: project.status }, 'Resume: project is not paused');
      return;
    }

    const state = this.getState(projectId);
    state.pauseRequested = false;
    state.status = 'idle'; // Reset so run() can take over

    // Reset interrupted sprints to pending so they can be re-executed
    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'interrupted') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    this.run(projectId).catch(err => {
      logger.error({ err, projectId }, 'Error resuming harness');
      this.emitIPC('harness:error', { projectId, error: (err as Error).message });
    });
  }

  abort(projectId: string): void {
    const state = this.getState(projectId);
    if (state.abortController) {
      state.abortController.abort();
    }

    // Reset any running sprint to pending so it can be re-executed on resume
    const sprints = getHarnessSprints(projectId);
    for (const sprint of sprints) {
      if (sprint.status === 'running') {
        updateHarnessSprint(sprint.id, { status: 'pending' });
        this.emitIPC('harness:sprint-update', { projectId, sprintId: sprint.id, status: 'pending' });
      }
    }

    state.status = 'idle';
    updateHarnessProject(projectId, { status: 'paused' });
    this.emitIPC('harness:project-update', { projectId, status: 'paused' });
    logger.info({ projectId }, 'Harness aborted - project paused for resume');
  }

  getStatus(projectId: string): HarnessState {
    return this.getState(projectId);
  }

  /** Returns true if an enrich session is currently active. */
  hasActiveEnrichSession(): boolean {
    return this.activeEnrichSession !== null;
  }

  // ---- Enrich Pipeline ----

  /**
   * Internal helper: run one query() call for an enrich agent and stream
   * events to the renderer. Returns accumulated metrics for the turn.
   */
  private async runEnrichQuery(
    prompt: string,
    agent: import('../../src/types').AgentConfig,
    specPath: string,
    sessionId: string,
    phase: 'validator' | 'enricher',
    isFollowUp?: boolean,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  }> {
    ensureNodeInPath();
    await ensureAuthForSDK();

    const cliPath = getClaudeCodeExecutablePath();
    if (!fs.existsSync(cliPath)) {
      throw new Error(`Claude Agent SDK cli.js not found at ${cliPath}. Run npm install.`);
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Use the abort controller from the active enrich session
    const abort = this.activeEnrichSession?.abort ?? new AbortController();

    // Determine cwd: use the parent directory of the SPEC file as context
    const cwd = path.dirname(specPath);

    logger.info(
      { sessionId, phase, agentId: agent.id, model: agent.model, cwd, isFollowUp },
      'Starting enrich agent query',
    );

    const enrichMcps = await resolveMCPsForHarnessAgent(agent.id);
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd,
        model: agent.model,
        systemPrompt: agent.systemPrompt || '',
        allowedTools: agent.allowedTools,
        permissionMode: 'default' as const,
        includePartialMessages: true,
        abortController: abort,
        ...(enrichMcps ? { mcpServers: enrichMcps } : {}),
        stderr: (text: string) => {
          logger.info({ stderr: text.substring(0, 500), sessionId, phase }, 'Enrich agent stderr');
        },
      },
    });

    const startedAt = Date.now();

    // Accumulators for persisting the full assistant message after the stream
    let accumulatedText = '';
    const accumulatedToolCalls: Array<{ tool: string; input: unknown }> = [];

    const { metrics: enrichMetrics } = await processAgentStream(q, {
      shouldAbort: () => abort.signal.aborted,
      onText: (text) => {
        accumulatedText += text;
        this.emitIPC('enrich:stream', {
          type: 'text',
          content: text,
          sessionId,
          phase,
        });
      },
      onThinking: (text) => {
        this.emitIPC('enrich:stream', {
          type: 'thinking',
          content: text,
          sessionId,
          phase,
        });
      },
      onToolUse: (toolName) => {
        this.emitIPC('enrich:stream', {
          type: 'tool_call',
          tool: toolName,
          sessionId,
          phase,
        });
      },
      onRawEvent: (event) => {
        // Capture tool input from content_block_start for DB persistence
        if (event['type'] === 'content_block_start') {
          const block = event['content_block'] as Record<string, unknown> | undefined;
          if (block?.['type'] === 'tool_use') {
            const toolName = block['name'] as string;
            const toolInput = (block['input'] ?? {}) as unknown;
            accumulatedToolCalls.push({ tool: toolName, input: toolInput });
          }
        }
      },
      onResult: (resultText) => {
        // Emit the final result text as a stream chunk so the renderer knows
        // the agent has finished its turn.
        if (resultText) {
          this.emitIPC('enrich:stream', {
            type: 'done',
            content: resultText,
            sessionId,
            phase,
          });
        } else {
          this.emitIPC('enrich:stream', {
            type: 'done',
            sessionId,
            phase,
          });
        }
        logger.info({ sessionId, phase }, 'Enrich agent turn completed');
      },
    });

    // Persist the full assistant message to the database
    if (accumulatedText || accumulatedToolCalls.length > 0) {
      try {
        insertEnrichMessage(
          sessionId,
          phase,
          'assistant',
          accumulatedText,
          accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        );
      } catch (err) {
        logger.error({ err, sessionId, phase }, 'Failed to persist enrich assistant message');
      }
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = calculateCost(
      agent.model,
      enrichMetrics.inputTokens,
      enrichMetrics.outputTokens,
      enrichMetrics.cacheReadTokens,
      enrichMetrics.cacheCreationTokens,
    );

    logger.info(
      { sessionId, phase, durationMs, costUsd, toolUses: enrichMetrics.toolUses, apiRequests: enrichMetrics.apiRequests, inputTokens: enrichMetrics.inputTokens, outputTokens: enrichMetrics.outputTokens },
      'Enrich query metrics collected',
    );

    return {
      inputTokens: enrichMetrics.inputTokens,
      outputTokens: enrichMetrics.outputTokens,
      cacheReadTokens: enrichMetrics.cacheReadTokens,
      cacheCreationTokens: enrichMetrics.cacheCreationTokens,
      costUsd,
      durationMs,
      toolUses: enrichMetrics.toolUses,
      apiRequests: enrichMetrics.apiRequests,
    };
  }

  /**
   * Start an enrich session by launching the Validator agent with the
   * initial prompt built from the SPEC file and optional project/PRD paths.
   *
   * The session is CONVERSATIONAL: the agent waits after presenting its
   * report and the user can send follow-up messages via sendEnrichMessage().
   */
  async startEnrichSession(
    config: CreateEnrichConfig & { sessionId: string },
  ): Promise<void> {
    // Concurrency guard: only one enrich session at a time
    if (this.activeEnrichSession !== null) {
      throw new Error(
        'Ja existe uma sessao de enrich ativa. Finalize ou aborte a sessao atual antes de iniciar uma nova.',
      );
    }

    logger.info({ sessionId: config.sessionId }, 'Starting enrich session');

    // 1. Validate SPEC file exists (agent will Read it via tools)
    if (!fs.existsSync(config.specPath)) {
      throw new Error(`SPEC file not found: ${config.specPath}`);
    }

    // 2. Validate PRD file exists if provided (agent will Read it via tools)
    if (config.prdPath && !fs.existsSync(config.prdPath)) {
      throw new Error(`PRD file not found: ${config.prdPath}`);
    }

    // 3. Get validator agent config
    const validatorAgent = getAgent(config.validatorAgentId);
    if (!validatorAgent) {
      throw new Error(`Validator agent not found: ${config.validatorAgentId}`);
    }

    // 4. Build the validator prompt (paths only, agent reads files via Read tool)
    const prompt = buildValidatorPrompt(
      config.specPath,
      config.projectPath,
      config.prdPath,
      config.message,
    );

    // 5. Register the active enrich session
    const abort = new AbortController();
    this.activeEnrichSession = {
      sessionId: config.sessionId,
      specPath: config.specPath,
      phase: 'validator',
      abort,
    };

    // 6. Register the SPEC path so Write/Edit are auto-approved
    setActiveEnrichSpecPath(config.specPath);

    // 7. Update session status to running
    updateEnrichSession(config.sessionId, { status: 'running', phase: 'validator' });

    this.emitIPC('enrich:status', {
      sessionId: config.sessionId,
      phase: 'validator',
      status: 'running',
    });

    try {
      // 8. Persist the initial user prompt as the first message of the session
      try {
        insertEnrichMessage(config.sessionId, 'validator', 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId: config.sessionId }, 'Failed to persist enrich initial user message');
      }

      // 9. Run the validator agent (first turn)
      const metrics = await this.runEnrichQuery(
        prompt,
        validatorAgent,
        config.specPath,
        config.sessionId,
        'validator',
      );

      // 9. Accumulate metrics and persist them
      accumulateEnrichMetrics(config.sessionId, 'validator', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      // 10. Emit metrics to renderer
      this.emitIPC('enrich:metrics', {
        sessionId: config.sessionId,
        phase: 'validator',
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      // 11. Session is now waiting for user input
      updateEnrichSession(config.sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'waiting',
      });

      logger.info({ sessionId: config.sessionId }, 'Enrich session started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId: config.sessionId }, 'Enrich session failed during startup');
      updateEnrichSession(config.sessionId, { status: 'idle' });
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
      this.emitIPC('enrich:status', {
        sessionId: config.sessionId,
        phase: 'validator',
        status: 'idle',
      });
      throw err;
    }
  }

  /**
   * Send a follow-up message to the active enrich session agent.
   *
   * Each call creates a new query() turn with the user message as the prompt.
   * The Agent SDK maintains conversation history via its session files so
   * the agent has full context of the previous exchange.
   */
  async sendEnrichMessage(sessionId: string, message: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);

    const phase = this.activeEnrichSession.phase;
    const specPath = this.activeEnrichSession.specPath;

    // Determine which agent to use based on current phase
    let agentId: string;
    if (phase === 'validator') {
      agentId = session.validatorAgentId;
    } else if (phase === 'enricher') {
      agentId = session.enricherAgentId;
    } else {
      throw new Error(`Enrich session is in terminal phase: ${phase}`);
    }

    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    logger.info(
      { sessionId, phase, agentId, messageLen: message.length },
      'Sending message to enrich agent',
    );

    // Mark session as running for this turn
    updateEnrichSession(sessionId, { status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase, status: 'running' });

    // Persist the user message before querying the agent
    try {
      insertEnrichMessage(sessionId, phase as 'validator' | 'enricher', 'user', message);
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Failed to persist enrich user message');
    }

    // Build a follow-up prompt that tells the agent to read its persistent
    // report/suggestions file for context instead of replaying conversation history.
    const fullPrompt = phase === 'validator'
      ? buildValidatorFollowUpPrompt(specPath, message)
      : buildEnricherFollowUpPrompt(specPath, message);

    try {
      const metrics = await this.runEnrichQuery(
        fullPrompt,
        agent,
        specPath,
        sessionId,
        phase as 'validator' | 'enricher',
        true,
      );

      // Accumulate metrics for this turn
      accumulateEnrichMetrics(sessionId, phase as 'validator' | 'enricher', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      // Emit updated metrics to renderer
      this.emitIPC('enrich:metrics', {
        sessionId,
        phase,
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      // Return to waiting state for the next user message
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });

      logger.info({ sessionId, phase }, 'Enrich message processed - waiting for next input');
    } catch (err) {
      logger.error({ err, sessionId, phase }, 'Enrich message failed');
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase, status: 'waiting' });
      throw err;
    }
  }

  /**
   * Transition an enrich session from the validator phase to the enricher
   * phase. Reads the current (now-corrected) SPEC content and launches the
   * Enricher agent.
   */
  async approveEnrichPhase(sessionId: string): Promise<void> {
    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) throw new Error(`Enrich session not found: ${sessionId}`);
    if (session.phase !== 'validator') {
      throw new Error(`Cannot approve phase transition from phase: ${session.phase}`);
    }

    logger.info({ sessionId }, 'Approving phase transition: validator -> enricher');

    // Abort the current Validator query so it stops processing
    logger.info({ sessionId }, 'Aborting validator abort controller before enricher transition');
    this.activeEnrichSession.abort.abort();

    const enricherAgent = getAgent(session.enricherAgentId);
    if (!enricherAgent) throw new Error(`Enricher agent not found: ${session.enricherAgentId}`);

    // Build prompt with paths only - agent reads files via Read tool
    const prompt = buildEnricherPrompt(
      session.specPath,
      session.projectPath ?? undefined,
    );

    // Update the in-memory session phase
    this.activeEnrichSession.phase = 'enricher';

    // Create a fresh AbortController for the enricher - the old validator one is aborted
    this.activeEnrichSession.abort = new AbortController();
    logger.info({ sessionId }, 'New AbortController created for enricher phase');

    // Persist phase transition
    updateEnrichSession(sessionId, { phase: 'enricher', status: 'running' });
    this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'running' });

    try {
      // Persist the enricher initial prompt as the first user message of the enricher phase
      try {
        insertEnrichMessage(sessionId, 'enricher', 'user', prompt);
      } catch (err) {
        logger.error({ err, sessionId }, 'Failed to persist enrich enricher initial user message');
      }

      const metrics = await this.runEnrichQuery(
        prompt,
        enricherAgent,
        session.specPath,
        sessionId,
        'enricher',
      );

      accumulateEnrichMetrics(sessionId, 'enricher', {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheReadTokens: metrics.cacheReadTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        costUsd: metrics.costUsd,
        durationMs: metrics.durationMs,
        toolUses: metrics.toolUses,
        apiRequests: metrics.apiRequests,
        messages: 1,
      });

      this.emitIPC('enrich:metrics', {
        sessionId,
        phase: 'enricher',
        metrics: {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheCreationTokens: metrics.cacheCreationTokens,
          costUsd: metrics.costUsd,
          durationMs: metrics.durationMs,
          toolUses: metrics.toolUses,
          apiRequests: metrics.apiRequests,
          messages: 1,
        },
      });

      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });

      logger.info({ sessionId }, 'Enricher phase started - waiting for user');
    } catch (err) {
      logger.error({ err, sessionId }, 'Enricher phase launch failed');
      updateEnrichSession(sessionId, { status: 'waiting' });
      this.emitIPC('enrich:status', { sessionId, phase: 'enricher', status: 'waiting' });
      throw err;
    }
  }

  /**
   * Finalize the enrich session: create the `.enriched.md` copy, mark it as
   * done, clear the active session state so subsequent permission checks no
   * longer auto-approve writes to the SPEC file, and return the final path.
   */
  finalizeEnrichSession(sessionId: string): string {
    logger.info({ sessionId }, 'Finalizing enrich session');

    if (!this.activeEnrichSession || this.activeEnrichSession.sessionId !== sessionId) {
      throw new Error(`No active enrich session for id: ${sessionId}`);
    }

    const session = getEnrichSession(sessionId);
    if (!session) {
      throw new Error(`Enrich session not found: ${sessionId}`);
    }

    // Read final SPEC content (after enricher edits)
    if (!fs.existsSync(session.specPath)) {
      throw new Error(`SPEC file not found at finalization time: ${session.specPath}`);
    }
    const finalContent = fs.readFileSync(session.specPath, 'utf-8');
    logger.info({ sessionId, specPath: session.specPath, size: finalContent.length }, 'Read final SPEC content');

    // Build the enriched copy path: avoid double-suffixing .enriched.md
    const parsed = path.parse(session.specPath);
    let enrichedPath: string;
    if (parsed.name.endsWith('.enriched')) {
      // Already has .enriched in the name - don't double it
      enrichedPath = session.specPath;
      logger.info({ sessionId, enrichedPath }, 'SPEC already has .enriched suffix - using original path');
    } else {
      enrichedPath = path.join(parsed.dir, parsed.name + '.enriched' + parsed.ext);
      logger.info({ sessionId, enrichedPath }, 'Creating enriched copy');
      fs.writeFileSync(enrichedPath, finalContent, 'utf-8');
      logger.info({ sessionId, enrichedPath }, 'Enriched copy written');
    }

    // Update DB: phase = 'done', status = 'done', finalSpecPath = enrichedPath
    updateEnrichSession(sessionId, {
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    // Clear active session and release permission guard override
    setActiveEnrichSpecPath(null);
    this.activeEnrichSession = null;

    // Emit final status to renderer
    this.emitIPC('enrich:status', {
      sessionId,
      phase: 'done',
      status: 'done',
      finalSpecPath: enrichedPath,
    });

    logger.info({ sessionId, enrichedPath }, 'Enrich session finalized successfully');
    return enrichedPath;
  }

  /**
   * Abort the currently active enrich session.
   */
  abortEnrichSession(sessionId: string): void {
    logger.info({ sessionId }, 'Aborting enrich session');

    if (this.activeEnrichSession?.sessionId === sessionId) {
      const phase = this.activeEnrichSession.phase;
      logger.info({ sessionId, phase }, 'Aborting active enrich session abort controller');
      this.activeEnrichSession.abort.abort();
      setActiveEnrichSpecPath(null);
      this.activeEnrichSession = null;
    }

    const session = getEnrichSession(sessionId);
    const currentPhase = session?.phase ?? 'validator';

    updateEnrichSession(sessionId, { status: 'idle' });
    this.emitIPC('enrich:status', { sessionId, phase: currentPhase, status: 'idle' });
    logger.info({ sessionId, phase: currentPhase }, 'Enrich session aborted');
  }
}
