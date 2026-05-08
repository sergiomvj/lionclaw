/**
 * pipeline-report.ts
 *
 * Generates a Markdown pipeline execution report from pipeline_phase_metrics
 * and harness_rounds (for per-sprint detail).
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getPipelineMetrics, getHarnessProject, getHarnessSprints, getHarnessRounds } from './db';
import type { PipelinePhaseMetricsRow } from './db';

const logger = createLogger('pipeline-report');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

function formatRuntime(runtime: string | null | undefined): string {
  if (!runtime) return 'cloud';
  if (runtime === 'local') return 'local (Ollama)';
  if (runtime === 'external') return 'external (API)';
  if (runtime === 'codex') return 'codex (OpenAI/OAuth)';
  return 'cloud';
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'completed': return 'OK';
    case 'failed': return 'FAIL';
    case 'running': return 'RUN';
    case 'interrupted': return 'INT';
    case 'skipped': return 'SKIP';
    default: return status.toUpperCase();
  }
}

function hrLine(): string {
  return '\n---\n';
}

// ---------------------------------------------------------------------------
// Section: General Summary
// ---------------------------------------------------------------------------

function buildSummarySection(metrics: ReturnType<typeof getPipelineMetrics>): string {
  const { totals, cloudCost, localCost } = metrics;
  const hasLocal = localCost > 0;

  let section = '## Resumo Geral\n\n';
  section += `| Metrica | Valor |\n`;
  section += `|---|---|\n`;
  section += `| Tokens de entrada | ${formatTokens(totals.inputTokens)} |\n`;
  section += `| Tokens de saida | ${formatTokens(totals.outputTokens)} |\n`;
  section += `| Tokens de cache | ${formatTokens(totals.cacheTokens)} |\n`;
  section += `| Custo total | ${formatCost(totals.costUsd)} |\n`;
  if (hasLocal) {
    section += `| Custo cloud | ${formatCost(cloudCost)} |\n`;
    section += `| Custo local (Ollama) | ${formatCost(localCost)} |\n`;
  }
  section += `| Duracao total | ${formatMs(totals.durationMs)} |\n`;
  section += `| Chamadas de ferramenta | ${totals.toolUses} |\n`;
  section += `| Requisicoes de API | ${totals.apiRequests} |\n`;

  return section;
}

// ---------------------------------------------------------------------------
// Section: Per-phase Detail
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<number, string> = {
  1: 'Discovery',
  2: 'PRD Generator (Modo 1)',
  3: 'PRD Validator',
  4: 'PRD Generator (Modo 2)',
  5: 'Technical Decisions',
  6: 'Spec Generation (Builder)',
  61: 'Spec Generation (Validator)',
  7: 'Spec Enricher',
  8: 'Planner',
  9: 'Sprint Validator',
  10: 'Coder',
  11: 'Evaluator',
  12: 'Acceptance Reviewer',
};

function buildPhasesSection(phases: PipelinePhaseMetricsRow[]): string {
  if (phases.length === 0) return '';

  let section = '## Detalhe por Fase\n\n';
  section += `| Fase | Nome | Status | Agente | Modelo | Runtime | Entrada | Saida | Cache | Custo | Duracao | Tools | API Reqs |\n`;
  section += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

  for (const p of phases) {
    const phaseLabel = PHASE_LABELS[p.phaseNumber] ?? p.phaseName;
    const agentId = p.agentId ?? '-';
    const model = p.model ?? '-';
    const runtime = formatRuntime(p.runtime);
    section += `| ${p.phaseNumber} | ${phaseLabel} | ${statusEmoji(p.status)} | ${agentId} | ${model} | ${runtime} | ${formatTokens(p.inputTokens)} | ${formatTokens(p.outputTokens)} | ${formatTokens(p.cacheReadTokens + p.cacheCreationTokens)} | ${formatCost(p.costUsd)} | ${formatMs(p.durationMs)} | ${p.toolUses} | ${p.apiRequests} |\n`;
  }

  return section;
}

// ---------------------------------------------------------------------------
// Section: Per-sprint Detail (from harness_rounds)
// ---------------------------------------------------------------------------

interface RoundRow {
  id: string;
  sprintId: string;
  roundNumber: number;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
}

function buildSprintsSection(projectId: string): string {
  const sprints = getHarnessSprints(projectId);
  if (sprints.length === 0) return '';

  let section = '## Detalhe por Sprint\n\n';

  for (const sprint of sprints) {
    section += `### Sprint: ${sprint.name}\n\n`;
    section += `- **Status:** ${sprint.status}\n`;
    section += `- **ID:** ${sprint.id}\n\n`;

    let rounds: RoundRow[] = [];
    try {
      rounds = getHarnessRounds(sprint.id) as RoundRow[];
    } catch {
      // rounds table may be empty for pipeline-only projects
    }

    if (rounds.length > 0) {
      section += `| Round | Status | Entrada | Saida | Cache | Custo | Duracao | Tools | API Reqs |\n`;
      section += `|---|---|---|---|---|---|---|---|---|\n`;

      for (const r of rounds) {
        section += `| ${r.roundNumber} | ${statusEmoji(r.status)} | ${formatTokens(r.inputTokens ?? 0)} | ${formatTokens(r.outputTokens ?? 0)} | ${formatTokens(r.cacheTokens ?? 0)} | ${formatCost(r.costUsd ?? 0)} | ${formatMs(r.durationMs ?? 0)} | ${r.toolUses ?? 0} | ${r.apiRequests ?? 0} |\n`;
      }
      section += '\n';
    } else {
      section += '_Nenhum round registrado para este sprint._\n\n';
    }
  }

  return section;
}

// ---------------------------------------------------------------------------
// Section: Generated Artifacts
// ---------------------------------------------------------------------------

function buildArtifactsSection(projectPath: string): string {
  const ARTIFACT_FILES = [
    'discovery-notes.md',
    'stories-requisitos.md',
    'PRD.md',
    'SPEC.md',
    'sprints.json',
    'pipeline-report.md',
    '.prd-validation-report.md',
    '.spec-validation-report.md',
    '.spec-enricher-suggestions.md',
    '.sprint-validation-report.md',
  ];

  const found: Array<{ name: string; sizeBytes: number }> = [];

  for (const filename of ARTIFACT_FILES) {
    const fullPath = path.join(projectPath, filename);
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        found.push({ name: filename, sizeBytes: stat.size });
      } catch {
        // ignore stat errors
      }
    }
  }

  if (found.length === 0) return '';

  let section = '## Artefatos Gerados\n\n';
  section += `| Arquivo | Tamanho |\n`;
  section += `|---|---|\n`;

  for (const f of found) {
    const sizeKb = (f.sizeBytes / 1024).toFixed(1);
    section += `| \`${f.name}\` | ${sizeKb} KB |\n`;
  }

  return section;
}

// ---------------------------------------------------------------------------
// Section: Cloud vs Local breakdown
// ---------------------------------------------------------------------------

function buildRuntimeSection(metrics: ReturnType<typeof getPipelineMetrics>): string {
  const { cloudCost, localCost, phases } = metrics;
  const hasLocal = phases.some((p) => p.runtime === 'local');
  const hasExternal = phases.some((p) => p.runtime === 'external');
  const hasCodex = phases.some((p) => p.runtime === 'codex');
  if (!hasLocal && !hasExternal && !hasCodex) return '';

  const externalCost = phases
    .filter((p) => p.runtime === 'external')
    .reduce((sum, p) => sum + p.costUsd, 0);
  const codexCost = phases
    .filter((p) => p.runtime === 'codex')
    .reduce((sum, p) => sum + p.costUsd, 0);
  // Cloud cost from db excludes only 'local'; recalculate to also exclude external and codex.
  const trueCloudCost = cloudCost - externalCost - codexCost;

  let section = '## Custo por Runtime\n\n';
  section += `| Runtime | Custo |\n`;
  section += `|---|---|\n`;
  section += `| Cloud (Anthropic) | ${formatCost(trueCloudCost)} |\n`;
  if (hasLocal)     section += `| Local (Ollama) | ${formatCost(localCost)} |\n`;
  if (hasExternal)  section += `| External (API) | ${formatCost(externalCost)} |\n`;
  if (hasCodex)     section += `| Codex (OpenAI/OAuth) | ${formatCost(codexCost)} |\n`;
  section += '\n';

  const localPhases = phases.filter((p) => p.runtime === 'local');
  if (localPhases.length > 0) {
    section += `**Fases executadas localmente:** ${localPhases.map((p) => p.phaseName).join(', ')}\n`;
  }
  const codexPhases = phases.filter((p) => p.runtime === 'codex');
  if (codexPhases.length > 0) {
    section += `**Fases executadas via Codex:** ${codexPhases.map((p) => p.phaseName).join(', ')}\n`;
  }

  return section;
}

// ---------------------------------------------------------------------------
// Main: generatePipelineReport
// ---------------------------------------------------------------------------

/**
 * Generate a complete Markdown pipeline report for a project.
 *
 * @param projectId - Harness project ID
 * @returns Markdown string with full report
 */
export function generatePipelineReport(projectId: string): string {
  const project = getHarnessProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const metrics = getPipelineMetrics(projectId);

  const now = new Date().toISOString();

  let report = `# Pipeline Report — ${project.name}\n\n`;
  report += `**Projeto:** ${project.name}\n`;
  report += `**ID:** ${projectId}\n`;
  report += `**Caminho:** ${project.projectPath}\n`;
  report += `**Gerado em:** ${now}\n`;

  if (project.pipelineCurrentPhase !== null && project.pipelineCurrentPhase !== undefined) {
    report += `**Fase atual:** ${project.pipelineCurrentPhase}\n`;
  }

  report += '\n';
  report += hrLine();
  report += '\n';

  // General summary
  report += buildSummarySection(metrics);
  report += '\n';
  report += hrLine();
  report += '\n';

  // Per-phase detail
  const phasesSection = buildPhasesSection(metrics.phases);
  if (phasesSection) {
    report += phasesSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  // Per-sprint detail (from harness_rounds)
  const sprintsSection = buildSprintsSection(projectId);
  if (sprintsSection) {
    report += sprintsSection;
    report += hrLine();
    report += '\n';
  }

  // Artifacts
  const artifactsSection = buildArtifactsSection(project.projectPath);
  if (artifactsSection) {
    report += artifactsSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  // Runtime breakdown (only if local agents were used)
  const runtimeSection = buildRuntimeSection(metrics);
  if (runtimeSection) {
    report += runtimeSection;
    report += '\n';
    report += hrLine();
    report += '\n';
  }

  report += `_Relatorio gerado automaticamente pelo LionClaw Pipeline Engine._\n`;

  return report;
}

// ---------------------------------------------------------------------------
// Export: exportReport — save report to projectPath/pipeline-report.md
// ---------------------------------------------------------------------------

/**
 * Generate and save the pipeline report to the project's directory.
 *
 * @param projectId - Harness project ID
 * @param format - Currently only 'md' is supported
 * @returns The absolute path where the report was saved
 */
export function exportReport(projectId: string, format: 'md'): string {
  const project = getHarnessProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (format !== 'md') {
    throw new Error(`Unsupported format: ${format}. Only 'md' is supported.`);
  }

  const report = generatePipelineReport(projectId);
  const reportPath = path.join(project.projectPath, 'pipeline-report.md');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf-8');

  logger.info({ projectId, reportPath }, 'Pipeline report exported');

  return reportPath;
}
