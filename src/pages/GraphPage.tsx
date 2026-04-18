import { useState, useEffect, useCallback } from 'react';
import { Loader2, Network, Sprout } from 'lucide-react';
import type { GraphNode, GraphEdge, MgraphStats } from '@/types';
import { fetchGraphData } from '@/components/graph-view/graph-parser';
import { GraphCanvas } from '@/components/graph-view/GraphCanvas';
import { GraphControls } from '@/components/graph-view/GraphControls';
import { GraphSidebar } from '@/components/graph-view/GraphSidebar';

type LoadState = 'loading' | 'ready' | 'empty';

export function GraphPage() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [stats, setStats] = useState<MgraphStats | null>(null);
  const [selectedNode, setSelectedNode] = useState<{ id: string; type: string } | null>(null);
  const [seeding, setSeeding] = useState(false);

  // Filter / search state
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(['entity', 'meeting', 'decision', 'project', 'reference']));
  const [searchQuery, setSearchQuery] = useState('');

  // Zoom counters (bumped to trigger zoom in GraphCanvas)
  const [zoomInCount, setZoomInCount] = useState(0);
  const [zoomOutCount, setZoomOutCount] = useState(0);

  const loadData = useCallback(async () => {
    setLoadState('loading');
    try {
      const [data, statsData] = await Promise.all([
        fetchGraphData(),
        window.lionclaw.mgraph.stats(),
      ]);
      setNodes(data.nodes);
      setEdges(data.edges);
      setStats(statsData);
      setLoadState(data.nodes.length === 0 ? 'empty' : 'ready');
    } catch {
      setNodes([]);
      setEdges([]);
      setLoadState('empty');
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for mgraph:updated events (after compaction)
  useEffect(() => {
    const unsub = window.lionclaw.mgraph.onUpdated(() => {
      loadData();
    });
    return unsub;
  }, [loadData]);

  // Compute active node IDs based on filters + search
  const activeNodeIds: Set<string> | null = (() => {
    const hasTypeFilter = activeTypes.size < 5;
    const hasSearch = searchQuery.length > 0;
    if (!hasTypeFilter && !hasSearch) return null; // all visible

    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const node of nodes) {
      if (!activeTypes.has(node.type)) continue;
      if (hasSearch) {
        const matchTitle = node.title.toLowerCase().includes(q);
        const matchTags = node.tags.some(t => t.toLowerCase().includes(q));
        if (!matchTitle && !matchTags) continue;
      }
      ids.add(node.id);
    }
    return ids;
  })();

  const handleSeed = async () => {
    setSeeding(true);
    try {
      await window.lionclaw.mgraph.seed();
      await loadData();
    } finally {
      setSeeding(false);
    }
  };

  // Loading state
  if (loadState === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-zinc-500" />
          <span className="text-sm text-zinc-500">Carregando graph...</span>
        </div>
      </div>
    );
  }

  // Empty state
  if (loadState === 'empty') {
    const hasMessages = stats && stats.totalNotes === 0;
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Network size={28} className="text-zinc-600" />
          </div>
          <h2 className="text-lg font-medium text-zinc-300">
            O Memory Graph ainda esta vazio.
          </h2>
          <p className="text-sm text-zinc-500">
            Converse com o LionClaw para que ele comece a construir conexoes de conhecimento automaticamente.
          </p>
          {hasMessages && (
            <button
              onClick={handleSeed}
              disabled={seeding}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {seeding ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Sprout size={16} />
              )}
              Rodar seed agora
            </button>
          )}
        </div>
      </div>
    );
  }

  // Ready state — graph view
  return (
    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
      <GraphControls
        onFilterChange={setActiveTypes}
        onSearchChange={setSearchQuery}
        onRefresh={loadData}
        onZoomIn={() => setZoomInCount(c => c + 1)}
        onZoomOut={() => setZoomOutCount(c => c + 1)}
      />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            onNodeClick={(id, type) => setSelectedNode({ id, type })}
            activeNodeIds={activeNodeIds}
            zoomIn={zoomInCount}
            zoomOut={zoomOutCount}
          />
          {/* Stats overlay */}
          {stats && (
            <div className="absolute bottom-3 left-3 flex items-center gap-3 px-3 py-1.5 rounded bg-zinc-900/80 border border-zinc-800 text-[10px] font-mono text-zinc-500">
              <span>{stats.totalNotes} notas</span>
              <span>{stats.totalConnections} conexoes</span>
            </div>
          )}
        </div>
        {selectedNode && (
          <GraphSidebar
            nodeId={selectedNode.id}
            nodeType={selectedNode.type}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>
    </div>
  );
}
