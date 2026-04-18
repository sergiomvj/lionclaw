import { create } from 'zustand';
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
} from '@/types';

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
  type: 'markdown' | 'sprints';
  content?: string;
  sprints?: unknown[];
}

// ---- Store state ----

interface PipelineState {
  // Project list
  projects: PipelineProject[];
  activeProjectId: string | null;

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
  }) => Promise<string>;

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

  /** Returns true if the project's current phase is a tech phase (5-8). */
  isInTechPhase: (projectId: string) => boolean;

  /** Returns true if the project's current phase is an execution phase (11-14). */
  isInExecutionPhase: (projectId: string) => boolean;

  // ---- Internal helpers (used by init listeners) ----
  _appendStreamText: (text: string) => void;
  _appendStreamTool: (tool: string, input: unknown) => void;
  _finalizeAssistantMessage: () => void;
  _appendAgentStream: (agent: string, entry: { type: string; content?: string; tool?: string }) => void;
  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => void;
  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => void;
  _handleNotesUpdated: (event: PipelineNotesUpdatedEvent) => void;
  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => void;
  _handleSprintUpdated: (data: { sprintIndex: number; status: string; round: number }) => void;
  _handleSprintRound: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void;
  _handleStreamError: (message: string) => void;
  _handleStreamUsage: (usage: {
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
};

// ---- Store ----

export const usePipelineStore = create<PipelineState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  artifactCache: {},
  sprintHistoryCache: {},
  ...initialRuntimeState,

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
        set({ error: result.error });
      } else {
        set({ metrics: result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  // ---- Project CRUD ----

  createProject: async (data) => {
    const result = await window.lionclaw.pipeline.createProject(data);
    if ('error' in result) {
      throw new Error(`Falha ao criar projeto: ${result.error}`);
    }
    await get().loadProjects();
    return result.id;
  },

  deleteProject: async (projectId: string) => {
    try {
      const result = await window.lionclaw.pipeline.deleteProject(projectId);
      if ('error' in result) {
        set({ error: result.error });
        return;
      }
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
        ...(state.activeProjectId === projectId
          ? { activeProjectId: null, ...initialRuntimeState }
          : {}),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  // ---- Project selection ----

  setActiveProject: (projectId) => {
    set({
      activeProjectId: projectId,
      ...initialRuntimeState,
    });
  },

  openProject: async (projectId: string) => {
    set({
      activeProjectId: projectId,
      ...initialRuntimeState,
    });
    try {
      const result = await window.lionclaw.pipeline.getProject(projectId);
      if ('error' in result) {
        set({ error: result.error });
        return;
      }
      set({
        currentPhase: result.currentPhase,
        phaseStatus: result.status,
        // BUG-19: Rehydrate awaitingUser from the backend so the "Aprovar"
        // button re-appears after a main-process restart on conversation
        // phases. The backend derives this flag in `pipeline:get-project`
        // based on currentPhase ∈ CONVERSATION_PHASES.
        awaitingUser: result.awaitingUser ?? false,
        // No active stream at rehydration time.
        agentCompleted: false,
        // Rehydrate sprints from DB so the sprint tab is populated on reload
        ...(Array.isArray(result.sprints) && result.sprints.length > 0
          ? {
              sprints: result.sprints.map((s: { index: number; name: string; status?: string; coderAgentId?: string; evaluatorAgentId?: string; sprintJsonId?: string; sprintId?: string; rounds?: number; metrics?: Record<string, unknown> }) => ({
                index: s.index,
                name: s.name,
                verdict: s.status ?? '',
                coderAgentId: s.coderAgentId,
                evaluatorAgentId: s.evaluatorAgentId,
                sprintJsonId: s.sprintJsonId,
                sprintId: s.sprintId,
                rounds: s.rounds,
                metrics: s.metrics,
              })),
            }
          : {}),
      });

      // Load persisted messages for the current phase into phaseMessages[currentPhase]
      if (result.currentPhase !== null) {
        try {
          const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, result.currentPhase);
          if (Array.isArray(msgs) && msgs.length > 0) {
            set((state) => ({
              phaseMessages: {
                ...state.phaseMessages,
                [result.currentPhase as number]: msgs as PipelineMessage[],
              },
            }));
          }
        } catch {
          // Non-critical: messages just won't be pre-loaded
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
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
    set((state) => {
      const phase = state.currentPhase;
      if (phase === null) {
        return { isStreaming: true, error: null };
      }
      const existing = state.phaseMessages[phase] ?? [];
      return {
        phaseMessages: {
          ...state.phaseMessages,
          [phase]: [...existing, userMsg],
        },
        isStreaming: true,
        error: null,
      };
    });
    try {
      const result = await window.lionclaw.pipeline.send(activeProjectId, message, attachments);
      if ('error' in result) {
        set({ error: result.error, isStreaming: false });
      }
    } catch (err) {
      const message_ = err instanceof Error ? err.message : String(err);
      set({ error: message_, isStreaming: false });
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
    set({ viewingPhase: phase });
  },

  loadPhaseHistory: async (projectId: string, phase: number) => {
    try {
      const msgs = await window.lionclaw.pipeline.getPhaseMessages(projectId, phase);
      if (Array.isArray(msgs)) {
        set((state) => ({
          phaseMessages: {
            ...state.phaseMessages,
            [phase]: msgs as PipelineMessage[],
          },
        }));
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
    set({ selectedSprintTab: tab });
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
      const result = await window.lionclaw.pipeline.readPhaseArtifact(projectId, phase) as ArtifactCacheEntry | { error: string } | null;
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

  _appendStreamText: (text: string) => {
    set((state) => ({
      streamContent: state.streamContent + text,
      isStreaming: true,
    }));
  },

  _appendStreamTool: (tool: string, input: unknown) => {
    set((state) => ({
      currentToolCalls: [...state.currentToolCalls, { tool, input }],
    }));
  },

  _appendAgentStream: (agent: string, entry: { type: string; content?: string; tool?: string }) => {
    set((state) => {
      if (agent === 'evaluator') {
        return { evaluatorStream: [...state.evaluatorStream, entry], isStreaming: true };
      }
      return { coderStream: [...state.coderStream, entry], isStreaming: true };
    });
  },

  _finalizeAssistantMessage: () => {
    const { streamContent, currentToolCalls } = get();
    if (!streamContent && currentToolCalls.length === 0) {
      set({ isStreaming: false });
      return;
    }
    const msg: PipelineMessage = {
      role: 'assistant',
      content: streamContent,
      toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
    };
    set((state) => {
      const phase = state.currentPhase;
      if (phase === null) {
        return {
          streamContent: '',
          currentToolCalls: [],
          isStreaming: false,
        };
      }
      const existing = state.phaseMessages[phase] ?? [];
      return {
        phaseMessages: {
          ...state.phaseMessages,
          [phase]: [...existing, msg],
        },
        streamContent: '',
        currentToolCalls: [],
        isStreaming: false,
      };
    });
  },

  _handlePhaseChanged: (event: PipelinePhaseChangedEvent) => {
    const { activeProjectId, currentPhase } = get();
    if (activeProjectId !== null && event.projectId !== activeProjectId) return;

    // Finalize any in-progress stream when phase changes
    get()._finalizeAssistantMessage();

    const isPhaseTransition = event.phase !== currentPhase;

    set((state) => ({
      currentPhase: event.phase,
      phaseStatus: event.status,
      awaitingUser: event.awaitingUser,
      agentCompleted: false,
      // Reset live phase metrics when entering a new phase
      phaseMetrics: isPhaseTransition ? null : state.phaseMetrics,
      // Clear agent streams when entering a new sprint cycle (phase 13 from non-loop phase)
      coderStream: (isPhaseTransition && event.phase === 13) ? [] : state.coderStream,
      evaluatorStream: (isPhaseTransition && event.phase === 13) ? [] : state.evaluatorStream,
      // Reset round counter on phase transition
      currentRound: isPhaseTransition ? 0 : state.currentRound,
      currentAgent: isPhaseTransition ? '' : state.currentAgent,
      // Initialize phaseMessages entry for new phase if it doesn't exist
      phaseMessages: (isPhaseTransition && event.phase !== null && !(event.phase in state.phaseMessages))
        ? { ...state.phaseMessages, [event.phase]: [] }
        : state.phaseMessages,
      // Reset viewingPhase to follow current phase when phase changes
      viewingPhase: isPhaseTransition ? null : state.viewingPhase,
      // Update pipelineSprintIndex when metadata provides it (UI-03); reset on pipeline completion
      pipelineSprintIndex: event.phase === null
        ? null
        : typeof event.metadata?.sprintIndex === 'number'
          ? event.metadata.sprintIndex
          : state.pipelineSprintIndex,
      // Mark project as done when pipeline concludes (phase === null)
      projects: event.phase === null
        ? state.projects.map((p) =>
            p.id === event.projectId
              ? { ...p, status: 'done' as const, currentPhase: null }
              : p
          )
        : state.projects,
    }));
  },

  _handleProjectUpdated: (event: PipelineProjectUpdatedEvent) => {
    // BUG-21: patch the project row in the store so derived UI state
    // (isPaused / isStreaming / uiState) reflects backend reality without
    // a full refetch. Fires whenever the engine calls updateProjectColumns.
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
    const { activeProjectId } = get();
    if (activeProjectId !== null && event.projectId !== activeProjectId) return;
    set({
      notesPath: event.path,
      notesContent: event.content,
    });
  },

  _handleSprintComplete: (event: PipelineSprintCompleteEvent) => {
    const { activeProjectId } = get();
    if (activeProjectId !== null && event.projectId !== activeProjectId) return;
    set((state) => {
      const existing = state.sprints.findIndex((s) => s.index === event.sprintIndex);
      const completedStatus: SprintStatus = {
        // Preserve agent/json ids from the existing entry if available (set by sprints-loaded)
        ...(existing !== -1 ? state.sprints[existing] : {}),
        index: event.sprintIndex,
        name: event.sprintName,
        verdict: event.verdict,
        reportPath: event.reportPath,
        rounds: event.rounds,
        metrics: event.metrics,
      };
      if (existing !== -1) {
        const updated = [...state.sprints];
        updated[existing] = completedStatus;
        return { sprints: updated };
      }
      return { sprints: [...state.sprints, completedStatus] };
    });
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
    const { activeProjectId } = get();
    if (activeProjectId !== null && data.projectId !== activeProjectId) return;
    set({ currentRound: data.round, currentAgent: data.agent });
  },

  _handleStreamError: (message: string) => {
    set({ error: message, isStreaming: false });
  },

  _handleAgentCompleted: (projectId: string) => {
    const { activeProjectId } = get();
    if (activeProjectId !== null && projectId !== activeProjectId) return;
    set({ agentCompleted: true });
  },

  closeDocument: () => {
    set({ activeDocument: null });
  },

  _handleDocumentUpdated: (data: { projectId: string; path: string; content: string }) => {
    const { activeProjectId } = get();
    if (activeProjectId !== null && data.projectId !== activeProjectId) return;
    set((state) => {
      // Store the document info mapped to the current phase (UI-20)
      const phase = state.currentPhase;
      const updatedPhaseDocuments = phase !== null
        ? {
            ...state.phaseDocuments,
            [phase]: { path: data.path, label: _getPhaseDocLabel(phase) },
          }
        : state.phaseDocuments;
      return {
        activeDocument: { path: data.path, content: data.content },
        phaseDocuments: updatedPhaseDocuments,
      };
    });
  },

  _handleStreamUsage: (usage) => {
    set((state) => {
      const prev = state.phaseMetrics ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
      return {
        phaseMetrics: {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheCreationTokens: prev.cacheCreationTokens + (usage.cacheCreationTokens ?? 0),
          costUsd: prev.costUsd + (usage.costUsd ?? 0),
        },
      };
    });
  },

  // ---- IPC listener registration ----

  init: () => {
    const unsubStream = window.lionclaw.pipeline.onStream((chunk: PipelineStreamChunk) => {
      const store = usePipelineStore.getState();
      switch (chunk.type) {
        case 'thinking':
          usePipelineStore.setState({ isStreaming: true });
          break;
        case 'text': {
          // Use the phase from the chunk itself (set by the stream bridge in pipeline-engine)
          // so that coder vs evaluator routing is correct even within the same sprint loop,
          // where currentPhase stays at 13 and the engine does not emit phase-changed between agents.
          const chunkPhase = chunk.phase ?? usePipelineStore.getState().currentPhase;
          if (chunkPhase === 13 || chunkPhase === 14) {
            const agent = chunkPhase === 14 ? 'evaluator' : 'coder';
            store._appendAgentStream(agent, { type: 'text', content: chunk.content });
          }
          store._appendStreamText(chunk.content);
          break;
        }
        case 'tool_call': {
          const chunkPhase = chunk.phase ?? usePipelineStore.getState().currentPhase;
          if (chunkPhase === 13 || chunkPhase === 14) {
            const agent = chunkPhase === 14 ? 'evaluator' : 'coder';
            store._appendAgentStream(agent, { type: 'tool_use', tool: chunk.tool });
          }
          store._appendStreamTool(chunk.tool, chunk.input ?? null);
          break;
        }
        case 'done':
          store._finalizeAssistantMessage();
          break;
        case 'error':
          store._handleStreamError(chunk.message);
          break;
        case 'usage':
          store._handleStreamUsage({
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
      usePipelineStore.getState()._handlePhaseChanged(event);
    });

    const unsubProjectUpdated = window.lionclaw.pipeline.onProjectUpdated(
      (event: PipelineProjectUpdatedEvent) => {
        usePipelineStore.getState()._handleProjectUpdated(event);
      },
    );

    const unsubNotes = window.lionclaw.pipeline.onNotesUpdated((event: PipelineNotesUpdatedEvent) => {
      usePipelineStore.getState()._handleNotesUpdated(event);
    });

    const unsubSprint = window.lionclaw.pipeline.onSprintComplete((event: PipelineSprintCompleteEvent) => {
      usePipelineStore.getState()._handleSprintComplete(event);
    });

    const unsubSprintUpdated = window.lionclaw.pipeline.onSprintUpdated(
      (data: { sprintIndex: number; status: string; round: number }) => {
        usePipelineStore.getState()._handleSprintUpdated(data);
      },
    );

    const unsubAgentCompleted = window.lionclaw.pipeline.onAgentCompleted(
      (data: { projectId: string }) => {
        usePipelineStore.getState()._handleAgentCompleted(data.projectId);
      },
    );

    const unsubDocumentUpdated = window.lionclaw.pipeline.onDocumentUpdated(
      (data: { projectId: string; path: string; content: string }) => {
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
        const store = usePipelineStore.getState();
        if (store.activeProjectId !== null && store.activeProjectId !== data.projectId) return;
        set({
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
        usePipelineStore.getState()._handleSprintRound(data);
      },
    );

    const unsubResetComplete = window.lionclaw.pipeline.onResetComplete(
      (data: { projectId: string; phase?: number; sprintIndex?: number }) => {
        usePipelineStore.getState()._invalidateCaches(data.projectId);
        void usePipelineStore.getState().openProject(data.projectId);
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
    };
  },
}));

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
