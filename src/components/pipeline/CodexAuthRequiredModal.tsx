/**
 * CodexAuthRequiredModal.tsx
 *
 * Displayed when the pipeline emits `pipeline:auth-required` — meaning a Codex
 * agent's OAuth token expired mid-execution. The pipeline is already paused at
 * this point (backend sets status='paused').
 *
 * User flow:
 * 1. Modal appears with the error message.
 * 2. User clicks "Reconectar" to open the Codex login in a terminal.
 * 3. User clicks "Verificar" to test whether auth is now valid.
 * 4. "Retomar pipeline" is enabled only after a successful auth test.
 * 5. Alternatively, "Cancelar pipeline" aborts the run entirely.
 */

import { useEffect, useState, useCallback } from 'react';

interface AuthRequiredPayload {
  projectId: string;
  phaseNumber: number;
  agentId: string;
  message: string;
}

export function CodexAuthRequiredModal() {
  const [payload, setPayload] = useState<AuthRequiredPayload | null>(null);
  const [authVerified, setAuthVerified] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.lionclaw.pipeline.onAuthRequired((data) => {
      setPayload(data);
      setAuthVerified(false);
      setTestMessage(null);
    });
    return unsub;
  }, []);

  const handleReconectar = useCallback(async () => {
    await window.lionclaw.codex.openLogin();
  }, []);

  const handleVerificar = useCallback(async () => {
    setTesting(true);
    setTestMessage(null);
    try {
      const result = await window.lionclaw.codex.test() as { ok: boolean; message: string };
      if (result.ok) {
        setAuthVerified(true);
        setTestMessage('Autenticado com sucesso.');
      } else {
        setAuthVerified(false);
        setTestMessage(result.message ?? 'Ainda nao autenticado.');
      }
    } catch {
      setAuthVerified(false);
      setTestMessage('Erro ao verificar autenticacao.');
    } finally {
      setTesting(false);
    }
  }, []);

  const handleRetomar = useCallback(async () => {
    if (!payload || !authVerified) return;
    setResuming(true);
    try {
      const result = await window.lionclaw.pipeline.resumeAfterAuth(payload.projectId);
      if (result.ok) {
        setPayload(null);
      } else {
        setTestMessage(result.message ?? 'Nao foi possivel retomar. Tente verificar novamente.');
        setAuthVerified(false);
      }
    } catch {
      setTestMessage('Erro ao retomar pipeline.');
    } finally {
      setResuming(false);
    }
  }, [payload, authVerified]);

  const handleCancelar = useCallback(async () => {
    if (!payload) return;
    setAborting(true);
    try {
      await window.lionclaw.pipeline.abort(payload.projectId);
    } finally {
      setPayload(null);
      setAborting(false);
    }
  }, [payload]);

  if (!payload) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <h2 className="text-lg font-semibold text-white mb-2">Codex desconectado</h2>

        <p className="text-sm text-zinc-300 mb-1">
          O pipeline foi pausado porque o Codex perdeu a autenticacao OAuth durante a execucao da fase {payload.phaseNumber}.
        </p>

        <p className="text-xs text-zinc-500 mb-4 font-mono bg-zinc-800 rounded p-2 break-words">
          {payload.message}
        </p>

        <p className="text-sm text-zinc-300 mb-4">
          Clique em <span className="font-medium text-amber-400">Reconectar</span> para abrir o terminal com{' '}
          <code className="text-amber-400">codex login</code>, autentique-se, depois clique em{' '}
          <span className="font-medium text-amber-400">Verificar</span> para confirmar e{' '}
          <span className="font-medium text-green-400">Retomar pipeline</span> para continuar.
        </p>

        {testMessage && (
          <p
            className={`text-xs mb-4 px-3 py-2 rounded ${
              authVerified
                ? 'bg-green-900/40 text-green-300 border border-green-700'
                : 'bg-red-900/40 text-red-300 border border-red-700'
            }`}
          >
            {testMessage}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <button
            onClick={handleReconectar}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-amber-700 hover:bg-amber-600 text-white transition-colors"
          >
            Reconectar (abre codex login)
          </button>

          <button
            onClick={handleVerificar}
            disabled={testing}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? 'Verificando...' : 'Verificar autenticacao'}
          </button>

          <button
            onClick={handleRetomar}
            disabled={!authVerified || resuming}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {resuming ? 'Retomando...' : 'Retomar pipeline'}
          </button>

          <button
            onClick={handleCancelar}
            disabled={aborting}
            className="w-full px-4 py-2 text-sm font-medium rounded-lg border border-zinc-600 text-zinc-400 hover:text-red-400 hover:border-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {aborting ? 'Cancelando...' : 'Cancelar pipeline'}
          </button>
        </div>
      </div>
    </div>
  );
}
