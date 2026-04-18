// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState } from 'react';
import { CheckCircle2, RotateCcw, Loader2 } from 'lucide-react';

interface ApprovalButtonsProps {
  workflowRunId: string | null;
  onApprove: () => void;
  onRevisar: () => void;
}

export function ApprovalButtons({ workflowRunId, onApprove, onRevisar }: ApprovalButtonsProps) {
  const [isApproving, setIsApproving] = useState(false);

  const handleApprove = async () => {
    if (isApproving || !workflowRunId) return;
    setIsApproving(true);
    try {
      await window.lionclaw.workflow.approve(workflowRunId);
      onApprove();
    } catch {
      setIsApproving(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-zinc-950 border-t border-zinc-800">
      <div className="max-w-2xl mx-auto w-full flex items-center gap-3">
        <span className="text-xs text-zinc-500 flex-1">
          Revise o resumo acima e escolha uma acao:
        </span>
        <button
          onClick={onRevisar}
          disabled={isApproving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600/15 hover:bg-orange-600/25 text-orange-400 border border-orange-600/30 hover:border-orange-500/50 text-sm font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <RotateCcw size={14} />
          Revisar
        </button>
        <button
          onClick={handleApprove}
          disabled={isApproving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600/20 hover:bg-green-600/30 text-green-400 border border-green-600/30 hover:border-green-500/50 text-sm font-medium transition-all shadow-[0_0_12px_rgba(34,197,94,0.15)] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {isApproving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <CheckCircle2 size={14} />
          )}
          {isApproving ? 'Aprovando...' : 'Aprovar'}
        </button>
      </div>
    </div>
  );
}
