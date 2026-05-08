import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { createLogger } from './logger';
import { insertAuditEntry } from './db';
import { sendAskQuestion } from './ask-question';
import type { ConfirmAction } from '../../src/types';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { EXCLUDED_FROM_AUDIT_PATTERNS } from './repo-profiler';

import type { ToolDecision } from './agent-runtime/types';

const logger = createLogger('permission-guard');

interface PendingConfirmation {
  resolve: (decision: ToolDecision) => void;
  action: ConfirmAction;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

// ---- Active Enrich Session allowed paths ----
// When an enrich session is running, Write/Edit to the active SPEC file and
// its companion report/suggestions files are auto-approved so the Validator
// and Enricher agents can edit them without triggering a confirmation popup.

const activeEnrichAllowedPaths: Set<string> = new Set();
let activeEnrichSpecPath: string | null = null;

// ---- Active Security Audit Phase flag ----
// When a security audit is running, Read access to .env* files is blocked.

let activeSecurityAuditPhase = false;

export function setActiveSecurityAuditPhase(active: boolean): void {
  activeSecurityAuditPhase = active;
}

export function isSecurityAuditPhaseActive(): boolean {
  return activeSecurityAuditPhase;
}

export function setActiveEnrichSpecPath(specPath: string | null): void {
  activeEnrichAllowedPaths.clear();
  activeEnrichSpecPath = specPath;
  if (specPath) {
    const specDir = path.dirname(specPath);
    activeEnrichAllowedPaths.add(specPath);
    activeEnrichAllowedPaths.add(path.join(specDir, '.validator-report.md'));
    activeEnrichAllowedPaths.add(path.join(specDir, '.enricher-suggestions.md'));
  }
}

export function getActiveEnrichSpecPath(): string | null {
  return activeEnrichSpecPath;
}

/**
 * Comandos git que MUDAM state do repositorio. Sao negados DIRETAMENTE
 * (sem modal de confirmacao) — o usuario faz controle de versao manualmente,
 * fora do agente.
 *
 * Verificado antes de DESTRUCTIVE_BASH_PATTERNS pra garantir deny imediato
 * mesmo que o pattern tambem case com checagem de confirmacao.
 */
const FORBIDDEN_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+push\s+(-f|--force)\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rm\b/,
  /\bgit\s+stash\s+drop\b/,
  /\bgit\s+tag\b/,
  /\bgit\s+remote\s+(add|set-url|remove|rename)\b/,
  /\bgit\s+fetch\s+--force\b/,
  // git checkout -- <path> descarta mudancas locais (destrutivo).
  // Switch de branch (git checkout main, git checkout -b new) NAO e bloqueado.
  /\bgit\s+checkout\s+--/,
  /\bgit\s+clean\s+-[a-z]*f/,
];

const FORBIDDEN_GIT_DENY_MESSAGE =
  'Comandos git que modificam state (commit, push, reset, rebase, merge, etc) sao proibidos. O usuario faz controle de versao manualmente. Use Write/Edit para arquivos, e git status/diff/log para inspecao.';

const DESTRUCTIVE_BASH_PATTERNS: Array<{ pattern: RegExp; risk: ConfirmAction['risk'] }> = [
  { pattern: /\brm\s+-rf?\b/, risk: 'critical' },
  { pattern: /\bsudo\b/, risk: 'critical' },
  { pattern: /\bformat\b/, risk: 'critical' },
  { pattern: /\bmkfs\b/, risk: 'critical' },
  { pattern: /\bdd\s+if=/, risk: 'critical' },
  { pattern: /\brm\b/, risk: 'high' },
  { pattern: /\bnpm\s+publish\b/, risk: 'high' },
];

const SENSITIVE_WRITE_PATTERNS = [/\.(env|pem|key|crt|p12)$/];

export function createPermissionGuard(getWindow: () => BrowserWindow | null, options?: { isOnboarding?: boolean }) {
  return async (toolName: string, toolInput: Record<string, unknown>): Promise<ToolDecision> => {
    // During onboarding, block ALL file/system tools
    // The agent only needs to chat - no reading files, no writing, no bash
    if (options?.isOnboarding) {
      const blockedDuringOnboarding = new Set([
        'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
        'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
      ]);
      if (blockedDuringOnboarding.has(toolName) || toolName.startsWith('mcp__')) {
        return { behavior: 'deny', message: 'Durante o onboarding, apenas converse com o usuario. Nao use ferramentas. Siga as instrucoes do BOOTSTRAP.md.' };
      }
    }

    // AskUserQuestion: intercept, route to frontend UI, feed answers back via deny message.
    // We MUST deny the tool to prevent the SDK from running its built-in terminal prompt
    // (which would hang in our headless Electron environment). The deny message carries
    // the user's formatted answers so the agent receives them as tool feedback.
    if (toolName === 'AskUserQuestion') {
      try {
        const questions = (toolInput as Record<string, unknown>).questions;
        if (!Array.isArray(questions) || questions.length === 0) {
          return { behavior: 'deny', message: 'AskUserQuestion: nenhuma pergunta fornecida.' };
        }

        const response = await sendAskQuestion(getWindow, questions);
        logger.info({ id: response.id, answers: response.answers }, 'AskUserQuestion answered by user');

        // Format the user's answers into a clear message the agent can parse
        const lines: string[] = ['O usuario respondeu as perguntas:'];
        for (const q of questions) {
          const answer = response.answers[q.question];
          const formatted = Array.isArray(answer) ? answer.join(', ') : answer;
          lines.push(`- ${q.question} -> ${formatted || '(sem resposta)'}`);

          // Include notes if provided
          const annotation = response.annotations?.[q.question];
          if (annotation?.notes) {
            lines.push(`  Notas: ${annotation.notes}`);
          }
        }

        return { behavior: 'deny', message: lines.join('\n') };
      } catch (err) {
        logger.error({ err }, 'AskUserQuestion failed');
        return { behavior: 'deny', message: `AskUserQuestion falhou: ${(err as Error).message}` };
      }
    }

    // Block Read on .env* files during security audit phase to prevent
    // tautological findings (reading .env and reporting secrets is not a finding).
    if (toolName === 'Read' && activeSecurityAuditPhase) {
      const filePath = (toolInput['file_path'] as string) || '';
      const basename = path.basename(filePath);
      if (EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename))) {
        return {
          behavior: 'deny',
          message:
            'Read em .env* proibido durante auditoria. Para verificar exposicao, leia .gitignore e use Bash para \'git log -- <path>\'.',
        };
      }
    }

    // If the tool passed SDK allowedTools filtering, auto-approve unless it needs
    // destructive pattern checks (Bash, Write, Edit, MCP tools).
    if (toolName !== 'Bash' && toolName !== 'Write' && toolName !== 'Edit' && !toolName.startsWith('mcp__')) {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Check Bash commands for destructive patterns
    if (toolName === 'Bash') {
      const command = (toolInput['command'] as string) || '';
      // FORBIDDEN_GIT_PATTERNS — deny direto (sem modal). Comandos git que
      // mudam state do repo sao proibidos por politica.
      for (const pattern of FORBIDDEN_GIT_PATTERNS) {
        if (pattern.test(command)) {
          logger.warn({ command }, 'Bash blocked by FORBIDDEN_GIT_PATTERNS');
          return { behavior: 'deny', message: FORBIDDEN_GIT_DENY_MESSAGE };
        }
      }
      for (const { pattern, risk } of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return requestConfirmation(getWindow, {
            tool: toolName,
            description: `Executar comando: ${command.substring(0, 100)}`,
            input: toolInput,
            risk,
          });
        }
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Check writes to sensitive files
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = (toolInput['file_path'] as string) || '';

      // Auto-approve Write/Edit on the active enrich SPEC file so the
      // Validator and Enricher agents can edit it without a popup.
      if (activeEnrichAllowedPaths.has(filePath)) {
        logger.info({ tool: toolName, filePath }, 'Auto-approving Write/Edit on active enrich path');
        return { behavior: 'allow', updatedInput: toolInput };
      }

      for (const pattern of SENSITIVE_WRITE_PATTERNS) {
        if (pattern.test(filePath)) {
          return requestConfirmation(getWindow, {
            tool: toolName,
            description: `Escrever em arquivo sensivel: ${filePath}`,
            input: toolInput,
            risk: 'high',
          });
        }
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // MCP tools - check for destructive ones
    if (toolName.startsWith('mcp__')) {
      // Extrair nome real da tool do formato mcp__{server}__{toolName}
      const parts = toolName.split('__');
      const actualToolName = parts[parts.length - 1] || toolName;

      // Operacoes verdadeiramente destrutivas (delete permanente, envio de emails)
      const DESTRUCTIVE_MCP_PATTERNS = [
        /^.*-delete$/i,        // notion-delete, gmail-delete etc (sufixo -delete)
        /^.*-trash$/i,         // mover para lixeira
        /^.*-send-email$/i,    // enviar email
        /^.*-send-message$/i,  // enviar mensagem
        /^.*-publish$/i,       // publicar conteudo
        /^send_email$/i,       // gmail send_email
        /^reply_to$/i,         // gmail reply_to
        /^forward$/i,          // gmail forward
        /^delete_event$/i,     // calendar delete_event
        /^delete_file$/i,      // drive delete_file
        /^trash_message$/i,    // gmail trash_message
        /^share_file$/i,       // drive share_file
      ];

      // Operacoes de risco medio (criar/editar e reversivel)
      const MEDIUM_RISK_MCP_PATTERNS = [
        /^.*-move$/i,          // mover paginas/arquivos
        /^.*-archive$/i,       // arquivar
      ];

      for (const pattern of DESTRUCTIVE_MCP_PATTERNS) {
        if (pattern.test(actualToolName)) {
          return requestConfirmation(getWindow, {
            tool: toolName,
            description: `Acao MCP destrutiva: ${actualToolName}`,
            input: toolInput,
            risk: 'high',
          });
        }
      }

      for (const pattern of MEDIUM_RISK_MCP_PATTERNS) {
        if (pattern.test(actualToolName)) {
          return requestConfirmation(getWindow, {
            tool: toolName,
            description: `Acao MCP: ${actualToolName}`,
            input: toolInput,
            risk: 'medium',
          });
        }
      }

      // Todas as outras operacoes MCP (fetch, search, create, update) = auto-approve
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Default: allow non-destructive tools
    return { behavior: 'allow', updatedInput: toolInput };
  };
}

async function requestConfirmation(
  getWindow: () => BrowserWindow | null,
  action: Omit<ConfirmAction, 'id'>,
): Promise<ToolDecision> {
  const window = getWindow();
  if (!window) {
    return { behavior: 'deny', message: 'Janela nao disponivel para confirmacao' };
  }

  const id = crypto.randomUUID();
  const fullAction: ConfirmAction = { ...action, id };

  return new Promise((resolve) => {
    pendingConfirmations.set(id, { resolve, action: fullAction });

    window.webContents.send('chat:confirm-request', fullAction);

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingConfirmations.has(id)) {
        pendingConfirmations.delete(id);
        insertAuditEntry({
          eventType: 'confirm_response',
          toolName: action.tool,
          input: JSON.stringify(action.input).substring(0, 500),
          approved: false,
        });
        resolve({ behavior: 'deny', message: 'Timeout na confirmacao do usuario' });
      }
    }, 60_000);
  });
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const pending = pendingConfirmations.get(id);
  if (!pending) {
    logger.warn({ id }, 'Confirmation not found');
    return;
  }

  pendingConfirmations.delete(id);

  insertAuditEntry({
    eventType: 'confirm_response',
    toolName: pending.action.tool,
    input: JSON.stringify(pending.action.input).substring(0, 500),
    approved,
  });

  if (approved) {
    pending.resolve({ behavior: 'allow', updatedInput: pending.action.input as Record<string, unknown> });
  } else {
    pending.resolve({ behavior: 'deny', message: 'Acao negada pelo usuario' });
  }
}

/**
 * Factory que retorna um canUseTool callback pro enrich.
 *
 * Auto-aprova Write/Edit nos paths registrados pelo setActiveEnrichSpecPath
 * (specPath + .validator-report.md + .enricher-suggestions.md).
 *
 * Para tudo o mais (Bash destrutivo, MCP destrutivo, Write/Edit em arquivos
 * sensiveis, etc), DELEGA pro createPermissionGuard padrao. Isso preserva
 * 100% o comportamento atual do enrich (R8 da SPEC-refactor-pipelines.md).
 *
 * Diferenca para createPermissionGuard padrao: o auto-approval de
 * activeEnrichAllowedPaths roda PRIMEIRO, antes do ramo Write/Edit do guard
 * principal. Como o guard principal tambem checa esse Set internamente, o
 * efeito final e identico — mas explicitar aqui mantem a intencao do enrich
 * obvia ao leitor e protege contra refactors futuros do guard padrao.
 */
export function createEnrichPermissionGuard(
  getWindow: () => BrowserWindow | null,
): CanUseTool {
  const fallbackGuard = createPermissionGuard(getWindow);

  return (async (toolName: string, toolInput: Record<string, unknown>) => {
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = (toolInput['file_path'] as string) || '';
      if (filePath && activeEnrichAllowedPaths.has(filePath)) {
        logger.info({ tool: toolName, filePath }, 'Enrich guard: auto-approving Write/Edit on active enrich path');
        return { behavior: 'allow', updatedInput: toolInput };
      }
    }
    return fallbackGuard(toolName, toolInput);
  }) as CanUseTool;
}
