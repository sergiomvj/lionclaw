import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { HarnessProjectMetrics, SprintMetrics } from '@/types';
import { MetricsChart } from './MetricsChart';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}min`;
  return `${mins}min`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
}

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-zinc-500 uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold text-zinc-100">{value}</span>
      {sub !== undefined && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  );
}

interface PassRateCardProps {
  rate: number;
}

function PassRateCard({ rate }: PassRateCardProps) {
  const color =
    rate >= 70
      ? 'text-green-400'
      : rate >= 50
        ? 'text-yellow-400'
        : 'text-red-400';

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-zinc-500 uppercase tracking-wide">Pass rate</span>
      <span className={`text-2xl font-bold ${color}`}>{rate.toFixed(0)}%</span>
    </div>
  );
}

interface CoderEvaluatorSplitProps {
  coderCost: number;
  evaluatorCost: number;
}

function CoderEvaluatorSplit({ coderCost, evaluatorCost }: CoderEvaluatorSplitProps) {
  const total = coderCost + evaluatorCost;
  const coderPct = total > 0 ? (coderCost / total) * 100 : 50;
  const evaluatorPct = total > 0 ? (evaluatorCost / total) * 100 : 50;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <h3 className="text-xs text-zinc-500 uppercase tracking-wide">
        Distribuicao de custo
      </h3>

      <div className="space-y-2">
        {/* Coder bar */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-amber-400 w-20 shrink-0">Coder</span>
          <div className="flex-1 bg-zinc-800 rounded h-6 overflow-hidden">
            <div
              className="h-6 rounded bg-amber-500 transition-all duration-500"
              style={{ width: `${coderPct}%`, minWidth: coderPct > 0 ? '0.25rem' : '0' }}
            />
          </div>
          <span className="text-xs text-zinc-300 w-28 text-right shrink-0">
            {formatCost(coderCost)} ({coderPct.toFixed(0)}%)
          </span>
        </div>

        {/* Evaluator bar */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-blue-400 w-20 shrink-0">Evaluator</span>
          <div className="flex-1 bg-zinc-800 rounded h-6 overflow-hidden">
            <div
              className="h-6 rounded bg-blue-500 transition-all duration-500"
              style={{ width: `${evaluatorPct}%`, minWidth: evaluatorPct > 0 ? '0.25rem' : '0' }}
            />
          </div>
          <span className="text-xs text-zinc-300 w-28 text-right shrink-0">
            {formatCost(evaluatorCost)} ({evaluatorPct.toFixed(0)}%)
          </span>
        </div>
      </div>
    </div>
  );
}

interface SprintTableProps {
  sprints: SprintMetrics[];
}

function SprintTable({ sprints }: SprintTableProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <h3 className="text-xs text-zinc-500 uppercase tracking-wide px-4 py-3 border-b border-zinc-800">
        Detalhes por sprint
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 text-zinc-400 text-left">
              <th className="px-4 py-2 font-medium">Sprint</th>
              <th className="px-4 py-2 font-medium text-right">Rounds</th>
              <th className="px-4 py-2 font-medium text-right">Coder $</th>
              <th className="px-4 py-2 font-medium text-right">Evaluator $</th>
              <th className="px-4 py-2 font-medium text-right">Total $</th>
              <th className="px-4 py-2 font-medium text-right">Tokens In</th>
              <th className="px-4 py-2 font-medium text-right">Tokens Out</th>
              <th className="px-4 py-2 font-medium text-right">Duracao</th>
              <th className="px-4 py-2 font-medium text-center">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {sprints.map((sprint, idx) => {
              const rowBg = idx % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-800/30';
              const verdictBadge =
                sprint.verdict === 'passed'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-red-500/20 text-red-400';
              const verdictLabel = sprint.verdict === 'passed' ? 'Passou' : 'Falhou';

              return (
                <tr key={sprint.sprintId} className={rowBg}>
                  <td className="px-4 py-2 text-zinc-200 max-w-xs truncate" title={sprint.name}>
                    {sprint.name}
                  </td>
                  <td className="px-4 py-2 text-zinc-300 text-right">{sprint.rounds}</td>
                  <td className="px-4 py-2 text-amber-400 text-right">
                    {formatCost(sprint.coderCost)}
                  </td>
                  <td className="px-4 py-2 text-blue-400 text-right">
                    {formatCost(sprint.evaluatorCost)}
                  </td>
                  <td className="px-4 py-2 text-zinc-200 text-right font-medium">
                    {formatCost(sprint.totalCost)}
                  </td>
                  <td className="px-4 py-2 text-zinc-400 text-right">
                    {formatTokens(sprint.coderInputTokens + sprint.evaluatorInputTokens)}
                  </td>
                  <td className="px-4 py-2 text-zinc-400 text-right">
                    {formatTokens(sprint.coderOutputTokens + sprint.evaluatorOutputTokens)}
                  </td>
                  <td className="px-4 py-2 text-zinc-400 text-right">
                    {formatDuration(sprint.duration)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${verdictBadge}`}
                    >
                      {verdictLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {sprints.length === 0 && (
          <p className="text-center text-zinc-600 text-xs py-6">
            Nenhum sprint executado ainda.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MetricsViewProps {
  projectId: string;
}

export function MetricsView({ projectId }: MetricsViewProps) {
  const [metrics, setMetrics] = useState<HarnessProjectMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    window.lionclaw.harness
      .getMetrics(projectId)
      .then((data) => {
        if (!cancelled) {
          setMetrics(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar metricas.');
          setLoading(false);
        }
      });

    const unsub = window.lionclaw.harness.onMetricsUpdate((data) => {
      const updated = data as Record<string, unknown>;
      if (updated.projectId === projectId) {
        window.lionclaw.harness.getMetrics(projectId).then((fresh) => {
          if (!cancelled) setMetrics(fresh);
        });
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 py-8">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Carregando metricas...</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <p className="text-xs text-red-400 bg-red-900/10 border border-red-900/30 rounded px-3 py-2">
        {error}
      </p>
    );
  }

  if (metrics === null) return null;

  const chartData = metrics.sprintMetrics.map((s) => ({
    label: s.name,
    value: s.totalCost,
  }));

  const maxChartValue =
    metrics.sprintMetrics.length > 0
      ? Math.max(...metrics.sprintMetrics.map((s) => s.totalCost), 0.0001)
      : 0.0001;

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Custo total" value={formatCost(metrics.totalCost)} />
        <StatCard label="Duracao total" value={formatDuration(metrics.totalDuration)} />
        <StatCard label="Total rounds" value={String(metrics.totalRounds)} />
        <PassRateCard rate={metrics.passRate} />
        <StatCard label="Tokens total" value={formatTokens(metrics.totalTokens)} sub={`In: ${formatTokens(metrics.totalInputTokens)} / Out: ${formatTokens(metrics.totalOutputTokens)}`} />
        <StatCard label="API requests" value={String(metrics.totalApiRequests)} />
      </div>

      {/* Cost bar chart per sprint */}
      {metrics.sprintMetrics.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <h3 className="text-xs text-zinc-500 uppercase tracking-wide">
            Custo por sprint
          </h3>
          <MetricsChart
            data={chartData}
            maxValue={maxChartValue}
            formatValue={formatCost}
          />
        </div>
      )}

      {/* Coder vs Evaluator split */}
      <CoderEvaluatorSplit
        coderCost={metrics.coderCost}
        evaluatorCost={metrics.evaluatorCost}
      />

      {/* Detail table */}
      <SprintTable sprints={metrics.sprintMetrics} />
    </div>
  );
}
