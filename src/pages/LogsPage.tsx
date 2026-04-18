import { useState, useEffect } from 'react';
import { RefreshCw, Search, Terminal, Download, ChevronRight, ChevronDown } from 'lucide-react';
import type { AuditEntry } from '@/types';

export function LogsPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadLogs = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.logs.query({
      search: search || undefined,
      limit: 200,
    });
    setEntries(result);
    setIsLoading(false);
  };

  useEffect(() => {
    loadLogs();
    const unsub = window.lionclaw.logs.stream((entry) => {
      setEntries((prev) => [entry, ...prev].slice(0, 500));
    });
    return unsub;
  }, []);

  const handleExport = async (format: 'csv' | 'json') => {
    const filters = { search: search || undefined, limit: 10000, offset: 0 };
    const data = format === 'csv'
      ? await window.lionclaw.logs.exportCSV(filters)
      : await window.lionclaw.logs.exportJSON(filters);
    const blob = new Blob([data], { type: format === 'csv' ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lionclaw-logs-${new Date().toISOString().split('T')[0]}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'tool_call': return 'text-blue-400';
      case 'tool_result': return 'text-green-400';
      case 'error': return 'text-red-400';
      case 'confirm_request': return 'text-amber-400';
      case 'confirm_response': return 'text-purple-400';
      default: return 'text-zinc-400';
    }
  };

  const getEventBg = (type: string) => {
    switch (type) {
      case 'error': return 'bg-red-500/5 border-l-2 border-red-500/30';
      case 'confirm_request': return 'bg-amber-500/5 border-l-2 border-amber-500/30';
      default: return '';
    }
  };

  /** Build the one-line summary for each entry */
  const getSummaryText = (entry: AuditEntry): string => {
    if (entry.eventType === 'error') {
      return entry.output || entry.input || 'Erro sem detalhes';
    }
    const parts: string[] = [];
    if (entry.input) parts.push(entry.input.substring(0, 120));
    if (entry.output && !entry.input) parts.push(entry.output.substring(0, 120));
    return parts.join(' ');
  };

  const hasDetails = (entry: AuditEntry): boolean => {
    return !!(entry.input || entry.output || entry.sessionId);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <Terminal size={18} className="text-amber-500" />
        <h1 className="text-sm font-semibold text-zinc-200">Audit Log</h1>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadLogs()}
              placeholder="Buscar..."
              className="bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50 w-48"
            />
          </div>
          <button
            onClick={() => handleExport('csv')}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors text-xs"
            title="Exportar CSV"
          >
            <Download size={12} />
            CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors text-xs"
            title="Exportar JSON"
          >
            <Download size={12} />
            JSON
          </button>
          <button
            onClick={loadLogs}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto font-mono text-xs p-3 space-y-0.5 bg-zinc-950">
        {entries.map((entry) => (
          <div key={entry.id} className={`rounded ${getEventBg(entry.eventType)}`}>
            {/* Main row */}
            <div
              className={`flex items-center gap-2 py-0.5 px-2 rounded ${hasDetails(entry) ? 'cursor-pointer hover:bg-zinc-900/50' : ''}`}
              onClick={() => hasDetails(entry) && setExpandedId(expandedId === entry.id ? null : entry.id)}
            >
              {hasDetails(entry) ? (
                expandedId === entry.id
                  ? <ChevronDown size={10} className="text-zinc-600 shrink-0" />
                  : <ChevronRight size={10} className="text-zinc-600 shrink-0" />
              ) : (
                <span className="w-[10px] shrink-0" />
              )}
              <span className="text-zinc-600 shrink-0">
                {new Date(entry.createdAt).toLocaleTimeString('pt-BR')}
              </span>
              <span className={`shrink-0 w-28 ${getEventColor(entry.eventType)}`}>
                [{entry.eventType}]
              </span>
              {entry.toolName && (
                <span className="text-cyan-400 shrink-0">{entry.toolName}</span>
              )}
              <span className="text-zinc-500 truncate min-w-0">
                {getSummaryText(entry)}
              </span>
              {entry.approved !== undefined && (
                <span className={`shrink-0 ${entry.approved ? 'text-green-400' : 'text-red-400'}`}>
                  {entry.approved ? 'APPROVED' : 'DENIED'}
                </span>
              )}
            </div>

            {/* Expanded details */}
            {expandedId === entry.id && (
              <div className="ml-8 px-3 py-2 mb-1 bg-zinc-900/60 rounded border border-zinc-800/50 space-y-1.5">
                {entry.sessionId && (
                  <div>
                    <span className="text-zinc-600">session: </span>
                    <span className="text-zinc-400">{entry.sessionId}</span>
                  </div>
                )}
                {entry.subagent && (
                  <div>
                    <span className="text-zinc-600">agente: </span>
                    <span className="text-amber-400">{entry.subagent}</span>
                  </div>
                )}
                {entry.input && (
                  <div>
                    <span className="text-zinc-600">input: </span>
                    <pre className="text-zinc-300 whitespace-pre-wrap break-all mt-0.5 max-h-40 overflow-y-auto">{entry.input}</pre>
                  </div>
                )}
                {entry.output && (
                  <div>
                    <span className="text-zinc-600">output: </span>
                    <pre className="text-zinc-300 whitespace-pre-wrap break-all mt-0.5 max-h-40 overflow-y-auto">{entry.output}</pre>
                  </div>
                )}
                {entry.durationMs !== undefined && (
                  <div>
                    <span className="text-zinc-600">duracao: </span>
                    <span className="text-zinc-400">{entry.durationMs}ms</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {entries.length === 0 && !isLoading && (
          <div className="text-center text-zinc-600 py-8">Nenhum log encontrado</div>
        )}
      </div>
    </div>
  );
}
