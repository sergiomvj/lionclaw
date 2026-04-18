import { app, BrowserWindow, shell, powerMonitor, ipcMain, protocol, net } from 'electron';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import { initDatabase, seedToolDefaults, ensureSkillCreatorAgent, ensureHarnessAgents, ensureWorkflowAgents, ensureEnrichAgents, ensureDevAgents, ensurePipelineAgents, ensureTechAgents, getSetting } from './db';
import { registerIPCHandlers } from './ipc-handlers';
import { startScheduler, stopScheduler } from './scheduler';
import { startTelegramBot, stopTelegramBot } from './telegram-bridge';
import { startActiveMCPServers, stopAllMCPServers, getAllMCPServers, createMCPServer, updateMCPServer } from './mcp-manager';
import { discoverSDKMcpServers } from './mcp-discovery';
import { getExcalidrawView } from './excalidraw-views';
import { logout } from './auth';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { bootstrapWorkflowFiles } from './workflow-engine';
import { startKnowledgeBridge, stopKnowledgeBridge } from './knowledge-ipc-bridge';
import { HarnessEngine } from './harness-engine';
import { PipelineEngine } from './pipeline-engine';
import { startIngestQueueWatcher, stopIngestQueueWatcher } from './graph-ingest';

const logger = createLogger('main');

// Prevent EPIPE and other uncaught errors from crashing the app with a dialog
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE')) {
    logger.warn({ err }, 'EPIPE error (subprocess pipe closed) - ignoring');
    return;
  }
  logger.error({ err }, 'Uncaught exception in main process');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection in main process');
});

// Graceful shutdown on SIGTERM/SIGINT (electron-vite dev sends SIGTERM on hot-reload)
// Without this, the Telegram long-polling connection isn't released and causes 409 Conflict
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Received signal, cleaning up');
    try { await stopTelegramBot(); } catch { /* ignore */ }
    stopScheduler();
    stopAllMCPServers();
    stopKnowledgeBridge();
    process.exit(0);
  });
}

let mainWindow: BrowserWindow | null = null;
let harnessEngine: HarnessEngine | null = null;
let pipelineEngine: PipelineEngine | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LionClaw',
    icon: path.join(__dirname, '../../resources/logo-lionclaw.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Log renderer console messages to terminal for debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelStr = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'LOG';
    logger.info({ levelStr, line, sourceId }, `[RENDERER] ${message}`);
  });

  if (process.env.NODE_ENV === 'development') {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl) {
      mainWindow.loadURL(rendererUrl);
    }
    // Cmd+Shift+I (Mac) / Ctrl+Shift+I (Linux/Win) to toggle DevTools
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'I' && input.shift && (input.meta || input.control)) {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Recover from GPU/renderer crashes by reloading the page
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error({ reason: details.reason, exitCode: details.exitCode }, 'Render process gone, reloading window');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function lockSession(reason: 'suspend' | 'lock-screen'): void {
  logger.info({ reason }, 'System lock event received, locking session');
  logout();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:locked');
  }
}

const DEFAULT_SOUL = `# LionClaw - Soul

## Identidade
Voce e o LionClaw, um assistente pessoal de IA rodando como app desktop no computador do usuario.
Voce nao e um chatbot generico. Voce e O assistente pessoal dedicado deste usuario.
Voce tem acesso ao terminal, filesystem e internet. Voce executa, nao apenas explica.

## Personalidade
- Direto e pragmatico: va ao ponto, sem rodeios
- Proativo: antecipe necessidades, sugira melhorias, avise sobre problemas
- Tecnico quando necessario: sabe falar de codigo, infra, dados, negocio
- Honesto: se nao sabe, diga. Se discorda, argumente com fatos
- Resiliente: se algo falhar, tente resolver antes de reportar

## Tom de Voz
- Portugues brasileiro, informal
- Como um colega de trabalho senior e confiavel
- Sem formalidades desnecessarias (nada de "prezado", "cordialmente", "espero que esteja bem")
- Nunca use travessoes no meio de frases
- Seja conciso: se uma frase resolve, nao use um paragrafo

## Valores
- Privacidade do usuario acima de tudo
- Execucao > explicacao (faca, nao apenas diga como fazer)
- Transparencia sobre limitacoes
- Melhoria continua (aprenda com cada interacao)

## Limites
- Voce opera APENAS no computador do usuario, nunca em servidores remotos sem permissao
- Voce NUNCA toma decisoes irreversiveis sem confirmacao (deletar, enviar, publicar)
- Voce NUNCA compartilha dados do usuario com terceiros
- Voce SEMPRE informa quando nao tem certeza sobre algo
`;

const DEFAULT_USER = `# Sobre o Usuario

Nenhuma informacao coletada ainda. Execute o onboarding para conhecer o usuario.
`;

const DEFAULT_RULES = `# Regras do LionClaw

## Seguranca
- Nunca delete arquivos sem confirmacao explicita do usuario
- Nunca execute comandos com sudo sem confirmacao
- Nunca envie emails/mensagens sem mostrar o rascunho antes
- Nunca faca git push sem confirmacao
- Nunca modifique arquivos de sistema (/usr, /etc, /System)
- Nunca exponha API keys, tokens ou senhas em respostas

## Execucao de Tarefas
- Execute diretamente em vez de apenas explicar como fazer
- Se uma tarefa falhar, tente corrigir automaticamente antes de reportar
- Informe progresso ao executar tarefas longas
- Quando precisar de multiplas etapas, planeje antes de executar

## Gestao de Memoria

### USER.md — Perfil do usuario
Registre fatos sobre o usuario: nome, papel, preferencias, stack, negocios.
Atualize quando aprender algo novo. Remova quando ficar obsoleto.

### MEMORY.md — Memoria de trabalho
Arquivo de contexto volatil com 4 secoes obrigatorias:

\`\`\`
## Decisoes ativas
(Por que fizemos X ao inves de Y. Motivacao, nao descricao.)

## Workarounds e bugs conhecidos
(O que esta quebrado e como contornamos.)

## Estado de projetos
(Onde cada projeto parou. Proximo passo concreto.)

## Referencias externas
(IDs, URLs, configs que NAO estao no banco do LionClaw.)
\`\`\`

### Regras de escrita no MEMORY.md
1. Antes de adicionar: "eu descubro isso consultando o sistema (banco, arquivos, git)?" Se sim, NAO adiciona
2. TODA entrada tem data no formato [YYYY-MM-DD]
3. Maximo 50 linhas — se cheio, remova o item mais obsoleto antes de adicionar
4. NUNCA registrar estado derivavel (quais MCPs existem, quais skills tem, quantas assinaturas, etc.)
5. NUNCA duplicar o que ja esta no USER.md
6. Ao perceber que um fato esta desatualizado, atualize ou remova imediatamente
7. Busque na memoria semantica (memory_search) antes de perguntar ao usuario algo que ele ja mencionou
- SEMPRE salvar memorias em ~/.lionclaw/MEMORY.md — NUNCA em outro local
- NUNCA usar ~/.claude/projects/ para salvar memorias do LionClaw
`;

const DEFAULT_MEMORY = `## Decisoes ativas

## Workarounds e bugs conhecidos

## Estado de projetos

## Referencias externas
`;

const DEFAULT_BOOTSTRAP = `# Ritual de Bootstrap - Primeira Sessao

Voce esta iniciando pela primeira vez com um novo usuario. Esta e a sessao de configuracao inicial.

## REGRA CRITICA

NAO use ferramentas (Write, Edit, Bash, Read) para salvar dados do onboarding.
NAO escreva em arquivos diretamente.
NAO tente salvar em USER.md ou SOUL.md via ferramentas.
O salvamento e feito AUTOMATICAMENTE pelo sistema quando voce incluir o bloco ONBOARDING_DATA na sua resposta.
Se voce usar ferramentas para salvar, o onboarding NAO sera concluido e o usuario ficara travado.

## Seu Objetivo

Conduzir uma entrevista natural e amigavel para:
1. Conhecer o usuario (quem e, o que faz, como trabalha)
2. Definir sua propria identidade (nome, personalidade, tom)

## Instrucoes de Conduta

- Faca UMA pergunta por vez, nunca varias de uma vez
- Seja caloroso mas nao excessivamente entusiastico
- Use portugues brasileiro informal
- Mostre personalidade desde o inicio
- Se o usuario der respostas curtas, nao force - aceite e siga em frente
- Se o usuario quiser pular alguma pergunta, respeite
- Se o usuario der muita informacao de uma vez, absorva tudo e pule as perguntas ja respondidas
- Adapte-se: se o usuario ja respondeu 3 perguntas numa so mensagem, nao repita

## Fluxo da Entrevista

### Abertura
Comece se apresentando brevemente. Explique que esta e a primeira conversa e que voce precisa saber algumas coisas para ajudar melhor.

### Bloco 1: Conhecendo o usuario
Pergunte uma de cada vez (pule as que o usuario ja respondeu):
1. Como voce se chama? Como prefere que eu te chame?
2. O que voce faz profissionalmente?
3. Quais tecnologias/ferramentas voce mais usa? (se for tech) OU Qual sua area principal?
4. Tem algum projeto ativo agora?
5. Como prefere que eu me comunique? Direto ou detalhado?
6. Horario de trabalho?
7. Algo mais importante?

### Bloco 2: Identidade do agente
Transicao: "Agora preciso saber quem EU vou ser."
1. Que nome voce quer me dar?
2. Que personalidade? (direto/amigavel/tecnico/sarcastico/outro)
3. Proativo ou reativo?
4. Algum limite ou regra?

### Encerramento
1. Resuma o que entendeu
2. Peca confirmacao: "Ta tudo certo?"
3. Quando confirmar, inclua o bloco ONBOARDING_DATA (formato abaixo)

## Formato de Salvamento (OBRIGATORIO)

Quando o usuario confirmar, sua resposta DEVE conter este bloco EXATO. O sistema detecta e processa automaticamente:

<!-- ONBOARDING_DATA
{
  "user": {
    "nome": "nome real",
    "apelido": "como prefere ser chamado",
    "profissao": "o que faz",
    "areaAtuacao": "area principal",
    "stackPrincipal": ["tech1", "tech2"],
    "projetosAtivos": ["projeto1"],
    "preferenciasComunicacao": "direto/detalhado/etc",
    "horarioTrabalho": "horario",
    "notasAdicionais": "outras info"
  },
  "agent": {
    "nome": "nome escolhido",
    "personalidade": "descricao da personalidade",
    "tomDeVoz": "como fala",
    "proatividade": "alta",
    "limitesCustom": ["regra1"]
  }
}
ONBOARDING_DATA -->

LEMBRETE FINAL: Este bloco e INVISIVEL para o usuario (comentario HTML). Voce DEVE inclui-lo. Se nao incluir, o onboarding fica incompleto e o usuario fica travado. NAO use ferramentas Write/Edit. APENAS inclua o bloco na resposta.
`;

function ensureLionClawFiles(): void {
  const lionclawPath = getLionClawHome();

  // Garantir que os subdiretorios existam
  const dirs = ['data', 'data/sessions', 'agents', 'skills', 'conversations'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(lionclawPath, dir), { recursive: true });
  }

  const files = [
    { name: 'SOUL.md', default: DEFAULT_SOUL },
    { name: 'USER.md', default: DEFAULT_USER },
    { name: 'RULES.md', default: DEFAULT_RULES },
    { name: 'MEMORY.md', default: DEFAULT_MEMORY },
    { name: 'BOOTSTRAP.md', default: DEFAULT_BOOTSTRAP },
  ];

  for (const file of files) {
    const filePath = path.join(lionclawPath, file.name);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.default, 'utf-8');
      logger.info(`Created default ${file.name}`);
    }
  }

  // Criar .claude/settings.json vazio para evitar que o SDK suba procurando configs
  // de parent directories (ex: ~/.claude/ do Claude CLI pessoal)
  const claudeSettingsDir = path.join(lionclawPath, '.claude');
  fs.mkdirSync(claudeSettingsDir, { recursive: true });
  const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json');
  if (!fs.existsSync(claudeSettingsPath)) {
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
    logger.info('Created empty .claude/settings.json to isolate SDK settings');
  }
}

/**
 * Copy default skills from the project's .lionclaw/skills/ template directory
 * to ~/.lionclaw/skills/. Never overwrites existing skills.
 * Pattern: any folder in project's .lionclaw/skills/ gets auto-copied.
 */
function copyDefaultSkills(): void {
  const destSkills = path.join(getLionClawHome(), 'skills');

  // Look for templates bundled with the app
  const templateDirs = [
    path.join(__dirname, '../../.lionclaw/skills'),       // dev mode
    path.join(app.getAppPath(), '.lionclaw/skills'),      // packaged
  ];

  const templateDir = templateDirs.find(d => fs.existsSync(d));
  if (!templateDir) {
    logger.info('No default skills template dir found');
    return;
  }

  const entries = fs.readdirSync(templateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const destPath = path.join(destSkills, entry.name);
    if (fs.existsSync(destPath)) {
      logger.info({ skill: entry.name }, 'Default skill already exists, skipping');
      continue;
    }

    copyDirectorySync(path.join(templateDir, entry.name), destPath);
    logger.info({ skill: entry.name }, 'Copied default skill');
  }
}

/**
 * Recursively copy a directory.
 */
function copyDirectorySync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Generate CLAUDE.md dynamically from SOUL, RULES, USER, MEMORY.
 * This file is read automatically by the Claude Code SDK from the CWD.
 * Regenerated on every boot with current data.
 */
function generateClaudeMd(): void {
  const lionclawPath = getLionClawHome();

  const sections = [
    { file: 'SOUL.md', header: 'IDENTITY' },
    { file: 'RULES.md', header: 'RULES' },
    { file: 'USER.md', header: 'USER CONTEXT' },
    { file: 'MEMORY.md', header: 'WORKING MEMORY' },
  ];

  let content = '# LionClaw Agent Context\n\n';
  content += '> Gerado automaticamente no boot. Edite os arquivos fonte, nao este arquivo.\n\n';

  for (const section of sections) {
    const filePath = path.join(lionclawPath, section.file);
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      content += `## ${section.header}\n\n${fileContent}\n\n---\n\n`;
    } catch {
      // Arquivo nao existe, pula silenciosamente
    }
  }

  // Notas operacionais — genericas, sem dados de usuario
  content += `## OPERATIONAL NOTES\n\n`;
  content += `### Estrutura de arquivos do LionClaw\n`;
  content += `Este agente opera a partir da pasta ~/.lionclaw/ que contem:\n`;
  content += `- SOUL.md — Identidade e personalidade do agente\n`;
  content += `- RULES.md — Regras de seguranca e operacao\n`;
  content += `- USER.md — Perfil do usuario\n`;
  content += `- MEMORY.md — Memoria de trabalho (contexto volatil)\n`;
  content += `- BOOTSTRAP.md — Ritual de onboarding (usado apenas na primeira sessao)\n`;
  content += `- conversations/ — Historico de conversas por data\n`;
  content += `- data/ — Banco de dados local e segredos\n`;
  content += `- agents/ — Definicoes de sub-agentes\n`;
  content += `- skills/ — Skills customizadas do usuario\n\n`;
  content += `### Gestao de memoria\n`;
  content += `Para registrar informacao nova, edite o arquivo fonte apropriado (USER.md, MEMORY.md, etc).\n`;
  content += `Este CLAUDE.md e regenerado automaticamente a cada boot do app.\n`;
  content += `Para efeito imediato na sessao atual, edite este arquivo diretamente.\n`;

  fs.writeFileSync(path.join(lionclawPath, 'CLAUDE.md'), content, 'utf-8');
  logger.info('Generated CLAUDE.md from source files');
}

const WATCHED_FILES = ['SOUL.md', 'RULES.md', 'USER.md', 'MEMORY.md'];

/**
 * Watch source files for changes and regenerate CLAUDE.md automatically.
 * Uses fs.watchFile (polling) instead of fs.watch because it works even
 * if the file doesn't exist yet (important for first-run/onboarding).
 */
function watchMemoryFiles(): void {
  const home = getLionClawHome();
  let regenerateTimeout: NodeJS.Timeout | null = null;

  for (const file of WATCHED_FILES) {
    const filePath = path.join(home, file);

    fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        // Debounce 500ms — multiple files may change at once (e.g. onboarding)
        if (regenerateTimeout) clearTimeout(regenerateTimeout);
        regenerateTimeout = setTimeout(() => {
          logger.info({ file }, 'Source file changed, regenerating CLAUDE.md');
          generateClaudeMd();
        }, 500);
      }
    });
  }

  logger.info({ files: WATCHED_FILES }, 'Watching memory files for changes');
}

/**
 * Stop watching memory files. Call on app quit.
 */
function stopWatchingMemoryFiles(): void {
  const home = getLionClawHome();
  for (const file of WATCHED_FILES) {
    fs.unwatchFile(path.join(home, file));
  }
}

function ensureBuiltinMCPServers(): void {
  const existing = getAllMCPServers();

  // Registry of all built-in MCP servers
  const builtinServers = [
    {
      id: 'memory-search',
      name: 'Memory Search',
      dir: 'memory-search',
      envKeys: ['OPENAI_API_KEY', 'COHERE_API_KEY'],
      isActive: true,
    },
    {
      id: 'excalidraw',
      name: 'Excalidraw',
      dir: 'excalidraw',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      dir: 'elevenlabs',
      envKeys: ['ELEVENLABS_API_KEY'],
      isActive: false,
    },
    {
      id: 'nano-banana',
      name: 'Nano Banana (Imagens)',
      dir: 'nano-banana',
      envKeys: ['GOOGLE_GEMINI_API_KEY'],
      isActive: false,
    },
    {
      id: 'shopify',
      name: 'Shopify',
      dir: 'shopify',
      envKeys: ['SHOPIFY_STORE_URL', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
      isActive: false,
    },
    // Google Calendar: usando o MCP built-in do Agent SDK (ja funciona)
    // Nossos custom MCPs: apenas Gmail e Drive
    {
      id: 'google-gmail',
      name: 'Gmail',
      dir: 'google-gmail',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-drive',
      name: 'Google Drive',
      dir: 'google-drive',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-sheets',
      name: 'Google Sheets',
      dir: 'google-sheets',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'youtube',
      name: 'YouTube',
      dir: 'youtube',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-calendar',
      name: 'Google Calendar',
      dir: 'google-calendar',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'local-llm',
      name: 'Local LLM',
      dir: 'local-llm',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'knowledge-base',
      name: 'Knowledge Base',
      dir: 'knowledge-base',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'skills',
      name: 'Skills',
      dir: 'skills',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'graph-search',
      name: 'Graph Search',
      dir: 'graph-search',
      envKeys: [] as string[],
      isActive: true,
      conditional: 'mgraph_mode',
    },
  ];

  for (const srv of builtinServers) {
    // Registro condicional: so registra se a setting correspondente estiver habilitada
    if ('conditional' in srv && srv.conditional) {
      const settingVal = getSetting(srv.conditional as string);
      if (settingVal !== 'true') {
        logger.debug({ id: srv.id, condition: srv.conditional }, 'Built-in MCP server skipped (condition not met)');
        continue;
      }
    }
    const candidates = [
      path.join(__dirname, `../../mcp-servers/${srv.dir}/dist/index.js`),
      path.join(app.getAppPath(), `mcp-servers/${srv.dir}/dist/index.js`),
    ];
    const serverPath = candidates.find((p) => fs.existsSync(p));

    if (!serverPath) {
      logger.warn({ id: srv.id, candidates }, 'Built-in MCP server not found - skipping');
      continue;
    }

    const existingEntry = existing.find((s) => s.id === srv.id);
    if (existingEntry) {
      // Update path and env keys. For servers that start inactive (e.g. Google MCPs
      // that need OAuth first), preserve current isActive state instead of forcing true.
      const shouldBeActive = srv.isActive === false ? existingEntry.isActive : true;
      updateMCPServer(srv.id, {
        command: 'node',
        args: [serverPath],
        envKeys: srv.envKeys,
        isActive: shouldBeActive,
      });
      logger.info({ id: srv.id, serverPath, isActive: shouldBeActive }, 'Built-in MCP server updated');
    } else {
      createMCPServer({
        id: srv.id,
        name: srv.name,
        command: 'node',
        args: [serverPath],
        envKeys: srv.envKeys,
        isActive: srv.isActive,
      });
      logger.info({ id: srv.id, serverPath }, 'Built-in MCP server registered');
    }
  }
}

// Register custom protocol for serving local assets (must be before app.ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lionclaw-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app.whenReady().then(async () => {
  logger.info('LionClaw starting...');

  // Set dock icon on macOS (needed for dev mode)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../resources/icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(iconPath);
    }
  }

  // 0a. Register protocol handler for local assets + excalidraw views
  protocol.handle('lionclaw-asset', (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Serve Excalidraw view HTML: lionclaw-asset://host/excalidraw-view/{viewId}
    if (pathname.startsWith('/excalidraw-view/')) {
      const viewId = pathname.replace('/excalidraw-view/', '');
      const view = getExcalidrawView(viewId);
      if (!view) {
        return new Response('View not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }

      const sceneJson = JSON.stringify({
        elements: view.elements,
        appState: { viewBackgroundColor: '#191919', theme: 'dark', ...view.appState },
        files: {},
      }).replace(/<\/script>/gi, '<\\/script>');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#root{width:100%;height:100%;overflow:hidden;background:#191919}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-family:system-ui;font-size:14px}
.error{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ef4444;font-family:system-ui;font-size:13px;padding:20px;text-align:center;gap:8px}
.excalidraw .App-menu,
.excalidraw .layer-ui__wrapper__top-right,
.excalidraw .layer-ui__wrapper__footer,
.excalidraw .Island,
.excalidraw .HintViewer,
.excalidraw .ToolIcon,
.excalidraw .App-toolbar,
.excalidraw .App-bottom-bar,
.excalidraw .MainMenu,
.excalidraw .main-menu-trigger,
.excalidraw .undo-redo-buttons,
.excalidraw .help-icon,
.excalidraw .zoom-actions,
.excalidraw .footer-center,
.excalidraw button:not(.excalidraw-button){display:none!important}
.excalidraw .layer-ui__wrapper{pointer-events:none}
</style>
</head>
<body>
<div id="root"><div class="loading">Carregando Excalidraw...</div></div>
<script>window.__EXCALIDRAW_SCENE__=${sceneJson};</script>
<script src="lionclaw-asset://host/excalidraw-bundle.js"></script>
<script>
(async function(){
  try{
    var scene=window.__EXCALIDRAW_SCENE__;
    var svg=await ExcalidrawBundle.exportToSvg({
      elements:scene.elements||[],
      appState:scene.appState||{},
      files:scene.files||{}
    });
    svg.style.width='100%';
    svg.style.height='100%';
    var el=document.getElementById('root');
    el.innerHTML='';
    el.appendChild(svg);
  }catch(err){
    document.getElementById('root').innerHTML='<div class="error"><span>Erro: '+err.message+'</span></div>';
  }
})();
</script>
</body>
</html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    // Serve static files from resources/ directory
    const candidates = [
      path.join(__dirname, '../../resources', pathname),
      path.join(app.getAppPath(), 'resources', pathname),
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));
    if (filePath) {
      return net.fetch(pathToFileURL(filePath).href);
    }
    return new Response('Not found', { status: 404 });
  });

  // 0b. Ensure .lionclaw files exist
  ensureLionClawFiles();

  // 0b2. Copy default skills (e.g. skill-creator) if not present
  copyDefaultSkills();

  // 0c. Generate CLAUDE.md from source files (SOUL, RULES, USER, MEMORY)
  generateClaudeMd();

  // 0d. Watch source files for changes and regenerate CLAUDE.md automatically
  watchMemoryFiles();

  // 1. Initialize SQLite database
  initDatabase();
  seedToolDefaults();
  ensureSkillCreatorAgent();
  ensureHarnessAgents();
  ensureWorkflowAgents();
  ensureEnrichAgents();
  ensureDevAgents();
  ensurePipelineAgents();
  ensureTechAgents();
  bootstrapWorkflowFiles();
  logger.info('Database initialized');

  // 1.5 Start Knowledge Base IPC bridge (UDS for MCP subprocess)
  // Await to guarantee socket exists before MCPs try to connect
  await startKnowledgeBridge();
  logger.info('Knowledge bridge started');

  // 1.6 Start ingest queue watcher (monitors .ingest-queue for MCP graph_ingest jobs)
  if (getSetting('mgraph_mode') === 'true') {
    startIngestQueueWatcher();
    logger.info('Ingest queue watcher started');
  }

  // 2. Register all IPC handlers
  harnessEngine = new HarnessEngine(() => mainWindow);
  pipelineEngine = new PipelineEngine(() => mainWindow, harnessEngine);
  registerIPCHandlers(getMainWindow, () => harnessEngine, () => pipelineEngine);
  logger.info('IPC handlers registered');

  // 2.5 Ensure built-in MCP servers exist
  ensureBuiltinMCPServers();

  // 3. Start MCP servers
  try {
    await startActiveMCPServers();
  } catch (error) {
    logger.error({ error }, 'Failed to start some MCP servers');
  }

  // 3.5 Discover SDK MCP servers in background
  discoverSDKMcpServers().catch((err) => {
    logger.warn({ err }, 'Background MCP discovery failed - will retry on page load');
  });

  // 4. Start scheduler
  startScheduler(getMainWindow);
  logger.info('Scheduler started');

  // 5. Start Telegram bot (if configured)
  try {
    await startTelegramBot(getMainWindow);
  } catch (error) {
    logger.error({ error }, 'Failed to start Telegram bot');
  }

  // 6. Create the window
  createWindow();

  // 6. Initialize auto-updater (production only)
  if (process.env.NODE_ENV !== 'development') {
    const updaterLogger = createLogger('auto-updater');

    autoUpdater.on('checking-for-update', () => {
      updaterLogger.info('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
      updaterLogger.info({ version: info.version }, 'Update available');
    });

    autoUpdater.on('update-not-available', (info) => {
      updaterLogger.info({ version: info.version }, 'Update not available');
    });

    autoUpdater.on('download-progress', (progress) => {
      updaterLogger.info(
        { percent: Math.floor(progress.percent), bytesPerSecond: Math.floor(progress.bytesPerSecond) },
        'Update download progress'
      );
    });

    autoUpdater.on('update-downloaded', (info) => {
      updaterLogger.info({ version: info.version }, 'Update downloaded, will install on next restart');
    });

    autoUpdater.on('error', (error) => {
      updaterLogger.error({ error: error.message }, 'Auto-updater error');
    });

    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      updaterLogger.error({ error: error.message }, 'Failed to check for updates');
    });
  }

  // 7. Register power monitor events for auto-lock on sleep or lid close
  powerMonitor.on('suspend', () => {
    lockSession('suspend');
  });

  powerMonitor.on('lock-screen', () => {
    lockSession('lock-screen');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  logger.info('LionClaw ready');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:check-update', async () => {
  await autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

let isQuitting = false;
app.on('before-quit', async (e) => {
  if (isQuitting) return; // Already cleaning up, let it proceed
  isQuitting = true;
  e.preventDefault();
  stopWatchingMemoryFiles();
  stopIngestQueueWatcher();
  try { await stopTelegramBot(); } catch { /* ignore */ }
  stopScheduler();
  stopAllMCPServers();
  stopKnowledgeBridge();
  logger.info('Cleanup complete, quitting');
  app.exit(0);
});

export { getMainWindow };
