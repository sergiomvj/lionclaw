import { CheckCircle, Circle, XCircle, Loader2 } from 'lucide-react';
import type { SecurityAgentStatus } from '@/types/pipeline';

// ---- Props ----

interface SecurityAuditProgressProps {
  agents: SecurityAgentStatus[];
  isStreaming: boolean;
}

// ---- Total expected agents ----

const TOTAL_AGENTS = 7;

// ---- Agent status row ----

interface AgentRowProps {
  agent: SecurityAgentStatus;
}

function AgentRow({ agent }: AgentRowProps) {
  const { agentName, status, findingsCount, error } = agent;

  // Icon + label resolved by status
  const icon = (() => {
    switch (status) {
      case 'completed':
        return <CheckCircle size={14} className="text-green-400 shrink-0" />;
      case 'running':
        return <Loader2 size={14} className="text-amber-400 animate-spin shrink-0" />;
      case 'failed':
        return <XCircle size={14} className="text-red-400 shrink-0" />;
      default:
        return <Circle size={14} className="text-zinc-600 shrink-0" />;
    }
  })();

  const statusLabel = (() => {
    switch (status) {
      case 'completed':
        return (
          <span className="text-green-400 text-[11px]">
            concluido{' '}
            <span className="text-zinc-400">({findingsCount} {findingsCount === 1 ? 'finding' : 'findings'})</span>
          </span>
        );
      case 'running':
        return <span className="text-amber-400 text-[11px] animate-pulse">rodando...</span>;
      case 'failed':
        return (
          <span className="text-red-400 text-[11px]" title={error}>
            falhou
            {error ? (
              <span className="text-red-300/70 ml-1 truncate max-w-[120px] inline-block align-bottom">
                {error.length > 40 ? `${error.slice(0, 40)}...` : error}
              </span>
            ) : null}
          </span>
        );
      default:
        return <span className="text-zinc-600 text-[11px]">aguardando</span>;
    }
  })();

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      {icon}
      <span className="flex-1 text-xs text-zinc-300 truncate">{agentName}</span>
      <span className="shrink-0">{statusLabel}</span>
    </div>
  );
}

// ---- Main component ----

export function SecurityAuditProgress({ agents, isStreaming }: SecurityAuditProgressProps) {
  const completedCount = agents.filter((a) => a.status === 'completed').length;
  const runningCount = agents.filter((a) => a.status === 'running').length;

  // Progress bar fill: completed / TOTAL_AGENTS
  const progressPct = Math.round((completedCount / TOTAL_AGENTS) * 100);

  // Overall header badge
  const isDone = completedCount === TOTAL_AGENTS;
  const hasFailed = agents.some((a) => a.status === 'failed');

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Security Audit
        </span>
        <div className="flex items-center gap-2">
          {isDone ? (
            <span className="text-[11px] text-green-400 font-medium">Concluido</span>
          ) : hasFailed ? (
            <span className="text-[11px] text-red-400 font-medium">Erro</span>
          ) : isStreaming || runningCount > 0 ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
              </span>
              <span className="text-[11px] text-amber-300 font-medium">Fase 2</span>
              <Loader2 size={11} className="text-amber-400 animate-spin" />
            </div>
          ) : (
            <span className="text-[11px] text-zinc-600 font-medium">Fase 2</span>
          )}
        </div>
      </div>

      {/* Agent list area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0 flex flex-col">
        {agents.length === 0 && (
          <p className="text-xs text-zinc-600 italic mt-4 text-center">
            {isStreaming ? 'Inicializando agentes...' : 'Nenhum agente registrado ainda.'}
          </p>
        )}

        {agents.length > 0 && (
          <div className="divide-y divide-zinc-800/60">
            {agents.map((agent) => (
              <AgentRow key={agent.agentId} agent={agent} />
            ))}
          </div>
        )}

        {/* Spacer to push footer down */}
        <div className="flex-1" />

        {/* Progress footer */}
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-zinc-400">Progresso</span>
            <span className="text-[11px] font-mono text-zinc-300">
              {completedCount}/{TOTAL_AGENTS} concluidos
            </span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-2 bg-amber-500 rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
