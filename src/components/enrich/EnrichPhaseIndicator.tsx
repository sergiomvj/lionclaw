// @deprecated - migrado para pipeline-engine/pipeline-store
import { CheckCircle, Circle, Dot } from 'lucide-react';
import type { EnrichPhase } from '@/types';

interface Props {
  phase: EnrichPhase;
}

interface PhaseStep {
  key: EnrichPhase;
  label: string;
  shortLabel: string;
}

const STEPS: PhaseStep[] = [
  { key: 'validator', label: 'Fase 1: Validacao', shortLabel: 'Validacao' },
  { key: 'enricher', label: 'Fase 2: Enrich', shortLabel: 'Enrich' },
];

function phaseIndex(phase: EnrichPhase): number {
  if (phase === 'validator') return 0;
  if (phase === 'enricher') return 1;
  return 2; // done
}

export function EnrichPhaseIndicator({ phase }: Props) {
  const current = phaseIndex(phase);

  return (
    <div className="flex items-center gap-1">
      {STEPS.map((step, idx) => {
        const isCompleted = current > idx;
        const isActive = current === idx;

        return (
          <div key={step.key} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-600 text-white'
                  : isCompleted
                  ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                  : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {isCompleted ? (
                <CheckCircle size={12} />
              ) : isActive ? (
                <Dot size={12} className="animate-pulse" />
              ) : (
                <Circle size={12} />
              )}
              {step.shortLabel}
            </div>
            {idx < STEPS.length - 1 && (
              <div
                className={`w-6 h-px ${
                  current > idx ? 'bg-green-500/50' : 'bg-zinc-700'
                }`}
              />
            )}
          </div>
        );
      })}
      {phase === 'done' && (
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-400 border border-green-500/30 ml-1">
          <CheckCircle size={12} />
          Concluido
        </div>
      )}
    </div>
  );
}
