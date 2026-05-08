import { usePipelineStore } from '@/stores/pipeline-store';
import { useAppStore } from '@/stores/app-store';
import { isActiveSidebarEntry } from './sidebar-utils';

function getDotColor(isStreaming: boolean, error: string | null, phaseStatus: string): string {
  if (error) return 'text-red-400';
  if (isStreaming) return 'text-green-400';
  if (phaseStatus === 'paused' || phaseStatus === 'interrupted') return 'text-yellow-400';
  return 'text-zinc-400';
}

function getPhaseLabel(currentPhase: number | null, phaseStatus: string): string {
  if (currentPhase === null) return phaseStatus || 'Aguardando';
  return `Fase ${currentPhase}`;
}

export function PipelinesActiveSidebar() {
  const projectStates = usePipelineStore((s) => s.projectStates);
  const projects = usePipelineStore((s) => s.projects);
  const setActiveProject = usePipelineStore((s) => s.setActiveProject);
  const setPage = useAppStore((s) => s.setPage);

  const activeEntries = [...projectStates.entries()].filter(([, ps]) =>
    isActiveSidebarEntry(ps),
  );

  if (activeEntries.length === 0) return null;

  const streamingCount = activeEntries.filter(([, ps]) => ps.isStreaming).length;

  return (
    <div className="px-2 py-2 border-t border-zinc-800">
      <p className="text-[10px] uppercase text-zinc-600 font-medium px-3 py-1 tracking-wider">
        Pipelines ativos
      </p>

      {streamingCount >= 5 && (
        <div className="mx-1 mb-1.5 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20">
          <span className="text-[11px] text-amber-400">
            Voce tem {streamingCount} pipelines rodando, atencao com quota da API.
          </span>
        </div>
      )}

      <div className="space-y-0.5">
        {activeEntries.map(([projectId, ps]) => {
          const project = projects.find((p) => p.id === projectId);
          const name = project?.name ?? projectId;
          const dotColor = getDotColor(ps.isStreaming, ps.error, ps.phaseStatus);
          const phaseLabel = getPhaseLabel(ps.currentPhase, ps.phaseStatus);

          return (
            <button
              key={projectId}
              onClick={() => {
                setActiveProject(projectId);
                setPage('pipeline');
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 transition-colors text-left"
              title={name}
            >
              <span className={`shrink-0 leading-none ${dotColor}`} aria-hidden="true">
                &#9679;
              </span>
              <span className="flex-1 min-w-0 truncate">{name}</span>
              <span className="shrink-0 text-zinc-600 text-[10px]">{phaseLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
