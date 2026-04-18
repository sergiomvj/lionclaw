import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import type { EvaluationResult, EvaluationCriterion } from '../../src/types';
import type { SprintJsonEntry } from './harness-planner';

const logger = createLogger('harness-evaluator');

/**
 * Build the Evaluator prompt with anti-hallucination rules.
 * The Evaluator receives: sprint features + acceptance criteria + instructions to output evaluation.json
 */
export function buildEvaluatorPrompt(
  sprintJson: SprintJsonEntry,
  projectPath: string,
): string {
  const criteriaBlock = sprintJson.features.map(f => {
    const criteria = f.acceptance_criteria.map((c, i) =>
      `  - ${f.id}-c${i + 1}: "${c}"`,
    ).join('\n');
    return `### ${f.name} (${f.id})\n${f.description}\n\nCriterios:\n${criteria}`;
  }).join('\n\n');

  return `## Diretorio do Projeto
${projectPath}

## Sprint: ${sprintJson.name}
${sprintJson.description}

## Features e Criterios de Aceite
${criteriaBlock}

## Formato OBRIGATORIO do output (JSON puro, sem markdown, sem code blocks)

{
  "sprint_id": "${sprintJson.id}",
  "verdict": "pass" | "fail",
  "criteria": [
    {
      "id": "feat-001-c1",
      "feature_id": "feat-001",
      "description": "descricao curta do criterio",
      "result": "pass" | "fail",
      "justification": "explicacao concreta (arquivo, linha, comportamento)"
    }
  ],
  "summary": "resumo da avaliacao"
}

REGRAS DO SCHEMA:
- Use EXATAMENTE "result" (nao "verdict") dentro de cada item de "criteria".
- "verdict" so aparece no nivel raiz do JSON.
- O "verdict" raiz so e "pass" se TODOS os itens de "criteria" tiverem "result": "pass".
- Inclua "feature_id" em cada criterio (ex: "feat-001-c1" pertence a "feat-001").`;
}

/**
 * Parse the Evaluator's JSON output, validating structure.
 */
export function parseEvaluationOutput(rawOutput: string, roundNumber: number): EvaluationResult {
  let jsonStr = rawOutput.trim();

  if (!jsonStr) {
    throw new Error('Evaluator returned empty output. The agent may have only used tools without producing a final JSON response.');
  }

  // Handle markdown code blocks
  const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  }

  // Find JSON object
  const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) {
    jsonStr = jsonObjMatch[0];
  } else {
    throw new Error(`Evaluator output contains no JSON object. Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Evaluator output is not valid JSON. Parse error: ${(e as Error).message}. Extracted JSON (first 500 chars): ${jsonStr.slice(0, 500)}`);
  }

  if (!parsed['sprint_id']) throw new Error('Missing sprint_id in evaluation output');
  if (!parsed['verdict']) throw new Error('Missing verdict in evaluation output');
  if (!Array.isArray(parsed['criteria'])) throw new Error('Missing criteria array in evaluation output');

  // Derive feature_id from criterion id (ex: "feat-001-c1" -> "feat-001") when model omits it.
  const deriveFeatureId = (id: string): string => {
    const match = id.match(/^(.+)-c\d+$/);
    return match ? match[1] : '';
  };

  let sawCriterionVerdictFallback = false;
  const criteria: EvaluationCriterion[] = (parsed['criteria'] as Array<Record<string, unknown>>).map(c => {
    const id = (c['id'] as string) || '';
    // Accept both "result" (spec) and "verdict" (model drift) at criterion level.
    const rawOutcome = (c['result'] ?? c['verdict']) as 'pass' | 'fail' | undefined;
    if (c['result'] === undefined && c['verdict'] !== undefined) {
      sawCriterionVerdictFallback = true;
    }
    return {
      id,
      featureId: (c['feature_id'] as string) || deriveFeatureId(id),
      description: (c['description'] as string) || '',
      result: rawOutcome === 'pass' || rawOutcome === 'fail' ? rawOutcome : 'fail',
      justification: (c['justification'] as string) || '',
    };
  });

  if (sawCriterionVerdictFallback) {
    logger.warn(
      { sprintId: parsed['sprint_id'], round: roundNumber },
      'Evaluator used "verdict" instead of "result" at criterion level - parser accepted both, but prompt/schema may be drifting.',
    );
  }

  // Determine real verdict from criteria (override agent's verdict if inconsistent)
  const allPass = criteria.every(c => c.result === 'pass');
  const verdict: 'pass' | 'fail' = allPass ? 'pass' : 'fail';

  return {
    sprintId: parsed['sprint_id'] as string,
    round: roundNumber,
    verdict,
    criteria,
    summary: (parsed['summary'] as string) || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate that all criteria IDs in the evaluation match the sprint JSON.
 * Returns only valid criteria, logging warnings for invented ones.
 */
export function validateCriteria(
  evaluation: EvaluationResult,
  sprintJson: SprintJsonEntry,
): EvaluationResult {
  // Build a set of valid criteria IDs from the sprint JSON
  const validIds = new Set<string>();
  for (const feature of sprintJson.features) {
    feature.acceptance_criteria.forEach((_, i) => {
      validIds.add(`${feature.id}-c${i + 1}`);
    });
  }

  const validCriteria: EvaluationCriterion[] = [];
  for (const criterion of evaluation.criteria) {
    if (validIds.has(criterion.id)) {
      validCriteria.push(criterion);
    } else {
      logger.warn(
        { criterionId: criterion.id, sprintId: evaluation.sprintId },
        'Evaluator invented criterion - ignoring',
      );
    }
  }

  // Recalculate verdict based on valid criteria only
  const allPass = validCriteria.length > 0 && validCriteria.every(c => c.result === 'pass');

  return {
    ...evaluation,
    criteria: validCriteria,
    verdict: allPass ? 'pass' : 'fail',
  };
}

/**
 * Update SPEC_PROGRESS.md after a sprint is approved.
 * Follows the enxuto format: ~4-6 lines per sprint.
 */
export function updateSpecProgress(
  projectPath: string,
  projectName: string,
  sprintJson: SprintJsonEntry,
  totalSprints: number,
  completedCount: number,
): void {
  const specProgressPath = path.join(projectPath, 'SPEC_PROGRESS.md');

  let content: string;
  if (fs.existsSync(specProgressPath)) {
    content = fs.readFileSync(specProgressPath, 'utf-8');
  } else {
    content = `# SPEC_PROGRESS - ${projectName}\n\n## Status: 0/${totalSprints} sprints concluidas\nUltima atualizacao: ${new Date().toISOString()}\n\n---\n`;
  }

  // Update status line
  content = content.replace(
    /## Status: \d+\/\d+ sprints concluidas/,
    `## Status: ${completedCount}/${totalSprints} sprints concluidas`,
  );
  content = content.replace(
    /Ultima atualizacao: .*/,
    `Ultima atualizacao: ${new Date().toISOString()}`,
  );

  // Build sprint entry
  const features = sprintJson.features.map(f => `- ${f.name}: ${f.description}`).join('\n');
  const sprintEntry = `\n## Sprint ${String(sprintJson.index + 1).padStart(3, '0')} - ${sprintJson.name} [CONCLUIDA]\n${features}\n`;

  content += sprintEntry;

  fs.writeFileSync(specProgressPath, content, 'utf-8');
  logger.info({ projectPath, sprint: sprintJson.name }, 'SPEC_PROGRESS.md updated');
}

/**
 * Build a concise feedback summary from failed criteria for the Coder's next round.
 */
export function buildFeedbackFromEvaluation(evaluation: EvaluationResult): string {
  const failedCriteria = evaluation.criteria.filter(c => c.result === 'fail');
  if (failedCriteria.length === 0) return '';

  const lines = failedCriteria.map(c =>
    `- [FAIL] ${c.description}: ${c.justification}`,
  ).join('\n');

  return `${evaluation.summary}\n\nCriterios que falharam:\n${lines}`;
}
