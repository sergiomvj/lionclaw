// @deprecated - migrado para pipeline-engine/pipeline-store
import { useState, useEffect } from 'react';
import { X, FolderOpen, FileText, Loader2 } from 'lucide-react';
import type { AgentConfig, CreateEnrichConfig } from '@/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function EnrichModal({ isOpen, onClose, onCreated }: Props) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [name, setName] = useState('');
  const [specPath, setSpecPath] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [prdPath, setPrdPath] = useState('');
  const [message, setMessage] = useState('');
  const [validatorAgentId, setValidatorAgentId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    window.lionclaw.agents.list().then((all) => {
      const enrichAgents = all.filter(
        (a) => a.isActive && a.squad === 'enrich'
      );
      setAgents(enrichAgents.length > 0 ? enrichAgents : all.filter((a) => a.isActive));
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const isValid =
    name.trim() !== '' &&
    specPath.trim() !== '' &&
    validatorAgentId !== '';

  const handleOpenFile = async (setter: (p: string) => void) => {
    const selected = await window.lionclaw.dialog.openFile();
    if (selected) setter(selected);
  };

  const handleOpenDirectory = async () => {
    const selected = await window.lionclaw.dialog.openDirectory();
    if (selected) setProjectPath(selected);
  };

  const handleCreate = async () => {
    if (!isValid || creating) return;
    setCreating(true);
    setError(null);
    try {
      const config: CreateEnrichConfig = {
        name: name.trim(),
        specPath: specPath.trim(),
        validatorAgentId,
        projectPath: projectPath.trim() || undefined,
        prdPath: prdPath.trim() || undefined,
        message: message.trim() || undefined,
      };
      const result = await window.lionclaw.enrich.start(config);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      onCreated(result.sessionId);
      handleClose();
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setName('');
    setSpecPath('');
    setProjectPath('');
    setPrdPath('');
    setMessage('');
    setValidatorAgentId('');
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold text-zinc-100">Nova Validacao Enrich</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* Nome do documento */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Nome do documento <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
              placeholder="Ex: Spec v2.0 - Modulo Pagamentos"
            />
          </div>

          {/* Path da SPEC */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Path da SPEC <span className="text-red-400">*</span>
            </label>
            <div className="flex gap-2">
              <input
                value={specPath}
                onChange={(e) => setSpecPath(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                placeholder="/caminho/para/SPEC.md"
              />
              <button
                type="button"
                onClick={() => handleOpenFile(setSpecPath)}
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                title="Selecionar arquivo"
              >
                <FileText size={15} />
              </button>
            </div>
          </div>

          {/* Path do Projeto */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Path do projeto <span className="text-zinc-600 font-normal">(opcional)</span>
            </label>
            <div className="flex gap-2">
              <input
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                placeholder="/caminho/do/projeto"
              />
              <button
                type="button"
                onClick={handleOpenDirectory}
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                title="Selecionar pasta"
              >
                <FolderOpen size={15} />
              </button>
            </div>
          </div>

          {/* Path do PRD */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Path do PRD <span className="text-zinc-600 font-normal">(opcional)</span>
            </label>
            <div className="flex gap-2">
              <input
                value={prdPath}
                onChange={(e) => setPrdPath(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
                placeholder="/caminho/para/PRD.md"
              />
              <button
                type="button"
                onClick={() => handleOpenFile(setPrdPath)}
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                title="Selecionar arquivo"
              >
                <FileText size={15} />
              </button>
            </div>
          </div>

          {/* Agente validador */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Agente validador <span className="text-red-400">*</span>
            </label>
            <select
              value={validatorAgentId}
              onChange={(e) => setValidatorAgentId(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors"
            >
              <option value="">Selecione um agente...</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {agents.length === 0 && (
              <p className="text-[11px] text-zinc-500 mt-1">
                Nenhum agente com squad='enrich' encontrado. Exibindo todos os agentes ativos.
              </p>
            )}
          </div>

          {/* Mensagem extra */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Mensagem extra <span className="text-zinc-600 font-normal">(opcional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500 transition-colors resize-none"
              placeholder="Contexto adicional para o agente..."
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleCreate}
              disabled={!isValid || creating}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              {creating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Iniciando...
                </>
              ) : (
                'Iniciar Validacao'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
