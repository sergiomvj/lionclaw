import { useState, useEffect } from 'react';
import { Bot, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import type { AgentConfig } from '@/types';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import { DeleteAgentDialog } from '@/components/agents/DeleteAgentDialog';
import { PROVIDER_PRESETS } from '@/lib/provider-presets';
import { resolveContextWindow, formatContextWindow } from '@/lib/agent-helpers';

const BADGE_BG = '#F97316';
const BADGE_FG = '#FFFFFF';
const BADGE_CLASS = 'px-1.5 py-0.5 rounded text-[10px] font-medium cursor-default';

function RuntimeBadge({ agent }: { agent: AgentConfig }) {
  if (agent.runtime === 'cloud') {
    return (
      <span
        title={`Modelo: ${agent.model}`}
        style={{ backgroundColor: BADGE_BG, color: BADGE_FG }}
        className={BADGE_CLASS}
      >
        Anthropic
      </span>
    );
  }

  if (agent.runtime === 'local') {
    const provider = agent.localConfig?.provider ?? 'local';
    const model = agent.localConfig?.model ?? '';
    return (
      <div className="flex items-center gap-1">
        <span
          title={`${provider} / ${model}`}
          style={{ backgroundColor: BADGE_BG, color: BADGE_FG }}
          className={BADGE_CLASS}
        >
          Local
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
          {agent.localMode === 'smart' ? 'SMART' : 'SIMPLE'}
        </span>
      </div>
    );
  }

  if (agent.runtime === 'external' && agent.externalConfig) {
    const { provider, model } = agent.externalConfig;
    const label = PROVIDER_PRESETS[provider]?.label ?? provider;
    const cw = resolveContextWindow(agent);
    const cwText = cw !== null ? ` (${formatContextWindow(cw)})` : '';
    const tooltipText = `${model}${cwText}`;
    return (
      <span
        title={tooltipText}
        style={{ backgroundColor: BADGE_BG, color: BADGE_FG }}
        className={BADGE_CLASS}
      >
        {label}
      </span>
    );
  }

  if (agent.runtime === 'codex' && agent.codexConfig) {
    const { model } = agent.codexConfig;
    return (
      <div className="flex items-center gap-1">
        <span
          title={`Codex / ${model}`}
          className={`${BADGE_CLASS} bg-purple-600/20 text-purple-400 border border-purple-600/30`}
          style={undefined}
        >
          Codex
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
          {model}
        </span>
      </div>
    );
  }

  return null;
}

export function SubAgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [formModal, setFormModal] = useState<{ mode: 'create' | 'edit'; agent?: AgentConfig } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentConfig | null>(null);
  const [activeSquad, setActiveSquad] = useState<string>('all');

  const squads = Array.from(new Set(agents.map((a) => a.squad).filter(Boolean))) as string[];

  const loadAgents = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.agents.list();
    setAgents(result);
    setIsLoading(false);
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const toggleActive = async (agent: AgentConfig) => {
    await window.lionclaw.agents.update(agent.id, { isActive: !agent.isActive });
    loadAgents();
  };

  const handleSave = async (agentData: Omit<AgentConfig, 'sortOrder'>) => {
    if (formModal?.mode === 'edit' && formModal.agent) {
      await window.lionclaw.agents.update(formModal.agent.id, agentData);
    } else {
      await window.lionclaw.agents.create(agentData);
    }
    loadAgents();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await window.lionclaw.agents.delete(deleteTarget.id);
    setDeleteTarget(null);
    loadAgents();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">SubAgents</h1>
            <p className="text-sm text-zinc-500 mt-1">Agentes especializados do LionClaw</p>
          </div>
          <button
            onClick={() => setFormModal({ mode: 'create' })}
            className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Novo Agente
          </button>
        </div>

        {/* Squad tabs */}
        {squads.length > 0 && (
          <div className="flex items-center gap-1 mb-5 border-b border-zinc-800">
            <button
              onClick={() => setActiveSquad('all')}
              className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                activeSquad === 'all'
                  ? 'border-amber-500 text-amber-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Todos
              <span className="ml-1.5 text-[10px] opacity-60">{agents.length}</span>
            </button>
            {squads.map((sq) => {
              const count = agents.filter((a) => a.squad === sq).length;
              return (
                <button
                  key={sq}
                  onClick={() => setActiveSquad(sq)}
                  className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                    activeSquad === sq
                      ? 'border-amber-500 text-amber-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {sq}
                  <span className="ml-1.5 text-[10px] opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Agent cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.filter((a) => activeSquad === 'all' || a.squad === activeSquad).map((agent) => (
            <div
              key={agent.id}
              className={`bg-zinc-900 border rounded-xl p-4 transition-colors ${
                agent.isActive ? 'border-zinc-800' : 'border-zinc-800/50 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <Bot size={18} className="text-amber-500" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-200">{agent.name}</h3>
                      <RuntimeBadge agent={agent} />
                    </div>
                    <p className="text-xs text-zinc-500">
                      {agent.runtime === 'local' ? (
                        <span className="text-green-400">{agent.localConfig?.provider} - {agent.localConfig?.model}</span>
                      ) : agent.runtime === 'external' ? (
                        <span style={{ color: '#C2410C' }}>{agent.externalConfig?.model}</span>
                      ) : (
                        agent.model
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => toggleActive(agent)}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                    title={agent.isActive ? 'Desativar' : 'Ativar'}
                  >
                    {agent.isActive ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button
                    onClick={() => setFormModal({ mode: 'edit', agent })}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                    title="Editar"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(agent)}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                    title="Excluir"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <p className="text-xs text-zinc-400 mb-3">{agent.description}</p>

              {/* Tools */}
              <div className="flex flex-wrap gap-1 mb-2">
                {agent.allowedTools.slice(0, 5).map((tool) => (
                  <span
                    key={tool}
                    className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400"
                  >
                    {tool}
                  </span>
                ))}
                {agent.allowedTools.length > 5 && (
                  <span className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
                    +{agent.allowedTools.length - 5}
                  </span>
                )}
              </div>

              {/* Skills + Effort/Thinking */}
              <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span>Effort: {agent.effort}</span>
                <span>|</span>
                <span>Thinking: {agent.thinking}</span>
                {agent.skills.length > 0 && (
                  <>
                    <span>|</span>
                    <span>Skills: {agent.skills.join(', ')}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modals */}
      {formModal && (
        <AgentFormModal
          mode={formModal.mode}
          agent={formModal.agent}
          existingSquads={squads}
          onSave={handleSave}
          onClose={() => setFormModal(null)}
        />
      )}

      {deleteTarget && (
        <DeleteAgentDialog
          agentName={deleteTarget.name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
