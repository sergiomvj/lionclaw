// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState } from 'react';
import { FileSearch, Loader2, Clock, Trash2 } from 'lucide-react';
import type { EnrichSession } from '@/types';

const PHASE_LABELS: Record<EnrichSession['phase'], string> = {
  validator: 'Validacao',
  enricher: 'Enrich',
  done: 'Concluido',
};

const STATUS_CONFIG: Record<
  EnrichSession['status'],
  { color: string; label: string }
> = {
  idle: { color: 'bg-zinc-500/20 text-zinc-400', label: 'Aguardando' },
  running: { color: 'bg-blue-500/20 text-blue-400', label: 'Processando' },
  waiting: { color: 'bg-amber-500/20 text-amber-400', label: 'Aguardando resposta' },
  finalizing: { color: 'bg-purple-500/20 text-purple-400', label: 'Finalizando' },
  done: { color: 'bg-green-500/20 text-green-400', label: 'Concluido' },
};

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

interface EnrichSessionCardProps {
  session: EnrichSession;
  onClick: () => void;
  onDelete: (sessionId: string) => void;
}

export function EnrichSessionCard({ session, onClick, onDelete }: EnrichSessionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const statusConfig = STATUS_CONFIG[session.status];
  const totalCost = session.validatorMetrics.costUsd + session.enricherMetrics.costUsd;
  const totalMessages = session.validatorMetrics.messages + session.enricherMetrics.messages;
  const isActive = session.status !== 'done';

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await onDelete(session.id);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 bg-zinc-900 border rounded-lg hover:border-zinc-700 transition-colors ${
        isActive ? 'border-indigo-500/40' : 'border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileSearch size={14} className="text-indigo-400 shrink-0" />
          <h3 className="text-sm font-semibold text-zinc-100 truncate">
            {session.name}
          </h3>
          <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">
            ENRICH
          </span>
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {session.status === 'running' && (
            <Loader2 size={12} className="text-blue-400 animate-spin" />
          )}
          {session.status === 'waiting' && (
            <Clock size={12} className="text-amber-400" />
          )}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${statusConfig.color}`}
          >
            {statusConfig.label}
          </span>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                {deleting ? '...' : 'Confirmar'}
              </button>
              <button
                onClick={cancelDelete}
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700 transition-colors"
              >
                Nao
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Deletar sessao"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500 mb-2">
        <span>Fase: {PHASE_LABELS[session.phase]}</span>
        {totalMessages > 0 && <span>Mensagens: {totalMessages}</span>}
        {totalCost > 0 && <span>Custo: {formatCost(totalCost)}</span>}
      </div>

      {/* Phase progress bar */}
      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            session.phase === 'done'
              ? 'bg-green-500'
              : session.phase === 'enricher'
                ? 'bg-indigo-500'
                : 'bg-amber-500'
          }`}
          style={{
            width:
              session.phase === 'done'
                ? '100%'
                : session.phase === 'enricher'
                  ? '50%'
                  : '15%',
          }}
        />
      </div>
    </button>
  );
}
