// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState } from 'react';
import { CheckCheck, Flag, FileSearch, Loader2 } from 'lucide-react';
import type { EnrichPhase, EnrichStatus } from '@/types';

interface Props {
  sessionId: string;
  phase: EnrichPhase;
  status: EnrichStatus;
  finalSpecPath?: string;
  onViewSpec: (path: string) => void;
}

export function EnrichControls({ sessionId, phase, status, finalSpecPath, onViewSpec }: Props) {
  const [loadingApprove, setLoadingApprove] = useState(false);
  const [loadingFinalize, setLoadingFinalize] = useState(false);
  const isDisabled = status === 'running' || status === 'finalizing';

  const handleApprove = async () => {
    if (loadingApprove) return;
    setLoadingApprove(true);
    try {
      await window.lionclaw.enrich.approvePhase(sessionId);
    } finally {
      setLoadingApprove(false);
    }
  };

  const handleFinalize = async () => {
    if (loadingFinalize) return;
    setLoadingFinalize(true);
    try {
      await window.lionclaw.enrich.finalize(sessionId);
    } finally {
      setLoadingFinalize(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Phase 1: show Approve button */}
      {phase === 'validator' && (
        <button
          onClick={handleApprove}
          disabled={isDisabled || loadingApprove}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
          title="Aprovar validacao e avancar para Fase 2"
        >
          {loadingApprove ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <CheckCheck size={13} />
          )}
          Aprovar e Avancar
        </button>
      )}

      {/* Phase 2: show Finalize button */}
      {phase === 'enricher' && (
        <button
          onClick={handleFinalize}
          disabled={isDisabled || loadingFinalize}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
          title="Finalizar e gerar SPEC final"
        >
          {loadingFinalize ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Flag size={13} />
          )}
          Finalizar
        </button>
      )}

      {/* Done: show Ver Spec */}
      {phase === 'done' && finalSpecPath && (
        <button
          onClick={() => onViewSpec(finalSpecPath)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg text-xs font-medium transition-colors"
          title="Ver SPEC final gerada"
        >
          <FileSearch size={13} />
          Ver Spec
        </button>
      )}
    </div>
  );
}
