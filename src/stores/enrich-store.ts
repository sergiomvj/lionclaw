// @deprecated - migrado para pipeline-engine/pipeline-store
import { create } from 'zustand';
import type { EnrichSession, EnrichPhase, EnrichStatus, EnrichMetrics, EnrichMessage as EnrichMessageRow } from '@/types';

interface EnrichMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
}

interface EnrichState {
  sessions: EnrichSession[];
  activeSessionId: string | null;
  messages: EnrichMessage[];
  isStreaming: boolean;
  currentStreamContent: string;
  currentToolCalls: Array<{ tool: string; input: unknown }>;
  currentMetrics: EnrichMetrics;

  loadSessions: () => Promise<void>;
  loadMessages: (sessionId: string, phase?: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  addUserMessage: (content: string) => void;
  appendStreamText: (text: string) => void;
  appendStreamTool: (tool: string, input: unknown) => void;
  finalizeAssistantMessage: () => void;
  setStreaming: (streaming: boolean) => void;
  updateMetrics: (metrics: Partial<EnrichMetrics>) => void;
  resetMetrics: () => void;
  clearMessages: () => void;
  updateSessionPhase: (sessionId: string, phase: EnrichPhase, status: EnrichStatus) => void;
  updateSessionFinalSpec: (sessionId: string, finalSpecPath: string) => void;
  deleteSession: (sessionId: string) => Promise<void>;
}

const emptyMetrics: EnrichMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  toolUses: 0,
  apiRequests: 0,
  messages: 0,
};

export const useEnrichStore = create<EnrichState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  currentStreamContent: '',
  currentToolCalls: [],
  currentMetrics: { ...emptyMetrics },

  loadSessions: async () => {
    const sessions = await window.lionclaw.enrich.listSessions();
    set({ sessions });
  },

  loadMessages: async (sessionId: string, phase?: string) => {
    const rows: EnrichMessageRow[] = await window.lionclaw.enrich.getMessages(sessionId, phase);
    const mapped: EnrichMessage[] = rows.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? undefined,
    }));
    set({ messages: mapped });
  },

  setActiveSession: (sessionId) => {
    set({
      activeSessionId: sessionId,
      messages: [],
      currentStreamContent: '',
      currentToolCalls: [],
      isStreaming: false,
      currentMetrics: { ...emptyMetrics },
    });
  },

  addUserMessage: (content) => {
    set((state) => ({
      messages: [...state.messages, { role: 'user', content }],
    }));
  },

  appendStreamText: (text) => {
    set((state) => ({
      currentStreamContent: state.currentStreamContent + text,
      isStreaming: true,
    }));
  },

  appendStreamTool: (tool, input) => {
    set((state) => ({
      currentToolCalls: [...state.currentToolCalls, { tool, input }],
    }));
  },

  finalizeAssistantMessage: () => {
    const { currentStreamContent, currentToolCalls } = get();
    if (!currentStreamContent && currentToolCalls.length === 0) {
      set({ isStreaming: false });
      return;
    }
    const msg: EnrichMessage = {
      role: 'assistant',
      content: currentStreamContent,
      toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
    };
    set((state) => ({
      messages: [...state.messages, msg],
      currentStreamContent: '',
      currentToolCalls: [],
      isStreaming: false,
    }));
  },

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  updateMetrics: (metrics) => {
    set((state) => ({
      currentMetrics: { ...state.currentMetrics, ...metrics },
    }));
  },

  resetMetrics: () => set({ currentMetrics: { ...emptyMetrics } }),

  clearMessages: () => {
    set({ messages: [], currentStreamContent: '', currentToolCalls: [] });
  },

  updateSessionPhase: (sessionId, phase, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, phase, status } : s
      ),
    }));
  },

  updateSessionFinalSpec: (sessionId, finalSpecPath) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, finalSpecPath, phase: 'done', status: 'done' } : s
      ),
    }));
  },

  deleteSession: async (sessionId) => {
    await window.lionclaw.enrich.delete(sessionId);
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
    }));
  },
}));
