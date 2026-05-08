/**
 * useCodexWindowsPrep.ts
 *
 * SPEC-codex-windows-fix.md Camada 2: hook que centraliza o fluxo de checagem +
 * abertura do dialog de prep Windows. Reusavel pelos 3 momentos do trigger:
 *
 * - NewPipelineModal (apos validar path, antes de criar projeto)
 * - PipelinePage / PipelineProjectCard (ao montar/focar projeto)
 * - PhaseActionButtons (no click "Iniciar pipeline")
 *
 * Mac safe: checkPrepNeeded retorna { needs: false, reason: 'not-windows' } e o hook
 * nao mostra dialog nenhum.
 *
 * Suporte a "gating start": ensureCheckedThen permite agendar uma acao (como
 * startPipeline) que so executa apos o usuario decidir no dialog. Se nao precisa
 * de prep, executa imediatamente. Resolve o P1: criar projeto + start imediato
 * sem dar chance pro check rodar antes.
 */

import { useCallback, useRef, useState } from 'react';
import type { CodexPrepCheckResult, CodexPrepApplyResult, CodexWindowsIssue } from '@/types';

export interface UseCodexWindowsPrepReturn {
  /** Estado atual: null = nao verificado / dispensado. Caso contrario: resultado do check. */
  checkResult: CodexPrepCheckResult | null;
  /** True se um check ou apply esta em andamento. */
  busy: boolean;
  /**
   * Roda check pra projectPath. Se needs=true, set state pra dialog renderizar.
   * Caller pode checar return.needs pra decidir se aguarda decisao do usuario.
   */
  checkProject: (projectPath: string) => Promise<CodexPrepCheckResult>;
  /**
   * Abre o dialog diretamente a partir de um warning pre-flight. Diferente de
   * checkProject(), nao silencia por consentimento antigo: se o executor avisou,
   * o usuario precisa conseguir tentar reparar.
   */
  openFromWarning: (repoRoot: string, issues: CodexWindowsIssue[]) => void;
  /**
   * Roda check + executa pendingAction. Se prep eh necessaria, agenda
   * pendingAction pra apos o dialog fechar (em qualquer decisao). Se nao, roda
   * imediatamente. Use isso pra gatear startPipeline / criacao de projeto.
   */
  ensureCheckedThen: (projectPath: string, pendingAction: () => void | Promise<void>) => Promise<void>;
  /** Limpa state — fecha dialog. Tambem dispara pendingAction se houver (P1 fix). */
  dismiss: () => void;
  /** Caller passa pro dialog como onDone callback. Dispara pendingAction. */
  handleDialogDone: (result: CodexPrepApplyResult | null) => void;
}

export function useCodexWindowsPrep(): UseCodexWindowsPrepReturn {
  const [checkResult, setCheckResult] = useState<CodexPrepCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Acao agendada pra rodar apos dialog fechar (qualquer decisao).
  // Usada pelo ensureCheckedThen pra evitar que startPipeline rode antes do
  // usuario consentir/dispensar a prep.
  const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null);

  const flushPending = useCallback((): void => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) {
      void Promise.resolve(action()).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('useCodexWindowsPrep: pending action threw', err);
      });
    }
  }, []);

  const checkProject = useCallback(
    async (projectPath: string): Promise<CodexPrepCheckResult> => {
      setBusy(true);
      try {
        const result = (await window.lionclaw.codex.checkPrepNeeded(projectPath)) as CodexPrepCheckResult;
        if (result.needs) {
          setCheckResult(result);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openFromWarning = useCallback((repoRoot: string, issues: CodexWindowsIssue[]): void => {
    setCheckResult({
      needs: true,
      reason: 'needs-dialog',
      repoRoot,
      issues,
    });
  }, []);

  const ensureCheckedThen = useCallback(
    async (projectPath: string, pendingAction: () => void | Promise<void>): Promise<void> => {
      // Substitui pending anterior (raro, mas evita lock-up se chamado 2x rapido)
      pendingActionRef.current = pendingAction;
      try {
        const result = await checkProject(projectPath);
        if (!result.needs) {
          // Sem prep necessaria — roda imediatamente
          flushPending();
          return;
        }
        // Caso contrario, dialog vai aparecer; pendingAction sera disparada por
        // dismiss/handleDialogDone quando user decidir.
      } catch (err) {
        // Se check falhou (IPC error, edge case), nao deixa pendingAction leakar.
        // Roda mesmo assim — sem prep nao bloqueia, Camadas 1+4 compensam.
        // eslint-disable-next-line no-console
        console.error('useCodexWindowsPrep: checkProject falhou, executando pendingAction sem prep', err);
        flushPending();
      }
    },
    [checkProject, flushPending],
  );

  const dismiss = useCallback(() => {
    setCheckResult(null);
    flushPending();
  }, [flushPending]);

  const handleDialogDone = useCallback(
    (_result: CodexPrepApplyResult | null) => {
      setCheckResult(null);
      flushPending();
    },
    [flushPending],
  );

  return { checkResult, busy, checkProject, openFromWarning, ensureCheckedThen, dismiss, handleDialogDone };
}
