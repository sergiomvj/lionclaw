import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const MAX_PROJECT_STATES_IN_MEMORY = 20;
import type {
  PipelineProject,
  PipelineMessage,
  PipelineStreamChunk,
  PipelinePhaseChangedEvent,
  PipelineNotesUpdatedEvent,
  PipelineSprintCompleteEvent,
  PipelineProjectUpdatedEvent,
  PipelineMetricsResult,
  ChatAttachment,
  SecurityAgentStatus,
  SecurityAgentStatusEvent,
  RepoManifest,
  PipelineType,
  PipelineConversationPhases,
} from '@/types';
import type { AuditAgentState, AuditPanelSlots, PipelineAuditAgentProgressEvent } from '@/types/pipeline';

// Estado plano permanece como ESPELHO do project ativo durante migração progressiva (Sprint A2-A3-A4).
// setProjectState(activeProjectId, patch) também aplica ao state plano para manter consistência.
// Remover espelho ao final da Sprint A4 quando todos os componentes consumirem via useActiveProjectState.

// ---- Sprint status tracked per sprint index ----

export interface SprintStatus {
  index: number;
  name: string;
  verdict: string;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  sprintJsonId?: string;
  sprintId?: string;
  reportPath?: string;
  rounds?: number;
  metrics?: Record<string, unknown>;
}

// ---- Live phase metrics (from usage stream events) ----

export interface LivePhaseMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// ---- Phase document metadata ----

export interface PhaseDocumentInfo {
  path: string;
  label: string;
}

// ---- Artifact cache entry ----

export interface ArtifactCacheEntry {
  type: 'markdown' | 'sprints' | 'architecture';
  content?: string;
  sprints?: unknown[];
  // architecture-review variant (phases 1-4): MD + JSON pair for rich rendering.
  phase?: number;
  markdown?: string | null;
  json?: string | null;
}

// ---- Per-project runtime state (infrastructure for progressive multi-project migration) ----

export interface PerProjectState {
  currentPhase: number | null;
  phaseStatus: string;
  awaitingUser: boolean;
  agentCompleted: boolean;
  phaseMessages: Record<number, PipelineMessage[]>;
  viewingPhase: number | null;
  streamContent: string;
  currentToolCalls: Array<{ tool: string; input: unknown }>;
  isStreaming: boolean;
  coderStream: Array<{ type: string; content?: string; tool?: string }>;
  evaluatorStream: Array<{ type: string; content?: string; tool?: string }>;
  currentRound: number;
  currentAgent: string;
  notesPath: string | null;
  notesContent: string | null;
  sprints: SprintStatus[];
  metrics: PipelineMetricsResult | null;
  phaseMetrics: LivePhaseMetrics | null;
  activeDocument: { path: string; content: string } | null;
  phaseDocuments: Record<number, PhaseDocumentInfo | null>;
  selectedSprintTab: number;
  pipelineSprintIndex: number | null;
  error: string | null;
  securityAgentStatuses: SecurityAgentStatus[];
  repoManifest: RepoManifest | null;
  currentModel: string | null;
  auditAgents: Map<string, AuditAgentState>;
  auditPanelSlots: AuditPanelSlots;
  /** Set to true when the engine emits pipeline:stalled (agent stuck for 3min). */
  stalled: boolean;
}

// ---- Store state ----

interface PipelineState {
  // Project list
  projects: PipelineProject[];
  activeProjectId: string | null;

  // Per-project state map (Sprint A2 infrastructure; flat fields below are the mirror of the active project)
  projectStates: Map<string, PerProjectState>;

  // GC LRU: tracks last access time per project for eviction
  _lastTouchedAt: Map<string, number>;

  // Pipeline runtime state
  currentPhase: number | null;
  phaseStatus: string;
  awaitingUser: boolean;
  agentCompleted: boolean;

  // Per-phase conversation (UI-19: replaces single messages array)
  phaseMessages: Record<number, PipelineMessage[]>;

  // Phase history navigation (UI-17)
  viewingPhase: number | null;

  // Streaming
  streamContent: string;
  currentToolCalls: Array<{ tool: string; input: unknown }>;
  isStreaming: boolean;

  // Split streams for coder/evaluator (phases 13/14)
  coderStream: Array<{ type: string; content?: string; tool?: string }>;
  evaluatorStream: Array<{ type: string; content?: string; tool?: string }>;

  // Real-time round counter (updated via pipeline:sprint-round events)
  currentRound: number;
  currentAgent: string;

  // Notes file (phase 1 output)
  notesPath: string | null;
  notesContent: string | null;

  // Sprints (phase 11+)
  sprints: SprintStatus[];

  // Metrics (loaded on demand)
  metrics: PipelineMetricsResult | null;

  // Live metrics accumulated from usage stream events in current phase
  phaseMetrics: LivePhaseMetrics | null;

  // Active document for split-view (set when pipeline:document-updated is received)
  activeDocument: { path: string; content: string } | null;

  // Per-phase document tracking (UI-20)
  phaseDocuments: Record<number, PhaseDocumentInfo | null>;

  // Selected sprint tab (UI-18: persisted in store to survive remounts)
  selectedSprintTab: number;

  // Active sprint index from backend (UI-03: received via phase-changed metadata)
  pipelineSprintIndex: number | null;

  // Error
  error: string | null;

  // Security pipeline: status dos agentes da fase 2 (paralela)
  securityAgentStatuses: SecurityAgentStatus[];

  // Security pipeline: resultado da fase 1 (Repo Profiler)
  repoManifest: RepoManifest | null;

  // Multi-panel security audit: per-agent state and panel slot assignment
  auditAgents: Map<string, AuditAgentState>;
  auditPanelSlots: AuditPanelSlots;

  // Stall detection: set to true when pipeline:stalled is received (agent stuck for 3min)
  stalled: boolean;

  // Modelo atual do agente em execucao (atualizado via pipeline:phase-changed currentModel).
  // Espelha o campo plano de PerProjectState pra que a UI ativa exiba o badge sem refetch.
  currentModel: string | null;

  // Conversation phases: populated on boot from pipeline:get-conversation-phases
  conversationPhases: PipelineConversationPhases;

  // Cache for phase artifacts (markdown content or sprint data)
  artifactCache: Record<string, Record<number, ArtifactCacheEntry | undefined>>;

  // Cache for sprint execution history
  sprintHistoryCache: Record<string, Record<number, unknown[] | undefined>>;

  // ---- Computed getters ----

  /** Returns messages for the currently viewed phase (or current phase if not viewing history). */
  getCurrentMessages: () => PipelineMessage[];

  // ---- Actions ----

  /** Load all pipeline projects. */
  loadProjects: () => Promise<void>;

  /** Load metrics for a given project. */
  loadMetrics: (projectId: string) => Promise<void>;

  /** Create a new pipeline project. Throws on failure. */
  createProject: (data: {
    name: string;
    description: string;
    projectPath: string;
    startPhase: number;
    specPath?: string;
    prdPath?: string;
    pipelineType?: PipelineType;
  }) => Promise<string>;

  /** Load security agent statuses for a project (fase 2). */
  loadSecurityAgentStatuses: (projectId: string) => Promise<void>;

  /** Rehydrate auditAgents map from DB when opening a security project post-audit. */
  loadAuditAgents: (projectId: string) => Promise<void>;

  /** Handle real-time security agent status update (pipeline:security-agent-status). */
  handleSecurityAgentStatus: (event: SecurityAgentStatusEvent) => void;

  /** Delete a pipeline project by ID. */
  deleteProject: (projectId: string) => Promise<void>;

  /** Set the active project and reset runtime state (alias for backwards compat). */
  setActiveProject: (projectId: string | null) => void;

  /** Open a project: set active ID and reload its phase state from IPC. */
  openProject: (projectId: string) => Promise<void>;

  /** Close the active project and reset all runtime state. */
  closeProject: () => void;

  /** Start the pipeline for the active project from the given phase. */
  startPipeline: (startPhase: number) => Promise<void>;

  /** Send a user message to the currently running phase. */
  sendMessage: (message: string, attachments?: ChatAttachment[]) => Promise<void>;

  /** Approve the current phase (advance to next). */
  approvePhase: (metadata?: Record<string, unknown>) => Promise<void>;

  /** Close the active document preview panel. */
  closeDocument: () => void;

  /** Set agentCompleted flag (called when pipeline:agent-completed is received). */
  _handleAgentCompleted: (projectId: string) => void;

  /** Handle pipeline:document-updated event. */
  _handleDocumentUpdated: (data: { projectId: string; path: string; content: string }) => void;

  /** Confirm start of development after phase 9 approval (proceeds to phase 11). */
  confirmDevelopment: () => Promise<void>;

  /** Abort the running pipeline. */
  abortPipeline: () => Promise<void>;

  /** Pause a running pipeline. */
  pausePipeline: () => Promise<void>;

  /** Resume a paused pipeline. */
  resumePipeline: () => Promise<void>;

  /** Retry the current failed/interrupted phase. */
  retryPhase: () => Promise<void>;

  // ---- Phase history navigation (UI-17) ----

  /** Set the phase being viewed for history. Pass null to return to live view. */
  setViewingPhase: (phase: number | null) => void;

  /** Load messages for a specific phase from IPC and store in phaseMessages. */
  loadPhaseHistory: (projectId: string, phase: number) => Promise<void>;

  // ---- Phase document actions (UI-20) ----

  /** Open the document for a specific phase (reads from IPC, sets activeDocument). */
  openPhaseDocument: (phase: number) => Promise<void>;

  // ---- Sprint tab persistence (UI-18) ----

  /** Set the selected sprint tab index. */
  setSelectedSprintTab: (tab: number) => void;

  // ---- Reset actions ----

  /** Reset a phase (calls IPC, invalidates caches, re-hydrates project). */
  resetPhase: (projectId: string, phase: number) => Promise<{ ok: boolean; error?: string }>;

  /** Reset a sprint (calls IPC, invalidates caches, re-hydrates project). */
  resetSprint: (projectId: string, sprintIndex: number) => Promise<{ ok: boolean; error?: string }>;

  /** Get reset preview (passthrough to IPC). */
  getResetPreview: (projectId: string, target: { phase?: number; sprintIndex?: number }) => Promise<unknown>;

  /** Load phase artifact for PhaseHistoryView and store in artifactCache. */
  loadPhaseArtifact: (projectId: string, phase: number) => Promise<void>;

  /** Load sprint execution history and store in sprintHistoryCache. */
  loadSprintHistory: (projectId: string, sprintIndex: number) => Promise<void>;

  // ---- Utility selectors ----

  /** Returns true if the given phase accepts manual user messages for the given pipeline type. */
  isConversationPhase: (phase: number | null, pipelineType?: string) => boolean;

  /** Returns true if the project's current phase is a tech phase (5-8). */
  isInTechPhase: (projectId: string) => boolean;

  /** Returns true if the project's current phase is an execution phase (11-14). */
  isInExecutionPhase: (projectId: string) => boolean;

  // ---- Per-project state helpers (Sprint A2 infrastructure) ----

  /** Returns a fresh PerProjectState with all fields set to their default values. */
  _createEmptyProjectState: () => PerProjectState;

  /** Merges patch into projectStates[projectId] and, if projectId === activeProjectId, also applies patch to flat state. */
  _setProjectState: (projectId: string, patch: Partial<PerProjectState>) => void;

  /** Returns existing projectStates[projectId] or creates and stores an empty one, idempotent. */
  _ensureProjectState: (projectId: string) => PerProjectState;

  /** Hydrate flat state from the Map entry for projectId. No-op if entry does not exist. */
  _hydrateFlatFromMap: (projectId: string) => void;

  // ---- Internal helpers (used by init listeners) ----
  _appendStreamText: (projectId: string, text: string) => void;
  _appendStreamTool: (projectId: string, tool: string, input: unknown) => void;
  _finalizeAssistantMessage: (projectId: string) => void;
  _appendAgentStream: (projectId: string, agent: string, entry: { type: string; content?: string; tool?: string }) => void;
  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => void;
  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => void;
  _handleNotesUpdated: (event: PipelineNotesUpdatedEvent) => void;
  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => void;
  _handleSprintUpdated: (data: { sprintIndex: number; status: string; round: number }) => void;
  _handleSprintRound: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void;
  _handleStreamError: (projectId: string, message: string) => void;
  _handleStreamUsage: (projectId: string, usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  }) => void;
  _invalidateCaches: (projectId: string) => void;

  /** Register all IPC listeners. Returns a cleanup function for useEffect. */
  init: () => () => void;
}

// ---- Initial values ----

const initialRuntimeState = {
  currentPhase: null as number | null,
  phaseStatus: '',
  awaitingUser: false,
  agentCompleted: false,
  phaseMessages: {} as Record<number, PipelineMessage[]>,
  viewingPhase: null as number | null,
  streamContent: '',
  currentToolCalls: [] as Array<{ tool: string; input: unknown }>,
  isStreaming: false,
  coderStream: [] as Array<{ type: string; content?: string; tool?: string }>,
  evaluatorStream: [] as Array<{ type: string; content?: string; tool?: string }>,
  currentRound: 0,
  currentAgent: '',
  notesPath: null as string | null,
  notesContent: null as string | null,
  sprints: [] as SprintStatus[],
  metrics: null as PipelineMetricsResult | null,
  phaseMetrics: null as LivePhaseMetrics | null,
  activeDocument: null as { path: string; content: string } | null,
  phaseDocuments: {} as Record<number, PhaseDocumentInfo | null>,
  selectedSprintTab: 0,
  pipelineSprintIndex: null as number | null,
  error: null as string | null,
  securityAgentStatuses: [] as SecurityAgentStatus[],
  repoManifest: null as RepoManifest | null,
  currentModel: null as string | null,
  auditAgents: new Map<string, AuditAgentState>(),
  auditPanelSlots: [null, null, null] as AuditPanelSlots,
  stalled: false,
};

// ---- Slot rotation helper (multi-panel security audit) ----

function assignAgentToPanel(
  slots: AuditPanelSlots,
  newAgent: string,
  auditAgents: Map<string, AuditAgentState>,
): AuditPanelSlots {
  if (slots.includes(newAgent)) return slots;
  const next: [string | null, string | null, string | null] = [slots[0], slots[1], slots[2]];
  const emptyIdx = next.findIndex(
    (s) => s === null || auditAgents.get(s)?.status === 'completed' || auditAgents.get(s)?.status === 'failed',
  );
  if (emptyIdx >= 0) {
    next[emptyIdx] = newAgent;
    return next as AuditPanelSlots;
  }
  return slots;
}

export { assignAgentToPanel };

// ---- Store ----

export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
  projects: [],
  activeProjectId: null,
  projectStates: new Map<string, PerProjectState>(),
  _lastTouchedAt: new Map<string, number>(),
  artifactCache: {},
  sprintHistoryCache: {},
  conversationPhases: {
    security:     [4, 5, 7, 9],
    dev:          [1, 3, 5, 6, 7, 8, 9, 10, 12],
    architecture: [2, 4, 6, 7, 9],
  },
  ...initialRuntimeState,

  // ---- Per-project state helpers (Sprint A2 infrastructure) ----

  _createEmptyProjectState: (): PerProjectState => ({
    currentPhase: null,
    phaseStatus: '',
    awaitingUser: false,
    agentCompleted: false,
    phaseMessages: {},
    viewingPhase: null,
    streamContent: '',
    currentToolCalls: [],
    isStreaming: false,
    coderStream: [],
    evaluatorStream: [],
    currentRound: 0,
    currentAgent: '',
    notesPath: null,
    notesContent: null,
    sprints: [],
    metrics: null,
    phaseMetrics: null,
    activeDocument: null,
    phaseDocuments: {},
    selectedSprintTab: 0,
    pipelineSprintIndex: null,
    error: null,
    securityAgentStatuses: [],
    repoManifest: null,
    currentModel: null,
    auditAgents: new Map<string, AuditAgentState>(),
    auditPanelSlots: [null, null, null] as AuditPanelSlots,
    stalled: false,
  }),

  _setProjectState: (projectId: string, patch: Partial<PerProjectState>) => {
    set((state) => {
      const prev = state.projectStates.get(projectId) ?? get()._createEmptyProjectState();
      const next: PerProjectState = { ...prev, ...patch };
      const newMap = new Map(state.projectStates);
      newMap.set(projectId, next);

      // GC LRU: update last-touched timestamp
      const newTouched = new Map(state._lastTouchedAt);
      newTouched.set(projectId, Date.now());

      // GC LRU: evict oldest non-active, non-streaming entries when over limit
      if (newMap.size > MAX_PROJECT_STATES_IN_MEMORY) {
        const activeId = state.activeProjectId;
        const candidates = [...newMap.entries()]
          .filter(([id, ps]) => id !== activeId && !ps.isStreaming)
          .sort((a, b) => (newTouched.get(a[0]) ?? 0) - (newTouched.get(b[0]) ?? 0));
        const toRemove = newMap.size - MAX_PROJECT_STATES_IN_MEMORY;
        for (let i = 0; i < toRemove && i < candidates.length; i++) {
          newMap.delete(candidates[i][0]);
          newTouched.delete(candidates[i][0]);
        }
      }

      // Mirror to flat state when the patch targets the active project
      if (projectId === state.activeProjectId) {
        return { projectStates: newMap, _lastTouchedAt: newTouched, ...patch } as Partial<PipelineState> & { projectStates: Map<string, PerProjectState>; _lastTouchedAt: Map<string, number> };
      }
      return { projectStates: newMap, _lastTouchedAt: newTouched };
    });
  },

  _ensureProjectState: (projectId: string): PerProjectState => {
    const existing = get().projectStates.get(projectId);
    if (existing !== undefined) return existing;
    const empty = get()._createEmptyProjectState();
    set((state) => {
      const newMap = new Map(state.projectStates);
      newMap.set(projectId, empty);
      return { projectStates: newMap };
    });
    return empty;
  },

  // ---------------------------------------------------------------------------
  // _hydrateFlatFromMap: Pull all fields from the Map entry into flat state.
  // Used by setActiveProject and openProject to keep both in sync.
  // ---------------------------------------------------------------------------
  _hydrateFlatFromMap: (projectId: string): void => {
    const entry = get().projectStates.get(projectId);
    if (!entry) return;
    set({
      currentPhase: entry.currentPhase,
      phaseStatus: entry.phaseStatus,
      awaitingUser: entry.awaitingUser,
      agentCompleted: entry.agentCompleted,
      phaseMessages: entry.phaseMessages,
      viewingPhase: entry.viewingPhase,
      streamContent: entry.streamContent,
      currentToolCalls: entry.currentToolCalls,
      isStreaming: entry.isStreaming,
      coderStream: entry.coderStream,
      evaluatorStream: entry.evaluatorStream,
      currentRound: entry.currentRound,
      currentAgent: entry.currentAgent,
      notesPath: entry.notesPath,
      notesContent: entry.notesContent,
      sprints: entry.sprints,
      metrics: entry.metrics,
      phaseMetrics: entry.phaseMetrics,
      activeDocument: entry.activeDocument,
      phaseDocuments: entry.phaseDocuments,
      selectedSprintTab: entry.selectedSprintTab,
      pipelineSprintIndex: entry.pipelineSprintIndex,
      error: entry.error,
      securityAgentStatuses: entry.securityAgentStatuses,
      repoManifest: entry.repoManifest,
      currentModel: entry.currentModel,
      auditAgents: entry.auditAgents,
      auditPanelSlots: entry.auditPanelSlots,
      stalled: entry.stalled,
    });
  },

  // ---- Computed getter ----

  getCurrentMessages: () => {
    const { phaseMessages, viewingPhase, currentPhase } = get();
    const phase = viewingPhase ?? currentPhase;
    if (phase === null) return [];
    return phaseMessages[phase] ?? [];
  },

  // ---- Data loading ----

  loadProjects: async () => {
    try {
      const projects = await window.lionclaw.pipeline.listProjects();
      set({ projects });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  loadMetrics: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getMetrics(projectId);
      if ('error' in result) {
        get()._setProjectState(projectId, { error: result.error });
      } else {
        // Persist via _setProjectState so the Map is updated too — otherwise
        // _hydrateFlatFromMap (triggered on tab switch / navigation) wipes
        // metrics back to null because the Map entry never received them.
        get()._setProjectState(projectId, { metrics: result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get()._setProjectState(projectId, { error: message });
    }
  },

  // ---- Project CRUD ----

  createProject: async (data) => {
    const result = await window.lionclaw.pipeline.createProject({
      name: data.name,
      description: data.description,
      projectPath: data.projectPath,
      startPhase: data.startPhase,
      specPath: data.specPath,
      prdPath: data.prdPath,
      pipelineType: data.pipelineType,
    });
    if ('error' in result) {
      throw new Error(`Falha ao criar projeto: ${result.error}`);
    }
    await get().loadProjects();
    return result.id;
  },

  loadSecurityAgentStatuses: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getSecurityAgentStatus(projectId);
      if (Array.isArray(result)) {
        // Persist via _setProjectState so the Map is updated and the field
        // survives _hydrateFlatFromMap on tab switch / navigation.
        get()._setProjectState(projectId, {
          securityAgentStatuses: result as SecurityAgentStatus[],
        });
      }
    } catch {
      // Non-critical: statuses just won't be pre-loaded
    }
  },

  loadAuditAgents: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.getAuditAgentsState(projectId);
      if ('error' in result) {
        console.warn('[pipeline-store] loadAuditAgents error:', result.error);
        return;
      }
      const agentsList = result.agents;
      // Preserve in-memory streamContent/toolCalls for agents currently streaming
      // so navigating away and back during phase 2 does not blank the matrix.
      const existingMap = get().projectStates.get(projectId)?.auditAgents ?? new Map<string, AuditAgentState>();
      const map = new Map<string, AuditAgentState>();
      for (const a of agentsList) {
        const startedAtMs = a.startedAt ? Date.parse(a.startedAt) : undefined;
        const completedAtMs = a.completedAt ? Date.parse(a.completedAt) : undefined;
        const slug = a.agentId.replace(/^security-/, '').split('-')[0] ?? a.agentId;
        const prior = existingMap.get(a.agentId);
        map.set(a.agentId, {
          agentId: a.agentId,
          slug,
          name: a.agentName,
          model: a.model,
          runtime: prior?.runtime ?? null,
          status: a.status as AuditAgentState['status'],
          streamContent: prior?.streamContent ?? '',
          toolCalls: prior?.toolCalls ?? [],
          filesAnalyzed: a.toolCallsCount,
          additionalFilesAfterStart: prior?.additionalFilesAfterStart ?? 0,
          toolCallsCount: a.toolCallsCount,
          costUsd: a.costUsd,
          durationMs: a.durationMs,
          findingsCount: a.findingsCount,
          startedAt: startedAtMs,
          completedAt: completedAtMs,
        });
      }
      const cur = get().projectStates.get(projectId);
      get()._setProjectState(projectId, {
        auditAgents: map,
        auditPanelSlots: cur?.auditPanelSlots ?? ([null, null, null] as AuditPanelSlots),
      });
    } catch (err) {
      console.error('[pipeline-store] loadAuditAgents failed:', err);
    }
  },

  handleSecurityAgentStatus: (event: SecurityAgentStatusEvent) => {
    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();
    const existing = cur.securityAgentStatuses.findIndex((a) => a.agentId === event.agentId);
    const updated: SecurityAgentStatus = {
      agentId: event.agentId,
      agentName: event.agentName,
      status: event.status,
      findingsCount: event.findingsCount ?? 0,
      error: event.error,
    };
    let updatedStatuses: SecurityAgentStatus[];
    if (existing !== -1) {
      updatedStatuses = [...cur.securityAgentStatuses];
      updatedStatuses[existing] = { ...updatedStatuses[existing], ...updated };
    } else {
      updatedStatuses = [...cur.securityAgentStatuses, updated];
    }
    get()._setProjectState(event.projectId, { securityAgentStatuses: updatedStatuses });
  },

  deleteProject: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.deleteProject(projectId);
      if ('error' in result) {
        set({ error: result.error });
        return;
      }
      set((state) => {
        const newStates = new Map(state.projectStates);
        newStates.delete(projectId);
        const newTouched = new Map(state._lastTouchedAt);
        newTouched.delete(projectId);
        return {
          projects: state.projects.filter((p) => p.id !== projectId),
          projectStates: newStates,
          _lastTouchedAt: newTouched,
          ...(state.activeProjectId === projectId
            ? { activeProjectId: null, ...initialRuntimeState }
            : {}),
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  // ---- Project selection ----

  setActiveProject: (projectId) => {
    if (projectId === null) {
      set({ activeProjectId: null, ...initialRuntimeState });
      return;
    }
    // Hydrate flat state from existing Map entry, or create empty entry and use defaults
    const existing = get().projectStates.get(projectId);
    if (!existing) {
      get()._ensureProjectState(projectId);
    }
    set({ activeProjectId: projectId });
    get()._hydrateFlatFromMap(projectId);
    // Se entry não existia OU está com state inicial vazio (pipeline já passou de fase
    // mas Map foi GC-ado / app reiniciado), refetch do DB de forma lazy.
    if (!existing || (existing.currentPhase === null && existing.phaseStatus === '')) {
      void get().openProject(projectId);
    }
  },

  openProject: async (projectId: string) => {
    // Ensure Map entry exists so stream listeners have somewhere to write
    get()._ensureProjectState(projectId);
    // Hydrate flat state from Map (preserves streamContent/currentToolCalls/phaseMessages
    // that may have arrived while the user was navigating away).
    set({ activeProjectId: projectId });
    get()._hydrateFlatFromMap(projectId);
    try {
      const result = await window.lionclaw.pipeline.getProject(projectId);
      if ('error' in result) {
        get()._setProjectState(projectId, { error: result.error });
        return;
      }

      const sprintsHydrated = Array.isArray(result.sprints) && result.sprints.length > 0
        ? result.sprints.map((s: { index: number; name: string; status?: string; coderAgentId?: string; evaluatorAgentId?: string; sprintJsonId?: string; sprintId?: string; rounds?: number; metrics?: Record<string, unknown> }) => ({
            index: s.index,
            name: s.name,
            verdict: s.status ?? '',
            coderAgentId: s.coderAgentId,
            evaluatorAgentId: s.evaluatorAgentId,
            sprintJsonId: s.sprintJsonId,
            sprintId: s.sprintId,
            rounds: s.rounds,
            metrics: s.metrics,
          }))
        : [];

      // Hidratar TANTO o Map quanto o flat state via _setProjectState
      get()._setProjectState(projectId, {
        currentPhase: result.currentPhase,
        phaseStatus: result.status,
        // BUG-19: Rehydrate awaitingUser from the backend so the "Aprovar"
        // button re-appears after a main-process restart on conversation
        // phases. The backend derives this flag in `pipeline:get-project`
        // based on currentPhase ∈ CONVERSATION_PHASES.
        awaitingUser: result.awaitingUser ?? false,
        agentCompleted: false,
        ...(sprintsHydrated.length > 0 ? { sprints: sprintsHydrated } : {}),
      });

      // Load persisted messages for the current phase (merge with in-memory, dedupe)
      if (result.currentPhase !== null) {
        try {
          const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, result.currentPhase);
          if (Array.isArray(msgs) && msgs.length > 0) {
            const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
            const phase = result.currentPhase as number;
            const existingMsgs: PipelineMessage[] = cur.phaseMessages[phase] ?? [];
            // Dedupe by (role, content prefix) to avoid duplicating messages that were
            // already streamed in-memory and are now also returned from the DB.
            const dedupeKey = (m: PipelineMessage) => `${m.role}::${m.content.slice(0, 50)}`;
            const existingKeys = new Set(existingMsgs.map(dedupeKey));
            const newMsgs = (msgs as PipelineMessage[]).filter((m) => !existingKeys.has(dedupeKey(m)));
            const merged = [...existingMsgs, ...newMsgs];
            get()._setProjectState(projectId, {
              phaseMessages: {
                ...cur.phaseMessages,
                [phase]: merged,
              },
            });
          }
        } catch {
          // Non-critical: messages just won't be pre-loaded
        }
      }

      // Security pipeline: rehydrate manifest and audit agents
      if (result.pipelineType === 'security') {
        try {
          const manifest = await window.lionclaw.pipeline.readManifest(projectId);
          if (manifest) {
            get()._setProjectState(projectId, { repoManifest: manifest as RepoManifest });
          }
        } catch {
          // Non-critical
        }
        void get().loadAuditAgents(projectId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get()._setProjectState(projectId, { error: message });
    }
  },

  closeProject: () => {
    set({
      activeProjectId: null,
      ...initialRuntimeState,
    });
  },

  // ---- Pipeline actions ----

  startPipeline: async (startPhase: number) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.start(activeProjectId, startPhase);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  sendMessage: async (message: string, attachments?: ChatAttachment[]) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    const userMsg: PipelineMessage = {
      role: 'user',
      content: message,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    // Persist via _setProjectState so the Map is updated and survives _hydrateFlatFromMap.
    const cur = get().projectStates.get(activeProjectId);
    const phase = cur?.currentPhase ?? null;
    if (phase === null) {
      get()._setProjectState(activeProjectId, { isStreaming: true, error: null });
    } else {
      const existing = cur?.phaseMessages[phase] ?? [];
      get()._setProjectState(activeProjectId, {
        phaseMessages: {
          ...(cur?.phaseMessages ?? {}),
          [phase]: [...existing, userMsg],
        },
        isStreaming: true,
        error: null,
      });
    }
    try {
      const result = await window.lionclaw.pipeline.send(activeProjectId, message, attachments);
      if ('error' in result) {
        get()._setProjectState(activeProjectId, { error: result.error, isStreaming: false });
      }
    } catch (err) {
      const message_ = err instanceof Error ? err.message : String(err);
      get()._setProjectState(activeProjectId, { error: message_, isStreaming: false });
    }
  },

  approvePhase: async (metadata?: Record<string, unknown>) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.approve(activeProjectId, metadata);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  confirmDevelopment: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.confirmDevelopment(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  abortPipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.abort(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      } else {
        set({ ...initialRuntimeState });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  pausePipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.pause(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  resumePipeline: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.resume(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  retryPhase: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({ error: null });
    try {
      const result = await window.lionclaw.pipeline.retry(activeProjectId);
      if ('error' in result) {
        set({ error: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  // ---- Phase history navigation (UI-17) ----

  setViewingPhase: (phase: number | null) => {
    const { activeProjectId } = get();
    if (activeProjectId) {
      get()._setProjectState(activeProjectId, { viewingPhase: phase });
    } else {
      set({ viewingPhase: phase });
    }
  },

  loadPhaseHistory: async (projectId: string, phase: number) => {
    try {
      const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, phase);
      if (Array.isArray(msgs)) {
        // Persist via _setProjectState so the Map is updated and survives _hydrateFlatFromMap.
        const cur = get().projectStates.get(projectId);
        get()._setProjectState(projectId, {
          phaseMessages: {
            ...(cur?.phaseMessages ?? {}),
            [phase]: msgs as PipelineMessage[],
          },
        });
      }
    } catch {
      // Non-critical: leave existing messages for that phase
    }
  },

  // ---- Phase document actions (UI-20) ----

  openPhaseDocument: async (phase: number) => {
    const { activeProjectId, phaseDocuments } = get();
    if (!activeProjectId) return;
    const docInfo = phaseDocuments[phase];
    if (!docInfo) return;
    try {
      const result = await window.lionclaw.pipeline.readPhaseDocument(activeProjectId, phase);
      if ('error' in result) {
        set({ error: result.error });
        return;
      }
      set({ activeDocument: { path: result.path, content: result.content } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  // ---- Sprint tab persistence (UI-18) ----

  setSelectedSprintTab: (tab: number) => {
    const { activeProjectId } = get();
    if (activeProjectId) {
      // Persist via _setProjectState so the Map is updated and survives _hydrateFlatFromMap.
      get()._setProjectState(activeProjectId, { selectedSprintTab: tab });
    } else {
      set({ selectedSprintTab: tab });
    }
  },

  // ---- Reset actions ----

  resetPhase: async (projectId: string, phase: number) => {
    try {
      const result = await window.lionclaw.pipeline.resetPhase(projectId, phase) as { ok: boolean; error?: string };
      if (result.ok) {
        get()._invalidateCaches(projectId);
        await get().openProject(projectId);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  resetSprint: async (projectId: string, sprintIndex: number) => {
    try {
      const result = await window.lionclaw.pipeline.resetSprint(projectId, sprintIndex) as { ok: boolean; error?: string };
      if (result.ok) {
        get()._invalidateCaches(projectId);
        await get().openProject(projectId);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  getResetPreview: async (projectId: string, target: { phase?: number; sprintIndex?: number }) => {
    try {
      return await window.lionclaw.pipeline.getResetPreview(projectId, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      return null;
    }
  },

  loadPhaseArtifact: async (projectId: string, phase: number) => {
    // Return early if already cached
    const cached = get().artifactCache[projectId]?.[phase];
    if (cached !== undefined) return;
    try {
      const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase);
      if (!result || 'error' in result) return;
      set((state) => ({
        artifactCache: {
          ...state.artifactCache,
          [projectId]: {
            ...(state.artifactCache[projectId] ?? {}),
            [phase]: result as ArtifactCacheEntry,
          },
        },
      }));
    } catch {
      // Non-critical: artifact just won't be in cache
    }
  },

  loadSprintHistory: async (projectId: string, sprintIndex: number) => {
    // Return early if already cached with actual data (empty arrays are not treated as valid cache)
    const cached = get().sprintHistoryCache[projectId]?.[sprintIndex];
    if (cached !== undefined && cached.length > 0) return;
    try {
      const result = await window.lionclaw.pipeline.getSprintHistory(projectId, sprintIndex) as unknown[] | { error: string } | null;
      if (!result || 'error' in result) return;
      set((state) => ({
        sprintHistoryCache: {
          ...state.sprintHistoryCache,
          [projectId]: {
            ...(state.sprintHistoryCache[projectId] ?? {}),
            [sprintIndex]: result as unknown[],
          },
        },
      }));
    } catch {
      // Non-critical: history just won't be in cache
    }
  },

  // ---- Utility selectors ----

  isConversationPhase: (phase: number | null, pipelineType?: string) => {
    if (phase === null) return false;
    const { conversationPhases } = get();
    if (pipelineType === 'security') return conversationPhases.security.includes(phase);
    if (pipelineType === 'architecture-review') return conversationPhases.architecture.includes(phase);
    // 'feature' tambem cai aqui — engine reusa DEV_CONVERSATION_PHASES pra ambos.
    return conversationPhases.dev.includes(phase);
  },

  isInTechPhase: (projectId: string) => {
    const { activeProjectId, currentPhase } = get();
    if (activeProjectId !== projectId || currentPhase === null) return false;
    return currentPhase >= 5 && currentPhase <= 8;
  },

  isInExecutionPhase: (projectId: string) => {
    const { activeProjectId, currentPhase } = get();
    if (activeProjectId !== projectId || currentPhase === null) return false;
    return currentPhase >= 11 && currentPhase <= 14;
  },

  // ---- Internal cache invalidation ----

  _invalidateCaches: (projectId: string) => {
    set((state) => {
      const newArtifactCache = { ...state.artifactCache };
      delete newArtifactCache[projectId];
      const newSprintHistoryCache = { ...state.sprintHistoryCache };
      delete newSprintHistoryCache[projectId];
      return { artifactCache: newArtifactCache, sprintHistoryCache: newSprintHistoryCache };
    });
  },

  // ---- Internal stream helpers ----

  _appendStreamText: (projectId: string, text: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    get()._setProjectState(projectId, {
      streamContent: cur.streamContent + text,
      isStreaming: true,
    });
  },

  _appendStreamTool: (projectId: string, tool: string, input: unknown) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    get()._setProjectState(projectId, {
      currentToolCalls: [...cur.currentToolCalls, { tool, input }],
    });
  },

  _appendAgentStream: (projectId: string, agent: string, entry: { type: string; content?: string; tool?: string }) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    if (agent === 'evaluator') {
      get()._setProjectState(projectId, {
        evaluatorStream: [...cur.evaluatorStream, entry],
        isStreaming: true,
      });
    } else {
      get()._setProjectState(projectId, {
        coderStream: [...cur.coderStream, entry],
        isStreaming: true,
      });
    }
  },

  _finalizeAssistantMessage: (projectId: string) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    if (!cur.streamContent && cur.currentToolCalls.length === 0) {
      get()._setProjectState(projectId, { isStreaming: false });
      return;
    }
    const msg: PipelineMessage = {
      role: 'assistant',
      content: cur.streamContent,
      toolCalls: cur.currentToolCalls.length > 0 ? [...cur.currentToolCalls] : undefined,
    };
    const phase = cur.currentPhase;
    if (phase === null) {
      get()._setProjectState(projectId, {
        streamContent: '',
        currentToolCalls: [],
        isStreaming: false,
      });
      return;
    }
    const existing = cur.phaseMessages[phase] ?? [];
    get()._setProjectState(projectId, {
      phaseMessages: {
        ...cur.phaseMessages,
        [phase]: [...existing, msg],
      },
      streamContent: '',
      currentToolCalls: [],
      isStreaming: false,
    });
  },

  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => {
    const { currentPhase } = get();

    // Finalize any in-progress stream when phase changes
    get()._finalizeAssistantMessage(event.projectId);

    const isPhaseTransition = event.phase !== currentPhase;
    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();

    get()._setProjectState(event.projectId, {
      currentPhase: event.phase,
      phaseStatus: event.status,
      awaitingUser: event.awaitingUser,
      agentCompleted: false,
      // Reset live phase metrics when entering a new phase
      phaseMetrics: isPhaseTransition ? null : cur.phaseMetrics,
      // Clear agent streams when entering a new sprint cycle (phase 13 from non-loop phase)
      coderStream: (isPhaseTransition && event.phase === 13) ? [] : cur.coderStream,
      evaluatorStream: (isPhaseTransition && event.phase === 13) ? [] : cur.evaluatorStream,
      // Reset round counter on phase transition
      currentRound: isPhaseTransition ? 0 : cur.currentRound,
      currentAgent: isPhaseTransition ? '' : cur.currentAgent,
      // Initialize phaseMessages entry for new phase if it doesn't exist
      phaseMessages: (isPhaseTransition && event.phase !== null && !(event.phase in cur.phaseMessages))
        ? { ...cur.phaseMessages, [event.phase]: [] }
        : cur.phaseMessages,
      // Reset viewingPhase to follow current phase when phase changes
      viewingPhase: isPhaseTransition ? null : cur.viewingPhase,
      // Update pipelineSprintIndex when metadata provides it (UI-03); reset on pipeline completion
      pipelineSprintIndex: event.phase === null
        ? null
        : typeof event.metadata?.sprintIndex === 'number'
          ? event.metadata.sprintIndex
          : cur.pipelineSprintIndex,
      // Preserve currentModel when event doesn't carry it. Only update when the
      // field is explicitly present (string) or explicitly null (pipeline ended).
      // This prevents partial phase-changed events from clobbering the badge.
      currentModel: event.currentModel !== undefined ? event.currentModel : cur.currentModel,
    });

    // Mark project as done/interrupted/aborted/failed when pipeline concludes (phase === null).
    // The terminal status comes from the event itself — never assume 'done' (would mask
    // crash recovery emitting status='interrupted' with phase=null).
    if (event.phase === null) {
      const terminalStatus: PipelineProject['status'] =
        event.status === 'completed' || event.status === 'pipeline-completed'
          ? 'done'
          : event.status === 'interrupted'
            ? 'interrupted'
            : event.status === 'aborted'
              ? 'aborted'
              : event.status === 'failed'
                ? 'failed'
                : 'done';
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === event.projectId
            ? { ...p, status: terminalStatus, currentPhase: null }
            : p
        ),
      }));
    }
  },

  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => {
    // BUG-21: patch the project row in the store so derived UI state
    // (isPaused / isStreaming / uiState) reflects backend reality without
    // a full refetch. Fires whenever the engine calls updateProjectColumns.
    // projects is not a PerProjectState field - use set() directly.
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== event.projectId) return p;
        const next: PipelineProject = { ...p };
        if (event.patch.status !== undefined) {
          next.status = event.patch.status;
        }
        if (event.patch.currentPhase !== undefined) {
          next.currentPhase = event.patch.currentPhase;
        }
        return next;
      }),
    }));
  },

  _handleNotesUpdated: (event: PipelineNotesUpdatedEvent) => {
    get()._setProjectState(event.projectId, {
      notesPath: event.path,
      notesContent: event.content,
    });
  },

  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => {
    const cur = get().projectStates.get(event.projectId) ?? get()._createEmptyProjectState();
    const existing = cur.sprints.findIndex((s) => s.index === event.sprintIndex);
    const completedStatus: SprintStatus = {
      // Preserve agent/json ids from the existing entry if available (set by sprints-loaded)
      ...(existing !== -1 ? cur.sprints[existing] : {}),
      index: event.sprintIndex,
      name: event.sprintName,
      verdict: event.verdict,
      reportPath: event.reportPath,
      rounds: event.rounds,
      metrics: event.metrics,
    };
    let updatedSprints: SprintStatus[];
    if (existing !== -1) {
      updatedSprints = [...cur.sprints];
      updatedSprints[existing] = completedStatus;
    } else {
      updatedSprints = [...cur.sprints, completedStatus];
    }
    get()._setProjectState(event.projectId, { sprints: updatedSprints });
  },

  _handleSprintUpdated: (data: { sprintIndex: number; status: string; round: number }) => {
    set((state) => {
      const existing = state.sprints.findIndex((s) => s.index === data.sprintIndex);

      // When a new round starts (round number increases), add a visual separator to coderStream
      // and clear evaluatorStream so each round has a clean evaluator panel.
      const prevRounds = existing !== -1 ? (state.sprints[existing].rounds ?? 0) : 0;
      const isNewRound = data.round > prevRounds && data.round > 0;

      const streamUpdates = isNewRound
        ? {
            coderStream: [
              ...state.coderStream,
              { type: 'separator' as const, content: `--- Round ${data.round} ---` },
            ],
            evaluatorStream: [] as Array<{ type: string; content?: string; tool?: string }>,
            streamContent: '',
          }
        : {};

      // Auto-update selectedSprintTab to the active sprint (UI-18)
      const newSelectedTab = data.sprintIndex;

      if (existing !== -1) {
        const updated = [...state.sprints];
        updated[existing] = {
          ...updated[existing],
          verdict: data.status,
          rounds: data.round,
        };
        return { sprints: updated, selectedSprintTab: newSelectedTab, ...streamUpdates };
      }
      // Sprint not yet in list - add a placeholder entry
      return {
        sprints: [
          ...state.sprints,
          {
            index: data.sprintIndex,
            name: `Sprint ${data.sprintIndex + 1}`,
            verdict: data.status,
            rounds: data.round,
          },
        ],
        selectedSprintTab: newSelectedTab,
        ...streamUpdates,
      };
    });
  },

  _handleSprintRound: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => {
    get()._setProjectState(data.projectId, { currentRound: data.round, currentAgent: data.agent });
  },

  _handleStreamError: (projectId: string, message: string) => {
    get()._setProjectState(projectId, { error: message, isStreaming: false });
  },

  _handleAgentCompleted: (projectId: string) => {
    get()._setProjectState(projectId, { agentCompleted: true });
  },

  closeDocument: () => {
    set({ activeDocument: null });
  },

  _handleDocumentUpdated: (data: { projectId: string; path: string; content: string }) => {
    const cur = get().projectStates.get(data.projectId) ?? get()._createEmptyProjectState();
    // Store the document info mapped to the current phase (UI-20)
    const phase = cur.currentPhase;
    const updatedPhaseDocuments = phase !== null
      ? {
          ...cur.phaseDocuments,
          [phase]: { path: data.path, label: _getPhaseDocLabel(phase) },
        }
      : cur.phaseDocuments;
    get()._setProjectState(data.projectId, {
      activeDocument: { path: data.path, content: data.content },
      phaseDocuments: updatedPhaseDocuments,
    });
  },

  _handleStreamUsage: (projectId: string, usage) => {
    const cur = get().projectStates.get(projectId) ?? get()._createEmptyProjectState();
    const prev = cur.phaseMetrics ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    };
    get()._setProjectState(projectId, {
      phaseMetrics: {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
        cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheCreationTokens: prev.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
        costUsd: prev.costUsd + (usage.costUsd ?? 0),
      },
    });
  },

  // ---- IPC listener registration ----

  init: () => {
    // Fetch conversation phases from backend to keep frontend in sync with engine constants.
    void window.lionclaw.pipeline.getConversationPhases().then((phases) => {
      set({ conversationPhases: phases });
    }).catch(() => {
      // Non-critical: defaults are hardcoded above
    });

    const unsubStream = window.lionclaw.pipeline.onStream((chunk: PipelineStreamChunk) => {
      const eventProjectId = chunk.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onStream event without projectId ignored', { type: chunk.type });
        return;
      }
      const store = usePipelineStore.getState();
      switch (chunk.type) {
        case 'thinking':
          get()._setProjectState(eventProjectId, { isStreaming: true });
          break;
        case 'text': {
          // Multi-panel security audit: route per-agent streams to auditAgents map
          if (chunk.auditAgentId) {
            const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
            const agentId = chunk.auditAgentId;
            const existing = cur.auditAgents.get(agentId);
            if (existing) {
              const next = new Map(cur.auditAgents);
              next.set(agentId, {
                ...existing,
                streamContent: existing.streamContent + chunk.content,
              });
              get()._setProjectState(eventProjectId, { auditAgents: next });
            }
            break;
          }
          // Route per-phase to coderStream/evaluatorStream so the SprintExecutionView
          // panels render live. Coder phases: 10 (security) | 13 (dev). Evaluator: 11 | 14.
          const cur = get().projectStates.get(eventProjectId);
          const chunkPhase = chunk.phase ?? cur?.currentPhase ?? null;
          const isCoderPhase = chunkPhase === 10 || chunkPhase === 13;
          const isEvaluatorPhase = chunkPhase === 11 || chunkPhase === 14;
          if (isCoderPhase || isEvaluatorPhase) {
            const agent = isEvaluatorPhase ? 'evaluator' : 'coder';
            store._appendAgentStream(eventProjectId, agent, { type: 'text', content: chunk.content });
          }
          store._appendStreamText(eventProjectId, chunk.content);
          break;
        }
        case 'tool_call': {
          // Multi-panel security audit: route per-agent tool calls to auditAgents map
          if (chunk.auditAgentId) {
            const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
            const agentId = chunk.auditAgentId;
            const existing = cur.auditAgents.get(agentId);
            if (existing) {
              const next = new Map(cur.auditAgents);
              next.set(agentId, {
                ...existing,
                toolCalls: [...existing.toolCalls, { tool: chunk.tool, input: chunk.input ?? null }],
              });
              get()._setProjectState(eventProjectId, { auditAgents: next });
            }
            break;
          }
          const cur = get().projectStates.get(eventProjectId);
          const chunkPhase = chunk.phase ?? cur?.currentPhase ?? null;
          const isCoderPhase = chunkPhase === 10 || chunkPhase === 13;
          const isEvaluatorPhase = chunkPhase === 11 || chunkPhase === 14;
          if (isCoderPhase || isEvaluatorPhase) {
            const agent = isEvaluatorPhase ? 'evaluator' : 'coder';
            store._appendAgentStream(eventProjectId, agent, { type: 'tool_use', tool: chunk.tool });
          }
          store._appendStreamTool(eventProjectId, chunk.tool, chunk.input ?? null);
          break;
        }
        case 'done':
          store._finalizeAssistantMessage(eventProjectId);
          break;
        case 'error':
          store._handleStreamError(eventProjectId, chunk.message);
          break;
        case 'usage':
          store._handleStreamUsage(eventProjectId, {
            inputTokens: chunk.inputTokens,
            outputTokens: chunk.outputTokens,
            cacheReadTokens: chunk.cacheReadTokens,
            cacheCreationTokens: chunk.cacheCreationTokens,
            costUsd: chunk.costUsd,
          });
          break;
        // tool_result and phase_changed/sprint_complete are handled via dedicated listeners
        default:
          break;
      }
    });

    const unsubPhase = window.lionclaw.pipeline.onPhaseChanged((event: PipelinePhaseChangedEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onPhaseChanged event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handlePhaseChanged(event);
    });

    const unsubProjectUpdated = window.lionclaw.pipeline.onProjectUpdated(
      (event: PipelineProjectUpdatedEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onProjectUpdated event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleProjectUpdated(event);
      },
    );

    const unsubNotes = window.lionclaw.pipeline.onNotesUpdated((event: PipelineNotesUpdatedEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onNotesUpdated event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handleNotesUpdated(event);
    });

    const unsubSprint = window.lionclaw.pipeline.onSprintComplete((event: PipelineSprintCompleteEvent) => {
      const eventProjectId = event.projectId ?? null;
      if (!eventProjectId) {
        console.warn('[pipeline-store] onSprintComplete event without projectId ignored');
        return;
      }
      usePipelineStore.getState()._handleSprintComplete(event);
    });

    const unsubSprintUpdated = window.lionclaw.pipeline.onSprintUpdated(
      // TODO: add projectId to onSprintUpdated payload so this listener can be filtered per-project
      (data: { sprintIndex: number; status: string; round: number }) => {
        usePipelineStore.getState()._handleSprintUpdated(data);
      },
    );

    const unsubAgentCompleted = window.lionclaw.pipeline.onAgentCompleted(
      (data: { projectId: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onAgentCompleted event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleAgentCompleted(data.projectId);
      },
    );

    const unsubDocumentUpdated = window.lionclaw.pipeline.onDocumentUpdated(
      (data: { projectId: string; path: string; content: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onDocumentUpdated event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleDocumentUpdated(data);
      },
    );

    const unsubSprintsLoaded = window.lionclaw.pipeline.onSprintsLoaded(
      (data: {
        projectId: string;
        sprints: Array<{
          index: number;
          name: string;
          status: string;
          coderAgentId?: string;
          evaluatorAgentId?: string;
          sprintJsonId?: string;
          sprintId?: string;
        }>;
      }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSprintsLoaded event without projectId ignored');
          return;
        }
        get()._setProjectState(eventProjectId, {
          sprints: data.sprints.map((s) => ({
            index: s.index,
            name: s.name,
            verdict: s.status ?? '',
            coderAgentId: s.coderAgentId,
            evaluatorAgentId: s.evaluatorAgentId,
            sprintJsonId: s.sprintJsonId,
            sprintId: s.sprintId,
          })),
        });
      },
    );

    const unsubSprintRound = window.lionclaw.pipeline.onSprintRound(
      (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSprintRound event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._handleSprintRound(data);
      },
    );

    const unsubResetComplete = window.lionclaw.pipeline.onResetComplete(
      (data: { projectId: string; phase?: number; sprintIndex?: number }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onResetComplete event without projectId ignored');
          return;
        }
        usePipelineStore.getState()._invalidateCaches(data.projectId);
        void usePipelineStore.getState().openProject(data.projectId);
      },
    );

    const unsubSecurityAgentStatus = window.lionclaw.pipeline.onSecurityAgentStatus(
      (event: SecurityAgentStatusEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onSecurityAgentStatus event without projectId ignored');
          return;
        }
        usePipelineStore.getState().handleSecurityAgentStatus(event);
      },
    );

    const unsubResolutionTrackerComplete = window.lionclaw.pipeline.onResolutionTrackerComplete(
      (data: { projectId: string }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onResolutionTrackerComplete event without projectId ignored');
          return;
        }
        // Future: could reload project or show notification
        // For now just a no-op listener to keep the channel open
      },
    );

    const unsubManifest = window.lionclaw.pipeline.onManifest(
      (data: { projectId: string; manifest: unknown }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onManifest event without projectId ignored');
          return;
        }
        get()._setProjectState(eventProjectId, { repoManifest: data.manifest as RepoManifest });
      },
    );

    const unsubAuditProgress = window.lionclaw.pipeline.onAuditAgentProgress(
      (event: PipelineAuditAgentProgressEvent) => {
        const eventProjectId = event.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onAuditAgentProgress event without projectId ignored');
          return;
        }
        const cur = get().projectStates.get(eventProjectId) ?? get()._createEmptyProjectState();
        const existing = cur.auditAgents.get(event.agentId);
        const now = Date.now();

        const updated: AuditAgentState = {
          agentId: event.agentId,
          slug: event.slug,
          name: event.agentName ?? existing?.name ?? event.slug,
          model: event.model ?? existing?.model ?? null,
          runtime: event.runtime ?? existing?.runtime ?? null,
          status: event.status,
          streamContent: existing?.streamContent ?? '',
          toolCalls: existing?.toolCalls ?? [],
          filesAnalyzed: event.filesAnalyzed,
          additionalFilesAfterStart: event.additionalFilesAfterStart,
          toolCallsCount: event.toolCallsCount,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          findingsCount: event.findingsCount,
          startedAt: existing?.startedAt ?? (event.status === 'running' ? now : undefined),
          completedAt:
            event.status === 'completed' || event.status === 'failed'
              ? now
              : existing?.completedAt,
        };

        const nextMap = new Map(cur.auditAgents);
        nextMap.set(event.agentId, updated);

        let nextSlots = cur.auditPanelSlots;
        if (event.status === 'running') {
          nextSlots = assignAgentToPanel(cur.auditPanelSlots, event.agentId, nextMap);
        }

        get()._setProjectState(eventProjectId, {
          auditAgents: nextMap,
          auditPanelSlots: nextSlots,
        });
      },
    );

    const unsubStalled = window.lionclaw.pipeline.onStalled(
      (data: { projectId: string; phase: number; agentId: string; lastChunkAt: number; secondsSinceLastChunk: number }) => {
        const eventProjectId = data.projectId ?? null;
        if (!eventProjectId) {
          console.warn('[pipeline-store] onStalled event without projectId ignored');
          return;
        }
        console.warn('[pipeline-store] pipeline:stalled received', data);
        get()._setProjectState(eventProjectId, { stalled: true });
      },
    );

    return () => {
      unsubStream();
      unsubPhase();
      unsubProjectUpdated();
      unsubNotes();
      unsubSprint();
      unsubSprintUpdated();
      unsubAgentCompleted();
      unsubDocumentUpdated();
      unsubSprintsLoaded();
      unsubSprintRound();
      unsubResetComplete();
      unsubSecurityAgentStatus();
      unsubResolutionTrackerComplete();
      unsubManifest();
      unsubAuditProgress();
      unsubStalled();
    };
  },
  }),
  {
    name: 'lionclaw-pipeline',
    storage: createJSONStorage(() => localStorage),
    // Persist only the active project pointer so dev-mode reloads don't
    // dump the user back to the project list. All per-project runtime
    // state (streamContent, sprints, metrics, etc.) is rehydrated from
    // backend via openProject — keeping it out of localStorage avoids
    // stale serialization issues with Maps/Sets.
    partialize: (state) => ({
      activeProjectId: state.activeProjectId,
    }),
  },
));

// ---- Phase document label helper (module-level, not in store) ----

const PHASE_DOC_LABELS: Record<number, string> = {
  1:  'Ver Discovery Notes',
  2:  'Ver User Stories',
  3:  'Ver User Stories',
  4:  'Ver PRD',
  5:  'Ver PRD',
  6:  'Ver SPEC',
  7:  'Ver SPEC',
  8:  'Ver SPEC',
  9:  'Ver Spec',
  10: 'Ver Spec',
  11: 'Ver Sprints',
  12: 'Ver Sprints',
  13: 'Ver Sprints',
  14: 'Ver Sprints',
};

function _getPhaseDocLabel(phase: number): string {
  return PHASE_DOC_LABELS[phase] ?? `Ver Documento (Fase ${phase})`;
}
