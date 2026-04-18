import { useState } from 'react';
import { Plus, FileSearch } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import { useAppStore } from '@/stores/app-store';
import { useEnrichStore } from '@/stores/enrich-store';
import { ProjectCard } from './ProjectCard';
import { NewProjectModal } from './NewProjectModal';
import { EnrichModal } from '@/components/enrich/EnrichModal';
import { EnrichSessionCard } from '@/components/enrich/EnrichSessionCard';

export function ProjectList() {
  const { projects } = useHarnessStore();
  const { setPage } = useAppStore();
  const { sessions, setActiveSession, loadSessions: loadEnrichSessions, deleteSession } = useEnrichStore();
  const [showModal, setShowModal] = useState(false);
  const [showEnrichModal, setShowEnrichModal] = useState(false);

  const handleEnrichCreated = async (sessionId: string) => {
    await loadEnrichSessions();
    setActiveSession(sessionId);
    setPage('enrich');
  };

  const handleEnrichSessionClick = (sessionId: string) => {
    setActiveSession(sessionId);
    setPage('enrich');
  };

  // Separate active enrich sessions (not done) from completed ones
  const activeEnrichSessions = sessions.filter((s) => s.status !== 'done');
  const completedEnrichSessions = sessions.filter((s) => s.status === 'done');
  const hasContent = projects.length > 0 || sessions.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-zinc-100">Agent Harness</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowEnrichModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <FileSearch size={16} />
            Enrich Doc
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Novo Projeto
          </button>
        </div>
      </div>

      {!hasContent ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
          <p className="text-sm">Nenhum projeto ainda.</p>
          <p className="text-xs mt-1">Crie um novo projeto para comecar.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Active enrich sessions always on top */}
          {activeEnrichSessions.map((session) => (
            <EnrichSessionCard
              key={session.id}
              session={session}
              onClick={() => handleEnrichSessionClick(session.id)}
              onDelete={deleteSession}
            />
          ))}

          {/* Harness projects */}
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}

          {/* Completed enrich sessions at the bottom */}
          {completedEnrichSessions.map((session) => (
            <EnrichSessionCard
              key={session.id}
              session={session}
              onClick={() => handleEnrichSessionClick(session.id)}
              onDelete={deleteSession}
            />
          ))}
        </div>
      )}

      {showModal && <NewProjectModal onClose={() => setShowModal(false)} />}
      <EnrichModal
        isOpen={showEnrichModal}
        onClose={() => setShowEnrichModal(false)}
        onCreated={handleEnrichCreated}
      />
    </div>
  );
}
