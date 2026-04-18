// @deprecated - migrado para pipeline-engine/pipeline-store
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkflowStore } from '@/stores/workflow-store';
import { OpenFolderButton } from '@/components/common/OpenFolderButton';

export function DiscoveryPanel() {
  const { notesContent, setNotesContent } = useWorkflowStore();
  const [notesPath, setNotesPath] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.lionclaw.workflow.onNotesUpdated((data) => {
      setNotesContent(data.content);
      if (data.path) setNotesPath(data.path);
    });
    return unsub;
  }, [setNotesContent]);

  return (
    <aside className="w-72 border-l border-zinc-800 flex flex-col bg-zinc-950 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-orange-500/60" />
        <h3 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
          Discovery Notes
        </h3>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {notesContent ? (
          <div className="discovery-notes-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{notesContent}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <span className="text-lg">📋</span>
            </div>
            <p className="text-xs text-zinc-600 leading-relaxed">
              As notas do discovery<br />aparecerão aqui conforme<br />a conversa avança
            </p>
          </div>
        )}
      </div>

      {/* Footer: persistence indicator */}
      {notesPath && notesContent && (
        <div className="px-3 py-1.5 border-t border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            <Save size={10} className="text-green-500/60" />
            <span className="text-[9px] text-zinc-600 truncate" title={notesPath}>
              Salvo em disco
            </span>
          </div>
          <OpenFolderButton filePath={notesPath} label="Abrir" variant="subtle" />
        </div>
      )}

      <style>{`
        .discovery-notes-content {
          font-size: 0.7rem;
          line-height: 1.6;
          color: #a1a1aa;
        }

        .discovery-notes-content h1,
        .discovery-notes-content h2,
        .discovery-notes-content h3,
        .discovery-notes-content h4 {
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #f97316;
          margin-top: 1.25rem;
          margin-bottom: 0.4rem;
          padding-bottom: 0.3rem;
          border-bottom: 1px solid rgba(249, 115, 22, 0.2);
        }

        .discovery-notes-content h1 {
          color: #ea580c;
          font-size: 0.7rem;
        }

        .discovery-notes-content p {
          margin-bottom: 0.5rem;
          color: #a1a1aa;
        }

        .discovery-notes-content hr {
          border: none;
          border-top: 1px solid rgba(63, 63, 70, 0.4);
          margin: 0.75rem 0;
        }

        .discovery-notes-content ul,
        .discovery-notes-content ol {
          padding-left: 1.1rem;
          margin-bottom: 0.5rem;
        }

        .discovery-notes-content li {
          margin-bottom: 0.2rem;
          color: #a1a1aa;
        }

        .discovery-notes-content strong {
          color: #d4d4d8;
          font-weight: 600;
        }

        .discovery-notes-content em {
          color: #9ca3af;
          font-style: italic;
        }

        .discovery-notes-content code {
          background: rgba(39, 39, 42, 0.8);
          border: 1px solid rgba(63, 63, 70, 0.5);
          padding: 0.1rem 0.3rem;
          border-radius: 3px;
          font-size: 0.65rem;
          color: #fb923c;
          font-family: monospace;
        }

        .discovery-notes-content blockquote {
          border-left: 2px solid rgba(249, 115, 22, 0.4);
          padding-left: 0.75rem;
          color: #71717a;
          margin: 0.5rem 0;
        }

        .discovery-notes-content table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 0.5rem;
        }

        .discovery-notes-content th,
        .discovery-notes-content td {
          border: 1px solid rgba(63, 63, 70, 0.4);
          padding: 0.2rem 0.4rem;
          text-align: left;
        }

        .discovery-notes-content th {
          background: rgba(39, 39, 42, 0.5);
          color: #d4d4d8;
        }
      `}</style>
    </aside>
  );
}
