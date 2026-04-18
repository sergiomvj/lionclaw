import { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';

interface TokenCounterProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  isStreaming: boolean;
}

function useAnimatedCounter(target: number, duration = 200): number {
  const [display, setDisplay] = useState(0);
  const startRef = useRef(0);
  const startTimeRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    startRef.current = display;
    startTimeRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(startRef.current + (target - startRef.current) * eased);
      setDisplay(value);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
  if (tokens >= 1_000) return tokens.toLocaleString();
  return String(tokens);
}

function estimateCost(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): string {
  // Sonnet pricing: input $3/M, output $15/M, cache_read $0.30/M, cache_creation $3.75/M
  const pureInput = Math.max(0, input - cacheRead - cacheCreation);
  const cost = (pureInput / 1_000_000) * 3.0
    + (cacheRead / 1_000_000) * 0.30
    + (cacheCreation / 1_000_000) * 3.75
    + (output / 1_000_000) * 15.0;
  if (cost < 0.001) return '<$0.001';
  if (cost < 0.01) return `~$${cost.toFixed(4)}`;
  return `~$${cost.toFixed(3)}`;
}

export function TokenCounter({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, isStreaming }: TokenCounterProps) {
  const animatedInput = useAnimatedCounter(inputTokens);
  const animatedOutput = useAnimatedCounter(outputTokens);
  const animatedCacheRead = useAnimatedCounter(cacheReadTokens || 0);
  const animatedCacheCreation = useAnimatedCounter(cacheCreationTokens || 0);

  if (inputTokens === 0 && outputTokens === 0) return null;

  const hasCacheInfo = (cacheReadTokens || 0) > 0 || (cacheCreationTokens || 0) > 0;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800/50">
      <Zap size={12} className={`text-amber-500 ${isStreaming ? 'animate-pulse' : ''}`} />
      <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500">
        <span>
          <span className="text-zinc-600">in:</span>{' '}
          <span className="text-zinc-400">{formatTokenCount(animatedInput)}</span>
          {hasCacheInfo && (
            <span className="text-zinc-600"> (cache: {formatTokenCount(animatedCacheRead + animatedCacheCreation)})</span>
          )}
        </span>
        <span className="text-zinc-700">|</span>
        <span>
          <span className="text-zinc-600">out:</span>{' '}
          <span className="text-zinc-400">{formatTokenCount(animatedOutput)}</span>
        </span>
        <span className="text-zinc-700">|</span>
        <span className="text-zinc-500">
          {estimateCost(animatedInput, animatedOutput, animatedCacheRead, animatedCacheCreation)}
        </span>
      </div>
    </div>
  );
}
