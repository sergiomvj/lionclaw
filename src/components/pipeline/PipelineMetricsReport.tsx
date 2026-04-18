import { Fragment } from 'react';
import {
  DollarSign,
  Clock,
  RotateCcw,
  TrendingUp,
  Cpu,
  Activity,
  CheckCircle2,
  XCircle,
  Cloud,
  Server,
  X,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelinePhaseMetrics, PipelineMetricsResult } from '@/types';

// ---- Phase CSS variables (--phase-1 through --phase-14) ----

const PHASE_CSS_VARS = `
  :root {
    --phase-1:  #6366f1;
    --phase-2:  #8b5cf6;
    --phase-3:  #a78bfa;
    --phase-4:  #7c3aed;
    --phase-5:  #0ea5e9;
    --phase-6:  #22c55e;
    --phase-7:  #16a34a;
    --phase-8:  #f59e0b;
    --phase-9:  #d97706;
    --phase-10: #f97316;
    --phase-11: #3b82f6;
    --phase-12: var(--color-purple-400, #c084fc);
    --phase-13: var(--color-sky-400, #38bdf8);
    --phase-14: var(--color-teal-400, #2dd4bf);
  }
`;

// ---- Formatting helpers ----

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}min`;
  if (seconds === 0) return `${minutes}min`;
  return `${minutes}min ${seconds.toString().padStart(2, '0')}s`;
}

function pct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

// ---- Phase sort and display helpers for non-integer phases (e.g. 91 = "9.1") ----

const phaseSortKey = (n: number): number => n === 91 ? 9.1 : n;
const phaseDisplayLabel = (n: number): string => n === 91 ? '9.1' : String(n);

// ---- Phase type classifier ----

type PhaseType = 'conversation' | 'auto' | 'loop';

function classifyPhase(phaseNumber: number): PhaseType {
  if (phaseNumber === 91) return 'auto';
  // 14-phase system: Coder (13) and Evaluator (14) are loop phases
  if (phaseNumber === 13 || phaseNumber === 14) return 'loop';
  // Conversational phases: 1 (Discovery), 3 (PRD Validator), 5-8 (Tech), 9 (Spec review), 10 (Spec Enricher), 12 (Sprint Validator)
  if (phaseNumber === 1 || phaseNumber === 3) return 'conversation';
  if (phaseNumber >= 5 && phaseNumber <= 10) return 'conversation';
  if (phaseNumber === 12) return 'conversation';
  // Auto phases: 2 (PRD Gen), 4 (PRD Completo), 11 (Planner)
  return 'auto';
}

function phaseTypeColor(type: PhaseType): string {
  if (type === 'conversation') return 'bg-blue-500';
  if (type === 'auto') return 'bg-green-500';
  return 'bg-amber-500';
}

function phaseTypeBadgeColor(type: PhaseType): string {
  if (type === 'conversation') return 'bg-blue-500/15 text-blue-400';
  if (type === 'auto') return 'bg-green-500/15 text-green-400';
  return 'bg-amber-500/15 text-amber-400';
}

function phaseTypeLabel(type: PhaseType): string {
  if (type === 'conversation') return 'Conversa';
  if (type === 'auto') return 'Auto';
  return 'Loop';
}

// ---- Phase color from CSS variable ----

function phaseVarColor(phaseNumber: number): string {
  if (phaseNumber === 91) return 'var(--phase-9)';
  const n = Math.max(1, Math.min(14, phaseNumber));
  return `var(--phase-${n})`;
}

// ---- KPI Card ----

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

function KpiCard({ icon, label, value, sub, color = 'text-zinc-100' }: KpiCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500">{icon}</span>
        <span className="text-[11px] text-zinc-500 uppercase tracking-wide font-medium">{label}</span>
      </div>
      <span className={`text-2xl font-bold leading-none ${color}`}>{value}</span>
      {sub !== undefined && (
        <span className="text-[11px] text-zinc-600">{sub}</span>
      )}
    </div>
  );
}

// ---- Horizontal bar chart row ----

interface BarRowProps {
  label: string;
  value: number;
  maxValue: number;
  formattedValue: string;
  barColor: string;
  barCssVar?: string;
  badge?: string;
  badgeColor?: string;
}

function BarRow({ label, value, maxValue, formattedValue, barColor, barCssVar, badge, badgeColor }: BarRowProps) {
  const width = pct(value, maxValue);

  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 flex items-center gap-1.5">
        <span className="text-xs text-zinc-300 truncate">{label}</span>
        {badge !== undefined && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0 ${badgeColor ?? ''}`}>
            {badge}
          </span>
        )}
      </div>
      <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden">
        <div
          className={barCssVar ? 'h-5 rounded transition-all duration-500' : `h-5 rounded transition-all duration-500 ${barColor}`}
          style={{
            width: `${width}%`,
            minWidth: width > 0 ? '4px' : '0',
            ...(barCssVar ? { background: barCssVar } : {}),
          }}
        />
      </div>
      <span className="text-xs text-zinc-400 w-20 text-right shrink-0 font-mono">
        {formattedValue}
      </span>
    </div>
  );
}

// ---- Section 1: KPI Cards ----

interface KpiSectionProps {
  metrics: PipelineMetricsResult;
}

function KpiSection({ metrics }: KpiSectionProps) {
  const { totals } = metrics;
  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheTokens;

  const executedPhases = metrics.phases.filter((p) => p.status === 'completed');
  const passRate =
    metrics.phases.length > 0
      ? Math.round((executedPhases.length / metrics.phases.length) * 100)
      : 0;

  const passColor =
    passRate >= 70 ? 'text-green-400' : passRate >= 50 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <KpiCard
        icon={<DollarSign size={14} />}
        label="Custo Total"
        value={formatCost(totals.costUsd)}
        sub={`Cloud: ${formatCost(metrics.cloudCost)} / Local: ${formatCost(metrics.localCost)}`}
      />
      <KpiCard
        icon={<Clock size={14} />}
        label="Duracao Total"
        value={formatDuration(totals.durationMs)}
      />
      <KpiCard
        icon={<RotateCcw size={14} />}
        label="Total Rounds"
        value={String(
          metrics.sprintPhases.filter((p) => p.phaseNumber === 13).length +
          metrics.sprintPhases.filter((p) => p.phaseNumber === 14).length,
        )}
        sub={`${metrics.sprintPhases.length} execucoes de loop`}
      />
      <KpiCard
        icon={<TrendingUp size={14} />}
        label="Pass Rate"
        value={`${passRate}%`}
        color={passColor}
        sub={`${executedPhases.length}/${metrics.phases.length} fases`}
      />
      <KpiCard
        icon={<Cpu size={14} />}
        label="Total Tokens"
        value={formatTokens(totalTokens)}
        sub={`In: ${formatTokens(totals.inputTokens)} / Out: ${formatTokens(totals.outputTokens)}`}
      />
      <KpiCard
        icon={<Activity size={14} />}
        label="API Requests"
        value={String(totals.apiRequests)}
        sub={`${totals.toolUses} tool uses`}
      />
    </div>
  );
}

// ---- Section 2: Cost per phase ----

const PHASE_DISPLAY_NAMES: Record<number, string> = {
  1: 'Discovery',
  2: 'PRD Generator',
  3: 'PRD Validator',
  4: 'PRD Completo',
  5: 'Tech: Database',
  6: 'Tech: Backend',
  7: 'Tech: Frontend',
  8: 'Tech: Security',
  9: 'Spec Generation',
  91: 'Spec Validator',
  10: 'Spec Enricher',
  11: 'Planner',
  12: 'Sprint Validator',
  13: 'Coder',
  14: 'Evaluator',
};

interface PhaseBarChartProps {
  phases: PipelinePhaseMetrics[];
}

function PhaseBarChart({ phases }: PhaseBarChartProps) {
  if (phases.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-6">Nenhuma fase executada ainda.</p>
    );
  }

  const phaseMap = new Map<number, number>();
  for (const p of phases) {
    phaseMap.set(p.phaseNumber, (phaseMap.get(p.phaseNumber) ?? 0) + p.costUsd);
  }

  const rows = Array.from(phaseMap.entries())
    .sort(([a], [b]) => phaseSortKey(a) - phaseSortKey(b))
    .map(([phaseNumber, costUsd]) => ({
      phaseNumber,
      label: PHASE_DISPLAY_NAMES[phaseNumber] ?? `Fase ${phaseNumber}`,
      costUsd,
      type: classifyPhase(phaseNumber),
    }));

  const maxCost = Math.max(...rows.map((r) => r.costUsd), 0.0001);

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <BarRow
          key={row.phaseNumber}
          label={`${phaseDisplayLabel(row.phaseNumber)}. ${row.label}`}
          value={row.costUsd}
          maxValue={maxCost}
          formattedValue={formatCost(row.costUsd)}
          barColor={phaseTypeColor(row.type)}
          barCssVar={phaseVarColor(row.phaseNumber)}
          badge={phaseTypeLabel(row.type)}
          badgeColor={phaseTypeBadgeColor(row.type)}
        />
      ))}

      {/* Legend */}
      <div className="flex items-center gap-4 pt-2 justify-end">
        {(['conversation', 'auto', 'loop'] as PhaseType[]).map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded ${phaseTypeColor(type)}`} />
            <span className="text-[10px] text-zinc-500">{phaseTypeLabel(type)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Section 3: Agent distribution ----

interface AgentBarChartProps {
  phases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
}

function AgentBarChart({ phases, agentNames }: AgentBarChartProps) {
  const agentMap = new Map<string, number>();
  for (const p of phases) {
    const key = p.agentId ?? p.phaseName;
    agentMap.set(key, (agentMap.get(key) ?? 0) + p.costUsd);
  }

  const rows = Array.from(agentMap.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-6">Nenhum dado de agente disponivel.</p>
    );
  }

  const maxCost = Math.max(...rows.map(([, v]) => v), 0.0001);

  return (
    <div className="space-y-2">
      {rows.map(([agentId, costUsd]) => (
        <BarRow
          key={agentId}
          label={agentNames[agentId] ?? agentId}
          value={costUsd}
          maxValue={maxCost}
          formattedValue={formatCost(costUsd)}
          barColor="bg-amber-500"
        />
      ))}
    </div>
  );
}

// ---- Section 4: Sprint cost stacked bars ----

interface SprintBarData {
  sprintIndex: number;
  coderCost: number;
  evalCost: number;
  total: number;
}

function buildSprintBarData(sprintPhases: PipelinePhaseMetrics[]): SprintBarData[] {
  const sprintMap = new Map<number, SprintBarData>();

  for (const p of sprintPhases) {
    // Use the top-level sprintIndex field (from sprint_index column);
    // fall back to metadata.sprintIndex for backwards compatibility.
    const si = p.sprintIndex >= 0
      ? p.sprintIndex
      : (typeof p.metadata?.sprintIndex === 'number' ? p.metadata.sprintIndex : -1);
    if (si < 0) continue;

    if (!sprintMap.has(si)) {
      sprintMap.set(si, {
        sprintIndex: si,
        coderCost: 0,
        evalCost: 0,
        total: 0,
      });
    }

    const entry = sprintMap.get(si)!;
    if (p.phaseNumber === 13) entry.coderCost += p.costUsd;
    else if (p.phaseNumber === 14) entry.evalCost += p.costUsd;
    entry.total += p.costUsd;
  }

  return Array.from(sprintMap.values()).sort((a, b) => a.sprintIndex - b.sprintIndex);
}

interface SprintCostChartProps {
  sprintPhases: PipelinePhaseMetrics[];
}

function SprintCostChart({ sprintPhases }: SprintCostChartProps) {
  const rows = buildSprintBarData(sprintPhases);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-6">Nenhum sprint executado ainda.</p>
    );
  }

  const maxTotal = Math.max(...rows.map((r) => r.total), 0.0001);

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const coderW = pct(row.coderCost, maxTotal);
        const evalW = pct(row.evalCost, maxTotal);

        return (
          <div key={row.sprintIndex} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-20 shrink-0">
              Sprint {row.sprintIndex + 1}
            </span>
            <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden flex">
              {coderW > 0 && (
                <div
                  className="h-5 transition-all duration-500"
                  style={{ width: `${coderW}%`, minWidth: '4px', background: 'var(--phase-13)' }}
                  title={`Coder: ${formatCost(row.coderCost)}`}
                />
              )}
              {evalW > 0 && (
                <div
                  className="h-5 transition-all duration-500"
                  style={{ width: `${evalW}%`, minWidth: '4px', background: 'var(--phase-14)' }}
                  title={`Evaluator: ${formatCost(row.evalCost)}`}
                />
              )}
            </div>
            <span className="text-xs text-zinc-400 w-16 text-right font-mono shrink-0">
              {formatCost(row.total)}
            </span>
          </div>
        );
      })}

      {/* Legend */}
      <div className="flex items-center gap-4 pt-1 justify-end">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ background: 'var(--phase-13)' }} />
          <span className="text-[10px] text-zinc-500">Coder</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ background: 'var(--phase-14)' }} />
          <span className="text-[10px] text-zinc-500">Evaluator</span>
        </div>
      </div>
    </div>
  );
}

// ---- Section 5: Detailed phase table ----

interface PhaseTableProps {
  phases: PipelinePhaseMetrics[];
  agentNames: Record<string, string>;
}

/** Render a single data row for the phase table. */
function PhaseRow({
  phase,
  label,
  rowBg,
  indent,
  agentNames,
}: {
  phase: PipelinePhaseMetrics;
  label: string;
  rowBg: string;
  indent?: boolean;
  agentNames?: Record<string, string>;
}) {
  const type = classifyPhase(phase.phaseNumber);
  const isPass =
    phase.status === 'done' ||
    phase.status === 'approved' ||
    phase.status === 'passed' ||
    phase.status === 'completed';
  const isFail = phase.status === 'failed' || phase.status === 'rejected';

  return (
    <tr className={rowBg}>
      <td
        className={`px-4 py-2 font-medium ${indent ? 'pl-8' : ''}`}
        style={{ color: phaseVarColor(phase.phaseNumber) }}
      >
        {label}
      </td>
      <td className="px-4 py-2 text-zinc-400 max-w-[180px] truncate" title={phase.agentId ?? undefined}>
        {phase.agentId ? (agentNames?.[phase.agentId] ?? phase.agentId) : '-'}
      </td>
      <td className="px-4 py-2 text-center">
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase ${phaseTypeBadgeColor(type)}`}
        >
          {phaseTypeLabel(type)}
        </span>
      </td>
      <td className="px-4 py-2 text-zinc-300 text-right font-mono">
        {formatCost(phase.costUsd)}
      </td>
      <td className="px-4 py-2 text-zinc-400 text-right">
        {formatTokens(phase.inputTokens + phase.outputTokens)}
      </td>
      <td className="px-4 py-2 text-zinc-400 text-right">
        {formatDuration(phase.durationMs)}
      </td>
      <td className="px-4 py-2 text-center">
        {isPass ? (
          <span className="flex items-center justify-center gap-1 text-green-400">
            <CheckCircle2 size={11} />
            <span className="text-[10px]">OK</span>
          </span>
        ) : isFail ? (
          <span className="flex items-center justify-center gap-1 text-red-400">
            <XCircle size={11} />
            <span className="text-[10px]">Falhou</span>
          </span>
        ) : (
          <span className="text-[10px] text-zinc-600 uppercase">{phase.status}</span>
        )}
      </td>
    </tr>
  );
}

function PhaseTable({ phases, agentNames }: PhaseTableProps) {
  // Separate preparation phases (1-12 + 91) from sprint execution phases (13-14)
  const preparationPhases = phases
    .filter((p) => p.phaseNumber < 13 || p.phaseNumber === 91)
    .sort((a, b) => phaseSortKey(a.phaseNumber) - phaseSortKey(b.phaseNumber));
  const sprintPhases = phases.filter((p) => p.phaseNumber >= 13 && p.phaseNumber !== 91);

  // Group sprint phases by sprintIndex (14-phase system: Coder=13, Evaluator=14)
  const sprintMap = new Map<
    number,
    { coder: PipelinePhaseMetrics[]; evaluator: PipelinePhaseMetrics[] }
  >();
  for (const p of sprintPhases) {
    const si =
      p.sprintIndex >= 0
        ? p.sprintIndex
        : typeof p.metadata?.sprintIndex === 'number'
          ? p.metadata.sprintIndex
          : -1;
    if (si < 0) continue;
    if (!sprintMap.has(si)) sprintMap.set(si, { coder: [], evaluator: [] });
    const group = sprintMap.get(si)!;
    if (p.phaseNumber === 13) group.coder.push(p);
    else if (p.phaseNumber === 14) group.evaluator.push(p);
  }

  const sortedSprints = Array.from(sprintMap.entries()).sort(([a], [b]) => a - b);

  let rowIndex = 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-2 font-medium">Fase</th>
            <th className="px-4 py-2 font-medium">Agente</th>
            <th className="px-4 py-2 font-medium text-center">Tipo</th>
            <th className="px-4 py-2 font-medium text-right">Custo</th>
            <th className="px-4 py-2 font-medium text-right">Tokens</th>
            <th className="px-4 py-2 font-medium text-right">Duracao</th>
            <th className="px-4 py-2 font-medium text-center">Resultado</th>
          </tr>
        </thead>
        <tbody>
          {/* Non-sprint phases (1-9): render normally */}
          {preparationPhases.map((phase) => {
            const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
            rowIndex++;
            return (
              <PhaseRow
                key={`prep-${phase.phaseNumber}-${phase.id}`}
                phase={phase}
                label={`${phaseDisplayLabel(phase.phaseNumber)}. ${PHASE_DISPLAY_NAMES[phase.phaseNumber] ?? phase.phaseName}`}
                rowBg={bg}
                agentNames={agentNames}
              />
            );
          })}

          {/* Sprint phases (13-14): grouped under sprint headers */}
          {sortedSprints.map(([si, group]) => {
            const sprintName =
              (group.coder[0]?.metadata?.sprintName as string) ||
              (group.evaluator[0]?.metadata?.sprintName as string) ||
              `Sprint ${si + 1}`;
            const sprintTotal =
              [...group.coder, ...group.evaluator].reduce(
                (acc, p) => acc + p.costUsd,
                0,
              );

            return (
              <Fragment key={`sprint-${si}`}>
                {/* Sprint header row */}
                <tr className="bg-zinc-800/70 border-t border-zinc-700">
                  <td
                    colSpan={3}
                    className="px-4 py-2 font-semibold text-amber-400 text-xs"
                  >
                    Sprint {si + 1}: {sprintName}
                  </td>
                  <td className="px-4 py-2 text-amber-400 text-right font-mono font-semibold text-xs">
                    {formatCost(sprintTotal)}
                  </td>
                  <td colSpan={3} />
                </tr>

                {/* Coder rows for this sprint */}
                {group.coder.map((phase) => {
                  const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
                  rowIndex++;
                  return (
                    <PhaseRow
                      key={`coder-${si}-${phase.id}`}
                      phase={phase}
                      label="Coder"
                      rowBg={bg}
                      indent
                      agentNames={agentNames}
                    />
                  );
                })}

                {/* Evaluator rows for this sprint */}
                {group.evaluator.map((phase) => {
                  const bg = rowIndex % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
                  rowIndex++;
                  return (
                    <PhaseRow
                      key={`eval-${si}-${phase.id}`}
                      phase={phase}
                      label="Evaluator"
                      rowBg={bg}
                      indent
                      agentNames={agentNames}
                    />
                  );
                })}

              </Fragment>
            );
          })}

          {phases.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-zinc-600">
                Nenhuma fase executada ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- Section 6: Sprint detail table ----

interface SprintTableProps {
  sprintPhases: PipelinePhaseMetrics[];
}

function SprintDetailTable({ sprintPhases }: SprintTableProps) {
  const rows = buildSprintBarData(sprintPhases);

  const sprintExtras = new Map<
    number,
    { tokens: number; durationMs: number; verdict: string }
  >();

  for (const p of sprintPhases) {
    const si = p.sprintIndex >= 0
      ? p.sprintIndex
      : (typeof p.metadata?.sprintIndex === 'number' ? p.metadata.sprintIndex : -1);
    if (si < 0) continue;
    const existing = sprintExtras.get(si) ?? {
      tokens: 0,
      durationMs: 0,
      verdict: p.status,
    };
    existing.tokens += p.inputTokens + p.outputTokens;
    existing.durationMs += p.durationMs;
    sprintExtras.set(si, existing);
  }

  if (rows.length === 0) {
    return (
      <p className="text-xs text-zinc-600 text-center py-6">Nenhum sprint executado ainda.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-2 font-medium">Sprint</th>
            <th className="px-4 py-2 font-medium text-right">Rounds</th>
            <th className="px-4 py-2 font-medium text-right">Coder $</th>
            <th className="px-4 py-2 font-medium text-right">Evaluator $</th>
            <th className="px-4 py-2 font-medium text-right">Total</th>
            <th className="px-4 py-2 font-medium text-right">Tokens</th>
            <th className="px-4 py-2 font-medium text-right">Duracao</th>
            <th className="px-4 py-2 font-medium text-center">Resultado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const extras = sprintExtras.get(row.sprintIndex);
            const coderRounds = sprintPhases.filter(
              (p) =>
                p.phaseNumber === 13 &&
                (p.sprintIndex >= 0 ? p.sprintIndex === row.sprintIndex
                  : (typeof p.metadata?.sprintIndex === 'number' ? p.metadata.sprintIndex === row.sprintIndex : false)),
            ).length;
            const rowBg = idx % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';

            const verdictStatus = extras?.verdict ?? '';
            const isPass =
              verdictStatus === 'done' ||
              verdictStatus === 'approved' ||
              verdictStatus === 'passed';
            const isFail =
              verdictStatus === 'failed' || verdictStatus === 'rejected';

            return (
              <tr key={row.sprintIndex} className={rowBg}>
                <td className="px-4 py-2 text-zinc-200 font-medium">
                  Sprint {row.sprintIndex + 1}
                </td>
                <td className="px-4 py-2 text-zinc-400 text-right">{coderRounds}</td>
                <td className="px-4 py-2 text-right font-mono" style={{ color: 'var(--phase-13)' }}>
                  {formatCost(row.coderCost)}
                </td>
                <td className="px-4 py-2 text-right font-mono" style={{ color: 'var(--phase-14)' }}>
                  {formatCost(row.evalCost)}
                </td>
                <td className="px-4 py-2 text-zinc-200 text-right font-mono font-medium">
                  {formatCost(row.total)}
                </td>
                <td className="px-4 py-2 text-zinc-400 text-right">
                  {formatTokens(extras?.tokens ?? 0)}
                </td>
                <td className="px-4 py-2 text-zinc-400 text-right">
                  {formatDuration(extras?.durationMs ?? 0)}
                </td>
                <td className="px-4 py-2 text-center">
                  {isPass ? (
                    <span className="flex items-center justify-center gap-1 text-green-400">
                      <CheckCircle2 size={11} />
                      <span className="text-[10px]">Passou</span>
                    </span>
                  ) : isFail ? (
                    <span className="flex items-center justify-center gap-1 text-red-400">
                      <XCircle size={11} />
                      <span className="text-[10px]">Falhou</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-600 uppercase">
                      {verdictStatus || '-'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Section 7: Cloud vs Local ----

interface CloudLocalSectionProps {
  cloudCost: number;
  localCost: number;
  phases: PipelinePhaseMetrics[];
}

function CloudLocalSection({ cloudCost, localCost, phases }: CloudLocalSectionProps) {
  const hasLocal = localCost > 0;
  if (!hasLocal) return null;

  const total = cloudCost + localCost;
  const cloudPct = pct(cloudCost, total);
  const localPct = pct(localCost, total);

  const cloudTokens = phases
    .filter((p) => p.runtime !== 'local')
    .reduce((sum, p) => sum + p.inputTokens + p.outputTokens, 0);
  const localTokens = phases
    .filter((p) => p.runtime === 'local')
    .reduce((sum, p) => sum + p.inputTokens + p.outputTokens, 0);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <h3 className="text-xs text-zinc-400 uppercase tracking-wide font-semibold flex items-center gap-2">
        <Server size={13} />
        Cloud vs Local
      </h3>

      <div className="grid grid-cols-2 gap-4">
        {/* Cloud */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Cloud size={13} className="text-blue-400" />
            <span className="text-xs text-zinc-300">Cloud</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-2 bg-blue-500 rounded transition-all duration-500"
              style={{ width: `${cloudPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-400 font-mono">{formatCost(cloudCost)}</span>
            <span className="text-zinc-600">{formatTokens(cloudTokens)} tokens</span>
          </div>
        </div>

        {/* Local */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Server size={13} className="text-green-400" />
            <span className="text-xs text-zinc-300">Local</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-2 bg-green-500 rounded transition-all duration-500"
              style={{ width: `${localPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-400 font-mono">{formatCost(localCost)}</span>
            <span className="text-zinc-600">{formatTokens(localTokens)} tokens</span>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-zinc-600">
        Economizado com modelos locais:{' '}
        <span className="text-green-400 font-medium">{formatCost(localCost)}</span>{' '}
        ({localPct.toFixed(0)}% das execucoes)
      </p>
    </div>
  );
}

// ---- Section wrapper ----

interface SectionProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function Section({ title, subtitle, children }: SectionProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800">
        <h3 className="text-xs text-zinc-400 uppercase tracking-wide font-semibold">{title}</h3>
        {subtitle && (
          <p className="text-[10px] text-zinc-600 mt-0.5">{subtitle}</p>
        )}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ---- Main component ----

interface PipelineMetricsReportProps {
  projectId: string;
  /** Optional close callback — renders an X button in the header when provided. */
  onClose?: () => void;
}

export function PipelineMetricsReport({ projectId, onClose }: PipelineMetricsReportProps) {
  const { metrics } = usePipelineStore();

  if (metrics === null) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        {onClose && (
          <div className="flex w-full justify-end mb-4">
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <Activity size={28} className="text-zinc-700 mb-3" />
        <p className="text-sm text-zinc-500">Nenhuma metrica disponivel ainda.</p>
        <p className="text-xs text-zinc-600 mt-1">
          Execute o pipeline para ver o relatorio completo.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Inject CSS variables */}
      <style>{PHASE_CSS_VARS}</style>

      <div className="space-y-6">
        {/* Header + export + close */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">Relatorio de Metricas</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Resumo completo do pipeline: custo, tokens, tempo e resultado por fase.
            </p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors shrink-0"
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Section 1: KPI Cards */}
        <KpiSection metrics={metrics} />

        {/* Section 2: Cost per phase */}
        <Section
          title="Custo por Etapa"
          subtitle="Quanto custou cada etapa do pipeline (Discovery, PRD, Spec, Planner, Coder, Evaluator, etc.)"
        >
          <PhaseBarChart phases={metrics.phases} />
        </Section>

        {/* Section 3: Agent distribution */}
        <Section
          title="Custo por Agente"
          subtitle="Quanto cada agente individual gastou (ex: sprints diferentes podem usar agentes diferentes)"
        >
          <AgentBarChart phases={metrics.phases} agentNames={metrics.agentNames ?? {}} />
        </Section>

        {/* Section 4: Sprint cost breakdown */}
        {metrics.sprintPhases.length > 0 && (
          <Section title="Custo por Sprint (Coder / Evaluator / Reviewer)">
            <SprintCostChart sprintPhases={metrics.sprintPhases} />
          </Section>
        )}

        {/* Section 5: Detailed phase table */}
        <Section title="Detalhes por Fase">
          <PhaseTable phases={metrics.phases} agentNames={metrics.agentNames ?? {}} />
        </Section>

        {/* Section 6: Detailed sprint table */}
        {metrics.sprintPhases.length > 0 && (
          <Section title="Detalhes por Sprint">
            <SprintDetailTable sprintPhases={metrics.sprintPhases} />
          </Section>
        )}

        {/* Section 7: Cloud vs Local (conditional) */}
        {metrics.localCost > 0 && (
          <CloudLocalSection
            cloudCost={metrics.cloudCost}
            localCost={metrics.localCost}
            phases={metrics.phases}
          />
        )}
      </div>
    </>
  );
}
