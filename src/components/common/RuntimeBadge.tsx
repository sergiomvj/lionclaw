import type { AgentConfig } from '@/types';

// Generic runtime badge pill used across pipeline views.
// For the SubAgentsPage rich badge (with provider labels and model details)
// see the inline RuntimeBadge in pages/SubAgentsPage.tsx.

interface RuntimeBadgeProps {
  runtime: AgentConfig['runtime'] | null | undefined;
}

const BASE = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium cursor-default select-none';

export function RuntimeBadge({ runtime }: RuntimeBadgeProps) {
  switch (runtime) {
    case 'cloud':
      return (
        <span className={`${BASE} bg-blue-600/20 text-blue-400 border border-blue-600/30`}>
          Cloud
        </span>
      );
    case 'local':
      return (
        <span className={`${BASE} bg-green-600/20 text-green-400 border border-green-600/30`}>
          Local
        </span>
      );
    case 'external':
      return (
        <span className={`${BASE} bg-orange-600/20 text-orange-400 border border-orange-600/30`}>
          External
        </span>
      );
    case 'codex':
      return (
        <span className={`${BASE} bg-purple-600/20 text-purple-400 border border-purple-600/30`}>
          Codex
        </span>
      );
    default:
      return (
        <span className={`${BASE} bg-zinc-800 text-zinc-500 border border-zinc-700`}>
          &mdash;
        </span>
      );
  }
}
