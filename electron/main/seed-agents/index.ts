/**
 * Seed agents for the Agent Harness and BuildPlan Workflow features.
 *
 * These agents ship with LionClaw and are created on first boot.
 * The user can edit them freely after creation (model, prompt, tools, etc).
 * If deleted, they can be re-created by calling ensureHarnessAgents() / ensureWorkflowAgents().
 */

// ---- Harness Agents ----

export { harnessPlanner, HARNESS_PLANNER_ID } from './harness-planner';
export { harnessCoder, HARNESS_CODER_ID } from './harness-coder';
export { harnessEvaluator, HARNESS_EVALUATOR_ID } from './harness-evaluator';

import { harnessPlanner, HARNESS_PLANNER_ID } from './harness-planner';
import { harnessCoder, HARNESS_CODER_ID } from './harness-coder';
import { harnessEvaluator, HARNESS_EVALUATOR_ID } from './harness-evaluator';

export const HARNESS_AGENT_IDS = [
  HARNESS_PLANNER_ID,
  HARNESS_CODER_ID,
  HARNESS_EVALUATOR_ID,
] as const;

export const HARNESS_SEED_AGENTS = [
  harnessPlanner,
  harnessCoder,
  harnessEvaluator,
];

// ---- Workflow (BuildPlan) Agents ----

export { specBuilder, SPEC_BUILDER_ID } from './spec-builder';
export { specValidator, SPEC_VALIDATOR_ID } from './spec-validator';

import { specBuilder, SPEC_BUILDER_ID } from './spec-builder';
import { specValidator, SPEC_VALIDATOR_ID } from './spec-validator';

export const WORKFLOW_AGENT_IDS = [
  SPEC_BUILDER_ID,
  SPEC_VALIDATOR_ID,
] as const;

export const WORKFLOW_SEED_AGENTS = [
  specBuilder,
  specValidator,
];

// ---- Enrich Agents ----

export { specValidatorEnrich, SPEC_VALIDATOR_ENRICH_ID } from './spec-validator-enrich';
export { specEnricher, SPEC_ENRICHER_ID } from './spec-enricher';

import { specValidatorEnrich, SPEC_VALIDATOR_ENRICH_ID } from './spec-validator-enrich';
import { specEnricher, SPEC_ENRICHER_ID } from './spec-enricher';

export const ENRICH_AGENT_IDS = [
  SPEC_VALIDATOR_ENRICH_ID,
  SPEC_ENRICHER_ID,
] as const;

export const ENRICH_SEED_AGENTS = [
  specValidatorEnrich,
  specEnricher,
];

// ---- Pipeline Agents ----

export { discoveryAgent, DISCOVERY_AGENT_ID } from './discovery-agent';
export { prdGenerator, PRD_GENERATOR_ID } from './prd-generator';
export { prdValidator, PRD_VALIDATOR_ID } from './prd-validator';
export { sprintValidator, SPRINT_VALIDATOR_ID } from './sprint-validator';

import { discoveryAgent, DISCOVERY_AGENT_ID } from './discovery-agent';
import { prdGenerator, PRD_GENERATOR_ID } from './prd-generator';
import { prdValidator, PRD_VALIDATOR_ID } from './prd-validator';
import { sprintValidator, SPRINT_VALIDATOR_ID } from './sprint-validator';

export const PIPELINE_AGENT_IDS = [
  DISCOVERY_AGENT_ID,
  PRD_GENERATOR_ID,
  PRD_VALIDATOR_ID,
  SPRINT_VALIDATOR_ID,
] as const;

export const PIPELINE_SEED_AGENTS = [
  discoveryAgent,
  prdGenerator,
  prdValidator,
  sprintValidator,
];

// ---- Tech Agents ----

export { techDatabase, TECH_DATABASE_ID } from './tech-database';
export { techBackend, TECH_BACKEND_ID } from './tech-backend';
export { techFrontend, TECH_FRONTEND_ID } from './tech-frontend';
export { techSecurity, TECH_SECURITY_ID } from './tech-security';

import { techDatabase, TECH_DATABASE_ID } from './tech-database';
import { techBackend, TECH_BACKEND_ID } from './tech-backend';
import { techFrontend, TECH_FRONTEND_ID } from './tech-frontend';
import { techSecurity, TECH_SECURITY_ID } from './tech-security';

export const TECH_AGENT_IDS = [
  TECH_DATABASE_ID,
  TECH_BACKEND_ID,
  TECH_FRONTEND_ID,
  TECH_SECURITY_ID,
] as const;

export const TECH_SEED_AGENTS = [
  techDatabase,
  techBackend,
  techFrontend,
  techSecurity,
];

// ---- Skill Creator ----

export { skillCreator, SKILL_CREATOR_ID } from './skill-creator';

import { skillCreator, SKILL_CREATOR_ID } from './skill-creator';

export const SKILL_CREATOR_AGENTS = [skillCreator];

// ---- Dev Agents ----

export { frontendDeveloper, FRONTEND_DEVELOPER_ID } from './frontend-developer';
export { backendDeveloper, BACKEND_DEVELOPER_ID } from './backend-developer';
export { electronPro, ELECTRON_PRO_ID } from './electron-pro';
export { javascriptPro, JAVASCRIPT_PRO_ID } from './javascript-pro';
export { nextjsDeveloper, NEXTJS_DEVELOPER_ID } from './nextjs-developer';

import { frontendDeveloper, FRONTEND_DEVELOPER_ID } from './frontend-developer';
import { backendDeveloper, BACKEND_DEVELOPER_ID } from './backend-developer';
import { electronPro, ELECTRON_PRO_ID } from './electron-pro';
import { javascriptPro, JAVASCRIPT_PRO_ID } from './javascript-pro';
import { nextjsDeveloper, NEXTJS_DEVELOPER_ID } from './nextjs-developer';

export const DEV_AGENT_IDS = [
  FRONTEND_DEVELOPER_ID,
  BACKEND_DEVELOPER_ID,
  ELECTRON_PRO_ID,
  JAVASCRIPT_PRO_ID,
  NEXTJS_DEVELOPER_ID,
] as const;

export const DEV_SEED_AGENTS = [
  frontendDeveloper,
  backendDeveloper,
  electronPro,
  javascriptPro,
  nextjsDeveloper,
];
