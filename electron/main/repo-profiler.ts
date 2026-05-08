/**
 * repo-profiler.ts
 *
 * Fase 1 do Security Audit Pipeline.
 *
 * Fluxo principal (deterministico, zero LLM): detecta linguagem via manifesto na raiz,
 * varre o file tree, classifica arquivos por role via regex de nome + conteudo, salva
 * manifest.json. Rapido e previsivel.
 *
 * Fallback LLM: quando a deteccao de linguagem/framework retorna 'unknown' (projeto
 * sem manifesto na raiz ou manifesto em formato incomum), um agente leve roda com
 * Glob/Read/Grep pra inferir a stack antes de gerar o manifest.
 *
 * Exporta: runRepoProfiler(), RepoManifest, PhaseCallbacks.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { createLogger } from './logger';
import { processAgentStream } from './stream-processor';

const logger = createLogger('repo-profiler');

// ---------------------------------------------------------------------------
// Tipos publicos
// ---------------------------------------------------------------------------

/**
 * Callbacks de streaming para fases do pipeline de seguranca.
 * Shape compativel com o padrao usado em pipeline-engine.ts (onText/onToolUse).
 */
export interface PhaseCallbacks {
  /** Emitido quando ha texto de progresso para exibir na UI. */
  onText?: (chunk: string) => void;
  /** Emitido quando uma acao relevante e executada (ex: nome de ferramenta). */
  onToolUse?: (toolName: string) => void;
  /** Emitido ao final da fase, sinalizando conclusao. */
  onDone?: () => void;
}

/**
 * Resultado estruturado da fase 1 (Repo Profiler).
 * Salvo em {projectPath}/.lionclaw/manifest.json.
 */
export interface RepoManifest {
  /** Caminho absoluto do projeto auditado. */
  projectPath: string;
  /** Linguagem principal detectada. */
  language: string;
  /** Framework detectado. */
  framework: string;
  /** Timestamp ISO da varredura. */
  scannedAt: string;
  /** Total de arquivos encontrados (incluindo skippados por tamanho). */
  totalFiles: number;
  /** Arquivos que receberam ao menos uma role. */
  classifiedFiles: number;
  /** Diretorios que foram ignorados durante a varredura. */
  ignoredDirs: string[];
  /** Mapa de role -> array de caminhos relativos ao projectPath. */
  filesByRole: Record<string, string[]>;
  /** Path absoluto do SecurityScan-*.json mais recente, ou null. */
  previousScan: string | null;
  /** Arquivos ignorados por excederem o limite de tamanho configurado. */
  skippedLargeFiles?: Array<{ path: string; sizeBytes: number }>;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'target',
  'coverage',
  '.lionclaw',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp',
  '.ico', '.svg', '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz',
  '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mp3', '.wav', '.ogg', '.avi', '.mov', '.mkv',
  '.so', '.dll', '.exe', '.wasm', '.dylib', '.a', '.lib',
  '.class', '.jar', '.pyc', '.pyo',
]);

/** Limite default de tamanho de arquivo para leitura de conteudo (5 MB). */
const DEFAULT_MAX_FILE_SIZE_BYTES = 5_242_880;

let MAX_FILE_SIZE_BYTES = DEFAULT_MAX_FILE_SIZE_BYTES;

/**
 * Permite configurar o limite de tamanho de arquivo lido pelo profiler.
 * Util para testes ou ambientes com restricoes de memoria.
 */
export function setRepoProfilerMaxFileSize(bytes: number): void {
  MAX_FILE_SIZE_BYTES = bytes;
}

/** Limite maximo de arquivos escaneados antes de emitir warning e continuar. */
const MAX_FILES_SCANNED = 10_000;

/** Roles disponiveis. */
const ALL_ROLES = [
  'auth', 'query', 'crypto', 'route', 'middleware',
  'template', 'async', 'error-handling', 'config', 'migration',
] as const;

export type Role = typeof ALL_ROLES[number];

// ---------------------------------------------------------------------------
// Patterns de classificacao por role
// ---------------------------------------------------------------------------

/**
 * Patterns baseados em conteudo (lidos do arquivo).
 * Strings sao testadas case-insensitive contra o conteudo do arquivo.
 */
const CONTENT_ROLE_PATTERNS: Record<Exclude<Role, 'config' | 'migration'>, string[]> = {
  auth: [
    'session', 'token', 'authenticate', 'passport',
    'jwt.verify', 'jwt.sign', 'login', 'bcrypt', 'argon2',
  ],
  query: [
    'SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ',
    '.query(', '.execute(', 'prepare(', 'findOne', 'findMany', 'where(',
    'prisma.', 'knex', 'sequelize',
  ],
  crypto: [
    'crypto.', 'createHash', 'createCipher', 'encrypt', 'decrypt',
    'randomBytes', 'pbkdf2', 'scrypt', 'bcrypt', 'argon2', 'hashlib',
  ],
  route: [
    'router.', 'app.get(', 'app.post(', 'app.put(', 'app.delete(',
    '@Get(', '@Post(', '@Route', 'Route.', '@app.get', 'controller',
  ],
  middleware: [
    'middleware', 'next()', 'req,', 'req.headers', 'cors(', 'helmet(',
    'interceptor', 'guard', '@UseGuards',
  ],
  template: [
    '.erb', '.ejs', '.pug', '.hbs', '.mustache',
    'innerHTML', 'dangerouslySetInnerHTML', 'v-html', '{{{',
    '<%', '{{',
  ],
  async: [
    'setTimeout', 'setInterval', 'async ', 'await ', 'Promise.',
    '.then(', 'queueMicrotask',
  ],
  'error-handling': [
    'try {', 'catch (', 'throw new', 'Error(', '.catch(', 'onerror',
    'catch(',
  ],
};

/**
 * Numero minimo de ocorrencias de patterns para que uma role seja atribuida.
 * Reduz falsos positivos em roles que aparecem naturalmente em qualquer arquivo.
 */
export const ROLE_MIN_HITS: Record<Role, number> = {
  auth: 2,
  query: 1,
  crypto: 2,
  route: 2,
  middleware: 2,
  template: 1,
  async: 5,
  'error-handling': 3,
  config: 1,
  migration: 1,
};

/**
 * Hints baseados em caminho do arquivo que aumentam a contagem de uma role.
 * Permite que arquivos em pastas canonicas sejam classificados mesmo com
 * pouco conteudo caracteristico.
 */
export const PATH_HINTS: Array<{ regex: RegExp; role: Role; boost: number }> = [
  { regex: /(\/|^)auth(\/|s\/)/i, role: 'auth', boost: 5 },
  { regex: /(\/|^)migrations?(\/)/i, role: 'migration', boost: 10 },
  { regex: /(\/|^)middlewares?(\/)/i, role: 'middleware', boost: 5 },
  { regex: /(\/|^)(routes?|controllers?|handlers?)(\/)/i, role: 'route', boost: 5 },
  { regex: /(\/|^)(crypto|security)(\/)/i, role: 'crypto', boost: 5 },
];

/**
 * Remove comentarios de linha, comentarios de bloco e literais de string do
 * conteudo antes de contar ocorrencias de patterns.
 * Evita falsos positivos causados por strings em comentarios ou textos.
 */
export function stripCommentsAndStrings(content: string): string {
  return content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Metadados descritivos de cada role, exportados para uso na UI e em relatorios.
 */
export const ROLE_METADATA: Record<Role, {
  label: string;
  description: string;
  threshold: number;
  samplePatterns: string[];
}> = {
  auth: {
    label: 'Auth',
    description: 'Arquivos com logica de autenticacao',
    threshold: ROLE_MIN_HITS.auth,
    samplePatterns: ['session', 'token', 'jwt.verify', 'bcrypt'],
  },
  query: {
    label: 'Query',
    description: 'Arquivos com queries de banco',
    threshold: ROLE_MIN_HITS.query,
    samplePatterns: ['SELECT', '.query(', 'prisma.', 'findOne'],
  },
  crypto: {
    label: 'Crypto',
    description: 'Arquivos com operacoes criptograficas',
    threshold: ROLE_MIN_HITS.crypto,
    samplePatterns: ['crypto.', 'createHash', 'encrypt', 'pbkdf2'],
  },
  route: {
    label: 'Route',
    description: 'Arquivos de rotas/handlers HTTP',
    threshold: ROLE_MIN_HITS.route,
    samplePatterns: ['router.', 'app.get(', '@Get(', '@Post('],
  },
  middleware: {
    label: 'Middleware',
    description: 'Arquivos com middlewares ou interceptors',
    threshold: ROLE_MIN_HITS.middleware,
    samplePatterns: ['middleware', 'next()', 'cors(', 'helmet('],
  },
  template: {
    label: 'Template',
    description: 'Arquivos de template/render HTML',
    threshold: ROLE_MIN_HITS.template,
    samplePatterns: ['innerHTML', 'dangerouslySetInnerHTML', '<%', '{{'],
  },
  async: {
    label: 'Async',
    description: 'Arquivos com codigo assincrono pesado',
    threshold: ROLE_MIN_HITS.async,
    samplePatterns: ['async', 'await', 'Promise.', 'setTimeout'],
  },
  'error-handling': {
    label: 'Error Handling',
    description: 'Arquivos com try/catch ou throw. NAO significa arquivos com bugs.',
    threshold: ROLE_MIN_HITS['error-handling'],
    samplePatterns: ['try {', 'catch (', 'throw new', 'Error('],
  },
  config: {
    label: 'Config',
    description: 'Arquivos de configuracao (env, config, settings)',
    threshold: ROLE_MIN_HITS.config,
    samplePatterns: ['.env', 'config.json', 'settings.json'],
  },
  migration: {
    label: 'Migration',
    description: 'Arquivos de migration de banco',
    threshold: ROLE_MIN_HITS.migration,
    samplePatterns: ['migrations/', 'CREATE TABLE', 'ALTER TABLE'],
  },
};

/**
 * Patterns de arquivos que NUNCA devem ser enviados aos agentes de auditoria.
 * Exportado para uso em security-audit-runner.ts e permission-guard.ts.
 *
 * Regra: arquivos .env* existem para guardar secrets localmente — isso e esperado.
 * O finding valido sobre .env e apenas: (a) arquivo commitado ao git, ou
 * (b) .env* ausente do .gitignore. O conteudo em si nao e finding.
 */
export const EXCLUDED_FROM_AUDIT_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i,
  /\.env\.(local|production|development|test|staging|example|sample)$/i,
];

/**
 * Patterns de nome de arquivo para a role 'config'.
 * Testados case-insensitive contra o basename do arquivo.
 * Nota: .env* foi removido da role 'config' — esses arquivos entram em
 * EXCLUDED_FROM_AUDIT_PATTERNS e nao sao enviados para nenhum agente.
 */
const CONFIG_NAME_PATTERNS = [
  /^config\./i,
  /^settings\./i,
  /^credentials\./i,
  /^secrets\./i,
  /\.config\.(js|ts|mjs|cjs)$/i,
  /^(docker-compose|docker\.compose)\.(yml|yaml)$/i,
  /^(\.gitlab-ci|\.travis|circle\.ci)\.(yml|yaml)$/i,
];

// ---------------------------------------------------------------------------
// Deteccao de linguagem/framework
// ---------------------------------------------------------------------------

interface LangFramework {
  language: string;
  framework: string;
}

function detectLanguageFramework(projectPath: string): LangFramework {
  // --- package.json (Node / TypeScript / JavaScript) ---
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    let language = 'javascript';

    // Se existe tsconfig.json, prefere typescript
    if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
      language = 'typescript';
    }

    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      const depNames = Object.keys(allDeps);

      let framework = 'node';

      if (depNames.includes('next')) {
        framework = 'next';
      } else if (depNames.includes('@nestjs/core')) {
        framework = 'nest';
      } else if (depNames.includes('express')) {
        framework = 'express';
      } else if (depNames.includes('fastify')) {
        framework = 'fastify';
      } else if (depNames.includes('react')) {
        framework = 'react';
      } else if (depNames.includes('vue')) {
        framework = 'vue';
      } else if (depNames.includes('svelte')) {
        framework = 'svelte';
      }

      return { language, framework };
    } catch (err) {
      logger.warn({ err, packageJsonPath }, 'Falha ao parsear package.json');
      return { language, framework: 'node' };
    }
  }

  // --- Gemfile (Ruby / Rails) ---
  const gemfilePath = path.join(projectPath, 'Gemfile');
  if (fs.existsSync(gemfilePath)) {
    try {
      const content = fs.readFileSync(gemfilePath, 'utf-8');
      const framework = content.toLowerCase().includes('rails') ? 'rails' : 'unknown';
      return { language: 'ruby', framework };
    } catch {
      return { language: 'ruby', framework: 'unknown' };
    }
  }

  // --- go.mod (Go) ---
  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf-8').toLowerCase();
      let framework = 'unknown';
      if (content.includes('gin-gonic/gin') || content.includes('"gin"')) {
        framework = 'gin';
      } else if (content.includes('labstack/echo')) {
        framework = 'echo';
      } else if (content.includes('gofiber/fiber')) {
        framework = 'fiber';
      }
      return { language: 'go', framework };
    } catch {
      return { language: 'go', framework: 'unknown' };
    }
  }

  // --- requirements.txt / pyproject.toml (Python) ---
  const requirementsTxtPath = path.join(projectPath, 'requirements.txt');
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(requirementsTxtPath) || fs.existsSync(pyprojectPath)) {
    let content = '';
    try {
      if (fs.existsSync(requirementsTxtPath)) {
        content += fs.readFileSync(requirementsTxtPath, 'utf-8').toLowerCase();
      }
      if (fs.existsSync(pyprojectPath)) {
        content += fs.readFileSync(pyprojectPath, 'utf-8').toLowerCase();
      }
    } catch {
      // ignora erros de leitura, usa o que tiver
    }

    let framework = 'unknown';
    if (content.includes('django')) {
      framework = 'django';
    } else if (content.includes('fastapi')) {
      framework = 'fastapi';
    } else if (content.includes('flask')) {
      framework = 'flask';
    }
    return { language: 'python', framework };
  }

  // --- Cargo.toml (Rust) ---
  const cargoPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf-8').toLowerCase();
      let framework = 'unknown';
      if (content.includes('actix-web')) {
        framework = 'actix-web';
      } else if (content.includes('rocket')) {
        framework = 'rocket';
      } else if (content.includes('axum')) {
        framework = 'axum';
      }
      return { language: 'rust', framework };
    } catch {
      return { language: 'rust', framework: 'unknown' };
    }
  }

  // --- pom.xml / build.gradle (Java) ---
  const pomPath = path.join(projectPath, 'pom.xml');
  const gradlePath = path.join(projectPath, 'build.gradle');
  const gradleKtsPath = path.join(projectPath, 'build.gradle.kts');
  if (fs.existsSync(pomPath) || fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath)) {
    let content = '';
    try {
      if (fs.existsSync(pomPath)) content += fs.readFileSync(pomPath, 'utf-8').toLowerCase();
      if (fs.existsSync(gradlePath)) content += fs.readFileSync(gradlePath, 'utf-8').toLowerCase();
      if (fs.existsSync(gradleKtsPath)) content += fs.readFileSync(gradleKtsPath, 'utf-8').toLowerCase();
    } catch {
      // ignora
    }
    const framework = content.includes('spring-boot') || content.includes('spring.boot')
      ? 'spring-boot'
      : 'unknown';
    return { language: 'java', framework };
  }

  return { language: 'unknown', framework: 'unknown' };
}

// ---------------------------------------------------------------------------
// Classificacao por role
// ---------------------------------------------------------------------------

/**
 * Verifica se o arquivo deve receber a role 'config' com base no nome.
 */
function isConfigFile(basename: string): boolean {
  return CONFIG_NAME_PATTERNS.some((re) => re.test(basename));
}

/**
 * Verifica se o arquivo deve receber a role 'migration' com base no caminho
 * e no conteudo (se disponivel).
 */
function isMigrationFile(relativePath: string, content: string | null): boolean {
  const lowerPath = relativePath.toLowerCase();
  const inMigrationFolder =
    lowerPath.includes('/migration') || lowerPath.includes('/migrate');

  if (!inMigrationFolder) return false;
  if (content === null) return false;

  const upperContent = content.toUpperCase();
  return (
    upperContent.includes('CREATE TABLE') ||
    upperContent.includes('ALTER TABLE') ||
    upperContent.includes('DROP TABLE')
  );
}

/**
 * Classifica um arquivo por roles baseadas em conteudo, threshold e path hints.
 * Retorna array de roles detectadas (pode ser vazio).
 */
export function classifyByContent(
  relativePath: string,
  basename: string,
  content: string | null,
): Role[] {
  const roles = new Set<Role>();

  // Config: classificacao por nome (sem precisar de conteudo)
  if (isConfigFile(basename)) {
    roles.add('config');
  }

  // Migration: classificacao por pasta + conteudo
  if (content !== null && isMigrationFile(relativePath, content)) {
    roles.add('migration');
  }

  // Pre-processar conteudo removendo comentarios e strings
  const stripped = content !== null ? stripCommentsAndStrings(content).toLowerCase() : '';

  // Calcular hits por role via contagem de ocorrencias + path hints
  const hits: Partial<Record<Role, number>> = {};
  for (const role of ALL_ROLES) {
    if (role === 'config' || role === 'migration') continue;

    const patterns = CONTENT_ROLE_PATTERNS[role as Exclude<Role, 'config' | 'migration'>];
    let count = 0;

    if (content !== null) {
      for (const p of patterns) {
        const lp = p.toLowerCase();
        count += stripped.split(lp).length - 1;
      }
    }

    // Aplicar boost de path hints
    for (const hint of PATH_HINTS) {
      if (hint.role === role && hint.regex.test(relativePath)) {
        count += hint.boost;
      }
    }

    hits[role] = count;
  }

  // Aplicar threshold: apenas adiciona a role se atingir o minimo de hits
  for (const role of ALL_ROLES) {
    if (role === 'config' || role === 'migration') continue;
    if ((hits[role] ?? 0) >= ROLE_MIN_HITS[role]) {
      roles.add(role);
    }
  }

  return Array.from(roles);
}

// ---------------------------------------------------------------------------
// Varredura recursiva de arquivos
// ---------------------------------------------------------------------------

interface ScanResult {
  totalFiles: number;
  classifiedFiles: number;
  ignoredDirsFound: string[];
  filesByRole: Record<Role, string[]>;
  skippedLargeFiles: Array<{ path: string; sizeBytes: number }>;
}

function scanDirectory(
  projectPath: string,
  callbacks: PhaseCallbacks,
): ScanResult {
  const filesByRole: Record<Role, string[]> = {
    auth: [],
    query: [],
    crypto: [],
    route: [],
    middleware: [],
    template: [],
    async: [],
    'error-handling': [],
    config: [],
    migration: [],
  };

  const skippedLargeFiles: Array<{ path: string; sizeBytes: number }> = [];

  const ignoredDirsFound = new Set<string>();
  let totalFiles = 0;
  let classifiedFiles = 0;
  let hitLimit = false;

  function walk(dirPath: string): void {
    if (hitLimit) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      logger.warn({ err, dirPath }, 'Nao foi possivel ler diretorio, ignorando');
      return;
    }

    for (const entry of entries) {
      if (hitLimit) break;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          ignoredDirsFound.add(entry.name);
          continue;
        }
        walk(path.join(dirPath, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      // Limite de arquivos
      if (totalFiles >= MAX_FILES_SCANNED) {
        if (!hitLimit) {
          hitLimit = true;
          logger.warn({ limit: MAX_FILES_SCANNED }, 'Limite de arquivos atingido, varredura truncada');
          callbacks.onText?.(`Aviso: limite de ${MAX_FILES_SCANNED} arquivos atingido, varredura truncada`);
        }
        break;
      }

      totalFiles++;

      const filePath = path.join(dirPath, entry.name);
      const relativePath = path.relative(projectPath, filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const basename = entry.name;

      // Skip .env* files — eles nao devem entrar em nenhuma role nem ser
      // enviados para agentes de auditoria (ver EXCLUDED_FROM_AUDIT_PATTERNS).
      if (EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename))) {
        continue;
      }

      // Skip binarios por extensao
      if (BINARY_EXTENSIONS.has(ext)) {
        // Conta em totalFiles mas nao classifica
        continue;
      }

      // Verificar tamanho do arquivo
      let content: string | null = null;
      let fileStat: fs.Stats | null = null;
      try {
        fileStat = fs.statSync(filePath);
      } catch (err) {
        logger.warn({ err, filePath }, 'Nao foi possivel ler stat do arquivo');
      }

      if (fileStat && fileStat.size <= MAX_FILE_SIZE_BYTES) {
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          // Arquivo pode ser binario sem extensao reconhecida - skip de conteudo
          content = null;
        }
      } else if (fileStat && fileStat.size > MAX_FILE_SIZE_BYTES) {
        // Arquivo grande: conta em totalFiles mas skip de conteudo
        logger.debug({ filePath, size: fileStat.size }, 'Arquivo maior que limite, skip de conteudo');
        skippedLargeFiles.push({ path: relativePath, sizeBytes: fileStat.size });
      }

      // Classificar
      const roles = classifyByContent(relativePath, basename, content);

      if (roles.length > 0) {
        classifiedFiles++;
        for (const role of roles) {
          filesByRole[role].push(relativePath);
        }
      }
    }
  }

  walk(projectPath);

  return {
    totalFiles,
    classifiedFiles,
    ignoredDirsFound: Array.from(ignoredDirsFound),
    filesByRole,
    skippedLargeFiles,
  };
}

// ---------------------------------------------------------------------------
// Deteccao de scan anterior
// ---------------------------------------------------------------------------

/**
 * Busca o SecurityScan-*.json mais recente em {projectPath}/.lionclaw/Security/.
 * Retorna o path absoluto ou null.
 */
function findPreviousScan(projectPath: string): string | null {
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');

  if (!fs.existsSync(securityDir)) {
    return null;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(securityDir);
  } catch (err) {
    logger.warn({ err, securityDir }, 'Nao foi possivel ler pasta Security');
    return null;
  }

  const scanFiles = entries
    .filter((name) => /^SecurityScan-.+\.json$/i.test(name))
    .sort(); // ordem lexicografica funciona pois nomes sao YYYYMMDD-HHmm

  if (scanFiles.length === 0) return null;

  const latest = scanFiles[scanFiles.length - 1];
  return path.join(securityDir, latest);
}

// ---------------------------------------------------------------------------
// Fallback LLM para deteccao de stack
// ---------------------------------------------------------------------------

/** Resolve o path para o executavel do Claude Code SDK. */
function getClaudeCodeExecutablePath(): string {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return path.join(path.dirname(sdkEntry), 'cli.js');
  } catch {
    const projectRoot = path.join(__dirname, '..', '..');
    return path.join(
      projectRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'cli.js',
    );
  }
}

const STACK_DETECTION_SYSTEM_PROMPT = `Voce e um detector de stack tecnico para auditoria de seguranca.

Objetivo: dado o caminho de um projeto, identificar a LINGUAGEM principal e o FRAMEWORK em uso usando Glob, Grep e Read.

Regras:
- Use Glob pra ver a distribuicao de extensoes e identificar manifests (package.json, Cargo.toml, go.mod, requirements.txt, Gemfile, composer.json, pom.xml, build.gradle, mix.exs, pyproject.toml).
- Se o manifesto existe, prefira a informacao dele (imports/deps).
- Se nao existe manifesto, use a extensao dominante e palavras-chave em imports (ex: "from django" => django; "FastAPI(" => fastapi).
- Reporte framework em uso REAL (imports, deps ativas), nao o que poderia estar.
- Responda APENAS com um bloco JSON no ultimo turno, sem texto antes ou depois:

\`\`\`json
{"language": "python", "framework": "fastapi"}
\`\`\`

Valores validos para language: typescript, javascript, python, ruby, go, rust, java, kotlin, php, csharp, swift, elixir, scala, unknown.
Valores validos para framework: string curta lowercase (fastapi, django, flask, nextjs, express, rails, spring-boot, gin, axum, ...) ou "unknown".`;

/**
 * Fallback assincrono: chama um agente Claude Haiku pra inspecionar o repo
 * com Glob/Read/Grep e inferir a stack quando a deteccao deterministica falha.
 *
 * Usa maxTurns=8 e timeout implicito via SDK. Em caso de erro ou resposta
 * invalida, retorna o resultado atual sem sobrescrever.
 */
async function detectStackWithAgent(
  projectPath: string,
  current: LangFramework,
): Promise<LangFramework> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const cliPath = getClaudeCodeExecutablePath();

    const prompt = `Analise o projeto em ${projectPath} e identifique language + framework.`;

    /**
     * EXCECAO D6 (SPEC-refactor-pipelines.md linhas 241-257):
     * Repo profiler usa query() direto em vez de executeAgent porque é um
     * utilitário rápido e isolado, sem precisar dos contratos do executor
     * unificado (watchdog, métricas estruturadas, runtime dispatch).
     *
     * NÃO migrar para executeAgent.
     */
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        cwd: projectPath,
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: STACK_DETECTION_SYSTEM_PROMPT,
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        maxTurns: 8,
        thinking: { type: 'disabled' as const },
      },
    }) as unknown as AsyncIterable<Record<string, unknown>>;

    const { output } = await processAgentStream(q, {
      shouldAbort: () => false,
    });

    // Extrai bloco JSON do output. Aceita cercado por ```json ... ``` ou inline.
    const fenced = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const rawJson = fenced?.[1] ?? output.match(/\{[^{}]*"language"[^{}]*\}/)?.[0];
    if (!rawJson) {
      logger.warn({ projectPath, outputPreview: output.slice(0, 200) }, 'Stack detection agent: no JSON in output');
      return current;
    }

    const parsed = JSON.parse(rawJson) as { language?: unknown; framework?: unknown };
    const lang = typeof parsed.language === 'string' && parsed.language.trim() ? parsed.language.trim() : current.language;
    const fw = typeof parsed.framework === 'string' && parsed.framework.trim() ? parsed.framework.trim() : current.framework;

    logger.info({ projectPath, detected: { language: lang, framework: fw } }, 'Stack detection agent: success');
    return { language: lang, framework: fw };
  } catch (err) {
    logger.warn({ err, projectPath }, 'Stack detection agent: failed; keeping deterministic result');
    return current;
  }
}

// ---------------------------------------------------------------------------
// Funcao principal
// ---------------------------------------------------------------------------

/**
 * Executa o Repo Profiler (fase 1 do Security Audit Pipeline).
 *
 * Fluxo principal deterministico: detecta stack via manifesto, varre, classifica.
 * Fallback LLM: se a deteccao nao encontrar linguagem ou framework, um agente
 * leve inspeciona o repo pra inferir a stack antes de salvar o manifest.
 *
 * @param projectPath - Caminho absoluto do repositorio a auditar.
 * @param callbacks   - Callbacks de streaming para progresso na UI.
 * @returns RepoManifest com resultado completo da analise.
 */
export async function runRepoProfiler(
  projectPath: string,
  callbacks: PhaseCallbacks,
): Promise<RepoManifest> {
  logger.info({ projectPath }, 'Iniciando Repo Profiler');

  // --- 1. Detectar linguagem/framework ---
  callbacks.onText?.('Detectando linguagem e framework...');

  let { language, framework } = detectLanguageFramework(projectPath);

  // Fallback LLM quando a deteccao deterministica retorna unknown.
  if (language === 'unknown' || framework === 'unknown') {
    callbacks.onText?.('Manifesto nao identificado; consultando agente de deteccao...');
    logger.info({ projectPath, pre: { language, framework } }, 'Invoking LLM fallback for stack detection');
    const detected = await detectStackWithAgent(projectPath, { language, framework });
    language = detected.language;
    framework = detected.framework;
  }

  const langLabel = language.charAt(0).toUpperCase() + language.slice(1);
  const fwLabel = framework !== 'unknown' ? ` + ${framework.charAt(0).toUpperCase() + framework.slice(1)}` : '';
  callbacks.onText?.(`Detectado: ${langLabel}${fwLabel}`);
  logger.info({ language, framework }, 'Linguagem/framework detectados');

  // --- 2. Criar pasta .lionclaw/Security/ no projeto ---
  const lionclawDir = path.join(projectPath, '.lionclaw');
  const securityDir = path.join(lionclawDir, 'Security');
  try {
    fs.mkdirSync(securityDir, { recursive: true });
  } catch (err) {
    logger.warn({ err, securityDir }, 'Nao foi possivel criar pasta Security');
  }

  // --- 3. Checar scan anterior (antes de sobrescrever com novo manifest) ---
  const previousScan = findPreviousScan(projectPath);
  if (previousScan) {
    logger.info({ previousScan }, 'Scan anterior encontrado');
    callbacks.onText?.(`Scan anterior encontrado: ${path.basename(previousScan)}`);
  }

  // --- 4. Varredura recursiva e classificacao ---
  callbacks.onText?.('Classificando arquivos...');

  const scanResult = scanDirectory(projectPath, callbacks);

  const {
    totalFiles,
    classifiedFiles,
    ignoredDirsFound,
    filesByRole,
    skippedLargeFiles,
  } = scanResult;

  logger.info(
    { totalFiles, classifiedFiles, ignoredDirs: ignoredDirsFound },
    'Varredura concluida',
  );

  // --- 5. Montar manifest ---
  const manifest: RepoManifest = {
    projectPath,
    language,
    framework,
    scannedAt: new Date().toISOString(),
    totalFiles,
    classifiedFiles,
    ignoredDirs: ignoredDirsFound,
    filesByRole: filesByRole as Record<string, string[]>,
    previousScan,
    skippedLargeFiles,
  };

  // --- 6. Salvar manifest.json ---
  const manifestPath = path.join(lionclawDir, 'manifest.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info({ manifestPath }, 'manifest.json salvo');
  } catch (err) {
    logger.error({ err, manifestPath }, 'Falha ao salvar manifest.json');
    throw err;
  }

  // --- 7. Emitir stats finais e done ---
  callbacks.onText?.(`${totalFiles} arquivos, ${classifiedFiles} classificados`);

  callbacks.onDone?.();

  logger.info({ projectPath, totalFiles, classifiedFiles }, 'Repo Profiler concluido');

  return manifest;
}
