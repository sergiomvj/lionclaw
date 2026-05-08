import { useState, useEffect, useRef, useCallback } from 'react';
import {
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
  Wrench,
  RotateCcw,
  Clock,
  ChevronRight,
  ChevronDown,
  DollarSign,
  Cpu,
  BarChart2,
} from 'lucide-react';
import type { SprintJsonDetail } from '@/types';
import type { PipelineSprintMessage } from '@/types/pipeline';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { SprintStatus } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { AgentThinking } from '@/components/chat/AgentThinking';
import { shortenModel } from '@/utils/model-display';

// ---- Constants ----

// Phases used in the live pipeline loop (currentPhase values during sprint execution).
// Sets accept both development (13/14) and security (10/11) pipeline numbers so the
// same component works for either pipeline type.
const LOOP_CODER_PHASES = new Set([13, 10]);
const LOOP_EVALUATOR_PHASES = new Set([14, 11]);
function isCoderPhase(phase: number | null): boolean {
  return phase !== null && LOOP_CODER_PHASES.has(phase);
}
function isEvaluatorPhase(phase: number | null): boolean {
  return phase !== null && LOOP_EVALUATOR_PHASES.has(phase);
}

// ---- Formatting helpers ----

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}min`;
  if (seconds === 0) return `${minutes}min`;
  return `${minutes}min${seconds.toString().padStart(2, '0')}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---- Agent color helpers ----

function getCoderColor(): string {
  return 'text-amber-400';
}

function getEvaluatorColor(): string {
  return 'text-blue-400';
}

function getCoderBg(): string {
  return 'bg-amber-500/10 border-amber-500/20';
}

function getEvaluatorBg(): string {
  return 'bg-blue-500/10 border-blue-500/20';
}

// ---- Round data structure for persisted history ----

interface PersistedRoundData {
  roundIndex: number;
  coderContent: string;
  coderToolCalls: Array<{ tool: string; input: unknown }>;
  evaluatorContent: string;
  evaluatorToolCalls: Array<{ tool: string; input: unknown }>;
}

function buildRoundsFromHistory(messages: PipelineSprintMessage[]): PersistedRoundData[] {
  const roundMap = new Map<number, PersistedRoundData>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const ri = msg.roundIndex ?? 0;

    if (!roundMap.has(ri)) {
      roundMap.set(ri, {
        roundIndex: ri,
        coderContent: '',
        coderToolCalls: [],
        evaluatorContent: '',
        evaluatorToolCalls: [],
      });
    }

    const entry = roundMap.get(ri)!;
    const toolCalls = (msg.toolCalls ?? []) as Array<{ tool: string; input: unknown }>;

    if (isCoderPhase(msg.phaseNumber)) {
      entry.coderContent = msg.content;
      entry.coderToolCalls = toolCalls;
    } else if (isEvaluatorPhase(msg.phaseNumber)) {
      entry.evaluatorContent = msg.content;
      entry.evaluatorToolCalls = toolCalls;
    }
  }

  return Array.from(roundMap.values()).sort((a, b) => a.roundIndex - b.roundIndex);
}

// ---- Tool call display ----

interface ToolCallRowProps {
  tool: string;
  input: unknown;
  isLast: boolean;
  isStreaming: boolean;
}

function ToolCallRow({ tool, input, isLast, isStreaming }: ToolCallRowProps) {
  let label = '';
  if (input !== null && input !== undefined) {
    if (typeof input === 'string') {
      label = input.slice(0, 60);
    } else {
      try {
        const s = JSON.stringify(input);
        label = s.slice(0, 60) + (s.length > 60 ? '...' : '');
      } catch {
        label = '';
      }
    }
  }

  return (
    <div className="flex items-center gap-1.5 py-0.5">
      {isStreaming && isLast ? (
        <Loader2 size={10} className="text-amber-400 animate-spin shrink-0" />
      ) : (
        <CheckCircle2 size={10} className="text-green-500 shrink-0" />
      )}
      <Wrench size={10} className="text-amber-500 shrink-0" />
      <span className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0.5 rounded font-mono">
        {tool}
      </span>
      {label && (
        <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[160px]">
          {label}
        </span>
      )}
    </div>
  );
}

// ---- Persisted round panel (renders content from DB history) ----

interface PersistedRoundPanelProps {
  round: PersistedRoundData;
  roundNumber: number;
  totalRounds: number;
  sprintVerdict: string;
  isLastRound: boolean;
}

function PersistedRoundPanel({
  round,
  roundNumber,
  totalRounds,
  sprintVerdict,
  isLastRound,
}: PersistedRoundPanelProps) {
  const [coderExpanded, setCoderExpanded] = useState(true);
  const [evaluatorExpanded, setEvaluatorExpanded] = useState(true);

  // Determine round verdict: last round gets sprint verdict, earlier rounds were rejected
  const roundVerdict = isLastRound ? sprintVerdict : 'rejected';
  const isPass =
    roundVerdict === 'pass' || roundVerdict === 'passed' || roundVerdict === 'accepted';
  const isFail =
    roundVerdict === 'fail' || roundVerdict === 'failed' || roundVerdict === 'rejected';

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      {/* Round header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/80 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-zinc-400">
            Round {roundNumber}/{totalRounds}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isPass && (
            <span className="flex items-center gap-1 text-[10px] font-semibold bg-green-500/15 text-green-400 border border-green-500/30 px-2 py-0.5 rounded">
              <CheckCircle2 size={9} />
              Aprovado
            </span>
          )}
          {isFail && (
            <span className="flex items-center gap-1 text-[10px] font-semibold bg-red-500/15 text-red-400 border border-red-500/30 px-2 py-0.5 rounded">
              <XCircle size={9} />
              Rejeitado
            </span>
          )}
        </div>
      </div>

      {/* Coder section */}
      {round.coderContent !== '' && (
        <div className={`border-b border-zinc-800 ${getCoderBg()}`}>
          <button
            onClick={() => setCoderExpanded(!coderExpanded)}
            className="w-full flex items-center justify-between px-4 py-2 text-left"
          >
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${getCoderColor()}`}>
              Coder
            </span>
            <ChevronDown
              size={13}
              className={`text-zinc-500 transition-transform ${coderExpanded ? 'rotate-180' : ''}`}
            />
          </button>
          {coderExpanded && (
            <div className="px-4 pb-3 space-y-2">
              {round.coderToolCalls.length > 0 && (
                <div className="space-y-0.5">
                  {round.coderToolCalls.map((tc, i) => (
                    <ToolCallRow
                      key={i}
                      tool={tc.tool}
                      input={tc.input}
                      isLast={false}
                      isStreaming={false}
                    />
                  ))}
                </div>
              )}
              <div className="text-xs text-zinc-300 leading-relaxed chat-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{round.coderContent}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Evaluator section */}
      {round.evaluatorContent !== '' && (
        <div className={getEvaluatorBg()}>
          <button
            onClick={() => setEvaluatorExpanded(!evaluatorExpanded)}
            className="w-full flex items-center justify-between px-4 py-2 text-left"
          >
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${getEvaluatorColor()}`}>
              Evaluator
            </span>
            <ChevronDown
              size={13}
              className={`text-zinc-500 transition-transform ${evaluatorExpanded ? 'rotate-180' : ''}`}
            />
          </button>
          {evaluatorExpanded && (
            <div className="px-4 pb-3 space-y-2">
              {round.evaluatorToolCalls.length > 0 && (
                <div className="space-y-0.5">
                  {round.evaluatorToolCalls.map((tc, i) => (
                    <ToolCallRow
                      key={i}
                      tool={tc.tool}
                      input={tc.input}
                      isLast={false}
                      isStreaming={false}
                    />
                  ))}
                </div>
              )}
              <div className="text-xs text-zinc-300 leading-relaxed chat-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{round.evaluatorContent}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Live stream panel (shown for the currently active phase) ----

interface LiveStreamPanelProps {
  phase: number;
  stream?: Array<{ type: string; content?: string; tool?: string }>;
}

function LiveStreamPanel({ phase, stream }: LiveStreamPanelProps) {
  const streamContent = useActiveProjectState(s => s.streamContent) ?? '';
  const currentToolCalls = useActiveProjectState(s => s.currentToolCalls) ?? [];
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const bottomRef = useRef<HTMLDivElement>(null);

  // If a dedicated stream array is provided (split-view), use it
  const useSplitView = stream !== undefined;

  const agentLabel = isCoderPhase(phase) ? 'Coder' : isEvaluatorPhase(phase) ? 'Evaluator' : `Fase ${phase}`;
  const agentColor = isCoderPhase(phase) ? getCoderColor() : getEvaluatorColor();
  const agentBg = isCoderPhase(phase) ? getCoderBg() : getEvaluatorBg();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream, streamContent, currentToolCalls]);

  if (useSplitView) {
    const hasContent = stream.length > 0;

    // Build text from stream entries
    const textContent = stream
      .filter(e => e.type === 'text' && e.content)
      .map(e => e.content)
      .join('');
    const toolEntries = stream.filter(e => e.type === 'tool_use' || e.type === 'tool_call');

    return (
      <div className={`rounded-xl border p-4 ${agentBg}`}>
        <div className="flex items-center gap-2 mb-3">
          <span className={`text-[11px] font-semibold uppercase tracking-wide ${agentColor}`}>
            {agentLabel}
          </span>
          {isStreaming && (
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              <span className="text-[10px] text-amber-400">Transmitindo...</span>
            </div>
          )}
        </div>
        {toolEntries.length > 0 && (
          <div className="mb-2 space-y-0.5">
            {toolEntries.map((tc, i) => (
              <ToolCallRow
                key={i}
                tool={tc.tool ?? 'tool'}
                input={null}
                isLast={i === toolEntries.length - 1}
                isStreaming={isStreaming}
              />
            ))}
          </div>
        )}
        {hasContent ? (
          <div className="text-xs text-zinc-300 leading-relaxed max-h-64 overflow-y-auto chat-markdown">
            {textContent ? (
              <>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{textContent}</ReactMarkdown>
                {isStreaming && <span className="sprint-exec-cursor" />}
              </>
            ) : (
              isStreaming && <AgentThinking />
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-600 italic">
            {isStreaming ? 'Aguardando saida do agente...' : 'Nenhum conteudo ainda.'}
          </p>
        )}
        <div ref={bottomRef} />
      </div>
    );
  }

  // Original behavior for non-split phases
  const hasContent = streamContent !== '' || currentToolCalls.length > 0;

  return (
    <div className={`rounded-xl border p-4 ${agentBg}`}>
      {/* Agent header */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${agentColor}`}>
          {agentLabel}
        </span>
        {isStreaming && (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            <span className="text-[10px] text-amber-400">Transmitindo...</span>
          </div>
        )}
      </div>

      {/* Tool calls */}
      {currentToolCalls.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {currentToolCalls.map((tc, i) => (
            <ToolCallRow
              key={i}
              tool={tc.tool}
              input={tc.input}
              isLast={i === currentToolCalls.length - 1}
              isStreaming={isStreaming}
            />
          ))}
        </div>
      )}

      {/* Stream content */}
      {hasContent ? (
        <div className="text-xs text-zinc-300 leading-relaxed max-h-64 overflow-y-auto chat-markdown">
          {streamContent ? (
            <>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamContent}</ReactMarkdown>
              {isStreaming && <span className="sprint-exec-cursor" />}
            </>
          ) : (
            isStreaming && <AgentThinking />
          )}
        </div>
      ) : (
        <p className="text-xs text-zinc-600 italic">
          {isStreaming ? 'Aguardando saida do agente...' : 'Nenhum conteudo ainda.'}
        </p>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

// ---- Round badge ----

interface RoundBadgeProps {
  roundNumber: number;
  totalRounds: number;
  isCurrent: boolean;
  phase: number;
}

function RoundBadge({ roundNumber, totalRounds, isCurrent, phase }: RoundBadgeProps) {
  const agentLabel = isCoderPhase(phase) ? 'Coder' : isEvaluatorPhase(phase) ? 'Evaluator' : `Fase ${phase}`;
  const agentColor = isCoderPhase(phase) ? getCoderColor() : getEvaluatorColor();

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] ${
        isCurrent
          ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
          : 'bg-zinc-800/60 border border-zinc-700/60 text-zinc-500'
      }`}
    >
      <span className={`font-semibold ${isCurrent ? 'text-amber-300' : agentColor}`}>
        {agentLabel}
      </span>
      <ChevronRight size={10} className="text-zinc-600" />
      <span className={isCurrent ? 'text-zinc-300' : 'text-zinc-600'}>
        Round {roundNumber}/{totalRounds}
      </span>
      {isCurrent && <Loader2 size={10} className="text-amber-400 animate-spin" />}
    </div>
  );
}

// ---- Sprint verdict badge ----

interface VerdictBadgeProps {
  verdict: string;
}

function VerdictBadge({ verdict }: VerdictBadgeProps) {
  const isPass = verdict === 'pass' || verdict === 'passed' || verdict === 'accepted';
  const isFail = verdict === 'fail' || verdict === 'failed' || verdict === 'rejected';
  const isRunning = verdict === 'running' || verdict === '' || verdict === 'pending';

  if (isRunning) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded">
        <Loader2 size={9} className="animate-spin" />
        Executando
      </span>
    );
  }

  if (isPass) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold bg-green-500/15 text-green-400 border border-green-500/30 px-2 py-0.5 rounded">
        <CheckCircle2 size={9} />
        Aprovado
      </span>
    );
  }

  if (isFail) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold bg-red-500/15 text-red-400 border border-red-500/30 px-2 py-0.5 rounded">
        <XCircle size={9} />
        Rejeitado
      </span>
    );
  }

  return (
    <span className="text-[10px] font-semibold text-zinc-400 bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded uppercase">
      {verdict}
    </span>
  );
}

// ---- Round status bar (circles at bottom of sprint) ----

interface RoundStatusBarProps {
  rounds: number;
  maxRounds: number;
  verdict: string;
  isActive: boolean;
  isStreaming: boolean;
  currentPhase: number | null;
}

function RoundStatusBar({ rounds, maxRounds, verdict, isActive, isStreaming: _isStreaming, currentPhase }: RoundStatusBarProps) {
  if (rounds === 0 && !isActive) return null;

  const isPass = verdict === 'pass' || verdict === 'passed' || verdict === 'accepted';
  const isFail = verdict === 'fail' || verdict === 'failed' || verdict === 'rejected';

  // Build the circle list: completed rounds + current active (if any) + remaining
  const totalSlots = Math.max(maxRounds, rounds + (isActive ? 1 : 0));

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {Array.from({ length: totalSlots }, (_, idx) => {
        const roundNum = idx + 1; // 1-indexed
        const isCompleted = roundNum <= rounds;
        const isCurrent = isActive && roundNum === rounds + 1 && (isCoderPhase(currentPhase) || isEvaluatorPhase(currentPhase));
        const isPending = !isCompleted && !isCurrent;

        let circleClass = '';
        let icon: React.ReactNode = <span className="text-[8px] font-bold">{roundNum}</span>;

        if (isCurrent) {
          circleClass = 'bg-amber-500/20 border-amber-500/40 text-amber-300';
          icon = <Loader2 size={8} className="animate-spin" />;
        } else if (isCompleted) {
          const roundIsLast = roundNum === rounds;
          if (roundIsLast && isPass) {
            circleClass = 'bg-green-500/20 border-green-500/40 text-green-400';
            icon = <CheckCircle2 size={8} />;
          } else if (roundIsLast && isFail) {
            circleClass = 'bg-red-500/20 border-red-500/40 text-red-400';
            icon = <XCircle size={8} />;
          } else {
            // Intermediate rounds that failed (coder needed to retry)
            circleClass = 'bg-zinc-700 border-zinc-600 text-zinc-400';
            icon = <span className="text-[8px] font-bold">{roundNum}</span>;
          }
        } else if (isPending) {
          circleClass = 'bg-zinc-800/50 border-zinc-700/50 text-zinc-600';
        }

        return (
          <div key={idx} className="flex items-center gap-0.5">
            <div
              className={`w-5 h-5 rounded-full flex items-center justify-center border ${circleClass}`}
            >
              {icon}
            </div>
            {idx < totalSlots - 1 && (
              <div className={`w-2.5 h-px ${isCompleted ? 'bg-zinc-600' : 'bg-zinc-800'}`} />
            )}
          </div>
        );
      })}
      <span className="text-[10px] text-zinc-600 ml-1">
        {rounds}/{maxRounds} rounds
      </span>
    </div>
  );
}

// ---- Inner sub-tabs: Coder / Evaluator / Metricas ----

type SprintInnerTab = 'coder' | 'evaluator' | 'metricas';

interface SprintMetricsTabProps {
  sprint: SprintStatus;
  maxRounds: number;
  currentPhase: number | null;
  isActive: boolean;
  isStreaming: boolean;
}

function SprintMetricsTab({ sprint, maxRounds, currentPhase, isActive, isStreaming }: SprintMetricsTabProps) {
  const phaseMetrics = useActiveProjectState(s => s.phaseMetrics) ?? null;

  const raw = sprint.metrics as { coder?: Record<string, number>; evaluator?: Record<string, number> } | undefined;
  const coder = raw?.coder;
  const evaluator = raw?.evaluator;

  const inputTokens = (coder?.inputTokens ?? 0) + (evaluator?.inputTokens ?? 0);
  const outputTokens = (coder?.outputTokens ?? 0) + (evaluator?.outputTokens ?? 0);
  const costUsd = (coder?.costUsd ?? 0) + (evaluator?.costUsd ?? 0);
  const durationMs = (coder?.durationMs ?? 0) + (evaluator?.durationMs ?? 0);
  const coderCost = coder?.costUsd ?? 0;
  const evaluatorCost = evaluator?.costUsd ?? 0;
  const rounds = sprint.rounds ?? 0;

  // If active, show live phase metrics as well
  const liveTokensIn = phaseMetrics?.inputTokens ?? 0;
  const liveTokensOut = phaseMetrics?.outputTokens ?? 0;
  const liveCost = phaseMetrics?.costUsd ?? 0;

  const totalInputDisplay = isActive && liveTokensIn > 0 ? liveTokensIn : inputTokens;
  const totalOutputDisplay = isActive && liveTokensOut > 0 ? liveTokensOut : outputTokens;
  const totalCostDisplay = isActive && liveCost > 0 ? liveCost : costUsd;

  const isPass = sprint.verdict === 'pass' || sprint.verdict === 'passed' || sprint.verdict === 'accepted';
  const isFail = sprint.verdict === 'fail' || sprint.verdict === 'failed' || sprint.verdict === 'rejected';

  return (
    <div className="space-y-4">
      {/* Token and cost cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wide font-medium">
            <Cpu size={11} />
            Tokens
          </div>
          <div className="space-y-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Input</span>
              <span className="text-zinc-300 font-mono">{formatTokens(totalInputDisplay)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Output</span>
              <span className="text-zinc-300 font-mono">{formatTokens(totalOutputDisplay)}</span>
            </div>
          </div>
          {isActive && liveTokensIn > 0 && (
            <p className="text-[10px] text-amber-400">ao vivo</p>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wide font-medium">
            <DollarSign size={11} />
            Custo
          </div>
          <p className="text-lg font-bold text-zinc-100 font-mono leading-none">
            {formatCost(totalCostDisplay)}
          </p>
          {durationMs > 0 && (
            <p className="text-[10px] text-zinc-500 flex items-center gap-1">
              <Clock size={9} />
              {formatDuration(durationMs)}
            </p>
          )}
        </div>
      </div>

      {/* Per-agent cost */}
      {(coderCost > 0 || evaluatorCost > 0) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-medium flex items-center gap-1.5">
            <BarChart2 size={11} />
            Custo por agente
          </p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-amber-400 w-20 shrink-0">Coder</span>
              <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                <div
                  className="h-3 bg-amber-500/70 rounded"
                  style={{ width: `${costUsd > 0 ? (coderCost / costUsd) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[11px] text-zinc-400 font-mono w-14 text-right">
                {formatCost(coderCost)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-blue-400 w-20 shrink-0">Evaluator</span>
              <div className="flex-1 h-3 bg-zinc-800 rounded overflow-hidden">
                <div
                  className="h-3 bg-blue-500/70 rounded"
                  style={{ width: `${costUsd > 0 ? (evaluatorCost / costUsd) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[11px] text-zinc-400 font-mono w-14 text-right">
                {formatCost(evaluatorCost)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Rounds used + verdicts */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-medium">
          Rounds {rounds}/{maxRounds}
        </p>
        <RoundStatusBar
          rounds={rounds}
          maxRounds={maxRounds}
          verdict={sprint.verdict}
          isActive={isActive}
          isStreaming={isStreaming}
          currentPhase={currentPhase}
        />
        {(isPass || isFail) && (
          <div className="pt-1">
            <VerdictBadge verdict={sprint.verdict} />
          </div>
        )}
      </div>

      {/* Verdicts per round */}
      {rounds > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide font-medium">
            Resultado por round
          </p>
          <div className="space-y-1">
            {Array.from({ length: rounds }, (_, idx) => {
              const roundNum = idx + 1;
              const isLastRound = roundNum === rounds;
              const roundVerdict = isLastRound
                ? sprint.verdict
                : 'fail'; // Intermediate rounds were failures (coder had to retry)
              const roundIsPass =
                roundVerdict === 'pass' || roundVerdict === 'passed' || roundVerdict === 'accepted';
              const roundIsFail =
                roundVerdict === 'fail' || roundVerdict === 'failed' || roundVerdict === 'rejected';

              return (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  <span className="text-zinc-500 w-16 shrink-0">Round {roundNum}</span>
                  {roundIsPass ? (
                    <span className="flex items-center gap-1 text-green-400">
                      <CheckCircle2 size={10} />
                      Aprovado
                    </span>
                  ) : roundIsFail ? (
                    <span className="flex items-center gap-1 text-red-400">
                      <XCircle size={10} />
                      Reprovado
                    </span>
                  ) : (
                    <span className="text-zinc-500">{roundVerdict || 'Pendente'}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Verdict overlay ----

type VerdictOverlayType = 'pass' | 'fail_with_rounds' | 'fail_max_rounds' | 'sprint_transition' | null;

interface VerdictOverlayProps {
  type: VerdictOverlayType;
  sprintIndex: number;
  totalSprints: number;
  currentRound: number;
  maxRounds: number;
  nextSprintName?: string;
  onAbort: () => void;
}

function VerdictOverlay({
  type,
  sprintIndex,
  totalSprints,
  currentRound,
  maxRounds,
  nextSprintName,
  onAbort,
}: VerdictOverlayProps) {
  if (type === null) return null;

  if (type === 'pass') {
    return (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl z-20"
           style={{ background: 'rgba(0,0,0,0.75)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-green-500/20 border border-green-500/40 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-green-400" />
          </div>
          <span className="text-xl font-bold text-green-400 tracking-widest">APROVADO</span>
          {sprintIndex + 1 < totalSprints && (
            <span className="text-xs text-zinc-400">
              Avancando para Sprint {sprintIndex + 2}...
            </span>
          )}
        </div>
      </div>
    );
  }

  if (type === 'sprint_transition') {
    return (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl z-20"
           style={{ background: 'rgba(0,0,0,0.75)' }}>
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <div className="w-14 h-14 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-amber-400" />
          </div>
          <p className="text-sm font-semibold text-amber-300">
            Sprint {sprintIndex + 1} concluido.
          </p>
          {nextSprintName ? (
            <p className="text-xs text-zinc-400">
              Iniciando Sprint {sprintIndex + 2}: {nextSprintName}...
            </p>
          ) : (
            <p className="text-xs text-zinc-400">Iniciando Sprint {sprintIndex + 2}...</p>
          )}
          <Loader2 size={16} className="text-amber-400 animate-spin mt-1" />
        </div>
      </div>
    );
  }

  if (type === 'fail_with_rounds') {
    return (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl z-20"
           style={{ background: 'rgba(0,0,0,0.75)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
            <XCircle size={28} className="text-red-400" />
          </div>
          <span className="text-lg font-bold text-red-400 tracking-wide">REPROVADO</span>
          <span className="text-xs text-zinc-400">
            Round {currentRound} de {maxRounds}
          </span>
          <span className="text-[11px] text-zinc-500 mt-1">
            Iniciando proximo round...
          </span>
        </div>
      </div>
    );
  }

  if (type === 'fail_max_rounds') {
    return (
      <div className="absolute inset-0 flex items-center justify-center rounded-xl z-20"
           style={{ background: 'rgba(0,0,0,0.82)' }}>
        <div className="flex flex-col items-center gap-4 text-center px-6 max-w-xs">
          <div className="w-14 h-14 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
            <XCircle size={28} className="text-red-400" />
          </div>
          <div>
            <p className="text-lg font-bold text-red-400">REPROVADO</p>
            <p className="text-xs text-zinc-400 mt-1">
              Limite de {maxRounds} rounds atingido para o Sprint {sprintIndex + 1}.
            </p>
          </div>
          <div className="flex gap-2 w-full justify-center">
            <button
              onClick={onAbort}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg transition-colors"
            >
              <XCircle size={12} />
              Abortar pipeline
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ---- Completed sprint summary card ----

interface SprintSummaryCardProps {
  sprint: SprintStatus;
}

function SprintSummaryCard({ sprint }: SprintSummaryCardProps) {
  const rounds = sprint.rounds ?? 0;
  const metrics = sprint.metrics as Record<string, number> | undefined;
  const costUsd = metrics?.costUsd ?? 0;
  const durationMs = metrics?.durationMs ?? 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-200">{sprint.name}</span>
        </div>
        <VerdictBadge verdict={sprint.verdict} />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <RotateCcw size={10} />
          {rounds} {rounds === 1 ? 'round' : 'rounds'}
        </span>
        {costUsd > 0 && (
          <span>{formatCost(costUsd)}</span>
        )}
        {durationMs > 0 && (
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {formatDuration(durationMs)}
          </span>
        )}
      </div>

      {/* Round progression visual */}
      {rounds > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {Array.from({ length: rounds }).map((_, idx) => {
            const isLast = idx === rounds - 1;
            const isPass = isLast && (sprint.verdict === 'pass' || sprint.verdict === 'passed' || sprint.verdict === 'accepted');
            return (
              <div key={idx} className="flex items-center gap-1">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                    isPass
                      ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : isLast
                      ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                      : 'bg-zinc-700 text-zinc-400 border border-zinc-600'
                  }`}
                >
                  {idx + 1}
                </div>
                {idx < rounds - 1 && (
                  <div className="w-3 h-px bg-zinc-700" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Empty state for sprint tab ----

function SprintEmptyState({ sprintIndex }: { sprintIndex: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center mb-3">
        <RotateCcw size={18} className="text-zinc-600" />
      </div>
      <p className="text-xs text-zinc-600">Sprint {sprintIndex + 1} ainda nao iniciou.</p>
    </div>
  );
}

// ---- Sprint definition collapsible panel (UI-04) ----

interface SprintDefinitionProps {
  projectId: string;
  sprintJsonId: string;
}

function SprintDefinition({ projectId, sprintJsonId }: SprintDefinitionProps) {
  const [detail, setDetail] = useState<SprintJsonDetail | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.lionclaw.harness.getSprintJson(projectId, sprintJsonId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, sprintJsonId]);

  if (loading) {
    return (
      <div className="border border-zinc-800 rounded-lg px-4 py-2">
        <p className="text-xs text-zinc-500">Carregando definicao...</p>
      </div>
    );
  }
  if (!detail) return null;

  const complexityColors: Record<string, string> = {
    low: 'text-green-400',
    medium: 'text-amber-400',
    high: 'text-red-400',
  };

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-800/50 transition-colors"
      >
        <span className="font-medium">Definicao da Sprint</span>
        <ChevronDown
          size={14}
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-zinc-800">
          <p className="text-sm text-zinc-400 mt-2">{detail.description}</p>

          <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
            <span>
              Coder: <span className="text-zinc-300">{detail.coder_agent_id}</span>
            </span>
            <span>
              Complexidade:{' '}
              <span className={complexityColors[detail.complexity] ?? 'text-zinc-300'}>
                {detail.complexity}
              </span>
            </span>
            <span>Rounds: {detail.estimated_rounds}</span>
            {detail.stack.length > 0 && (
              <span>Stack: {detail.stack.join(', ')}</span>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-zinc-300">
              Features ({detail.features.length})
            </h4>
            {detail.features.map((f) => (
              <div
                key={f.id}
                className="bg-zinc-950 border border-zinc-800 rounded p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-zinc-500">{f.id}</span>
                  <span className="text-sm text-zinc-200">{f.name}</span>
                </div>
                <p className="text-xs text-zinc-400 mt-1">{f.description}</p>
                <ul className="mt-1 space-y-0.5">
                  {f.acceptance_criteria.map((c, i) => (
                    <li key={i} className="text-xs text-zinc-500 flex gap-1">
                      <span className="text-zinc-600">-</span> {c}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Sprint tab content (with inner tabs: Coder / Evaluator / Metricas) ----

interface SprintTabContentProps {
  sprintIndex: number;
  sprint: SprintStatus | null;
  isActive: boolean;
  currentPhase: number | null;
  totalRounds: number;
  totalSprints: number;
  projectId: string;
}

function SprintTabContent({
  sprintIndex,
  sprint,
  isActive,
  currentPhase,
  totalRounds,
  totalSprints,
  projectId,
}: SprintTabContentProps) {
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const coderStream = useActiveProjectState(s => s.coderStream) ?? [];
  const evaluatorStream = useActiveProjectState(s => s.evaluatorStream) ?? [];
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const abortPipeline = usePipelineStore(s => s.abortPipeline);

  // Resolve model badges from phase metrics for this sprint.
  // So mostra badge se a fase completou nessa execucao — caso contrario o badge
  // mostraria dados de uma execucao anterior (ex: sonnet em rodada que falhou,
  // depois usuario mudou pra codex e re-rodou; sem esse guard o badge mostraria
  // 'sonnet' mesmo com codex em execucao).
  const coderPhaseMetric = metrics?.phases.find(
    (p) => (p.phaseNumber === 13 || p.phaseNumber === 10) && p.sprintIndex === sprintIndex,
  );
  const evaluatorPhaseMetric = metrics?.phases.find(
    (p) => (p.phaseNumber === 14 || p.phaseNumber === 11) && p.sprintIndex === sprintIndex,
  );
  const coderModel = coderPhaseMetric?.status === 'completed' ? coderPhaseMetric.model ?? null : null;
  const evaluatorModel = evaluatorPhaseMetric?.status === 'completed' ? evaluatorPhaseMetric.model ?? null : null;
  const loadSprintHistory = usePipelineStore(s => s.loadSprintHistory);
  const sprintHistoryCache = usePipelineStore(s => s.sprintHistoryCache);
  const isLoopPhase = isCoderPhase(currentPhase) || isEvaluatorPhase(currentPhase);
  const sprintRunning = isActive && isLoopPhase;

  // Inner tab state: default to 'coder' for running, else available based on phase
  const [innerTab, setInnerTab] = useState<SprintInnerTab>('coder');

  // When phase changes, switch inner tab
  useEffect(() => {
    if (isCoderPhase(currentPhase)) setInnerTab('coder');
    else if (isEvaluatorPhase(currentPhase)) setInnerTab('evaluator');
  }, [currentPhase]);

  // ---- Load sprint history from DB on mount / sprintIndex change ----
  useEffect(() => {
    if (projectId && sprintIndex !== null && sprintIndex !== undefined) {
      void loadSprintHistory(projectId, sprintIndex);
    }
  }, [projectId, sprintIndex, loadSprintHistory]);

  // ---- After each agent turn completes ('done' stream event), refresh history from DB ----
  // We track the done event by watching coderStream/evaluatorStream length changes when not streaming
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;

    // When streaming transitions false -> false is a no-op; we act when it goes true -> false
    if (wasStreaming && !isStreaming) {
      // Force-invalidate the cache entry for this sprint so loadSprintHistory re-fetches
      usePipelineStore.setState((state) => ({
        sprintHistoryCache: {
          ...state.sprintHistoryCache,
          [projectId]: {
            ...(state.sprintHistoryCache[projectId] ?? {}),
            [sprintIndex]: undefined,
          },
        },
      }));
      void loadSprintHistory(projectId, sprintIndex);
    }
  }, [isStreaming, projectId, sprintIndex, loadSprintHistory]);

  // ---- Build persisted round list from cache ----
  const rawHistory = sprintHistoryCache[projectId]?.[sprintIndex];
  const persistedRounds: PersistedRoundData[] = rawHistory
    ? buildRoundsFromHistory(rawHistory as PipelineSprintMessage[])
    : [];

  // ---- Verdict overlay logic ----
  const [overlayType, setOverlayType] = useState<VerdictOverlayType>(null);
  const [overlayTimeoutRef] = useState<{ id: ReturnType<typeof setTimeout> | null }>({ id: null });

  const clearOverlayTimeout = useCallback(() => {
    if (overlayTimeoutRef.id !== null) {
      clearTimeout(overlayTimeoutRef.id);
      overlayTimeoutRef.id = null;
    }
  }, [overlayTimeoutRef]);

  const prevSprintRef = useRef<SprintStatus | null>(sprint);

  useEffect(() => {
    const prev = prevSprintRef.current;
    prevSprintRef.current = sprint;

    if (sprint === null || !isActive) return;

    const isPass =
      sprint.verdict === 'pass' ||
      sprint.verdict === 'passed' ||
      sprint.verdict === 'accepted';
    const isFail =
      sprint.verdict === 'fail' ||
      sprint.verdict === 'failed' ||
      sprint.verdict === 'rejected';
    const rounds = sprint.rounds ?? 0;

    // Newly completed (verdict changed from running/empty to pass/fail)
    const wasRunning =
      !prev ||
      prev.verdict === 'running' ||
      prev.verdict === '' ||
      prev.verdict === 'pending';

    if (!wasRunning) return;

    clearOverlayTimeout();

    if (isPass) {
      setOverlayType('pass');
      // After 2s, show sprint transition if there's a next sprint, then clear
      overlayTimeoutRef.id = setTimeout(() => {
        if (sprintIndex + 1 < totalSprints) {
          setOverlayType('sprint_transition');
          overlayTimeoutRef.id = setTimeout(() => {
            setOverlayType(null);
          }, 1500);
        } else {
          setOverlayType(null);
        }
      }, 2000);
    } else if (isFail) {
      if (rounds >= totalRounds) {
        // Max rounds reached: persistent overlay with action buttons
        setOverlayType('fail_max_rounds');
      } else {
        // Still has rounds remaining: auto-advance to next round after 2s
        setOverlayType('fail_with_rounds');
        overlayTimeoutRef.id = setTimeout(() => {
          setOverlayType(null);
        }, 2000);
      }
    }
  }, [sprint, isActive, sprintIndex, totalSprints, totalRounds, clearOverlayTimeout, overlayTimeoutRef]);

  // Cleanup on unmount
  useEffect(() => {
    return () => clearOverlayTimeout();
  }, [clearOverlayTimeout]);

  const handleAbort = useCallback(() => {
    setOverlayType(null);
    void abortPipeline();
  }, [abortPipeline]);

  // Sprint not started yet and no history
  if (!sprint && !sprintRunning && persistedRounds.length === 0) {
    return <SprintEmptyState sprintIndex={sprintIndex} />;
  }

  const rounds = sprint?.rounds ?? 0;
  const sprintName = sprint?.name ?? `Sprint ${sprintIndex + 1}`;
  const sprintVerdict = sprint?.verdict ?? '';

  // Determine which inner tabs to show
  const showCoder = sprintRunning || (sprint !== null) || persistedRounds.some(r => r.coderContent !== '');
  const showEvaluator = sprintRunning || (sprint !== null && (rounds > 0)) || persistedRounds.some(r => r.evaluatorContent !== '');
  const showMetricas = sprint !== null;

  // Resolve active inner tab - fall back to coder if current tab not available
  const resolvedTab: SprintInnerTab =
    (innerTab === 'evaluator' && !showEvaluator) ||
    (innerTab === 'metricas' && !showMetricas)
      ? 'coder'
      : innerTab;

  // When viewing a completed sprint's coder/evaluator tabs, figure out which rounds to show.
  // During live streaming, only show the live panels (history will catch up after done).
  // After streaming ends, show persisted rounds.
  const showLiveCoder = isActive && isLoopPhase;
  const showLiveEvaluator = isActive && (isEvaluatorPhase(currentPhase) || evaluatorStream.length > 0);

  // For persisted history: exclude rounds that are currently streaming (they'll be reloaded after done)
  // If currently streaming round N, we still show round N from DB if it exists (it won't until after done)
  const persistedRoundsToShow = persistedRounds;

  return (
    <div className="flex flex-col gap-3 relative">
      {/* Sprint info header */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs font-semibold text-zinc-300">
          Sprint {sprintIndex + 1}/{totalSprints}: {sprintName}
        </span>
        {sprint && <VerdictBadge verdict={sprint.verdict} />}
        {sprintRunning && !sprint && (
          <span className="flex items-center gap-1 text-[10px] text-amber-400">
            <Loader2 size={9} className="animate-spin" />
            Em execucao
          </span>
        )}
      </div>

      {/* Sprint definition panel (UI-04) */}
      {sprint?.sprintJsonId && (
        <SprintDefinition projectId={projectId} sprintJsonId={sprint.sprintJsonId} />
      )}

      {/* Inner tab strip */}
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-0">
        {showCoder && (
          <button
            onClick={() => setInnerTab('coder')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-t-lg transition-colors ${
              resolvedTab === 'coder'
                ? 'bg-amber-500/15 text-amber-400 border-b-2 border-amber-500'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {isCoderPhase(currentPhase) && isStreaming && isActive && (
              <Loader2 size={9} className="animate-spin" />
            )}
            Coder
            {coderModel && (
              <span className="text-[10px] font-medium text-green-400 bg-green-500/10 border border-green-500/30 px-1.5 py-0.5 rounded font-mono">
                {shortenModel(coderModel)}
              </span>
            )}
          </button>
        )}
        {showEvaluator && (
          <button
            onClick={() => setInnerTab('evaluator')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-t-lg transition-colors ${
              resolvedTab === 'evaluator'
                ? 'bg-blue-500/15 text-blue-400 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {isEvaluatorPhase(currentPhase) && isStreaming && isActive && (
              <Loader2 size={9} className="animate-spin" />
            )}
            Evaluator
            {evaluatorModel && (
              <span className="text-[10px] font-medium text-green-400 bg-green-500/10 border border-green-500/30 px-1.5 py-0.5 rounded font-mono">
                {shortenModel(evaluatorModel)}
              </span>
            )}
          </button>
        )}
        {showMetricas && (
          <button
            onClick={() => setInnerTab('metricas')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-t-lg transition-colors ${
              resolvedTab === 'metricas'
                ? 'bg-amber-500/15 text-amber-400 border-b-2 border-amber-500'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Metricas
          </button>
        )}
      </div>

      {/* Inner tab content */}
      <div className="relative">

        {/* Coder tab */}
        {resolvedTab === 'coder' && (
          <div className="space-y-3">
            {/* Round indicator during live execution */}
            {sprintRunning && currentPhase !== null && (
              <div className="flex items-center gap-2 flex-wrap">
                <RoundBadge
                  roundNumber={rounds + 1}
                  totalRounds={totalRounds}
                  isCurrent={isCoderPhase(currentPhase)}
                  phase={currentPhase}
                />
              </div>
            )}

            {/* Persisted rounds from DB */}
            {persistedRoundsToShow.length > 0 && (
              <div className="space-y-3">
                {persistedRoundsToShow.map((roundData, i) => (
                  <PersistedRoundPanel
                    key={roundData.roundIndex}
                    round={roundData}
                    roundNumber={roundData.roundIndex}
                    totalRounds={totalRounds}
                    sprintVerdict={sprintVerdict}
                    isLastRound={i === persistedRoundsToShow.length - 1}
                  />
                ))}
              </div>
            )}

            {/* Live stream for coder (shown during active coder phase) */}
            {showLiveCoder && coderStream.length > 0 && (
              <LiveStreamPanel phase={13} stream={coderStream} />
            )}

            {/* If streaming but no content yet */}
            {showLiveCoder && coderStream.length === 0 && isStreaming && (
              <LiveStreamPanel phase={13} stream={coderStream} />
            )}

            {/* Completed sprint summary (only when not showing persisted rounds) */}
            {sprint !== null && !sprintRunning && persistedRounds.length === 0 && (
              <SprintSummaryCard sprint={sprint} />
            )}
          </div>
        )}

        {/* Evaluator tab */}
        {resolvedTab === 'evaluator' && (
          <div className="space-y-3">
            {/* Persisted evaluator rounds from DB */}
            {persistedRoundsToShow.filter(r => r.evaluatorContent !== '').length > 0 && (
              <div className="space-y-3">
                {persistedRoundsToShow
                  .filter(r => r.evaluatorContent !== '')
                  .map((roundData, i, arr) => (
                    <PersistedRoundPanel
                      key={roundData.roundIndex}
                      round={roundData}
                      roundNumber={roundData.roundIndex}
                      totalRounds={totalRounds}
                      sprintVerdict={sprintVerdict}
                      isLastRound={i === arr.length - 1}
                    />
                  ))}
              </div>
            )}

            {/* Live stream for evaluator (shown during active evaluator phase) */}
            {showLiveEvaluator && (
              <LiveStreamPanel phase={14} stream={evaluatorStream} />
            )}

            {/* Completed sprint summary (only when not showing persisted rounds) */}
            {sprint !== null && !sprintRunning && !isActive && persistedRounds.filter(r => r.evaluatorContent !== '').length === 0 && (
              <SprintSummaryCard sprint={sprint} />
            )}
          </div>
        )}

        {/* Metricas tab */}
        {resolvedTab === 'metricas' && sprint !== null && (
          <SprintMetricsTab
            sprint={sprint}
            maxRounds={totalRounds}
            currentPhase={currentPhase}
            isActive={isActive}
            isStreaming={isStreaming}
          />
        )}

        {/* Verdict overlay - positioned over the inner tab content */}
        <VerdictOverlay
          type={overlayType}
          sprintIndex={sprintIndex}
          totalSprints={totalSprints}
          currentRound={rounds}
          maxRounds={totalRounds}
          onAbort={handleAbort}
        />
      </div>

      {/* Round status bar at bottom (always visible) */}
      {(sprint !== null || sprintRunning) && (
        <div className="border-t border-zinc-800 pt-2 mt-1">
          <RoundStatusBar
            rounds={sprintRunning ? (sprint?.rounds ?? 0) : rounds}
            maxRounds={totalRounds}
            verdict={sprint?.verdict ?? 'running'}
            isActive={isActive}
            isStreaming={isStreaming}
            currentPhase={currentPhase}
          />
        </div>
      )}
    </div>
  );
}

// ---- Main component ----

export interface SprintExecutionViewProps {
  /** Total number of sprints planned (from sprint planner output). */
  totalSprints: number;
  /** Max rounds per sprint (from project config). */
  maxRounds?: number;
  /** Active project id (needed for sprint definition panel). */
  projectId: string;
}

export function SprintExecutionView({
  totalSprints,
  maxRounds = 5,
  projectId,
}: SprintExecutionViewProps) {
  // UI-18: use store-persisted selectedSprintTab so the selection survives remounts
  const sprints = useActiveProjectState(s => s.sprints) ?? [];
  const currentPhase = useActiveProjectState(s => s.currentPhase) ?? null;
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const selectedSprintTab = useActiveProjectState(s => s.selectedSprintTab) ?? 0;
  const pipelineSprintIndex = useActiveProjectState(s => s.pipelineSprintIndex) ?? null;
  const setSelectedSprintTab = usePipelineStore(s => s.setSelectedSprintTab);

  // UI-03: use backend-provided sprint index when available, fall back to heuristic
  const activeSprintIndex = (() => {
    if (pipelineSprintIndex !== null && pipelineSprintIndex !== undefined) {
      return pipelineSprintIndex;
    }
    // Fallback: find first sprint without completed verdict
    for (const s of sprints) {
      const v = s.verdict ?? '';
      if (v === '' || v === 'running' || v === 'pending') return s.index;
    }
    return sprints.length > 0 ? sprints[sprints.length - 1].index : 0;
  })();

  // Sidebar ref for auto-scrolling to the active sprint (UI-02)
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeButtonRef = useRef<HTMLButtonElement>(null);

  // When the component mounts and the stored tab is out of range, sync it
  useEffect(() => {
    const maxTab = Math.max(0, totalSprints - 1);
    if (selectedSprintTab > maxTab) {
      setSelectedSprintTab(0);
    }
  }, [totalSprints, selectedSprintTab, setSelectedSprintTab]);

  // Auto-scroll sidebar to active sprint when it changes (UI-02)
  useEffect(() => {
    activeButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeSprintIndex]);

  const sprintCount = Math.max(totalSprints, sprints.length, 1);
  const tabs = Array.from({ length: sprintCount }, (_, i) => i);

  // Clamp the selected tab to available range
  const clampedTab = Math.min(selectedSprintTab, sprintCount - 1);

  const isExecuting = isCoderPhase(currentPhase) || isEvaluatorPhase(currentPhase);

  return (
    <div className="flex gap-3">
      {/* Sprint sidebar (UI-02) */}
      <div
        ref={sidebarRef}
        className="w-44 shrink-0 space-y-1 max-h-[60vh] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700"
      >
        {tabs.map((sprintIdx) => {
          const sprintData = sprints.find((s) => s.index === sprintIdx);
          const isActive = sprintIdx === activeSprintIndex;
          const isSelected = sprintIdx === clampedTab;
          const verdict = sprintData?.verdict ?? '';
          const isPass = verdict === 'pass' || verdict === 'passed' || verdict === 'accepted';
          const isFail = verdict === 'fail' || verdict === 'failed' || verdict === 'rejected';
          const isRunning = isActive && isExecuting;

          return (
            <button
              key={sprintIdx}
              ref={isActive ? activeButtonRef : undefined}
              onClick={() => setSelectedSprintTab(sprintIdx)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                isSelected
                  ? 'bg-zinc-800 border border-zinc-600 text-zinc-100'
                  : 'bg-zinc-900/50 border border-transparent text-zinc-400 hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-500 shrink-0">S{sprintIdx + 1}</span>
                {isPass ? (
                  <CheckCircle2 size={12} className="text-green-400 shrink-0" />
                ) : isRunning && isStreaming ? (
                  <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />
                ) : isFail ? (
                  <XCircle size={12} className="text-red-400 shrink-0" />
                ) : (
                  <Circle size={12} className="text-zinc-600 shrink-0" />
                )}
              </div>
              <span className="block truncate mt-0.5">
                {sprintData?.name ?? `Sprint ${sprintIdx + 1}`}
              </span>
              {sprintData?.coderAgentId && (
                <span className="block text-[10px] text-zinc-600 truncate">
                  {sprintData.coderAgentId}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sprint content (UI-02) */}
      <div className="flex-1 min-w-0">
        {/* Tab content */}
        <SprintTabContent
          sprintIndex={clampedTab}
          sprint={sprints.find((s) => s.index === clampedTab) ?? null}
          isActive={clampedTab === activeSprintIndex}
          currentPhase={currentPhase}
          totalRounds={maxRounds}
          totalSprints={sprintCount}
          projectId={projectId}
        />
        {/* cursor animation */}
        <style>{`
          .sprint-exec-cursor {
            display: inline-block;
            width: 2px;
            height: 0.85em;
            background: currentColor;
            margin-left: 1px;
            vertical-align: text-bottom;
            animation: sprint-blink 1s step-end infinite;
          }
          @keyframes sprint-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>
      </div>
    </div>
  );
}
