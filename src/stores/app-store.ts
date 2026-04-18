import { create } from 'zustand';

export type Page = 'chat' | 'agents' | 'skills' | 'mcp' | 'scheduler' | 'tasks' | 'channels' | 'knowledge' | 'memory' | 'logs' | 'settings' | 'rules' | 'usage' | 'permissions' | 'vault' | 'harness' | 'pipeline';

interface AppState {
  currentPage: Page;
  sidebarCollapsed: boolean;
  setPage: (page: Page) => void;
  toggleSidebar: () => void;
  pendingChatMessage: string | null;
  pendingChatAgent: string | null;
  setPendingChat: (message: string, agentId?: string) => void;
  clearPendingChat: () => void;
  // Scheduler task session viewer (stays on scheduler page)
  viewingTaskSession: string | null;
  viewingTaskRunId: number | null;
  viewingTaskName: string | null;
  openTaskSession: (sessionId: string, runId: number, taskName: string) => void;
  closeTaskSession: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'chat',
  sidebarCollapsed: false,
  setPage: (page) => set({ currentPage: page }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  pendingChatMessage: null,
  pendingChatAgent: null,
  setPendingChat: (message, agentId) => set({ pendingChatMessage: message, pendingChatAgent: agentId || null }),
  clearPendingChat: () => set({ pendingChatMessage: null, pendingChatAgent: null }),
  viewingTaskSession: null,
  viewingTaskRunId: null,
  viewingTaskName: null,
  openTaskSession: (sessionId, runId, taskName) => set({
    viewingTaskSession: sessionId,
    viewingTaskRunId: runId,
    viewingTaskName: taskName,
  }),
  closeTaskSession: () => set({
    viewingTaskSession: null,
    viewingTaskRunId: null,
    viewingTaskName: null,
  }),
}));
