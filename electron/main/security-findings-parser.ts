/**
 * security-findings-parser.ts
 *
 * Parses a consolidated Security-{id}.md file and counts findings by severity.
 * Used by the security pipeline to populate project.metadata.securitySummary.
 */

import fs from 'fs';
import { createLogger } from './logger';

const logger = createLogger('security-findings-parser');

/** Severity breakdown matching SecuritySummary.bySeverity (EN lowercase keys). */
export interface ParsedFindingsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Result returned by parseSecurityFindings(). */
export interface ParsedFindings {
  total: number;
  bySeverity: ParsedFindingsBySeverity;
}

/**
 * PT (all-caps) severity label -> EN lowercase key mapping.
 * Agents emit headers like `### CRITICO-001: Titulo`.
 */
const SEVERITY_MAP: Record<string, keyof ParsedFindingsBySeverity> = {
  CRITICO: 'critical',
  ALTO: 'high',
  MEDIO: 'medium',
  BAIXO: 'low',
};

/** Regex that matches finding section headers, e.g. `### CRITICO-001: Titulo`. */
const FINDING_HEADER_RE = /^### (CRITICO|ALTO|MEDIO|BAIXO)-\d{3}:/gm;

/**
 * Reads a consolidated Security-{id}.md file and counts findings per severity.
 *
 * Returns zeroed totals if the file does not exist, is empty, or cannot be read.
 */
export function parseSecurityFindings(markdownPath: string): ParsedFindings {
  const zeroed: ParsedFindings = {
    total: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  };

  if (!fs.existsSync(markdownPath)) {
    logger.debug({ markdownPath }, 'parseSecurityFindings: file not found, returning zeroed result');
    return zeroed;
  }

  let content: string;
  try {
    content = fs.readFileSync(markdownPath, 'utf-8');
  } catch (err) {
    logger.warn({ err, markdownPath }, 'parseSecurityFindings: failed to read file');
    return zeroed;
  }

  if (!content.trim()) {
    return zeroed;
  }

  const bySeverity: ParsedFindingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;

  let match: RegExpExecArray | null;
  FINDING_HEADER_RE.lastIndex = 0;
  while ((match = FINDING_HEADER_RE.exec(content)) !== null) {
    const ptKey = match[1] as keyof typeof SEVERITY_MAP;
    const enKey = SEVERITY_MAP[ptKey];
    if (enKey !== undefined) {
      bySeverity[enKey]++;
      total++;
    }
  }

  return { total, bySeverity };
}
