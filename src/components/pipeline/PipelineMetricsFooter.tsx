import { useState, useEffect, useRef } from 'react';
import { BarChart2 } from 'lucide-react';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import type { PipelinePhaseMetrics } from '@/types';

// ---- Formatting helpers ----

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(2)}`;
}

/**
 * Formats elapsed seconds as H:MM:SS (always includes hours digit).
 */
function formatTimer(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ---- Metric pill ----

interface MetricPillProps {
  label: string;
  value: string;
  dimmed?: boolean;
  /** When true renders the value in white bold */
  highlight?: boolean;
}

function MetricPill({ label, value, dimmed = false, highlight = false }: MetricPillProps) {
  const valueClass = highlight
    ? 'text-[10px] font-mono font-bold text-white'
    : `text-[10px] font-mono font-medium ${dimmed ? 'text-zinc-600' : 'text-zinc-400'}`;

  return (
    <div className="flex items-center gap-1">
      <span className="text-zinc-600 text-[10px] font-mono">{label}:</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

// ---- Separator ----

function Dot() {
  return <span className="text-zinc-700 text-[10px] select-none">·</span>;
}

// ---- Live streaming accumulators ----

/**
 * During active streaming, the metrics in the store may not yet reflect the
 * current token counts for the phase in progress. We read the in-flight
 * stream content length as a heuristic output token count and combine with
 * whatever the store already has for the current phase.
 */
interface LiveMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  model: string | null;
}

function resolveLiveMetrics(
  currentPhase: number | null,
  isStreaming: boolean,
  currentToolCallsLen: number,
  storedPhaseMetrics: PipelinePhaseMetrics[] | undefined,
): LiveMetrics | null {
  if (currentPhase === null) return null;

  const phaseMetric = storedPhaseMetrics?.find((m) => m.phaseNumber === currentPhase);

  if (!phaseMetric && !isStreaming) return null;

  const base: LiveMetrics = {
    inputTokens: phaseMetric?.inputTokens ?? 0,
    outputTokens: phaseMetric?.outputTokens ?? 0,
    costUsd: phaseMetric?.costUsd ?? 0,
    durationMs: phaseMetric?.durationMs ?? 0,
    toolUses: phaseMetric?.toolUses ?? 0,
    model: phaseMetric?.model ?? null,
  };

  // If currently streaming, augment tool uses with the in-flight tool calls
  if (isStreaming) {
    base.toolUses = Math.max(base.toolUses, currentToolCallsLen);
  }

  return base;
}

// ---- Main component ----

interface PipelineMetricsFooterProps {
  onExpandMetrics?: () => void;
}

export function PipelineMetricsFooter({ onExpandMetrics }: PipelineMetricsFooterProps) {
  const currentPhase = useActiveProjectState(s => s.currentPhase) ?? null;
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const currentToolCalls = useActiveProjectState(s => s.currentToolCalls) ?? [];
  const livePhaseMetrics = useActiveProjectState(s => s.phaseMetrics) ?? null;

  // ---- Live timer ----
  // Track when streaming started so we can show elapsed H:MM:SS
  const streamStartRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (isStreaming) {
      // Record start time if not already set
      if (streamStartRef.current === null) {
        streamStartRef.current = Date.now();
        setElapsedSeconds(0);
      }

      const id = setInterval(() => {
        const start = streamStartRef.current;
        if (start !== null) {
          setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
        }
      }, 1000);

      return () => clearInterval(id);
    } else {
      // Reset when streaming stops
      streamStartRef.current = null;
      setElapsedSeconds(0);
      return undefined;
    }
  }, [isStreaming]);

  // Also reset timer when the phase changes
  useEffect(() => {
    streamStartRef.current = null;
    setElapsedSeconds(0);
  }, [currentPhase]);

  // ---- Resolve metrics to display ----

  // Merge stored phase metrics with live stream data
  const storedPhaseMetrics = metrics?.phases;

  // Build a merged metrics source: prefer live phaseMetrics from store when streaming
  const mergedStoredMetrics: PipelinePhaseMetrics[] | undefined = (() => {
    if (livePhaseMetrics !== null && currentPhase !== null) {
      // Create a synthetic entry for the current phase using live data
      const synthetic: PipelinePhaseMetrics = {
        id: -1,
        projectId: '',
        phaseNumber: currentPhase,
        phaseName: '',
        agentId: null,
        status: 'running',
        inputTokens: livePhaseMetrics.inputTokens,
        outputTokens: livePhaseMetrics.outputTokens,
        cacheReadTokens: livePhaseMetrics.cacheReadTokens,
        cacheCreationTokens: livePhaseMetrics.cacheCreationTokens,
        costUsd: livePhaseMetrics.costUsd,
        durationMs: 0,
        toolUses: 0,
        apiRequests: 0,
        model: null,
        runtime: null,
        startedAt: null,
        completedAt: null,
        metadata: {},
        createdAt: '',
      };
      // Merge: replace or prepend the current phase entry
      const without = (storedPhaseMetrics ?? []).filter((m) => m.phaseNumber !== currentPhase);
      return [synthetic, ...without];
    }
    return storedPhaseMetrics;
  })();

  const liveMetrics = resolveLiveMetrics(
    currentPhase,
    isStreaming,
    currentToolCalls.length,
    mergedStoredMetrics,
  );

  if (liveMetrics === null && currentPhase === null) {
    return (
      <div className="flex items-center justify-center border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
        <span className="text-[10px] text-zinc-700 font-mono">aguardando inicio...</span>
      </div>
    );
  }

  const inputStr = liveMetrics ? formatTokens(liveMetrics.inputTokens) : '-';
  const outputStr = liveMetrics ? formatTokens(liveMetrics.outputTokens) : '-';
  const costStr = liveMetrics ? formatCost(liveMetrics.costUsd) : '-';
  const modelStr = liveMetrics?.model ?? '-';
  const toolStr = liveMetrics ? String(liveMetrics.toolUses) : '-';
  const timerStr = isStreaming ? formatTimer(elapsedSeconds) : '-';
  const totalCostStr = metrics !== null ? formatCost(metrics.totals.costUsd) : null;

  const dimmed = !liveMetrics || (
    liveMetrics.inputTokens === 0 &&
    liveMetrics.outputTokens === 0 &&
    liveMetrics.costUsd === 0
  );

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-1.5 bg-zinc-950/60 shrink-0">
      {/* Streaming pulse */}
      {isStreaming && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
        </span>
      )}

      {/* Live timer (only shown while streaming) */}
      {isStreaming && (
        <>
          <MetricPill label="tempo" value={timerStr} />
          <Dot />
        </>
      )}

      <MetricPill label="in" value={inputStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="out" value={outputStr} dimmed={dimmed} />
      <Dot />
      <MetricPill label="custo" value={costStr} dimmed={dimmed} highlight={!dimmed} />
      <Dot />
      <MetricPill label="tools" value={toolStr} dimmed={dimmed} />

      {/* Model name */}
      {modelStr !== '-' && (
        <>
          <Dot />
          <MetricPill label="modelo" value={modelStr} dimmed={false} />
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Total cost */}
      {totalCostStr !== null && (
        <>
          <span className="text-zinc-700 text-[10px] font-mono">total:</span>
          <span className="text-white font-bold text-[10px] font-mono">{totalCostStr}</span>
        </>
      )}

      {/* Expand metrics report button */}
      {onExpandMetrics !== undefined && (
        <button
          onClick={onExpandMetrics}
          className="ml-2 flex items-center justify-center w-5 h-5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          title="Ver relatorio completo de metricas"
        >
          <BarChart2 size={12} />
        </button>
      )}
    </div>
  );
}
