<div align="center">
  <img src="LionLogoGit.png" alt="LionClaw logo" />
</div>

# LionClaw

Assistente pessoal de IA em app desktop Electron. Single-user, single-machine, com acesso ao terminal, filesystem, internet, MCPs locais e agentes especializados.

Versao atual do pacote: `2.2.0`

---

## Indice

1. [Visao Geral](#visao-geral)
2. [Novidades da 2.2](#novidades-da-22)
3. [Pre-requisitos](#pre-requisitos)
4. [Instalacao](#instalacao)
5. [Configuracao de Chaves](#configuracao-de-chaves)
6. [OpenRouter e Providers Externos](#openrouter-e-providers-externos)
7. [Codex CLI](#codex-cli)
8. [Pipelines](#pipelines)
9. [Funcionalidades](#funcionalidades)
10. [Arquitetura](#arquitetura)
11. [Boot Sequence](#boot-sequence)
12. [MCP Servers](#mcp-servers)
13. [Comandos](#comandos)
14. [Estrutura do Projeto](#estrutura-do-projeto)
15. [Troubleshooting](#troubleshooting)
16. [Licenca](#licenca)

---

## Visao Geral

LionClaw roda localmente como aplicativo desktop. Ele nao e um chatbot web: o main process do Electron orquestra agentes, banco SQLite, scheduler, MCPs, Knowledge Base, Telegram, Vault, CodeBurn e pipelines de implementacao. O renderer React so conversa com o main process via Electron IPC tipado.

Em producao nao existe servidor web separado nem API HTTP exposta. Dados ficam na maquina do usuario: `~/.lionclaw/`, SQLite local, keychain do sistema operacional para segredos e sqlite-vec para busca vetorial.

O runtime principal usa `@anthropic-ai/claude-agent-sdk` para agentes Claude. A versao 2.2 tambem inclui:

- runtime `external` para OpenRouter, OpenAI direto e providers OpenAI-compatible;
- runtime `codex` via OpenAI Codex CLI autenticado por OAuth;
- runtime `local` para Ollama, LM Studio e endpoints locais compativeis.

---

## Novidades da 2.2

### Pipeline unificado

A tela **Pipeline** concentra quatro tipos de fluxo:

| Tipo | Uso |
|------|-----|
| `development` | Criar produto do zero: discovery, PRD, SPEC, planejamento e implementacao |
| `feature` | Adicionar uma feature a um projeto existente |
| `security` | Auditoria multi-agente de seguranca e qualidade, gerando SPEC de correcao |
| `architecture-review` | Mapeamento arquitetural, triagem de alvo, diagnostico, decisoes e SPEC |

### Security Audit Pipeline

Novo pipeline de seguranca com Repo Profiler, sete auditores em paralelo limitado a 3 agentes, deduplicacao, validadores ceticos, SPEC, planner e ciclo Coder/Evaluator.

Auditores da fase 2:

- Secrets Scanner
- Auth Auditor
- Isolation Inspector
- Duplication Detector
- Logic Analyzer
- Standards Checker
- OWASP Scanner

O fluxo gera artefatos em `.lionclaw/Security/`, inclui `manifest.json`, relatorios parciais, relatorio consolidado, resumo executivo e `SecurityScan-*.json` para tracking de resolucao.

### Architecture Review Pipeline

Novo fluxo para entender uma codebase antes de implementar mudancas grandes:

1. Mapeamento arquitetural
2. Triagem de alvos
3. Diagnostico arquitetural
4. Entrevista de decisao
5. Spec Generation
6. Spec Validation
7. Spec Enricher
8. Planner
9. Sprint Validator
10. Coder
11. Evaluator

Os artefatos ficam em:

```text
<projectPath>/.lionclaw/pipelines/architecture-review/<runId>/
  manifest.json
  ArchitectureMap-<runId>.md
  ArchitectureMap-<runId>.json
  ArchitectureCandidates-<runId>.md
  ArchitectureCandidates-<runId>.json
  ArchitectureDiagnosis-<runId>.md
  ArchitectureDiagnosis-<runId>.json
  ArchitectureDecisions-<runId>.md
  ArchitectureDecisions-<runId>.json
  ArchitectureSpecSource-<runId>.md
  SPEC-<runId>.md
  sprints-<runId>.json
```

### OpenRouter e OpenAI externo

Agentes agora podem usar runtime `external` com providers OpenRouter, OpenAI direto ou qualquer endpoint OpenAI-compatible. As chaves ficam no Vault, nao em `.env`.

### Codex CLI

Agentes podem usar runtime `codex`, rodando o OpenAI Codex CLI por OAuth. Esse runtime usa ferramentas nativas do Codex, sandbox `workspace-write` por padrao e nao usa MCPs, Skills ou Knowledge Base do LionClaw durante a execucao.

### Codex no Windows

Existe um health check especifico para Windows para evitar falhas de `apply_patch` por CRLF e encoding PowerShell 5.1. O app pode preparar o repo com consentimento do usuario.

### CodeBurn

A tela **Usage** foi substituida por um terminal embutido do CodeBurn. O LionClaw inicia `codeburn report` via `node-pty` e renderiza no xterm.js.

### Seeds e DB atualizados

O boot garante todos os seed agents por uma chamada unica (`ensureAllSeedAgents`) e materializa snapshots em `~/.lionclaw/agents/<id>/config.json`. O banco esta na migration V57.

---

## Pre-requisitos

| Ferramenta | Versao Minima | Como verificar | Como instalar |
|------------|---------------|----------------|---------------|
| **Node.js** | v18+ (recomendado v22) | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | v9+ | `npm --version` | Ja vem com o Node.js |
| **Python** | 3.10+ | `python --version` | [python.org](https://www.python.org/) |
| **Git** | qualquer versao recente | `git --version` | [git-scm.com](https://git-scm.com/) |

Modulos que podem exigir build nativo: `better-sqlite3`, `keytar`, `sqlite-vec` e `node-pty`.

Build tools por sistema:

| Sistema | Requisito |
|---------|-----------|
| macOS | Xcode Command Line Tools: `xcode-select --install` |
| Windows | Visual Studio Build Tools com workload "Desktop development with C++". Alternativa rapida: `npm install -g windows-build-tools` |
| Linux | `sudo apt install build-essential python3 libsecret-1-dev` |

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

O `npm install` instala todas as dependencias, incluindo modulos nativos, e compila automaticamente todos os MCP servers via `postinstall` (`npm run build:mcps`). Se houver erro de compilacao, verifique os Build Tools acima.

> [!WARNING]
> **Para usuarios de Windows:** apos rodar `npm install`, e necessario recompilar as bibliotecas nativas para a versao interna de Node.js que o Electron utiliza. Caso contrario, o app pode falhar ao iniciar com `ERR_DLOPEN_FAILED`.
>
> Comando recomendado neste repo:
>
> ```bash
> npm run rebuild:electron
> ```
>
> Alternativa equivalente:
>
> ```bash
> npx electron-rebuild
> ```

### 3. Configurar a API Key

O LionClaw nao usa arquivos `.env` para segredos de usuario. Chaves sao armazenadas no keychain do sistema operacional.

Na primeira execucao, o app abre o fluxo de onboarding e pede sua API Key. Depois disso, as chaves podem ser configuradas no **Vault** dentro do app.

Chave obrigatoria:

| Chave | Para que serve |
|-------|----------------|
| `ANTHROPIC_API_KEY` | Agentes Claude via Claude Agent SDK |

Chaves opcionais principais:

| Chave | Para que serve |
|-------|----------------|
| `OPENAI_API_KEY` | Embeddings da memoria e Knowledge Base, transcricao |
| `HARNESS_OPENROUTER_KEY` | Agentes externos via OpenRouter |
| `HARNESS_OPENAI_KEY` | Agentes externos via OpenAI direto |
| `COHERE_API_KEY` | Reranking na Knowledge Base |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + tokens OAuth | Google Calendar, Gmail, Drive, Sheets, YouTube |
| `ELEVENLABS_API_KEY` | Sintese de voz |
| `GOOGLE_GEMINI_API_KEY` | Geracao de imagens via Nano Banana |
| `SHOPIFY_STORE_URL` + credenciais | Integracao Shopify |

### 4. Rodar

```bash
npm run dev
```

Abre o app Electron com React dev server (Vite HMR), main process com auto-restart e DevTools.

### 5. Primeiro boot

Na primeira execucao, o app cria `~/.lionclaw/` com:

```text
~/.lionclaw/
  SOUL.md               Identidade e personalidade do agente
  RULES.md              Regras de seguranca e operacao
  USER.md               Perfil do usuario, preenchido no onboarding
  MEMORY.md             Memoria de trabalho
  BOOTSTRAP.md          Ritual de onboarding, usado na primeira sessao
  CLAUDE.md             Contexto consolidado, gerado automaticamente
  .claude/
    settings.json       Isolamento do SDK
  agents/               Configuracoes e snapshots de sub-agentes
  skills/               Skills default
  workflows/
    build-plan/
      stages/           Stage files do BuildPlan
  conversations/        Transcricoes arquivadas
  background/           CWD isolado para scheduler e Telegram
  data/
    lionclaw.db         Banco SQLite
    sessions/           Sessions do Agent SDK
```

O onboarding conduz uma entrevista inicial para conhecer o usuario e definir preferencias do agente.

---

## Configuracao de Chaves

Segredos sao armazenados no keychain do sistema operacional via `node-keytar`. Se o keytar falhar, o LionClaw usa fallback criptografado local em `~/.lionclaw/data/.secrets`.

Abra **Vault** dentro do app e configure as chaves necessarias.

| Chave | Obrigatoria | Uso |
|-------|-------------|-----|
| `ANTHROPIC_API_KEY` | Sim | Agentes Claude via Claude Agent SDK |
| `OPENAI_API_KEY` | Nao | Embeddings `text-embedding-3-small` e transcricao |
| `HARNESS_OPENROUTER_KEY` | Nao | Agentes runtime `external` via OpenRouter |
| `HARNESS_OPENAI_KEY` | Nao | Agentes runtime `external` via OpenAI direto |
| `COHERE_API_KEY` | Nao | Reranking na Knowledge Base |
| `ELEVENLABS_API_KEY` | Nao | Voz sintetica |
| `GOOGLE_GEMINI_API_KEY` | Nao | Nano Banana, geracao de imagens |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_ACCESS_TOKEN` | Nao | Gmail, Drive, Sheets, Calendar, YouTube |
| `SHOPIFY_STORE_URL`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Nao | MCP Shopify |

O app nao deve depender de chaves commitadas em `.env`. Para development local, `.env` pode existir para tooling auxiliar, mas segredos de usuario devem ir para o Vault.

---

## OpenRouter e Providers Externos

### Configurar OpenRouter

1. Crie uma API key no OpenRouter: [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
2. No LionClaw, abra **Vault**.
3. Edite **OpenRouter API Key**.
4. Cole a chave no formato `sk-or-v1-...`.
5. Clique em **Testar conexao**.
6. Em **Sub-Agentes**, crie ou edite um agente.
7. Em **Runtime**, escolha `External`.
8. Em **Provider**, escolha `OpenRouter`.

Preset aplicado pelo app:

| Campo | Valor |
|-------|-------|
| Base URL | `https://openrouter.ai/api/v1` |
| Vault key | `HARNESS_OPENROUTER_KEY` |
| Test endpoint | `/auth/key` |
| Default model | `deepseek/deepseek-v4-pro` |
| Headers extras | `HTTP-Referer: https://lionclaw.app`, `X-Title: LionClaw` |

O runtime `external` chama endpoints OpenAI-compatible (`/v1/chat/completions`) e suporta tool calling quando o provider/modelo suporta.

Referencia oficial: [OpenRouter API Authentication](https://openrouter.ai/docs/api-keys).

### Modelos OpenRouter no catalogo

| Modelo | Label no app | Contexto |
|--------|--------------|----------|
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1M |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1M |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | 256K |
| `moonshotai/kimi-k2-thinking` | Kimi K2 Thinking | 256K |
| `qwen/qwen3.6-max-preview` | Qwen 3.6 Max Preview | 262K |
| `qwen/qwen3.6-plus` | Qwen 3.6 Plus | 262K |
| `minimax/minimax-m2.7` | MiniMax M2.7 | 196K |
| `minimax/minimax-m2.5` | MiniMax M2.5 | 196K |
| `minimax/minimax-m1` | MiniMax M1 | 1M |
| `z-ai/glm-4.7` | GLM 4.7 | 202K |
| `z-ai/glm-4.7-flash` | GLM 4.7 Flash | 202K |

### OpenAI direto

Provider `OpenAI` usa:

| Campo | Valor |
|-------|-------|
| Base URL | `https://api.openai.com/v1` |
| Vault key | `HARNESS_OPENAI_KEY` |
| Modelos | `gpt-5.5`, `gpt-5.5-pro` |

Essa chave e separada de `OPENAI_API_KEY`, que e usada para embeddings e audio.

### Custom OpenAI-compatible

Use provider `Custom (OpenAI-compatible)` para APIs locais ou de terceiros.

Campos:

- Base URL manual
- Model slug manual ou carregado via `/v1/models`
- Vault key no formato `HARNESS_CUSTOM_<SLUG>_KEY`
- Context window manual
- Headers extras em JSON

---

## Codex CLI

O runtime `codex` usa o OpenAI Codex CLI instalado na maquina do usuario. O LionClaw nao pede API key separada para esse runtime; ele usa a autenticacao local do CLI.

Referencias oficiais: [Codex CLI Getting Started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started) e [Codex CLI Sign in with ChatGPT](https://help.openai.com/en/articles/11381614).

### Instalar

```bash
npm install -g @openai/codex
```

### Conectar no LionClaw

1. Abra **Settings**.
2. Va para **Codex CLI**.
3. Clique em **Conectar Codex**.
4. O app abre um terminal externo executando `codex login`.
5. Complete o login no browser.
6. Volte ao LionClaw e clique em **Testar conexao**.

O status checa:

- se o binario `codex` existe;
- a versao via `codex --version`;
- se existe `~/.codex/auth.json`;
- se `codex login status` retorna sucesso.

Se o binario nao estiver no `PATH`, configure **Path customizado do binario** em Settings. No Windows, o app tambem procura em `%APPDATA%\npm\codex.cmd` e caminhos equivalentes do usuario.

### Modelos Codex no app

| Modelo | Descricao no app |
|--------|------------------|
| `gpt-5.5` | Frontier, codex-tuned, recomendado |
| `gpt-5.4` | Generalista frontier |
| `gpt-5.4-mini` | Mais barato e rapido |
| `gpt-5.3-codex` | Variante codex-tuned legado |
| `gpt-5.2` | Anterior, generalista |

O agente Codex tambem tem `reasoningEffort`: `low`, `medium` ou `high`.

### Como criar um agente Codex

1. Abra **Sub-Agentes**.
2. Crie ou edite um agente.
3. Em **Runtime**, escolha `Codex`.
4. Escolha modelo e reasoning effort.
5. Salve.

Notas importantes:

- Codex usa sandbox `workspace-write` por padrao.
- Codex usa ferramentas nativas de read/write/exec do CLI.
- Tools, MCPs, Skills e Knowledge Base do LionClaw sao ignorados nesse runtime.
- O permission guard do LionClaw nao intermedeia as operacoes internas do Codex. A protecao vem do sandbox e das regras do Codex CLI.
- O pipeline captura metricas, comandos executados, arquivos alterados e falhas repetidas de patch.

### Windows Health Check do Codex

No Windows, o Codex CLI pode sofrer com CRLF e encoding do PowerShell 5.1. O LionClaw implementa um fluxo de preparo com consentimento.

O dialog aparece somente quando todas as condicoes abaixo sao verdadeiras:

- sistema operacional Windows;
- path do projeto resolve para um repo Git;
- Codex CLI esta instalado e autenticado;
- existe pelo menos um agente Codex ativo;
- o health check detecta issues acionaveis;
- o usuario ainda nao autorizou ou pulou a preparacao para aquela versao do prep.

Issues detectadas:

| Issue | Severidade | O que significa |
|-------|------------|-----------------|
| `autocrlf-true` | Alta | `core.autocrlf=true`, checkout pode converter LF para CRLF |
| `no-gitattributes` | Media | `.gitattributes` ausente ou sem regra `eol=lf` |
| `mixed-line-endings` | Media | index e working tree divergem em line endings |
| `powershell-5.1` | Baixa | informativo sobre encoding CP-1252 |

Ao clicar **Preparar**, o app executa:

```bash
git config core.autocrlf false
git add --renormalize .
git reset
```

E cria ou atualiza `.gitattributes` com:

```text
* text=auto eol=lf
```

Guardrails:

- nao roda fora do Windows;
- nao roda em repos com submodules;
- exige working tree limpo antes de aplicar;
- nao faz commit;
- permite **Agora nao** ou **Nunca para este projeto**;
- reemite warning se o problema persistir e o usuario nao tiver optado por pular.

Se o Codex acumular 3 falhas de `apply_patch verification failed`, o pipeline mostra um warning especifico sugerindo Health Check.

---

## Pipelines

### Development Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Discovery | Conversa |
| 2 | PRD Generator | Auto |
| 3 | PRD Validator | Conversa |
| 4 | PRD Completo | Auto |
| 5 | Database | Conversa |
| 6 | Backend | Conversa |
| 7 | Frontend | Conversa |
| 8 | Security | Conversa |
| 9 | Spec Generation | Auto |
| 10 | Spec Enricher | Conversa |
| 11 | Planner | Auto |
| 12 | Sprint Validator | Conversa |
| 13 | Coder | Loop |
| 14 | Evaluator | Loop |

Entry points disponiveis:

- Discovery: comecar do zero.
- Spec Builder: quando ja existe PRD e decisoes tecnicas.
- Planner: quando ja existe SPEC aprovada.

### Feature Pipeline

Versao do Development Pipeline voltada a um repositorio existente. Comeca por Feature Discovery e segue por PRD, tech review, SPEC, planner e implementacao.

Entry point atual: Feature Discovery.

### Security Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Repo Profiler | Auto |
| 2 | Security Audit | Auto multi-agente |
| 3 | Deduplicador | Auto |
| 4 | Skeptic Security | Conversa |
| 5 | Skeptic Quality | Conversa |
| 6 | SPEC Generator | Auto |
| 7 | SPEC Enricher | Conversa |
| 8 | Planner | Auto |
| 9 | Sprint Validator | Conversa |
| 10 | Coder | Loop |
| 11 | Evaluator | Loop |

Entry points:

- Scan Completo: profiling, auditoria, validacao e correcao automatizada.
- SPEC a partir de relatorio: quando ja existe um `Security-*.md`.

### Architecture Review Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Mapeamento Arquitetural | Auto |
| 2 | Triagem de Alvos | Conversa |
| 3 | Diagnostico Arquitetural | Auto |
| 4 | Entrevista de Decisao | Conversa |
| 5 | Spec Generation | Auto |
| 6 | Spec Validation | Conversa |
| 7 | Spec Enricher | Conversa |
| 8 | Planner | Auto |
| 9 | Sprint Validator | Conversa |
| 10 | Coder | Loop |
| 11 | Evaluator | Loop |

Entry point atual: Mapeamento Completo.

### Reset, pausa e historico

A tela Pipeline suporta:

- pausar e abortar pipeline;
- retry de fase;
- reset de fase ou sprint com preview;
- historico por fase;
- preview de documentos gerados;
- metricas por fase e por agente;
- tracking de sprints, rounds, custo e duracao.

---

## Funcionalidades

### Chat

Chat com streaming, tool calls visiveis, Markdown com GFM, anexos, imagens, audio, artefatos e slash commands. Sessoes e mensagens ficam no SQLite.

### Sub-Agentes

Cada agente tem configuracao propria:

- runtime: `cloud`, `local`, `external` ou `codex`;
- modelo;
- prompt;
- tools;
- MCP servers;
- skills;
- effort;
- thinking;
- max turns;
- max tool rounds;
- squad.

Agentes `cloud` rodam pelo Claude Agent SDK. Agentes `local` usam Ollama, LM Studio ou OpenAI-compatible local. Agentes `external` usam HTTP OpenAI-compatible. Agentes `codex` usam Codex CLI.

### Knowledge Base

Ingestao de PDF, DOCX, CSV e Markdown. O sistema faz parse, chunking, embeddings e busca hibrida. Embeddings usam OpenAI `text-embedding-3-small` quando `OPENAI_API_KEY` existe, com fallback Ollama se configurado e se as dimensoes baterem.

### Skills

Skills sao instrucoes em Markdown com frontmatter. O MCP `skills` expoe `list_skills`, `load_skill` e `get_skill_metadata`. Agentes com skills vinculadas recebem o MCP automaticamente.

### Enrich

Fluxo conversacional de duas fases para melhorar uma SPEC antes da implementacao:

1. Validator: cruza SPEC, PRD e codigo existente.
2. Enricher: adiciona edge cases, estados de UI, fluxos alternativos, tratamento de erros e permissoes.

### Scheduler e Tasks

Scheduler baseado em `cron-parser`, com execucao sob demanda, historico de runs, calendario, kanban e filtros.

### Vault

Vault com keychain do SO e fallback criptografado. A UI permite salvar, testar e apagar chaves conhecidas.

### Telegram

Bridge bidirecional com Telegram via bot token. Conversas sao roteadas para o orquestrador e retornam ao Telegram.

### CodeBurn

Dashboard de uso via CodeBurn embutido em terminal xterm.js. O main process resolve o binario Node do sistema e executa `codeburn report`.

### Auth

Autenticacao local com bcrypt e TOTP. O app bloqueia a sessao em suspend e lock-screen.

### Permission Guard

Ferramentas seguras sao auto-aprovadas. Acoes destrutivas exigem confirmacao via popup. Durante auditoria de seguranca, leitura direta de `.env*` e bloqueada: o agente deve verificar historico Git e `.gitignore` sem abrir secrets.

---

## Arquitetura

```text
Renderer React + Vite
        |
        | Electron IPC via contextBridge
        v
Main Process Node.js + TypeScript
        |
        +-- Orchestrator
        +-- Agent Runtime Executors
        |     +-- cloud: Claude Agent SDK
        |     +-- local: Ollama, LM Studio, OpenAI-compatible
        |     +-- external: OpenRouter, OpenAI, custom HTTP
        |     +-- codex: OpenAI Codex CLI
        |
        +-- SQLite + sqlite-vec
        +-- PipelineEngine
        +-- HarnessEngine
        +-- KnowledgeEngine
        +-- Scheduler
        +-- MCP Manager
        +-- Telegram Bridge
        +-- Vault
```

Regras importantes:

- Renderer nunca acessa Node.js diretamente.
- Todo acesso a banco fica no main process.
- Todos os IPCs passam pelo preload.
- Todas as operacoes SQLite usam prepared statements.
- Segredos nunca ficam no banco nem em arquivos plaintext.
- MCPs rodam como subprocessos stdio.
- Pipelines gravam artefatos no projeto alvo, normalmente dentro de `.lionclaw/`.

---

## Boot Sequence

Sequencia resumida do boot atual:

1. Registra handlers de excecao e shutdown.
2. Registra protocolo `lionclaw-asset://`.
3. Cria arquivos base em `~/.lionclaw/`.
4. Copia skills default se ainda nao existem.
5. Gera `CLAUDE.md` a partir de `SOUL.md`, `RULES.md`, `USER.md` e `MEMORY.md`.
6. Inicia watcher desses arquivos.
7. Inicializa SQLite e aplica migrations ate V57.
8. Roda `seedToolDefaults`.
9. Roda `ensureAllSeedAgents`.
10. Registra entradas do Vault para OpenRouter e OpenAI externo.
11. Inicia Knowledge Bridge.
12. Inicia watcher de ingestao graph quando `mgraph_mode=true`.
13. Instancia HarnessEngine e PipelineEngine.
14. Registra IPC handlers.
15. Garante MCPs built-in.
16. Inicia MCPs ativos.
17. Descobre MCPs remotos do SDK em background.
18. Inicia Scheduler.
19. Tenta iniciar Telegram bot se configurado.
20. Cria BrowserWindow.
21. Inicializa auto-updater em producao.
22. Registra power monitor para auto-lock.

### Diretorio `~/.lionclaw`

```text
~/.lionclaw/
  SOUL.md
  RULES.md
  USER.md
  MEMORY.md
  BOOTSTRAP.md
  CLAUDE.md
  .claude/
    settings.json
  agents/
    <agent-id>/
      config.json
  skills/
  workflows/
  conversations/
  background/
  data/
    lionclaw.db
    sessions/
```

---

## MCP Servers

MCPs built-in sao registrados no banco no boot. Servidores que exigem chave podem ficar inativos ate a configuracao no Vault.

| ID | Ativo por padrao | Chaves | Uso |
|----|------------------|--------|-----|
| `memory-search` | Sim | `OPENAI_API_KEY`, `COHERE_API_KEY` opcionais | Busca em memoria semantica |
| `excalidraw` | Sim | Nenhuma | Diagramas e whiteboard |
| `local-llm` | Sim | Nenhuma | Ollama e modelos locais |
| `knowledge-base` | Sim | Nenhuma | Busca em documentos indexados |
| `skills` | Sim | Nenhuma | Carregamento de skills |
| `graph-search` | Condicional | Nenhuma | Knowledge graph quando `mgraph_mode=true` |
| `elevenlabs` | Nao | `ELEVENLABS_API_KEY` | Text-to-speech |
| `nano-banana` | Nao | `GOOGLE_GEMINI_API_KEY` | Geracao de imagens |
| `shopify` | Nao | Shopify | Integracao Shopify |
| `google-gmail` | Nao | Google OAuth | Gmail |
| `google-drive` | Nao | Google OAuth | Drive |
| `google-sheets` | Nao | Google OAuth | Sheets |
| `google-calendar` | Nao | Google OAuth | Calendar |
| `youtube` | Nao | Google OAuth | YouTube |

Auto-inject:

- `knowledge-base` e injetado quando o agente tem Knowledge Base habilitada e documentos indexados.
- `skills` e injetado quando o agente tem skills vinculadas.
- `codex-agents` e criado in-process quando existe agente `runtime=codex` ativo.

---

## Comandos

| Comando | Descricao |
|---------|-----------|
| `npm run dev` | Inicia Electron + Vite em modo desenvolvimento |
| `npm run build` | Compila main e renderer |
| `npm run preview` | Preview do build Electron Vite |
| `npm run dist` | Build e empacotamento com electron-builder |
| `npm run dist:mac` | Empacota para macOS |
| `npm run dist:win` | Empacota para Windows |
| `npm run build:mcps` | Compila todos os MCP servers |
| `npm run build:excalidraw-bundle` | Gera bundle do Excalidraw |
| `npm run rebuild:electron` | Rebuild de `better-sqlite3` e `node-pty` para Electron |
| `npm run rebuild:node` | Rebuild de `better-sqlite3` e `node-pty` para Node |
| `npm run typecheck` | TypeScript geral |
| `npm run typecheck:main` | TypeScript main process |
| `npm run typecheck:renderer` | TypeScript renderer |
| `npm run test` | Vitest |
| `npm run test:watch` | Vitest em watch |

---

## Estrutura do Projeto

```text
LionClaw/
  electron/
    main/
      index.ts
      orchestrator.ts
      agent-runtime/
      pipeline-engine/
      harness-engine.ts
      security-audit-runner.ts
      repo-profiler.ts
      codex-bridge.ts
      codex-windows-prep.ts
      codeburn-pty.ts
      db.ts
      ipc-handlers.ts
      mcp-manager.ts
      knowledge-engine.ts
      scheduler.ts
      telegram-bridge.ts
      vault-registry.ts
      seed-agents/
    preload/
      index.ts
  src/
    App.tsx
    pages/
      ChatPage.tsx
      SubAgentsPage.tsx
      PipelinePage.tsx
      KnowledgePage.tsx
      SettingsPage.tsx
      VaultPage.tsx
      UsagePage.tsx
    components/
      chat/
      agents/
      pipeline/
      settings/
    stores/
      app-store.ts
      chat-store.ts
      pipeline-store.ts
    types/
      index.ts
      pipeline.ts
  mcp-servers/
  resources/
  scripts/
  tests/
```

---

## Troubleshooting

### Chat nao funciona

Configure `ANTHROPIC_API_KEY` no Vault. Essa chave e obrigatoria para agentes Claude.

### OpenRouter falha

Verifique:

- `HARNESS_OPENROUTER_KEY` esta no Vault;
- a chave comeca com `sk-or-v1-`;
- o provider do agente e `OpenRouter`;
- a Base URL esta em `https://openrouter.ai/api/v1`;
- o teste de conexao no Vault passa.

### Codex nao conecta

Verifique:

```bash
codex --version
```

Depois rode o login pelo app ou manualmente no terminal. Se a sua versao do CLI nao aceitar `codex login`, atualize:

```bash
npm install -g @openai/codex
```

Depois autentique com o comando indicado pelo proprio CLI e clique **Testar conexao** no LionClaw.

### Codex no Windows falha em patches

Use o Health Check do Pipeline. O preparo exige working tree limpo. Se houver mudancas locais, commit ou stash antes. Repos com submodules sao pulados por seguranca.

### CodeBurn nao abre

Verifique:

- `npm install` foi executado;
- `node` esta no PATH do sistema;
- `node-pty` foi recompilado para Electron com `npm run rebuild:electron`.

### MCP nao inicia

Rode:

```bash
npm run build:mcps
```

Depois veja logs na pagina **Logs**.

### Knowledge Base nao retorna resultados

Verifique se os documentos estao com status `completed`. Para embeddings, configure `OPENAI_API_KEY` ou habilite Ollama com um modelo que retorne 1536 dimensoes.

### Erro de keytar no Linux

Instale:

```bash
sudo apt install libsecret-1-dev
```

Se o keytar ainda falhar, o app usa fallback criptografado local.

---

## Licenca

UNLICENSED - Proprietary (LionLabs)
