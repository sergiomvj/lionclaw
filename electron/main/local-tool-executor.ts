import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('local-tool-executor');

const BASH_TIMEOUT_MS = 30_000;

// Termos perigosos bloqueados no Bash
const BASH_BLOCKED_TERMS = [
  'rm -rf',
  'rm -r',
  'sudo',
  'mkfs',
  'dd if=',
  ':(){',
  'chmod -R 777',
  '> /dev/sd',
] as const;

export interface LocalToolResult {
  result: string;
  isError: boolean;
}

type ToolImpl = (args: Record<string, unknown>, cwd: string) => Promise<LocalToolResult>;

// ---- Implementacoes individuais ----

async function execRead(args: Record<string, unknown>): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  if (!filePath) {
    return { result: 'Error: file_path e obrigatorio', isError: true };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : lines.length;
    const sliced = lines.slice(offset, offset + limit).join('\n');
    return { result: sliced, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Read tool failed');
    return { result: `Error ao ler arquivo: ${msg}`, isError: true };
  }
}

async function execWrite(args: Record<string, unknown>): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  const content = args.content as string | undefined;

  if (!filePath || content === undefined) {
    return { result: 'Error: file_path e content sao obrigatorios', isError: true };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { result: `Arquivo escrito com sucesso: ${filePath}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Write tool failed');
    return { result: `Error ao escrever arquivo: ${msg}`, isError: true };
  }
}

async function execEdit(args: Record<string, unknown>): Promise<LocalToolResult> {
  const filePath = args.file_path as string | undefined;
  const oldString = args.old_string as string | undefined;
  const newString = args.new_string as string | undefined;

  if (!filePath || !oldString) {
    return { result: 'Error: file_path e old_string sao obrigatorios', isError: true };
  }

  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldString)) {
      return { result: 'Error: old_string nao encontrado no arquivo', isError: true };
    }
    content = content.replace(oldString, newString ?? '');
    fs.writeFileSync(filePath, content, 'utf-8');
    return { result: `Arquivo editado com sucesso: ${filePath}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err }, 'Edit tool failed');
    return { result: `Error ao editar arquivo: ${msg}`, isError: true };
  }
}

async function execGlob(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const pattern = args.pattern as string | undefined;
  if (!pattern) {
    return { result: 'Error: pattern e obrigatorio', isError: true };
  }

  const basePath = (args.path as string | undefined) || cwd;

  try {
    // Usa find pra suportar patterns basicos. Para patterns mais avancados (ex: **/*.ts),
    // convertemos para uma busca por extensao quando possivel.
    const ext = pattern.match(/\*\*\/\*(\.\w+)$/)?.[1];
    let cmd: string;

    if (ext) {
      cmd = `find "${basePath}" -type f -name "*${ext}" 2>/dev/null | head -100`;
    } else {
      // Pattern simples: normaliza ** para * e usa find
      const normalized = pattern.replace(/\*\*/g, '*');
      cmd = `find "${basePath}" -type f -name "${normalized}" 2>/dev/null | head -100`;
    }

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 });
    const trimmed = output.trim();
    return { result: trimmed || 'Nenhum arquivo encontrado.', isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ pattern, basePath, err }, 'Glob tool failed');
    return { result: `Error ao buscar arquivos: ${msg}`, isError: true };
  }
}

async function execGrep(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const pattern = args.pattern as string | undefined;
  if (!pattern) {
    return { result: 'Error: pattern e obrigatorio', isError: true };
  }

  const searchPath = (args.path as string | undefined) || cwd;
  const glob = args.glob as string | undefined;

  try {
    // Escapa aspas duplas no pattern para evitar injecao de shell
    const safePattern = pattern.replace(/"/g, '\\"');
    let cmd = `grep -rn "${safePattern}" "${searchPath}"`;
    if (glob) cmd += ` --include="${glob}"`;
    cmd += ' 2>/dev/null | head -50';

    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 });
    const trimmed = output.trim();
    return { result: trimmed || 'Nenhum resultado encontrado.', isError: false };
  } catch (err) {
    // grep retorna exit code 1 quando nao encontra nada, nao e um erro real
    const exitCode = (err as { status?: number }).status;
    if (exitCode === 1) {
      return { result: 'Nenhum resultado encontrado.', isError: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ pattern, searchPath, err }, 'Grep tool failed');
    return { result: `Error ao buscar conteudo: ${msg}`, isError: true };
  }
}

async function execBash(args: Record<string, unknown>, cwd: string): Promise<LocalToolResult> {
  const command = args.command as string | undefined;
  if (!command) {
    return { result: 'Error: command e obrigatorio', isError: true };
  }

  const timeout = typeof args.timeout === 'number' ? args.timeout : BASH_TIMEOUT_MS;

  const blockedTerm = BASH_BLOCKED_TERMS.find((term) => command.includes(term));
  if (blockedTerm) {
    logger.warn({ command, blockedTerm }, 'Bash command blocked by safety filter');
    return {
      result: `BLOCKED: comando contem termo proibido '${blockedTerm}'. Use alternativas seguras.`,
      isError: true,
    };
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout,
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { result: output || '(sem output)', isError: false };
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message?: string; status?: number };
    // Mesmo com erro, retorna o stderr/stdout para que o modelo possa reagir
    const output = error.stderr || error.stdout || error.message || 'comando falhou';
    logger.warn({ command, cwd }, 'Bash command exited with error');
    return { result: `Error (exit ${error.status ?? '?'}): ${output}`, isError: true };
  }
}

// ---- Dispatcher principal ----

const TOOL_MAP: Record<string, ToolImpl> = {
  Read: (args, _cwd) => execRead(args),
  Write: (args, _cwd) => execWrite(args),
  Edit: (args, _cwd) => execEdit(args),
  Glob: (args, cwd) => execGlob(args, cwd),
  Grep: (args, cwd) => execGrep(args, cwd),
  Bash: (args, cwd) => execBash(args, cwd),
};

/**
 * Executa uma tool local (Read, Write, Edit, Glob, Grep, Bash) no filesystem/shell.
 *
 * @param toolName - Nome da tool (ex: "Read", "Bash")
 * @param args     - Argumentos da tool no formato chave/valor
 * @param cwd      - Diretorio de trabalho para Bash, Glob, Grep quando nao ha path explicito
 * @returns        - Resultado da execucao com flag de erro
 */
export async function executeLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<LocalToolResult> {
  const impl = TOOL_MAP[toolName];

  if (!impl) {
    logger.warn({ toolName }, 'Tool nao suportada pelo local-tool-executor');
    return {
      result: `Error: Tool "${toolName}" nao suportada. Tools disponiveis: ${Object.keys(TOOL_MAP).join(', ')}.`,
      isError: true,
    };
  }

  logger.debug({ toolName, args }, 'Executando local tool');

  try {
    return await impl(args, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ toolName, args, err }, 'Local tool execution threw unexpectedly');
    return { result: `Error inesperado em ${toolName}: ${msg}`, isError: true };
  }
}

/** Lista de tools suportadas pelo executor local */
export const SUPPORTED_LOCAL_TOOLS = Object.keys(TOOL_MAP) as ReadonlyArray<string>;
