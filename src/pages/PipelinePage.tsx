import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  PlayCircle,
  PauseCircle,
  BarChart2,
  MessageSquare,
  GitBranch,
  Clock,
  DollarSign,
  RotateCcw,
  X,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { PIPELINE_PHASES } from '@/types/pipeline';
import type { PipelinePhaseType } from '@/types';
import { PipelineProjectList } from '@/components/pipeline/PipelineProjectList';
import { PipelineProgressBar } from '@/components/pipeline/PipelineProgressBar';
import { NewPipelineModal } from '@/components/pipeline/NewPipelineModal';
import { PipelineChatView } from '@/components/pipeline/PipelineChatView';
import { PipelineStreamView } from '@/components/pipeline/PipelineStreamView';
import { PhaseActionButtons } from '@/components/pipeline/PhaseActionButtons';
import { PipelineMetricsFooter } from '@/components/pipeline/PipelineMetricsFooter';
import { SprintExecutionView } from '@/components/pipeline/SprintExecutionView';
import { PipelineMetricsReport } from '@/components/pipeline/PipelineMetricsReport';
import { DocumentPreview } from '@/components/pipeline/DocumentPreview';
import { SprintListBar } from '@/components/pipeline/SprintListBar';
import { PhaseHistoryView } from '@/components/pipeline/PhaseHistoryView';
import { ResetConfirmDialog } from '@/components/pipeline/ResetConfirmDialog';
import { AgentThinking } from '@/components/chat/AgentThinking';

// ---- Reset target type ----

type ResetTarget =
  | { phase: number; phaseName: string }
  | { sprintIndex: number; sprintTitle: string };

// ---- Phase name helper ----

function getPhaseName(phaseNumber: number): string {
  return PIPELINE_PHASES.find((p) => p.number === phaseNumber)?.name ?? `Fase ${phaseNumber}`;
}

function getPhaseType(phaseNumber: number): PipelinePhaseType {
  return PIPELINE_PHASES.find((p) => p.number === phaseNumber)?.type ?? 'auto';
}

// ---- Phases where SprintExecutionView replaces the chat view ----
const SPRINT_EXECUTION_PHASES = new Set([13, 14]);

// ---- Auto phases that produce artifacts viewable via PhaseHistoryView ----
const ARTIFACT_AUTO_PHASES = new Set<number>([2, 4, 9, 11]);

// ---- View mode tabs ----

type ViewMode = 'chat' | 'sprints' | 'metrics';

interface ViewTabProps {
  mode: ViewMode;
  active: ViewMode;
  label: string;
  icon: React.ReactNode;
  onClick: (mode: ViewMode) => void;
  disabled?: boolean;
}

function ViewTab({ mode, active, label, icon, onClick, disabled = false }: ViewTabProps) {
  const isActive = mode === active;
  return (
    <button
      onClick={() => onClick(mode)}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        isActive
          ? 'bg-amber-600 text-white'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ---- Inline confirmation dialog ----

interface InlineConfirmProps {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function InlineConfirm({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: InlineConfirmProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl px-6 py-5 max-w-sm w-full mx-4">
        <p className="text-sm text-zinc-200 mb-4 leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-yellow-600 hover:bg-yellow-500 text-white transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Read-only historical phase view ----

interface HistoricalPhaseViewProps {
  phaseNumber: number;
  projectId: string;
  onClose: () => void;
  onRequestReset: (phaseNumber: number) => void;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function HistoricalPhaseView({ phaseNumber, projectId, onClose, onRequestReset }: HistoricalPhaseViewProps) {
  const { metrics, loadPhaseHistory } = usePipelineStore();
  const [loading, setLoading] = useState(true);

  const phaseName = getPhaseName(phaseNumber);
  const phaseType = getPhaseType(phaseNumber);
  const phaseMetrics = metrics?.phases.find((p) => p.phaseNumber === phaseNumber);
  const isConversation = phaseType === 'conversation';

  // Load messages into phaseMessages[phaseNumber] via the store action
  // PipelineChatView reads from the store's getCurrentMessages() / phaseMessages
  useEffect(() => {
    setLoading(true);
    // Set viewingPhase so PipelineChatView renders this phase's messages
    usePipelineStore.setState({ viewingPhase: phaseNumber });
    loadPhaseHistory(projectId, phaseNumber)
      .finally(() => setLoading(false));
    return () => {
      // Clear viewingPhase when this historical view unmounts
      usePipelineStore.setState({ viewingPhase: null });
    };
  }, [projectId, phaseNumber, loadPhaseHistory]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Fechar historico"
        >
          <X size={16} />
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100">
            Fase {phaseNumber} - {phaseName} (concluida)
          </h1>
        </div>

        {phaseMetrics && (
          <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {formatMs(phaseMetrics.durationMs)}
            </span>
            <span className="flex items-center gap-1">
              <DollarSign size={11} />
              {formatCost(phaseMetrics.costUsd)}
            </span>
          </div>
        )}

        <button
          onClick={() => onRequestReset(phaseNumber)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors shrink-0"
        >
          <RotateCcw size={12} />
          Resetar Fase
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center flex-1 text-zinc-600 text-sm gap-2">
          <Loader2 size={14} className="animate-spin" />
          Carregando historico...
        </div>
      ) : isConversation ? (
        /* Conversation phases: use PipelineChatView with readOnly=true */
        <PipelineChatView
          showInput={false}
          readOnly={true}
        />
      ) : ARTIFACT_AUTO_PHASES.has(phaseNumber) ? (
        /* Artifact auto phases (2, 4, 9, 11): render the produced document/sprints */
        <PhaseHistoryView
          phase={phaseNumber as import('@/types').PipelinePhaseNumber}
          projectId={projectId}
        />
      ) : (
        /* Other auto phases: use PipelineStreamView (read-only, no spinner, no retry) */
        <PipelineStreamView
          phaseName={`${phaseName} (concluida)`}
        />
      )}

    </div>
  );
}

// ---- Active pipeline view ----

interface ActivePipelineViewProps {
  projectId: string;
}

function ActivePipelineView({ projectId }: ActivePipelineViewProps) {
  const {
    projects,
    currentPhase,
    phaseStatus,
    awaitingUser,
    isStreaming,
    error,
    metrics,
    phaseStatus: rawStatus,
    sprints,
    pipelineSprintIndex,
    activeDocument,
    closeProject,
    pausePipeline,
    resumePipeline,
    loadMetrics,
    closeDocument,
  } = usePipelineStore();

  const project = projects.find((p) => p.id === projectId);
  const [actionLoading, setActionLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [viewingPhase, setViewingPhase] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);

  useEffect(() => {
    loadMetrics(projectId);
  }, [projectId, loadMetrics, currentPhase]);

  // Auto-switch to sprint view when pipeline enters phases 10-11
  useEffect(() => {
    if (currentPhase !== null && SPRINT_EXECUTION_PHASES.has(currentPhase)) {
      if (viewMode === 'chat') {
        setViewMode('sprints');
      }
    }
  }, [currentPhase, viewMode]);

  // Close historical view when the phase changes (user returns to live pipeline)
  useEffect(() => {
    setViewingPhase(null);
  }, [currentPhase]);

  const handlePause = useCallback(async () => {
    setActionLoading(true);
    await pausePipeline();
    setActionLoading(false);
  }, [pausePipeline]);

  const handleResume = useCallback(async () => {
    setActionLoading(true);
    await resumePipeline();
    setActionLoading(false);
  }, [resumePipeline]);

  const handleBackClick = useCallback(() => {
    if (isStreaming) {
      setShowBackConfirm(true);
    } else {
      closeProject();
    }
  }, [isStreaming, closeProject]);

  const handleBackConfirm = useCallback(async () => {
    setShowBackConfirm(false);
    await pausePipeline();
    closeProject();
  }, [pausePipeline, closeProject]);

  const handlePhaseClick = useCallback((phaseNumber: number) => {
    // Phases 13 and 14 are sprint execution phases: redirect to sprints view
    if (phaseNumber === 13 || phaseNumber === 14) {
      setViewMode('sprints');
      return;
    }
    // Allow viewing any phase that has already been passed (phase < currentPhase)
    // or has metrics with status 'completed'
    const phaseM = metrics?.phases.find((p) => p.phaseNumber === phaseNumber);
    const isCompleted = phaseM?.status === 'completed';
    const isPast = currentPhase !== null && phaseNumber < currentPhase;
    if (isCompleted || isPast) {
      setViewingPhase(phaseNumber);
    }
  }, [metrics, currentPhase]);

  const handleSprintSelect = useCallback((sprintIndex: number) => {
    // Switch to sprints view and highlight the selected sprint
    setViewMode('sprints');
    usePipelineStore.setState({ selectedSprintTab: sprintIndex });
  }, []);

  const handlePhaseResetRequest = useCallback((phaseNumber: number) => {
    const phaseDef = PIPELINE_PHASES.find((p) => p.number === phaseNumber);
    if (!phaseDef) return;
    setResetTarget({ phase: phaseNumber, phaseName: phaseDef.name });
  }, []);

  const handleSprintResetRequest = useCallback((sprintIndex: number) => {
    const sprint = usePipelineStore.getState().sprints.find((s) => s.index === sprintIndex);
    const sprintTitle = sprint?.name ?? `Sprint ${sprintIndex + 1}`;
    setResetTarget({ sprintIndex, sprintTitle });
  }, []);

  const phaseName =
    currentPhase !== null
      ? getPhaseName(currentPhase)
      : null;

  // BUG-21: Unified UI state discriminant. Previously the header derived
  // multiple independent booleans (isPaused, isStreaming, awaitingUser, ...)
  // that could all be true at once, producing conflicting badges (e.g.
  // "Pausado" + "Processando" + "Retomar" all rendered simultaneously).
  //
  // By collapsing into one enum with a strict precedence:
  //   done > failed > streaming > awaiting-input > paused > idle
  // we guarantee the header renders exactly one state at a time. Every
  // button/badge below branches off this single value.
  //
  // `_handleProjectUpdated` keeps `project.status` in sync with the engine
  // via the `pipeline:project-updated` IPC event, so there is no window
  // where `isStreaming=true` and `status='paused'` coexist — the engine
  // emits status='running' at the entry of every phase/sprint handler.
  type PipelineUIState =
    | 'done'
    | 'failed'
    | 'streaming'
    | 'awaiting-input'
    | 'paused'
    | 'idle';

  const uiState: PipelineUIState = useMemo(() => {
    if (project?.status === 'done') return 'done';
    if (project?.status === 'failed' || project?.status === 'aborted') return 'failed';
    if (isStreaming) return 'streaming';
    if (awaitingUser) return 'awaiting-input';
    if (project?.status === 'paused') return 'paused';
    return 'idle';
  }, [project?.status, isStreaming, awaitingUser]);

  // Derived booleans kept for backward compatibility with the rest of the
  // component and with props passed to PipelineChatView etc.
  const isPaused = uiState === 'paused';
  const isDone = uiState === 'done';
  const isFailed = uiState === 'failed';

  // Detect max-loop pause
  const pausedByMaxLoops =
    rawStatus === 'paused_max_loops' || rawStatus === 'max_loops';

  // All phases where the user can send messages (conversation + phase-9 review).
  // When awaitingUser=true and phase is NOT in this set, the chat input is hidden.
  const CONVERSATION_PHASES = new Set([1, 3, 5, 6, 7, 8, 9, 10, 12]);
  const isConversationPhase = currentPhase !== null && CONVERSATION_PHASES.has(currentPhase);
  const showChatInput = (!awaitingUser || isConversationPhase) && !isDone && !isFailed;

  // Whether we are in sprint execution phases
  const inSprintPhase = currentPhase !== null && SPRINT_EXECUTION_PHASES.has(currentPhase);

  // Sprint count from the planner output (approximated from sprints array)
  const totalSprints = sprints.length > 0 ? sprints.length : 1;

  // If the user clicked a completed phase, show its read-only history
  if (viewingPhase !== null) {
    return (
      <div className="flex flex-col h-full">
        {/* Reset dialog */}
        <ResetConfirmDialog
          open={resetTarget !== null}
          target={resetTarget}
          projectId={projectId}
          onClose={() => setResetTarget(null)}
          onConfirmed={() => setResetTarget(null)}
        />
        {/* Progress bar stays visible for navigation context */}
        <PipelineProgressBar
          currentPhase={currentPhase}
          phaseStatus={phaseStatus}
          phaseMetrics={metrics?.phases}
          onPhaseClick={handlePhaseClick}
          onRequestReset={handlePhaseResetRequest}
        />
        <SprintListBar
          sprints={sprints}
          currentSprintIndex={pipelineSprintIndex}
          onSelectSprint={handleSprintSelect}
          onRequestReset={handleSprintResetRequest}
        />
        <HistoricalPhaseView
          phaseNumber={viewingPhase}
          projectId={projectId}
          onClose={() => setViewingPhase(null)}
          onRequestReset={handlePhaseResetRequest}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Confirmation dialog for back button while streaming */}
      {showBackConfirm && (
        <InlineConfirm
          message="Sair vai pausar a execucao atual. Continuar?"
          confirmLabel="Pausar e sair"
          cancelLabel="Cancelar"
          onConfirm={() => { void handleBackConfirm(); }}
          onCancel={() => setShowBackConfirm(false)}
        />
      )}

      {/* Reset confirmation dialog */}
      <ResetConfirmDialog
        open={resetTarget !== null}
        target={resetTarget}
        projectId={projectId}
        onClose={() => setResetTarget(null)}
        onConfirmed={() => setResetTarget(null)}
      />

      {/* Progress bar */}
      <PipelineProgressBar
        currentPhase={currentPhase}
        phaseStatus={phaseStatus}
        phaseMetrics={metrics?.phases}
        onPhaseClick={handlePhaseClick}
        onRequestReset={handlePhaseResetRequest}
      />

      {/* Sprint list bar */}
      <SprintListBar
        sprints={sprints}
        currentSprintIndex={pipelineSprintIndex}
        onSelectSprint={handleSprintSelect}
        onRequestReset={handleSprintResetRequest}
      />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
        <button
          onClick={handleBackClick}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Voltar a lista"
        >
          <ArrowLeft size={16} />
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-100 truncate">
            {project?.name ?? projectId}
          </h1>
          <p className="text-[11px] text-zinc-500">
            {phaseName !== null
              ? `Fase ${currentPhase}: ${phaseName}`
              : isDone
              ? 'Pipeline concluido'
              : 'Aguardando inicio...'}
          </p>
        </div>

        {/* View mode tabs */}
        <div className="flex items-center gap-1 shrink-0">
          <ViewTab
            mode="chat"
            active={viewMode}
            label="Chat"
            icon={<MessageSquare size={12} />}
            onClick={setViewMode}
          />
          <ViewTab
            mode="sprints"
            active={viewMode}
            label="Sprints"
            icon={<GitBranch size={12} />}
            onClick={setViewMode}
            disabled={!inSprintPhase && sprints.length === 0}
          />
          <ViewTab
            mode="metrics"
            active={viewMode}
            label="Metricas"
            icon={<BarChart2 size={12} />}
            onClick={setViewMode}
          />
        </div>

        {/* Status indicator — mutually exclusive by construction.
          |------------------|----------------------|----------------------|
          | uiState          | Badge                | Button               |
          |------------------|----------------------|----------------------|
          | streaming        | Processando (amber)  | Pausar               |
          | awaiting-input   | (none)               | (none — chat+Aprovar)|
          | paused           | Pausado (yellow)     | Retomar              |
          | done             | (none — header copy) | (none)               |
          | failed           | (none)               | (none)               |
          | idle             | (none)               | (none)               |
          |------------------|----------------------|----------------------|
          BUG-21: switch on a single `uiState` so the badges cannot double up.
        */}
        {uiState === 'streaming' && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400 shrink-0">
            <Loader2 size={13} className="animate-spin" />
            <span>Processando</span>
          </div>
        )}
        {uiState === 'paused' && (
          <div className="flex items-center gap-1.5 text-xs text-yellow-400 shrink-0">
            <div className="w-2 h-2 rounded-full bg-yellow-500" />
            <span>Pausado</span>
          </div>
        )}

        <div className="flex items-center gap-1 shrink-0">
          {uiState === 'paused' && (
            <button
              onClick={() => void handleResume()}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-green-400 border border-green-500/30 rounded-lg hover:bg-green-500/10 transition-colors disabled:opacity-40"
              title="Retoma reiniciando a fase atual"
            >
              <PlayCircle size={13} />
              Retomar
            </button>
          )}
          {uiState === 'streaming' && (
            <button
              onClick={() => void handlePause()}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-yellow-400 border border-yellow-500/30 rounded-lg hover:bg-yellow-500/10 transition-colors disabled:opacity-40"
              title="Pausar pipeline (aborta o agente atual)"
            >
              <PauseCircle size={13} />
              Pausar
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 shrink-0">
          <AlertCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-xs text-red-300">{error}</span>
        </div>
      )}

      {/* Main content area -- switches by viewMode */}
      {viewMode === 'metrics' ? (
        /* Metrics report -- scrollable panel */
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="max-w-5xl mx-auto">
            <PipelineMetricsReport projectId={projectId} />
          </div>
        </div>
      ) : viewMode === 'sprints' ? (
        /* Sprint execution view -- scrollable panel */
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="max-w-4xl mx-auto">
            <SprintExecutionView
              totalSprints={totalSprints}
              maxRounds={5}
              projectId={projectId}
            />
          </div>
        </div>
      ) : activeDocument !== null ? (
        /* Split-view: chat on the left, document preview on the right */
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <PipelineChatView
              showInput={showChatInput}
              isPaused={isPaused}
            />
          </div>
          <div className="w-[45%] min-w-0 shrink-0 h-full overflow-hidden">
            <DocumentPreview
              path={activeDocument.path}
              content={activeDocument.content}
              onClose={closeDocument}
            />
          </div>
        </div>
      ) : (
        /* Default: chat messages + input -- grows to fill space */
        <>
          {currentPhase !== null && ARTIFACT_AUTO_PHASES.has(currentPhase) && isStreaming && (
            <div className="flex flex-col items-center justify-center gap-4 py-12">
              <AgentThinking />
              <p className="text-muted-foreground text-sm">
                {getPhaseName(currentPhase)} em andamento...
              </p>
            </div>
          )}
          <PipelineChatView
            showInput={showChatInput}
            isPaused={isPaused}
          />
        </>
      )}

      {/* Contextual action buttons (Decidido, Aprovar, Rejeitar, etc.) */}
      {viewMode !== 'metrics' && (
        <PhaseActionButtons
          currentPhase={currentPhase}
          pausedByMaxLoops={pausedByMaxLoops}
        />
      )}

      {/* Metrics footer */}
      <PipelineMetricsFooter onExpandMetrics={() => setViewMode('metrics')} />
    </div>
  );
}

// ---- Main page ----

export default function PipelinePage() {
  const {
    projects,
    activeProjectId,
    loadProjects,
    openProject,
    closeProject,
    init,
  } = usePipelineStore();

  const [showNewModal, setShowNewModal] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  // Register IPC listeners for the lifetime of this page and do cleanup on unmount
  useEffect(() => {
    const cleanup = init();
    return cleanup;
  }, [init]);

  // Load projects on mount
  useEffect(() => {
    setIsLoadingProjects(true);
    loadProjects().finally(() => setIsLoadingProjects(false));
  }, [loadProjects]);

  const handleSelect = useCallback(async (projectId: string) => {
    await openProject(projectId);
  }, [openProject]);

  if (activeProjectId) {
    return <ActivePipelineView projectId={activeProjectId} />;
  }

  return (
    <>
      <PipelineProjectList
        projects={projects}
        isLoading={isLoadingProjects}
        onSelect={(id) => { void handleSelect(id); }}
        onNewPipeline={() => setShowNewModal(true)}
      />
      {showNewModal && (
        <NewPipelineModal
          onClose={() => setShowNewModal(false)}
          onCreated={async (projectId, startPhase) => {
            setShowNewModal(false);
            await openProject(projectId);
            await usePipelineStore.getState().startPipeline(startPhase);
          }}
        />
      )}
    </>
  );
}
