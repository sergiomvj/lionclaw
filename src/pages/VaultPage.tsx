import { useState, useEffect } from 'react';
import { KeyRound, Eye, EyeOff, Check, Trash2, ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-react';

interface VaultEntry {
  key: string;
  label: string;
  description: string;
  service: string;
  required: boolean;
  configured: boolean;
  placeholder?: string;
  docsUrl?: string;
}

export default function VaultPage() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    const list = await window.lionclaw.vault.list();
    setEntries(list);
  };

  const handleSave = async (key: string) => {
    if (!inputValue.trim()) return;
    setSaving(true);
    try {
      await window.lionclaw.vault.set(key, inputValue.trim());
      setEditingKey(null);
      setInputValue('');
      setShowValue(false);
      await loadEntries();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (key: string) => {
    await window.lionclaw.vault.delete(key);
    await loadEntries();
  };

  const startEditing = (key: string) => {
    setEditingKey(key);
    setInputValue('');
    setShowValue(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <KeyRound size={24} className="text-amber-500" />
          <h1 className="text-xl font-semibold text-zinc-100">Vault</h1>
        </div>

        <p className="text-sm text-zinc-400 mb-6">
          Gerencie suas API keys de forma segura. As chaves sao armazenadas
          no keychain do sistema operacional com criptografia AES-256-GCM.
        </p>

        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-4"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {entry.configured ? (
                    <ShieldCheck size={16} className="text-green-500" />
                  ) : (
                    <ShieldAlert size={16} className={entry.required ? 'text-red-400' : 'text-zinc-500'} />
                  )}
                  <span className="text-sm font-medium text-zinc-200">{entry.label}</span>
                  {entry.required && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 uppercase tracking-wider">
                      obrigatoria
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {entry.docsUrl && (
                    <a
                      href={entry.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 hover:text-amber-400 flex items-center gap-1 transition-colors"
                    >
                      <ExternalLink size={12} /> Obter chave
                    </a>
                  )}
                </div>
              </div>

              <p className="text-xs text-zinc-500 mb-3">{entry.description}</p>

              {editingKey === entry.key ? (
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showValue ? 'text' : 'password'}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={entry.placeholder || 'Cole a chave aqui...'}
                      className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-500 focus:outline-none pr-9"
                      onKeyDown={(e) => e.key === 'Enter' && handleSave(entry.key)}
                      autoFocus
                    />
                    <button
                      onClick={() => setShowValue(!showValue)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    >
                      {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={() => handleSave(entry.key)}
                    disabled={saving || !inputValue.trim()}
                    className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm disabled:opacity-50 transition-colors"
                  >
                    {saving ? '...' : 'Salvar'}
                  </button>
                  <button
                    onClick={() => { setEditingKey(null); setInputValue(''); }}
                    className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => startEditing(entry.key)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                  >
                    {entry.configured ? 'Alterar' : 'Configurar'}
                  </button>
                  {entry.configured && !entry.required && (
                    <button
                      onClick={() => handleDelete(entry.key)}
                      className="text-xs px-2 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  {entry.configured && (
                    <span className="text-xs text-green-500/70 ml-2 flex items-center gap-1">
                      <Check size={12} /> Configurada
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
