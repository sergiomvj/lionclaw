// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Wrench, CheckCircle2, Loader2, X, FileText, AlertTriangle, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkflowStore } from '@/stores/workflow-store';
import type { WorkflowMessage } from '@/stores/workflow-store';
import { useAppStore } from '@/stores/app-store';
import { DiscoveryPanel } from '@/components/buildplan/DiscoveryPanel';
import { ApprovalButtons } from '@/components/buildplan/ApprovalButtons';
import { SpecGenerationView } from '@/components/buildplan/SpecGenerationView';
import { AgentThinking } from '@/components/chat/AgentThinking';
import { OpenFolderButton } from '@/components/common/OpenFolderButton';

const STAGE_LABELS = ['Discovery', 'PRD', 'Database', 'Backend', 'Frontend', 'Security'];

export function BuildPlanPage() {
  const { setPage } = useAppStore();

  // Redirect immediately to the new unified Pipeline page
  useEffect(() => {
    setPage('pipeline');
  }, [setPage]);

  return null;
}

function _LegacyBuildPlanPage() {
  const {
    currentStage,
    currentQuestionNumber,
    totalQuestions,
    phase,
    generationRound,
    maxRounds,
    workflowRunId,
    specContent,
    validationContent,
    validationPassed,
    specPath,
    notesPath,
    discoveryComplete,
    messages,
    setStage,
    setPhase,
    setQuestion,
    setGenerationRound,
    setSpecResult,
    setDiscoveryComplete,
    addMessage,
    deactivate,
  } = useWorkflowStore();

  const { setPage } = useAppStore();
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [showApprovalButtons, setShowApprovalButtons] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingRef = useRef('');
  const toolCallsRef = useRef<string[]>([]);
  const phaseRef = useRef(phase);
  const currentStageRef = useRef(currentStage);

  // Keep refs in sync
  phaseRef.current = phase;
  currentStageRef.current = currentStage;

  // Signal backend that BuildPlan UI is active (controls chat routing)
  useEffect(() => {
    window.lionclaw.workflow.setUIActive(true);
    return () => {
      window.lionclaw.workflow.setUIActive(false);
    };
  }, []);

  // BuildPlan persists when user navigates away - no auto-cancel.
  // The workflowUIActive flag controls routing: when user is NOT on this page,
  // chat messages go to the orchestrator instead of the discovery harness.

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, toolCalls]);

  const finalizeStreamingMessage = useCallback((agent?: string) => {
    const content = streamingRef.current;
    if (content) {
      addMessage({ id: Date.now(), role: 'assistant', content, agent });
    }
    streamingRef.current = '';
    toolCallsRef.current = [];
    setStreamingContent('');
    setToolCalls([]);
    setIsStreaming(false);
  }, [addMessage]);

  useEffect(() => {
    // Discovery phase: main workflow stream
    const unsubStream = window.lionclaw.workflow.onStream((data) => {
      if (data.type === 'text' && data.content) {
        setIsStreaming(true);
        streamingRef.current += data.content;
        setStreamingContent(streamingRef.current);
      } else if (data.type === 'tool_call' && data.tool) {
        toolCallsRef.current = [...toolCallsRef.current, data.tool];
        setToolCalls([...toolCallsRef.current]);
      } else if (data.type === 'done') {
        finalizeStreamingMessage();
      } else if (data.type === 'error') {
        streamingRef.current = '';
        toolCallsRef.current = [];
        setStreamingContent('');
        setToolCalls([]);
        setIsStreaming(false);
        setError(data.error || 'Erro no workflow');
        setTimeout(() => setError(null), 8000);
      }
    });

    // Stage changes
    const unsubStage = window.lionclaw.workflow.onStageChanged((data) => {
      setStage(data.stage);
      if (data.stage >= 7) {
        setPhase('generating');
      }
    });

    // Generation rounds (spec-builder / spec-validator loop)
    const unsubRound = window.lionclaw.workflow.onGenerationRound((data) => {
      setGenerationRound(data.round, data.max);
    });

    // Agent stream during generation phase — only process if NOT in generating phase
    // (SpecGenerationView handles its own streaming during generating phase)
    const unsubAgentStream = window.lionclaw.workflow.onAgentStream((data) => {
      if (phaseRef.current === 'generating') return;
      const msg = data.msg;
      if (msg.type === 'text' && msg.content) {
        setIsStreaming(true);
        streamingRef.current += msg.content;
        setStreamingContent(streamingRef.current);
      } else if (msg.type === 'tool_call' && msg.tool) {
        toolCallsRef.current = [...toolCallsRef.current, msg.tool];
        setToolCalls([...toolCallsRef.current]);
      } else if (msg.type === 'done') {
        finalizeStreamingMessage(data.agent);
      }
    });

    // Generation complete
    const unsubGenDone = window.lionclaw.workflow.onGenerationDone((data) => {
      setPhase('done');
      setSpecResult(
        data.specPath,
        data.notesPath,
        data.passed,
        (data as unknown as Record<string, string>).specContent ?? '',
        (data as unknown as Record<string, string>).validationContent ?? '',
      );
    });

    // Question changed (discovery harness)
    const unsubQuestion = window.lionclaw.workflow.onQuestionChanged((data) => {
      setQuestion(data.question, data.current, data.total);
    });

    // Discovery complete (show approval buttons)
    const unsubDiscoveryComplete = window.lionclaw.workflow.onDiscoveryComplete(() => {
      setDiscoveryComplete(true);
      setShowApprovalButtons(true);
    });

    return () => {
      unsubStream();
      unsubStage();
      unsubRound();
      unsubAgentStream();
      unsubGenDone();
      unsubQuestion();
      unsubDiscoveryComplete();
    };
  }, [setStage, setPhase, setGenerationRound, setSpecResult, setQuestion, setDiscoveryComplete, finalizeStreamingMessage]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || phase === 'done' || phase === 'generating') return;

    addMessage({ id: Date.now(), role: 'user', content: trimmed });
    setInput('');
    setIsStreaming(true);
    setShowApprovalButtons(false);

    // chat:send is routed to workflow by the IPC handler when workflow is active
    window.lionclaw.chat.send(trimmed);
  }, [input, isStreaming, phase, addMessage]);

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

  const handleCancel = async () => {
    if (workflowRunId) {
      await window.lionclaw.workflow.cancel(workflowRunId);
    }
    deactivate();
    setPage('chat');
  };

  const handleApprove = () => {
    setShowApprovalButtons(false);
    setGenerationRound(1, 3);
    setPhase('generating');
  };

  const handleRevisar = () => {
    setShowApprovalButtons(false);
  };

  const handleClose = () => {
    deactivate();
    setPage('chat');
  };

  const isDone = phase === 'done';
  const isGenerating = phase === 'generating';

  const inputPlaceholder = isDone || isGenerating
    ? isGenerating ? 'Gerando especificação...' : 'Workflow concluído'
    : isStreaming
    ? 'Aguardando resposta...'
    : 'Responda ao assistente...';

  // Parse validation issues from validation report
  const hasValidationIssues = !validationPassed && validationContent && validationContent.trim() !== '';

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main area */}
      <div
        className={`flex-1 flex flex-col min-w-0 ${!isDone ? 'buildplan-chat-area' : ''}`}
      >
        {/* Header */}
        <div className="border-b border-zinc-800 px-4 py-2.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {/* BuildPlan label */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full bg-orange-500 shrink-0 ${!isDone ? 'animate-pulse' : ''}`} />
              <span className="text-sm font-bold text-orange-400 tracking-wide">
                BuildPlan
              </span>
            </div>

            {/* Question progress — during discovery */}
            {!isGenerating && !isDone && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalQuestions }, (_, i) => {
                    const qNum = i + 1;
                    const isPast = qNum < currentQuestionNumber;
                    const isCurrent = qNum === currentQuestionNumber;
                    return (
                      <div
                        key={qNum}
                        className={`w-2 h-2 rounded-full transition-all ${
                          isPast
                            ? 'bg-orange-500'
                            : isCurrent
                            ? 'bg-orange-400 shadow-[0_0_6px_rgba(249,115,22,0.6)]'
                            : 'bg-zinc-700'
                        }`}
                      />
                    );
                  })}
                </div>
                <span className="text-[10px] text-zinc-500 font-medium tabular-nums">
                  {currentQuestionNumber}/{totalQuestions}
                </span>
              </div>
            )}

            {/* Generation progress */}
            {isGenerating && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Loader2 size={12} className="animate-spin text-orange-400" />
                <span>
                  Gerando especificação — rodada {generationRound}/{maxRounds}
                </span>
              </div>
            )}

            {isDone && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-400 font-medium">Concluído</span>
                {hasValidationIssues && (
                  <span className="flex items-center gap-1 text-xs text-yellow-400">
                    <AlertTriangle size={11} />
                    com ressalvas
                  </span>
                )}
              </div>
            )}
          </div>

          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-orange-400 border border-orange-500/30 rounded-lg hover:bg-orange-500/10 hover:text-orange-300 transition-colors"
            title="Cancelar workflow"
          >
            <X size={13} />
            <span>Cancelar</span>
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-400 shrink-0" />
            <span className="text-xs text-red-300">{error}</span>
          </div>
        )}

        {/* Body — conditional by phase */}
        {isGenerating ? (
          // --- Generating phase: dual panel ---
          <SpecGenerationView />
        ) : isDone ? (
          // --- Done phase: render SPEC.md ---
          <SpecDoneView
            specContent={specContent}
            validationContent={validationContent}
            validationPassed={validationPassed}
            specPath={specPath}
            notesPath={notesPath}
            onClose={handleClose}
          />
        ) : (
          // --- Discovery phase: chat ---
          <>
            <div className="flex-1 overflow-y-auto px-4 py-5">
              <div className="max-w-2xl mx-auto space-y-4">
                {messages.length === 0 && !isStreaming && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-12 h-12 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center mb-4">
                      <span className="text-xl">🦁</span>
                    </div>
                    <h2 className="text-sm font-semibold text-orange-400 mb-1">BuildPlan</h2>
                    <p className="text-xs text-zinc-600 max-w-xs">
                      O assistente irá guiar você pelas etapas de discovery para gerar a especificação do seu projeto.
                    </p>
                  </div>
                )}

                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex gap-3 items-start ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        msg.role === 'user'
                          ? 'bg-zinc-700'
                          : 'bg-amber-500/10'
                      }`}
                    >
                      {msg.role === 'user'
                        ? <User size={14} className="text-zinc-300" />
                        : <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-4 h-4" />}
                    </div>
                    <div
                      className={`rounded-xl px-4 py-3 text-sm max-w-[85%] ${
                        msg.role === 'user'
                          ? 'bg-amber-600 text-white'
                          : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
                      }`}
                    >
                      {msg.agent && (
                        <span className="text-[10px] text-amber-500/70 font-medium uppercase block mb-1.5">
                          {msg.agent}
                        </span>
                      )}
                      {msg.role === 'user' ? (
                        <p className="whitespace-pre-wrap selectable">{msg.content}</p>
                      ) : (
                        <div className="chat-markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Active tool calls */}
                {toolCalls.length > 0 && (
                  <div className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Wrench size={14} className="text-amber-500" />
                    </div>
                    <div className="text-xs text-zinc-500 space-y-1 py-1">
                      {toolCalls.map((tool, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          {isStreaming && i === toolCalls.length - 1 ? (
                            <Loader2 size={12} className="animate-spin text-amber-500" />
                          ) : (
                            <CheckCircle2 size={12} className="text-green-500" />
                          )}
                          <span className="font-mono">{tool}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Thinking indicator */}
                {isStreaming && !streamingContent && toolCalls.length === 0 && (
                  <div className="py-1 pl-10">
                    <AgentThinking />
                  </div>
                )}

                {/* Streaming content */}
                {streamingContent && (
                  <div className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-4 h-4" />
                    </div>
                    <div className="rounded-xl px-4 py-3 text-sm bg-zinc-900 text-zinc-300 border border-zinc-800 max-w-[85%]">
                      <div className="chat-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {streamingContent}
                        </ReactMarkdown>
                        <span className="streaming-cursor" />
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Approval buttons */}
            {showApprovalButtons && !isStreaming && (
              <ApprovalButtons
                workflowRunId={workflowRunId}
                onApprove={handleApprove}
                onRevisar={handleRevisar}
              />
            )}

            {/* Input area */}
            {!showApprovalButtons && (
              <div className="border-t border-zinc-800 px-4 py-3 shrink-0">
                <div className="max-w-2xl mx-auto">
                  <div className="flex gap-2 items-end bg-zinc-900 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-orange-500/40 transition-colors">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={handleInputChange}
                      onKeyDown={handleKeyDown}
                      placeholder={inputPlaceholder}
                      rows={1}
                      disabled={isStreaming || isDone || isGenerating}
                      className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none max-h-32 selectable disabled:opacity-40"
                      style={{ minHeight: '24px' }}
                    />
                    <button
                      onClick={handleSend}
                      disabled={!input.trim() || isStreaming || isDone || isGenerating}
                      className="p-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                      title="Enviar (Enter)"
                    >
                      <Send size={15} />
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-700 text-center mt-1.5">
                    Enter para enviar, Shift+Enter para nova linha
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Discovery Panel — only during discovery phase */}
      {!isGenerating && !isDone && <DiscoveryPanel />}

      <style>{`
        @keyframes buildplan-glow {
          0%, 100% {
            box-shadow:
              inset 0 0 30px rgba(255, 165, 0, 0.03),
              inset 0 0 60px rgba(255, 165, 0, 0.015);
          }
          50% {
            box-shadow:
              inset 0 0 40px rgba(255, 165, 0, 0.08),
              inset 0 0 80px rgba(255, 165, 0, 0.04);
          }
        }

        .buildplan-chat-area {
          animation: buildplan-glow 3.5s ease-in-out infinite;
          border-left: 1px solid rgba(249, 115, 22, 0.15);
          border-right: 1px solid rgba(249, 115, 22, 0.15);
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

// ---------------------------------------------------------------------------
// SpecDoneView
// ---------------------------------------------------------------------------

interface SpecDoneViewProps {
  specContent: string | null;
  validationContent: string | null;
  validationPassed: boolean;
  specPath: string | null;
  notesPath: string | null;
  onClose: () => void;
}

function SpecDoneView({ specContent, validationContent, validationPassed, specPath, notesPath, onClose }: SpecDoneViewProps) {
  const hasIssues = !validationPassed && validationContent && validationContent.trim() !== '';

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Done banner */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <FileText size={16} className="text-green-400" />
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Especificação gerada</h2>
            <p className="text-xs text-zinc-500">
              {validationPassed
                ? 'Validação passou — SPEC.md está pronta'
                : 'Gerada com ressalvas — verifique os itens abaixo'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {specPath && (
            <OpenFolderButton filePath={specPath} label="Abrir SPEC" />
          )}
          {notesPath && (
            <OpenFolderButton filePath={notesPath} label="Abrir Notes" />
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 text-xs font-medium transition-colors"
          >
            <X size={13} />
            Fechar
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {/* Validation issues */}
        {hasIssues && (
          <div className="rounded-xl border border-yellow-600/30 bg-yellow-600/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={14} className="text-yellow-400" />
              <h3 className="text-xs font-semibold text-yellow-400 uppercase tracking-wide">
                Issues do último relatório de validação
              </h3>
            </div>
            <div className="validation-report-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{validationContent!}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* SPEC.md content */}
        <div className="spec-content">
          {specContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{specContent}</ReactMarkdown>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText size={32} className="text-zinc-700 mb-3" />
              <p className="text-sm text-zinc-500">Conteúdo da especificação não disponível.</p>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .spec-content {
          font-size: 0.875rem;
          line-height: 1.7;
          color: #d4d4d8;
        }
        .spec-content h1 {
          font-size: 1.25rem;
          font-weight: 700;
          color: #f4f4f5;
          margin-top: 2rem;
          margin-bottom: 0.75rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid rgba(249, 115, 22, 0.3);
        }
        .spec-content h2 {
          font-size: 1rem;
          font-weight: 700;
          color: #f97316;
          margin-top: 1.75rem;
          margin-bottom: 0.5rem;
        }
        .spec-content h3 {
          font-size: 0.875rem;
          font-weight: 600;
          color: #e4e4e7;
          margin-top: 1.25rem;
          margin-bottom: 0.4rem;
        }
        .spec-content h4 {
          font-size: 0.8rem;
          font-weight: 600;
          color: #a1a1aa;
          margin-top: 1rem;
          margin-bottom: 0.3rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .spec-content p { margin-bottom: 0.75rem; color: #a1a1aa; }
        .spec-content ul, .spec-content ol {
          padding-left: 1.5rem;
          margin-bottom: 0.75rem;
        }
        .spec-content li { margin-bottom: 0.3rem; color: #a1a1aa; }
        .spec-content strong { color: #e4e4e7; font-weight: 600; }
        .spec-content em { color: #9ca3af; }
        .spec-content code {
          background: rgba(39, 39, 42, 0.9);
          border: 1px solid rgba(63, 63, 70, 0.5);
          padding: 0.15rem 0.4rem;
          border-radius: 4px;
          font-size: 0.8rem;
          color: #fb923c;
          font-family: monospace;
        }
        .spec-content pre {
          background: rgba(24, 24, 27, 0.9);
          border: 1px solid rgba(63, 63, 70, 0.5);
          padding: 1rem;
          border-radius: 8px;
          overflow-x: auto;
          margin-bottom: 1rem;
        }
        .spec-content pre code {
          background: none;
          border: none;
          padding: 0;
          color: #e4e4e7;
        }
        .spec-content blockquote {
          border-left: 3px solid rgba(249, 115, 22, 0.5);
          padding-left: 1rem;
          color: #71717a;
          margin: 0.75rem 0;
        }
        .spec-content hr {
          border: none;
          border-top: 1px solid rgba(63, 63, 70, 0.5);
          margin: 1.5rem 0;
        }
        .spec-content table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 1rem;
          font-size: 0.8rem;
        }
        .spec-content th, .spec-content td {
          border: 1px solid rgba(63, 63, 70, 0.5);
          padding: 0.4rem 0.75rem;
          text-align: left;
        }
        .spec-content th {
          background: rgba(39, 39, 42, 0.6);
          color: #d4d4d8;
          font-weight: 600;
        }

        .validation-report-content {
          font-size: 0.78rem;
          line-height: 1.6;
          color: #fbbf24;
        }
        .validation-report-content h1,
        .validation-report-content h2,
        .validation-report-content h3 {
          color: #f59e0b;
          font-weight: 600;
          margin-top: 0.75rem;
          margin-bottom: 0.3rem;
        }
        .validation-report-content p { margin-bottom: 0.4rem; }
        .validation-report-content ul { padding-left: 1rem; margin-bottom: 0.4rem; }
        .validation-report-content li { margin-bottom: 0.2rem; }
        .validation-report-content strong { color: #fcd34d; }
        .validation-report-content code {
          background: rgba(120, 53, 15, 0.3);
          padding: 0.1rem 0.3rem;
          border-radius: 3px;
          font-size: 0.72rem;
          font-family: monospace;
        }
      `}</style>
    </div>
  );
}
