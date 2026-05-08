import { useEffect, useState, useRef } from 'react';
import { Sidebar } from '@/components/common/Sidebar';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
import { usePipelineStore } from '@/stores/pipeline-store';
import { ChatPage } from '@/pages/ChatPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AuthPage } from '@/pages/AuthPage';
import { LogsPage } from '@/pages/LogsPage';
import { SubAgentsPage } from '@/pages/SubAgentsPage';
import { SkillsPage } from '@/pages/SkillsPage';
import { MCPServersPage } from '@/pages/MCPServersPage';
import { SchedulerPage } from '@/pages/SchedulerPage';
import { TasksPage } from '@/pages/TasksPage';
import { MemoryPage } from '@/pages/MemoryPage';
import { UsagePage } from '@/pages/UsagePage';
import { PermissionsPage } from '@/pages/PermissionsPage';
import VaultPage from '@/pages/VaultPage';
import { ChannelsPage } from '@/pages/ChannelsPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import HarnessPage from '@/pages/HarnessPage';
import PipelinePage from '@/pages/PipelinePage';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import type { ConfirmAction } from '@/types';

export function App() {
  const { isAuthenticated, isFirstRun, isLoading, checkAuth, onboardingCompleted, checkOnboarding } = useAuthStore();
  const { currentPage, setPage } = useAppStore();
  const { handleStreamChunk, loadSessions } = useChatStore();
  const { init: pipelineInit } = usePipelineStore();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const pipelineCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Subscribe to auto-lock events (sleep, lid close)
  useEffect(() => {
    const unsubLock = window.lionclaw.auth.onLocked(() => {
      checkAuth();
    });
    return unsubLock;
  }, [checkAuth]);

  // Check onboarding status after authentication
  useEffect(() => {
    if (!isAuthenticated) return;
    checkOnboarding();
  }, [isAuthenticated, checkOnboarding]);

  // Force chat page during onboarding
  useEffect(() => {
    if (isAuthenticated && !onboardingCompleted) {
      setPage('chat');
    }
  }, [isAuthenticated, onboardingCompleted, setPage]);

  // Register pipeline IPC listeners once at app-level so stream chunks are
  // never lost when the user navigates away from PipelinePage.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (pipelineCleanupRef.current) return; // already registered
    const cleanup = pipelineInit();
    pipelineCleanupRef.current = cleanup;
    // No return cleanup: listeners persist for the app lifetime.
  }, [isAuthenticated, pipelineInit]);

  // Subscribe to chat stream events
  useEffect(() => {
    if (!isAuthenticated) return;
    const unsubStream = window.lionclaw.chat.onStream(handleStreamChunk);
    const unsubConfirm = window.lionclaw.chat.onConfirmRequest((action) => {
      setConfirmAction(action);
    });
    loadSessions();
    return () => {
      unsubStream();
      unsubConfirm();
    };
  }, [isAuthenticated, handleStreamChunk, loadSessions]);

  // Subscribe to sessions-updated events (title generation, etc.)
  useEffect(() => {
    if (!isAuthenticated) return;
    const unsub = window.lionclaw.chat.onSessionsUpdated(() => {
      useChatStore.getState().loadSessions();
    });
    return unsub;
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">Carregando...</span>
        </div>
      </div>
    );
  }

  if (isFirstRun || !isAuthenticated) {
    return <AuthPage isSetup={isFirstRun} />;
  }

  const pageContent = () => {
    switch (currentPage) {
      case 'chat': return <ChatPage />;
      case 'agents': return <SubAgentsPage />;
      case 'logs': return <LogsPage />;
      case 'settings': return <SettingsPage />;
      case 'skills': return <SkillsPage />;
      case 'mcp': return <MCPServersPage />;
      case 'scheduler': return <SchedulerPage />;
      case 'tasks': return <TasksPage />;
      case 'channels': return <ChannelsPage />;
      case 'knowledge': return <KnowledgePage />;
      case 'rules': return <MemoryPage />;
      case 'memory': return <MemoryPage />;
      case 'usage': return <UsagePage />;
      case 'permissions': return <PermissionsPage />;
      case 'vault': return <VaultPage />;
      case 'harness': return <HarnessPage />;
      case 'pipeline': return <PipelinePage />;
      default: return <ChatPage />;
    }
  };

  const handleConfirmResponse = (approved: boolean) => {
    if (confirmAction) {
      window.lionclaw.chat.confirmResponse(confirmAction.id, approved);
      setConfirmAction(null);
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {pageContent()}
      </main>
      {confirmAction && (
        <ConfirmDialog
          action={confirmAction}
          onApprove={() => handleConfirmResponse(true)}
          onDeny={() => handleConfirmResponse(false)}
        />
      )}
    </div>
  );
}
