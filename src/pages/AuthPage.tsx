import { useState } from 'react';
import { Eye, EyeOff, ArrowRight, Key } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';

export function AuthPage({ isSetup }: { isSetup: boolean }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'password' | 'apikey'>(isSetup ? 'password' : 'password');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { checkAuth } = useAuthStore();

  const handleSetup = async () => {
    if (step === 'password') {
      if (password.length < 6) {
        setError('Senha deve ter pelo menos 6 caracteres');
        return;
      }
      if (password !== confirmPassword) {
        setError('Senhas nao conferem');
        return;
      }
      setError('');
      setIsSubmitting(true);
      try {
        await window.lionclaw.auth.setupPassword(password);
        setStep('apikey');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (step === 'apikey') {
      if (!apiKey.startsWith('sk-')) {
        setError('API key deve comecar com sk-');
        return;
      }
      setError('');
      setIsSubmitting(true);
      try {
        await window.lionclaw.settings.setApiKey(apiKey);
        await window.lionclaw.settings.update({ defaultModel: 'sonnet' });
        await window.lionclaw.auth.login(password);
        await checkAuth();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
  };

  const handleLogin = async () => {
    if (!password) {
      setError('Digite sua senha');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      await window.lionclaw.auth.login(password);
      await checkAuth();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <div className="w-full max-w-sm px-6">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="/resources/logo-lionclaw.png"
            alt="LionClaw"
            className="w-20 h-20 rounded-2xl mb-3 object-contain"
            onError={(e) => {
              // Fallback: hide image if not found
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
          <h1 className="text-2xl font-bold text-zinc-100">LionClaw</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {isSetup
              ? step === 'password'
                ? 'Criar senha de acesso'
                : 'Configurar API Key'
              : 'Acesso protegido'}
          </p>
        </div>

        {/* Setup: password step */}
        {isSetup && step === 'password' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Criar senha</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="Minimo 6 caracteres"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Confirmar senha</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                placeholder="Repita a senha"
              />
            </div>
          </div>
        )}

        {/* Setup: API key step */}
        {isSetup && step === 'apikey' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Anthropic API Key</label>
              <div className="relative">
                <Key size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="sk-ant-..."
                  autoFocus
                />
              </div>
              <p className="text-xs text-zinc-600 mt-1.5">
                Armazenada no keychain do SO, nunca em plaintext
              </p>
            </div>
          </div>
        )}

        {/* Login flow */}
        {!isSetup && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Senha</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="Sua senha"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-sm text-red-400 mt-3">{error}</p>
        )}

        {/* Action button */}
        <button
          onClick={isSetup ? handleSetup : handleLogin}
          disabled={isSubmitting}
          className="w-full mt-6 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {isSubmitting ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              {isSetup && step === 'password' ? 'Continuar' : isSetup ? 'Iniciar LionClaw' : 'Entrar'}
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
