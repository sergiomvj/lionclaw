# LionClaw

Assistente pessoal de IA rodando como app desktop Electron. Single-user, single-machine. O agente tem acesso completo ao terminal, filesystem e internet via Claude Agent SDK, com runtimes alternativos (Codex CLI, modelos locais via Ollama, externos via HTTP).

## 1. Quick Context

App Electron (main + renderer). Main process: orquestrador Node.js com Agent SDK, SQLite, scheduler, MCP manager, Telegram bot, knowledge engine, pipeline-engine multi-fase (security/feature/dev/architecture-review) e harness loop coder/evaluator. Renderer process: React + Vite (chat, pipeline, harness, enrich, knowledge, settings). Comunicacao via Electron IPC. Sem servidor web, sem portas expostas.

## 2. Stack

| Componente | Tecnologia |
|-----------|-----------|
| Desktop runtime | Electron 33+ |
| Frontend | React 19 + Vite + TailwindCSS |
| State management | Zustand |
| Backend (main process) | Node.js + TypeScript |
| AI engine principal | @anthropic-ai/claude-agent-sdk |
| Runtimes alternativos | Codex CLI bridge, Ollama local, HTTP external |
| Database | better-sqlite3 + sqlite-vec |
| Embeddings | @anthropic-ai/sdk (Anthropic Embeddings API) |
| Alt LLMs | @google/genai (Gemini), cohere-ai, ollama-client (local) |
| Scheduler | cron-parser |
| Logger | pino |
| Secrets | node-keytar (OS keychain) |
| Auth | bcrypt + otplib (TOTP) |
| Telegram | node-telegram-bot-api |
| Doc parsing | pdf-parse, mammoth (DOCX), csv-parse |
| Terminal UI | xterm.js |
| Markdown | react-markdown + remark-gfm |
| Icons | lucide-react |

## 3. Architecture

```
electron/main/                  -> Electron main process (Node.js)
  index.ts                      -> Entry point, window creation, boot sequence
  orchestrator.ts               -> Message queue, subagent delegation, SDK sessions (chat)
  message-queue.ts              -> Fila de mensagens do chat
  db.ts                         -> SQLite schema, 50 migracoes, todas as CRUD (~5k linhas)
  db-migrations/                -> Migrations isoladas (ex: v50-prompts.ts)
  ipc-handlers.ts               -> Todos os handlers IPC registrados aqui (~2.8k linhas)
  permission-guard.ts           -> canUseTool callback, deteccao de acoes destrutivas
  prompt-builder.ts             -> System prompt (rules + memory + agent rules)
  harness-engine.ts             -> Harness loop: planner -> coder -> evaluator (loops standalone)
  harness-planner.ts            -> Sprint planning via AI
  harness-evaluator.ts          -> Avaliacao de codigo vs criterios
  harness-prompts.ts            -> Builders de prompt (coder, evaluator, validator, enricher)
  knowledge-engine.ts           -> Knowledge base: ingest, chunk, embed, search
  knowledge-ipc-bridge.ts       -> IPC bridge do knowledge
  memory-pipeline.ts            -> Compactacao, sumarizacao, embedding
  scheduler.ts                  -> Cron task runner
  mcp-manager.ts                -> Lifecycle MCP servers
  mcp-discovery.ts              -> Descoberta de SDK MCP
  mcp-tool-bridge.ts            -> Bridge tool->MCP
  telegram-bridge.ts            -> Telegram bot
  secrets-vault.ts              -> Encrypt/decrypt via node-keytar
  auth.ts                       -> Password hash, TOTP, session tokens
  pricing.ts                    -> calculateCost(model, ...)
  logger.ts                     -> Pino factory (createLogger)
  paths.ts                      -> Caminhos (.lionclaw home, etc)
  pipeline-paths.ts             -> Caminhos dos artefatos por projeto pipeline
  pipeline-report.ts            -> Geracao de relatorios consolidados
  image-engine.ts               -> Image processing
  voice-engine.ts               -> Voice/TTS (ElevenLabs)
  artifact-detector.ts          -> Deteccao de artefatos em tool results
  repo-profiler.ts              -> Profiler do repo alvo
  security-audit-runner.ts      -> Runner multi-agente da auditoria de seguranca
  security-findings-parser.ts   -> Parser dos findings JSON
  json-extractor.ts             -> Extrai JSON de texto livre
  stream-processor.ts           -> Pipeline de chunks
  ask-question.ts               -> Interatividade ask_question tool
  smoke-test-runner.ts          -> Runner de smoke tests
  graph-ingest.ts               -> Ingestao para graph engine
  mgraph-engine.ts              -> Memory graph engine
  ollama-client.ts              -> Cliente Ollama local
  excalidraw-views.ts           -> Persistencia views Excalidraw
  embedding-provider.ts         -> Provider abstrato de embeddings
  agent-config-resolver.ts      -> Resolve config final por agentId
  channels-db.ts                -> Persistencia canais (Telegram)
  google-auth.ts                -> OAuth Google (Gmail/Drive/Calendar/Sheets)
  onboarding.ts                 -> Onboarding flow
  vault-registry.ts             -> Registry de secrets

  architecture-review-paths.ts  -> Helpers de paths para pipeline architecture-review:
                                   generateRunId (YYYYMMDD_HHmmss-hex6), getContext,
                                   ensureContext, readManifest, patchManifest,
                                   resolvePhaseDocument

  pipeline-engine/              -> Pipeline multi-fase (S5.0: folder)
    index.ts                    -> Despacho por pipelineType + execucao por fase
                                   (handler extraction S5.1-S5.3 deferida)

  pipeline-shared/              -> Helpers compartilhados (pipeline + harness + enrich)
    ipc-emitter.ts              -> emitIPC tipado
    ipc-helpers.ts              -> Helpers IPC repetidos
    lock.ts                     -> acquireProjectLock / ensureProjectLock / releaseProjectLock
    persist.ts                  -> persistMessage (discriminated), persistHarnessRound.{insert,update}
    project-mapper.ts           -> Mapeia DB row -> objeto de UI
    sdk-bootstrap.ts            -> Bootstrap configuracao SDK
    status.ts                   -> HarnessProjectStatus (DB), UIStatus, deriveUIStatus, setProjectStatus
    stream/
      pipeline-stream.ts        -> emitPipelineStream(...) por canal
      harness-stream.ts         -> emitHarnessStream(...)
      security-stream.ts        -> emitSecurityStream(...)
      enrich-stream.ts          -> emitEnrichStream(...)

  agent-runtime/                -> Abstracao por runtime
    index.ts                    -> Re-exports
    types.ts                    -> ToolDecision, AgentPermissionProfile, AgentExecutionRequest/Result, RuntimeExecutor
    permission-profiles.ts      -> PERM_BYPASS_NO_GUARD, PERM_DEFAULT_WITH_GUARD, PERM_DEFAULT_NO_BYPASS
    execute.ts                  -> executeAgent(req): despacha por req.runtime
    cloud-executor.ts           -> Anthropic SDK
    codex-executor.ts           -> Codex CLI bridge
    local-executor.ts           -> Ollama local
    external-executor.ts        -> HTTP externo
    external-http.ts            -> Cliente HTTP do external
    watchdog.ts                 -> Timeout e cancelamento por execucao
    tool-schemas.ts             -> Schemas das tools por runtime

  codex-bridge.ts               -> Bridge processo Codex CLI
  codex-agent-tools.ts          -> Tools expostas para o Codex
  codex-agents-mcp.ts           -> MCP Codex
  local-agent-tools.ts          -> Tools dos agentes locais
  local-tool-executor.ts        -> Executor de tools locais

  seed-agents/                  -> Agent configs pre-build
    index.ts                    -> Registry, exporta arrays HARNESS / PIPELINE / SECURITY / FEATURE / ENRICH
    ensure.ts                   -> reconcileSeedAgent (INSERT-ONLY, R6)
    _shared/                    -> Blocos compartilhados de prompt
      critical-rules.ts         -> CRITICAL_RULES_BLOCK
      git-restrictions.ts       -> GIT_RESTRICTIONS_BLOCK
      language-pt-br.ts         -> PT_BR_BLOCK
    harness-planner.ts          -> Planner (opus, max effort)
    harness-coder.ts            -> Coder (sonnet, high effort)
    harness-evaluator.ts        -> Evaluator
    spec-builder.ts             -> SPEC generator (squad pipeline, usado em dev/feature/security)
    spec-validator.ts           -> SPEC validator
    spec-validator-enrich.ts    -> SPEC validator (Enrich, squad enrich)
    spec-enricher.ts            -> SPEC enricher (Enrich, squad enrich)
    sprint-validator.ts         -> Sprint validator
    discovery-agent.ts          -> Discovery (dev pipeline)
    feat-discovery.ts           -> Feature discovery (feature pipeline)
    feat-prd-generator.ts       -> PRD generator (feature)
    feat-prd-validator.ts       -> PRD validator (feature)
    feat-prd-completo.ts        -> PRD completo (feature)
    feat-tech-database.ts       -> Tech Database (feature)
    feat-tech-backend.ts        -> Tech Backend (feature)
    feat-tech-frontend.ts       -> Tech Frontend (feature)
    feat-tech-security.ts       -> Tech Security (feature)
    architecture-mapper.ts          -> Architecture Review fase 1 (Map, opus)
    architecture-target-triage.ts   -> Architecture Review fase 2 (Triage, sonnet)
    architecture-diagnostician.ts   -> Architecture Review fase 3 (Diagnosis, opus)
    architecture-decision-interviewer.ts -> Architecture Review fase 4 (Decisions, sonnet)
    prd-generator.ts            -> PRD generator (dev)
    prd-validator.ts            -> PRD validator (dev)
    tech-database.ts            -> Tech database (dev)
    tech-backend.ts             -> Tech backend (dev)
    tech-frontend.ts            -> Tech frontend (dev)
    tech-security.ts            -> Tech security (dev)
    repo-profiler.ts            -> Repo profiler (security pipeline)
    security-auth-auditor.ts    -> Auth auditor (security audit)
    security-secrets-scanner.ts -> Secrets scanner
    security-owasp-scanner.ts   -> OWASP scanner
    security-isolation-inspector.ts -> Isolation inspector
    security-logic-analyzer.ts  -> Logic analyzer
    security-standards-checker.ts -> Standards checker
    security-duplication-detector.ts -> Duplication detector
    security-deduplicator.ts    -> Deduplicator
    security-resolution-tracker.ts -> Resolution tracker
    security-skeptic-security.ts -> Skeptic security (validacao conversacional)
    security-skeptic-quality.ts -> Skeptic quality
    backend-developer.ts        -> Specialist generico
    frontend-developer.ts       -> Specialist generico
    electron-pro.ts             -> Specialist Electron
    nextjs-developer.ts         -> Specialist Next.js
    javascript-pro.ts           -> Specialist JS
    skill-creator.ts            -> Skill creator

electron/preload/
  index.ts                      -> contextBridge: window.lionclaw.{chat,agents,pipeline,harness,enrich,knowledge,...}

src/                            -> Renderer (React)
  App.tsx                       -> Switch por currentPage, gate de auth, subscriptions IPC
  pages/
    ChatPage.tsx                -> Chat principal
    PipelinePage.tsx            -> Pipelines multi-fase (security/feature/dev) + harness execution
    HarnessPage.tsx             -> Dashboard harness standalone
    EnrichDocPage.tsx           -> Enrich pipeline (validator chat, enricher chat)
    SubAgentsPage.tsx           -> Agent CRUD
    SkillsPage.tsx              -> Skill management
    MCPServersPage.tsx          -> MCP server config
    SchedulerPage.tsx           -> Cron tasks
    LogsPage.tsx                -> System logs
    SettingsPage.tsx            -> App settings (inclui CodexSection e RuntimeBadge)
    AuthPage.tsx                -> Login + TOTP
    MemoryPage.tsx              -> Memory management
    VaultPage.tsx               -> Secrets vault
    KnowledgePage.tsx           -> Knowledge base (ingest, search, manage)
    GraphPage.tsx               -> Memory graph view
    TasksPage.tsx               -> Task management
    UsagePage.tsx               -> Token usage analytics
    ChannelsPage.tsx            -> Telegram integration
    PermissionsPage.tsx         -> Permission management
  components/
    chat/                       -> ChatMessage, ConfirmDialog, AskQuestionDialog, AudioPlayer,
                                   VoiceRecorder, TokenCounter, AgentThinking, ArtifactRenderer,
                                   SlashCommandPicker, ExcalidrawViewer, McpAppViewer
    pipeline/                   -> PipelineProjectList, PipelineProjectCard, PipelineChatView,
                                   PipelineStreamView, PipelineMetricsFooter, PipelineMetricsReport,
                                   PipelineProgressBar, PhaseActionButtons, PhaseDocumentButton,
                                   PhaseHistoryView, NewPipelineModal, ResetConfirmDialog,
                                   AuditMultiPanelView, AuditFinalSummaryView, SecurityAuditProgress,
                                   RepoProfilerView, SprintListBar, SprintExecutionView,
                                   SprintsFormattedView, TechGroup, DocumentPreview,
                                   CodexAuthRequiredModal
    harness/                    -> ProjectList, ProjectCard, ProjectDetail, NewProjectModal,
                                   ExecutionView, MetricsView, MetricsChart, SprintList,
                                   SprintCard, AgentStreamPanel, RegenerateModal, RoundHistory,
                                   CriteriaList
    enrich/                     -> EnrichModal, EnrichControls, EnrichMetricsBar,
                                   EnrichPhaseIndicator, EnrichSessionCard, SpecViewer
    agents/                     -> AgentFormModal, DeleteAgentDialog
    scheduler/                  -> TaskList, TaskFormModal, CalendarView, KanbanView,
                                   ActivityBoard, ActivityCard, ActivityFilters
    skills/                     -> SkillFormModal, SkillEditor, SkillWizard
    settings/                   -> VoiceSelector, GoogleOAuthSetup, CodexSection
    channels/                   -> TelegramSetup
    graph-view/                 -> Componentes do GraphPage
    common/                     -> Sidebar, MarkdownEditor, OpenFolderButton, RuntimeBadge
  stores/                       -> Zustand stores
    app-store.ts                -> Page routing, global state
    auth-store.ts               -> Auth state
    chat-store.ts               -> Chat sessions
    pipeline-store.ts           -> Pipeline projects (security/feature/dev)
    harness-store.ts            -> Harness projects standalone
    enrich-store.ts             -> Enrich sessions
    knowledge-store.ts          -> Knowledge base state
  constants/
    codex-models.ts             -> Modelos Codex disponiveis
  types/
    index.ts                    -> Tipos compartilhados (~1.3k linhas, ~34KB)
    pipeline.ts                 -> PIPELINE_PHASES, SECURITY_PIPELINE_PHASES, FEATURE_PIPELINE_PHASES, PhaseDefinition

.lionclaw/                      -> Dados persistentes do agente (gitignored)
  MEMORY.md                     -> Working memory (em todo prompt)
  RULES.md                      -> Regras globais (system prompt)
  SOUL.md                       -> Personalidade
  USER.md                       -> Preferencias usuario
  BOOTSTRAP.md                  -> Guia inicializacao
  agents/{name}/                -> Por agente: RULES.md, config.json
  skills/{name}/SKILL.md        -> Skills com frontmatter
  conversations/                -> Transcripts arquivados
  data/
    lionclaw.db                 -> SQLite (WAL, FK on)
    sessions/                   -> Sessoes Agent SDK
  pipelines/{projectId}/        -> Artefatos por pipeline (PRD, SPEC, sprints, audits, etc)

mcp-servers/                    -> 15 MCP servers standalone
  google-calendar, google-gmail, google-drive, google-sheets,
  elevenlabs, excalidraw, knowledge-base, memory-search, graph-search,
  local-agents, local-llm, skills, youtube, shopify, nano-banana
```

### Boot Sequence (electron/main/index.ts)

1. Exception handlers
2. BrowserWindow
3. `initDatabase()` -> SQLite + migrations V1-V51
4. Seed: tool defaults + ensure*Agents (harness, pipeline, security, feature, enrich)
5. `registerIPCHandlers()`
6. `startScheduler()`
7. `startTelegramBot()`
8. `startActiveMCPServers()`
9. `discoverSDKMcpServers()`
10. `startKnowledgeBridge()`
11. `HarnessEngine` instanciado
12. `PipelineEngine` (despacho por pipelineType) disponivel via IPC

### Core Systems

#### Orchestrator (orchestrator.ts)

Message queue: `submitMessage()` enfileira, `processQueue()` desenfileira e chama `executeQuery()`. Mantem estado da sessao SDK. Builda subagent definitions a partir dos agents ativos no DB. Integra permission guard, MCP config, artifact detection.

Excecao DOCUMENTADA (D6): orchestrator usa `query()` direto e calcula custo localmente; nao migra para `executeAgent`.

#### Pipeline Engine (`pipeline-engine/index.ts`)

Despacho por `pipelineType` (`security` | `feature` | `dev` | `architecture-review`):
- security             -> `SECURITY_PIPELINE_PHASES` (11 fases, ver secao 5.5)
- feature              -> `FEATURE_PIPELINE_PHASES` (14 fases)
- dev                  -> `PIPELINE_PHASES` (variante dev, ver `src/types/pipeline.ts`)
- architecture-review  -> `ARCHITECTURE_REVIEW_PIPELINE_PHASES` (11 fases, ver secao 5.5)

Cada fase chama `executeAgent` do `agent-runtime/`. Conversational phases pausam aguardando input do usuario (status `awaiting-user`); auto phases rodam ate concluir.

S5.1-S5.3 (handler extraction por fase para arquivos separados) DEFERIDOS. Por enquanto tudo dentro de `pipeline-engine/index.ts`.

#### Harness System (standalone)

Loop coder/evaluator independente do pipeline-engine:
- Planner (opus): decompoe SPEC em sprints com features e criterios
- Coder (sonnet): implementa
- Evaluator: valida vs criterios, devolve feedback
- Loop: coder -> evaluator -> feedback -> coder (max rounds configuravel)

Tabelas: `harness_projects`, `harness_sprints`, `harness_rounds`. Os mesmos seed agents (harness-planner, harness-coder, harness-evaluator) sao reusados pelos pipelines security/feature/dev nas fases de execucao.

#### Enrich Pipeline

Duas fases conversacionais para enriquecer SPEC antes do code:
- Validator (`spec-validator-enrich`): audita SPEC vs codigo/PRD, reporta gaps
- Enricher (`spec-enricher`): adiciona edge cases, UI states, paths alternativos, permissoes
- Conversacional, isolado por fase. Transicao mata validator e spawna enricher com contexto fresco
- Agentes editam SPEC direto via Write/Edit (auto-aprovado em specPath via permission guard)

Tabelas: `enrich_sessions`, `enrich_messages`. IPC: `enrich:start`, `enrich:send`, `enrich:approve-phase`, `enrich:finalize`, `enrich:abort`, `enrich:open-spec`, `enrich:get-messages`, `enrich:list-sessions`. Stream: `enrich:stream` (StreamChunk), `enrich:metrics`, `enrich:status`.

#### Security Audit (security-audit-runner.ts)

Multi-agent run da fase 2 do security pipeline. 7 specialists em paralelo (auth, secrets, owasp, isolation, logic, standards, duplication). Resultados sao parseados por `security-findings-parser.ts` e consolidados em MD persistido em disco. **Os streams individuais NAO ficam persistidos**; revisita mostra apenas o consolidado.

#### Knowledge Engine

Ingestao (PDF, DOCX, CSV, MD), chunking, embedding via Anthropic API, busca semantica via sqlite-vec. IPC bridge dedicado.

#### Seed Agents

Pre-build configs em `electron/main/seed-agents/`. Criados no boot via `ensure*Agents()` (`reconcileSeedAgent` em `seed-agents/ensure.ts` - INSERT-ONLY, ver R6 na secao 7). User customiza apos criacao. Se deletado, recriado no proximo boot.

Cada seed agent: `id`, `name`, `description`, `model`, `effort`, `thinking`, `thinkingBudget`, `maxTurns`, `maxToolRounds`, `allowedTools`, `mcpServers`, `isActive`, `skills`, `runtime`, `squad`.

Squads: `harness`, `pipeline`, `security`, `feature`, `enrich`.

## 4. Runtime Abstraction

Toda chamada de agente passa por `executeAgent(req: AgentExecutionRequest): Promise<AgentExecutionResult>` (`electron/main/agent-runtime/execute.ts`). O despacho usa `req.runtime` (`'cloud' | 'codex' | 'local' | 'external'`) e delega para o executor correspondente:

| Runtime    | Executor                | Backend                     |
|-----------|-------------------------|-----------------------------|
| cloud     | cloud-executor.ts       | @anthropic-ai/claude-agent-sdk |
| codex     | codex-executor.ts       | Codex CLI via codex-bridge.ts |
| local     | local-executor.ts       | Ollama local + local-tool-executor |
| external  | external-executor.ts    | HTTP custom via external-http.ts |

`watchdog.ts` aplica timeout e cancelamento por execucao. `tool-schemas.ts` define schemas das tools por runtime (alguns runtimes precisam de schema explicito; cloud usa o do SDK).

Vantagens da abstracao:
- Callers (pipeline / harness / enrich / security) nao conhecem detalhes do runtime
- Custo: sempre via `calculateCost` dentro do executor (D6 - orchestrator/repo-profiler/mcp-discovery sao excecoes documentadas)
- Permissoes: profile passado em `req.permissionProfile`; cada runtime decide o que honra (ver secao 5)

## 5. Permission Profiles

3 perfis pre-definidos em `electron/main/agent-runtime/permission-profiles.ts`:

| Perfil                    | Significado                                                  |
|--------------------------|--------------------------------------------------------------|
| `PERM_BYPASS_NO_GUARD`    | bypass total das permissoes, nenhum guard. Usado em pipelines/harness/security/codex-mcp. |
| `PERM_DEFAULT_WITH_GUARD` | default Anthropic + canUseTool guard. Usado em enrich.       |
| `PERM_DEFAULT_NO_BYPASS`  | default Anthropic, sem bypass, sem guard customizado. Reserva. |

### Honor / ignore por runtime

| Runtime  | BYPASS_NO_GUARD | DEFAULT_WITH_GUARD | DEFAULT_NO_BYPASS |
|----------|-----------------|--------------------|--------------------|
| cloud    | honra           | honra              | honra              |
| codex    | honra           | parcial (guard nao chamado por escolha do CLI) | honra |
| local    | honra           | honra              | honra              |
| external | depende do contrato HTTP (documentado por executor) | depende | depende |

### Mapeamento por caller

| Caller                    | Profile                  |
|--------------------------|--------------------------|
| chat (orchestrator)       | excecao (legado, nao usa executeAgent) |
| pipeline-engine           | `PERM_BYPASS_NO_GUARD`   |
| harness-engine            | `PERM_BYPASS_NO_GUARD`   |
| security-audit-runner     | `PERM_BYPASS_NO_GUARD`   |
| codex-agents-mcp          | `PERM_BYPASS_NO_GUARD`   |
| enrich                    | `PERM_DEFAULT_WITH_GUARD`|

### 5.5 Pipeline Phases Reference

#### Dev / Feature (`PIPELINE_PHASES` / `FEATURE_PIPELINE_PHASES`, em `src/types/pipeline.ts`)

Feature pipeline (referencia mais completa):

| # | Nome                | Tipo         | Agente             |
|---|---------------------|--------------|---------------------|
| 1 | Feature Discovery   | conversation | feat-discovery      |
| 2 | PRD Generator       | auto         | feat-prd-generator  |
| 3 | PRD Validator       | conversation | feat-prd-validator  |
| 4 | PRD Completo        | auto         | feat-prd-completo   |
| 5 | Database (Tech)     | conversation | feat-tech-database  |
| 6 | Backend (Tech)      | conversation | feat-tech-backend   |
| 7 | Frontend (Tech)     | conversation | feat-tech-frontend  |
| 8 | Security (Tech)     | conversation | feat-tech-security  |
| 9 | Spec Generation     | auto         | spec-builder        |
|10 | Spec Enricher       | conversation | spec-enricher       |
|11 | Planner             | auto         | harness-planner     |
|12 | Sprint Validator    | conversation | sprint-validator    |
|13 | Coder               | loop         | harness-coder       |
|14 | Evaluator           | loop         | harness-evaluator   |

Dev pipeline (`PIPELINE_PHASES`) usa estrutura analoga com `discovery-agent`, `prd-generator`, `prd-validator`, `tech-*` (variantes dev) e os mesmos `spec-builder`, `harness-planner`, `harness-coder`, `harness-evaluator`.

#### Security (`SECURITY_PIPELINE_PHASES`)

| # | Nome                | Tipo         | Agente                          |
|---|---------------------|--------------|---------------------------------|
| 1 | Repo Profiler       | auto         | repo-profiler                   |
| 2 | Security Audit      | auto (multi) | security-audit-runner (7 agents)|
| 3 | Deduplicador        | auto         | security-deduplicator           |
| 4 | Skeptic Security    | conversation | security-skeptic-security       |
| 5 | Skeptic Quality     | conversation | security-skeptic-quality        |
| 6 | SPEC Generator      | auto         | spec-builder                    |
| 7 | SPEC Enricher       | conversation | spec-enricher                   |
| 8 | Planner             | auto         | harness-planner                 |
| 9 | Sprint Validator    | conversation | sprint-validator                |
|10 | Coder               | loop         | harness-coder                   |
|11 | Evaluator           | loop         | harness-evaluator               |

#### Architecture Review (`ARCHITECTURE_REVIEW_PIPELINE_PHASES`)

| # | Nome                    | Tipo         | Agente                                    |
|---|-------------------------|--------------|-------------------------------------------|
| 1 | Mapeamento Arquitetural | auto         | architecture-mapper                       |
| 2 | Triagem de Alvos        | conversation | architecture-target-triage                |
| 3 | Diagnostico Arquitetural| auto         | architecture-diagnostician                |
| 4 | Entrevista de Decisao   | conversation | architecture-decision-interviewer         |
| 5 | Spec Generation         | auto         | spec-builder (REUSO via user message)     |
| 6 | Spec Validation         | conversation | spec-validator (REUSO via user message)   |
| 7 | Spec Enricher           | conversation | spec-enricher (REUSO via user message)    |
| 8 | Planner                 | auto         | harness-planner                           |
| 9 | Sprint Validator        | conversation | sprint-validator                          |
|10 | Coder                   | loop         | harness-coder                             |
|11 | Evaluator               | loop         | harness-evaluator                         |

Pasta canonica de artefatos: `<projectPath>/.lionclaw/pipelines/architecture-review/<runId>/`
com `manifest.json` + Map/Candidates/Diagnosis/Decisions em MD+JSON, SPEC em MD, sprints em JSON.

`runId` formato: `YYYYMMDD_HHmmss-<hex6>`. Persistido em `harness_projects.config.architectureReview.{runId, selectedCandidateId}`.

Fase 2 approve usa payload `{ selectedCandidateId }` no canal `pipeline:approve`. Fase 4 gate
exige >=1 secao `## DN` no decisions.md (regex check). Fase 5 reusa SPEC_BUILDER_ID com briefing
arquitetural injetado no user message (mesmo pattern do security pipeline).

#### Harness standalone

Sequencia: planner -> coder -> evaluator (loops). Mesmos agentes acima.

#### Enrich

Sessoes conversacionais com `spec-validator-enrich` (fase 1) e `spec-enricher` (fase 2). Nao tem ordem rigida; cada sessao tem suas mensagens persistidas em `enrich_messages`.

### 5.6 Pipeline Contract

Sequencia tipica que TODA execucao de fase respeita:

```
1. acquireProjectLock(projectId, 'pipeline-engine')   // S4.1 - lock per-project
2. setProjectStatus(projectId, 'running')             // S3.2 - mudanca PURA de status
3. handler(project, ctx) -> executeAgent(...)         // S1.0.3 - via runtime abstraction
4. persistMessage(target, role, content)              // S2.2 - persistencia tipada
5. emitIPC('pipeline:phase-changed', payload)         // S2.3 - notifica UI
6. setProjectStatus(projectId, 'done')                // S3.2 - status final
7. releaseProjectLock(projectId)                      // S4.1 - libera projeto
```

Variacoes:
- Pausa conversacional: passo 6 vira `setProjectStatus(projectId, 'paused')` apos pergunta ao user; lock NAO eh liberado (still owned), espera `pipeline:resume`.
- Aborto: `setProjectStatus(projectId, 'aborted')` + release.
- Erro: `setProjectStatus(projectId, 'failed')` + release + payload de erro.
- Atomicidade composta (ex: status + outros campos): usar `updateHarnessProject(...)` em vez de `setProjectStatus(...)` para evitar perda de campos (ver D3).

## 6. Adding a New Pipeline

Para adicionar um pipeline novo:

1. **Definir as fases**: nova constante `MY_PIPELINE_PHASES: PhaseDefinition[]` em `src/types/pipeline.ts` (numero, nome, type `auto`/`conversation`/`loop`, agentId, abbreviation, stage, stageName, resetable).
2. **Criar seed agents** em `electron/main/seed-agents/` (um arquivo por agente, com squad correto). Adicionar ao registry em `seed-agents/index.ts`.
3. **Migration SQL**: `electron/main/db-migrations/vNN-*.ts` para popular DBs existentes (R10).
4. **Estender `PipelineType`** em `src/types/index.ts` (`'security' | 'feature' | 'dev' | 'mypipeline'`).
5. **Adicionar handler** em `pipeline-engine/index.ts`: branch no despacho por `pipelineType`, chamando as fases na ordem com `executeAgent` + `persistMessage` + emit IPC.
6. **UI**: opcional, novo card em `NewPipelineModal`, novo subset de stream/views em `src/components/pipeline/` se precisar.
7. **Testes**: snapshot de IPC, persistencia, lock, permission profile.

Reaproveite seed agents existentes quando aplicavel (`spec-builder`, `harness-planner/coder/evaluator`, `sprint-validator`).

## 7. Seed Agents Pattern

### Squad obrigatorio

Todo seed agent tem `squad: 'harness' | 'pipeline' | 'security' | 'feature' | 'enrich'`. Squad eh usado para visibilidade na UI e filtros internos. Mudar squad eh BREAKING (ver R10).

### R6 ADR — nao unificar agents similares

Mesmo que `prd-validator` (dev) e `feat-prd-validator` (feature) facam tarefa parecida, sao agentes SEPARADOS. NUNCA unificar via "compartilha base e parametriza" - isso quebra customizacao por usuario, dificulta migration e amarra evolucao independente. ADR documenta isso.

### Regra INSERT-ONLY do `reconcileSeedAgent`

`seed-agents/ensure.ts:reconcileSeedAgent(seed)` so faz INSERT (`INSERT OR IGNORE`). NAO faz UPDATE. Customizacoes do usuario sobrevivem reboot. Para mudar prompt/squad/qualquer campo de seed agent existente, precisa de migration SQL (ver R10).

### R10 — Regra DUPLA: edit do .ts + migration SQL

Para alterar QUALQUER campo de um seed agent:

1. **Edit do .ts** (`seed-agents/<agent>.ts`): garante que fresh installs (DB novo) recebem a versao nova.
2. **Migration SQL** (`db-migrations/vNN-*.ts`): atualiza DBs existentes (UPDATE direcionado, idealmente preservando customizacoes - ver V50 prepared statement).

Pular qualquer um dos dois deixa metade dos usuarios na versao errada.

Exemplos no historico: V49 (squad fixes), V50 (prompt updates de spec-builder/spec-validator/security-skeptic-security).

## 8. Persistence Patterns

### `persistMessage(target, role, content, metadata?)` — `pipeline-shared/persist.ts`

Discriminated union no `target`:
- `{ kind: 'pipeline', projectId, phase }`
- `{ kind: 'harness', projectId, sprintId?, roundId? }`
- `{ kind: 'enrich', sessionId, phase }`
- `{ kind: 'chat', sessionId }`

Roteia para a tabela correta (`pipeline_messages`, `harness_round_messages`, `enrich_messages`, `messages`). Sempre usar este helper - **nao** chamar SQL direto.

### `persistHarnessRound.{insert, update}` — `pipeline-shared/persist.ts`

- `insert(round)`: cria round novo na sprint
- `update(roundId, patch)`: atualiza metricas/status do round

Usar SO para harness rounds. Para mensagens dentro do round, use `persistMessage({ kind: 'harness', ... })`.

### Quando usar cada um

- Mensagem de agent ou user em qualquer lugar: `persistMessage`
- Lifecycle de harness round (criar, marcar done, atualizar metricas): `persistHarnessRound`

## 9. IPC Conventions

- Namespace com colon: `chat:send`, `pipeline:start-phase`, `enrich:approve-phase`, `agents:list`.
- Calls novas em kebab-case dentro do namespace.
- Errors em fluxo normal: retornar `{ error: string }` em vez de throw.
- **Rename de canal**: alias compativel obrigatorio (R2). Manter o antigo como passthrough do novo durante upgrade. Remocao so em release major com nota.
- Listeners no renderer SEMPRE retornam cleanup function para `useEffect` unmount.

`window.lionclaw` (preload) namespaces: `chat`, `agents`, `skills`, `mcp`, `scheduler`, `pipeline`, `harness`, `enrich`, `dialog`, `shell`, `knowledge`, `settings`, `auth`, `logs`, `vault`, `rules`, `memory`, `usage`, `codex`.

## 10. Streaming

Agent SDK (e os outros runtimes) emitem eventos. Main process transforma e envia para renderer via IPC.

Helpers POR CANAL em `pipeline-shared/stream/`:
- `pipeline-stream.ts` -> `pipeline:stream`
- `harness-stream.ts`  -> `harness:agent-stream`
- `security-stream.ts` -> `security:stream`
- `enrich-stream.ts`   -> `enrich:stream`

Cada helper tem schema proprio (D2: nao genericizar). Format basico: `{ type: 'text' | 'tool_call' | 'done', ... }`.

**Golden snapshots** em `electron/main/__tests__/__snapshots__/ipc-channels-snapshot.test.ts.snap` (R2) garantem que renames/changes nao quebrem o renderer silenciosamente. Atualizar snapshot exige justificativa em PR.

## 11. Status Conventions

### `HarnessProjectStatus` (DB-side, `pipeline-shared/status.ts`)

10 valores que vao para o DB:
```
'idle' | 'planning' | 'reviewing' | 'ready' | 'running' |
'paused' | 'done' | 'failed' | 'aborted' | 'interrupted'
```

`aborted` e `interrupted` foram adicionados na V48 (CHECK constraint expansion).

### `UIStatus` (TypeScript, derivado em runtime)

Superset com 3 valores que NAO ficam no DB (calculados via `deriveUIStatus`):
```
HarnessProjectStatus | 'streaming' | 'awaiting-user' | 'pipeline-completed'
```

`deriveUIStatus(domain, { isStreaming, awaitingUser, pipelineComplete })` aplica precedencia: pipelineComplete > streaming > awaitingUser > domain.

### `setProjectStatus` vs `updateHarnessProject`

- `setProjectStatus(projectId, status)` — mudanca PURA de status (so a coluna `status`). Tipado com `HarnessProjectStatus` para impedir uso de UI-only values.
- `updateHarnessProject(projectId, patch)` — mudanca COMPOSTA (status + outros campos). Atomico no DB. Use quando precisa mudar status JUNTO com (ex) `currentPhase`, `currentSprintId`, etc.

D3: substituir `updateHarnessProject(...)` cego por `setProjectStatus` perde campos compostos. Sempre revisar o patch original antes de migrar.

## 12. Locking

Lock per-project em RAM em `pipeline-shared/lock.ts`. NAO persistido (intencional - restart manual = unlock implicito).

Funcoes:
- `acquireProjectLock(projectId, owner)` — estrito. Throw se ja lockado por outro.
- `ensureProjectLock(projectId, owner)` — idempotente. Se ja for o owner, no-op; senao throw.
- `releaseProjectLock(projectId)` — libera.
- `isProjectLocked(projectId)` — query.

Regra de concorrencia (R7):
- Cross-project: livre (nada compartilhado)
- Same-project, mesma pipeline (ex: pipeline-engine processando 2 fases simultaneamente): BLOQUEADO
- Same-project, callers diferentes (ex: pipeline + harness simultaneo no mesmo projectId): BLOQUEADO

Owner string convencional: `'pipeline-engine'`, `'harness-engine'`, `'enrich'`, `'security-audit'`.

## 13. Conventions

- TypeScript strict mode, sem `any`
- Prettier defaults
- Imports: alias `@/` no renderer, relativos no main
- Error handling: NUNCA engolir, sempre logar via pino (`createLogger('module-name')`)
- IPC channels: namespaced com colon
- IPC errors: `{ error: string }`, nao throw
- Database: tudo em `db.ts` (e `db-migrations/`), exportado como funcoes. Nunca SQL fora.
- Respostas do agente: PT-BR (RULES.md)
- File naming: kebab-case para arquivos, PascalCase para componentes React
- Sem default exports exceto pages React
- Acoes destrutivas: confirmacao via popup
- Tool calls: audit trail
- Secrets: nunca em codigo, nunca em env commitado, sempre em OS keychain via node-keytar
- IPC listeners no renderer: sempre retornam cleanup function
- Pipeline / harness / enrich / security: SEMPRE via `executeAgent` (D6) e SEMPRE com `persistMessage` / `persistHarnessRound`

## 14. Do NOT

- NAO usar `electron.remote` (deprecado e inseguro)
- NAO expor APIs Node.js direto ao renderer (so contextBridge)
- NAO armazenar API keys em plaintext
- NAO usar `bypassPermissions` HARDCODED no Agent SDK; use `PERM_BYPASS_NO_GUARD` via runtime profile
- NAO hardcodear nome de modelo - sempre ler de agent config / settings
- NAO usar `localStorage` no renderer para dados sensiveis
- NAO rodar SQLite no renderer
- NAO criar web server / Express - tudo no Electron main
- NAO usar Next.js, SSR, ou framework server - app desktop
- NAO usar em-dashes em texto gerado ou copy de UI
- NAO mencionar outros agentes no system prompt de seed agents (regra de isolamento)
- NAO chamar `calculateCost` fora de `agent-runtime/` em pipelines/harness/enrich (excecoes documentadas D6: orchestrator, repo-profiler, mcp-discovery)
- NAO chamar `query()` direto em pipelines/harness/enrich (mesmas 3 excecoes)
- NAO hardcodear `permissionMode` em callers de `executeAgent` (use `permissionProfile` via request)
- NAO modificar seed agent (squad / prompt / model / etc) sem migration SQL (R10) - DBs existentes ficam errados
- NAO modificar seed agent sem editar tambem o arquivo `.ts` correspondente (R10) - fresh installs ficam errados
- NAO mudar canal IPC sem alias compativel durante a transicao (R2)
- NAO substituir `updateHarnessProject(projectId, { status, ... })` cego por `setProjectStatus` - perde campos compostos (D3)
- NAO unificar seed agents similares (`prd-validator` vs `feat-prd-validator`) sob "compartilha base parametriza" (R6 ADR)
- NAO persistir streams individuais dos 7 agentes da fase 2 do security pipeline - revisita mostra so o consolidado
- NAO escrever fora de `<runDir>/` durante fases pre-SPEC (1-4) do architecture-review (mapper/triage/diagnostician/interviewer escrevem APENAS em `.lionclaw/pipelines/architecture-review/<runId>/`)
- NAO criar agentes novos para SPEC builder/validator/enricher do architecture-review - reusa os existentes via briefing no user message do handler (R6 ADR)
