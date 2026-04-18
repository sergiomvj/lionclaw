import { useState, useEffect, useCallback } from 'react';
import { X, Save, RefreshCw } from 'lucide-react';
import type { AgentConfig, MCPServerConfig, Skill } from '@/types';

const TOOL_IDS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
  'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'AskUserQuestion',
] as const;

const LOCAL_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch',
] as const;

const AVAILABLE_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6', runtime: 'cloud' as const },
  { value: 'opus', label: 'Claude Opus 4.7', runtime: 'cloud' as const },
  { value: 'haiku', label: 'Claude Haiku 4.5', runtime: 'cloud' as const },
  { value: 'local', label: 'Modelo Local (Ollama/LM Studio)', runtime: 'local' as const },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const THINKING_OPTIONS = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

interface AgentFormModalProps {
  mode: 'create' | 'edit';
  agent?: AgentConfig;
  existingSquads?: string[];
  onSave: (agent: Omit<AgentConfig, 'sortOrder'>) => Promise<void>;
  onClose: () => void;
}

export function AgentFormModal({ mode, agent, existingSquads = [], onSave, onClose }: AgentFormModalProps) {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [runtime, setRuntime] = useState<'cloud' | 'local'>(agent?.runtime || 'cloud');
  const [model, setModel] = useState(agent?.runtime === 'local' ? 'local' : (agent?.model || 'sonnet'));
  const [localProvider, setLocalProvider] = useState<string>(agent?.localConfig?.provider || 'ollama');
  const [localBaseUrl, setLocalBaseUrl] = useState(agent?.localConfig?.baseUrl || 'http://localhost:11434');
  const [localModel, setLocalModel] = useState(agent?.localConfig?.model || '');
  const [localTemperature, setLocalTemperature] = useState<string>(agent?.localConfig?.temperature?.toString() || '0.7');
  const [localMaxTokens, setLocalMaxTokens] = useState<string>(agent?.localConfig?.maxTokens?.toString() || '');
  const [localMode, setLocalMode] = useState<'simple' | 'smart'>(agent?.localMode || 'simple');
  const [maxToolRounds, setMaxToolRounds] = useState<string>(agent?.maxToolRounds?.toString() || '5');
  const [effort, setEffort] = useState<AgentConfig['effort']>(agent?.effort || 'medium');
  const [thinking, setThinking] = useState<AgentConfig['thinking']>(agent?.thinking || 'adaptive');
  const [thinkingBudget, setThinkingBudget] = useState<string>(agent?.thinkingBudget?.toString() || '');
  const [maxTurns, setMaxTurns] = useState<string>(agent?.maxTurns?.toString() || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(agent?.allowedTools || []));
  const [mcpServers, setMcpServers] = useState<Set<string>>(new Set(agent?.mcpServers || []));
  const [skills, setSkills] = useState<Set<string>>(new Set(agent?.skills || []));
  const [squad, setSquad] = useState<string>(agent?.squad || 'Desenvolvimento');

  // External data for checkboxes
  const [globalTools, setGlobalTools] = useState<string[]>([]);
  const [availableMCP, setAvailableMCP] = useState<MCPServerConfig[]>([]);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState(false);

  // Local model discovery
  const [availableLocalModels, setAvailableLocalModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const fetchLocalModels = useCallback(async (provider: string, baseUrl: string) => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const result = await window.lionclaw.ollama.listModels(provider, baseUrl);
      if (result.error) {
        setModelsError(result.error);
        setAvailableLocalModels([]);
      } else {
        setAvailableLocalModels(result.models);
        // Auto-select first model if none selected
        if (result.models.length > 0 && !localModel) {
          setLocalModel(result.models[0]);
        }
      }
    } catch {
      setModelsError('Falha ao conectar');
      setAvailableLocalModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [localModel]);

  useEffect(() => {
    Promise.all([
      window.lionclaw.tools.getEnabled(),
      window.lionclaw.mcp.list(),
      window.lionclaw.skills.list(),
    ]).then(([tools, mcp, sk]) => {
      setGlobalTools(tools);
      setAvailableMCP(mcp.filter((s) => s.isActive));
      setAvailableSkills(sk);
    });
  }, []);

  // Fetch models when local config changes
  useEffect(() => {
    if (runtime === 'local' && localBaseUrl) {
      fetchLocalModels(localProvider, localBaseUrl);
    }
  }, [runtime, localProvider, localBaseUrl, fetchLocalModels]);

  const toggleTool = (tool: string) => {
    const next = new Set(allowedTools);
    if (next.has(tool)) next.delete(tool);
    else next.add(tool);
    setAllowedTools(next);
  };

  const toggleMCP = (id: string) => {
    const next = new Set(mcpServers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMcpServers(next);
  };

  const toggleSkill = (skillName: string) => {
    const next = new Set(skills);
    if (next.has(skillName)) next.delete(skillName);
    else next.add(skillName);
    setSkills(next);
  };

  const isValid =
    name.trim().length >= 2 &&
    name.trim().length <= 30 &&
    description.trim().length >= 5 &&
    systemPrompt.trim().length >= 10;

  const handleSave = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      await onSave({
        id: agent?.id || name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        model: runtime === 'local' ? 'haiku' : model,
        allowedTools: runtime === 'local' && localMode === 'simple' ? [] : Array.from(allowedTools),
        mcpServers: runtime === 'local' ? [] : Array.from(mcpServers),
        isActive: agent?.isActive ?? true,
        effort,
        thinking,
        thinkingBudget: thinking === 'enabled' && thinkingBudget ? parseInt(thinkingBudget, 10) : undefined,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
        skills: runtime === 'local' ? [] : Array.from(skills),
        runtime,
        localConfig: runtime === 'local' ? {
          provider: localProvider as 'ollama' | 'lmstudio' | 'openai-compatible',
          baseUrl: localBaseUrl,
          model: localModel,
          temperature: localTemperature ? parseFloat(localTemperature) : undefined,
          maxTokens: localMaxTokens ? parseInt(localMaxTokens, 10) : undefined,
        } : undefined,
        localMode: runtime === 'local' ? localMode : undefined,
        maxToolRounds: runtime === 'local' && localMode === 'smart' ? parseInt(maxToolRounds, 10) || 5 : undefined,
        squad,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-lg mx-4 max-h-[90vh] rounded-xl border border-zinc-700 bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">
            {mode === 'create' ? 'Novo Subagente' : `Editar: ${agent?.name}`}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name + Description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Nome</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Coder"
                maxLength={30}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Descricao</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ex: Especialista em codigo e arquitetura"
                maxLength={200}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Squad</label>
              <input
                list="squad-options"
                value={squad}
                onChange={(e) => setSquad(e.target.value)}
                placeholder="Ex: Desenvolvimento"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
              <datalist id="squad-options">
                {existingSquads.map((sq) => (
                  <option key={sq} value={sq} />
                ))}
              </datalist>
            </div>
          </div>

          {/* Model & Performance */}
          <div>
            <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Modelo e Performance</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                <select
                  value={model}
                  onChange={(e) => {
                    const selected = AVAILABLE_MODELS.find((m) => m.value === e.target.value);
                    setModel(e.target.value);
                    setRuntime(selected?.runtime || 'cloud');
                    if (selected?.runtime === 'local' && localProvider === 'ollama') {
                      setLocalBaseUrl('http://localhost:11434');
                    }
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {AVAILABLE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              {runtime !== 'local' && (
                <>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                    >
                      {EFFORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Thinking</label>
                    <select
                      value={thinking}
                      onChange={(e) => setThinking(e.target.value as AgentConfig['thinking'])}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                    >
                      {THINKING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  {thinking === 'enabled' && (
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Budget (tokens)</label>
                      <input
                        type="number"
                        value={thinkingBudget}
                        onChange={(e) => setThinkingBudget(e.target.value)}
                        placeholder="Ex: 10000"
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Max Turnos</label>
                    <input
                      type="number"
                      value={maxTurns}
                      onChange={(e) => setMaxTurns(e.target.value)}
                      placeholder="Sem limite"
                      min={1}
                      max={100}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Local Model Config */}
          {runtime === 'local' && (
            <div className="space-y-3 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-amber-400 uppercase tracking-wide">Configuracao Local</h5>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Provider</label>
                  <select
                    value={localProvider}
                    onChange={(e) => {
                      setLocalProvider(e.target.value);
                      if (e.target.value === 'ollama') setLocalBaseUrl('http://localhost:11434');
                      else if (e.target.value === 'lmstudio') setLocalBaseUrl('http://localhost:1234');
                    }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="openai-compatible">OpenAI Compatible</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Base URL</label>
                  <input
                    value={localBaseUrl}
                    onChange={(e) => setLocalBaseUrl(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1 flex items-center gap-2">
                    Modelo
                    <button
                      type="button"
                      onClick={() => fetchLocalModels(localProvider, localBaseUrl)}
                      disabled={loadingModels}
                      className="text-zinc-500 hover:text-amber-400 transition-colors"
                      title="Atualizar lista de modelos"
                    >
                      <RefreshCw size={10} className={loadingModels ? 'animate-spin' : ''} />
                    </button>
                  </label>
                  {availableLocalModels.length > 0 ? (
                    <select
                      value={localModel}
                      onChange={(e) => setLocalModel(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                    >
                      {!localModel && <option value="">Selecione um modelo</option>}
                      {availableLocalModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm">
                      {loadingModels ? (
                        <span className="text-zinc-500">Buscando modelos...</span>
                      ) : modelsError ? (
                        <span className="text-red-400">{modelsError}</span>
                      ) : (
                        <span className="text-zinc-500">Nenhum modelo encontrado</span>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={localTemperature}
                    onChange={(e) => setLocalTemperature(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              {/* Modo de Execucao */}
              <div className="pt-2 border-t border-zinc-700/50">
                <label className="block text-xs text-zinc-400 mb-2">Modo de Execucao</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLocalMode('simple')}
                    className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                      localMode === 'simple'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Simple
                    <span className="block text-[10px] font-normal mt-0.5 opacity-70">Text-in, text-out</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocalMode('smart')}
                    className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                      localMode === 'smart'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Smart
                    <span className="block text-[10px] font-normal mt-0.5 opacity-70">Com tool calling</span>
                  </button>
                </div>
              </div>

              {/* Max Tool Rounds (smart mode only) */}
              {localMode === 'smart' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Tool Rounds</label>
                  <input
                    type="number"
                    value={maxToolRounds}
                    onChange={(e) => setMaxToolRounds(e.target.value)}
                    min={1}
                    max={20}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">Limite de rounds de tool calling por request (1-20)</p>
                </div>
              )}
            </div>
          )}

          {/* Tools - filtered by runtime */}
          {!(runtime === 'local' && localMode === 'simple') && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Ferramentas</h4>
              <div className="flex flex-wrap gap-2">
                {runtime === 'local' ? (
                  // Local smart: only primitive tools
                  LOCAL_ALLOWED_TOOLS.map((id) => (
                    <button
                      key={id}
                      onClick={() => toggleTool(id)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                        allowedTools.has(id)
                          ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                          : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {id}
                    </button>
                  ))
                ) : (
                  // Cloud: all tools enabled globally
                  <>
                    {TOOL_IDS.filter((id) => globalTools.includes(id)).map((id) => (
                      <button
                        key={id}
                        onClick={() => toggleTool(id)}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                          allowedTools.has(id)
                            ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                            : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {id}
                      </button>
                    ))}
                    {globalTools.length === 0 && (
                      <span className="text-xs text-zinc-600">Carregando ferramentas...</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* MCP Servers - hidden for local agents */}
          {runtime !== 'local' && availableMCP.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">MCP Servers</h4>
              <div className="flex flex-wrap gap-2">
                {availableMCP.map((server) => (
                  <button
                    key={server.id}
                    onClick={() => toggleMCP(server.id)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                      mcpServers.has(server.id)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Skills - hidden for local agents */}
          {runtime !== 'local' && availableSkills.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Skills</h4>
              <div className="flex flex-wrap gap-2">
                {availableSkills.map((skill) => (
                  <button
                    key={skill.name}
                    onClick={() => toggleSkill(skill.name)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                      skills.has(skill.name)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                    title={skill.description}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* System Prompt */}
          <div>
            <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">
              {runtime === 'local' ? 'RULES.md do Agente' : 'System Prompt'}
            </h4>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={runtime === 'local'
                ? 'Ex: Voce e um agente especializado em...\nResponda SEMPRE em portugues brasileiro.'
                : 'Ex: Voce e um especialista em...'
              }
              rows={runtime === 'local' ? 12 : 6}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors resize-y font-mono"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Save size={14} />
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
