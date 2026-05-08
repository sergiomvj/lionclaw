/**
 * security-audit-runner.ts
 *
 * Orquestrador da Fase 2 do Security Audit Pipeline.
 * Gerencia 7 agentes de auditoria em paralelo com concorrencia limitada.
 *
 * Cada agente recebe arquivos filtrados por tags do manifest, escreve findings
 * em arquivo isolado, e ao final o runner faz merge deterministico.
 *
 * Exporta: SecurityAuditRunner, SECURITY_AUDIT_AGENTS
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { emitIPC } from './pipeline-shared/ipc-emitter';
import {
  insertSecurityAgentStatus,
  updateSecurityAgentStatus,
  savePipelinePhaseMetrics,
} from './db';
import { resolveAgentQueryConfig } from './agent-config-resolver';
import type { PhaseCallbacks, RepoManifest } from './repo-profiler';
import { EXCLUDED_FROM_AUDIT_PATTERNS } from './repo-profiler';
import type { AgentConfig } from '../../src/types';
import type { PipelineProject } from '../../src/types/pipeline';
import { getPipelineDocsContext } from './pipeline-paths';
import type { PipelineEngine } from './pipeline-engine';
import { setActiveSecurityAuditPhase } from './permission-guard';
import {
  SECRETS_SCANNER_ID,
  AUTH_AUDITOR_ID,
  ISOLATION_INSPECTOR_ID,
  DUPLICATION_DETECTOR_ID,
  LOGIC_ANALYZER_ID,
  STANDARDS_CHECKER_ID,
  OWASP_SCANNER_ID,
} from './seed-agents/index';

const logger = createLogger('security-audit-runner');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Phase number for all security audit sub-agents. */
const SECURITY_AUDIT_PHASE = 2;

/** Regex to count findings in agent output. */
const FINDING_REGEX = /^### [A-Z_]+-\d{3}:/gm;

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface SecurityAuditAgentDef {
  /** ID that matches the seed agent in the DB. */
  agentId: string;
  /** Display name shown in the UI. */
  name: string;
  /**
   * Role tags from the manifest.filesByRole to resolve files for this agent.
   * The special value '*' means all classified files (union of all roles).
   */
  tags: string[];
  /** Numeric order used for filename and merge ordering (1-7). */
  order: number;
  /** Short slug used in partial filenames (e.g. 'secrets'). */
  slug: string;
}

export const SECURITY_AUDIT_AGENTS: SecurityAuditAgentDef[] = [
  { agentId: SECRETS_SCANNER_ID,      name: 'Secrets Scanner',      tags: ['config', 'migration'],                                                     order: 1, slug: 'secrets'     },
  { agentId: AUTH_AUDITOR_ID,         name: 'Auth Auditor',         tags: ['auth', 'route', 'middleware'],                                              order: 2, slug: 'auth'        },
  { agentId: ISOLATION_INSPECTOR_ID,  name: 'Isolation Inspector',  tags: ['query', 'migration', 'middleware'],                                         order: 3, slug: 'isolation'   },
  { agentId: DUPLICATION_DETECTOR_ID, name: 'Duplication Detector', tags: ['route', 'query', 'auth', 'middleware', 'async', 'error-handling', 'template'], order: 4, slug: 'duplication' },
  { agentId: LOGIC_ANALYZER_ID,       name: 'Logic Analyzer',       tags: ['async', 'query', 'error-handling'],                                         order: 5, slug: 'logic'       },
  { agentId: STANDARDS_CHECKER_ID,    name: 'Standards Checker',    tags: ['route', 'query', 'auth', 'middleware', 'async', 'error-handling', 'template'], order: 6, slug: 'standards'   },
  { agentId: OWASP_SCANNER_ID,        name: 'OWASP Scanner',        tags: ['route', 'query', 'auth', 'template'],                                       order: 7, slug: 'owasp'       },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the list of files for a given agent based on its tags and the manifest.
 * Tag '*' = union of all classified files (legacy, no longer used in SECURITY_AUDIT_AGENTS).
 * Specific tags = union of filesByRole[tag] arrays.
 * Duplicates are removed; result contains relative paths as stored in manifest.
 *
 * When the resolved list exceeds maxFiles, the list is trimmed by prioritising:
 *   (a) larger files (by size) then (b) more recently modified files (by mtime).
 * Files that cannot be stat-ed are sorted to the end.
 */
export function resolveFilesForAgent(
  manifest: RepoManifest,
  tags: string[],
  maxFiles = 300,
): string[] {
  const seen = new Set<string>();
  const collect: string[] = [];

  const allFiles = (): string[] => {
    const acc: string[] = [];
    for (const files of Object.values(manifest.filesByRole)) {
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          acc.push(f);
        }
      }
    }
    return acc;
  };

  if (tags.includes('*')) {
    // '*' means all classified files; skip specific tag resolution
    collect.push(...allFiles());
  } else {
    for (const tag of tags) {
      const files = manifest.filesByRole[tag] ?? [];
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          collect.push(f);
        }
      }
    }
  }

  // Belt-and-suspenders: filter .env* files even if they somehow ended up in the manifest
  const filtered = collect.filter((relPath) => {
    const basename = path.basename(relPath);
    return !EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename));
  });

  if (filtered.length <= maxFiles) {
    return filtered;
  }

  // Trim to maxFiles, prioritising larger and more recently modified files.
  const projectPath = manifest.projectPath;
  interface FileMeta { relPath: string; size: number; mtime: number }
  const withMeta: FileMeta[] = filtered.map((relPath) => {
    try {
      const stat = fs.statSync(path.join(projectPath, relPath));
      return { relPath, size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return { relPath, size: 0, mtime: 0 };
    }
  });

  withMeta.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.mtime - a.mtime;
  });

  logger.info(
    { totalResolved: filtered.length, maxFiles, tagsUsed: tags },
    'resolveFilesForAgent: capping file list (prioritising by size+mtime)',
  );

  return withMeta.slice(0, maxFiles).map((m) => m.relPath);
}

/**
 * Generate the scan ID in the format YYYYMMDD-HHmm from a Date.
 */
export function formatScanId(date: Date): string {
  const y = date.getFullYear().toString();
  const mo = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const h = date.getHours().toString().padStart(2, '0');
  const mi = date.getMinutes().toString().padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}`;
}

// ---------------------------------------------------------------------------
// Per-agent spawn result
// ---------------------------------------------------------------------------

interface AgentRunResult {
  output: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolUses: number;
    apiRequests: number;
    costUsd: number;
    durationMs: number;
  };
  model: string;
  runtime: AgentConfig['runtime'];
  provider: string;
}

// ---------------------------------------------------------------------------
// SecurityAuditRunner
// ---------------------------------------------------------------------------

export class SecurityAuditRunner {
  private currentProjectId: string | null = null;

  /** Hardcoded invariant for multi-panel UI: always 3 concurrent agents. */
  private readonly maxConcurrent = 3;

  constructor(private readonly pipelineEngine: PipelineEngine) {}

  /**
   * Run all 7 security audit agents with bounded concurrency.
   *
   * @param project         - HarnessProject (has projectPath).
   * @param abortController - Shared abort controller for the pipeline phase.
   * @param callbacks       - Streaming callbacks (onText, onDone, etc.).
   * @param pipelineDocsId  - When truthy, write consolidated report to docs/Docs{id}/Security{id}.md.
   */
  async run(
    project: PipelineProject & { projectPath: string },
    abortController: AbortController,
    callbacks: PhaseCallbacks,
    pipelineDocsId: string | null = null,
  ): Promise<string | null> {
    this.currentProjectId = project.id;
    setActiveSecurityAuditPhase(true);
    try {
      return await this.runInternal(project, abortController, callbacks, pipelineDocsId);
    } finally {
      this.currentProjectId = null;
      setActiveSecurityAuditPhase(false);
    }
  }

  private async runInternal(
    project: PipelineProject & { projectPath: string },
    abortController: AbortController,
    callbacks: PhaseCallbacks,
    pipelineDocsId: string | null,
  ): Promise<string | null> {
    const projectId = project.id;
    const projectPath = project.projectPath;

    // --- 1. Read manifest.json ---
    const manifestPath = path.join(projectPath, '.lionclaw', 'manifest.json');
    let manifest: RepoManifest;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as RepoManifest;
    } catch (err) {
      const msg = `Falha ao ler manifest.json: ${String(err)}`;
      logger.error({ err, manifestPath }, 'Cannot read manifest.json');
      callbacks.onText?.(msg);
      throw new Error(msg);
    }

    // --- 2. Scan ID and output directory ---
    const runStartedAt = new Date();
    const scanId = formatScanId(runStartedAt);
    const securityDir = path.join(projectPath, '.lionclaw', 'Security');

    try {
      fs.mkdirSync(securityDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, securityDir }, 'Could not create Security dir');
    }

    logger.info({ projectId, scanId, securityDir }, 'Starting SecurityAuditRunner');
    callbacks.onText?.(`Iniciando auditoria de seguranca (scan ${scanId})...`);

    // --- 3. Insert pending status rows for all 7 agents ---
    try {
      insertSecurityAgentStatus(
        projectId,
        SECURITY_AUDIT_AGENTS.map((a) => ({ agentId: a.agentId, agentName: a.name })),
      );
    } catch (err) {
      logger.warn({ err, projectId }, 'insertSecurityAgentStatus failed (may already exist)');
    }

    // --- 4. Run agents with bounded concurrency pool ---
    const queue = [...SECURITY_AUDIT_AGENTS].sort((a, b) => a.order - b.order);

    // Track failures for the merge header
    const failed: Array<{ agentId: string; name: string; error: string }> = [];

    /**
     * Worker: runs a single agent from the queue.
     * Returns after the agent finishes (success or error).
     * Never throws - errors are captured and logged.
     */
    const runAgent = async (agentDef: SecurityAuditAgentDef): Promise<void> => {
      // Resolve modelo + runtime do agente cedo para mostrar no painel ativo durante 'running'
      let initialModel: string | null = null;
      let initialRuntime: 'cloud' | 'local' | 'external' | 'codex' | null = null;
      try {
        const cfg = await resolveAgentQueryConfig(agentDef.agentId);
        initialModel = cfg.model ?? null;
        initialRuntime = cfg.runtime ?? null;
      } catch (err) {
        logger.warn({ err, agentId: agentDef.agentId }, 'Could not resolve initial model/runtime for audit agent');
      }

      // Abort check before even starting
      if (abortController.signal.aborted) {
        updateSecurityAgentStatus(projectId, agentDef.agentId, {
          status: 'failed',
          errorMessage: 'Abortado antes de iniciar',
          completedAt: new Date().toISOString(),
        });
        emitIPC('pipeline:security-agent-status', {
          projectId,
          agentId: agentDef.agentId,
          agentName: agentDef.name,
          status: 'failed',
          error: 'Abortado antes de iniciar',
        });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: 'Abortado' });
        return;
      }

      const agentStartedAt = new Date();

      // Resolve the set of files sent in the initial prompt (relative paths from manifest)
      // so we can distinguish extras (files the agent READS beyond the initial set).
      const initialFilesForTracker = resolveFilesForAgent(manifest, agentDef.tags, 300);
      const initialFilesSet = new Set(initialFilesForTracker);

      // Per-agent stream tracker
      const tracker = {
        initialFilesCount: initialFilesForTracker.length,
        initialFilesSet,
        filesRead: new Set<string>(),
        toolCallsCount: 0,
        model: initialModel,
        runtime: initialRuntime,
      };

      const emitProgress = (
        status: 'queued' | 'running' | 'completed' | 'failed',
        extras?: Partial<{ findingsCount: number; costUsd: number; durationMs: number; model: string | null }>,
      ): void => {
        // Count files the agent opened that were NOT in the initial prompt set.
        // tracker.filesRead contains absolute paths (from Read tool file_path);
        // convert to relative before comparing against initialFilesSet.
        const extrasCount = (() => {
          let count = 0;
          for (const fp of tracker.filesRead) {
            const relative = fp.startsWith(projectPath + path.sep)
              ? fp.slice(projectPath.length + 1)
              : fp;
            if (!tracker.initialFilesSet.has(relative)) {
              count += 1;
            }
          }
          return count;
        })();

        emitIPC('pipeline:audit-agent-progress', {
          projectId,
          agentId: agentDef.agentId,
          slug: agentDef.slug,
          agentName: agentDef.name,
          status,
          filesAnalyzed: tracker.initialFilesCount,
          additionalFilesAfterStart: extrasCount,
          toolCallsCount: tracker.toolCallsCount,
          costUsd: extras?.costUsd ?? 0,
          durationMs: extras?.durationMs ?? (Date.now() - agentStartedAt.getTime()),
          findingsCount: extras?.findingsCount,
          model: extras?.model ?? tracker.model,
          runtime: tracker.runtime,
        });
      };

      // Mark as running
      updateSecurityAgentStatus(projectId, agentDef.agentId, {
        status: 'running',
        startedAt: agentStartedAt.toISOString(),
      });
      emitIPC('pipeline:security-agent-status', {
        projectId,
        agentId: agentDef.agentId,
        agentName: agentDef.name,
        status: 'running',
      });
      emitProgress('running');

      callbacks.onText?.(`[${agentDef.name}] iniciando...`);
      logger.info({ projectId, agentId: agentDef.agentId, order: agentDef.order }, 'Starting audit agent');

      // Reuse the already-resolved file list (same as initialFilesForTracker above)
      const files = initialFilesForTracker;
      const partialFilename = `Security-${scanId}-${agentDef.order.toString().padStart(2, '0')}-${agentDef.slug}.md`;
      const partialPath = path.join(securityDir, partialFilename);

      // Build user prompt
      const previousScanNote = manifest.previousScan
        ? `\n\nScan anterior disponivel em: ${manifest.previousScan}`
        : '';

      const fileList = files.length > 0
        ? files.map((f) => `- ${f}`).join('\n')
        : '(nenhum arquivo classificado para suas tags)';

      const userPrompt = buildAuditPrompt({
        agentDef,
        manifest,
        files,
        fileList,
        partialPath,
        previousScanNote,
        projectPath,
      });

      // Spawn the LLM agent - with one retry for transient exit-code-1 failures
      let result!: AgentRunResult;
      const MAX_ATTEMPTS = 2;
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await this.spawnAuditAgent(
            agentDef.agentId,
            userPrompt,
            projectPath,
            abortController,
            pipelineDocsId,
            agentDef,
            tracker,
            emitProgress,
          );
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          const isTransient = /Claude Code process exited with code 1/.test(lastErr.message);
          if (attempt < MAX_ATTEMPTS && isTransient) {
            logger.warn(
              { agentId: agentDef.agentId, attempt, errorMsg: lastErr.message },
              'Audit agent transient failure (exit code 1) - retrying after 5s',
            );
            callbacks.onText?.(`[${agentDef.name}] Falha transiente, tentando novamente em 5s...`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }
          break;
        }
      }

      if (lastErr) {
        const errorMsg = lastErr.message;
        logger.error({ err: lastErr, agentId: agentDef.agentId }, 'Audit agent failed');
        callbacks.onText?.(`[${agentDef.name}] ERRO: ${errorMsg}`);

        const completedAt = new Date().toISOString();
        updateSecurityAgentStatus(projectId, agentDef.agentId, {
          status: 'failed',
          errorMessage: errorMsg.substring(0, 500),
          completedAt,
        });
        emitIPC('pipeline:security-agent-status', {
          projectId,
          agentId: agentDef.agentId,
          agentName: agentDef.name,
          status: 'failed',
          error: errorMsg.substring(0, 200),
        });
        emitProgress('failed', { durationMs: Date.now() - agentStartedAt.getTime() });
        failed.push({ agentId: agentDef.agentId, name: agentDef.name, error: errorMsg });

        // Save failed metrics row
        savePipelinePhaseMetrics({
          projectId,
          phaseNumber: SECURITY_AUDIT_PHASE,
          phaseName: 'Security Audit',
          agentId: agentDef.agentId,
          status: 'failed',
          startedAt: agentStartedAt.toISOString(),
          completedAt,
          metadata: { auditAgent: true, findingsCount: 0, agentSlug: agentDef.slug },
          sprintIndex: agentDef.order,
        });

        return;
      }

      // Update tracker with the confirmed model + runtime returned by the spawn (may differ from initial guess)
      tracker.model = result.model ?? tracker.model;
      tracker.runtime = result.runtime ?? tracker.runtime;

      // Save output to partial file
      try {
        fs.writeFileSync(partialPath, result.output, 'utf-8');
      } catch (err) {
        logger.warn({ err, partialPath }, 'Could not write partial output file');
      }

      // Count findings using primary regex, with fallback if output contains finding keywords
      let findingsCount = (result.output.match(FINDING_REGEX) ?? []).length;
      if (findingsCount === 0 && result.output.length > 200) {
        // Normalise diacritics so 'crítico' (output) matches 'critico' (keyword).
        const normalised = result.output.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
        const hasFindingKeywords = (
          normalised.includes('finding') ||
          normalised.includes('vulnerab') ||
          normalised.includes('critico') ||
          normalised.includes('exposta') ||
          normalised.includes('exposed') ||
          normalised.includes('hardcod') ||
          normalised.includes('injection')
        );
        if (hasFindingKeywords) {
          const boldFindingMatches = result.output.match(/\*\*Finding[^*]*\*\*/gi) ?? [];
          const headerFindingMatches = result.output.match(/^### Finding [^\n]+/gm) ?? [];
          const fallbackCount = boldFindingMatches.length + headerFindingMatches.length;
          if (fallbackCount > 0) {
            logger.warn(
              {
                projectId,
                agentId: agentDef.agentId,
                primaryRegexCount: 0,
                fallbackCount,
                outputLen: result.output.length,
              },
              'Audit agent: fallback finding parser activated (canonical regex matched 0 but output has finding keywords)',
            );
            findingsCount = fallbackCount;
          }
        }
      }

      // Truncation detection: output is incomplete if it has no findings,
      // no explicit "no findings found" statement, AND looks like mid-stream
      // reasoning (very short or contains continuation keywords).
      const isTruncated = ((): boolean => {
        if (findingsCount > 0) return false;
        const lower = result.output.toLowerCase();
        const explicitNoFindings = (
          lower.includes('nenhum finding') ||
          lower.includes('no findings') ||
          lower.includes('sem findings') ||
          lower.includes('0 findings')
        );
        if (explicitNoFindings) return false;
        const looksLikeMidStream = (
          result.output.length < 200 ||
          /continuarei|continuando|vou prosseguir|vou analisar mais|let me continue|continuing/i.test(result.output)
        );
        return looksLikeMidStream;
      })();

      if (isTruncated) {
        logger.warn(
          {
            projectId,
            agentId: agentDef.agentId,
            outputLen: result.output.length,
            outputPreview: result.output.slice(0, 200),
          },
          'Audit agent output appears truncated (incomplete reasoning, no findings, no explicit zero-findings statement)',
        );
        callbacks.onText?.(`[${agentDef.name}] AVISO: output incompleto detectado. Pode ter sido cortado prematuramente.`);
      }

      const completedAt = new Date().toISOString();

      // Update DB status
      updateSecurityAgentStatus(projectId, agentDef.agentId, {
        status: 'completed',
        findingsCount,
        outputFile: partialFilename,
        completedAt,
      });

      // Emit status event
      emitIPC('pipeline:security-agent-status', {
        projectId,
        agentId: agentDef.agentId,
        agentName: agentDef.name,
        status: 'completed',
        findingsCount,
        outputFile: partialFilename,
      });

      callbacks.onText?.(`[${agentDef.name}] concluido. ${findingsCount} finding(s) encontrado(s).`);
      logger.info({ projectId, agentId: agentDef.agentId, findingsCount }, 'Audit agent completed');

      // Save per-agent metrics
      const durationMs = Date.now() - agentStartedAt.getTime();
      savePipelinePhaseMetrics({
        projectId,
        phaseNumber: SECURITY_AUDIT_PHASE,
        phaseName: 'Security Audit',
        agentId: agentDef.agentId,
        status: 'completed',
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        durationMs,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
        model: result.model,
        runtime: result.runtime,
        startedAt: agentStartedAt.toISOString(),
        completedAt,
        metadata: { auditAgent: true, findingsCount, agentSlug: agentDef.slug, truncated: isTruncated },
        sprintIndex: agentDef.order,
      });

      // Emit per-agent progress with final metrics
      emitProgress('completed', {
        findingsCount,
        costUsd: result.metrics.costUsd,
        durationMs,
        model: result.model,
      });

      // Emit cumulative usage for live metrics footer
      emitIPC('pipeline:usage', {
        projectId,
        phase: SECURITY_AUDIT_PHASE,
        agentId: agentDef.agentId,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheCreationTokens: result.metrics.cacheCreationTokens,
        costUsd: result.metrics.costUsd,
        durationMs,
        model: result.model,
      });
    };

    // Pool execution: never more than maxConcurrent agents running simultaneously
    await runWithConcurrencyLimit(queue, this.maxConcurrent, runAgent, abortController.signal);

    // --- 5. Merge deterministico ---
    callbacks.onText?.('Consolidando relatorio de seguranca...');
    const docsCtxMerge = getPipelineDocsContext(projectPath, pipelineDocsId);
    const consolidatedPath = await mergeAuditFiles({
      securityDir,
      scanId,
      agents: SECURITY_AUDIT_AGENTS,
      failed,
      overridePath: docsCtxMerge ? docsCtxMerge.resolveDocPath('Security.md') : undefined,
    });

    logger.info({ projectId, consolidatedPath }, 'Security audit merge complete');
    callbacks.onText?.(`Relatorio consolidado: ${path.basename(consolidatedPath)}`);

    // --- 6. Done ---
    callbacks.onDone?.();
    emitIPC('pipeline:stream', {
      projectId,
      phase: SECURITY_AUDIT_PHASE,
      type: 'done',
    });

    logger.info({ projectId, scanId, consolidatedPath }, 'SecurityAuditRunner finished');
    return consolidatedPath;
  }

  private async spawnAuditAgent(
    agentId: string,
    prompt: string,
    cwd: string,
    abortController: AbortController,
    pipelineDocsId: string | null,
    agentDef: SecurityAuditAgentDef,
    tracker: { initialFilesCount: number; initialFilesSet: Set<string>; filesRead: Set<string>; toolCallsCount: number; model: string | null },
    emitProgress: (
      status: 'queued' | 'running' | 'completed' | 'failed',
      extras?: Partial<{ findingsCount: number; costUsd: number; durationMs: number; model: string | null }>,
    ) => void,
  ): Promise<AgentRunResult> {
    const docsCtx = getPipelineDocsContext(cwd, pipelineDocsId);
    const projectId = this.currentProjectId;
    if (!projectId) {
      throw new Error('SecurityAuditRunner.spawnAuditAgent called without active projectId context');
    }

    const phase = SECURITY_AUDIT_PHASE;
    let lastProgressAt = Date.now();

    const result = await this.pipelineEngine.spawnAgent(agentId, prompt, {
      projectId,
      phaseNumber: phase,
      cwd,
      docsDir: docsCtx?.docsDir,
      abortController,
      skipProjectRootInjection: true,
      onText: (chunk) => {
        emitIPC('pipeline:stream', {
          type: 'text',
          projectId,
          phase,
          content: chunk,
          auditAgentId: agentDef.agentId,
          auditAgentSlug: agentDef.slug,
        });
      },
      onToolUse: (toolName: string) => {
        tracker.toolCallsCount += 1;
        emitIPC('pipeline:stream', {
          type: 'tool_call',
          projectId,
          phase,
          tool: toolName,
          auditAgentId: agentDef.agentId,
          auditAgentSlug: agentDef.slug,
        });
        // Throttled progress emission (every 1500ms)
        const now = Date.now();
        if (now - lastProgressAt > 1500) {
          lastProgressAt = now;
          emitProgress('running');
        }
      },
      onToolUseComplete: (toolName: string, input: unknown) => {
        if (toolName === 'Read' && input !== null && typeof input === 'object') {
          const fp = (input as Record<string, unknown>).file_path;
          if (typeof fp === 'string' && fp.length > 0) {
            tracker.filesRead.add(fp);
          }
        }
      },
    });

    logger.info(
      {
        agentId,
        runtime: result.runtime,
        model: result.model,
        provider: result.provider,
        durationMs: result.metrics.durationMs,
        outputLen: result.output.length,
        toolUses: result.metrics.toolUses,
        apiRequests: result.metrics.apiRequests,
      },
      'Security audit agent finished',
    );

    // Note: codex session is NOT closed per-agent here. With the unlimited pool
    // model, idle codex processes are harmless and only get killed when the entire
    // pipeline reaches status='done' or 'aborted'.

    return {
      output: result.output,
      metrics: result.metrics,
      model: result.model,
      runtime: result.runtime,
      provider: result.provider,
    };
  }
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

/**
 * Run all items in `queue` with at most `maxConcurrent` running simultaneously.
 * Errors from individual tasks do NOT propagate (worker captures them internally).
 * When `abortSignal` fires, not-yet-started items are skipped; in-flight workers
 * are allowed to run to completion before the returned promise resolves.
 *
 * Strategy: explicit activeWorkers counter inside a single wrapping Promise.
 * - launchNext() fills all available slots via a while-loop (safe because each
 *   iteration increments activeWorkers before spawning, so the condition tightens).
 * - Each worker's .finally() decrements activeWorkers and calls launchNext() again,
 *   keeping the pool full until the queue is drained.
 * - The wrapping Promise resolves ONLY when activeWorkers reaches 0 AND either the
 *   queue is exhausted or the signal is aborted (guaranteeing all workers have landed).
 *
 * Mental simulation with queue=[1..7], maxConcurrent=3:
 *   launchNext() initial call => W1, W2, W3 start (activeWorkers=3)
 *   W1 finishes => activeWorkers=2, launchNext => W4 starts (activeWorkers=3)
 *   W2 finishes => activeWorkers=2, launchNext => W5 starts (activeWorkers=3)
 *   W3 finishes => activeWorkers=2, launchNext => W6 starts (activeWorkers=3)
 *   W4 finishes => activeWorkers=2, launchNext => W7 starts (activeWorkers=3)
 *   W5 finishes => activeWorkers=2, launchNext => queue empty, no new launch
 *   W6 finishes => activeWorkers=1, launchNext => queue empty, no new launch
 *   W7 finishes => activeWorkers=0, nextIndex>=queue.length => resolve()
 *   Peak parallelism: exactly 3 at all times.
 *
 * Abort simulation (signal fires after W3 starts, before W4 is launched):
 *   launchNext() while-condition sees abortSignal.aborted=true => stops launching
 *   W1, W2, W3 complete normally => activeWorkers reaches 0 => resolve()
 *   W4-W7 are never spawned.
 */
function runWithConcurrencyLimit<T>(
  queue: T[],
  maxConcurrent: number,
  worker: (item: T) => Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (queue.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let nextIndex = 0;
    let activeWorkers = 0;

    const launchNext = (): void => {
      // Fill all available slots in one pass; each iteration increments
      // activeWorkers first so the while-condition naturally tightens.
      while (
        !abortSignal.aborted &&
        activeWorkers < maxConcurrent &&
        nextIndex < queue.length
      ) {
        const item = queue[nextIndex++];
        activeWorkers++;

        worker(item)
          .catch((err: unknown) => {
            // worker should not reject (it handles errors internally),
            // but guard defensively so the pool is never stuck.
            logger.error({ err }, 'runWithConcurrencyLimit: unexpected worker rejection');
          })
          .finally(() => {
            activeWorkers--;
            // Resolve only when every in-flight worker has landed and there
            // is nothing left to launch (queue drained or abort requested).
            if (activeWorkers === 0 && (nextIndex >= queue.length || abortSignal.aborted)) {
              resolve();
              return;
            }
            launchNext();
          });
      }

      // Edge case: queue was already empty or aborted before any worker launched.
      if (activeWorkers === 0) {
        resolve();
      }
    };

    launchNext();
  });
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

interface BuildAuditPromptArgs {
  agentDef: SecurityAuditAgentDef;
  manifest: RepoManifest;
  files: string[];
  fileList: string;
  partialPath: string;
  previousScanNote: string;
  projectPath: string;
}

const AGENT_PREFIX_MAP: Record<string, string> = {
  secrets: 'SECRETS',
  auth: 'AUTH',
  isolation: 'ISOLATION',
  duplication: 'DUPLICATION',
  logic: 'LOGIC',
  standards: 'STANDARDS',
  owasp: 'OWASP',
};

function buildAuditPrompt(args: BuildAuditPromptArgs): string {
  const { agentDef, manifest, files, fileList, previousScanNote, projectPath } = args;

  const prefix = AGENT_PREFIX_MAP[agentDef.slug] ?? agentDef.slug.toUpperCase();

  return `# Auditoria de Seguranca - ${agentDef.name}

## Projeto
- **Path:** ${projectPath}
- **Linguagem:** ${manifest.language}
- **Framework:** ${manifest.framework}
- **Total de arquivos classificados:** ${manifest.classifiedFiles}${previousScanNote}

## Arquivos sob sua responsabilidade (${files.length} arquivos)

${fileList}

---

## FASE 1 - INVESTIGACAO (ate 10 rounds de ferramentas)

Leia os arquivos listados acima usando Read, Grep e Glob. Identifique vulnerabilidades,
problemas de seguranca e riscos dentro do escopo do seu papel.

Conforme voce identifica vulnerabilidades durante a investigacao, EMITA imediatamente o
finding completo no formato abaixo, sem esperar o final da analise. NAO acumule findings
para o final.

## FASE 2 - RELATORIO (obrigatorio, mesmo que parcial)

Ao concluir a investigacao (ou ao atingir o limite de rounds), escreva TODOS os findings
encontrados usando EXATAMENTE o template abaixo:

### ${prefix}-{NNN}: {Titulo curto da vulnerabilidade}
- **Severidade:** CRITICO | ALTO | MEDIO | BAIXO
- **Arquivo(s):** caminho/do/arquivo.ts:linha
- **Trecho:**
  \`\`\`linguagem
  codigo relevante aqui
  \`\`\`
- **Impacto:** Descricao do risco concreto
- **Recomendacao:** Como corrigir de forma segura

Onde {NNN} e um numero sequencial de 3 digitos (001, 002, etc).
Use o prefixo ${prefix} em todos os findings.

Se nao encontrar nenhum problema, escreva apenas: "Nenhum finding encontrado para os arquivos analisados."

**OBRIGATORIO:** A ultima linha da sua resposta final DEVE ser exatamente:
\`RELATORIO COMPLETO\`

O runner salvara automaticamente o conteudo da sua resposta. Voce nao precisa e nao deve escrever arquivos.

Comece a FASE 1 agora.`;
}

// ---------------------------------------------------------------------------
// Merge deterministico
// ---------------------------------------------------------------------------

interface MergeArgs {
  securityDir: string;
  scanId: string;
  agents: SecurityAuditAgentDef[];
  failed: Array<{ agentId: string; name: string; error: string }>;
  /** When provided, write the consolidated report here instead of inside securityDir. */
  overridePath?: string;
}

async function mergeAuditFiles(args: MergeArgs): Promise<string> {
  const { securityDir, scanId, agents, failed, overridePath } = args;
  const sortedAgents = [...agents].sort((a, b) => a.order - b.order);

  const sections: string[] = [];

  // Optional header listing failed agents
  if (failed.length > 0) {
    const failedList = failed
      .map((f) => `- ${f.name} (${f.agentId}): ${f.error.substring(0, 100)}`)
      .join('\n');
    sections.push(
      `# Aviso: Agentes com falha\n\nOs seguintes agentes nao concluiram a auditoria:\n\n${failedList}\n\nOs resultados abaixo sao parciais.`,
    );
  }

  // Read each partial file in order 01..07
  for (const agentDef of sortedAgents) {
    const partialFilename = `Security-${scanId}-${agentDef.order.toString().padStart(2, '0')}-${agentDef.slug}.md`;
    const partialPath = path.join(securityDir, partialFilename);

    if (!fs.existsSync(partialPath)) {
      logger.warn({ partialPath }, 'Partial file not found during merge; skipping');
      continue;
    }

    try {
      const content = fs.readFileSync(partialPath, 'utf-8').trim();
      const header = `## ${agentDef.order.toString().padStart(2, '0')}. ${agentDef.name}`;
      sections.push(`${header}\n\n${content}`);
    } catch (err) {
      logger.warn({ err, partialPath }, 'Could not read partial file during merge; skipping');
    }
  }

  const consolidated = sections.join('\n\n---\n\n');
  const consolidatedFilename = `Security-${scanId}.md`;
  const consolidatedPath = overridePath ?? path.join(securityDir, consolidatedFilename);

  try {
    fs.writeFileSync(consolidatedPath, consolidated, 'utf-8');
    logger.info({ consolidatedPath }, 'Consolidated security report written');
  } catch (err) {
    logger.error({ err, consolidatedPath }, 'Failed to write consolidated report');
    throw err;
  }

  return consolidatedPath;
}
