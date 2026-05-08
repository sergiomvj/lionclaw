import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Send, Square, User, Wrench, Loader2, AlertTriangle, CheckCircle2, Copy, Check, CheckCircle, Paperclip } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAppStore } from '@/stores/app-store';
import { TokenCounter } from '@/components/chat/TokenCounter';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { AskQuestionDialog } from '@/components/chat/AskQuestionDialog';
import { AskQuestionInline } from '@/components/chat/AskQuestionInline';
import { AgentThinking } from '@/components/chat/AgentThinking';
import ArtifactRenderer from '@/components/chat/ArtifactRenderer';
import { VoiceRecorder } from '@/components/chat/VoiceRecorder';
import { AudioPlayer } from '@/components/chat/AudioPlayer';
import { SlashCommandPicker, type SlashCommand } from '@/components/chat/SlashCommandPicker';
import type { ConfirmAction, AskQuestionRequest, AskQuestionResponse, ChatAttachment } from '@/types';

const SLASH_COMMANDS: SlashCommand[] = [];

export function ChatPage() {
  const {
    messages,
    streamingContent,
    isStreaming,
    toolCalls,
    artifacts,
    sendMessage,
    stopStreaming,
    currentUsage,
    sessions,
    currentSessionId,
    pendingConfirmation,
    setPendingConfirmation,
    pendingAskQuestion,
    setPendingAskQuestion,
    isCompacting,
  } = useChatStore();

  const { onboardingCompleted } = useAuthStore();
  const {
    pendingChatMessage, pendingChatAgent, clearPendingChat,
  } = useAppStore();

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const isReadOnly = (currentSession != null && currentSession.status !== 'active') || isCompacting;

  const { drafts, setDraft, clearDraft } = useChatStore();
  const sessionKey = currentSessionId || '__new__';
  const input = drafts[sessionKey] || '';
  const setInput = useCallback((text: string) => {
    setDraft(sessionKey, text);
  }, [sessionKey, setDraft]);
  const [error, setError] = useState<string | null>(null);
  const [onboardingSent, setOnboardingSent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slash command picker state
  const slashPickerRef = useRef<{ onKeyDown: (e: React.KeyboardEvent) => boolean }>({ onKeyDown: () => false });
  const slashFilter = useMemo(() => {
    const match = input.match(/^\/(\S*)$/);
    return match ? match[1] : null;
  }, [input]);
  const showSlashPicker = slashFilter !== null;

  const handleSlashSelect = useCallback((command: string) => {
    clearDraft(sessionKey);
    setError(null);
    sendMessage(command);
  }, [clearDraft, sessionKey, sendMessage]);

  const handleSlashNavigate = useCallback((handler: { onKeyDown: (e: React.KeyboardEvent) => boolean }) => {
    slashPickerRef.current = handler;
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, toolCalls]);

  // Auto-send onboarding message
  useEffect(() => {
    if (!onboardingCompleted && messages.length === 0 && !onboardingSent && !isStreaming) {
      setOnboardingSent(true);
      sendMessage('Ola! Vamos comecar.');
    }
  }, [onboardingCompleted, messages.length, onboardingSent, isStreaming, sendMessage]);

  // Reset onboardingSent flag when re-entering onboarding
  useEffect(() => {
    if (!onboardingCompleted) {
      setOnboardingSent(false);
    }
  }, [onboardingCompleted]);

  // Consume pending chat message set by other pages (e.g. SkillsPage "Criar com Assistente")
  useEffect(() => {
    if (pendingChatMessage && !isStreaming) {
      const msg = pendingChatMessage;
      const agent = pendingChatAgent || undefined;
      clearPendingChat();
      sendMessage(msg, agent);
    }
  }, [pendingChatMessage, isStreaming]);

  // Global paste handler for images (single source: works focused or not, no duplicate with textarea onPaste)
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            processImageFile(file)
              .then(att => setAttachments(prev => [...prev, att]))
              .catch(err => console.error('Failed to process pasted image:', err));
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, []);

  // Subscribe to errors
  useEffect(() => {
    const unsub = window.lionclaw.chat.onStream((chunk) => {
      if (chunk.type === 'error') {
        setError(chunk.error || 'Erro desconhecido');
        setTimeout(() => setError(null), 8000);
      }
    });
    return unsub;
  }, []);

  // Subscribe to confirm requests
  useEffect(() => {
    const unsub = window.lionclaw.chat.onConfirmRequest((action: ConfirmAction) => {
      setPendingConfirmation(action);
    });
    return unsub;
  }, [setPendingConfirmation]);

  // Subscribe to ask question requests
  useEffect(() => {
    const unsub = window.lionclaw.chat.onAskQuestion((request: AskQuestionRequest) => {
      setPendingAskQuestion(request);
    });
    return unsub;
  }, [setPendingAskQuestion]);

  const handleConfirmResponse = async (approved: boolean) => {
    if (!pendingConfirmation) return;
    await window.lionclaw.chat.confirmResponse(pendingConfirmation.id, approved);
    setPendingConfirmation(null);
  };

  const handleAskResponse = async (response: AskQuestionResponse) => {
    await window.lionclaw.chat.askResponse(response);
    setPendingAskQuestion(null);
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;
    // Allow sending while streaming - the message queue handles it
    clearDraft(sessionKey);
    setError(null);
    const atts = [...attachments];
    setAttachments([]);
    sendMessage(trimmed, undefined, atts);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let slash picker handle navigation keys when visible
    if (showSlashPicker && slashPickerRef.current.onKeyDown(e)) {
      return;
    }
    if (e.key === 'Escape' && showSlashPicker) {
      e.preventDefault();
      setInput('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const processImageFile = async (file: File): Promise<ChatAttachment> => {
    if (!file.type.startsWith('image/')) return Promise.reject('Not an image');
    if (file.size > 20 * 1024 * 1024) return Promise.reject('Image too large (max 20MB)');

    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64Data = result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    const preview = await generateThumbnail(file, 200);

    return {
      id: crypto.randomUUID(),
      type: 'image',
      filename: file.name,
      mimeType: file.type as ChatAttachment['mimeType'],
      data: base64,
      size: file.size,
      preview,
    };
  };

  const generateThumbnail = (file: File, maxSize: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const cleanup = () => URL.revokeObjectURL(url);
      const timer = setTimeout(() => { cleanup(); reject(new Error('Thumbnail generation timed out')); }, 5000);
      const img = new window.Image();
      img.onload = () => {
        clearTimeout(timer);
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        cleanup();
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('Failed to load image for thumbnail')); };
      img.src = url;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith('image/') && file.size < 20 * 1024 * 1024) {
        processImageFile(file)
          .then(att => setAttachments(prev => [...prev, att]))
          .catch(err => console.error('Failed to process selected image:', err));
      }
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        processImageFile(file)
          .then(att => setAttachments(prev => [...prev, att]))
          .catch(err => console.error('Failed to process dropped image:', err));
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const isEmpty = messages.length === 0 && !streamingContent;

  return (
    <div className="flex flex-col h-full">
      {/* Onboarding banner */}
      {!onboardingCompleted && (
        <div className="mx-4 mt-2 px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2">
          <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs text-amber-300 flex-1">Configuracao inicial - conhecendo voce</span>
          {messages.length >= 10 && !isStreaming && (
            <button
              onClick={async () => {
                await window.lionclaw.onboarding.markCompleted();
                useAuthStore.getState().checkOnboarding();
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium transition-colors shrink-0"
            >
              <CheckCircle size={12} />
              Concluir
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertTriangle size={14} className="text-red-400 shrink-0" />
          <span className="text-xs text-red-300">{error}</span>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-4">
              <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-10 h-10" />
            </div>
            <h2 className="text-xl font-semibold text-zinc-200 mb-2">LionClaw</h2>
            <p className="text-sm text-zinc-500 max-w-md mb-6">
              Seu assistente pessoal de IA. Pergunte qualquer coisa, delegue tarefas ou
              deixe-me executar acoes no seu computador.
            </p>
            <div className="flex gap-2 flex-wrap justify-center">
              {['O que voce pode fazer?', 'Qual o status do sistema?', 'Me ajude a organizar meu dia'].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="px-3 py-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            {messages.map((msg) => {
              if (msg.messageType === 'ask_question') {
                const meta = msg.metadata;
                return (
                  <div key={msg.id} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                      <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-4 h-4" />
                    </div>
                    <div className="flex-1 max-w-[85%]">
                      <AskQuestionInline
                        questions={meta?.askQuestions || []}
                        answers={meta?.askAnswers}
                      />
                    </div>
                  </div>
                );
              }
              const hasArtifacts = msg.metadata?.artifacts && msg.metadata.artifacts.length > 0;
              return (
                <div key={msg.id}>
                  <MessageBubble role={msg.role} content={msg.content} subagent={msg.subagent} attachments={msg.attachments} />
                  {hasArtifacts && msg.metadata!.artifacts!.map((artifact) => (
                    <div key={artifact.id} className="mt-3">
                      <ArtifactRenderer artifact={artifact} />
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Tool calls indicator */}
            {toolCalls.length > 0 && (
              <div className="flex gap-3 items-start">
                <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Wrench size={14} className="text-amber-500" />
                </div>
                <div className="text-xs text-zinc-500 space-y-1 py-1">
                  {toolCalls.map((tc, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      {isStreaming && i === toolCalls.length - 1 ? (
                        <Loader2 size={12} className="animate-spin text-amber-500" />
                      ) : (
                        <CheckCircle2 size={12} className="text-green-500" />
                      )}
                      <span className="font-mono">{tc.tool}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Thinking indicator (no text yet, no tools yet) */}
            {isStreaming && !streamingContent && toolCalls.length === 0 && (
              <div className="py-1 pl-10">
                <AgentThinking />
              </div>
            )}

            {/* Streaming artifacts */}
            {artifacts.length > 0 && artifacts.map((artifact) => (
              <div key={artifact.id}>
                <ArtifactRenderer artifact={artifact} />
              </div>
            ))}

            {/* Streaming content */}
            {streamingContent && (
              <MessageBubble role="assistant" content={streamingContent} isStreaming />
            )}


            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Confirm Dialog (modal overlay) */}
      {pendingConfirmation && (
        <ConfirmDialog
          action={pendingConfirmation}
          onApprove={() => handleConfirmResponse(true)}
          onDeny={() => handleConfirmResponse(false)}
        />
      )}

      {/* Ask Question Dialog (inline, above input) */}
      {pendingAskQuestion && (
        <div className="px-4">
          <AskQuestionDialog
            request={pendingAskQuestion}
            onSubmit={handleAskResponse}
          />
        </div>
      )}

      {/* Read-only banner */}
      {isReadOnly && (
        <div className="text-center py-2 text-xs text-zinc-500 bg-zinc-900/50 border-t border-zinc-800">
          {isCompacting ? 'Compactando sessao... aguarde' : 'Sessao arquivada - somente leitura'}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-zinc-800 px-4 py-3" onDrop={handleDrop} onDragOver={handleDragOver}>
        <div className="max-w-3xl mx-auto">
          {/* Token counter */}
          {currentUsage && (
            <div className="flex justify-center mb-2">
              <TokenCounter
                inputTokens={currentUsage.inputTokens}
                outputTokens={currentUsage.outputTokens}
                cacheReadTokens={currentUsage.cacheReadTokens}
                cacheCreationTokens={currentUsage.cacheCreationTokens}
                isStreaming={isStreaming}
              />
            </div>
          )}
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex gap-2 px-3 py-2 mb-2 overflow-x-auto">
              {attachments.map(att => (
                <div key={att.id} className="relative group shrink-0">
                  <img
                    src={att.preview || `data:${att.mimeType};base64,${att.data}`}
                    alt={att.filename}
                    className="w-16 h-16 object-cover rounded-lg border border-zinc-700"
                  />
                  <button
                    onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="relative flex gap-2 items-end bg-zinc-900 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-amber-500/50 transition-colors">
            <SlashCommandPicker
              commands={SLASH_COMMANDS}
              filter={slashFilter ?? ''}
              onSelect={handleSlashSelect}
              visible={showSlashPicker}
              onNavigate={handleSlashNavigate}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 transition-colors disabled:opacity-30"
              title="Anexar imagem"
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={isCompacting ? 'Compactando sessao...' : isReadOnly ? 'Sessao somente leitura' : isStreaming ? 'Digite enquanto o agente trabalha...' : 'Mensagem...'}
              rows={1}
              className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none max-h-32 selectable"
              style={{ minHeight: '24px' }}
              disabled={isReadOnly}
            />
            {isStreaming && (
              <button
                onClick={stopStreaming}
                className="p-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white transition-colors shrink-0"
                title="Parar"
              >
                <Square size={14} />
              </button>
            )}
            <button
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || isReadOnly}
              className="p-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={isStreaming ? 'Enviar para fila (Enter)' : 'Enviar (Enter)'}
            >
              <Send size={16} />
            </button>
            <VoiceRecorder
              onAudioReady={(audioBase64, transcription) => {
                const audioAttachment: ChatAttachment = {
                  id: crypto.randomUUID(),
                  type: 'audio',
                  filename: 'audio.webm',
                  mimeType: 'audio/webm',
                  data: audioBase64,
                  size: Math.ceil(audioBase64.length * 3 / 4),
                  preview: transcription,
                };
                const text = transcription || '[Audio]';
                sendMessage(text, undefined, [
                  ...attachments,
                  audioAttachment,
                ]);
                setAttachments([]);
                clearDraft(sessionKey);
              }}
              disabled={isReadOnly}
            />
          </div>
          <p className="text-[10px] text-zinc-600 text-center mt-1.5">
            {isStreaming ? 'Voce pode enviar mensagens enquanto o agente trabalha' : 'Enter para enviar, Shift+Enter para nova linha'}
          </p>
        </div>
      </div>

    </div>
  );
}

// ---- Code Block with copy button ----

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') || '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative group my-3">
      {lang && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border border-zinc-700/50 rounded-t-lg border-b-0">
          <span className="text-[10px] text-zinc-500 font-mono uppercase">{lang}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
      <pre className={`!mt-0 ${lang ? '!rounded-t-none' : ''}`}>
        <code className={className}>{children}</code>
      </pre>
      {!lang && (
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

// ---- Custom Markdown Components ----

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const isInline = !className && typeof children === 'string' && !children.includes('\n');
    if (isInline) {
      return <code className={className} {...props}>{children}</code>;
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre({ children }) {
    // Children is already a CodeBlock, just pass through
    return <>{children}</>;
  },
};

// ---- Message Bubble ----

function MessageBubble({
  role,
  content,
  isStreaming = false,
  subagent,
  attachments,
}: {
  role: string;
  content: string;
  isStreaming?: boolean;
  subagent?: string;
  attachments?: ChatAttachment[];
}) {
  const isUser = role === 'user';

  const renderedContent = useMemo(() => {
    if (isUser) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    );
  }, [content, isUser]);

  return (
    <div className={`flex gap-3 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? 'bg-zinc-700' : 'bg-amber-500/10'
        }`}
      >
        {isUser ? <User size={14} className="text-zinc-300" /> : <img src="/resources/logo-lionclaw.png" alt="LionClaw" className="w-4 h-4" />}
      </div>
      <div
        className={`rounded-xl px-4 py-3 text-sm max-w-[85%] ${
          isUser
            ? 'bg-amber-600 text-white'
            : 'bg-zinc-900 text-zinc-300 border border-zinc-800'
        }`}
      >
        {subagent && !isUser && (
          <span className="text-[10px] text-amber-500/70 font-medium uppercase block mb-1.5">
            {subagent}
          </span>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap selectable">{content}</p>
        ) : (
          <div className="chat-markdown">
            {renderedContent}
            {isStreaming && <span className="streaming-cursor" />}
          </div>
        )}
        {attachments && attachments.length > 0 && (
          <div className="flex gap-2 mt-2 flex-wrap">
            {attachments.map(att =>
              att.type === 'audio' ? (
                <div key={att.id} className="w-full">
                  <AudioPlayer
                    audioBase64={att.data}
                    mimeType={att.mimeType}
                    label="Audio enviado"
                  />
                </div>
              ) : (
                <img
                  key={att.id}
                  src={att.preview || `data:${att.mimeType};base64,${att.data}`}
                  alt={att.filename}
                  className="max-w-xs max-h-48 rounded-lg"
                />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
