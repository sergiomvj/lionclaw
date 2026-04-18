// @deprecated - migrado para pipeline-engine/pipeline-store
import type { EnrichMetrics } from '@/types';

interface Props {
  metrics: EnrichMetrics;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

interface MetricItemProps {
  label: string;
  value: string;
}

function MetricItem({ label, value }: MetricItemProps) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-zinc-500">{label}:</span>
      <span className="text-zinc-300 font-mono text-[11px]">{value}</span>
    </span>
  );
}

export function EnrichMetricsBar({ metrics }: Props) {
  const hasData =
    metrics.inputTokens > 0 ||
    metrics.outputTokens > 0 ||
    metrics.costUsd > 0 ||
    metrics.durationMs > 0;

  if (!hasData) return null;

  return (
    <div className="px-4 py-1.5 bg-zinc-900/80 border-b border-zinc-800 flex items-center gap-3 flex-wrap text-[11px]">
      <MetricItem
        label="Tokens"
        value={`${formatTokens(metrics.inputTokens)} in / ${formatTokens(metrics.outputTokens)} out`}
      />
      {metrics.cacheReadTokens > 0 && (
        <>
          <span className="text-zinc-700">|</span>
          <MetricItem label="Cache" value={`${formatTokens(metrics.cacheReadTokens)} read`} />
        </>
      )}
      <span className="text-zinc-700">|</span>
      <MetricItem label="Custo" value={formatCost(metrics.costUsd)} />
      {metrics.durationMs > 0 && (
        <>
          <span className="text-zinc-700">|</span>
          <MetricItem label="Duracao" value={formatDuration(metrics.durationMs)} />
        </>
      )}
      {metrics.toolUses > 0 && (
        <>
          <span className="text-zinc-700">|</span>
          <MetricItem label="Tools" value={String(metrics.toolUses)} />
        </>
      )}
      {metrics.apiRequests > 0 && (
        <>
          <span className="text-zinc-700">|</span>
          <MetricItem label="API" value={String(metrics.apiRequests)} />
        </>
      )}
    </div>
  );
}
