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
  Folder,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';
import { shortenModel } from '@/utils/model-display';
import { PIPELINE_PHASES, SECURITY_PIPELINE_PHASES, FEATURE_PIPELINE_PHASES, ARCHITECTURE_REVIEW_PIPELINE_PHASES } from '@/types/pipeline';
import type { PhaseDefinition } from '@/types/pipeline';
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
import { RepoProfilerView } from '@/components/pipeline/RepoProfilerView';
import { AuditMultiPanelView } from '@/components/pipeline/AuditMultiPanelView';
import { AuditFinalSummaryView } from '@/components/pipeline/AuditFinalSummaryView';
import { CodexAuthRequiredModal } from '@/components/pipeline/CodexAuthRequiredModal';
import { CodexWindowsHealthBanner } from '@/components/pipeline/CodexWindowsHealthBanner';
import { CodexWindowsPrepDialog } from '@/components/pipeline/CodexWindowsPrepDialog';
import { useCodexWindowsPrep } from '@/hooks/useCodexWindowsPrep';
import { ArchitectureReviewArtifactView } from '@/components/pipeline/ArchitectureReviewArtifactView';

// ---- Reset target type ----

type ResetTarget =
  | { phase: number; phaseName: string }
  | { sprintIndex: number; sprintTitle: string };

// ---- Phase name helper ----

function getPhaseName(phaseNumber: number, phases: readonly PhaseDefinition[] = PIPELINE_PHASES): string {
  return phases.find((p) => p.number === phaseNumber)?.name ?? `Fase ${phaseNumber}`;
}

function getPhaseType(phaseNumber: number, phases: readonly PhaseDefinition[] = PIPELINE_PHASES): PipelinePhaseType {
  return phases.find((p) => p.number === phaseNumber)?.type ?? 'auto';
}

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

// ---- Read-only historical phase view ----

interface HistoricalPhaseViewProps {
  phaseNumber: number;
  projectId: string;
  phases: readonly PhaseDefinition[];
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

function HistoricalPhaseView({ phaseNumber, projectId, phases, onClose, onRequestReset }: HistoricalPhaseViewProps) {
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const loadPhaseHistory = usePipelineStore(s => s.loadPhaseHistory);
  const projects = usePipelineStore(s => s.projects);
  const [loading, setLoading] = useState(true);

  const phaseName = getPhaseName(phaseNumber, phases);
  const phaseType = getPhaseType(phaseNumber, phases);
  const phaseMetrics = metrics?.phases.find((p) => p.phaseNumber === phaseNumber);
  const isConversation = phaseType === 'conversation';
  const projectPath = projects.find((p) => p.id === projectId)?.projectPath;

  // Artifact auto phases: auto phases that are resetable (produce viewable documents)
  const artifactAutoPhases = new Set<number>(phases.filter((p) => p.type === 'auto' && p.resetable).map((p) => p.number));

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
    <div className="flex flex-col flex-1 min-h-0">
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

        {phaseMetrics?.model && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded font-mono shrink-0 max-w-[200px]"
            title={phaseMetrics.model}
          >
            <span className="truncate">{shortenModel(phaseMetrics.model)}</span>
          </span>
        )}

        {projectPath && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 max-w-[280px]"
            title={projectPath}
          >
            <Folder size={11} className="shrink-0" />
            <span className="truncate font-mono">{projectPath}</span>
          </span>
        )}

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
      ) : artifactAutoPhases.has(phaseNumber) ? (
        /* Artifact auto phases (resetable auto phases): render the produced document/sprints */
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
  const projects = usePipelineStore(s => s.projects);
  const closeProject = usePipelineStore(s => s.closeProject);
  const pausePipeline = usePipelineStore(s => s.pausePipeline);
  const resumePipeline = usePipelineStore(s => s.resumePipeline);
  const loadMetrics = usePipelineStore(s => s.loadMetrics);
  const closeDocument = usePipelineStore(s => s.closeDocument);
  const loadSecurityAgentStatuses = usePipelineStore(s => s.loadSecurityAgentStatuses);

  const currentPhase = useActiveProjectState(s => s.currentPhase) ?? null;
  const phaseStatus = useActiveProjectState(s => s.phaseStatus) ?? '';
  const rawStatus = phaseStatus;
  const awaitingUser = useActiveProjectState(s => s.awaitingUser) ?? false;
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const error = useActiveProjectState(s => s.error) ?? null;
  const metrics = useActiveProjectState(s => s.metrics) ?? null;
  const sprints = useActiveProjectState(s => s.sprints) ?? [];
  const pipelineSprintIndex = useActiveProjectState(s => s.pipelineSprintIndex) ?? null;
  const activeDocument = useActiveProjectState(s => s.activeDocument) ?? null;
  const streamContent = useActiveProjectState(s => s.streamContent) ?? '';
  // Note: securityAgentStatuses available via useActiveProjectState(s => s.securityAgentStatuses) — atualmente nao usado neste arquivo.
  const repoManifest = useActiveProjectState(s => s.repoManifest) ?? null;
  const currentModel = useActiveProjectState(s => s.currentModel) ?? null;
  const auditAgents = useActiveProjectState(s => s.auditAgents) ?? new Map();

  const project = projects.find((p) => p.id === projectId);

  // Select phase definitions based on project pipeline type
  const pipelineType = project?.pipelineType ?? 'development';
  const phases = pipelineType === 'security'
    ? SECURITY_PIPELINE_PHASES
    : pipelineType === 'architecture-review'
      ? ARCHITECTURE_REVIEW_PIPELINE_PHASES
      : pipelineType === 'feature'
        ? FEATURE_PIPELINE_PHASES
        : PIPELINE_PHASES;

  // ---- Dynamic Sets derived from phases array ----

  const SPRINT_EXECUTION_PHASES = useMemo(
    () => new Set<number>(phases.filter((p) => p.type === 'loop').map((p) => p.number)),
    [phases],
  );

  const ARTIFACT_AUTO_PHASES = useMemo(
    () => new Set<number>(phases.filter((p) => p.type === 'auto' && p.resetable).map((p) => p.number)),
    [phases],
  );

  const CONVERSATION_PHASES_SET = useMemo(
    () => new Set<number>(phases.filter((p) => p.type === 'conversation').map((p) => p.number)),
    [phases],
  );

  const [actionLoading, setActionLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [viewingPhase, setViewingPhase] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);

  // After a renderer reload (dev HMR or app restart), zustand-persist restores
  // activeProjectId from localStorage but the per-project Map is empty, so the
  // backend data has to be re-fetched. openProject is idempotent — if the Map
  // already has data, _hydrateFlatFromMap restores it; otherwise it queries
  // the backend.
  const openProject = usePipelineStore(s => s.openProject);
  useEffect(() => {
    if (currentPhase === null) {
      void openProject(projectId);
    }
    // Run only when projectId changes; currentPhase null check is the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, openProject]);

  // SPEC-codex-windows-fix.md Camada 2: hook de check + dialog. Mac no-op.
  const codexPrep = useCodexWindowsPrep();
  useEffect(() => {
    if (project?.projectPath) {
      void codexPrep.checkProject(project.projectPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.projectPath]);

  useEffect(() => {
    loadMetrics(projectId);
  }, [projectId, loadMetrics, currentPhase]);

  // Hydrate security agent statuses from DB when opening a security project at phase 2
  useEffect(() => {
    if (project?.pipelineType === 'security' && currentPhase === 2) {
      void loadSecurityAgentStatuses(projectId);
    }
  }, [project?.pipelineType, currentPhase, projectId, loadSecurityAgentStatuses]);

  // Auto-switch to sprint view when pipeline enters loop phases (coder/evaluator)
  useEffect(() => {
    if (currentPhase !== null && SPRINT_EXECUTION_PHASES.has(currentPhase)) {
      if (viewMode === 'chat') {
        setViewMode('sprints');
      }
    }
  }, [currentPhase, viewMode, SPRINT_EXECUTION_PHASES]);

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

  const handleBack = useCallback(() => {
    closeProject();
  }, [closeProject]);

  const handlePhaseClick = useCallback((phaseNumber: number) => {
    // Loop phases (coder/evaluator) redirect to sprints view
    if (SPRINT_EXECUTION_PHASES.has(phaseNumber)) {
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
  }, [metrics, currentPhase, SPRINT_EXECUTION_PHASES]);

  const handleSprintSelect = useCallback((sprintIndex: number) => {
    // Switch to sprints view and highlight the selected sprint.
    // Use the store action so the change persists in the per-project Map and
    // survives _hydrateFlatFromMap (otherwise stream events revert it to 0).
    setViewMode('sprints');
    usePipelineStore.getState().setSelectedSprintTab(sprintIndex);
  }, []);

  const handlePhaseResetRequest = useCallback((phaseNumber: number) => {
    const phaseDef = phases.find((p) => p.number === phaseNumber);
    if (!phaseDef) return;
    setResetTarget({ phase: phaseNumber, phaseName: phaseDef.name });
  }, [phases]);

  const handleSprintResetRequest = useCallback((sprintIndex: number) => {
    const sprint = usePipelineStore.getState().sprints.find((s) => s.index === sprintIndex);
    const sprintTitle = sprint?.name ?? `Sprint ${sprintIndex + 1}`;
    setResetTarget({ sprintIndex, sprintTitle });
  }, []);

  const phaseName =
    currentPhase !== null
      ? getPhaseName(currentPhase, phases)
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
    | 'aborted'
    | 'interrupted'
    | 'streaming'
    | 'awaiting-input'
    | 'paused'
    | 'idle';

  const uiState: PipelineUIState = useMemo(() => {
    if (project?.status === 'done') return 'done';
    if (project?.status === 'failed') return 'failed';
    if (project?.status === 'aborted') return 'aborted';
    if (project?.status === 'interrupted') return 'interrupted';
    if (isStreaming) return 'streaming';
    if (awaitingUser) return 'awaiting-input';
    if (project?.status === 'paused') return 'paused';
    return 'idle';
  }, [project?.status, isStreaming, awaitingUser]);

  // Derived booleans kept for backward compatibility with the rest of the
  // component and with props passed to PipelineChatView etc.
  const isPaused = uiState === 'paused';
  const isDone = uiState === 'done';
  // Estados terminais que escondem chat/avancos: failed/aborted/interrupted.
  const isFailed = uiState === 'failed' || uiState === 'aborted' || uiState === 'interrupted';

  // Detect max-loop pause
  const pausedByMaxLoops =
    rawStatus === 'paused_max_loops' || rawStatus === 'max_loops';

  // All phases where the user can send messages (conversation phases derived from phases array).
  // When awaitingUser=true and phase is NOT in this set, the chat input is hidden.
  const isConversationPhase = currentPhase !== null && CONVERSATION_PHASES_SET.has(currentPhase);
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
          phases={phases}
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
          phases={phases}
          onClose={() => setViewingPhase(null)}
          onRequestReset={handlePhaseResetRequest}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Codex auth-required modal — listens globally via IPC; visible when token expires mid-pipeline */}
      <CodexAuthRequiredModal />

      {/* SPEC-codex-windows-fix.md Camada 3: warnings via canal IPC proprio (NUNCA via stream do agente) */}
      <CodexWindowsHealthBanner
        onOpenHealthCheck={(payload) => {
          codexPrep.openFromWarning(payload.repoRoot, payload.issues);
        }}
      />

      {/* SPEC-codex-windows-fix.md Camada 2: dialog de opt-in pra prep Windows */}
      {codexPrep.checkResult?.needs && (
        <CodexWindowsPrepDialog
          check={codexPrep.checkResult}
          onClose={codexPrep.dismiss}
          onDone={codexPrep.handleDialogDone}
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
        phases={phases}
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
          onClick={handleBack}
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
        {currentModel && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded font-mono shrink-0 max-w-[200px]"
            title={currentModel}
          >
            <span className="truncate">{shortenModel(currentModel)}</span>
          </span>
        )}

        {project?.projectPath && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-zinc-500 shrink-0 max-w-[280px]"
            title={project.projectPath}
          >
            <Folder size={11} className="shrink-0" />
            <span className="truncate font-mono">{project.projectPath}</span>
          </span>
        )}

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
      ) : pipelineType === 'architecture-review' && currentPhase !== null && currentPhase >= 1 && currentPhase <= 4 ? (
        /* Architecture-review fases 1-4: split view com chat + view rica do artefato */
        <ArchitectureReviewSplitView
          projectId={projectId}
          phase={currentPhase}
          showChatInput={showChatInput}
          isPaused={isPaused}
          selectedCandidateId={project?.metadata && typeof project.metadata['architectureReview'] === 'object' && project.metadata['architectureReview'] !== null
            ? (project.metadata['architectureReview'] as Record<string, unknown>)['selectedCandidateId'] as string | null | undefined
            : null}
        />
      ) : pipelineType === 'security' && currentPhase === 1 ? (
        /* Security fase 1: Repo Profiler -- shows manifest summary or streaming output */
        <RepoProfilerView
          manifest={repoManifest}
          isStreaming={isStreaming}
          streamContent={streamContent}
          projectId={projectId}
        />
      ) : pipelineType === 'security' && currentPhase === 2 ? (
        /* Security fase 2: multi-panel audit agents view */
        (() => {
          const TOTAL_AUDIT = 7;
          const allDone = auditAgents.size >= TOTAL_AUDIT && Array.from(auditAgents.values())
            .every(a => a.status === 'completed' || a.status === 'failed');
          return allDone
            ? <AuditFinalSummaryView />
            : <AuditMultiPanelView isStreaming={isStreaming} />;
        })()
      ) : activeDocument !== null ? (
        /* Split-view: chat on the left, document preview on the right.
           Triggered for security fase 4 (Validador Cetico) when the backend
           emits pipeline:document-updated with the consolidated Security report,
           and for dev pipeline phases that produce documents (phases 3, 9, etc.). */
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
                {getPhaseName(currentPhase, phases)} em andamento...
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

// ---- Architecture-review split view (chat + rich artefact view) ----

function ArchitectureReviewSplitView({
  projectId,
  phase,
  showChatInput,
  isPaused,
  selectedCandidateId,
}: {
  projectId: string;
  phase: number;
  showChatInput: boolean;
  isPaused: boolean;
  selectedCandidateId?: string | null;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const approvePhase = usePipelineStore((s) => s.approvePhase);

  // Load artefact pair (MD + JSON) for the current phase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
        if (cancelled) return;
        if (result && typeof result === 'object' && 'type' in result && result.type === 'architecture') {
          const r = result as { type: 'architecture'; phase: number; markdown: string | null; json: string | null };
          setMarkdown(r.markdown);
          setJson(r.json);
        } else if (result && typeof result === 'object' && 'type' in result && result.type === 'markdown') {
          setMarkdown((result as { type: 'markdown'; content: string }).content);
          setJson(null);
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, phase]);

  // Re-load when document-updated comes in for this phase.
  useEffect(() => {
    const off = window.lionclaw.pipeline.onDocumentUpdated((evt) => {
      if (evt.projectId !== projectId) return;
      // Re-fetch artefact pair (cheap).
      void (async () => {
        const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
        if (result && typeof result === 'object' && 'type' in result && result.type === 'architecture') {
          const r = result as { type: 'architecture'; phase: number; markdown: string | null; json: string | null };
          setMarkdown(r.markdown);
          setJson(r.json);
        }
      })();
    });
    return () => { off?.(); };
  }, [projectId, phase]);

  const handleSelectCandidate = async (candidateId: string) => {
    console.log('[architecture-review] selecting candidate', candidateId);
    setApproveError(null);
    setApproving(true);
    try {
      await approvePhase({ selectedCandidateId: candidateId });
      // After successful approve, the store sets error if backend rejected.
      const storeError = usePipelineStore.getState().error;
      if (storeError) {
        console.error('[architecture-review] approve failed:', storeError);
        setApproveError(storeError);
      } else {
        console.log('[architecture-review] approve OK');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[architecture-review] approve threw:', msg);
      setApproveError(msg);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <PipelineChatView showInput={showChatInput} isPaused={isPaused} />
      </div>
      <div className="w-[45%] min-w-0 shrink-0 h-full overflow-y-auto bg-zinc-950 border-l border-zinc-800">
        {approveError && (
          <div className="m-3 p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-200">
            <div className="font-semibold mb-1">Falha ao aprovar candidato:</div>
            <div className="font-mono break-all">{approveError}</div>
            <button
              onClick={() => setApproveError(null)}
              className="mt-2 px-2 py-1 text-[10px] bg-red-900 hover:bg-red-800 rounded"
            >
              fechar
            </button>
          </div>
        )}
        {approving && (
          <div className="m-3 p-3 bg-blue-950/40 border border-blue-800 rounded text-xs text-blue-200">
            Aprovando candidato...
          </div>
        )}
        <ArchitectureReviewArtifactView
          phase={phase}
          markdownContent={markdown}
          jsonContent={json}
          onSelectCandidate={phase === 2 ? handleSelectCandidate : undefined}
          selectedCandidateId={selectedCandidateId}
        />
      </div>
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
  } = usePipelineStore();

  const [showNewModal, setShowNewModal] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  // SPEC P1.1: hook do prep Windows pro fluxo de criacao de projeto.
  // Instancia separada da que vive em ActivePipelineView — cada componente cobre
  // um momento distinto do ciclo de vida (criacao vs abertura). State isolado.
  const codexPrep = useCodexWindowsPrep();

  // IPC listeners are registered once in App.tsx (init() moved there to avoid
  // losing pipeline:stream chunks when the user navigates away from PipelinePage).

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

            // SPEC P1.1: gate ANTES de openProject. Razao: openProject seta
            // activeProjectId → proximo render cai em <ActivePipelineView />
            // (early return em linha 786-788). Se chamarmos check apos
            // openProject, este componente outer nao monta mais o dialog.
            // Solucao: rodar check primeiro (com dialog mountavel aqui),
            // entao apos decisao do usuario, abrir + startar.
            const created = usePipelineStore.getState().projects.find((p) => p.id === projectId);
            const finishUp = async (): Promise<void> => {
              await openProject(projectId);
              await usePipelineStore.getState().startPipeline(startPhase);
            };

            if (!created?.projectPath) {
              void finishUp();
              return;
            }

            // ensureCheckedThen agenda finishUp pra rodar apos check + dialog (se aparecer).
            // Se nao precisa de prep, roda imediato. Mac sempre cai no nao-precisa.
            void codexPrep.ensureCheckedThen(created.projectPath, finishUp);
          }}
        />
      )}

      {/* SPEC P1.1: dialog de prep aparece se ensureCheckedThen detectar issues.
          Renderizado ANTES de openProject acontecer — outer component ainda visivel. */}
      {codexPrep.checkResult?.needs && (
        <CodexWindowsPrepDialog
          check={codexPrep.checkResult}
          onClose={codexPrep.dismiss}
          onDone={codexPrep.handleDialogDone}
        />
      )}
    </>
  );
}
