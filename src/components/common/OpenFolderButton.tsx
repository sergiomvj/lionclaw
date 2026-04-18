import { FolderOpen } from 'lucide-react';

interface OpenFolderButtonProps {
  filePath: string;
  label?: string;
  variant?: 'default' | 'subtle';
}

export function OpenFolderButton({ filePath, label = 'Abrir no Finder', variant = 'default' }: OpenFolderButtonProps) {
  const handleClick = async () => {
    try {
      await window.lionclaw.shell.showInFolder(filePath);
    } catch (err) {
      console.error('Erro ao abrir pasta:', err);
    }
  };

  if (variant === 'subtle') {
    return (
      <button
        onClick={handleClick}
        className="inline-flex items-center gap-1 text-[9px] text-zinc-500 hover:text-orange-400 transition-colors"
        title={`Abrir: ${filePath}`}
      >
        <FolderOpen size={10} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs
                 text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700
                 rounded-lg border border-zinc-700 transition-colors"
      title={`Abrir: ${filePath}`}
    >
      <FolderOpen size={14} />
      <span>{label}</span>
    </button>
  );
}
