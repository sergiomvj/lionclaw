import { useEffect, useRef, useState } from 'react';
import { Loader2, Wrench, CheckCircle2, ChevronDown, ChevronRight, AlertCircle, RefreshCw, XCircle } from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';

// ---- Helper: format a tool input for display ----

function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  try {
    const str = JSON.stringify(input, null, 2);
    return str.slice(0, 200) + (str.length > 200 ? '\n...' : '');
  } catch {
    return String(input).slice(0, 200);
  }
}

function formatToolInputShort(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  try {
    const str = JSON.stringify(input);
    return str.slice(0, 80) + (str.length > 80 ? '...' : '');
  } catch {
    return String(input).slice(0, 80);
  }
}

// ---- Tool call block (collapsible with inline divider) ----

interface ToolCallBlockProps {
  tool: string;
  input: unknown;
  output?: unknown;
  isLast: boolean;
  isStreaming: boolean;
  index: number;
}

function ToolCallBlock({ tool, input, output, isLast, isStreaming, index }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const showSpinner = isStreaming && isLast;
  const shortLabel = formatToolInputShort(input);

  return (
    <>
      {/* Thin grey divider between tool calls (not before the first) */}
      {index > 0 && (
        <div className="h-px bg-zinc-700 my-0.5" />
      )}

      <div className="py-0.5">
        {/* Collapsible header */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 w-full text-left group"
        >
          {expanded ? (
            <ChevronDown size={10} className="text-zinc-600 shrink-0" />
          ) : (
            <ChevronRight size={10} className="text-zinc-600 shrink-0" />
          )}
          {showSpinner ? (
            <Loader2 size={10} className="text-amber-400 animate-spin shrink-0" />
          ) : (
            <CheckCircle2 size={10} className="text-green-500 shrink-0" />
          )}
          <Wrench size={10} className="text-amber-500 shrink-0" />
          <span className="bg-amber-500/20 text-amber-400 text-[10px] px-1.5 py-0.5 rounded font-mono">
            {tool}
          </span>
          {!expanded && shortLabel && (
            <span className="text-[10px] text-zinc-500 font-mono truncate max-w-[200px]">
              {shortLabel}
            </span>
          )}
        </button>

        {/* Expanded input/output panel */}
        {expanded && (
          <div className="mt-1 ml-4 rounded border border-zinc-800 bg-zinc-950 p-2 space-y-2">
            <div>
              <p className="text-[10px] text-zinc-500 font-medium mb-1 uppercase tracking-wide">Input</p>
              <pre className="text-[10px] text-zinc-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
                {formatToolInput(input) || '(vazio)'}
              </pre>
            </div>
            <div>
              <p className="text-[10px] text-zinc-500 font-medium mb-1 uppercase tracking-wide">Output</p>
              <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap break-words leading-relaxed">
                {output !== undefined && output !== null ? formatToolInput(output) : showSpinner ? '(aguardando...)' : '(sem output)'}
              </pre>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ---- Auto-transition banner ----

interface AutoTransitionBannerProps {
  nextPhaseName: string;
}

function AutoTransitionBanner({ nextPhaseName }: AutoTransitionBannerProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const duration = 2000;
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(100, (elapsed / duration) * 100);
      setProgress(pct);
      if (pct >= 100) clearInterval(tick);
    }, 30);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={13} className="text-green-400 shrink-0" />
        <span className="text-xs text-zinc-300">
          Concluido. Avancando para{' '}
          <span className="text-amber-300 font-medium">{nextPhaseName}</span>...
        </span>
      </div>
      {/* Progress bar */}
      <div className="h-1 bg-zinc-800 rounded overflow-hidden">
        <div
          className="h-1 bg-amber-500 rounded transition-all duration-75"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

// ---- Error banner with retry ----

interface ErrorBannerProps {
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  onRetry: () => void;
  onAbort: () => void;
}

function ErrorBanner({ errorMessage, retryCount, maxRetries, onRetry, onAbort }: ErrorBannerProps) {
  const retryExhausted = retryCount >= maxRetries;

  return (
    <div
      className="mt-3 rounded-lg border p-3 space-y-2"
      style={{
        background: 'rgba(239, 68, 68, 0.08)',
        borderColor: '#ef4444',
      }}
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={13} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-red-400">
            {retryExhausted ? 'Pipeline pausado - limite de tentativas atingido' : 'Erro na fase'}
          </p>
          <p className="text-[11px] text-red-300/80 mt-0.5 break-words">{errorMessage}</p>
          {retryCount > 0 && (
            <p className="text-[10px] text-zinc-500 mt-1">
              Tentativa {retryCount}/{maxRetries}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {retryExhausted ? (
          <>
            <button
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
            >
              <RefreshCw size={11} />
              Retry manual
            </button>
            <button
              onClick={onAbort}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg transition-colors"
            >
              <XCircle size={11} />
              Abortar
            </button>
          </>
        ) : (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
          >
            <RefreshCw size={11} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Phase running indicator (header badge) ----

function PhaseRunningBadge({ phaseName }: { phaseName: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
      </span>
      <span className="text-[11px] text-amber-300 font-medium">{phaseName}</span>
      <Loader2 size={11} className="text-amber-400 animate-spin" />
    </div>
  );
}

// ---- Main component ----

interface PipelineStreamViewProps {
  /** Human-readable name of the current phase. */
  phaseName: string;
  /** Human-readable name of the next phase (for transition banner). */
  nextPhaseName?: string;
}

const MAX_RETRIES = 3;

export function PipelineStreamView({ phaseName, nextPhaseName }: PipelineStreamViewProps) {
  const { streamContent, currentToolCalls, isStreaming, error, retryPhase, abortPipeline } =
    usePipelineStore();

  const bottomRef = useRef<HTMLDivElement>(null);

  // Track retry count locally across error+retry cycles
  const [retryCount, setRetryCount] = useState(0);
  // Track whether to show the auto-transition banner
  const [showTransition, setShowTransition] = useState(false);

  // Reset retry count when phase changes (phaseName prop changes)
  useEffect(() => {
    setRetryCount(0);
  }, [phaseName]);

  // Auto-scroll as content arrives
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamContent, currentToolCalls]);

  // Detect phase completion: streaming stops and there's content => show transition
  const prevIsStreaming = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevIsStreaming.current;
    prevIsStreaming.current = isStreaming;

    // Transition from streaming -> not streaming with content
    if (wasStreaming && !isStreaming && (streamContent !== '' || currentToolCalls.length > 0) && !error) {
      setShowTransition(true);
      // Hide after 2.5s (banner is 2s + small buffer)
      const timer = setTimeout(() => setShowTransition(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, streamContent, currentToolCalls.length, error]);

  // When a new error arrives, reset transition
  useEffect(() => {
    if (error) setShowTransition(false);
  }, [error]);

  const handleRetry = () => {
    setRetryCount((c) => c + 1);
    void retryPhase();
  };

  const handleAbort = () => {
    void abortPipeline();
  };

  const hasContent = streamContent !== '' || currentToolCalls.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Stream da fase
        </span>
        {isStreaming ? (
          <PhaseRunningBadge phaseName={phaseName} />
        ) : (
          <span className="text-[11px] text-zinc-600 font-medium">{phaseName}</span>
        )}
      </div>

      {/* Stream content area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        {!hasContent && !error && (
          <p className="text-xs text-zinc-600 italic mt-4 text-center">
            {isStreaming ? 'Aguardando saida do agente...' : 'Nenhum conteudo ainda.'}
          </p>
        )}

        {/* Tool calls shown above text — each with divider and collapsible */}
        {currentToolCalls.length > 0 && (
          <div className="mb-2">
            {currentToolCalls.map((tc, i) => (
              <ToolCallBlock
                key={i}
                index={i}
                tool={tc.tool}
                input={tc.input}
                isLast={i === currentToolCalls.length - 1}
                isStreaming={isStreaming}
              />
            ))}
          </div>
        )}

        {/* Streamed text content */}
        {streamContent && (
          <pre className="font-mono text-xs text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
            {streamContent}
            {isStreaming && (
              <span className="pipeline-stream-cursor" />
            )}
          </pre>
        )}

        {/* Auto-transition banner */}
        {showTransition && nextPhaseName && (
          <AutoTransitionBanner nextPhaseName={nextPhaseName} />
        )}

        {/* Error banner with retry */}
        {error && (
          <ErrorBanner
            errorMessage={error}
            retryCount={retryCount}
            maxRetries={MAX_RETRIES}
            onRetry={handleRetry}
            onAbort={handleAbort}
          />
        )}

        <div ref={bottomRef} />
      </div>

      <style>{`
        .pipeline-stream-cursor {
          display: inline-block;
          width: 6px;
          height: 0.9em;
          background: rgba(167, 139, 250, 0.8);
          margin-left: 2px;
          vertical-align: text-bottom;
          border-radius: 1px;
          animation: pipeline-stream-blink 1s step-end infinite;
        }
        @keyframes pipeline-stream-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
