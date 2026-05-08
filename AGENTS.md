# LionClaw

Assistente pessoal de IA rodando como app desktop Electron. Single-user, single-machine. O agente tem acesso completo ao terminal, filesystem e internet via Codex Agent SDK.

## Quick Context

App Electron (main + renderer). Main process: orquestrador Node.js com Agent SDK, SQLite, scheduler, MCP manager, Telegram bot, knowledge engine. Renderer process: React + Vite (dashboard, chat, harness, enrich, knowledge, settings). Comunicacao via Electron IPC. Sem servidor web, sem portas expostas.

## Stack

| Componente | Tecnologia |
|-----------|-----------|
| Desktop runtime | Electron 33+ |
| Frontend | React 19 + Vite + TailwindCSS |
| State management | Zustand |
| Backend (main process) | Node.js + TypeScript |
| AI engine | @anthropic-ai/Codex-agent-sdk |
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

## Architecture

```
electron/main/                → Electron main process (Node.js)
  index.ts                    → Entry point, window creation, boot sequence
  orchestrator.ts             → Message queue, subagent delegation, SDK sessions
  agent-engine.ts             → Agent SDK wrapper, query(), streaming
  db.ts                       → SQLite schema, 27 migrations, all CRUD (~120KB)
  ipc-handlers.ts             → All IPC handlers registered here (~60KB)
  permission-guard.ts         → canUseTool callback, destructive action detection
  prompt-builder.ts           → System prompt construction (rules + memory + agent rules)
  harness-engine.ts           → Harness execution: planner -> coder -> evaluator loop
  harness-planner.ts          → Sprint planning via AI
  harness-evaluator.ts        → Code evaluation against acceptance criteria
  harness-prompts.ts          → Prompt builders (coder, evaluator, validator, enricher)
  workflow-engine.ts           → Multi-stage workflow orchestration (BuildPlan)
  knowledge-engine.ts          → Knowledge base: ingest, chunk, embed, search
  knowledge-ipc-bridge.ts     → Knowledge system IPC communication
  memory-pipeline.ts          → Compaction, summarization, embedding generation
  scheduler.ts                → Cron-based task runner
  mcp-manager.ts              → MCP server lifecycle (spawn, stop, restart)
  telegram-bridge.ts          → Telegram bot integration
  secrets-vault.ts            → Encrypt/decrypt secrets via node-keytar
  auth.ts                     → Password hash, TOTP verify, session tokens
  pricing.ts                  → Token cost calculation (calculateCost per model)
  logger.ts                   → Pino logger factory (createLogger)
  paths.ts                    → File path utilities (getLionClawHome, etc)
  image-engine.ts             → Image processing
  voice-engine.ts             → Voice/speech integration (ElevenLabs)
  artifact-detector.ts        → Artifact content detection from tool results

  seed-agents/                → Pre-built agent configs (ship with app)
    index.ts                  → Registry, exports: HARNESS/WORKFLOW/ENRICH arrays
    harness-planner.ts        → Sprint planner agent (opus, max effort)
    harness-coder.ts          → Code implementer (sonnet, high effort)
    harness-evaluator.ts      → Code evaluator
    spec-builder.ts           → SPEC generator (BuildPlan workflow)
    spec-validator.ts         → SPEC validator (BuildPlan workflow)
    spec-validator-enrich.ts  → SPEC validator (Enrich pipeline, squad='enrich')
    spec-enricher.ts          → SPEC enricher (Enrich pipeline, squad='enrich')

electron/preload/
  index.ts                    → contextBridge: window.lionclaw.{chat,agents,harness,enrich,dialog,...}

src/                          → React app (renderer process)
  App.tsx                     → Page switch (currentPage), auth gate, IPC subscriptions
  pages/                      → 20 pages
    ChatPage.tsx              → Main chat interface
    SubAgentsPage.tsx         → Agent CRUD
    SkillsPage.tsx            → Skill management
    MCPServersPage.tsx        → MCP server config
    SchedulerPage.tsx         → Cron tasks
    LogsPage.tsx              → System logs
    SettingsPage.tsx          → App settings
    AuthPage.tsx              → Login/TOTP
    RulesPage.tsx             → Global rules editor
    MemoryPage.tsx            → Memory management
    VaultPage.tsx             → Secrets vault
    KnowledgePage.tsx         → Knowledge base (ingest, search, manage)
    BuildPlanPage.tsx         → Workflow: discovery -> spec -> validation -> approval
    HarnessPage.tsx           → Harness dashboard (projects, sprints, rounds)
    EnrichDocPage.tsx         → Enrich pipeline (validator chat, enricher chat)
    TasksPage.tsx             → Task management (kanban/calendar)
    UsagePage.tsx             → Token usage analytics
    ChannelsPage.tsx          → Telegram integration
    PermissionsPage.tsx       → Permission management
  components/
    chat/                     → ChatMessage, ConfirmDialog, AskQuestionDialog, AudioPlayer,
                                VoiceRecorder, TokenCounter, AgentThinking, ArtifactRenderer,
                                SlashCommandPicker, ExcalidrawViewer, McpAppViewer
    agents/                   → AgentFormModal, DeleteAgentDialog
    enrich/                   → EnrichModal, EnrichControls, EnrichMetricsBar,
                                EnrichPhaseIndicator, EnrichSessionCard, SpecViewer
    harness/                  → ProjectList, ProjectCard, ProjectDetail, NewProjectModal,
                                ExecutionView, MetricsView, MetricsChart, SprintList,
                                SprintCard, AgentStreamPanel, RegenerateModal
    buildplan/                → DiscoveryPanel, SpecGenerationView, ApprovalButtons
    scheduler/                → TaskList, TaskFormModal, CalendarView, KanbanView,
                                ActivityBoard, ActivityCard, ActivityFilters
    skills/                   → SkillFormModal, SkillEditor, SkillWizard
    settings/                 → VoiceSelector, GoogleOAuthSetup
    channels/                 → TelegramSetup
    common/                   → Sidebar, MarkdownEditor, OpenFolderButton
  stores/                     → Zustand stores
    app-store.ts              → Page routing, global state
    auth-store.ts             → Auth state
    chat-store.ts             → Chat sessions, messages
    harness-store.ts          → Harness projects, sprints
    enrich-store.ts           → Enrich sessions, messages, metrics
    knowledge-store.ts        → Knowledge base state
    workflow-store.ts         → Workflow state
  types/
    index.ts                  → All shared TypeScript types (~34KB)

.lionclaw/                    → Agent persistent data (gitignored)
  MEMORY.md                   → Working memory (loaded in every prompt)
  RULES.md                    → Global rules (loaded as system prompt)
  SOUL.md                     → Agent personality definition
  USER.md                     → User preferences
  BOOTSTRAP.md                → Initialization guide
  agents/{name}/              → Per-agent: RULES.md, config.json
  skills/{name}/SKILL.md      → Skill definitions with frontmatter
  workflows/build-plan/       → BuildPlan workflow stages
  conversations/              → Archived transcripts
  data/
    lionclaw.db               → SQLite database
    sessions/                 → Agent SDK session files

mcp-servers/                  → 15+ MCP servers (each standalone Node.js package)
  google-calendar/            → Google Calendar API
  google-gmail/               → Gmail API
  google-drive/               → Google Drive API
  google-sheets/              → Google Sheets API
  google-shared/              → Shared Google auth utils
  elevenlabs/                 → Text-to-speech
  excalidraw/                 → Excalidraw drawing
  knowledge-base/             → Semantic search over knowledge
  memory-search/              → Semantic memory search
  local-agents/               → Local agent runner
  local-llm/                  → Ollama integration
  skills/                     → Skills MCP server
  youtube/                    → YouTube API
  shopify/                    → Shopify API
  nano-banana/                → Cohere LLM
```

## Boot Sequence (electron/main/index.ts)

1. Exception handlers registered
2. BrowserWindow created
3. `initDatabase()` - SQLite init, run migrations (V1-V27)
4. Seed data: tool defaults, ensureHarnessAgents, ensureWorkflowAgents, ensureEnrichAgents
5. `registerIPCHandlers()` - all IPC channels
6. `startScheduler()` - cron task runner
7. `startTelegramBot()` - Telegram bridge
8. `startActiveMCPServers()` - MCP server lifecycle
9. `discoverSDKMcpServers()` - SDK MCP discovery
10. `bootstrapWorkflowFiles()` - workflow stage files
11. `startKnowledgeBridge()` - knowledge engine
12. HarnessEngine instantiated

## Core Systems

### Orchestrator (orchestrator.ts)

Message queue pattern: `submitMessage()` enqueues, `processQueue()` dequeues and calls `executeQuery()`. Tracks SDK session alive state. Builds subagent definitions from active agents in DB. Integrates with permission guard, MCP config, and artifact detection.

### Harness System

Automated code implementation and evaluation pipeline:
- **Planner** (opus): decomposes SPEC into sprints with features and acceptance criteria
- **Coder** (sonnet): implements features, writes code
- **Evaluator**: validates code against criteria, provides feedback
- Loop: coder -> evaluator -> feedback -> coder (max rounds configurable)

Tables: `harness_projects`, `harness_sprints`, `harness_rounds`
Seed agents: harness-planner, harness-coder, harness-evaluator
Metrics: input/output/cache tokens, cost (via calculateCost), duration, tool uses, api requests per round

### Enrich Pipeline

Two-phase SPEC enrichment before code implementation:
- **Phase 1 - Validator** (spec-validator-enrich): audits SPEC against code/PRD, reports errors/gaps
- **Phase 2 - Enricher** (spec-enricher): adds edge cases, UI states, alternative paths, permissions
- Conversational: user discusses with each agent, approves changes incrementally
- Agents edit SPEC file directly (Write/Edit auto-approved on specPath via permission guard)
- Isolation: each agent has no knowledge of the other
- Transition: user clicks [Aprovar e Avancar], engine kills validator, spawns enricher with fresh context

Tables: `enrich_sessions` (metrics per phase), `enrich_messages` (chat persistence)
IPC: enrich:start, enrich:send, enrich:approve-phase, enrich:finalize, enrich:abort, enrich:open-spec, enrich:get-messages, enrich:list-sessions
Streaming: enrich:stream (same StreamChunk format as chat), enrich:metrics, enrich:status

### Workflow System (BuildPlan)

Multi-stage workflow: discovery -> spec-build -> spec-validate -> approval
Managed by workflow-engine.ts with stages defined in `.lionclaw/workflows/build-plan/`
Tables: `workflow_runs`

### Knowledge Engine

Document ingestion (PDF, DOCX, CSV, MD), chunking, embedding via Anthropic API, semantic search via sqlite-vec. Managed by knowledge-engine.ts with IPC bridge.

### Seed Agents

Pre-built agent configs in `electron/main/seed-agents/`. Created on first boot via `ensure*Agents()`. User can customize after creation. If deleted, recreated on next boot.

Each seed agent has: id, name, description, model, effort, thinking, thinkingBudget, maxTurns, maxToolRounds, allowedTools, mcpServers, isActive, skills, runtime, squad.

Squads: `harness` (planner, coder, evaluator), `workflow` (spec-builder, spec-validator), `enrich` (spec-validator-enrich, spec-enricher)

### Metrics Collection Pattern (reused across Harness + Enrich)

```typescript
// From Agent SDK stream events:
// message_start -> apiRequests++, input tokens (input_tokens + cache_read + cache_creation)
// message_delta -> output tokens
// content_block_start with tool_use -> toolUses++
// Cost: calculateCost(model, inputTokens, outputTokens, cacheRead, cacheCreation) from pricing.ts
```

## Key Patterns

### Electron IPC

All communication uses typed IPC channels via contextBridge. NEVER use `remote` module. NEVER expose Node.js APIs directly to renderer.

Preload exposes `window.lionclaw` with namespaces: chat, agents, skills, mcp, scheduler, harness, enrich, dialog, shell, knowledge, workflow, settings, auth, logs, vault, rules, memory, usage.

Each listener returns a cleanup function for unmount.

### Permission Guard (permission-guard.ts)

`createPermissionGuard(agentId)` returns `canUseTool` callback:
- Safe tools (Read, Glob, Grep, Web*): auto-approve
- Write/Edit to allowed paths: auto-approve
- During active enrich session: Write/Edit on specPath auto-approved via `setActiveEnrichSpecPath()`
- Destructive (rm, sudo, send email, git push): IPC confirm dialog to user
- Unknown: deny by default
- Shell handlers (shell:show-in-folder, shell:open-path) restrict to .lionclaw/ directory
- Enrich uses dedicated `enrich:open-spec` IPC to bypass this restriction for spec files

### SQLite (db.ts ~120KB)

Single database at `.lionclaw/data/lionclaw.db`. WAL mode. Foreign keys ON. 27 migrations (V1-V27).

ALWAYS use prepared statements. NEVER concatenate SQL. All DB operations exported from db.ts.

Key tables: messages, sessions, agents, skills, mcp_servers, scheduled_tasks, tool_audit_log, knowledge_documents, knowledge_chunks, harness_projects, harness_sprints, harness_rounds, workflow_runs, enrich_sessions, enrich_messages, schema_version.

### Streaming

Agent SDK streams events. Main process transforms and sends to renderer via IPC channels (chat:stream, harness:agent-stream, enrich:stream). All use the same StreamChunk format: `{ type: 'text' | 'tool_call' | 'done', ... }`.

### Page Routing

`src/App.tsx` uses `useAppStore().currentPage` with a switch statement. Page type defined in `app-store.ts`. Navigation via `setPage('pageName')`.

## Development

```bash
npm install              # Install all dependencies
npm run dev              # Start Electron app in dev mode (hot reload)
npm run build            # Build for production
npm run dist             # Package as DMG (Mac) / NSIS (Windows)
npm run typecheck        # TypeScript check without emitting (npx tsc --noEmit)
npm run lint             # ESLint
npm run test             # Vitest
```

Dev mode: React dev server (Vite HMR) + main process auto-restart + DevTools open.
Requires: `ANTHROPIC_API_KEY` in `.env` at project root. `.lionclaw/` created on first run.

## Conventions

- Language: TypeScript strict mode, no `any`
- Formatting: Prettier with defaults
- Imports: absolute paths via `@/` alias for renderer, relative for main process
- Error handling: never swallow errors silently, always log via pino (`createLogger('module-name')`)
- IPC channels: namespaced with colon (`chat:send`, `agents:list`, `enrich:start`)
- IPC errors: return `{ error: string }` objects, not throw
- Database: all operations in `db.ts`, exported as functions, never raw SQL outside this file
- Agent responses: always in Brazilian Portuguese (enforced via RULES.md)
- File naming: kebab-case for files, PascalCase for React components
- No default exports except React page components
- All destructive actions require confirmation popup
- All tool calls logged to audit trail
- Secrets NEVER in code, NEVER in env files committed, ALWAYS in OS keychain via node-keytar
- IPC event listeners always return cleanup function for React useEffect unmount

## Do NOT

- Do NOT use `electron.remote` (deprecated and insecure)
- Do NOT expose Node.js APIs to renderer (use contextBridge only)
- Do NOT store API keys in plaintext files
- Do NOT use `bypassPermissions` in the Agent SDK
- Do NOT hardcode model names - always read from agent config/settings
- Do NOT use `localStorage` in renderer for sensitive data
- Do NOT run SQLite operations in the renderer process
- Do NOT create separate web server / Express app - all backend logic runs in Electron main
- Do NOT use Next.js, SSR, or any server framework - this is a desktop app
- Do NOT use em-dashes (--) in any generated text or UI copy
- Do NOT mention other agents in seed agent system prompts (isolation rule)
