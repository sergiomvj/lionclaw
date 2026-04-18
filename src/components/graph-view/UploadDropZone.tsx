import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, Image, Music, Video, X } from 'lucide-react';
import toast from 'react-hot-toast';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilePreview {
  file: File;
  path: string;
  typeLabel: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_EXT_MIMES: Record<string, string[]> = {
  '.pdf':  ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.csv':  ['text/csv', 'application/csv', 'text/plain'],
  '.md':   ['text/markdown', 'text/plain', 'text/x-markdown'],
  '.txt':  ['text/plain'],
  '.png':  ['image/png'],
  '.jpg':  ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.webp': ['image/webp'],
  '.mp3':  ['audio/mpeg', 'audio/mp3'],
  '.m4a':  ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg'],
  '.wav':  ['audio/wav', 'audio/wave', 'audio/x-wav'],
  '.ogg':  ['audio/ogg'],
  '.mp4':  ['video/mp4'],
  '.webm': ['video/webm', 'audio/webm'],
};

const EXT_LABEL: Record<string, string> = {
  '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.csv': 'CSV',
  '.md': 'Markdown', '.txt': 'Texto', '.png': 'Imagem', '.jpg': 'Imagem',
  '.jpeg': 'Imagem', '.webp': 'Imagem', '.mp3': 'Áudio', '.m4a': 'Áudio',
  '.wav': 'Áudio', '.ogg': 'Áudio', '.mp4': 'Vídeo', '.webm': 'Vídeo',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.ogg']);
const VIDEO_EXTS = new Set(['.mp4', '.webm']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFileExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx !== -1 ? name.slice(idx).toLowerCase() : '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(ext: string): typeof FileText {
  if (IMAGE_EXTS.has(ext)) return Image;
  if (AUDIO_EXTS.has(ext)) return Music;
  if (VIDEO_EXTS.has(ext)) return Video;
  return FileText;
}

function validateFile(
  file: File,
  maxBytes: number,
): { ok: true; typeLabel: string } | { ok: false; reason: string } {
  const ext = getFileExt(file.name);
  const allowedMimes = ALLOWED_EXT_MIMES[ext];

  if (!allowedMimes) {
    return { ok: false, reason: 'tipo não suportado' };
  }

  if (file.size > maxBytes) {
    return { ok: false, reason: `excede ${(maxBytes / 1024 / 1024).toFixed(0)}MB` };
  }

  // MIME type check: if browser provides it, validate consistency
  if (file.type && !allowedMimes.includes(file.type)) {
    const textLikeExts = ['.md', '.csv', '.txt'];
    const isTextLike = textLikeExts.includes(ext) && file.type === 'text/plain';
    if (!isTextLike) {
      return { ok: false, reason: `MIME incompatível (${file.type})` };
    }
  }

  return { ok: true, typeLabel: EXT_LABEL[ext] || ext };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface UploadDropZoneProps {
  maxFileSizeMb: number;
  /** Called with only newly accepted files in this batch */
  onNewFilesAdded: (files: FilePreview[]) => void;
}

export function UploadDropZone({ maxFileSizeMb, onNewFilesAdded }: UploadDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<FilePreview[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    (rawFiles: File[]) => {
      const maxBytes = maxFileSizeMb * 1024 * 1024;
      const accepted: FilePreview[] = [];
      const rejectedMsgs: string[] = [];

      for (const file of rawFiles) {
        const result = validateFile(file, maxBytes);
        if (!result.ok) {
          rejectedMsgs.push(`${file.name}: ${result.reason}`);
          continue;
        }
        const path = window.lionclaw.utils.getPathForFile(file);
        accepted.push({ file, path, typeLabel: result.typeLabel });
      }

      if (accepted.length + previews.length > 10) {
        toast.error('Máximo de 10 arquivos por upload');
        return;
      }

      // Show rejection toasts (max 3, then summarize)
      rejectedMsgs.slice(0, 3).forEach((msg) => toast.error(msg));
      if (rejectedMsgs.length > 3) {
        toast.error(`...e mais ${rejectedMsgs.length - 3} rejeitado(s)`);
      }

      if (accepted.length > 0) {
        setPreviews((prev) => [...prev, ...accepted]);
        onNewFilesAdded(accepted);
      }
    },
    [previews, maxFileSizeMb, onNewFilesAdded],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(Array.from(e.dataTransfer.files));
    },
    [processFiles],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files || []));
    e.target.value = '';
  };

  const removePreview = (idx: number) => {
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  const Icon = Upload;

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-6 cursor-pointer transition-colors ${
          isDragging
            ? 'border-amber-500/70 bg-amber-500/5'
            : 'border-zinc-700 hover:border-zinc-600 bg-zinc-900/50 hover:bg-zinc-900'
        }`}
      >
        <Icon size={20} className={isDragging ? 'text-amber-400' : 'text-zinc-500'} />
        <div className="text-center pointer-events-none">
          <p className="text-sm text-zinc-300">
            {isDragging ? 'Solte os arquivos aqui' : 'Arraste arquivos ou clique para selecionar'}
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            PDF, Word, Excel, CSV, Markdown, TXT, Imagens, Áudio, Vídeo · Máx {maxFileSizeMb}MB
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept={Object.keys(ALLOWED_EXT_MIMES).join(',')}
          onChange={handleInputChange}
        />
      </div>

      {/* Preview cards */}
      {previews.length > 0 && (
        <div className="space-y-1.5">
          {previews.map((p, i) => {
            const FileIcon = getFileIcon(getFileExt(p.file.name));
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg"
              >
                <FileIcon size={14} className="text-zinc-400 shrink-0" />
                <span className="flex-1 text-xs text-zinc-300 truncate">{p.file.name}</span>
                <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full shrink-0">
                  {p.typeLabel}
                </span>
                <span className="text-[10px] text-zinc-600 shrink-0">{formatSize(p.file.size)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePreview(i);
                  }}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
