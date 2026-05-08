// ---- Pipeline types (re-exported from pipeline.ts) ----
export * from './pipeline';

// Imports tipados pra usar dentro deste arquivo (ex: window.lionclaw.pipeline API).
// `export *` apenas re-expoe; nao introduz binding local.
import type {
  PipelineProject,
  PipelineMessage,
  PipelineMetricsResult,
  PipelineStreamChunk,
  PipelinePhaseChangedEvent,
  PipelineProjectUpdatedEvent,
  PipelineNotesUpdatedEvent,
  PipelineSprintCompleteEvent,
  PipelineSprintMessage,
  SecurityAgentStatus,
} from './pipeline';

// ---- Chat ----

export interface ChatAttachment {
  id: string;
  type: 'image' | 'audio';
  filename: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'audio/webm' | 'audio/mpeg';
  data: string;      // base64
  size: number;      // bytes
  preview?: string;  // thumbnail base64 (images) or transcription text (audio)
}

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  subagent?: string;
  attachments?: ChatAttachment[];
  messageType?: 'text' | 'ask_question' | 'confirm_action';
  metadata?: MessageMetadata;
  createdAt: string;
}

export interface MessageMetadata {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  toolCalls?: ToolCallSummary[];
  askQuestions?: AskQuestion[];
  askAnswers?: Record<string, string | string[]>;
  artifacts?: ArtifactData[];
}

export interface ToolCallSummary {
  tool: string;
  input: string;
  durationMs: number;
}

export interface ChatSession {
  id: string;
  sdkSessionId?: string;
  subagent?: string;
  title?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: 'active' | 'archived' | 'compacted' | 'trashed';
  type: 'chat' | 'scheduled' | 'manual' | 'telegram';
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'done' | 'confirm_request'
       | 'ask_question' | 'usage' | 'session' | 'onboarding_completed' | 'replace_content'
       | 'artifact' | 'compacting';
  sessionId?: string;
  content?: string;
  tool?: string;
  input?: unknown;
  result?: string;
  error?: string;
  confirmId?: string;
  confirmAction?: ConfirmAction;
  askRequest?: AskQuestionRequest;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  artifact?: ArtifactData;
  isCompacting?: boolean;
  /** Number of messages still queued after this one. Present on 'done' chunks when the
   *  message queue has pending messages, so the renderer can keep isStreaming=true. */
  queueRemaining?: number;
}

export interface ArtifactData {
  id: string;
  type: 'excalidraw' | 'image' | 'html' | 'mermaid' | 'mcp_app' | 'audio';
  title: string;
  toolName: string;
  data: Record<string, unknown>;
}

export interface ConfirmAction {
  id: string;
  tool: string;
  description: string;
  input: unknown;
  risk: 'medium' | 'high' | 'critical';
}

// ---- AskUserQuestion ----

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface AskQuestionRequest {
  id: string;
  questions: AskQuestion[];
}

export interface AskQuestionResponse {
  id: string;
  answers: Record<string, string | string[]>;
  annotations?: Record<string, {
    preview?: string;
    notes?: string;
  }>;
}

// ---- SubAgents ----

export type LocalLLMProvider = 'ollama' | 'lmstudio' | 'openai-compatible';
export type ExternalProvider = 'openrouter' | 'openai' | 'openai-compatible';
export type LLMProvider = LocalLLMProvider | ExternalProvider;

export interface ExternalConfig {
  provider: ExternalProvider;
  baseUrl: string;
  model: string;
  /** Vault key name (e.g. "HARNESS_OPENROUTER_KEY"). Never the key itself. */
  apiKeyRef: string;
  temperature?: number;
  maxTokens?: number;
  /** Custom headers (e.g. HTTP-Referer for OpenRouter). */
  extraHeaders?: Record<string, string>;
  /**
   * Context window in tokens.
   * Manual input only for provider 'openai-compatible' (Custom).
   * For OpenRouter/OpenAI, derived from MODEL_CATALOG at runtime and not persisted.
   */
  contextWindow?: number;
}

export interface CodexConfig {
  model: string;
  sandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  mcpServers: string[];
  isActive: boolean;
  sortOrder: number;
  effort: 'low' | 'medium' | 'high' | 'max';
  thinking: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudget?: number;
  maxTurns?: number;
  skills: string[];
  runtime: 'cloud' | 'local' | 'external' | 'codex';
  localConfig?: {
    provider: LocalLLMProvider;
    baseUrl: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  externalConfig?: ExternalConfig;
  codexConfig?: CodexConfig;
  localMode?: 'simple' | 'smart';
  maxToolRounds?: number;
  squad?: string;
}

// ---- Skills ----

export interface Skill {
  name: string;
  description: string;
  category?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  context?: 'fork';
  agent?: string;
  content: string;
  rawContent: string;
  path: string;
  hasAuxFiles: boolean;
}

export interface SkillInput {
  name: string;
  description: string;
  category?: string;
  content: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: 'fork';
  agent?: string;
}

// ---- MCP Servers ----

export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
  status?: 'running' | 'stopped' | 'error';
}

/** MCP Server herdado do Claude Code SDK */
export interface SDKMcpServer {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
  isDisabledLocally: boolean;
}

// ---- Scheduler ----

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  subagent?: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  status: 'active' | 'paused' | 'completed';
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  notify: boolean;
  tags: string[];
}

export interface TaskRun {
  id: number;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'error';
  result?: string;
  error?: string;
  tokensUsed: number;
  costUsd: number;
  sessionId?: string;
  reviewStatus?: 'pending_review' | 'validated' | 'rejected';
  reviewNote?: string;
  reviewedAt?: string;
}

export type TaskInput = Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount'>;

// ---- Activity Board ----

export interface ActivityItem {
  runId: number;
  taskId: string;
  taskName: string;
  prompt: string;
  subagent: string | null;
  tags: string[];
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  status: 'scheduled' | 'running' | 'success' | 'error';
  reviewStatus: 'pending_review' | 'validated' | 'rejected' | null;
  sessionId: string | null;
  error: string | null;
}

export interface ActivityFilters {
  from: string;
  to: string;
  subagent?: string;
  status?: 'scheduled' | 'running' | 'success' | 'error';
  tags?: string[];
}

export interface ActivityStats {
  scheduled: number;
  running: number;
  success: number;
  error: number;
}

// ---- Personal Tasks ----

export interface PersonalTask {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  doneComment: string | null;
}

export interface PersonalTaskInput {
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  dueDate?: string;
}

export interface PersonalTaskFilters {
  status?: string;
  category?: string;
  priority?: string;
  period?: 'last30' | 'last90' | 'all';
}

// ---- Memory ----

export interface SemanticMemory {
  id: number;
  content: string;
  sourceSession?: string;
  topic?: string;
  subagent?: string;
  createdAt: string;
  similarity?: number;
}

export interface DailySummary {
  id: number;
  date: string;
  summary: string;
  decisions: string[];
  tasksCreated: string[];
  factsExtracted: string[];
  messageCount: number;
  subagentsUsed: string[];
  tokensUsed: number;
  costUsd: number;
}

// ---- Channels ----

export interface Channel {
  id: string;
  type: 'telegram' | 'slack' | 'discord' | 'whatsapp';
  name: string;
  config: Record<string, unknown>;
  isActive: boolean;
  status: 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramSaveConfig {
  botToken: string;
  allowedUserId: number;
  allowedUserName: string;
  notifyOnSchedulerTasks: boolean;
}

// ---- Audit ----

export interface AuditEntry {
  id: number;
  sessionId?: string;
  subagent?: string;
  eventType: 'tool_call' | 'tool_result' | 'tool_blocked' | 'error' | 'confirm_request' | 'confirm_response';
  toolName?: string;
  input?: string;
  output?: string;
  durationMs?: number;
  approved?: boolean;
  createdAt: string;
}

// ---- Settings ----

export interface AppSettings {
  defaultModel: string;
  theme: 'light' | 'dark' | 'system';
  language: 'pt-BR';
  sessionTimeoutMinutes: number;
  compactionSchedule: string;
  maxWorkingMemoryTokens: number;
  rawMessageRetentionDays: number;
  maxSessionTokens?: number;
  voiceResponseEnabled: boolean;
  voiceId?: string;
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  ollamaCompactionModel: string;
  mgraphMode: boolean;
}

// ---- Log Filters ----

export interface LogFilters {
  sessionId?: string;
  subagent?: string;
  eventType?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ---- Tool Catalog ----

export const TOOL_CATALOG = [
  { id: 'Read', name: 'Ler Arquivos', description: 'Le arquivos do filesystem', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'Write', name: 'Criar Arquivos', description: 'Cria arquivos novos', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Edit', name: 'Editar Arquivos', description: 'Edita arquivos existentes', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Glob', name: 'Buscar Arquivos', description: 'Busca arquivos por pattern', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'Grep', name: 'Buscar Conteudo', description: 'Busca conteudo dentro de arquivos', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'NotebookEdit', name: 'Editar Notebooks', description: 'Edita notebooks Jupyter', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Bash', name: 'Terminal', description: 'Executa comandos no terminal', category: 'system', risk: 'high', extraCost: false },
  { id: 'WebSearch', name: 'Busca Web', description: 'Pesquisa na internet (~$0.01/busca)', category: 'internet', risk: 'medium', extraCost: true },
  { id: 'WebFetch', name: 'Acessar URL', description: 'Acessa e le conteudo de URLs', category: 'internet', risk: 'medium', extraCost: false },
  { id: 'Agent', name: 'SubAgentes', description: 'Delega tarefas para subagentes', category: 'orchestration', risk: 'low', extraCost: false },
  { id: 'TodoWrite', name: 'Lista de Tarefas', description: 'Gerencia lista de tarefas interna', category: 'utility', risk: 'none', extraCost: false },
  { id: 'AskUserQuestion', name: 'Perguntar ao Usuario', description: 'Faz perguntas com opcoes', category: 'interaction', risk: 'none', extraCost: false },
] as const;

export type ToolId = typeof TOOL_CATALOG[number]['id'];

export type ToolCategory = typeof TOOL_CATALOG[number]['category'];

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  filesystem: 'Filesystem',
  system: 'Sistema',
  internet: 'Internet',
  orchestration: 'Orquestracao',
  utility: 'Utilidade',
  interaction: 'Interacao',
};

// ---- IPC API ----

export interface LionClawAPI {
  app: {
    getVersion: () => Promise<{ version: string; label: string }>;
  };
  chat: {
    send: (message: string, options?: { sessionId?: string; agentId?: string; attachments?: ChatAttachment[] }) => Promise<void>;
    stop: () => Promise<void>;
    onStream: (cb: (chunk: StreamChunk) => void) => () => void;
    onConfirmRequest: (cb: (action: ConfirmAction) => void) => () => void;
    confirmResponse: (id: string, approved: boolean) => Promise<void>;
    onAskQuestion: (cb: (request: AskQuestionRequest) => void) => () => void;
    askResponse: (response: AskQuestionResponse) => Promise<void>;
    getSessions: () => Promise<ChatSession[]>;
    getMessages: (sessionId: string) => Promise<ChatMessage[]>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    archiveSession: (sessionId: string) => Promise<boolean>;
    getActiveSession: () => Promise<{ id: string; createdAt: string; inputTokens: number; outputTokens: number } | null>;
    compactSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string; error?: string }>;
    clearSession: () => Promise<{ success: boolean; newSessionId?: string; reason?: string }>;
    onSessionsUpdated: (cb: () => void) => () => void;
  };
  agents: {
    list: () => Promise<AgentConfig[]>;
    get: (id: string) => Promise<AgentConfig>;
    create: (agent: Omit<AgentConfig, 'sortOrder'>) => Promise<AgentConfig>;
    update: (id: string, agent: Partial<AgentConfig>) => Promise<AgentConfig>;
    delete: (id: string) => Promise<void>;
  };
  skills: {
    list: () => Promise<Skill[]>;
    get: (name: string) => Promise<Skill>;
    create: (skill: SkillInput) => Promise<Skill>;
    update: (name: string, skill: SkillInput) => Promise<Skill>;
    updateRaw: (name: string, content: string) => Promise<Skill>;
    delete: (name: string) => Promise<void>;
  };
  mcp: {
    list: () => Promise<MCPServerConfig[]>;
    create: (config: Omit<MCPServerConfig, 'status'>) => Promise<MCPServerConfig>;
    update: (id: string, config: Partial<MCPServerConfig>) => Promise<MCPServerConfig>;
    delete: (id: string) => Promise<void>;
    test: (id: string) => Promise<{ success: boolean; error?: string }>;
    restart: (id: string) => Promise<void>;
    toggle: (id: string, active: boolean) => Promise<MCPServerConfig>;
    listSDK: () => Promise<SDKMcpServer[]>;
    refreshSDK: () => Promise<SDKMcpServer[]>;
    toggleSDK: (name: string, enabled: boolean) => Promise<void>;
  };
  scheduler: {
    list: () => Promise<ScheduledTask[]>;
    create: (task: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount'>) => Promise<ScheduledTask>;
    update: (id: string, task: Partial<ScheduledTask>) => Promise<ScheduledTask>;
    delete: (id: string) => Promise<void>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    getRuns: (taskId: string) => Promise<TaskRun[]>;
    reviewRun: (runId: number, status: 'validated' | 'rejected', note?: string) => Promise<void>;
    getPendingReviewCount: () => Promise<number>;
    getSessions: () => Promise<ChatSession[]>;
    deleteSession: (sessionId: string) => Promise<void>;
    cleanupSessions: () => Promise<void>;
    getActivities: (filters: ActivityFilters) => Promise<ActivityItem[]>;
    getActivityStats: (from: string, to: string) => Promise<ActivityStats>;
    getAllTags: () => Promise<string[]>;
  };
  tasks: {
    list: (filters?: PersonalTaskFilters) => Promise<PersonalTask[]>;
    get: (id: string) => Promise<PersonalTask>;
    create: (task: PersonalTaskInput) => Promise<PersonalTask>;
    update: (id: string, updates: Partial<PersonalTask>) => Promise<PersonalTask>;
    delete: (id: string) => Promise<void>;
    getCategories: () => Promise<string[]>;
    getPendingDueCount: () => Promise<number>;
  };
  memory: {
    getWorkingMemory: () => Promise<string>;
    updateWorkingMemory: (content: string) => Promise<void>;
    searchSemantic: (query: string, limit?: number) => Promise<SemanticMemory[]>;
    getDailySummaries: (from?: string, to?: string) => Promise<DailySummary[]>;
    triggerCompaction: () => Promise<void>;
  };
  logs: {
    query: (filters: LogFilters) => Promise<AuditEntry[]>;
    stream: (cb: (entry: AuditEntry) => void) => () => void;
    exportCSV: (filters: LogFilters) => Promise<string>;
    exportJSON: (filters: LogFilters) => Promise<string>;
  };
  tools: {
    getSettings: () => Promise<Record<string, boolean>>;
    setEnabled: (tool: string, enabled: boolean) => Promise<Record<string, boolean>>;
    getEnabled: () => Promise<string[]>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (settings: Partial<AppSettings>) => Promise<void>;
    setApiKey: (key: string) => Promise<void>;
  };
  auth: {
    login: (password: string, totpCode?: string) => Promise<{ token: string }>;
    logout: () => Promise<void>;
    isAuthenticated: () => Promise<boolean>;
    isFirstRun: () => Promise<boolean>;
    setupPassword: (password: string) => Promise<void>;
    enableTOTP: () => Promise<{ secret: string; qrCode: string }>;
    verifyTOTP: (code: string) => Promise<boolean>;
    onLocked: (cb: () => void) => () => void;
  };
  codeburn: {
    spawn: (cols: number, rows: number) => Promise<{ ok: true } | { ok: false; error: string }>;
    write: (data: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    kill: () => Promise<void>;
    onData: (cb: (chunk: string) => void) => () => void;
    onExit: (cb: (info: { exitCode: number; signal: number | null }) => void) => () => void;
  };
  soul: {
    get: () => Promise<string>;
    update: (content: string) => Promise<boolean>;
  };
  user: {
    get: () => Promise<string>;
    update: (content: string) => Promise<boolean>;
  };
  rules: {
    getGlobal: () => Promise<string>;
    updateGlobal: (content: string) => Promise<void>;
    getAgent: (agentId: string) => Promise<string>;
    updateAgent: (agentId: string, content: string) => Promise<void>;
  };
  onboarding: {
    isCompleted: () => Promise<boolean>;
    markCompleted: () => Promise<void>;
    reset: () => Promise<void>;
  };
  vault: {
    list: () => Promise<Array<{
      key: string;
      label: string;
      description: string;
      service: string;
      required: boolean;
      configured: boolean;
      placeholder?: string;
      docsUrl?: string;
    }>>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    check: (key: string) => Promise<boolean>;
    /** Registers a new vault entry (if not already registered) and stores the value. */
    registerAndSet: (entry: {
      key: string;
      label: string;
      description: string;
      service: string;
      required: boolean;
      placeholder?: string;
      docsUrl?: string;
    }, value: string) => Promise<{ ok: true } | { error: string }>;
  };
  provider: {
    /** Tests connectivity using the stored vault key for the given provider. */
    testConnection: (
      providerName: string,
      baseUrl: string,
      apiKeyRef: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  image: {
    generate: (prompt: string, options?: { aspectRatio?: string }) =>
      Promise<{ base64: string; mimeType: string; prompt: string }>;
    edit: (prompt: string, imageBase64: string, imageMimeType: string, options?: { aspectRatio?: string }) =>
      Promise<{ base64: string; mimeType: string; prompt: string }>;
  };
  voice: {
    transcribe: (audioBase64: string) => Promise<string>;
    speak: (text: string, voiceId?: string) => Promise<{ base64: string; format: 'mp3' | 'opus' }>;
    readAudioFile: (path: string) => Promise<string>;
    listVoices: () => Promise<Array<{ voice_id: string; name: string; category: string; labels: Record<string, string>; preview_url: string }>>;
  };
  channels: {
    list: () => Promise<Channel[]>;
    get: (type: string) => Promise<Channel | null>;
    saveTelegram: (config: TelegramSaveConfig) => Promise<Channel>;
    toggle: (type: string, active: boolean) => Promise<void>;
    testTelegram: () => Promise<{ success: boolean; error?: string; botUsername?: string; botName?: string }>;
    telegramStatus: () => Promise<{ running: boolean }>;
  };

  google: {
    setup: (config: { clientId: string; clientSecret: string }) => Promise<{ success: boolean }>;
    authenticate: () => Promise<{ success: boolean; error?: string }>;
    status: () => Promise<{ hasCredentials: boolean; isAuthenticated: boolean }>;
    revoke: () => Promise<void>;
  };
  ollama: {
    check: (baseUrl: string, model: string, provider?: string) => Promise<{ available: boolean; models: string[] }>;
    listModels: (provider: string, baseUrl: string) => Promise<{ models: string[]; error?: string }>;
  };
  knowledge: {
    upload: (payload: { agentId: string; filePath: string; config: { strategy: ChunkStrategy; chunkSize: number; chunkOverlap: number; title?: string } }) => Promise<KnowledgeSource>;
    reprocess: (payload: { sourceId: string; strategy: ChunkStrategy; chunkSize: number; chunkOverlap: number }) => Promise<KnowledgeSource>;
    delete: (payload: { sourceId: string }) => Promise<{ success: boolean }>;
    list: (payload: { agentId: string }) => Promise<KnowledgeSource[]>;
    search: (payload: { agentId: string; query: string }) => Promise<KBSearchResult>;
    benchmark: {
      start: (payload: { sourceIds: string[]; agentId: string; config: { totalQuestions: number; modelJudge: 'sonnet' | 'opus'; threshold: number } }) => Promise<{ benchmarkId: string }>;
      status: (payload: { benchmarkId: string }) => Promise<{ status: string; progress: number; currentStage: string; result?: BenchmarkResult }>;
    };
    config: {
      get: (payload: { agentId: string }) => Promise<KnowledgeAgentConfig>;
      update: (payload: { agentId: string; config: Partial<KnowledgeAgentConfig> }) => Promise<KnowledgeAgentConfig>;
    };
    onIngestionProgress: (cb: (data: IngestionProgress) => void) => () => void;
    onBenchmarkProgress: (cb: (data: BenchmarkProgress) => void) => () => void;
  };
  harness: {
    createProject: (data: {
      name: string;
      description?: string;
      projectPath: string;
      // Aceita conteudo direto OU caminho pra um arquivo SPEC existente.
      specText?: string;
      specFilePath?: string;
      config: HarnessConfig;
    }) => Promise<{ projectId: string } | { error: string }>;
    plan: (projectId: string) => Promise<void | { error: string }>;
    approveSprints: (projectId: string) => Promise<void | { error: string }>;
    regenerateSprints: (projectId: string, feedback: string) => Promise<void | { error: string }>;
    run: (projectId: string) => Promise<void | { error: string }>;
    pause: (projectId: string) => Promise<void | { error: string }>;
    resume: (projectId: string) => Promise<void | { error: string }>;
    abort: (projectId: string) => Promise<void | { error: string }>;
    deleteProject: (projectId: string) => Promise<void>;
    getProject: (projectId: string) => Promise<HarnessProject | null>;
    listProjects: () => Promise<HarnessProject[]>;
    getSprints: (projectId: string) => Promise<HarnessSprint[]>;
    getSprintJson: (projectId: string, sprintJsonId: string) => Promise<SprintJsonDetail | null>;
    getSprintsJson: (projectId: string) => Promise<unknown>;
    getRounds: (sprintId: string) => Promise<HarnessRound[]>;
    getEvaluation: (projectId: string, sprintId: string) => Promise<EvaluationResult | null>;
    getMetrics: (projectId: string) => Promise<HarnessProjectMetrics>;
    getStreamLog: (projectId: string, sprintId: string) => Promise<{
      coder: { type: string; content?: string; tool?: string }[];
      evaluator: { type: string; content?: string; tool?: string }[];
      round: number;
    }>;
    getFeedbackAudit: (projectId: string, sprintId: string) => Promise<{
      timestamp: string;
      round: number;
      evaluatorVerdict: string;
      evaluatorSummary: string;
      failedCriteria: { description: string; justification: string }[];
      feedbackInjectedIntoCoder: string;
    }[]>;
    onProjectUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onSprintUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onAgentStream: (cb: (data: Record<string, unknown>) => void) => () => void;
    onMetricsUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onPlanningDone: (cb: (data: Record<string, unknown>) => void) => () => void;
    onError: (cb: (data: Record<string, unknown>) => void) => () => void;
  };
  mgraph: {
    graph: () => Promise<GraphData>;
    read: (path: string) => Promise<string>;
    search: (query: string) => Promise<MgraphSearchResult[]>;
    seed: (forceReseed?: boolean) => Promise<void>;
    stats: () => Promise<MgraphStats>;
    listNotes: (type: string) => Promise<NoteListItem[]>;
    deleteNote: (notePath: string, options?: { force?: boolean }) => Promise<{ success: boolean; backlinks?: BacklinkResult[]; error?: string }>;
    noteBacklinks: (notePath: string) => Promise<BacklinkResult[]>;
    onSeedProgress: (cb: (data: { processed: number; total: number; notesCreated: number }) => void) => () => void;
    onUpdated: (cb: () => void) => () => void;
    ingestFile: (filePath: string, fileName: string) => Promise<IngestJob>;
    ingestUrl: (url: string) => Promise<IngestJob>;
    ingestText: (text: string, title?: string) => Promise<IngestJob>;
    ingestResume: (jobId: string) => Promise<IngestJob>;
    ingestHistory: () => Promise<IngestJob[]>;
    ingestCancel: (jobId: string) => Promise<void>;
    ingestEstimate: (filePath: string) => Promise<IngestEstimate>;
    ingestDiscard: (jobId: string) => Promise<void>;
    ingestAccept: (jobId: string) => Promise<void>;
    ingestSettings: () => Promise<IngestSettings>;
    ingestSettingsUpdate: (settings: Record<string, string>) => Promise<void>;
    onIngestProgress: (cb: (data: IngestJob) => void) => () => void;
  };
  shell: {
    showInFolder: (filePath: string) => Promise<void>;
    openPath: (dirPath: string) => Promise<void>;
    selectDirectory: () => Promise<string | null>;
  };
  utils: {
    getPathForFile: (file: File) => string;
  };
  enrich: {
    start: (config: CreateEnrichConfig) => Promise<{ sessionId: string } | { error: string }>;
    send: (sessionId: string, message: string) => Promise<{ ok: true } | { error: string }>;
    approvePhase: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    finalize: (sessionId: string) => Promise<{ ok: true; finalSpecPath: string } | { error: string }>;
    abort: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    delete: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    getSpec: (sessionId: string) => Promise<{ finalSpecPath: string | null } | { error: string }>;
    listSessions: () => Promise<EnrichSession[]>;
    getMessages: (sessionId: string, phase?: string) => Promise<EnrichMessage[]>;
    openSpec: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    onStream: (cb: (chunk: unknown) => void) => () => void;
    onMetrics: (cb: (data: unknown) => void) => () => void;
    onStatus: (cb: (status: unknown) => void) => () => void;
  };
  pipeline: {
    start: (projectId: string, startPhase: number) => Promise<{ ok: true } | { error: string }>;
    advance: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    abort: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    pause: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    resume: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    send: (projectId: string, message: string, attachments?: ChatAttachment[]) => Promise<{ ok: true } | { error: string }>;
    getConversationPhases: () => Promise<PipelineConversationPhases>;
    approve: (projectId: string, metadata?: Record<string, unknown>) => Promise<{ ok: true } | { error: string }>;
    decided: (projectId: string, blockId: string) => Promise<{ ok: true } | { error: string }>;
    conclude: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    retry: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    confirmDevelopment: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    createProject: (data: { name: string; description: string; projectPath: string; startPhase: number; specPath?: string; prdPath?: string; pipelineType?: string }) => Promise<{ id: string } | { error: string }>;
    getSecurityAgentStatus: (projectId: string) => Promise<SecurityAgentStatus[]>;
    getAuditAgentsState: (projectId: string) => Promise<{ agents: Array<{ agentId: string; agentName: string; status: string; findingsCount?: number; costUsd: number; durationMs: number; model: string | null; startedAt?: string | null; completedAt?: string | null; toolCallsCount: number }> } | { error: string }>;
    deleteProject: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    listProjects: () => Promise<PipelineProject[]>;
    getProject: (projectId: string) => Promise<PipelineProject | { error: string }>;
    getPhaseMessages: (projectId: string, phase: number) => Promise<PipelineMessage[]>;
    readPhaseDocument: (projectId: string, phase: number) => Promise<{ path: string; content: string } | { error: string }>;
    getMetrics: (projectId: string) => Promise<PipelineMetricsResult | { error: string }>;
    getReport: (projectId: string) => Promise<{ report: string } | { error: string }>;
    exportReport: (projectId: string, format: 'md') => Promise<{ ok: true; reportPath: string } | { error: string }>;
    openProjectFile: (projectId: string, relativePath: string) => Promise<{ ok: true } | { error: string }>;
    openSmokeTest: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    getSmokeTestPath: (projectId: string) => Promise<{ exists: boolean; path?: string }>;
    onStream: (cb: (chunk: PipelineStreamChunk) => void) => () => void;
    onPhaseChanged: (cb: (event: PipelinePhaseChangedEvent) => void) => () => void;
    onProjectUpdated: (cb: (event: PipelineProjectUpdatedEvent) => void) => () => void;
    onNotesUpdated: (cb: (event: PipelineNotesUpdatedEvent) => void) => () => void;
    onSprintComplete: (cb: (event: PipelineSprintCompleteEvent) => void) => () => void;
    onSprintUpdated: (cb: (data: { sprintIndex: number; status: string; round: number }) => void) => () => void;
    onAgentCompleted: (cb: (data: { projectId: string }) => void) => () => void;
    onDocumentUpdated: (cb: (data: { projectId: string; path: string; content: string }) => void) => () => void;
    onSprintsLoaded: (cb: (data: { projectId: string; sprints: Array<{ index: number; name: string; status: string; coderAgentId?: string; evaluatorAgentId?: string; sprintJsonId?: string; sprintId?: string }> }) => void) => () => void;
    onSprintRound: (cb: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void) => () => void;
    resetPhase: (projectId: string, phase: number) => Promise<{ ok: boolean; error?: string }>;
    resetSprint: (projectId: string, sprintIndex: number) => Promise<{ ok: boolean; error?: string }>;
    getResetPreview: (projectId: string, target: { phase?: number; sprintIndex?: number }) => Promise<{ filesToDelete: string[]; messagesToDelete: number; metricsToDelete: number; sprintsAffected: number[] }>;
    readPhaseArtifact: (projectId: string, phase: number) => Promise<PipelinePhaseArtifact>;
    getSprintHistory: (projectId: string, sprintIndex: number) => Promise<PipelineSprintMessage[]>;
    listSprints: (projectId: string) => Promise<HarnessSprint[]>;
    getSprintDetail: (projectId: string, sprintIndex: number) => Promise<{ sprint: HarnessSprint } | { error: string }>;
    onResetComplete: (cb: (data: { projectId: string; phase?: number; sprintIndex?: number }) => void) => () => void;
    onSecurityAgentStatus: (cb: (data: { projectId: string; agentId: string; agentName: string; status: 'pending' | 'running' | 'completed' | 'failed'; findingsCount?: number; error?: string }) => void) => () => void;
    onAuditAgentProgress: (cb: (event: import('./pipeline').PipelineAuditAgentProgressEvent) => void) => () => void;
    onResolutionTrackerComplete: (cb: (data: { projectId: string }) => void) => () => void;
    readManifest: (projectId: string) => Promise<import('./pipeline').RepoManifest | null>;
    onManifest: (cb: (data: { projectId: string; manifest: import('./pipeline').RepoManifest }) => void) => () => void;
    onStalled: (cb: (data: { projectId: string; phase: number; agentId: string; lastChunkAt: number; secondsSinceLastChunk: number }) => void) => () => void;
    onAuthRequired: (cb: (data: { projectId: string; phaseNumber: number; agentId: string; message: string }) => void) => () => void;
    resumeAfterAuth: (projectId: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  };
  dialog: {
    openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
    openDirectory: () => Promise<string | null>;
  };
  codex: {
    status: () => Promise<{ installed: boolean; version: string | null; authenticated: boolean }>;
    test: () => Promise<{ ok: boolean; message: string }>;
    openLogin: () => Promise<{ ok: boolean }>;
    setBinaryPath: (path: string) => Promise<{ ok: boolean }>;
    // SPEC-codex-windows-fix.md Camada 2 + 3 + 4
    checkPrepNeeded: (projectPath: string) => Promise<CodexPrepCheckResult>;
    applyPrep: (repoRoot: string) => Promise<CodexPrepApplyResult>;
    grantSkipConsent: (repoRoot: string) => Promise<{ ok: boolean; error?: string }>;
    onWindowsHealthWarning: (handler: (payload: CodexWindowsHealthWarning) => void) => () => void;
    onPatchFailureWarning: (handler: (payload: CodexPatchFailureWarning) => void) => () => void;
    onWindowsPrepSkipped: (handler: (payload: CodexWindowsPrepSkipped) => void) => () => void;
  };
}

// ---- pipeline IPC return types — sincronizar com handlers em ipc-handlers.ts ----

/**
 * Retorno de `pipeline:get-conversation-phases`. Cada chave mapeia para um
 * `pipelineType` do engine (campo `pipelineType` em `PipelineProject`):
 * - `security`     → SECURITY_CONVERSATION_PHASES (engine)
 * - `dev`          → DEV_CONVERSATION_PHASES (engine, tambem aplicado a feature)
 * - `architecture` → ARCHITECTURE_CONVERSATION_PHASES (engine, pipeline-type 'architecture-review')
 *
 * Note: `feature` nao tem entrada propria — o engine usa DEV_CONVERSATION_PHASES
 * pra ambos. Fica explicito aqui pra evitar surpresa em call sites futuros.
 */
export interface PipelineConversationPhases {
  security: number[];
  dev: number[];
  architecture: number[];
}

/**
 * Retorno de `pipeline:read-phase-artifact`. Tipo discriminado por `type`:
 * - `markdown`     → conteudo de arquivo MD generico (PRD, SPEC, stories, etc).
 * - `sprints`      → lista de sprints persistidos no DB (planner output).
 * - `architecture` → fase 1-7 do architecture-review pipeline; renderer escolhe
 *                    entre rich view (1-4) e markdown view (5-7) baseado em `phase`.
 *                    `markdown` e `json` sao independentemente opcionais.
 * - `{ error }`    → projectId nao encontrado (handler retorna `{ error: 'Project not found' }`).
 */
export type PipelinePhaseArtifact =
  | { type: 'markdown'; content: string }
  | { type: 'sprints'; sprints: HarnessSprint[] }
  | { type: 'architecture'; phase: number; markdown: string | null; json: string | null }
  | { error: string };

// ---- SPEC-codex-windows-fix.md tipos compartilhados (renderer + main) ----

export type CodexWindowsIssueType =
  | 'autocrlf-true'
  | 'no-gitattributes'
  | 'mixed-line-endings'
  | 'powershell-5.1';

export interface CodexWindowsIssue {
  type: CodexWindowsIssueType;
  severity: 'low' | 'medium' | 'high';
  message: string;
  hint: string;
}

export interface CodexPrepCheckResult {
  needs: boolean;
  reason:
    | 'not-windows'
    | 'not-git-repo'
    | 'codex-not-authenticated'
    | 'no-codex-agents'
    | 'no-issues'
    | 'consent-current'
    | 'consent-skip-current'
    | 'needs-dialog';
  repoRoot?: string;
  issues?: CodexWindowsIssue[];
  consent?: {
    repoRoot: string;
    prepVersion: number;
    action: 'prepared' | 'skip';
    consentedAt: number;
    lastAppliedAt: number | null;
  } | null;
}

export type CodexPrepApplyResult =
  | { applied: true; filesAffected: number }
  | {
      applied: false;
      reason: 'not-windows' | 'no-git-repo' | 'has-submodules' | 'dirty-tree' | 'error';
      message?: string;
    };

export interface CodexWindowsHealthWarning {
  projectId?: string;
  agentId: string;
  cwd: string;
  repoRoot: string;
  timestamp: number;
  issues: CodexWindowsIssue[];
}

export interface CodexPatchFailureWarning {
  projectId?: string;
  agentId: string;
  cwd: string;
  count: number;
  samples: Array<{ source: string; text: string; ts: number }>;
  timestamp: number;
}

export interface CodexWindowsPrepSkipped {
  projectId?: string;
  repoRoot: string;
  reason: string;
  timestamp: number;
}

declare global {
  interface Window {
    lionclaw: LionClawAPI;
  }
}

// ---- Knowledge Base ----

export type ChunkStrategy = 'recursive' | 'semantic' | 'page' | 'csv' | 'agentic';

export interface KnowledgeSource {
  id: string;
  agentId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  title?: string;
  description?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  chunksCount: number;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  qualityScore?: number;
  bestStrategy?: string;
  errorMessage?: string;
  createdAt: string;
  processedAt?: string;
  updatedAt: string;
}

export interface KnowledgeAgentConfig {
  agentId: string;
  hydeEnabled: boolean;
  hydeThreshold: number;
  minScore: number;
  defaultStrategy: ChunkStrategy;
  rerankEnabled: boolean;
  rerankTopK: number;
  searchTopK: number;
}

export interface KBSearchResult {
  found: boolean;
  strategy: 'hybrid_direct' | 'hyde_hybrid' | 'hybrid_fallback' | 'not_found';
  results: Array<{
    chunk_id: string;
    source_id: string;
    source_name: string;
    content: string;
    rerank_score: number;
    chunk_index: number;
    token_count: number;
    metadata: Record<string, unknown>;
  }>;
  query_used: string;
  latency_ms: number;
}

export interface BenchmarkResult {
  benchmark_id: string;
  winner: string;
  winner_score: number;
  execution_time_s: number;
  questions: string[];
  strategies: Record<string, Record<string, {
    avg_score: number;
    true_rate: number;
    llm_judge_avg: number;
    raw_scores: number[];
  }>>;
}

export interface IngestionProgress {
  sourceId: string;
  stage: 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'completed' | 'failed';
  progress: number;
}

export interface BenchmarkProgress {
  benchmarkId: string;
  stage: string;
  strategy?: string;
  mode?: string;
  current: number;
  total: number;
  done?: boolean;
}

// ---- Enrich Pipeline ----

export type EnrichPhase = 'validator' | 'enricher' | 'done';
export type EnrichStatus = 'idle' | 'running' | 'waiting' | 'finalizing' | 'done';

export interface EnrichMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  messages: number;
}

export interface EnrichSession {
  id: string;
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  userMessage?: string;
  validatorAgentId: string;
  enricherAgentId: string;
  phase: EnrichPhase;
  status: EnrichStatus;
  finalSpecPath?: string;
  validatorMetrics: EnrichMetrics;
  enricherMetrics: EnrichMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnrichConfig {
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  message?: string;
  validatorAgentId: string;
}

export interface EnrichStatusEvent {
  sessionId: string;
  phase: EnrichPhase;
  status: EnrichStatus;
}

export interface EnrichMetricsEvent {
  sessionId: string;
  phase: EnrichPhase;
  metrics: EnrichMetrics;
}

export interface EnrichMessage {
  id: number;
  sessionId: string;
  phase: EnrichPhase;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

// ---- Ingest & Notes ----

export interface IngestJob {
  id: string;
  fileName: string;
  sourceType: string;
  originalPath?: string;
  fileHash?: string;
  status: 'extracting' | 'estimating' | 'waiting_confirm' | 'processing' | 'completed' | 'failed' | 'partial';
  totalChunks: number;
  processedChunks: number;
  lastProcessedChunk: number;
  notesCreated: number;
  notesUpdated: number;
  estimatedCostUsd?: number;
  truncated?: boolean;
  originalChunkCount?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdNotePaths?: string[];
}

export interface IngestEstimate {
  totalChunks: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  requiresConfirmation: boolean;
  truncated: boolean;
  originalChunkCount: number;
}

export interface IngestSettings {
  visionModel: string;
  extractionModel: string;
  sttProvider: 'elevenlabs' | 'whisper';
  maxFileSizeMb: number;
  maxChunks: number;
  autoConfirm: boolean;
  pdfExtractor: 'auto' | 'pdfjs' | 'vision';
  urlLevel: 1 | 2 | 3;
}

export interface NoteListItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  snippet: string;
  updatedAt: string;
}

export interface BacklinkResult {
  path: string;
  title: string;
  linkContext: string;
}

// ---- Memory Graph (mgraph) ----

export interface VaultOperation {
  action: 'create' | 'update';
  path: string;
  type: 'entity' | 'meeting' | 'decision' | 'project' | 'reference';
  title: string;
  tags: string[];
  content: string;
  append?: boolean;
}

export interface MgraphSearchResult {
  path: string;
  title: string;
  type: string;
  snippet: string;
}

export interface MgraphStats {
  totalNotes: number;
  totalConnections: number;
  lastUpdated: string;
  notesByType: Record<string, number>;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  connections: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---- Harness ----

export interface HarnessProject {
  id: string;
  name: string;
  description?: string;
  projectPath: string;
  specPath: string;
  sprintsJsonPath?: string;
  status: 'idle' | 'planning' | 'reviewing' | 'ready' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  config: HarnessConfig;
  currentSprintIndex: number;
  totalSprints: number;
  totalFeatures: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
  plannerCacheTokens: number;
  plannerCostUsd: number;
  plannerDurationMs: number;
  createdAt: string;
  updatedAt: string;
  pipelineType?: import('./pipeline').PipelineType;
  pipelineDocsId?: string | null;
  // Pipeline progress fields (V37+, lidos pelo mapHarnessProject em db.ts).
  // Existem como colunas reais em harness_projects e sao consumidos pelo
  // pipeline-engine/handlers — declarados aqui pra eliminar drift type/DB.
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  pipelineSprintIndex?: number;
  pipelineDiscoveryBlock?: number;
  // Caminhos opcionais persistidos no DB.
  prdPath?: string;
  discoveryNotesPath?: string;
  // Security pipeline summary (JSON serialized) — populado pos-fase 3.
  securitySummaryJson?: string | null;
}

export interface HarnessConfig {
  maxRoundsPerSprint: number;
  usePlaywright: boolean;
  evaluatorAgentId: string;
  plannerAgentId: string;
  stack: string[];
  plannerOutputFormat?: 'json' | 'markdown';
  /**
   * Per-pipelineType extension config.
   * Architecture review uses this to persist runId + selectedCandidateId
   * without needing a dedicated DB column (R10-friendly).
   */
  architectureReview?: {
    runId?: string;
    selectedCandidateId?: string | null;
  };
}

export interface HarnessSprint {
  id: string;
  projectId: string;
  sprintIndex: number;
  sprintJsonId: string;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'rejected' | 'failed' | 'interrupted' | 'skipped';
  verdict?: string | null;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  roundsUsed: number;
  maxRounds: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface SprintJsonDetail {
  id: string;
  index: number;
  name: string;
  description: string;
  coder_agent_id: string;
  stack: string[];
  features: {
    id: string;
    name: string;
    description: string;
    acceptance_criteria: string[];
  }[];
  hints: {
    existing_files: string[];
    key_interfaces: string[];
    architecture_notes: string;
  };
  dependencies: string[];
  complexity: 'low' | 'medium' | 'high';
  estimated_rounds: number;
}

export type CostSource = 'sdk_anthropic' | 'reported' | 'calculated' | 'fallback_zero';

export interface HarnessRound {
  id: string;
  sprintId: string;
  roundNumber: number;
  coderSessionId?: string;
  coderInputTokens: number;
  coderOutputTokens: number;
  coderCacheTokens: number;
  coderCostUsd: number;
  coderDurationMs: number;
  coderToolUses: number;
  coderApiRequests: number;
  evaluatorSessionId?: string;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCacheTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  evaluatorToolUses: number;
  evaluatorApiRequests: number;
  verdict?: 'pass' | 'fail';
  feedbackSummary?: string;
  startedAt: string;
  completedAt?: string;
  /** How the cost was determined for this round. Null for rounds created before V44. */
  costSource?: CostSource | null;
  /** Runtime used to execute this round. Null for rounds created before V44. */
  runtimeUsed?: 'cloud' | 'local' | 'external' | 'codex' | null;
  /** Provider slug used to execute this round. Null for rounds created before V44. */
  providerUsed?: string | null;
  /** Exact model slug executed in this round. Null for rounds created before V44. */
  modelUsed?: string | null;
  /** Free-form telemetry bag. Added in V46. */
  metadata?: Record<string, unknown>;
  /** SPEC-codex-windows-fix.md Camada 4: contagem de apply_patch verification
   *  failures observados durante este round. Sempre 0 pra runtimes nao-Codex.
   *  Adicionado em V51. */
  codexPatchFailures?: number;
}

export interface HarnessProjectMetrics {
  totalCost: number;
  totalDuration: number;
  totalRounds: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalApiRequests: number;
  passRate: number;
  coderCost: number;
  evaluatorCost: number;
  plannerCost: number;
  sprintMetrics: SprintMetrics[];
}

export interface SprintMetrics {
  sprintId: string;
  name: string;
  rounds: number;
  coderCost: number;
  evaluatorCost: number;
  totalCost: number;
  coderInputTokens: number;
  coderOutputTokens: number;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  duration: number;
  verdict: 'passed' | 'failed';
}

export interface EvaluationResult {
  sprintId: string;
  round: number;
  verdict: 'pass' | 'fail';
  criteria: EvaluationCriterion[];
  summary: string;
  timestamp: string;
}

export interface EvaluationCriterion {
  id: string;
  featureId: string;
  description: string;
  result: 'pass' | 'fail';
  justification: string;
}
