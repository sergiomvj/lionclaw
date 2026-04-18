// @deprecated - migrado para pipeline-engine/pipeline-store
import { useEffect, useRef, useState } from 'react';
import { Loader2, Wrench, CheckCircle2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkflowStore } from '@/stores/workflow-store';

interface PanelState {
  content: string;
  toolCalls: string[];
  isStreaming: boolean;
}

const emptyPanel = (): PanelState => ({
  content: '',
  toolCalls: [],
  isStreaming: false,
});

export function SpecGenerationView() {
  const { generationRound, maxRounds } = useWorkflowStore();

  const [builderPanel, setBuilderPanel] = useState<PanelState>(emptyPanel());
  const [validatorPanel, setValidatorPanel] = useState<PanelState>(emptyPanel());

  // Refs for accumulating content without stale closures
  const builderRef = useRef({ content: '', toolCalls: [] as string[] });
  const validatorRef = useRef({ content: '', toolCalls: [] as string[] });

  useEffect(() => {
    const unsub = window.lionclaw.workflow.onAgentStream((data) => {
      const { agent, msg } = data;
      const isBuilder = agent === 'spec-builder';

      if (msg.type === 'text' && msg.content) {
        if (isBuilder) {
          builderRef.current.content += msg.content;
          setBuilderPanel((p) => ({ ...p, content: builderRef.current.content, isStreaming: true }));
        } else {
          validatorRef.current.content += msg.content;
          setValidatorPanel((p) => ({ ...p, content: validatorRef.current.content, isStreaming: true }));
        }
      } else if (msg.type === 'tool_call' && msg.tool) {
        if (isBuilder) {
          builderRef.current.toolCalls = [...builderRef.current.toolCalls, msg.tool];
          setBuilderPanel((p) => ({ ...p, toolCalls: builderRef.current.toolCalls }));
        } else {
          validatorRef.current.toolCalls = [...validatorRef.current.toolCalls, msg.tool];
          setValidatorPanel((p) => ({ ...p, toolCalls: validatorRef.current.toolCalls }));
        }
      } else if (msg.type === 'done') {
        if (isBuilder) {
          setBuilderPanel((p) => ({ ...p, isStreaming: false }));
        } else {
          setValidatorPanel((p) => ({ ...p, isStreaming: false }));
        }
      }
    });

    // Reset panels on new generation round
    const unsubRound = window.lionclaw.workflow.onGenerationRound(() => {
      builderRef.current = { content: '', toolCalls: [] };
      validatorRef.current = { content: '', toolCalls: [] };
      setBuilderPanel(emptyPanel());
      setValidatorPanel(emptyPanel());
    });

    return () => {
      unsub();
      unsubRound();
    };
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Round indicator */}
      <div className="flex items-center justify-center gap-3 py-2.5 border-b border-zinc-800 shrink-0">
        <Loader2 size={13} className="animate-spin text-orange-400" />
        <span className="text-xs font-medium text-zinc-400">
          Rodada{' '}
          <span className="text-orange-400 font-bold">{generationRound}</span>
          {' '}de{' '}
          <span className="text-zinc-300">{maxRounds}</span>
          {' '}— Gerando especificação
        </span>
        <div className="flex gap-1">
          {Array.from({ length: maxRounds }).map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i + 1 < generationRound
                  ? 'bg-green-500'
                  : i + 1 === generationRound
                  ? 'bg-orange-400 animate-pulse'
                  : 'bg-zinc-700'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Dual panels */}
      <div className="flex flex-1 overflow-hidden divide-x divide-zinc-800">
        <AgentPanel
          label="spec-builder"
          color="amber"
          panel={builderPanel}
        />
        <AgentPanel
          label="spec-validator"
          color="blue"
          panel={validatorPanel}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentPanel
// ---------------------------------------------------------------------------

interface AgentPanelProps {
  label: string;
  color: 'amber' | 'blue';
  panel: PanelState;
}

function AgentPanel({ label, color, panel }: AgentPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colorMap = {
    amber: {
      dot: 'bg-amber-500',
      text: 'text-amber-400',
      border: 'border-amber-500/20',
      bg: 'bg-amber-500/8',
      spinner: 'text-amber-400',
      toolIcon: 'text-amber-400',
    },
    blue: {
      dot: 'bg-blue-500',
      text: 'text-blue-400',
      border: 'border-blue-500/20',
      bg: 'bg-blue-500/8',
      spinner: 'text-blue-400',
      toolIcon: 'text-blue-400',
    },
  }[color];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [panel.content]);

  const isEmpty = !panel.content && panel.toolCalls.length === 0 && !panel.isStreaming;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
        <div className={`w-1.5 h-1.5 rounded-full ${colorMap.dot} ${panel.isStreaming ? 'animate-pulse' : ''}`} />
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${colorMap.text}`}>
          {label}
        </span>
        {panel.isStreaming && (
          <Loader2 size={10} className={`animate-spin ml-auto ${colorMap.spinner}`} />
        )}
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className={`w-8 h-8 rounded-lg border ${colorMap.border} flex items-center justify-center mb-2 opacity-40`}>
              <Loader2 size={16} className={`animate-spin ${colorMap.spinner}`} />
            </div>
            <p className="text-[11px] text-zinc-600">
              {label === 'spec-builder'
                ? 'Iniciando spec-builder... Lendo discovery notes.'
                : 'Aguardando spec-builder finalizar...'}
            </p>
          </div>
        ) : (
          <>
            {/* Tool calls */}
            {panel.toolCalls.length > 0 && (
              <div className="space-y-1 mb-2">
                {panel.toolCalls.map((tool, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    {panel.isStreaming && i === panel.toolCalls.length - 1 ? (
                      <Loader2 size={10} className={`animate-spin ${colorMap.toolIcon}`} />
                    ) : (
                      <CheckCircle2 size={10} className="text-green-500" />
                    )}
                    <span className="text-[10px] text-zinc-500 font-mono">{tool}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Streamed text */}
            {panel.content && (
              <div className="agent-panel-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{panel.content}</ReactMarkdown>
                {panel.isStreaming && <span className="streaming-cursor" />}
              </div>
            )}

            {/* Thinking indicator */}
            {panel.isStreaming && !panel.content && panel.toolCalls.length === 0 && (
              <div className="flex gap-1 items-center py-1">
                {[0, 120, 240].map((delay) => (
                  <span
                    key={delay}
                    className={`w-1.5 h-1.5 rounded-full ${colorMap.dot} animate-bounce opacity-60`}
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        .agent-panel-markdown {
          font-size: 0.68rem;
          line-height: 1.55;
          color: #a1a1aa;
        }
        .agent-panel-markdown h1,
        .agent-panel-markdown h2,
        .agent-panel-markdown h3,
        .agent-panel-markdown h4 {
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #d4d4d8;
          margin-top: 0.75rem;
          margin-bottom: 0.25rem;
        }
        .agent-panel-markdown p { margin-bottom: 0.35rem; }
        .agent-panel-markdown ul, .agent-panel-markdown ol {
          padding-left: 1rem;
          margin-bottom: 0.35rem;
        }
        .agent-panel-markdown li { margin-bottom: 0.15rem; }
        .agent-panel-markdown code {
          background: rgba(39,39,42,0.8);
          border: 1px solid rgba(63,63,70,0.4);
          padding: 0.05rem 0.25rem;
          border-radius: 3px;
          font-size: 0.6rem;
          color: #fb923c;
          font-family: monospace;
        }
        .agent-panel-markdown pre {
          background: rgba(39,39,42,0.8);
          border: 1px solid rgba(63,63,70,0.4);
          padding: 0.5rem;
          border-radius: 4px;
          overflow-x: auto;
          margin-bottom: 0.35rem;
        }
        .agent-panel-markdown pre code {
          background: none;
          border: none;
          padding: 0;
        }
        .agent-panel-markdown strong { color: #d4d4d8; font-weight: 600; }
        .agent-panel-markdown blockquote {
          border-left: 2px solid rgba(99,102,241,0.4);
          padding-left: 0.5rem;
          color: #71717a;
          margin: 0.35rem 0;
        }
        .streaming-cursor {
          display: inline-block;
          width: 2px;
          height: 0.85em;
          background: currentColor;
          margin-left: 1px;
          vertical-align: text-bottom;
          animation: blink 1s step-end infinite;
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
