import { useEffect, useRef } from 'react';
import { Wrench } from 'lucide-react';

interface StreamEntry {
  type: string;
  content?: string;
  tool?: string;
}

interface AgentStreamPanelProps {
  label: string;
  stream: StreamEntry[];
  isActive: boolean;
  tokens?: { input: number; output: number };
  cost?: number;
  duration?: number;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

export function AgentStreamPanel({
  label,
  stream,
  isActive,
  tokens,
  cost,
  duration,
}: AgentStreamPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream]);

  const hasContent = stream.length > 0;

  return (
    <div className="flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        ) : (
          <span className="h-2 w-2 rounded-full bg-zinc-700 shrink-0" />
        )}
        <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wide">{label}</span>
        {isActive && (
          <span className="ml-auto text-[10px] text-blue-400 font-mono">ativo</span>
        )}
      </div>

      {/* Stream content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0">
        {!hasContent && (
          <p className="text-xs text-zinc-600 italic">
            {isActive ? 'Aguardando saida...' : '(aguardando)'}
          </p>
        )}

        {stream.map((entry, idx) => {
          if (entry.type === 'tool_call' || entry.type === 'tool_use') {
            return (
              <div key={idx} className="flex items-center gap-1.5 my-1">
                <Wrench size={10} className="text-amber-500 shrink-0" />
                <span className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0.5 rounded font-mono">
                  {entry.tool ?? 'tool'}
                </span>
                {entry.content != null && entry.content !== '' && (
                  <span className="text-[10px] text-zinc-400 font-mono truncate">
                    {entry.content}
                  </span>
                )}
              </div>
            );
          }

          if (entry.type === 'tool_result') {
            return (
              <div key={idx} className="flex items-center gap-1.5 my-1">
                <span className="bg-zinc-700/60 text-zinc-400 text-[10px] px-1.5 py-0.5 rounded font-mono">
                  resultado
                </span>
                {entry.content != null && entry.content !== '' && (
                  <span className="text-[10px] text-zinc-500 font-mono truncate">
                    {entry.content}
                  </span>
                )}
              </div>
            );
          }

          if (entry.type === 'thinking') {
            return (
              <span
                key={idx}
                className="font-mono text-xs text-purple-400/70 italic whitespace-pre-wrap break-words"
              >
                {entry.content}
              </span>
            );
          }

          if (entry.content != null && entry.content !== '') {
            return (
              <span
                key={idx}
                className="font-mono text-xs text-zinc-100 whitespace-pre-wrap break-words"
              >
                {entry.content}
              </span>
            );
          }

          return null;
        })}

        <div ref={bottomRef} />
      </div>

      {/* Metrics footer */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-zinc-800 bg-zinc-900/40 shrink-0">
        {tokens != null && (
          <span className="text-[10px] text-zinc-500 font-mono">
            in: {tokens.input.toLocaleString()} / out: {tokens.output.toLocaleString()}
          </span>
        )}
        {cost != null && cost > 0 && (
          <span className="text-[10px] text-zinc-500 font-mono">{formatCost(cost)}</span>
        )}
        {duration != null && duration > 0 && (
          <span className="text-[10px] text-zinc-500 font-mono">{formatDuration(duration)}</span>
        )}
        {!tokens && !cost && !duration && (
          <span className="text-[10px] text-zinc-700 font-mono">sem metricas</span>
        )}
      </div>
    </div>
  );
}
