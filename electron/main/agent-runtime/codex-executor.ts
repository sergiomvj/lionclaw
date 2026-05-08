/**
 * codex-executor.ts
 *
 * Runs an agent via the OpenAI Codex CLI bridge (codex mcp-server process).
 * The bridge manages the process pool, JSON-RPC framing, and event dispatch.
 *
 * Does NOT import from pipeline-engine, harness-engine, or security-audit-runner.
 * Watchdog callbacks are already injected by execute.ts before calling run().
 *
 * Error propagation:
 * - CodexAuthError  — bubbles up as-is; Sprint 9 catches it at the pipeline layer.
 * - CodexUnavailableError — bubbles up as-is; Sprint 9 emits pipeline:error for this.
 * - All other errors — bubbles up; execute.ts finalizes the watchdog via finally.
 *
 * Session lifecycle (Sprint 4 scope):
 * One session is created per call. Multi-round continuation within the same pipeline
 * phase will be added in Sprint 9 via req.codexSession / reply().
 */

import { createLogger } from '../logger';
import { calculateCost } from '../pricing';
import {
  getAgent,
  getCodexWindowsPrepConsent,
  CODEX_PREP_VERSION_CURRENT,
} from '../db';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import {
  createCodexSession,
  CodexAuthError,
  CodexUnavailableError,
  type CodexResponse,
} from '../codex-bridge';
import {
  countActionableIssues,
  detectCodexWindowsIssues,
  resolveGitRoot,
  runPrep,
  shouldSilenceWarning,
} from '../codex-windows-prep';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';

// SPEC-codex-windows-fix.md Camada 4: limiar pra emitir warning IPC quando
// apply_patch failures se acumulam num run. Threshold conservador (3) ate
// telemetria mostrar baseline real.
const APPLY_PATCH_FAILURE_WARN_THRESHOLD = 3;

// SPEC Camada 2 Fluxo B: cache de repos ja prep'ados nesta sessao Electron.
// Evita reaplicar prep silencioso dentro da mesma sessao. Reset implicito ao
// reiniciar o app — comportamento desejado caso usuario tenha mexido na branch.
const sessionPreparedRepos = new Set<string>();

/**
 * SPEC Camada 2 Fluxo B (auto-apply silencioso) + Camada 3 (warning IPC).
 * Roda pre-flight antes do createCodexSession. Mac safe (early returns).
 *
 * Comportamento:
 * 1. Detecta repo Git canonical
 * 2. Se consent existe e e current e action='prepared': roda prep silencioso
 *    (rede de seguranca caso usuario tenha trocado branch e CRLF voltou)
 * 3. Detecta issues. Se houver e o usuario nao optou por skip atual:
 *    emite codex:windows-health-warning IPC (NAO via onText)
 */
function runPreFlight(req: AgentExecutionRequest): void {
  if (process.platform !== 'win32') return;

  const repoRoot = resolveGitRoot(req.cwd);
  if (!repoRoot) return;

  // Detecta issues UMA vez — reutilizado por Fluxo B e Camada 3.
  let issues = detectCodexWindowsIssues(repoRoot);
  let actionableCount = countActionableIssues(issues);

  // ---- Fluxo B: auto-apply silencioso se ja autorizado e current ----
  // P2.2: so chama runPrep se ainda existem issues acionaveis. Sem isso, apos
  // primeira prep bem-sucedida o working tree fica dirty (renormalizado, nao
  // commitado) e proxima sessao caia em 'dirty-tree' emitindo warning inutil
  // a cada run.
  const consent = getCodexWindowsPrepConsent(repoRoot);
  let prepSucceededThisRun = false;
  if (
    consent &&
    consent.prepVersion >= CODEX_PREP_VERSION_CURRENT &&
    consent.action === 'prepared' &&
    !sessionPreparedRepos.has(repoRoot)
  ) {
    if (actionableCount === 0) {
      // Prep ja foi aplicado em sessao anterior; working tree pode estar dirty
      // (arquivos renormalizados aguardando commit do user) mas isso NAO e mais
      // problema do auto-prep. Marca como ja-preparado nesta sessao e segue.
      sessionPreparedRepos.add(repoRoot);
      logger.info(
        { projectId: req.projectId, repoRoot },
        'codex auto-prep skipped: no actionable issues remain',
      );
    } else {
      const result = runPrep(repoRoot);
      if (result.applied) {
        sessionPreparedRepos.add(repoRoot);
        prepSucceededThisRun = true;
        logger.info(
          { projectId: req.projectId, repoRoot, filesAffected: result.filesAffected },
          'codex auto-prep applied silently',
        );
      } else {
        logger.warn(
          { projectId: req.projectId, repoRoot, reason: result.reason },
          'codex auto-prep skipped',
        );
        emitIPC('codex:windows-prep-skipped', {
          projectId: req.projectId,
          repoRoot,
          reason: result.reason,
          timestamp: Date.now(),
        });
        // CRITICAL: NUNCA aborta o agente. Camadas 1+4 compensam.
      }
    }
  }

  // ---- Camada 3: pre-flight warning ----
  // Respeita opt-out 'skip' atual (silencia warning).
  if (shouldSilenceWarning(repoRoot)) return;

  // Se prep rodou com sucesso nesta chamada, re-detecta pra refletir estado real
  // pos-prep (evita warning cosmetico baseado em contagem stale).
  if (prepSucceededThisRun) {
    issues = detectCodexWindowsIssues(repoRoot);
    actionableCount = countActionableIssues(issues);
  }

  // So emite warning se ha issues acionaveis. Issues informativas (powershell-5.1)
  // sozinhas nao justificam banner — Camada 1 ja mitigou.
  if (actionableCount === 0) return;

  emitIPC('codex:windows-health-warning', {
    projectId: req.projectId,
    agentId: req.agentId,
    cwd: req.cwd,
    repoRoot,
    timestamp: Date.now(),
    issues,
  });
  logger.warn(
    { projectId: req.projectId, repoRoot, actionableCount, totalIssues: issues.length },
    'codex windows pre-flight warning',
  );
}

// Re-export error classes so callers can catch them from a single import point.
export { CodexAuthError, CodexUnavailableError };

const logger = createLogger('codex-executor');

const CODEX_TERMINAL_GUARDRAILS = `## Regras de terminal Codex

- Prefira comandos nao interativos. Use flags/env para evitar prompts quando possivel.
- Se um comando exigir input interativo ou retornar erro pedindo tty=true, rerode uma unica vez com tty=true.
- Nao tente escrever stdin repetidamente em uma sessao fechada. Se o erro persistir, pare e explique o bloqueio.`;

const CODEX_WINDOWS_BLOCK = `## AMBIENTE WINDOWS PowerShell 5.1 - REGRAS OBRIGATORIAS

Voce esta rodando via PowerShell 5.1 (Windows). Default encoding e CP-1252 e CORROMPE arquivos UTF-8 sem BOM (acentos viram mojibake).

### Leitura de arquivos de codigo

PROIBIDO (corrompe acentos):
- Get-Content arquivo
- Get-Content arquivo -Raw
- type arquivo
- cat arquivo

OBRIGATORIO (preserva UTF-8):
1. node -e "process.stdout.write(require('fs').readFileSync('arquivo','utf8'))"
2. Get-Content arquivo -Raw -Encoding UTF8

Use a opcao 1 sempre que possivel - e independente de codepage do shell.

### Sinais de mojibake

Se voce ver no output: Ã§ Ã£ Ã© Ã­ Ã³ Ãº - leitura esta corrompida.
Arquivo real tem: c-cedilha a-til e-agudo i-agudo o-agudo u-agudo.

NAO use texto corrompido em apply_patch - match falha por bytes diferentes.

### Recovery de apply_patch failure

Se apply_patch retornar "Failed to find expected lines":
1. Releia o arquivo com node -e ... ou Get-Content -Raw -Encoding UTF8
2. Compare caracteres acentuados entre as duas leituras
3. Se viu Ã na primeira: era mojibake - reconstrua o patch a partir da leitura correta
4. NAO retente o mesmo patch - vai falhar igual`;

function appendCodexTerminalGuardrails(systemPrompt: string): string {
  let result = systemPrompt;

  if (!result.includes('## Regras de terminal Codex')) {
    result = `${result.trim()}\n\n${CODEX_TERMINAL_GUARDRAILS}`.trim();
  }

  if (process.platform === 'win32' && !result.includes('## AMBIENTE WINDOWS PowerShell 5.1')) {
    result = `${result.trim()}\n\n${CODEX_WINDOWS_BLOCK}`.trim();
  }

  return result;
}

async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  const agent = getAgent(req.agentId);
  if (!agent) {
    throw new Error(`Agent ${req.agentId} not found`);
  }
  if (!agent.codexConfig) {
    throw new Error(`Agent ${req.agentId} runtime=codex but no codexConfig`);
  }

  const startedAt = Date.now();

  // Session ownership logic (Sprint 9):
  // - If the caller passes req.codexSession, this is a continuation turn: use reply().
  //   The caller owns the session lifecycle; we never close it here.
  // - If no session is provided, create a fresh one using createCodexSession + send().
  //   When req.onCodexSessionCreated is supplied, the caller is claiming ownership
  //   of the new session (to persist it for future turns). In that case we do NOT
  //   close on exit. When no callback is supplied (standalone / Sprint 4 compat), we
  //   own the session and close it in the finally block.
  let session = req.codexSession ?? null;
  let shouldClose = false;

  if (!session) {
    // SPEC Camada 2 Fluxo B + Camada 3: pre-flight Windows. Mac no-op.
    runPreFlight(req);

    session = await createCodexSession({
      model: agent.codexConfig.model,
      cwd: req.cwd,
      systemPrompt: appendCodexTerminalGuardrails(config.systemPrompt),
      // Full bypass per SPEC D3: codex never asks the user for permission. Combined
      // with the bridge's auto-approve safety net (any approval_request is silently
      // approved), zero prompts ever surface in LionClaw.
      approvalPolicy: 'never',
      sandbox: agent.codexConfig.sandbox ?? 'workspace-write',
      reasoningEffort: agent.codexConfig.reasoningEffort,
      // 2h hard timeout. Coder/Evaluator de sprints reais editam 5-15 arquivos,
      // rodam testes/typecheck/build, podendo levar 30-60min. 10min original
      // matava no meio do trabalho. Ver BUGFIXTESTESV1.md (timeout pos-Bug #7).
      timeoutMs: 7_200_000,
      // S4.3 (Onda 4): isolamento de pool por projeto.
      projectId: req.projectId,
    });
    // Notify caller so it can cache the session for subsequent turns.
    req.onCodexSessionCreated?.(session);
    // Close only when the caller didn't claim ownership.
    shouldClose = !req.onCodexSessionCreated;
  }

  const activeSession = session;

  try {
    // Use reply() for continuation turns; send() for the first turn.
    // Mapeia o `onReasoning` do bridge pro canonical `onThinking` da request:
    // assim o reasoning do Codex passa pela watchdog wrapper em execute.ts e
    // tambem reseta o timer de stall, igual ao reasoning de Cloud (que ja usa
    // onThinking nativamente). Sem esse mapping, spans longos de raciocinio
    // do spec-builder eram mortos pela watchdog externa. Ver Bug #5.
    const callbacks = {
      onText: req.onText,
      onReasoning: req.onThinking,
      onToolUse: req.onToolUse,
      onToolUseComplete: req.onToolUseComplete,
      // Sinal generico: bridge chama isso em TODO evento Codex (incluindo
      // plan_update e qualquer evento futuro nao tratado explicitamente).
      // Reseta a watchdog do executeAgent. Ver Bug #7.
      onActivity: req.onActivity,
    };
    const response: CodexResponse = req.codexSession
      ? await activeSession.reply(req.prompt, callbacks, req.abortController.signal)
      : await activeSession.send(req.prompt, callbacks, req.abortController.signal);

    // Note: status === 'auth_required' is internal to the bridge — the bridge throws
    // CodexAuthError before returning when auth fails. We do NOT need to check
    // response.status here; the bridge has already rejected with CodexAuthError.

    const durationMs = Date.now() - startedAt;
    const costUsd = calculateCost(
      agent.codexConfig.model,
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.usage.cachedInputTokens,
      0,
    );

    logger.info(
      {
        agentId: req.agentId,
        model: agent.codexConfig.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd,
        durationMs,
        filesChanged: response.filesChanged.length,
        commandsRun: response.commandsRun.length,
        sessionReused: !!req.codexSession,
        applyPatchFailures: response.applyPatchFailures,
      },
      'Codex executor finished',
    );

    // SPEC Camada 4: emitir warning IPC se apply_patch failures atingiram threshold.
    // Canal proprio (NAO via onText) pra nao contaminar stream do agente.
    if (response.applyPatchFailures >= APPLY_PATCH_FAILURE_WARN_THRESHOLD) {
      emitIPC('codex:patch-failure-warning', {
        projectId: req.projectId,
        agentId: req.agentId,
        cwd: req.cwd,
        count: response.applyPatchFailures,
        samples: response.applyPatchFailureSamples,
        timestamp: Date.now(),
      });
      logger.warn(
        {
          projectId: req.projectId,
          agentId: req.agentId,
          count: response.applyPatchFailures,
        },
        'codex apply_patch failures reached warn threshold',
      );
    }

    return {
      output: response.content,
      metrics: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cachedInputTokens,
        cacheCreationTokens: 0,
        toolUses: response.commandsRun.length + response.filesChanged.length,
        apiRequests: 1,
        costUsd,
        durationMs,
      },
      model: agent.codexConfig.model,
      runtime: 'codex',
      provider: 'openai-codex',
      metadata: {
        codex: {
          applyPatchFailures: response.applyPatchFailures,
          applyPatchFailureSamples: response.applyPatchFailureSamples,
        },
      },
    };
  } finally {
    if (shouldClose) {
      activeSession.close();
    }
  }
}

export const codexExecutor: RuntimeExecutor = { run };
