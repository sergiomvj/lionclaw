// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowLeft, Send, Square, User, Wrench, Loader2, CheckCircle2, Trash2 } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEnrichStore } from '@/stores/enrich-store';
import { useAppStore } from '@/stores/app-store';
import { EnrichPhaseIndicator } from '@/components/enrich/EnrichPhaseIndicator';
import { EnrichMetricsBar } from '@/components/enrich/EnrichMetricsBar';
import { EnrichControls } from '@/components/enrich/EnrichControls';
import { SpecViewer } from '@/components/enrich/SpecViewer';
import type { EnrichStatusEvent, EnrichMetricsEvent } from '@/types';

// ---- Markdown components ----

const markdownComponents: Components = {
  code({ className, children }) {
    const isInline = !className && typeof children === 'string' && !children.includes('\n');
    if (isInline) {
      return (
        <code className="px-1.5 py-0.5 bg-zinc-800 rounded text-xs font-mono text-zinc-300">
          {children}
        </code>
      );
    }
    const lang = className?.replace('language-', '') || '';
    return (
      <div className="my-2">
        {lang && (
          <div className="flex items-center px-3 py-1 bg-zinc-800/80 border border-zinc-700/50 rounded-t-lg border-b-0">
            <span className="text-[10px] text-zinc-500 font-mono uppercase">{lang}</span>
          </div>
        )}
        <pre className={`!mt-0 text-xs ${lang ? '!rounded-t-none' : ''}`}>
          <code className={className}>{children}</code>
        </pre>
      </div>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

// ---- Message bubble ----

function MessageBubble({
  role,
  content,
  toolCalls,
  isStreaming = false,
  streamingTools,
}: {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
  isStreaming?: boolean;
  streamingTools?: Array<{ tool: string; input: unknown }>;
}) {
  const isUser = role === 'user';

  const renderedContent = useMemo(() => {
    if (isUser || !content) return null;
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    );
  }, [content, isUser]);

  const allTools = toolCalls ?? streamingTools ?? [];

  return (
    <div className={`flex gap-3 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? 'bg-zinc-700' : 'bg-indigo-500/10'
        }`}
      >
        {isUser ? (
          <User size={14} className="text-zinc-300" />
        ) : (
          <img src="/resources/logo-lionclaw.png" alt="agent" className="w-4 h-4" />
        )}
      </div>
      <div
        className={`rounded-xl px-4 py-3 text-sm max-w-[85%] ${
          isUser
            ? 'bg-amber-600 text-white'
            : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="chat-markdown">
            {allTools.length > 0 && (
              <div className="mb-2 space-y-1">
                {allTools.map((tc, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-zinc-500">
                    {isStreaming && i === allTools.length - 1 ? (
                      <Loader2 size={11} className="animate-spin text-indigo-400" />
                    ) : (
                      <CheckCircle2 size={11} className="text-green-500" />
                    )}
                    <span className="font-mono">{tc.tool}</span>
                  </div>
                ))}
              </div>
            )}
            {renderedContent}
            {isStreaming && !content && allTools.length === 0 && (
              <span className="inline-flex gap-1 items-center text-zinc-500 text-xs">
                <Loader2 size={12} className="animate-spin" />
                Processando...
              </span>
            )}
            {isStreaming && content && <span className="streaming-cursor" />}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Main page ----

export function EnrichDocPage() {
  const { setPage } = useAppStore();

  // Redirect immediately to the new unified Pipeline page
  useEffect(() => {
    setPage('pipeline');
  }, [setPage]);

  return null;
}

function _LegacyEnrichDocPage() {
  const { setPage } = useAppStore();
  const {
    activeSessionId,
    sessions,
    messages,
    isStreaming,
    currentStreamContent,
    currentToolCalls,
    currentMetrics,
    addUserMessage,
    appendStreamText,
    appendStreamTool,
    finalizeAssistantMessage,
    setStreaming,
    updateMetrics,
    updateSessionPhase,
    updateSessionFinalSpec,
    loadSessions,
    loadMessages,
    deleteSession,
  } = useEnrichStore();

  const [input, setInput] = useState('');
  const [specViewerPath, setSpecViewerPath] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const session = sessions.find((s) => s.id === activeSessionId);

  // Scroll to bottom on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStreamContent, currentToolCalls]);

  // Load persisted messages when the active session changes
  useEffect(() => {
    if (!activeSessionId) return;
    loadMessages(activeSessionId).catch(() => {
      // non-fatal: if loading fails the chat just starts empty
    });
  }, [activeSessionId, loadMessages]);

  // Subscribe to enrich stream events
  useEffect(() => {
    if (!activeSessionId) return;

    const unsubStream = window.lionclaw.enrich.onStream((raw) => {
      const chunk = raw as {
        type: string;
        sessionId?: string;
        content?: string;
        tool?: string;
        input?: unknown;
      };

      if (chunk.sessionId && chunk.sessionId !== activeSessionId) return;

      switch (chunk.type) {
        case 'text':
          appendStreamText(chunk.content ?? '');
          break;
        case 'tool_call':
          appendStreamTool(chunk.tool ?? '', chunk.input);
          break;
        case 'done':
          finalizeAssistantMessage();
          break;
        case 'error':
          finalizeAssistantMessage();
          break;
      }
    });

    const unsubMetrics = window.lionclaw.enrich.onMetrics((raw) => {
      const data = raw as EnrichMetricsEvent;
      if (data.sessionId !== activeSessionId) return;
      updateMetrics(data.metrics);
    });

    const unsubStatus = window.lionclaw.enrich.onStatus((raw) => {
      const data = raw as EnrichStatusEvent;
      if (data.sessionId !== activeSessionId) return;
      updateSessionPhase(data.sessionId, data.phase, data.status);

      if (data.status === 'running') {
        setStreaming(true);
      } else if (data.status === 'waiting' || data.status === 'done') {
        setStreaming(false);
      }

      // When finalize completes, fetch the spec path
      if (data.phase === 'done' && data.status === 'done') {
        window.lionclaw.enrich.getSpec(data.sessionId).then((res) => {
          if (!('error' in res) && res.finalSpecPath) {
            updateSessionFinalSpec(data.sessionId, res.finalSpecPath);
          }
        });
        loadSessions();
      }
    });

    return () => {
      unsubStream();
      unsubMetrics();
      unsubStatus();
    };
  }, [
    activeSessionId,
    appendStreamText,
    appendStreamTool,
    finalizeAssistantMessage,
    setStreaming,
    updateMetrics,
    updateSessionPhase,
    updateSessionFinalSpec,
    loadSessions,
    loadMessages,
  ]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !activeSessionId || isStreaming) return;
    setInput('');
    addUserMessage(trimmed);
    await window.lionclaw.enrich.send(activeSessionId, trimmed);
  }, [input, activeSessionId, isStreaming, addUserMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const handleAbort = async () => {
    if (!activeSessionId) return;
    await window.lionclaw.enrich.abort(activeSessionId);
    setStreaming(false);
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const handleDeleteSession = async () => {
    if (!activeSessionId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await deleteSession(activeSessionId);
    setPage('harness');
  };

  const combinedMetrics = session
    ? {
        inputTokens:
          session.validatorMetrics.inputTokens +
          session.enricherMetrics.inputTokens +
          currentMetrics.inputTokens,
        outputTokens:
          session.validatorMetrics.outputTokens +
          session.enricherMetrics.outputTokens +
          currentMetrics.outputTokens,
        cacheReadTokens:
          session.validatorMetrics.cacheReadTokens +
          session.enricherMetrics.cacheReadTokens +
          currentMetrics.cacheReadTokens,
        cacheCreationTokens:
          session.validatorMetrics.cacheCreationTokens +
          session.enricherMetrics.cacheCreationTokens +
          currentMetrics.cacheCreationTokens,
        costUsd:
          session.validatorMetrics.costUsd +
          session.enricherMetrics.costUsd +
          currentMetrics.costUsd,
        durationMs:
          session.validatorMetrics.durationMs +
          session.enricherMetrics.durationMs +
          currentMetrics.durationMs,
        toolUses:
          session.validatorMetrics.toolUses +
          session.enricherMetrics.toolUses +
          currentMetrics.toolUses,
        apiRequests:
          session.validatorMetrics.apiRequests +
          session.enricherMetrics.apiRequests +
          currentMetrics.apiRequests,
        messages:
          session.validatorMetrics.messages +
          session.enricherMetrics.messages +
          currentMetrics.messages,
      }
    : currentMetrics;

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Sessao nao encontrada.
      </div>
    );
  }

  const isEmpty = messages.length === 0 && !currentStreamContent;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <button
          onClick={() => setPage('harness')}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Voltar"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100 truncate">{session.name}</h1>
          <p className="text-[11px] text-zinc-500 truncate">{session.specPath}</p>
        </div>
        <EnrichPhaseIndicator phase={session.phase} />
        {confirmDelete ? (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleDeleteSession}
              className="px-2 py-1 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Confirmar
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 rounded text-[10px] font-semibold bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700 transition-colors"
            >
              Nao
            </button>
          </div>
        ) : (
          <button
            onClick={handleDeleteSession}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors shrink-0"
            title="Cancelar e deletar sessao"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {/* Metrics bar */}
      <EnrichMetricsBar metrics={combinedMetrics} />

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-4">
              <Wrench size={24} className="text-indigo-400" />
            </div>
            <h2 className="text-base font-semibold text-zinc-200 mb-1">Enrich Pipeline</h2>
            <p className="text-xs text-zinc-500 max-w-sm">
              O agente esta processando sua SPEC. As mensagens apareceram aqui em breve.
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            {messages.map((msg, idx) => (
              <MessageBubble
                key={idx}
                role={msg.role}
                content={msg.content}
                toolCalls={msg.toolCalls}
              />
            ))}

            {/* Streaming message */}
            {(currentStreamContent || currentToolCalls.length > 0 || (isStreaming && messages.length === 0)) && (
              <MessageBubble
                role="assistant"
                content={currentStreamContent}
                streamingTools={currentToolCalls}
                isStreaming={isStreaming}
              />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input + controls */}
      <div className="border-t border-zinc-800 px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative flex items-end gap-2 bg-zinc-900 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-indigo-500/50 transition-colors">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={
                  session.status === 'running'
                    ? 'Agente trabalhando...'
                    : session.phase === 'done'
                    ? 'Sessao concluida'
                    : 'Mensagem para o agente...'
                }
                rows={1}
                disabled={session.phase === 'done'}
                className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none max-h-32"
                style={{ minHeight: '24px' }}
              />
              {isStreaming ? (
                <button
                  onClick={handleAbort}
                  className="p-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white transition-colors shrink-0"
                  title="Parar"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || session.phase === 'done'}
                  className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                  title="Enviar (Enter)"
                >
                  <Send size={14} />
                </button>
              )}
            </div>

            <EnrichControls
              sessionId={session.id}
              phase={session.phase}
              status={session.status}
              finalSpecPath={session.finalSpecPath}
              onViewSpec={(path) => setSpecViewerPath(path)}
            />
          </div>
          <p className="text-[10px] text-zinc-600 text-center mt-1.5">
            Enter para enviar, Shift+Enter para nova linha
          </p>
        </div>
      </div>

      {/* Spec viewer modal */}
      {specViewerPath && (
        <SpecViewer
          specPath={specViewerPath}
          sessionId={activeSessionId}
          onClose={() => setSpecViewerPath(null)}
        />
      )}
    </div>
  );
}

export default EnrichDocPage;
