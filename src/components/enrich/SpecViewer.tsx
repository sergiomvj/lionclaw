// @deprecated - migrado para pipeline-engine/pipeline-store
import { X, FolderOpen } from 'lucide-react';

interface Props {
  specPath: string;
  sessionId: string;
  onClose: () => void;
}

export function SpecViewer({ specPath, sessionId, onClose }: Props) {
  const handleOpenInFinder = async () => {
    await window.lionclaw.enrich.openSpec(sessionId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">SPEC Final Gerada</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
            title="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 flex flex-col gap-4 overflow-hidden">
          <div className="bg-zinc-800 rounded-lg px-4 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-zinc-500 mb-0.5">Caminho do arquivo</p>
              <p className="text-xs text-zinc-300 font-mono break-all">{specPath}</p>
            </div>
          </div>

          <p className="text-xs text-zinc-400 leading-relaxed">
            A SPEC final foi salva no caminho acima. Clique em "Abrir no Finder" para navegar ate o arquivo e abrilo com o editor de sua preferencia.
          </p>
        </div>

        <div className="flex justify-end gap-2 mt-5 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Fechar
          </button>
          <button
            onClick={handleOpenInFinder}
            className="flex items-center gap-1.5 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg text-xs font-medium transition-colors"
          >
            <FolderOpen size={13} />
            Abrir no Finder
          </button>
        </div>
      </div>
    </div>
  );
}
