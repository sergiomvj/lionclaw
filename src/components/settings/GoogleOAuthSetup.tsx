import { useState, useEffect } from 'react';
import { Chrome, CheckCircle2, XCircle, Loader2, LogOut, ExternalLink } from 'lucide-react';

export function GoogleOAuthSetup() {
  const [status, setStatus] = useState<{ hasCredentials: boolean; isAuthenticated: boolean } | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadStatus = async () => {
    const s = await window.lionclaw.google.status();
    setStatus(s);
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleSetup = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Preencha Client ID e Client Secret');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await window.lionclaw.google.setup({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      setClientId('');
      setClientSecret('');
      setSuccess('Credenciais salvas');
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthenticate = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.lionclaw.google.authenticate();
      if (result.success) {
        setSuccess('Autenticado com sucesso! MCPs Google ativados.');
      } else {
        setError(result.error || 'Falha na autenticacao');
      }
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await window.lionclaw.google.revoke();
      setSuccess('Acesso Google revogado. MCPs desativados.');
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!status) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Chrome size={18} className="text-blue-400" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Google Workspace</h3>
          <p className="text-xs text-zinc-500">Calendar, Gmail e Drive</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {status.isAuthenticated ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <CheckCircle2 size={12} />
              Conectado
            </span>
          ) : status.hasCredentials ? (
            <span className="flex items-center gap-1 text-xs text-amber-400">
              <XCircle size={12} />
              Nao autenticado
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              <XCircle size={12} />
              Nao configurado
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-xs text-green-300">
          {success}
        </div>
      )}

      {!status.hasCredentials && (
        <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
          <p className="text-xs text-zinc-400">
            Crie um projeto no Google Cloud Console e configure OAuth 2.0.
            Adicione <code className="text-amber-400">http://localhost</code> como redirect URI autorizado.
          </p>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            onClick={(e) => { e.preventDefault(); window.open('https://console.cloud.google.com/apis/credentials'); }}
          >
            <ExternalLink size={11} />
            Google Cloud Console
          </a>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
            <p className="text-[11px] text-amber-300">
              Seu projeto Google Cloud deve estar em modo "Production".
              Apps em modo "Testing" perdem a autenticacao a cada 7 dias.
            </p>
          </div>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID (123...apps.googleusercontent.com)"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500/50"
          />
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client Secret (GOCSPX-...)"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500/50"
          />
          <button
            onClick={handleSetup}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            Salvar credenciais
          </button>
        </div>
      )}

      {status.hasCredentials && !status.isAuthenticated && (
        <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
          <p className="text-xs text-zinc-400">
            Credenciais configuradas. Clique para autorizar o LionClaw a acessar Calendar, Gmail e Drive.
          </p>
          <button
            onClick={handleAuthenticate}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Chrome size={14} />}
            Autorizar com Google
          </button>
        </div>
      )}

      {status.isAuthenticated && (
        <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
          <p className="text-xs text-zinc-400">
            LionClaw esta conectado ao Google. Os MCPs de Calendar, Gmail e Drive estao ativos.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleAuthenticate}
              disabled={loading}
              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Chrome size={12} />}
              Reautenticar
            </button>
            <button
              onClick={handleRevoke}
              disabled={loading}
              className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              Revogar acesso
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
