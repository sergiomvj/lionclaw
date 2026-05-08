import type { HarnessProject } from '../../../src/types';

/**
 * Campos base de PipelineProject extraidos do row de HarnessProject.
 *
 * Os handlers `pipeline:list-projects` e `pipeline:get-project` adicionam
 * extras especificos por cima desse mapeamento (ex.: get-project inclui
 * `awaitingUser`, `sprints`; list-projects sempre adiciona `metadata`).
 *
 * S7.6 da SPEC-refactor-pipelines.md — centraliza a parte comum pra evitar
 * drift entre os dois handlers.
 */
export interface PipelineProjectBase {
  id: string;
  name: string;
  projectPath: string;
  specPath: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  currentPhase: number | null;
  pipelineType: 'development' | 'security' | 'feature';
  createdAt: string;
  updatedAt: string;
}

/**
 * HarnessProject row carrega campos `pipeline_*` lidos do DB que nao constam
 * no tipo TypeScript exportado. Tipamos aqui o subset que usamos.
 */
type HarnessProjectRow = HarnessProject & {
  pipelineCurrentPhase?: number | null;
};

export function mapPipelineProject(p: HarnessProjectRow): PipelineProjectBase {
  return {
    id: p.id,
    name: p.name,
    projectPath: p.projectPath,
    specPath: p.specPath,
    status: p.status as PipelineProjectBase['status'],
    currentPhase: (p.pipelineCurrentPhase ?? null) as number | null,
    pipelineType: (p.pipelineType ?? 'development') as PipelineProjectBase['pipelineType'],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
