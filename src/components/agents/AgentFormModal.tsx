import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Save, RefreshCw, AlertTriangle, Key, Wifi } from 'lucide-react';
import type { AgentConfig, ExternalConfig, ExternalProvider, CodexConfig, MCPServerConfig, Skill } from '@/types';
import { PROVIDER_PRESETS, MODEL_CATALOG } from '@/lib/provider-presets';
import type { CatalogedModel } from '@/lib/provider-presets';
import { ApiKeyStatusIndicator } from './ApiKeyStatusIndicator';
import type { ApiKeyStatus } from './ApiKeyStatusIndicator';
import { ContextWindowDisplay } from './ContextWindowDisplay';
import { CODEX_MODELS, CODEX_DEFAULT_MODEL, CODEX_REASONING_EFFORT } from '@/constants/codex-models';

const TOOL_IDS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
  'Bash', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'AskUserQuestion',
] as const;

const LOCAL_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch',
] as const;

const CLOUD_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'opus', label: 'Claude Opus 4.7' },
  { value: 'haiku', label: 'Claude Haiku 4.5' },
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

const EXTERNAL_PROVIDERS: Array<{ value: ExternalProvider; label: string }> = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'Custom (OpenAI Compatible)' },
];

// Returns true if the model+provider combo supports explicit reasoning params
// (used to enable/disable effort/thinking fields in the UI, SPEC 3.10.3 and 3.10.4)
function modelSupportsReasoning(provider: ExternalProvider, model: string): boolean {
  if (provider === 'openai') {
    return model.startsWith('gpt-5.5') || model.startsWith('o');
  }
  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-5')) return true;
    if (model.startsWith('qwen/qwen3.6') ) return true;
  }
  return false;
}

// Checks whether the model notes mention surcharge / 2x pricing warning
function modelHasSurchargeWarning(notes?: string): boolean {
  if (!notes) return false;
  return notes.includes('surcharge') || notes.includes('2x') || notes.includes('>272k');
}

interface AgentFormModalProps {
  mode: 'create' | 'edit';
  agent?: AgentConfig;
  existingSquads?: string[];
  onSave: (agent: Omit<AgentConfig, 'sortOrder'>) => Promise<void>;
  onClose: () => void;
}

export function AgentFormModal({ mode, agent, existingSquads = [], onSave, onClose }: AgentFormModalProps) {
  // Shared fields
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [runtime, setRuntime] = useState<'cloud' | 'local' | 'external' | 'codex'>(agent?.runtime || 'cloud');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(agent?.allowedTools || []));
  const [mcpServers, setMcpServers] = useState<Set<string>>(new Set(agent?.mcpServers || []));
  const [skills, setSkills] = useState<Set<string>>(new Set(agent?.skills || []));
  const [squad, setSquad] = useState<string>(agent?.squad || 'Desenvolvimento');
  const [effort, setEffort] = useState<AgentConfig['effort']>(agent?.effort || 'medium');
  const [thinking, setThinking] = useState<AgentConfig['thinking']>(agent?.thinking || 'adaptive');
  const [thinkingBudget, setThinkingBudget] = useState<string>(agent?.thinkingBudget?.toString() || '');

  // Cloud-specific
  const [cloudModel, setCloudModel] = useState<string>(
    agent?.runtime !== 'local' && agent?.runtime !== 'external' ? (agent?.model || 'sonnet') : 'sonnet',
  );
  const [maxTurns, setMaxTurns] = useState<string>(agent?.maxTurns?.toString() || '');

  // Local-specific
  const [localProvider, setLocalProvider] = useState<string>(agent?.localConfig?.provider || 'ollama');
  const [localBaseUrl, setLocalBaseUrl] = useState(agent?.localConfig?.baseUrl || 'http://localhost:11434');
  const [localModel, setLocalModel] = useState(agent?.localConfig?.model || '');
  const [localTemperature, setLocalTemperature] = useState<string>(agent?.localConfig?.temperature?.toString() || '0.7');
  const [localMaxTokens] = useState<string>(agent?.localConfig?.maxTokens?.toString() || '');
  const [localMode, setLocalMode] = useState<'simple' | 'smart'>(agent?.localMode || 'simple');
  const [maxToolRounds, setMaxToolRounds] = useState<string>(agent?.maxToolRounds?.toString() || '5');
  const [availableLocalModels, setAvailableLocalModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // External-specific
  const [extProvider, setExtProvider] = useState<ExternalProvider>(
    agent?.externalConfig?.provider || 'openrouter',
  );
  const [extBaseUrl, setExtBaseUrl] = useState<string>(
    agent?.externalConfig?.baseUrl || PROVIDER_PRESETS['openrouter']?.baseUrl || '',
  );
  const [extModel, setExtModel] = useState<string>(
    agent?.externalConfig?.model || PROVIDER_PRESETS['openrouter']?.defaultModel || '',
  );
  const [extApiKeyInput, setExtApiKeyInput] = useState<string>('');
  // apiKeyRef stored: either from existing config or from the preset
  const [extApiKeyRef, setExtApiKeyRef] = useState<string>(
    agent?.externalConfig?.apiKeyRef || PROVIDER_PRESETS['openrouter']?.vaultKey || '',
  );
  const [extTemperature, setExtTemperature] = useState<string>(
    agent?.externalConfig?.temperature?.toString() || '',
  );
  const [extMaxTokens, setExtMaxTokens] = useState<string>(
    agent?.externalConfig?.maxTokens?.toString() || '',
  );
  // Custom-provider-only fields
  const [extCustomVaultSlug, setExtCustomVaultSlug] = useState<string>('');
  const [extExtraHeaders, setExtExtraHeaders] = useState<string>(
    agent?.externalConfig?.extraHeaders ? JSON.stringify(agent.externalConfig.extraHeaders, null, 2) : '',
  );
  const [extContextWindow, setExtContextWindow] = useState<string>(
    agent?.externalConfig?.contextWindow?.toString() || '',
  );
  const [extMaxToolRounds, setExtMaxToolRounds] = useState<string>(
    agent?.runtime === 'external' && agent.maxToolRounds ? agent.maxToolRounds.toString() : '5',
  );

  // Codex-specific. Sandbox is fixed at 'workspace-write' (the only sensible default
  // for coding agents — read-only blocks writes, danger-full-access is unsafe via UI).
  const [codexModel, setCodexModel] = useState<string>(
    agent?.codexConfig?.model || CODEX_DEFAULT_MODEL,
  );
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<'low' | 'medium' | 'high'>(
    agent?.codexConfig?.reasoningEffort || 'medium',
  );

  // Codex connection status (queried via IPC on mount and after Reconnect)
  const [codexStatus, setCodexStatus] = useState<{
    installed: boolean;
    version: string | null;
    authenticated: boolean;
  } | null>(null);
  const [codexTestResult, setCodexTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [codexTesting, setCodexTesting] = useState(false);

  const refreshCodexStatus = useCallback(async () => {
    try {
      const status = await window.lionclaw.codex.status();
      setCodexStatus(status);
    } catch {
      setCodexStatus({ installed: false, version: null, authenticated: false });
    }
  }, []);

  useEffect(() => {
    if (runtime === 'codex') void refreshCodexStatus();
  }, [runtime, refreshCodexStatus]);

  const handleCodexLogin = useCallback(async () => {
    await window.lionclaw.codex.openLogin();
  }, []);

  const handleCodexTest = useCallback(async () => {
    setCodexTesting(true);
    try {
      const result = await window.lionclaw.codex.test();
      setCodexTestResult(result);
      if (result.ok) await refreshCodexStatus();
    } finally {
      setCodexTesting(false);
    }
  }, [refreshCodexStatus]);

  // API Key status indicator
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('unconfigured');
  const [apiKeyError, setApiKeyError] = useState<string>('');

  // External data for checkboxes
  const [globalTools, setGlobalTools] = useState<string[]>([]);
  const [availableMCP, setAvailableMCP] = useState<MCPServerConfig[]>([]);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState(false);

  // Track whether vault key was already configured when the form opened
  const initializedRef = useRef(false);

  // Init: check existing key status
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    Promise.all([
      window.lionclaw.tools.getEnabled(),
      window.lionclaw.mcp.list(),
      window.lionclaw.skills.list(),
    ]).then(([tools, mcp, sk]) => {
      setGlobalTools(tools);
      setAvailableMCP(mcp.filter((s) => s.isActive));
      setAvailableSkills(sk);
    });

    // If editing an external agent, check if key already configured
    if (agent?.runtime === 'external' && agent.externalConfig?.apiKeyRef) {
      window.lionclaw.vault.check(agent.externalConfig.apiKeyRef).then((configured) => {
        setApiKeyStatus(configured ? 'saved' : 'unconfigured');
      });
      // Restore custom vault slug from apiKeyRef if custom provider
      if (agent.externalConfig.provider === 'openai-compatible') {
        const ref = agent.externalConfig.apiKeyRef;
        // Pattern: HARNESS_CUSTOM_<SLUG>_KEY
        const match = /^HARNESS_CUSTOM_(.+)_KEY$/.exec(ref);
        if (match) setExtCustomVaultSlug(match[1].toLowerCase());
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Local model discovery
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
    if (runtime === 'local' && localBaseUrl) {
      fetchLocalModels(localProvider, localBaseUrl);
    }
  }, [runtime, localProvider, localBaseUrl, fetchLocalModels]);

  useEffect(() => {
    if (runtime !== 'external') return;
    if (!extApiKeyRef) return;
    if (apiKeyStatus === 'ok' || apiKeyStatus === 'testing' || apiKeyStatus === 'error') return;
    let cancelled = false;
    window.lionclaw.vault.check(extApiKeyRef).then((configured) => {
      if (cancelled) return;
      setApiKeyStatus(configured ? 'saved' : 'unconfigured');
    });
    return () => { cancelled = true; };
  }, [runtime, extApiKeyRef, apiKeyStatus]);

  // Provider change: auto-fill baseUrl and reset model
  const handleProviderChange = (provider: ExternalProvider) => {
    setExtProvider(provider);
    setApiKeyStatus('unconfigured');
    setApiKeyError('');
    setExtApiKeyInput('');

    if (provider === 'openai-compatible') {
      setExtBaseUrl('');
      setExtModel('');
      setExtApiKeyRef('');
    } else {
      const preset = PROVIDER_PRESETS[provider];
      setExtBaseUrl(preset?.baseUrl || '');
      setExtModel(preset?.defaultModel || '');
      setExtApiKeyRef(preset?.vaultKey || '');

      // Check if key is already in vault
      if (preset?.vaultKey) {
        window.lionclaw.vault.check(preset.vaultKey).then((configured) => {
          if (configured) setApiKeyStatus('saved');
        });
      }
    }
  };

  // API Key: save to vault then auto-test
  const handleSaveAndTestKey = async () => {
    const keyValue = extApiKeyInput.trim();
    if (!keyValue) return;

    const vaultKey = resolveVaultKey();
    if (!vaultKey) return;

    setApiKeyStatus('testing');
    setApiKeyError('');

    try {
      if (extProvider === 'openai-compatible') {
        // Custom: use vault:register-and-set to register entry first
        const entryLabel = extCustomVaultSlug
          ? `Custom Provider (${extCustomVaultSlug})`
          : 'Custom Provider API Key';
        const result = await window.lionclaw.vault.registerAndSet(
          {
            key: vaultKey,
            label: entryLabel,
            description: 'API key para provider customizado OpenAI-compatible',
            service: 'LionClaw-Custom',
            required: false,
          },
          keyValue,
        );
        if ('error' in result) {
          setApiKeyStatus('error');
          setApiKeyError(result.error);
          return;
        }
      } else {
        // Known provider: use vault:set (key already registered in seed)
        await window.lionclaw.vault.set(vaultKey, keyValue);
      }

      // Auto-test immediately after save
      const testResult = await window.lionclaw.provider.testConnection(
        extProvider,
        extBaseUrl,
        vaultKey,
      );

      if (testResult.ok) {
        setApiKeyStatus('ok');
        setExtApiKeyInput('');
      } else {
        setApiKeyStatus('error');
        setApiKeyError('error' in testResult ? testResult.error : 'Falha no teste de conexao.');
      }
    } catch (err) {
      setApiKeyStatus('error');
      setApiKeyError(err instanceof Error ? err.message : 'Erro inesperado.');
    }
  };

  // Standalone test (key already in vault)
  const handleTestKey = async () => {
    const vaultKey = resolveVaultKey();
    if (!vaultKey) return;

    setApiKeyStatus('testing');
    setApiKeyError('');

    try {
      const testResult = await window.lionclaw.provider.testConnection(
        extProvider,
        extBaseUrl,
        vaultKey,
      );
      if (testResult.ok) {
        setApiKeyStatus('ok');
      } else {
        setApiKeyStatus('error');
        setApiKeyError('error' in testResult ? testResult.error : 'Falha no teste de conexao.');
      }
    } catch (err) {
      setApiKeyStatus('error');
      setApiKeyError(err instanceof Error ? err.message : 'Erro inesperado.');
    }
  };

  // Vault key derivation for custom provider
  const resolveVaultKey = (): string => {
    if (extProvider === 'openai-compatible') {
      const slug = extCustomVaultSlug.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
      return slug ? `HARNESS_CUSTOM_${slug}_KEY` : '';
    }
    return extApiKeyRef || PROVIDER_PRESETS[extProvider]?.vaultKey || '';
  };

  // Toggle helpers
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

  // Validation
  const baseFieldsValid =
    name.trim().length >= 2 &&
    name.trim().length <= 50 &&
    description.trim().length >= 5 &&
    systemPrompt.trim().length >= 10;

  const externalKeyBlocking = runtime === 'external' && apiKeyStatus !== 'ok';

  const isValid = baseFieldsValid && !externalKeyBlocking;

  // Derived state for external section
  const catalogModels: CatalogedModel[] = extProvider !== 'openai-compatible'
    ? (MODEL_CATALOG[extProvider] ?? [])
    : [];

  const selectedCatalogModel = catalogModels.find((m) => m.id === extModel);
  const reasoningSupported = modelSupportsReasoning(extProvider, extModel);
  const hasSurcharge = modelHasSurchargeWarning(selectedCatalogModel?.notes);

  // Build the AgentConfig snapshot for ContextWindowDisplay
  const agentSnapshot: AgentConfig = {
    id: '',
    name: name || '',
    description: '',
    systemPrompt: '',
    model: cloudModel,
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort,
    thinking,
    skills: [],
    runtime,
    externalConfig: runtime === 'external' ? buildExternalConfig() : undefined,
  };

  function buildExternalConfig(): ExternalConfig {
    const vaultKey = resolveVaultKey();
    let parsedHeaders: Record<string, string> | undefined;
    if (extProvider !== 'openai-compatible') {
      parsedHeaders = PROVIDER_PRESETS[extProvider]?.extraHeaders;
    } else {
      try {
        parsedHeaders = extExtraHeaders.trim() ? JSON.parse(extExtraHeaders) as Record<string, string> : undefined;
      } catch {
        parsedHeaders = undefined;
      }
    }

    return {
      provider: extProvider,
      baseUrl: extBaseUrl,
      model: extModel,
      apiKeyRef: vaultKey,
      temperature: extTemperature ? parseFloat(extTemperature) : undefined,
      maxTokens: extMaxTokens ? parseInt(extMaxTokens, 10) : undefined,
      extraHeaders: parsedHeaders,
      contextWindow: extProvider === 'openai-compatible' && extContextWindow
        ? parseInt(extContextWindow, 10)
        : undefined,
    };
  }

  function buildCodexConfig(): CodexConfig | undefined {
    if (runtime !== 'codex') return undefined;
    // sandbox is hardcoded to 'workspace-write' — only sensible default for coding
    // agents. Not exposed in UI to avoid confusion with LionClaw permission system
    // (which is fully bypassed for codex per SPEC D3).
    return {
      model: codexModel,
      sandbox: 'workspace-write',
      reasoningEffort: codexReasoningEffort,
    };
  }

  // Save
  const handleSave = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      const externalCfg = runtime === 'external' ? buildExternalConfig() : undefined;

      await onSave({
        id: agent?.id || name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        model:
          runtime === 'local'
            ? 'haiku'
            : runtime === 'codex'
              ? codexModel
              : cloudModel,
        allowedTools:
          runtime === 'local' && localMode === 'simple'
            ? []
            : runtime === 'codex'
              ? []
              : Array.from(allowedTools),
        mcpServers: runtime === 'local' || runtime === 'codex' ? [] : Array.from(mcpServers),
        isActive: agent?.isActive ?? true,
        effort,
        thinking,
        thinkingBudget: thinking === 'enabled' && thinkingBudget ? parseInt(thinkingBudget, 10) : undefined,
        maxTurns: runtime !== 'external' && runtime !== 'codex' && maxTurns ? parseInt(maxTurns, 10) : undefined,
        skills: runtime === 'local' || runtime === 'codex' ? [] : Array.from(skills),
        runtime,
        localConfig: runtime === 'local' ? {
          provider: localProvider as 'ollama' | 'lmstudio' | 'openai-compatible',
          baseUrl: localBaseUrl,
          model: localModel,
          temperature: localTemperature ? parseFloat(localTemperature) : undefined,
          maxTokens: localMaxTokens ? parseInt(localMaxTokens, 10) : undefined,
        } : undefined,
        localMode: runtime === 'local' ? localMode : undefined,
        maxToolRounds:
          runtime === 'external'
            ? parseInt(extMaxToolRounds, 10) || 5
            : runtime === 'local' && localMode === 'smart'
              ? parseInt(maxToolRounds, 10) || 5
              : undefined,
        externalConfig: externalCfg,
        codexConfig: buildCodexConfig(),
        squad,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const vaultKeyResolved = resolveVaultKey();
  const canSaveKey = extApiKeyInput.trim().length > 0 && (
    extProvider !== 'openai-compatible' || extCustomVaultSlug.trim().length > 0
  ) && extBaseUrl.trim().length > 0;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-lg mx-4 max-h-[90vh] rounded-xl border border-zinc-700 bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">
            {mode === 'create' ? 'Novo Subagente' : `Editar: ${agent?.name}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name, Description, Squad */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Nome</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Coder"
                maxLength={50}
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

          {/* Runtime Selector */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Runtime</label>
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as 'cloud' | 'local' | 'external' | 'codex')}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
            >
              <option value="cloud">Cloud (Claude SDK)</option>
              <option value="local">Local (Ollama / LM Studio)</option>
              <option value="external">External (OpenRouter, OpenAI, Custom)</option>
              <option value="codex">Codex (OpenAI via OAuth)</option>
            </select>
          </div>

          {/* CLOUD SECTION */}
          {runtime === 'cloud' && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Modelo e Performance</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                  <select
                    value={cloudModel}
                    onChange={(e) => setCloudModel(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {CLOUD_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
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
              </div>
            </div>
          )}

          {/* LOCAL SECTION */}
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

              {localMode === 'smart' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Tool Rounds</label>
                  <input
                    type="number"
                    value={maxToolRounds}
                    onChange={(e) => setMaxToolRounds(e.target.value)}
                    min={1}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">Limite de rounds de tool calling por request.</p>
                </div>
              )}
            </div>
          )}

          {/* EXTERNAL SECTION */}
          {runtime === 'external' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-blue-400 uppercase tracking-wide">Configuracao External</h5>

              {/* Provider */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Provider</label>
                <select
                  value={extProvider}
                  onChange={(e) => handleProviderChange(e.target.value as ExternalProvider)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {EXTERNAL_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Base URL</label>
                <input
                  value={extBaseUrl}
                  onChange={(e) => setExtBaseUrl(e.target.value)}
                  placeholder="https://openrouter.ai/api/v1"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  readOnly={extProvider !== 'openai-compatible'}
                />
                {extProvider !== 'openai-compatible' && (
                  <p className="text-[10px] text-zinc-600 mt-1">Auto-preenchido pelo preset do provider.</p>
                )}
              </div>

              {/* Custom-only: vault key slug */}
              {extProvider === 'openai-compatible' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Nome da chave no Vault (prefixo HARNESS_CUSTOM_)
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 whitespace-nowrap">HARNESS_CUSTOM_</span>
                    <input
                      value={extCustomVaultSlug}
                      onChange={(e) => setExtCustomVaultSlug(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      placeholder="MEUPROVIDER"
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors uppercase"
                    />
                    <span className="text-xs text-zinc-500 whitespace-nowrap">_KEY</span>
                  </div>
                  {extCustomVaultSlug && (
                    <p className="text-[10px] text-zinc-500 mt-1">
                      Vault key: HARNESS_CUSTOM_{extCustomVaultSlug.toUpperCase()}_KEY
                    </p>
                  )}
                </div>
              )}

              {/* API Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-zinc-400">API Key</label>
                  <ApiKeyStatusIndicator status={apiKeyStatus} errorMessage={apiKeyError} />
                </div>
                <input
                  type="password"
                  value={extApiKeyInput}
                  onChange={(e) => {
                    setExtApiKeyInput(e.target.value);
                    if (apiKeyStatus !== 'unconfigured') setApiKeyStatus('unconfigured');
                  }}
                  placeholder={
                    apiKeyStatus === 'ok' || apiKeyStatus === 'saved'
                      ? 'Key configurada. Cole nova key para atualizar.'
                      : 'Cole sua API key aqui'
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleSaveAndTestKey}
                    disabled={!canSaveKey || apiKeyStatus === 'testing'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Key size={11} />
                    Salvar no Vault e Testar
                  </button>
                  {(apiKeyStatus === 'saved' || apiKeyStatus === 'ok' || apiKeyStatus === 'error') && vaultKeyResolved && (
                    <button
                      type="button"
                      onClick={handleTestKey}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Wifi size={11} />
                      Testar conexao
                    </button>
                  )}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                {extProvider === 'openai-compatible' ? (
                  // Custom: free text input
                  <div className="space-y-2">
                    <input
                      value={extModel}
                      onChange={(e) => setExtModel(e.target.value)}
                      placeholder="Ex: mistral-nemo, llama3:8b, gpt-4o-mini..."
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => fetchLocalModels('openai-compatible', extBaseUrl)}
                      disabled={!extBaseUrl || loadingModels}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RefreshCw size={10} className={loadingModels ? 'animate-spin' : ''} />
                      Carregar lista de /v1/models
                    </button>
                    {availableLocalModels.length > 0 && (
                      <select
                        value={extModel}
                        onChange={(e) => setExtModel(e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                      >
                        <option value="">Selecione da lista</option>
                        {availableLocalModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : (
                  // Curated catalog dropdown
                  <select
                    value={extModel}
                    onChange={(e) => setExtModel(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {catalogModels.map((m) => (
                      <option key={m.id} value={m.id} title={m.notes}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}

                {/* Surcharge warning */}
                {hasSurcharge && (
                  <div className="flex items-start gap-1.5 mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-400">
                      Atencao: este modelo cobra valor adicional acima de 272k tokens de contexto.
                    </p>
                  </div>
                )}

                {/* Notes tooltip (rendered as visible text for non-surcharge notes) */}
                {selectedCatalogModel?.notes && !hasSurcharge && (
                  <p className="text-[10px] text-zinc-500 mt-1">{selectedCatalogModel.notes}</p>
                )}

                {/* Context window display */}
                <ContextWindowDisplay agent={agentSnapshot} />

                {/* Custom: context window manual input */}
                {extProvider === 'openai-compatible' && (
                  <div className="mt-3">
                    <label className="block text-xs text-zinc-400 mb-1">Janela de contexto (tokens)</label>
                    <input
                      type="number"
                      value={extContextWindow}
                      onChange={(e) => setExtContextWindow(e.target.value)}
                      placeholder="Ex: 128000"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Consulte a documentacao do provider. Sem este valor, o LionClaw nao pode avisar antes de estourar o contexto.
                    </p>
                  </div>
                )}
              </div>

              {/* Extra Headers (Custom only) */}
              {extProvider === 'openai-compatible' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Headers extras (JSON)</label>
                  <textarea
                    value={extExtraHeaders}
                    onChange={(e) => setExtExtraHeaders(e.target.value)}
                    placeholder={'{"Header-Name": "valor"}'}
                    rows={3}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors resize-y font-mono"
                  />
                </div>
              )}

              {/* Temperature + MaxTokens */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={extTemperature}
                    onChange={(e) => setExtTemperature(e.target.value)}
                    placeholder="Ex: 0.7"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max tokens de saida</label>
                  <input
                    type="number"
                    value={extMaxTokens}
                    onChange={(e) => setExtMaxTokens(e.target.value)}
                    placeholder="Sem limite"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              {/* Max Tool Rounds (replaces maxTurns for external) */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Max rounds de tool calling</label>
                <input
                  type="number"
                  value={extMaxToolRounds}
                  onChange={(e) => setExtMaxToolRounds(e.target.value)}
                  min={1}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                />
                <p className="text-[10px] text-zinc-600 mt-1">Limita quantas vezes o agente pode chamar ferramentas por requisicao.</p>
              </div>

              {/* Reasoning params (effort, thinking) — visible but disabled when not supported */}
              <div className="pt-2 border-t border-zinc-700/50 space-y-3">
                <p className="text-xs text-zinc-400 font-medium">Parametros de Reasoning</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                      disabled={!reasoningSupported}
                      title={!reasoningSupported ? 'Modelo nao suporta thinking explicito.' : undefined}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                      disabled={!reasoningSupported}
                      title={!reasoningSupported ? 'Modelo nao suporta thinking explicito.' : undefined}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {THINKING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  {reasoningSupported && thinking === 'enabled' && (
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
                </div>
                {!reasoningSupported && extModel && (
                  <p className="text-[10px] text-zinc-500">
                    Modelo nao suporta thinking explicito. Os campos acima sao ignorados na execucao.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* CODEX SECTION */}
          {runtime === 'codex' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-purple-400 uppercase tracking-wide">Configuracao Codex</h5>

              {/* Model */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                <select
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {CODEX_MODELS.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.label} — {m.description}
                    </option>
                  ))}
                </select>
              </div>

              {/* Reasoning Effort */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Reasoning Effort</label>
                <select
                  value={codexReasoningEffort}
                  onChange={(e) => setCodexReasoningEffort(e.target.value as typeof codexReasoningEffort)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {CODEX_REASONING_EFFORT.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>

              {/* Status indicator (live via IPC) */}
              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {codexStatus === null ? (
                  <p className="text-xs text-zinc-500">Verificando status do Codex...</p>
                ) : !codexStatus.installed ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <p className="text-xs text-red-400">Codex CLI nao instalado</p>
                  </div>
                ) : !codexStatus.authenticated ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <p className="text-xs text-yellow-400">
                      Codex instalado{codexStatus.version ? ` (${codexStatus.version})` : ''} — nao autenticado
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <p className="text-xs text-green-400">
                      Codex conectado{codexStatus.version ? ` (${codexStatus.version})` : ''}
                    </p>
                  </div>
                )}
                {codexTestResult && (
                  <p className={`text-xs mt-1 ${codexTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {codexTestResult.message}
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCodexLogin}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs text-white transition-colors"
                >
                  Conectar Codex
                </button>
                <button
                  type="button"
                  onClick={handleCodexTest}
                  disabled={codexTesting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100 transition-colors disabled:opacity-50"
                >
                  {codexTesting ? 'Testando...' : 'Testar conexao'}
                </button>
              </div>

              {/* Informative message about LionClaw permissions vs Codex sandbox */}
              <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <p className="text-xs text-zinc-500">
                  Codex usa ferramentas nativas (read/write/exec) dentro do sandbox `workspace-write` (escreve so dentro do projeto). Tools e MCPs do LionClaw sao ignorados neste runtime, e o permission-guard e bypassado.
                </p>
              </div>
            </div>
          )}

          {/* Skills/KB warning for Codex */}
          {runtime === 'codex' && (skills.size > 0 || mcpServers.size > 0) && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-400">
                Skills e Knowledge Base nao funcionam no runtime Codex -- serao ignorados na execucao. Considere remover ou trocar de runtime.
              </p>
            </div>
          )}

          {/* Tools */}
          {!(runtime === 'local' && localMode === 'simple') && runtime !== 'codex' && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Ferramentas</h4>
              <div className="flex flex-wrap gap-2">
                {runtime === 'local' ? (
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

          {/* MCP Servers */}
          {runtime !== 'local' && runtime !== 'codex' && availableMCP.length > 0 && (
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

          {/* Skills */}
          {runtime !== 'local' && runtime !== 'codex' && availableSkills.length > 0 && (
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
              placeholder={
                runtime === 'local'
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
          <div
            title={
              externalKeyBlocking
                ? 'Configure e teste a API key antes de salvar o agente.'
                : undefined
            }
          >
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
    </div>
  );
}
