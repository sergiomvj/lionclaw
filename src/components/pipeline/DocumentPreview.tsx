import { useRef, useEffect } from 'react';
import { X, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocumentPreviewProps {
  path: string;
  content: string;
  onClose: () => void;
}

function getFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? filePath;
}

export function DocumentPreview({ path: filePath, content, onClose }: DocumentPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const fileName = getFileName(filePath);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [filePath]);

  return (
    <div className="flex flex-col h-full border-l border-zinc-800 bg-zinc-950 min-w-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <FileText size={14} className="text-amber-400 shrink-0" />
        <span className="text-sm font-medium text-zinc-200 truncate flex-1">{fileName}</span>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
          title="Fechar preview"
        >
          <X size={14} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4"
      >
        <div className="document-preview-markdown text-sm text-zinc-300 leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>

      <style>{`
        .document-preview-markdown h1 {
          font-size: 1.25rem;
          font-weight: 700;
          color: #f4f4f5;
          margin-bottom: 0.75rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid #3f3f46;
        }
        .document-preview-markdown h2 {
          font-size: 1.05rem;
          font-weight: 600;
          color: #e4e4e7;
          margin-top: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .document-preview-markdown h3 {
          font-size: 0.925rem;
          font-weight: 600;
          color: #d4d4d8;
          margin-top: 1rem;
          margin-bottom: 0.375rem;
        }
        .document-preview-markdown p {
          margin-bottom: 0.625rem;
          color: #a1a1aa;
        }
        .document-preview-markdown ul,
        .document-preview-markdown ol {
          margin-bottom: 0.625rem;
          padding-left: 1.25rem;
          color: #a1a1aa;
        }
        .document-preview-markdown li {
          margin-bottom: 0.25rem;
        }
        .document-preview-markdown code {
          background: #27272a;
          border: 1px solid #3f3f46;
          border-radius: 0.25rem;
          padding: 0.1rem 0.35rem;
          font-size: 0.8rem;
          color: #fbbf24;
          font-family: ui-monospace, monospace;
        }
        .document-preview-markdown pre {
          background: #18181b;
          border: 1px solid #3f3f46;
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          overflow-x: auto;
          margin-bottom: 0.75rem;
        }
        .document-preview-markdown pre code {
          background: transparent;
          border: none;
          padding: 0;
          color: #d4d4d8;
        }
        .document-preview-markdown blockquote {
          border-left: 3px solid #78350f;
          padding-left: 0.875rem;
          color: #a1a1aa;
          margin-bottom: 0.625rem;
        }
        .document-preview-markdown table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 0.875rem;
          font-size: 0.8rem;
        }
        .document-preview-markdown th {
          background: #27272a;
          color: #e4e4e7;
          padding: 0.375rem 0.625rem;
          text-align: left;
          font-weight: 600;
          border: 1px solid #3f3f46;
        }
        .document-preview-markdown td {
          padding: 0.375rem 0.625rem;
          border: 1px solid #3f3f46;
          color: #a1a1aa;
        }
        .document-preview-markdown tr:nth-child(even) td {
          background: #18181b;
        }
        .document-preview-markdown a {
          color: #fbbf24;
          text-decoration: underline;
        }
        .document-preview-markdown hr {
          border: none;
          border-top: 1px solid #3f3f46;
          margin: 1rem 0;
        }
        .document-preview-markdown strong {
          color: #e4e4e7;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
