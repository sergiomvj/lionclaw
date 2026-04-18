import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { insertHarnessSprint, getAllAgents } from './db';
import type { AgentConfig, HarnessProject } from '../../src/types';

const logger = createLogger('harness-planner');

// Schema for the sprints.json output
export interface SprintsJson {
  project: {
    id: string;
    name: string;
    description: string;
    path: string;
    stack: string[];
    config: {
      max_rounds_per_sprint: number;
      use_playwright: boolean;
      evaluator_agent_id: string;
      planner_agent_id: string;
    };
  };
  sprints: SprintJsonEntry[];
  metadata: {
    version: number;
    created_at: string;
    total_sprints: number;
    total_features: number;
  };
}

export interface SprintJsonEntry {
  id: string;
  index: number;
  name: string;
  description: string;
  coder_agent_id: string;
  stack: string[];
  features: SprintFeature[];
  hints: {
    existing_files: string[];
    key_interfaces: string[];
    architecture_notes: string;
  };
  dependencies: string[];
  complexity: 'low' | 'medium' | 'high';
  estimated_rounds: number;
}

export interface SprintFeature {
  id: string;
  name: string;
  description: string;
  acceptance_criteria: string[];
}

/**
 * Build the prompt for the Planner agent.
 * Includes: spec content, available agents list, expected JSON schema.
 */
export function buildPlannerPrompt(
  specContent: string,
  project: HarnessProject,
  agents: AgentConfig[],
): string {
  const agentList = agents
    .filter(a => a.isActive && !['harness-coder', 'harness-evaluator', 'harness-planner'].includes(a.id))
    .map(a => `- ${a.name} (ID: ${a.id}): ${a.description}`)
    .join('\n');

  return `## Spec do Projeto
${specContent}

## Agentes Disponiveis (Coders)
${agentList}

## Regras de Selecao de Agente

1. O campo coder_agent_id DEVE conter o ID exato de um dos agentes listados acima
2. React / Next.js / Frontend / UI -> nextjs-developer ou frontend-developer
3. Node.js / API / Backend / Express / Fastify -> backend-developer
4. Electron / Desktop -> electron-pro
5. JavaScript generico / utilitarios -> javascript-pro
6. Quando em duvida, escolha o especialista mais proximo da stack da sprint. NUNCA use harness-coder

## Dados do Projeto
- ID: ${project.id}
- Nome: ${project.name}
- Descricao: ${project.description ?? ''}
- Path: ${project.projectPath}
- Stack: ${JSON.stringify(project.config.stack)}
- Max rounds por sprint: ${project.config.maxRoundsPerSprint}
- Playwright: ${project.config.usePlaywright}
- evaluator_agent_id: "${project.config.evaluatorAgentId}"
- planner_agent_id: "${project.config.plannerAgentId}"
- created_at: "${new Date().toISOString()}"

## Formato de Output
Responda com JSON puro no seguinte schema (preencha com os dados reais das sprints):

{
  "project": {
    "id": "${project.id}",
    "name": "${project.name}",
    "description": "${project.description ?? ''}",
    "path": "${project.projectPath}",
    "stack": ${JSON.stringify(project.config.stack)},
    "config": {
      "max_rounds_per_sprint": ${project.config.maxRoundsPerSprint},
      "use_playwright": ${project.config.usePlaywright},
      "evaluator_agent_id": "${project.config.evaluatorAgentId}",
      "planner_agent_id": "${project.config.plannerAgentId}"
    }
  },
  "sprints": [
    {
      "id": "sprint-001",
      "index": 0,
      "name": "Nome da Sprint",
      "description": "Descricao do que sera implementado",
      "coder_agent_id": "id-do-agente",
      "stack": ["tech1", "tech2"],
      "features": [
        {
          "id": "feat-001",
          "name": "Nome da Feature",
          "description": "O que sera implementado",
          "acceptance_criteria": [
            "Criterio verificavel 1",
            "Criterio verificavel 2"
          ]
        }
      ],
      "hints": {
        "existing_files": [],
        "key_interfaces": [],
        "architecture_notes": ""
      },
      "dependencies": [],
      "complexity": "low",
      "estimated_rounds": 1
    }
  ],
  "metadata": {
    "version": 1,
    "created_at": "${new Date().toISOString()}",
    "total_sprints": 0,
    "total_features": 0
  }
}`;
}

/**
 * Parse and validate the Planner's JSON output against the expected schema.
 * Extracts JSON from the output text (handles cases where the agent wraps in markdown or free text).
 */
export function parsePlannerOutput(rawOutput: string): SprintsJson {
  // Try to extract JSON from the output
  let jsonStr = rawOutput.trim();

  // Handle markdown code blocks
  const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  }

  // Try to find the outermost JSON object by matching balanced braces
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') depth++;
      else if (jsonStr[i] === '}') {
        depth--;
        if (depth === 0) { lastBrace = i; break; }
      }
    }
    if (lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }

  // If no JSON object found at all, give a clear error
  if (!jsonStr.startsWith('{')) {
    const preview = rawOutput.slice(0, 200).replace(/\n/g, ' ');
    throw new Error(
      `Planner nao retornou JSON valido. Inicio da resposta: "${preview}..."`,
    );
  }

  const parsed = JSON.parse(jsonStr) as SprintsJson;

  // Validate required fields
  if (!parsed.project) throw new Error('Missing "project" in planner output');
  if (!Array.isArray(parsed.sprints)) throw new Error('Missing "sprints" array in planner output');
  if (parsed.sprints.length === 0) throw new Error('Planner generated 0 sprints');

  // Validate each sprint
  for (const sprint of parsed.sprints) {
    if (!sprint.id) throw new Error(`Sprint missing "id"`);
    if (!sprint.name) throw new Error(`Sprint "${sprint.id}" missing "name"`);
    if (!Array.isArray(sprint.features)) throw new Error(`Sprint "${sprint.id}" missing "features"`);

    for (const feature of sprint.features) {
      if (!feature.id) throw new Error(`Feature missing "id" in sprint "${sprint.id}"`);
      if (!Array.isArray(feature.acceptance_criteria)) {
        throw new Error(`Feature "${feature.id}" missing "acceptance_criteria"`);
      }
    }
  }

  // Fix metadata counts
  parsed.metadata = parsed.metadata ?? { version: 1, created_at: new Date().toISOString(), total_sprints: 0, total_features: 0 };
  parsed.metadata.total_sprints = parsed.sprints.length;
  parsed.metadata.total_features = parsed.sprints.reduce((sum, s) => sum + s.features.length, 0);

  return parsed;
}

/**
 * Build the prompt for the Planner agent using Markdown output format.
 */
export function buildPlannerMarkdownPrompt(
  specContent: string,
  project: HarnessProject,
  agents: AgentConfig[],
): string {
  const agentList = agents
    .filter(a => a.isActive && !['harness-coder', 'harness-evaluator', 'harness-planner'].includes(a.id))
    .map(a => `- ${a.name} (ID: ${a.id}): ${a.description}`)
    .join('\n');

  return `## Spec do Projeto
${specContent}

## Agentes Disponiveis (Coders)
${agentList}

## Regras de Selecao de Agente

1. O campo coder_agent_id DEVE conter o ID exato de um dos agentes listados acima
2. React / Next.js / Frontend / UI -> nextjs-developer ou frontend-developer
3. Node.js / API / Backend / Express / Fastify -> backend-developer
4. Electron / Desktop -> electron-pro
5. JavaScript generico / utilitarios -> javascript-pro
6. Quando em duvida, escolha o especialista mais proximo da stack da sprint. NUNCA use harness-coder

## Dados do Projeto
- ID: ${project.id}
- Nome: ${project.name}
- Descricao: ${project.description ?? ''}
- Path: ${project.projectPath}
- Stack: ${project.config.stack.join(', ')}
- Max rounds por sprint: ${project.config.maxRoundsPerSprint}
- Playwright: ${project.config.usePlaywright}

## Formato de Output
Responda com Markdown seguindo exatamente esta estrutura (cada sprint separada por "---"):

# Sprint 1: Nome da Sprint
- **Coder:** id-do-agente
- **Complexidade:** low | medium | high
- **Stack:** tech1, tech2
- **Depende de:** nenhuma
- **Rounds estimados:** 1

Descricao do que sera implementado nesta sprint.

## Feature: Nome da Feature
Descricao da feature.

### Criterios de aceite
- Criterio verificavel 1
- Criterio verificavel 2

## Hints
- **Arquivos existentes:** path/to/file1.ts, path/to/file2.ts
- **Interfaces chave:** User, Product
- **Arquitetura:** Notas sobre decisoes de design

---

# Sprint 2: Nome da Sprint
...`;
}

/**
 * Parse Markdown output from the Planner into the SprintsJson structure.
 * Tolerant parser: accepts variations in heading levels and formatting.
 */
export function parsePlannerMarkdown(rawOutput: string, project: HarnessProject): SprintsJson {
  const text = rawOutput.trim();

  // Split by sprint headers: "# Sprint N:" or "# Sprint N -"
  const sprintBlocks = text.split(/(?=^# Sprint \d+[:\s-])/m).filter(b => b.trim());

  if (sprintBlocks.length === 0) {
    throw new Error('Planner nao retornou nenhuma sprint em Markdown. Esperado "# Sprint 1: ..."');
  }

  const sprints: SprintJsonEntry[] = [];

  for (let i = 0; i < sprintBlocks.length; i++) {
    const block = sprintBlocks[i].trim();

    // Parse sprint header: "# Sprint N: Name"
    const headerMatch = block.match(/^# Sprint \d+[:\s-]\s*(.+)/m);
    if (!headerMatch) continue;

    const sprintName = headerMatch[1].trim();
    const sprintId = `sprint-${String(i + 1).padStart(3, '0')}`;

    // Parse metadata fields
    const coderMatch = block.match(/\*\*Coder:\*\*\s*(.+)/i);
    const complexityMatch = block.match(/\*\*Complexidade:\*\*\s*(low|medium|high)/i);
    const stackMatch = block.match(/\*\*Stack:\*\*\s*(.+)/i);
    const dependsMatch = block.match(/\*\*Depende de:\*\*\s*(.+)/i);
    const roundsMatch = block.match(/\*\*Rounds estimados:\*\*\s*(\d+)/i);

    // Parse description: text between metadata block and first ## Feature
    const firstFeatureIdx = block.search(/^##\s+Feature[:\s]/m);
    let description = '';
    if (firstFeatureIdx !== -1) {
      // Find the paragraph between metadata and first feature
      const afterMeta = block.slice(0, firstFeatureIdx);
      const lines = afterMeta.split('\n');
      const descLines: string[] = [];
      let pastMeta = false;
      for (const line of lines) {
        if (line.startsWith('# ')) continue;
        if (line.match(/^\s*-\s*\*\*/)) { pastMeta = true; continue; }
        if (pastMeta && line.trim()) {
          descLines.push(line.trim());
        }
      }
      description = descLines.join(' ').trim();
    }

    // Parse features
    const featureBlocks = block.split(/(?=^##\s+Feature[:\s])/m).filter(b => b.match(/^##\s+Feature[:\s]/m));
    const features: SprintFeature[] = [];

    for (let j = 0; j < featureBlocks.length; j++) {
      const fb = featureBlocks[j].trim();

      // Feature name: "## Feature: Name"
      const featNameMatch = fb.match(/^##\s+Feature[:\s-]\s*(.+)/m);
      if (!featNameMatch) continue;

      const featName = featNameMatch[1].trim();
      const featId = `feat-${String(i + 1).padStart(3, '0')}-${String(j + 1).padStart(3, '0')}`;

      // Feature description: text between header and ### Criterios
      const criteriaHeaderIdx = fb.search(/^###?\s+Crit[eé]rios/mi);
      let featDescription = '';
      if (criteriaHeaderIdx !== -1) {
        const descPart = fb.slice(featNameMatch[0].length, criteriaHeaderIdx).trim();
        featDescription = descPart.replace(/\n+/g, ' ').trim();
      }

      // Parse acceptance criteria: lines starting with "- " after "### Criterios"
      const criteria: string[] = [];
      if (criteriaHeaderIdx !== -1) {
        const criteriaSection = fb.slice(criteriaHeaderIdx);
        const criteriaLines = criteriaSection.split('\n');
        for (const line of criteriaLines) {
          const critMatch = line.match(/^\s*-\s+\[?\s*]?\s*(.+)/);
          if (critMatch && !critMatch[1].startsWith('**')) {
            criteria.push(critMatch[1].trim());
          }
        }
      }

      features.push({
        id: featId,
        name: featName,
        description: featDescription,
        acceptance_criteria: criteria,
      });
    }

    // Parse hints
    const hintsMatch = block.match(/^##\s+Hints?\s*\n([\s\S]*?)(?=\n---|\n# Sprint|$)/mi);
    const hints = {
      existing_files: [] as string[],
      key_interfaces: [] as string[],
      architecture_notes: '',
    };

    if (hintsMatch) {
      const hintsBlock = hintsMatch[1];
      const filesMatch = hintsBlock.match(/\*\*Arquivos?\s*existentes?:\*\*\s*(.+)/i);
      const interfacesMatch = hintsBlock.match(/\*\*Interfaces?\s*chave:\*\*\s*(.+)/i);
      const archMatch = hintsBlock.match(/\*\*Arquitetura:\*\*\s*(.+)/i);

      if (filesMatch) {
        hints.existing_files = filesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (interfacesMatch) {
        hints.key_interfaces = interfacesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (archMatch) {
        hints.architecture_notes = archMatch[1].trim();
      }
    }

    // Parse dependencies
    const dependencies: string[] = [];
    if (dependsMatch) {
      const depText = dependsMatch[1].trim().toLowerCase();
      if (depText !== 'nenhuma' && depText !== 'nenhum' && depText !== 'none' && depText !== '-') {
        // Extract sprint numbers: "sprint 1, sprint 2" or "1, 2" or "sprint-001"
        const depNumbers = depText.match(/\d+/g);
        if (depNumbers) {
          for (const num of depNumbers) {
            dependencies.push(`sprint-${num.padStart(3, '0')}`);
          }
        }
      }
    }

    // Parse stack
    const stack: string[] = stackMatch
      ? stackMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : [];

    sprints.push({
      id: sprintId,
      index: i,
      name: sprintName,
      description,
      coder_agent_id: coderMatch ? coderMatch[1].trim() : '',
      stack,
      features,
      hints,
      dependencies,
      complexity: (complexityMatch?.[1]?.toLowerCase() as 'low' | 'medium' | 'high') ?? 'medium',
      estimated_rounds: roundsMatch ? parseInt(roundsMatch[1], 10) : 2,
    });
  }

  if (sprints.length === 0) {
    throw new Error('Planner Markdown nao continha sprints parseavaveis');
  }

  // Validate: every sprint must have at least one feature
  for (const sprint of sprints) {
    if (sprint.features.length === 0) {
      logger.warn({ sprintId: sprint.id, sprintName: sprint.name }, 'Sprint sem features detectada');
    }
    for (const feature of sprint.features) {
      if (feature.acceptance_criteria.length === 0) {
        logger.warn({ featId: feature.id, featName: feature.name }, 'Feature sem criterios de aceite');
      }
    }
  }

  const totalFeatures = sprints.reduce((sum, s) => sum + s.features.length, 0);

  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      path: project.projectPath,
      stack: project.config.stack,
      config: {
        max_rounds_per_sprint: project.config.maxRoundsPerSprint,
        use_playwright: project.config.usePlaywright,
        evaluator_agent_id: project.config.evaluatorAgentId,
        planner_agent_id: project.config.plannerAgentId,
      },
    },
    sprints,
    metadata: {
      version: 1,
      created_at: new Date().toISOString(),
      total_sprints: sprints.length,
      total_features: totalFeatures,
    },
  };
}

/**
 * Convert SprintsJson back to Markdown format (for regeneration prompts).
 */
export function sprintsJsonToMarkdown(sprintsJson: SprintsJson): string {
  return sprintsJson.sprints.map((sprint, i) => {
    const deps = sprint.dependencies.length > 0
      ? sprint.dependencies.map(d => {
          const num = d.match(/\d+/);
          return num ? `sprint ${parseInt(num[0], 10)}` : d;
        }).join(', ')
      : 'nenhuma';

    const featuresBlock = sprint.features.map(f => {
      const criteria = f.acceptance_criteria.map(c => `- ${c}`).join('\n');
      return `## Feature: ${f.name}\n${f.description}\n\n### Criterios de aceite\n${criteria}`;
    }).join('\n\n');

    const hintsLines: string[] = [];
    if (sprint.hints.existing_files.length > 0) {
      hintsLines.push(`- **Arquivos existentes:** ${sprint.hints.existing_files.join(', ')}`);
    }
    if (sprint.hints.key_interfaces.length > 0) {
      hintsLines.push(`- **Interfaces chave:** ${sprint.hints.key_interfaces.join(', ')}`);
    }
    if (sprint.hints.architecture_notes) {
      hintsLines.push(`- **Arquitetura:** ${sprint.hints.architecture_notes}`);
    }
    const hintsBlock = hintsLines.length > 0 ? `\n## Hints\n${hintsLines.join('\n')}` : '';

    return `# Sprint ${i + 1}: ${sprint.name}
- **Coder:** ${sprint.coder_agent_id}
- **Complexidade:** ${sprint.complexity}
- **Stack:** ${sprint.stack.join(', ')}
- **Depende de:** ${deps}
- **Rounds estimados:** ${sprint.estimated_rounds}

${sprint.description}

${featuresBlock}${hintsBlock}`;
  }).join('\n\n---\n\n');
}

/**
 * Get the next version number for sprint files by checking existing files.
 * Checks both .json and .md files to maintain a single version sequence.
 */
export function getNextSprintsVersion(projectDir: string): number {
  const files = fs.existsSync(projectDir)
    ? fs.readdirSync(projectDir).filter(f => f.match(/^sprints\.v\d+\.(json|md)$/))
    : [];

  if (files.length === 0) return 1;

  const versions = files.map(f => {
    const match = f.match(/^sprints\.v(\d+)\.(json|md)$/);
    return match ? parseInt(match[1], 10) : 0;
  });

  return Math.max(...versions) + 1;
}

/**
 * Save sprints with versioning and create sprint records in DB.
 * Saves as .json always (for the frontend/engine) and additionally as .md when format is 'markdown'.
 */
export function saveSprintsJson(
  projectId: string,
  projectDir: string,
  sprintsJson: SprintsJson,
  evaluatorAgentId: string,
  format: 'json' | 'markdown' = 'json',
): { path: string; version: number } {
  const version = getNextSprintsVersion(projectDir);
  sprintsJson.metadata.version = version;

  fs.mkdirSync(projectDir, { recursive: true });

  // Always save .json (the engine and frontend need it for structured access)
  const jsonFilename = `sprints.v${version}.json`;
  const jsonPath = path.join(projectDir, jsonFilename);
  fs.writeFileSync(jsonPath, JSON.stringify(sprintsJson, null, 2), 'utf-8');

  // Also save .md for readability when format is markdown
  if (format === 'markdown') {
    const mdFilename = `sprints.v${version}.md`;
    const mdPath = path.join(projectDir, mdFilename);
    fs.writeFileSync(mdPath, sprintsJsonToMarkdown(sprintsJson), 'utf-8');
  }

  // Create sprint records in DB
  for (const sprint of sprintsJson.sprints) {
    insertHarnessSprint({
      projectId,
      sprintIndex: sprint.index,
      sprintJsonId: sprint.id,
      name: sprint.name,
      coderAgentId: sprint.coder_agent_id,
      evaluatorAgentId,
      maxRounds: sprintsJson.project.config.max_rounds_per_sprint,
    });
  }

  logger.info({ projectId, version, format, sprintCount: sprintsJson.sprints.length }, 'Saved sprints');

  return { path: jsonPath, version };
}

/**
 * Build the regeneration prompt with previous sprints and user feedback.
 * Supports both JSON and Markdown output formats.
 */
export function buildRegenerationPrompt(
  previousJson: SprintsJson,
  feedback: string,
  specContent: string,
  agents: AgentConfig[],
  format: 'json' | 'markdown' = 'json',
): string {
  const fakeProject: HarnessProject = {
    id: previousJson.project.id,
    name: previousJson.project.name,
    description: previousJson.project.description,
    projectPath: previousJson.project.path,
    specPath: '',
    config: {
      maxRoundsPerSprint: previousJson.project.config.max_rounds_per_sprint,
      usePlaywright: previousJson.project.config.use_playwright,
      evaluatorAgentId: previousJson.project.config.evaluator_agent_id,
      plannerAgentId: previousJson.project.config.planner_agent_id,
      stack: previousJson.project.stack,
      plannerOutputFormat: format,
    },
    sprintsJsonPath: undefined,
    status: 'planning' as const,
    currentSprintIndex: 0,
    totalSprints: previousJson.metadata.total_sprints,
    totalFeatures: previousJson.metadata.total_features,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheTokens: 0,
    plannerCostUsd: 0,
    plannerDurationMs: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const basePrompt = format === 'markdown'
    ? buildPlannerMarkdownPrompt(specContent, fakeProject, agents)
    : buildPlannerPrompt(specContent, fakeProject, agents);

  const previousContent = format === 'markdown'
    ? sprintsJsonToMarkdown(previousJson)
    : JSON.stringify(previousJson, null, 2);

  return `${basePrompt}

## Versao Anterior (v${previousJson.metadata.version})
${previousContent}

## Feedback do Usuario
${feedback}`;
}

/**
 * Read the latest sprints.json for a project directory.
 * Returns the parsed SprintsJson or null if none exists.
 */
export function readLatestSprintsJson(projectDir: string): SprintsJson | null {
  if (!fs.existsSync(projectDir)) return null;

  const files = fs.readdirSync(projectDir).filter(f => f.match(/^sprints\.v\d+\.json$/));
  if (files.length === 0) return null;

  const versions = files.map(f => {
    const match = f.match(/^sprints\.v(\d+)\.json$/);
    return { file: f, version: match ? parseInt(match[1], 10) : 0 };
  });

  versions.sort((a, b) => b.version - a.version);
  const latest = versions[0];

  const content = fs.readFileSync(path.join(projectDir, latest.file), 'utf-8');
  return JSON.parse(content) as SprintsJson;
}

export { getAllAgents };
