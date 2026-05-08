import { useState, useEffect } from 'react';
import { Save, CheckCircle, RotateCcw, KeyRound, Volume2, Cpu, BrainCircuit } from 'lucide-react';
import { VoiceSelector } from '@/components/settings/VoiceSelector';
import { GoogleOAuthSetup } from '@/components/settings/GoogleOAuthSetup';
import { CodexSection } from '@/components/settings/CodexSection';
import { useAuthStore } from '@/stores/auth-store';
import { useAppStore } from '@/stores/app-store';
import { useChatStore } from '@/stores/chat-store';
import type { AppSettings } from '@/types';

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.lionclaw.settings.get().then((s) => {
      setSettings(s);
    });
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    await window.lionclaw.settings.update({
      ...settings,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-500 mt-1">Configuracoes gerais do LionClaw</p>
        </div>

        {/* API Keys */}
        <section className="space-y-3">
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
                  <KeyRound size={16} className="text-amber-500" />
                  API Keys
                </h3>
                <p className="text-xs text-zinc-500 mt-1">Gerencie suas chaves de API no Vault</p>
              </div>
              <button
                onClick={() => useAppStore.getState().setPage('vault')}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-amber-400 transition-colors flex items-center gap-1.5"
              >
                <KeyRound size={12} />
                Abrir Vault
              </button>
            </div>
          </div>
        </section>

        {/* Model */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Modelo padrao</h2>
          <select
            value={settings.defaultModel}
            onChange={(e) => setSettings({ ...settings, defaultModel: e.target.value })}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          >
            <option value="sonnet">Sonnet 4.6</option>
            <option value="opus">Opus 4.7</option>
            <option value="haiku">Haiku 4.5</option>
          </select>
        </section>

        {/* Theme */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Tema</h2>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setSettings({ ...settings, theme: t })}
                className={`px-4 py-2 rounded-lg text-sm capitalize transition-colors ${
                  settings.theme === t
                    ? 'bg-amber-600 text-white'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        {/* Voice */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Volume2 size={16} className="text-amber-500" />
            Voice
          </h2>

          <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
            <div>
              <p className="text-sm text-zinc-200">Respostas em audio</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Quando ativado, as respostas do agente serao convertidas em audio automaticamente
              </p>
            </div>
            <button
              onClick={() => setSettings({ ...settings, voiceResponseEnabled: !settings.voiceResponseEnabled })}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                settings.voiceResponseEnabled ? 'bg-amber-600' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  settings.voiceResponseEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {settings.voiceResponseEnabled && (
            <VoiceSelector
              selectedVoiceId={settings.voiceId}
              onSelect={(voiceId) => setSettings({ ...settings, voiceId })}
            />
          )}
        </section>

        {/* Google Workspace */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Integracoes</h2>
          <GoogleOAuthSetup />
        </section>

        {/* Ollama (Local Models) */}
        <OllamaSettings settings={settings} onChange={setSettings} />

        {/* Codex CLI */}
        <CodexSection />

        {/* Memory Graph */}
        <MgraphSettings settings={settings} onChange={setSettings} onSave={handleSave} />

        {/* Session timeout */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Timeout da sessao (minutos)</h2>
          <input
            type="number"
            value={settings.sessionTimeoutMinutes}
            onChange={(e) => setSettings({ ...settings, sessionTimeoutMinutes: parseInt(e.target.value) || 60 })}
            className="w-32 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          />
        </section>

        {/* Save button */}
        <button
          onClick={handleSave}
          className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-6 py-2.5 text-sm font-medium transition-colors"
        >
          {saved ? <CheckCircle size={16} /> : <Save size={16} />}
          {saved ? 'Salvo!' : 'Salvar configuracoes'}
        </button>

        {/* Re-onboarding */}
        <section className="space-y-3 pt-4 border-t border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-300">Configuracao inicial</h2>
          <button
            onClick={async () => {
              const confirmed = window.confirm(
                'Isso vai resetar seu perfil, memoria e historico de conversas. Continuar?'
              );
              if (!confirmed) return;
              await window.lionclaw.onboarding.reset();
              await window.lionclaw.chat.stop();
              useChatStore.getState().startNewSession();
              useAuthStore.getState().checkOnboarding();
              useAppStore.getState().setPage('chat');
            }}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-amber-500 transition-colors"
          >
            <RotateCcw size={14} />
            Refazer configuracao inicial
          </button>
          <p className="text-xs text-zinc-600">
            Reinicia o processo de onboarding para atualizar seu perfil e a personalidade do agente.
          </p>
        </section>
      </div>
    </div>
  );
}

function MgraphSettings({
  settings,
  onChange,
  onSave,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onSave: () => Promise<void>;
}) {
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showReseedConfirm, setShowReseedConfirm] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedProgress, setSeedProgress] = useState<{ processed: number; total: number; notesCreated: number } | null>(null);

  useEffect(() => {
    const unsub = window.lionclaw.mgraph.onSeedProgress((data) => {
      setSeedProgress(data);
      // Seed is done when processed === total and total > 0
      if (data.total > 0 && data.processed >= data.total) {
        setSeeding(false);
      }
    });
    return unsub;
  }, []);

  const handleToggle = async () => {
    onChange({ ...settings, mgraphMode: !settings.mgraphMode });
    setShowRestartDialog(true);
  };

  const handleReseed = async () => {
    setShowReseedConfirm(false);
    setSeeding(true);
    setSeedProgress(null);
    try {
      await window.lionclaw.mgraph.seed(true);
    } catch {
      // seed runs in background, errors handled via IPC
    } finally {
      setSeeding(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <BrainCircuit size={16} className="text-amber-500" />
        Memoria
      </h2>

      <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
        <div>
          <p className="text-sm text-zinc-200">Memory Graph</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Ativa o grafo de memoria persistente em arquivos Markdown
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={seeding}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            settings.mgraphMode ? 'bg-amber-600' : 'bg-zinc-700'
          } ${seeding ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              settings.mgraphMode ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {settings.mgraphMode && (
        <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
          <div>
            <p className="text-sm text-zinc-200">Forcar re-seed</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Apaga todas as notas do graph e reprocessa o historico
            </p>
          </div>
          <button
            onClick={() => setShowReseedConfirm(true)}
            disabled={seeding}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              seeding
                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
            }`}
          >
            {seeding ? 'Processando...' : 'Re-seed'}
          </button>
        </div>
      )}

      {/* Seed Progress Bar */}
      {seeding && seedProgress && seedProgress.total > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-300">
              Processando batch {seedProgress.processed} de {seedProgress.total} ({seedProgress.notesCreated} notas criadas)
            </span>
            <span className="text-amber-400 font-mono">
              {Math.round((seedProgress.processed / seedProgress.total) * 100)}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full transition-all duration-300"
              style={{ width: `${(seedProgress.processed / seedProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Restart Dialog */}
      {showRestartDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-sm font-medium text-zinc-100">Reiniciar necessario</h3>
            <p className="text-xs text-zinc-400">
              A alteracao do Memory Graph requer reiniciar o app para ter efeito.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={async () => {
                  setShowRestartDialog(false);
                  await onSave();
                }}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
              >
                Depois
              </button>
              <button
                onClick={async () => {
                  await onSave();
                  setShowRestartDialog(false);
                  // Trigger app restart - Electron will handle this
                  window.location.reload();
                }}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
              >
                Reiniciar agora
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-seed Confirmation Dialog */}
      {showReseedConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-sm font-medium text-zinc-100">Confirmar re-seed</h3>
            <p className="text-xs text-zinc-400">
              Isso vai apagar todas as notas do graph e reprocessar todo o historico. Continuar?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowReseedConfirm(false)}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleReseed}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function OllamaSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testModels, setTestModels] = useState<string[]>([]);

  const handleTest = async () => {
    setTestStatus('testing');
    try {
      const result = await window.lionclaw.ollama.check(
        settings.ollamaBaseUrl,
        settings.ollamaEmbeddingModel,
      );
      setTestStatus(result.available ? 'ok' : 'error');
      setTestModels(result.models);
    } catch {
      setTestStatus('error');
      setTestModels([]);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Cpu size={16} className="text-amber-500" />
        Ollama (Modelos Locais)
      </h2>

      <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
        <div>
          <p className="text-sm text-zinc-200">Ativar Ollama</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Usa modelos locais para embeddings e compaction de memoria
          </p>
        </div>
        <button
          onClick={() => onChange({ ...settings, ollamaEnabled: !settings.ollamaEnabled })}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            settings.ollamaEnabled ? 'bg-amber-600' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              settings.ollamaEnabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {settings.ollamaEnabled && (
        <div className="space-y-3 bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Base URL</label>
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              onChange={(e) => onChange({ ...settings, ollamaBaseUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Modelo de embeddings</label>
            <input
              type="text"
              value={settings.ollamaEmbeddingModel}
              onChange={(e) => onChange({ ...settings, ollamaEmbeddingModel: e.target.value })}
              placeholder="nomic-embed-text"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Modelo usado para gerar vetores de busca semantica (768 dimensoes)</p>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Modelo de compaction (opcional)</label>
            <input
              type="text"
              value={settings.ollamaCompactionModel}
              onChange={(e) => onChange({ ...settings, ollamaCompactionModel: e.target.value })}
              placeholder="qwen2.5:14b (vazio = usar Claude)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Modelo para sumarizar conversas. Deixe vazio para usar Claude (melhor qualidade, mais caro)</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {testStatus === 'testing' ? 'Testando...' : 'Testar Conexao'}
            </button>
            {testStatus === 'ok' && (
              <span className="text-xs text-green-400 flex items-center gap-1">
                <CheckCircle size={12} /> Conectado
              </span>
            )}
            {testStatus === 'error' && (
              <span className="text-xs text-red-400">Falha na conexao</span>
            )}
          </div>

          {testModels.length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-500 mb-1">Modelos disponiveis:</p>
              <div className="flex flex-wrap gap-1">
                {testModels.map((m) => (
                  <span key={m} className="px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
