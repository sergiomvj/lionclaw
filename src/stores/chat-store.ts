import { create } from 'zustand';
import type { ChatMessage, ChatSession, StreamChunk, ConfirmAction, AskQuestionRequest, ArtifactData, ChatAttachment } from '@/types';

interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isSdkCompacting: boolean;
  toolCalls: Array<{ tool: string; input: unknown }>;
  artifacts: ArtifactData[];
  currentUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null;
  streamingSessionId: string | null;
  drafts: Record<string, string>;
  pendingConfirmation: ConfirmAction | null;
  pendingAskQuestion: AskQuestionRequest | null;

  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  sendMessage: (message: string, agentId?: string, attachments?: ChatAttachment[]) => Promise<void>;
  stopStreaming: () => Promise<void>;
  handleStreamChunk: (chunk: StreamChunk) => void;
  startNewSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  compactSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string; error?: string }>;
  clearSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string }>;
  setPendingConfirmation: (action: ConfirmAction | null) => void;
  setPendingAskQuestion: (request: AskQuestionRequest | null) => void;
  setDraft: (sessionId: string, text: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  streamingContent: '',
  isStreaming: false,
  isCompacting: false,
  isSdkCompacting: false,
  toolCalls: [],
  artifacts: [],
  currentUsage: null,
  streamingSessionId: null,
  drafts: {},
  pendingConfirmation: null,
  pendingAskQuestion: null,

  loadSessions: async () => {
    const allSessions = await window.lionclaw.chat.getSessions();
    const base = allSessions.slice(0, 4);
    const { currentSessionId } = get();

    // Keep the currently selected session visible even if it falls outside the top 4.
    const current =
      currentSessionId && !base.find((s) => s.id === currentSessionId)
        ? allSessions.find((s) => s.id === currentSessionId)
        : undefined;
    const visibleSessions = current ? [current, ...base.slice(0, 3)] : base;

    if (!currentSessionId && visibleSessions.length > 0) {
      const active = visibleSessions.find((s) => s.status === 'active');
      if (active) {
        const messages = await window.lionclaw.chat.getMessages(active.id);
        set({ sessions: visibleSessions, currentSessionId: active.id, messages });
        return;
      }
    }

    set({ sessions: visibleSessions });
  },

  selectSession: async (id: string) => {
    const { currentSessionId } = get();
    if (id === currentSessionId) return;

    const messages = await window.lionclaw.chat.getMessages(id);
    set({
      currentSessionId: id,
      messages,
      streamingContent: '',
      toolCalls: [],
      artifacts: [],
      currentUsage: null,
    });
  },

  sendMessage: async (message: string, agentId?: string, attachments?: ChatAttachment[]) => {
    const { currentSessionId, isStreaming, sessions } = get();

    // Guard: block sending to non-active sessions
    if (currentSessionId) {
      const session = sessions.find((s) => s.id === currentSessionId);
      if (session && session.status !== 'active') return;
    }

    const userMsg: ChatMessage = {
      id: Date.now(),
      sessionId: currentSessionId || 'pending',
      role: 'user',
      content: message,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      createdAt: new Date().toISOString(),
    };

    if (isStreaming) {
      // Queue mode: add user message but don't reset streaming state.
      // The backend will enqueue this message and process it after the current query finishes.
      set((state) => ({
        messages: [...state.messages, userMsg],
      }));
    } else {
      // Normal mode: reset streaming state and start fresh
      set((state) => ({
        messages: [...state.messages, userMsg],
        streamingContent: '',
        isStreaming: true,
        toolCalls: [],
        currentUsage: null,
      }));
    }

    await window.lionclaw.chat.send(message, {
      sessionId: currentSessionId ?? undefined,
      agentId,
      attachments,
    });
  },

  stopStreaming: async () => {
    await window.lionclaw.chat.stop();
    set({ isStreaming: false });
  },

  handleStreamChunk: (chunk: StreamChunk) => {
    const { currentSessionId } = get();

    // FILTRO DE SESSAO: ignora chunks de outras sessoes
    const passthrough = ['session', 'error', 'onboarding_completed', 'compacting'];
    if (!passthrough.includes(chunk.type) && chunk.sessionId && currentSessionId && chunk.sessionId !== currentSessionId) {
      return;
    }

    switch (chunk.type) {
      case 'text':
        set((state) => ({
          streamingContent: state.streamingContent + (chunk.content || ''),
        }));
        break;

      case 'tool_call':
        set((state) => ({
          toolCalls: [...state.toolCalls, { tool: chunk.tool!, input: chunk.input }],
        }));
        break;

      case 'artifact':
        if (chunk.artifact) {
          set((state) => ({
            artifacts: [...state.artifacts, chunk.artifact!],
          }));
        }
        break;

      case 'usage':
        if (chunk.usage) {
          set({ currentUsage: chunk.usage });
        }
        break;

      case 'session':
        set({ currentSessionId: chunk.content || null, streamingSessionId: chunk.content || null });
        get().loadSessions();
        break;

      case 'done': {
        const doneSessionId = chunk.sessionId || chunk.content;
        const queueRemaining = chunk.queueRemaining || 0;
        Promise.resolve().then(() => {
          const { streamingContent, currentSessionId: currentSid, artifacts, toolCalls } = get();

          if (doneSessionId && currentSid && doneSessionId !== currentSid) {
            get().loadSessions();
            set({ streamingSessionId: null });
            return;
          }

          // When queue has more messages, keep isStreaming=true so the UI stays responsive
          const keepStreaming = queueRemaining > 0;

          if (streamingContent || artifacts.length > 0) {
            const assistantMsg: ChatMessage = {
              id: Date.now(),
              sessionId: doneSessionId || currentSid || '',
              role: 'assistant',
              content: streamingContent,
              metadata: {
                toolCalls: toolCalls.length > 0 ? toolCalls.map((tc) => ({ tool: tc.tool, input: JSON.stringify(tc.input), durationMs: 0 })) : undefined,
                artifacts: artifacts.length > 0 ? [...artifacts] : undefined,
              },
              createdAt: new Date().toISOString(),
            };
            set((state) => ({
              messages: [...state.messages, assistantMsg],
              streamingContent: '',
              isStreaming: keepStreaming,
              toolCalls: [],
              artifacts: [],
              streamingSessionId: keepStreaming ? state.streamingSessionId : null,
              currentSessionId: currentSid || doneSessionId || null,
            }));

            // Auto-TTS: convert response to audio if enabled
            if (streamingContent && streamingContent.length > 0) {
              window.lionclaw.settings.get().then(settings => {
                if (settings.voiceResponseEnabled && streamingContent.length < 5000) {
                  const cleanText = streamingContent
                    .replace(/```[\s\S]*?```/g, '')
                    .replace(/`[^`]+`/g, '')
                    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                    .replace(/[#*_~>]/g, '')
                    .replace(/\n{2,}/g, '. ')
                    .replace(/\n/g, ' ')
                    .trim();

                  if (cleanText.length > 10) {
                    window.lionclaw.voice.speak(cleanText, settings.voiceId)
                      .then(result => {
                        const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
                        const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
                        audio.play().catch(() => {});
                      })
                      .catch(err => console.error('Auto-TTS failed:', err));
                  }
                }
              });
            }
          } else {
            set({ isStreaming: keepStreaming, artifacts: [], streamingSessionId: keepStreaming ? get().streamingSessionId : null });
          }
          get().loadSessions();
        });
        break;
      }

      case 'replace_content':
        set({ streamingContent: chunk.content || '' });
        break;

      case 'onboarding_completed': {
        import('./auth-store').then(({ useAuthStore }) => {
          useAuthStore.getState().checkOnboarding();
        });
        break;
      }

      case 'ask_question': {
        if (chunk.askRequest) {
          const questionMsg: ChatMessage = {
            id: Date.now(),
            sessionId: get().currentSessionId || '',
            role: 'assistant',
            content: '',
            messageType: 'ask_question',
            metadata: { askQuestions: chunk.askRequest.questions },
            createdAt: new Date().toISOString(),
          };
          set((state) => ({
            messages: [...state.messages, questionMsg],
          }));
        }
        break;
      }

      case 'error':
        set({ isStreaming: false, streamingContent: '', streamingSessionId: null });
        break;

      case 'compacting':
        set({ isSdkCompacting: chunk.isCompacting ?? false });
        break;
    }
  },

  startNewSession: async () => {
    const sessions = await window.lionclaw.chat.getSessions();
    const active = sessions.find((s) => s.status === 'active');

    if (active) {
      const messages = await window.lionclaw.chat.getMessages(active.id);
      set({
        currentSessionId: active.id,
        messages,
        streamingContent: '',
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
      });
    } else {
      set({
        currentSessionId: null,
        messages: [],
        streamingContent: '',
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
      });
    }

    await get().loadSessions();
  },

  deleteSession: async (id: string) => {
    const result = await window.lionclaw.chat.deleteSession(id);
    if (result.success) {
      const { currentSessionId } = get();
      if (currentSessionId === id) {
        set({ currentSessionId: null, messages: [] });
      }
      get().loadSessions();
    } else {
      console.error('deleteSession failed:', result.error);
    }
  },

  compactSession: async () => {
    set({ isCompacting: true });
    try {
      const result = await window.lionclaw.chat.compactSession();

      if (result.success && result.newSessionId) {
        set({
          currentSessionId: result.newSessionId,
          messages: [],
          streamingContent: '',
          toolCalls: [],
          artifacts: [],
          currentUsage: null,
        });
        await get().loadSessions();
      }

      return result;
    } catch (err) {
      console.error('compactSession failed:', err);
      // Force reload sessions so UI reflects backend state
      await get().loadSessions();
      return { success: false, reason: 'ipc_error', error: String(err) };
    } finally {
      set({ isCompacting: false });
    }
  },

  clearSession: async () => {
    const result = await window.lionclaw.chat.clearSession();

    if (result.success && result.newSessionId) {
      set({
        currentSessionId: result.newSessionId,
        messages: [],
        streamingContent: '',
        toolCalls: [],
        artifacts: [],
        currentUsage: null,
      });
      await get().loadSessions();
    }

    return result;
  },

  setPendingConfirmation: (action) => set({ pendingConfirmation: action }),
  setPendingAskQuestion: (request) => set({ pendingAskQuestion: request }),

  setDraft: (sessionId: string, text: string) => {
    set((state) => ({
      drafts: { ...state.drafts, [sessionId]: text },
    }));
  },

  getDraft: (sessionId: string) => {
    return get().drafts[sessionId] || '';
  },

  clearDraft: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.drafts;
      return { drafts: rest };
    });
  },
}));
