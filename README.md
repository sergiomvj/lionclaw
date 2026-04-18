<div align="center">
  <img src="LionLogoGit.png" alt="alt text" />
</div>

# LionClaw

Assistente pessoal de IA rodando como app desktop Electron. Single-user, single-machine. O agente tem acesso completo ao terminal, filesystem e internet via Claude Agent SDK.

---

## Indice

1. [Visao Geral](#visao-geral)
2. [Funcionalidades](#funcionalidades)
3. [Arquitetura](#arquitetura)
4. [Pre-requisitos](#pre-requisitos)
5. [Instalacao](#instalacao)
6. [Comandos](#comandos)
7. [Stack](#stack)
8. [Boot Sequence](#boot-sequence)
9. [Sistemas Principais](#sistemas-principais)
10. [MCP Servers](#mcp-servers)
11. [Estrutura do Projeto](#estrutura-do-projeto)
12. [Troubleshooting](#troubleshooting)
13. [Licenca](#licenca)

---

## Visao Geral

LionClaw e um assistente pessoal de IA que roda localmente no seu computador como aplicativo desktop. Diferente de chatbots web, ele tem acesso real ao seu terminal, arquivos e internet. Ele executa, nao apenas explica.

O agente principal (orquestrador) pode delegar tarefas para sub-agentes especializados, cada um com seu proprio modelo, ferramentas e permissoes. Toda comunicacao entre frontend e backend acontece via Electron IPC. Nao ha servidor web, nao ha portas expostas.

Dados ficam exclusivamente na sua maquina: banco SQLite local, segredos no keychain do SO, embeddings vetoriais em sqlite-vec. Nada sai sem sua permissao.

---

## Funcionalidades

### Chat com IA

Interface principal de conversa com o agente. Suporta streaming de respostas em tempo real, visualizacao de tool calls (quais ferramentas o agente usou), rendering de Markdown com syntax highlighting, renderizacao de artefatos (Excalidraw, HTML, codigo), gravacao e reproducao de audio via ElevenLabs, anexos de arquivos e imagens, slash commands para acoes rapidas e contador de tokens por mensagem.

O agente responde em portugues brasileiro por padrao (configuravel). Sessoes sao persistidas no SQLite com todo o historico de mensagens, tool calls e metricas de tokens.

### Sub-Agentes

Sistema de delegacao onde o orquestrador principal pode rotear tarefas para agentes especializados. Cada sub-agente tem configuracao independente: modelo (opus, sonnet, haiku ou modelo local via Ollama), system prompt customizado, ferramentas permitidas (Read, Write, Bash, Glob, etc.), MCP servers vinculados, skills vinculadas, nivel de esforco e thinking habilitado/desabilitado.

Agentes com `runtime: local` usam Ollama e sao acessados via o MCP `local-agents`. Agentes com `runtime: cloud` sao registrados como sub-agentes nativos do Claude Agent SDK.

Na primeira execucao, 8 seed agents sao criados automaticamente (detalhes na secao Boot Sequence). Apos a criacao, o usuario pode customizar livremente e as mudancas sobrevivem ao reboot.

### Harness (Implementacao Automatizada)

Pipeline automatizado de implementacao de codigo. O fluxo funciona em tres etapas:

O **Planner** (modelo opus) recebe uma SPEC e decompoe em sprints com features e criterios de aceitacao. O **Coder** (modelo sonnet) implementa cada feature, escrevendo codigo real no projeto. O **Evaluator** valida o codigo contra os criterios de aceitacao e gera feedback.

O ciclo coder -> evaluator -> feedback -> coder repete ate todos os criterios passarem ou o limite de rounds ser atingido. Cada round coleta metricas: tokens de input/output/cache, custo (USD), duracao, tool uses e API requests.

Interface dedicada com dashboard de projetos, visualizacao de sprints, painel de streaming do agente em tempo real e graficos de metricas.

### BuildPlan (Workflow de Especificacao)

Pipeline completo que transforma uma ideia em especificacao tecnica pronta para implementacao. O fluxo passa por 6 etapas:

**Discovery**: agente conduz entrevista estruturada (11 perguntas em 5 blocos) para entender o escopo do projeto, gerando um `discovery-notes.md`.

**PRD Generator**: gera user stories, requisitos funcionais e nao-funcionais a partir das notas de discovery. Produz documento PRD completo com resumo executivo, personas, requisitos e metricas de sucesso.

**PRD Validator**: valida e refina user stories e requisitos com o usuario em conversa interativa. Garante que nada foi esquecido ou mal definido antes de prosseguir.

**Spec Build**: agente spec-builder (opus) gera uma SPEC.md completa a partir do PRD, cobrindo database (tabelas, campos, constraints, indexes, RLS), backend (endpoints com metodo, path, request/response, auth, status codes) e frontend (componentes, estados, fluxos).

**Spec Validate**: agente spec-validator audita a SPEC contra o PRD e o codigo existente, reportando erros, inconsistencias e lacunas.

**Approval**: usuario revisa, discute e aprova a SPEC antes de enviar pro Harness.

Apos aprovacao, o Harness recebe a SPEC e o **Sprint Validator** verifica cobertura completa, dependencias corretas e sizing realista antes do Planner decompor em sprints executaveis.

### Enrich (Enriquecimento de SPEC)

Pipeline conversacional de duas fases para melhorar uma SPEC antes da implementacao:

**Fase 1 - Validator**: auditor tecnico que cruza a SPEC contra o codigo existente e o PRD. Apresenta relatorio estruturado com categorias (erros, inconsistencias, scope creep, lacunas vs PRD, definicoes vagas). Cada item e discutido com o usuario e editado na SPEC apos aprovacao. Usa arquivo de relatorio persistente como memoria entre turnos.

**Fase 2 - Enricher**: adiciona edge cases, estados de UI, fluxos alternativos, tratamento de erros e permissoes que a SPEC original nao cobriu. Opera em isolamento total (nao sabe que o Validator existe).

A transicao entre fases e explicita: o usuario clica "Aprovar e Avancar" para matar o Validator e iniciar o Enricher com contexto limpo.

### Knowledge Base

Sistema de ingestion e busca semantica sobre documentos. Suporta PDF, DOCX, CSV e Markdown. O fluxo funciona assim: o documento e parseado e dividido em chunks, cada chunk recebe um embedding via Anthropic Embeddings API, os embeddings sao armazenados em sqlite-vec para busca vetorial.

Na busca, a query do usuario e convertida em embedding e comparada vetorialmente com os chunks indexados. Resultados relevantes sao injetados no contexto do agente.

Cada agente pode ter sua propria base de conhecimento. O MCP `knowledge-base` e auto-injetado em agentes que tem documentos indexados.

### Skills

Skills sao instrucoes estruturadas em Markdown (com frontmatter YAML) que ensinam o agente a executar tarefas especificas. Diferente de tools (que sao acoes atomicas), skills sao guias completos com contexto, exemplos e regras.

O sistema funciona via o MCP `skills` que expoe tres ferramentas: `list_skills` (lista skills disponiveis com filtro por categoria), `load_skill` (carrega o conteudo completo de uma skill) e `get_skill_metadata` (retorna metadados sem o conteudo).

Quando um agente tem skills vinculadas, o MCP de skills e auto-injetado e instrucoes de uso sao adicionadas ao prompt. O agente carrega a skill sob demanda quando a tarefa exige.

Na primeira execucao, 15 skills default sao copiadas automaticamente (design, ferramentas, documentos). Novas skills podem ser criadas pela interface ou pelo proprio agente.

### Memory Pipeline

Sistema de memoria em camadas. A **memoria de trabalho** (MEMORY.md) e carregada em todo prompt e contem contexto volatil da sessao atual. A **memoria semantica** usa embeddings para busca vetorial sobre mensagens antigas, acessada via MCP `memory-search`. A **compactacao** resume conversas longas usando LLM (cloud ou Ollama local) para manter o contexto gerenciavel.

Na inicializacao, SOUL.md + RULES.md + USER.md + MEMORY.md sao concatenados em um CLAUDE.md que o SDK le automaticamente. Esse arquivo e regenerado a cada boot e quando qualquer fonte muda (watcher com polling de 2 segundos).

### Scheduler

Agendador de tarefas baseado em cron. Suporta expressoes cron padrao via `cron-parser`, execucao sob demanda, interface com calendario e kanban, e log de execucoes. Tarefas agendadas podem acionar o agente para executar qualquer acao (enviar relatorio, checar status, etc).

### Secrets Vault

Gerenciamento seguro de credenciais. Chaves de API, tokens e senhas sao armazenadas no keychain nativo do SO via `node-keytar` (Keychain no macOS, Credential Manager no Windows, libsecret no Linux). Se o keytar falhar, existe fallback para arquivo criptografado local em `~/.lionclaw/data/.secrets`.

Nunca em arquivos de texto, nunca em variaveis de ambiente commitadas, nunca no banco SQLite.

### Telegram Bridge

Integracao bidirecional com Telegram. Permite conversar com o LionClaw de qualquer lugar via bot do Telegram. Mensagens recebidas sao roteadas para o orquestrador, respostas sao enviadas de volta ao chat. Configuracao via token do BotFather, com autenticacao por TOTP.

### Permission Guard

Todas as acoes do agente passam por um sistema de permissoes. Ferramentas seguras (Read, Glob, Grep, WebSearch, WebFetch) sao auto-aprovadas. Write/Edit em paths permitidos sao auto-aprovados. Acoes destrutivas (rm, sudo, git push, envio de email) exigem confirmacao do usuario via popup. Acoes desconhecidas sao negadas por padrao. Toda tool call e registrada no audit trail.

### Usage Analytics

Dashboard com metricas de consumo: tokens de input, output e cache por sessao, custo em USD por modelo (calculado via pricing.ts), historico de uso ao longo do tempo e breakdown por agente.

### Auth

Sistema de autenticacao local com hash de senha via bcrypt e suporte a TOTP (autenticacao de dois fatores) via otplib. A sessao e trancada automaticamente quando o sistema entra em suspensao ou o usuario trava a tela.

---

## Arquitetura

```
                        +-----------------+
                        |    Renderer     |
                        |  React + Vite   |
                        |  (BrowserWindow)|
                        +--------+--------+
                                 |
                            Electron IPC
                          (contextBridge)
                                 |
                        +--------+--------+
                        |  Main Process   |
                        |    Node.js      |
                        +--------+--------+
                                 |
            +--------------------+--------------------+
            |          |         |         |          |
     +------+---+ +---+----+ +-+------+ +-+------+ +-+--------+
     |Orchestrator| |  DB   | |Harness | |Enrich  | |Scheduler |
     |Agent SDK   | |SQLite | |Engine  | |Engine  | |Cron      |
     +------+---+ +--------+ +--------+ +--------+ +----------+
            |
    +-------+-------+
    |       |       |
  +--+--+ +-+--+ +-+--+
  |Sub  | |Sub | |Sub |
  |Agent| |Agt | |Agt |
  +-----+ +----+ +----+
            |
     +------+------+
     |  MCP Servers |
     |  (stdio)     |
     +--------------+
```

O **Renderer** (React) so se comunica com o **Main Process** (Node.js) via IPC tipado. Toda logica de negocio, acesso ao banco, chamadas de API e execucao de ferramentas acontecem no main process. O renderer nunca tem acesso direto ao Node.js.

O **Orchestrator** gerencia uma fila de mensagens (pattern message queue) e delega para sub-agentes via Agent SDK. Cada sub-agente pode ter seus proprios MCP servers, tools e system prompt.

---

## Pre-requisitos

| Ferramenta | Versao Minima | Como verificar | Como instalar |
|------------|--------------|----------------|---------------|
| **Node.js** | v18+ (recomendado v22) | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | v9+ | `npm --version` | Ja vem com o Node.js |
| **Python** | 3.10+ | `python --version` | [python.org](https://www.python.org/) |
| **Git** | qualquer | `git --version` | [git-scm.com](https://git-scm.com/) |

### Build Tools para modulos nativos

O projeto usa modulos nativos (better-sqlite3, keytar, bcrypt, sqlite-vec) que precisam ser compilados durante `npm install`.

**Windows**: Visual Studio Build Tools com o workload "Desktop development with C++". Alternativa rapida: `npm install -g windows-build-tools`

**macOS**: Xcode Command Line Tools: `xcode-select --install`

**Linux**: `sudo apt install build-essential python3 libsecret-1-dev`

---

## Instalacao

### 1. Clonar o repositorio

```bash
git clone https://github.com/LionLabsCommunity/lionclawv1.0.git
cd lionclawv1.0
```

### 2. Instalar dependencias

```bash
npm install
```

Instala todas as dependencias, incluindo modulos nativos e compila automaticamente todos os MCP servers via `postinstall`. Se houver erro de compilacao, verifique os Build Tools acima.

> [!WARNING]
> **Para usuarios de Windows:** Apos rodar o `npm install`, e necessario recompilar as bibliotecas nativas para a versao interna de Node.js que o Electron utiliza. Caso contrario, o app ira falhar ao iniciar com o erro `ERR_DLOPEN_FAILED`.
> Rode o comando:
> ```bash
> npx electron-rebuild
> ```

### 3. Configurar a API Key

O LionClaw nao usa arquivos `.env` para segredos. Chaves sao armazenadas no keychain do SO.

Na primeira execucao, o app abre o fluxo de onboarding e pede sua API Key. Tambem pode ser configurado em **Settings > API Keys** dentro do app.

Chave obrigatoria: `ANTHROPIC_API_KEY`

Chaves opcionais (ativar conforme necessidade):

| Chave | Para que serve |
|-------|----------------|
| `OPENAI_API_KEY` | Memory Search (embeddings) |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Google Calendar, Gmail, Drive, Sheets, YouTube |
| `ELEVENLABS_API_KEY` | Sintese de voz |
| `GOOGLE_GEMINI_API_KEY` | Geracao de imagens (Nano Banana) |
| `SHOPIFY_STORE_URL` + credenciais | Integracao Shopify |

### 4. Rodar

```bash
npm run dev
```

Abre o app Electron com React dev server (Vite HMR), main process com auto-restart e DevTools.

### 5. Primeiro boot

Na primeira execucao, o app cria `~/.lionclaw/` com:

```
~/.lionclaw/
  SOUL.md               Identidade e personalidade do agente
  RULES.md              Regras de seguranca e operacao
  USER.md               Perfil do usuario (preenchido no onboarding)
  MEMORY.md             Memoria de trabalho
  BOOTSTRAP.md          Ritual de onboarding (usado so na primeira sessao)
  CLAUDE.md             Contexto consolidado (gerado automaticamente)
  .claude/
    settings.json       Isolamento do SDK
  agents/               Configuracoes de sub-agentes
  skills/               15 skills default (design, ferramentas, documentos)
  workflows/
    build-plan/
      stages/           Stage files do BuildPlan
  conversations/        Transcricoes arquivadas
  data/
    lionclaw.db         Banco SQLite (27 migracoes)
    sessions/           Sessions do Agent SDK
```

O onboarding conduz uma entrevista para conhecer o usuario e definir a identidade do agente.

---

## Comandos

| Comando | Descricao |
|---------|-----------|
| `npm run dev` | Inicia o app em modo desenvolvimento (hot reload) |
| `npm run build` | Compila para producao (sem empacotar) |
| `npm run dist` | Compila e empacota (DMG no Mac, NSIS no Windows) |
| `npm run dist:mac` | Empacota apenas para macOS |
| `npm run dist:win` | Empacota apenas para Windows |
| `npm run build:mcps` | Compila todos os MCP servers |
| `npm run typecheck` | Verifica tipos TypeScript (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run test:watch` | Testes em modo watch |

---

## Stack

| Componente | Tecnologia |
|------------|------------|
| Desktop runtime | Electron 33+ |
| Frontend | React 19 + Vite 7 + TailwindCSS 4 |
| State management | Zustand |
| Backend (main process) | Node.js + TypeScript |
| AI engine | @anthropic-ai/claude-agent-sdk |
| Database | better-sqlite3 + sqlite-vec (vector search) |
| Embeddings | @anthropic-ai/sdk (Anthropic Embeddings API) |
| Alt LLMs | @google/genai (Gemini), cohere-ai, ollama (local) |
| Scheduler | cron-parser |
| Logger | pino + pino-pretty |
| Secrets | node-keytar (OS keychain) + fallback criptografado |
| Auth | bcrypt (hash) + otplib (TOTP) |
| Telegram | node-telegram-bot-api |
| Doc parsing | pdf-parse, mammoth (DOCX), csv-parse |
| Terminal UI | xterm.js |
| Markdown | react-markdown + remark-gfm |
| Icons | lucide-react |
| Google APIs | googleapis (OAuth2) |

---

## Boot Sequence

Sequencia completa do que acontece quando o app inicia:

**1. Filesystem** (`ensureLionClawFiles`): cria `~/.lionclaw/` com SOUL.md, RULES.md, USER.md, MEMORY.md, BOOTSTRAP.md e subdiretorios.

**2. Skills** (`copyDefaultSkills`): copia 15 skills default do projeto para `~/.lionclaw/skills/`. Nunca sobrescreve existentes.

**3. CLAUDE.md** (`generateClaudeMd`): concatena SOUL + RULES + USER + MEMORY em um arquivo unico que o SDK le automaticamente. Inicia watcher para regenerar quando fontes mudam.

**4. Database** (`initDatabase`): cria SQLite em `~/.lionclaw/data/lionclaw.db`, roda 27 migracoes, executa seeds:

| Funcao | O que cria | Comportamento se ja existe |
|--------|-----------|---------------------------|
| `seedToolDefaults` | 12 tools nativas com estados default | Preserva config do usuario |
| `ensureSkillCreatorAgent` | Agente skill-creator (sonnet) | Nao toca |
| `ensureHarnessAgents` | Planner (opus), Coder (sonnet), Evaluator (sonnet) | Reconcilia prompt |
| `ensureWorkflowAgents` | Spec Builder (opus), Spec Validator (sonnet) | Reconcilia prompt |
| `ensureEnrichAgents` | Spec Validator Enrich (sonnet), Spec Enricher (sonnet) | Reconcilia prompt |

**5. Workflow Files** (`bootstrapWorkflowFiles`): copia stage files do BuildPlan para runtime. Sempre sincroniza (para pegar atualizacoes).

**6. Knowledge Bridge** (`startKnowledgeBridge`): inicia IPC bridge para o knowledge engine via Unix Domain Socket.

**7. MCP Servers** (`ensureBuiltinMCPServers` + `startActiveMCPServers`): registra 13 MCPs no banco e inicia os que estao ativos.

**8. SDK Discovery** (`discoverSDKMcpServers`): descobre MCPs remotos do Claude.ai em background.

**9. Scheduler** (`startScheduler`): inicia cron runner.

**10. Telegram** (`startTelegramBot`): tenta iniciar bot (falha silenciosamente sem token).

**11. Window**: cria a BrowserWindow do Electron.

---

## Sistemas Principais

### Orchestrator

Gerencia a fila de mensagens com pattern message queue. `submitMessage()` enfileira, `processQueue()` desenfileira e chama `executeQuery()`. Constroi definicoes de sub-agentes a partir do banco, incluindo tools (nativas + MCP locais + MCP remotos do Claude.ai), system prompts (RULES.md do agente + prompt customizado + instrucoes de skills) e MCP servers (montados via `buildMCPSpecForAgent`).

Agentes locais (Ollama) sao filtrados e acessados via MCP `local-agents`. Agentes cloud viram sub-agentes nativos do SDK.

### Harness Engine

Tres agentes em loop: Planner decompoe SPEC em sprints, Coder implementa, Evaluator valida. Metricas coletadas por round via stream events do SDK (message_start para input tokens, message_delta para output, content_block_start para tool uses). Custo calculado por `calculateCost()` em pricing.ts.

### Enrich Engine

Duas fases conversacionais. Cada agente opera em isolamento total. O Validator salva relatorio em arquivo persistente (memoria entre turnos). Edita SPEC incrementalmente apos aprovacao do usuario. Write/Edit no specPath sao auto-aprovados via `setActiveEnrichSpecPath()` no permission guard.

### Streaming

Todos os pipelines (chat, harness, enrich) usam o mesmo formato `StreamChunk`: `{ type: 'text' | 'tool_call' | 'thinking' | 'done', ... }`. Events do Agent SDK sao transformados no main process e enviados ao renderer via IPC.

### SQLite

Banco unico em `~/.lionclaw/data/lionclaw.db`. WAL mode, foreign keys ON. 27 migracoes (V1-V27). Todas as operacoes exportadas de `db.ts` como funcoes. Sempre prepared statements, nunca concatenacao SQL.

Tabelas principais: messages, sessions, agents, skills, mcp_servers, mcp_tool_registry, scheduled_tasks, task_executions, tool_audit_log, knowledge_documents, knowledge_chunks, harness_projects, harness_sprints, harness_rounds, workflow_runs, enrich_sessions, enrich_messages, token_usage, settings.

---

## MCP Servers

Servidores MCP (Model Context Protocol) sao processos independentes que expoem ferramentas ao agente via protocolo stdio JSON-RPC. O LionClaw gerencia o lifecycle (spawn, stop, restart) automaticamente.

### Servidores Built-in

| ID | Nome | Ativo por padrao | Requer chaves | Descricao |
|----|------|:-:|---|-----------|
| `excalidraw` | Excalidraw | Sim | - | Criacao de diagramas e whiteboard |
| `local-llm` | Local LLM | Sim | - | Integracao com Ollama (modelos locais) |
| `knowledge-base` | Knowledge Base | Sim | - | Busca semantica sobre documentos indexados |
| `skills` | Skills | Sim | - | Acesso a skills por demanda (list, load, metadata) |
| `memory-search` | Memory Search | Nao | OPENAI_API_KEY | Busca semantica sobre memoria do agente |
| `graph-search` | Graph Search | Nao | - | Busca em knowledge graph (vault Obsidian). Requer `mgraph_mode` ativo |
| `elevenlabs` | ElevenLabs | Nao | ELEVENLABS_API_KEY | Sintese de voz (TTS) |
| `nano-banana` | Nano Banana | Nao | GOOGLE_GEMINI_API_KEY | Geracao de imagens via Google GenAI |
| `shopify` | Shopify | Nao | 3 chaves Shopify | Integracao com loja Shopify |
| `google-gmail` | Gmail | Nao | 4 chaves Google | Envio e leitura de emails |
| `google-drive` | Google Drive | Nao | 4 chaves Google | Acesso ao Google Drive |
| `google-sheets` | Google Sheets | Nao | 4 chaves Google | Leitura e escrita de planilhas |
| `google-calendar` | Google Calendar | Nao | 4 chaves Google | Eventos e agenda |
| `youtube` | YouTube | Nao | 4 chaves Google | Dados do YouTube |

Servidores que requerem chaves nascem inativos. Ative-os em **Settings > MCP Servers** apos configurar as chaves correspondentes no Vault.

### Auto-inject

Dois MCPs sao injetados automaticamente em sub-agentes quando necessario:

O **knowledge-base** e injetado quando o agente tem documentos indexados (`kb_enabled` e `getCompletedDocsCount > 0`). Recebe `KB_AGENT_ID` no env para filtrar por agente.

O **skills** e injetado quando o agente tem skills vinculadas (`agent.skills.length > 0`). Instrucoes de uso sao adicionadas ao prompt.

### MCPs Remotos (Claude.ai)

MCPs gerenciados pelo Claude.ai (Stripe, Supabase, Notion, etc) sao acessados via Agent SDK. Suas tools tem prefixo `mcp__claude_ai_` e sao passadas diretamente do `allowed_tools` do agente, sem necessidade de registro no banco local.

---

## Estrutura do Projeto

```
LionClaw/
  electron/
    main/                       Processo principal (Node.js)
      index.ts                  Entry point, boot sequence
      orchestrator.ts           Message queue, sub-agente delegation
      agent-engine.ts           Agent SDK wrapper
      db.ts                     SQLite schema, migracoes, CRUD (~120KB)
      ipc-handlers.ts           Todos os IPC handlers (~60KB)
      permission-guard.ts       canUseTool callback, deteccao de acoes destrutivas
      prompt-builder.ts         Construcao de system prompt
      harness-engine.ts         Pipeline: planner -> coder -> evaluator
      harness-planner.ts        Sprint planning via AI
      harness-evaluator.ts      Avaliacao de codigo
      harness-prompts.ts        Prompt builders (coder, evaluator, validator, enricher)
      workflow-engine.ts        Orquestracao multi-etapa (BuildPlan)
      knowledge-engine.ts       Ingestao, chunking, embedding, busca
      knowledge-ipc-bridge.ts   IPC bridge para knowledge engine
      memory-pipeline.ts        Compactacao, sumarizacao, embeddings
      scheduler.ts              Cron runner
      mcp-manager.ts            Lifecycle de MCP servers
      mcp-discovery.ts          Discovery de MCPs do SDK
      telegram-bridge.ts        Bot do Telegram
      secrets-vault.ts          Encrypt/decrypt via keytar
      auth.ts                   Password hash, TOTP, session tokens
      pricing.ts                Calculo de custo por modelo
      logger.ts                 Pino logger factory
      paths.ts                  Utilitarios de path
      ollama-client.ts          Cliente Ollama
      image-engine.ts           Processamento de imagens
      voice-engine.ts           Integracao ElevenLabs
      artifact-detector.ts      Deteccao de artefatos em tool results
      embedding-provider.ts     Provider de embeddings com fallback chain
      seed-agents/              Configuracoes de agentes pre-built
        index.ts                Registry com arrays HARNESS/WORKFLOW/ENRICH
        harness-planner.ts      Planner (opus)
        harness-coder.ts        Coder (sonnet)
        harness-evaluator.ts    Evaluator (sonnet)
        spec-builder.ts         SPEC generator (opus)
        spec-validator.ts       SPEC validator (sonnet)
        spec-validator-enrich.ts  SPEC validator para Enrich (sonnet)
        spec-enricher.ts        SPEC enricher (sonnet)
    preload/
      index.ts                  contextBridge: window.lionclaw.*

  src/                          React app (renderer)
    App.tsx                     Page router, auth gate, IPC subscriptions
    pages/
      ChatPage.tsx              Chat principal
      SubAgentsPage.tsx         CRUD de agentes
      SkillsPage.tsx            Gerenciamento de skills
      MCPServersPage.tsx        Config de MCP servers
      HarnessPage.tsx           Dashboard do Harness
      BuildPlanPage.tsx         Workflow de especificacao
      EnrichDocPage.tsx         Pipeline de enriquecimento
      KnowledgePage.tsx         Knowledge base
      SchedulerPage.tsx         Tarefas agendadas
      TasksPage.tsx             Task management (kanban/calendario)
      MemoryPage.tsx            Gerenciamento de memoria
      RulesPage.tsx             Editor de regras globais
      SettingsPage.tsx          Configuracoes do app
      VaultPage.tsx             Secrets vault
      UsagePage.tsx             Analytics de tokens
      ChannelsPage.tsx          Integracao Telegram
      PermissionsPage.tsx       Gerenciamento de permissoes
      LogsPage.tsx              Logs do sistema
      AuthPage.tsx              Login/TOTP
    components/
      chat/                     ChatMessage, ConfirmDialog, AskQuestionDialog,
                                AudioPlayer, VoiceRecorder, TokenCounter,
                                AgentThinking, ArtifactRenderer, SlashCommandPicker,
                                ExcalidrawViewer, McpAppViewer
      agents/                   AgentFormModal, DeleteAgentDialog
      enrich/                   EnrichModal, EnrichControls, EnrichMetricsBar,
                                EnrichPhaseIndicator, EnrichSessionCard, SpecViewer
      harness/                  ProjectList, ProjectCard, ProjectDetail,
                                NewProjectModal, ExecutionView, MetricsView,
                                MetricsChart, SprintList, SprintCard,
                                AgentStreamPanel, RegenerateModal
      buildplan/                DiscoveryPanel, SpecGenerationView, ApprovalButtons
      scheduler/                TaskList, TaskFormModal, CalendarView, KanbanView,
                                ActivityBoard, ActivityCard, ActivityFilters
      skills/                   SkillFormModal, SkillEditor, SkillWizard
      settings/                 VoiceSelector, GoogleOAuthSetup
      channels/                 TelegramSetup
      common/                   Sidebar, MarkdownEditor, OpenFolderButton
    stores/
      app-store.ts              Page routing, global state
      auth-store.ts             Auth state
      chat-store.ts             Chat sessions, messages
      harness-store.ts          Harness projects, sprints
      enrich-store.ts           Enrich sessions, messages, metrics
      knowledge-store.ts        Knowledge base state
      workflow-store.ts         Workflow state
    types/
      index.ts                  Todos os tipos TypeScript compartilhados

  mcp-servers/                  15+ MCP servers (pacotes Node.js independentes)
    google-calendar/            Google Calendar API
    google-gmail/               Gmail API
    google-drive/               Google Drive API
    google-sheets/              Google Sheets API
    google-shared/              Utilitarios compartilhados de auth Google
    elevenlabs/                 Text-to-speech
    excalidraw/                 Diagramas e whiteboard
    knowledge-base/             Busca semantica
    memory-search/              Busca semantica sobre memoria
    local-agents/               Runner de agentes locais (Ollama)
    local-llm/                  Integracao Ollama
    skills/                     Skills MCP server
    youtube/                    YouTube API
    shopify/                    Shopify API
    nano-banana/                Google GenAI (imagens)
    graph-search/               Knowledge graph (Obsidian vault)

  .lionclaw/                    Templates (copiados para ~/.lionclaw/ no primeiro boot)
    skills/                     15 skills default (design, ferramentas, documentos)

  resources/                    Icones e assets
  scripts/                      Scripts de build auxiliares
  tests/                        Testes (Vitest)
```

---

## Troubleshooting

### Erro de compilacao de modulos nativos

Se `npm install` falhar ao compilar better-sqlite3, keytar, bcrypt ou sqlite-vec, verifique os Build Tools na secao Pre-requisitos.

### O app abre mas o chat nao funciona

Verifique se a `ANTHROPIC_API_KEY` foi configurada em **Settings > API Keys**. A chave e armazenada no keychain do SO.

### MCP Servers nao funcionam

Rode `npm run build:mcps` para compilar todos os servidores. Verifique os logs em **Logs** dentro do app. MCPs que requerem chaves de API so funcionam apos configurar as chaves no Vault.

### Erro de permissao ao acessar keytar

No Linux, instale `libsecret-1-dev` e reinicie o terminal. Se o keytar falhar, o app usa fallback com arquivo criptografado local.

### Agentes locais (Ollama) nao respondem

Verifique se o Ollama esta rodando (`ollama serve`). O MCP `local-llm` e `local-agents` precisam estar ativos. O modelo configurado no agente precisa estar disponivel no Ollama (`ollama list`).

### Knowledge Base nao retorna resultados

Verifique se os documentos foram indexados completamente (status "completed" na pagina Knowledge). Embeddings requerem `ANTHROPIC_API_KEY` valida.

---

## Licenca

UNLICENSED - Proprietary (LionLabs)
