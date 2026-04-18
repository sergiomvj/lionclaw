import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getDb, getSetting } from './db';
import { ollamaChat } from './ollama-client';
import type { VaultOperation, GraphData, GraphNode, GraphEdge, MgraphSearchResult, MgraphStats, NoteListItem, BacklinkResult } from '../../src/types';

const logger = createLogger('mgraph');

const VAULT_SUBDIRS = ['entities', 'meetings', 'decisions', 'projects', 'references'] as const;
type VaultSubdir = typeof VAULT_SUBDIRS[number];

const MGRAPH_DIR = 'mgraph';

export function getVaultRoot(): string {
  return path.join(getLionClawHome(), MGRAPH_DIR);
}

// ---- Sanitization & Validation ----

/**
 * Sanitize a string into a strict slug for filenames.
 * Removes accents, special chars, limits to 50 chars.
 */
export function sanitizeFilename(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .trim()
    .replace(/[\s]+/g, '-')          // spaces to hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')         // trim leading/trailing hyphens
    .substring(0, 50);
}

/**
 * Validate a vault path. Rejects traversal, invalid chars, and paths outside whitelist.
 */
export function validateVaultPath(vaultPath: string): { valid: boolean; error?: string } {
  if (vaultPath.includes('..')) {
    return { valid: false, error: 'Path traversal (..) not allowed' };
  }
  if (vaultPath.includes('//')) {
    return { valid: false, error: 'Double slashes not allowed' };
  }
  // Allow only a-z 0-9 - . /
  if (!/^[a-z0-9\-./]+$/.test(vaultPath)) {
    return { valid: false, error: 'Invalid characters in path. Only a-z, 0-9, -, ., / allowed' };
  }
  const validPrefixes = VAULT_SUBDIRS.map((d) => `${d}/`);
  const hasValidPrefix = validPrefixes.some((p) => vaultPath.startsWith(p));
  if (!hasValidPrefix) {
    return { valid: false, error: `Path must start with one of: ${validPrefixes.join(', ')}` };
  }
  return { valid: true };
}

// ---- Frontmatter helpers ----

interface NoteFrontmatter {
  title: string;
  type: string;
  tags: string[];
  source: string;
  session_id: string;
  created: string;
  updated: string;
}

function buildFrontmatter(fm: NoteFrontmatter): string {
  const lines = [
    '---',
    `title: "${fm.title.replace(/"/g, '\\"')}"`,
    `type: ${fm.type}`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(', ')}]`,
    `source: ${fm.source}`,
    `session_id: ${fm.session_id}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    '---',
  ];
  return lines.join('\n');
}

function parseFrontmatter(content: string): { frontmatter: Partial<NoteFrontmatter>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = match[1];
  const body = match[2];
  const fm: Partial<NoteFrontmatter> = {};

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();

    // Remove surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'title': fm.title = value; break;
      case 'type': fm.type = value; break;
      case 'source': fm.source = value; break;
      case 'session_id': fm.session_id = value; break;
      case 'created': fm.created = value; break;
      case 'updated': fm.updated = value; break;
      case 'tags': {
        // Parse [\"tag1\", \"tag2\"]
        const tagMatch = value.match(/\[(.*)]/);
        if (tagMatch) {
          fm.tags = tagMatch[1]
            .split(',')
            .map((t) => t.trim().replace(/^"|"$/g, ''))
            .filter(Boolean);
        }
        break;
      }
    }
  }

  return { frontmatter: fm, body };
}

// ---- Core Functions ----

/**
 * Create the vault directory structure at ~/.lionclaw/mgraph/
 */
export function createVaultStructure(): void {
  const root = getVaultRoot();
  fs.mkdirSync(root, { recursive: true });

  for (const subdir of VAULT_SUBDIRS) {
    fs.mkdirSync(path.join(root, subdir), { recursive: true });
  }

  logger.info({ root }, 'Vault structure created');
}

/**
 * Execute a vault operation (create or update a note).
 */
export function executeVaultOperation(op: VaultOperation): { success: boolean; error?: string } {
  const validation = validateVaultPath(op.path);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fullPath = path.join(getVaultRoot(), op.path);
  const now = new Date().toISOString();

  try {
    if (op.action === 'create') {
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      const fm = buildFrontmatter({
        title: op.title,
        type: op.type,
        tags: op.tags || [],
        source: 'compaction',
        session_id: '',
        created: now,
        updated: now,
      });

      const fileContent = `${fm}\n\n${op.content}\n`;
      fs.writeFileSync(fullPath, fileContent, 'utf-8');
      logger.info({ path: op.path }, 'Note created');

    } else if (op.action === 'update') {
      if (!fs.existsSync(fullPath)) {
        return { success: false, error: `File not found: ${op.path}` };
      }

      const existing = fs.readFileSync(fullPath, 'utf-8');
      const { frontmatter: fm, body } = parseFrontmatter(existing);

      // Update the 'updated' timestamp in frontmatter
      fm.updated = now;
      if (op.tags && op.tags.length > 0) {
        const existingTags = new Set(fm.tags || []);
        for (const tag of op.tags) existingTags.add(tag);
        fm.tags = Array.from(existingTags);
      }

      const updatedFm = buildFrontmatter({
        title: fm.title || op.title,
        type: fm.type || op.type,
        tags: fm.tags || op.tags,
        source: fm.source || 'compaction',
        session_id: fm.session_id || '',
        created: fm.created || now,
        updated: now,
      });

      let newBody: string;
      if (op.append) {
        const dateHeading = `## ${now.split('T')[0]}`;
        newBody = `${body.trimEnd()}\n\n${dateHeading}\n\n${op.content}\n`;
      } else {
        newBody = op.content;
      }

      fs.writeFileSync(fullPath, `${updatedFm}\n\n${newBody}\n`, 'utf-8');
      logger.info({ path: op.path, append: op.append }, 'Note updated');
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, path: op.path }, 'Vault operation failed');
    return { success: false, error: msg };
  }
}

/**
 * Regenerate index.md with notes grouped by type.
 */
export function regenerateVaultIndex(): void {
  const root = getVaultRoot();
  const lines: string[] = ['# Memory Graph Index', ''];

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    if (files.length === 0) continue;

    lines.push(`## ${subdir.charAt(0).toUpperCase() + subdir.slice(1)}`);
    lines.push('');

    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      const name = file.replace('.md', '');
      const title = frontmatter.title || name;
      lines.push(`- [[${name}]] - ${title}`);
    }

    lines.push('');
  }

  fs.writeFileSync(path.join(root, 'index.md'), lines.join('\n'), 'utf-8');
  logger.info('Vault index regenerated');
}

/**
 * Update hot.md with the last 10 notes by 'updated' date, max 500 words.
 */
export function updateVaultHot(): void {
  const root = getVaultRoot();

  interface NoteInfo {
    path: string;
    title: string;
    updated: string;
    firstParagraph: string;
  }

  const allNotes: NoteInfo[] = [];

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      // First paragraph = first non-empty line(s) before a blank line
      const paragraphs = body.trim().split(/\n\s*\n/);
      const firstPara = paragraphs[0]?.trim() || '';

      allNotes.push({
        path: `${subdir}/${file}`,
        title: frontmatter.title || file.replace('.md', ''),
        updated: frontmatter.updated || '1970-01-01',
        firstParagraph: firstPara,
      });
    }
  }

  // Sort by updated descending, take 10
  allNotes.sort((a, b) => b.updated.localeCompare(a.updated));
  const top10 = allNotes.slice(0, 10);

  const lines: string[] = ['# Hot Notes', '', 'Ultimas notas atualizadas:', ''];
  let wordCount = 0;
  const maxWords = 500;

  for (const note of top10) {
    if (wordCount >= maxWords) break;

    const summary = note.firstParagraph.split(/\s+/).slice(0, 30).join(' ');
    const entry = `- **${note.title}** (${note.updated.split('T')[0]}): ${summary}`;
    wordCount += entry.split(/\s+/).length;
    lines.push(entry);
  }

  lines.push('');
  fs.writeFileSync(path.join(root, 'hot.md'), lines.join('\n'), 'utf-8');
  logger.info({ count: top10.length }, 'Vault hot.md updated');
}

// ---- Graph Data ----

/**
 * Parse all vault .md files and build a graph with nodes and edges.
 * Edges are derived from [[wiki-links]] found in note content.
 */
export function buildGraphData(): GraphData {
  const root = getVaultRoot();
  const nodes: GraphNode[] = [];
  const rawEdges: Array<{ source: string; target: string }> = [];
  const nodeIds = new Set<string>();

  // Map plural subdir names to singular type names used by NODE_COLORS/filters
  const subdirToType: Record<string, string> = {
    entities: 'entity',
    meetings: 'meeting',
    decisions: 'decision',
    projects: 'project',
    references: 'reference',
  };

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const id = file.replace('.md', '');
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      nodeIds.add(id);
      nodes.push({
        id,
        title: frontmatter.title || id,
        type: frontmatter.type || subdirToType[subdir] || subdir,
        tags: frontmatter.tags || [],
        connections: 0,
      });

      // Extract [[wiki-links]]
      const linkRegex = /\[\[([^\]]+)]]/g;
      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(body)) !== null) {
        let target = match[1];
        // Normalize: strip path prefix (e.g., "entities/john-smith" -> "john-smith")
        if (target.includes('/')) {
          target = target.substring(target.lastIndexOf('/') + 1);
        }
        // Strip .md extension if present
        if (target.endsWith('.md')) {
          target = target.slice(0, -3);
        }
        rawEdges.push({ source: id, target });
      }
    }
  }

  // Filter edges: only keep those where BOTH source and target exist as nodes.
  // D3 forceLink crashes if an edge references a non-existent node ID.
  const edges: GraphEdge[] = rawEdges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target,
  );

  // Count connections per node
  const connMap = new Map<string, number>();
  for (const edge of edges) {
    connMap.set(edge.source, (connMap.get(edge.source) || 0) + 1);
    connMap.set(edge.target, (connMap.get(edge.target) || 0) + 1);
  }
  for (const node of nodes) {
    node.connections = connMap.get(node.id) || 0;
  }

  logger.info({ nodes: nodes.length, edges: edges.length, droppedEdges: rawEdges.length - edges.length }, 'Graph data built');
  return { nodes, edges };
}

// ---- Search ----

/**
 * Search vault notes by query matching title, tags, or content.
 * Returns max 20 results with snippet.
 */
export function searchVault(query: string): MgraphSearchResult[] {
  const root = getVaultRoot();
  const results: MgraphSearchResult[] = [];
  const queryLower = query.toLowerCase();

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      const title = frontmatter.title || file.replace('.md', '');
      const tags = (frontmatter.tags || []).join(' ');
      const searchable = `${title} ${tags} ${body}`.toLowerCase();

      if (searchable.includes(queryLower)) {
        // Find snippet around the match
        const idx = searchable.indexOf(queryLower);
        const start = Math.max(0, idx - 20);
        const snippet = body.substring(start, start + 100).trim();

        results.push({
          path: `${subdir}/${file}`,
          title,
          type: frontmatter.type || subdir,
          snippet: snippet || body.substring(0, 100).trim(),
        });

        if (results.length >= 20) return results;
      }
    }
  }

  return results;
}

// ---- Stats ----

/**
 * Gather stats about the vault.
 */
export function getVaultStats(): MgraphStats {
  const root = getVaultRoot();
  let totalNotes = 0;
  let totalConnections = 0;
  let lastUpdated = '';
  const notesByType: Record<string, number> = {};

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    notesByType[subdir] = files.length;
    totalNotes += files.length;

    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      if (frontmatter.updated && frontmatter.updated > lastUpdated) {
        lastUpdated = frontmatter.updated;
      }

      // Count [[links]]
      const links = body.match(/\[\[[^\]]+]]/g);
      if (links) totalConnections += links.length;
    }
  }

  return {
    totalNotes,
    totalConnections,
    lastUpdated: lastUpdated || new Date().toISOString(),
    notesByType,
  };
}

/**
 * Read a single note from the vault.
 */
export function readVaultNote(notePath: string): string {
  const validation = validateVaultPath(notePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const fullPath = path.join(getVaultRoot(), notePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Note not found: ${notePath}`);
  }

  return fs.readFileSync(fullPath, 'utf-8');
}

// ---- Vault Log ----

const LOG_MAX_LINES = 500;

/**
 * Append an entry to ~/.lionclaw/mgraph/log.md with rotation at 500 lines.
 */
export function appendVaultLog(entry: string): void {
  const logPath = path.join(getVaultRoot(), 'log.md');

  let lines: string[] = [];
  try {
    if (fs.existsSync(logPath)) {
      lines = fs.readFileSync(logPath, 'utf-8').split('\n');
    }
  } catch {
    // file doesn't exist yet, start fresh
  }

  lines.push(entry);

  // Rotate: remove oldest lines if over limit
  if (lines.length > LOG_MAX_LINES) {
    lines = lines.slice(lines.length - LOG_MAX_LINES);
  }

  fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
}

// ---- Note helpers ----

/**
 * List notes of a given type (subdir), returning lightweight items.
 */
export function listNotesByType(type: string): NoteListItem[] {
  const root = getVaultRoot();
  const dirPath = path.join(root, type);
  if (!fs.existsSync(dirPath)) return [];

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
  const items: NoteListItem[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    items.push({
      path: `${type}/${file}`,
      title: frontmatter.title || file.replace('.md', ''),
      type: frontmatter.type || type,
      tags: frontmatter.tags || [],
      snippet: body.trim().substring(0, 100),
      updatedAt: frontmatter.updated || '',
    });
  }

  // Sort by updatedAt descending
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items;
}

/**
 * Find all notes that contain a [[wiki-link]] referencing the given note path.
 */
export function findBacklinks(notePath: string): BacklinkResult[] {
  const root = getVaultRoot();
  // Extract the slug from the path (e.g. "entities/john.md" -> "john")
  const slug = path.basename(notePath, '.md');
  const results: BacklinkResult[] = [];

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = `${subdir}/${file}`;
      // Skip the note itself
      if (filePath === notePath) continue;

      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Search for [[slug]] in the body
      const lines = body.split('\n');
      for (const line of lines) {
        if (line.includes(`[[${slug}]]`)) {
          results.push({
            path: filePath,
            title: frontmatter.title || file.replace('.md', ''),
            linkContext: line.trim(),
          });
          break; // One result per file
        }
      }
    }
  }

  return results;
}

/**
 * Save a snapshot of a note before updating it.
 */
export function snapshotBeforeUpdate(notePath: string): void {
  const root = getVaultRoot();
  const fullPath = path.join(root, notePath);
  if (!fs.existsSync(fullPath)) return;

  const slug = path.basename(notePath, '.md');
  const historyDir = path.join(root, '.history', slug);
  fs.mkdirSync(historyDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(historyDir, `${timestamp}.md`);
  fs.copyFileSync(fullPath, snapshotPath);

  logger.info({ notePath, snapshotPath }, 'Snapshot saved');
}

/**
 * Delete a vault note. Checks for backlinks first.
 * If backlinks exist and force !== true, returns them instead of deleting.
 */
export function deleteVaultNote(
  notePath: string,
  options?: { force?: boolean },
): { success: boolean; backlinks?: BacklinkResult[]; error?: string } {
  const validation = validateVaultPath(notePath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fullPath = path.join(getVaultRoot(), notePath);
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `Note not found: ${notePath}` };
  }

  const backlinks = findBacklinks(notePath);
  if (backlinks.length > 0 && !options?.force) {
    return { success: false, backlinks };
  }

  // Save snapshot before deleting
  snapshotBeforeUpdate(notePath);

  try {
    fs.unlinkSync(fullPath);
    regenerateVaultIndex();
    logger.info({ notePath, backlinkCount: backlinks.length }, 'Note deleted');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Remove snapshots older than 30 days and clean up empty directories.
 */
export function cleanOldSnapshots(): { removed: number } {
  const historyDir = path.join(getVaultRoot(), '.history');
  if (!fs.existsSync(historyDir)) return { removed: 0 };

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;

  const slugDirs = fs.readdirSync(historyDir);
  for (const slugDir of slugDirs) {
    const slugPath = path.join(historyDir, slugDir);
    const stat = fs.statSync(slugPath);
    if (!stat.isDirectory()) continue;

    const files = fs.readdirSync(slugPath);
    for (const file of files) {
      const filePath = path.join(slugPath, file);
      const fileStat = fs.statSync(filePath);
      if (fileStat.mtimeMs < thirtyDaysAgo) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    // Remove empty directory
    const remaining = fs.readdirSync(slugPath);
    if (remaining.length === 0) {
      fs.rmdirSync(slugPath);
    }
  }

  logger.info({ removed }, 'Old snapshots cleaned');
  return { removed };
}

// ---- Seed Vault ----

const SEED_BATCH_SIZE = 10;

const SEED_PROMPT_CONVERSATIONS = `You are a knowledge extraction system. Analyze the following conversation history and produce vault operations to populate a persistent knowledge graph.

CONVERSATIONS:
{{CONVERSATIONS}}

EXISTING NOTES (avoid duplicating these):
{{EXISTING_NOTES}}

RULES:
- Only create notes for SIGNIFICANT information:
  - Entities (people, tools, services, libraries) mentioned 2+ times across conversations
  - Explicit decisions (e.g. "we decided to use X", "let's go with Y")
  - Projects or initiatives discussed in detail
  - Important meetings or events with concrete outcomes
  - Reference material the user asked to remember
- IGNORE trivial conversations: greetings, simple Q&A about syntax, one-off questions
- Each note must be self-contained with enough context to be useful standalone
- Use [[wiki-links]] to connect related notes (e.g. "Related to [[project-name]]")
- Path format: {type}/{slug}.md where type is one of: entities, meetings, decisions, projects, references
- Slug must be lowercase, a-z 0-9 hyphens only, max 50 chars

POSITIVE EXAMPLES:
- User discusses React migration across 3 sessions -> create projects/react-migration.md
- User mentions "John from the backend team" in 4 conversations -> create entities/john-backend.md
- User says "we decided to use PostgreSQL instead of MongoDB" -> create decisions/postgresql-over-mongodb.md

NEGATIVE EXAMPLES:
- User asks "how to center a div in CSS" -> DO NOT create a note (trivial Q&A)
- User says "hello, how are you?" -> DO NOT create a note (greeting)
- User asks for a one-off code review -> DO NOT create a note (ephemeral)

Respond with a JSON array of vault operations. Each operation:
{
  "action": "create" or "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Human readable title",
  "tags": ["tag1", "tag2"],
  "content": "Markdown content with [[wiki-links]]"
}

If no significant information found, return an empty array: []

CRITICAL: Output ONLY valid JSON array, no markdown fences, no explanation.`;

const SEED_PROMPT_SUMMARIES = `You are a knowledge extraction system. Analyze the following daily summaries and produce vault operations to populate a persistent knowledge graph.

DAILY SUMMARIES:
{{SUMMARIES}}

EXISTING NOTES (avoid duplicating these):
{{EXISTING_NOTES}}

RULES:
- Only create notes for SIGNIFICANT information:
  - Entities (people, tools, services, libraries) mentioned 2+ times
  - Explicit decisions recorded in summaries
  - Projects or initiatives with clear context
  - Important facts extracted that are worth persisting
- IGNORE trivial or ephemeral information
- Each note must be self-contained
- Use [[wiki-links]] to connect related notes
- Path format: {type}/{slug}.md where type is one of: entities, meetings, decisions, projects, references
- Slug must be lowercase, a-z 0-9 hyphens only, max 50 chars

Respond with a JSON array of vault operations. Each operation:
{
  "action": "create" or "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Human readable title",
  "tags": ["tag1", "tag2"],
  "content": "Markdown content with [[wiki-links]]"
}

If no significant information found, return an empty array: []

CRITICAL: Output ONLY valid JSON array, no markdown fences, no explanation.`;

interface SeedProgress {
  processed: number;
  total: number;
  notesCreated: number;
}

interface SessionBatch {
  sessions: Array<{
    id: string;
    title: string;
    messages: Array<{ role: string; content: string }>;
  }>;
}

interface SummaryBatch {
  summaries: Array<{
    date: string;
    summary: string;
    decisions: string;
    facts_extracted: string;
  }>;
}

/**
 * Get existing vault files with their titles for the EXISTING_VAULT_FILES section.
 * Format: "path - title\n" for each note.
 */
export function getExistingVaultFilesList(): string {
  const root = getVaultRoot();
  const entries: string[] = [];
  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      const title = frontmatter.title || file.replace('.md', '');
      entries.push(`${subdir}/${file} - ${title}`);
    }
  }
  return entries.join('\n');
}

function getExistingNotePaths(): string[] {
  const root = getVaultRoot();
  const paths: string[] = [];
  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(root, subdir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      paths.push(`${subdir}/${file}`);
    }
  }
  return paths;
}

function buildConversationText(batch: SessionBatch): string {
  const parts: string[] = [];
  for (const session of batch.sessions) {
    parts.push(`### Session: ${session.title || session.id}`);
    for (const msg of session.messages) {
      parts.push(`[${msg.role}] ${msg.content.substring(0, 2000)}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function buildSummaryText(batch: SummaryBatch): string {
  const parts: string[] = [];
  for (const s of batch.summaries) {
    parts.push(`### ${s.date}`);
    parts.push(`Summary: ${s.summary}`);
    if (s.decisions) parts.push(`Decisions: ${s.decisions}`);
    if (s.facts_extracted) parts.push(`Facts: ${s.facts_extracted}`);
    parts.push('');
  }
  return parts.join('\n');
}

async function callAIForSeed(prompt: string): Promise<VaultOperation[]> {
  const ollamaEnabled = getSetting('ollama_enabled') === 'true';
  const ollamaBaseUrl = getSetting('ollama_base_url') || 'http://localhost:11434';
  const compactionModel = getSetting('ollama_compaction_model') || '';

  let responseText: string;

  if (ollamaEnabled && compactionModel) {
    try {
      responseText = await ollamaChat(ollamaBaseUrl, compactionModel, prompt);
    } catch (err) {
      logger.warn({ err }, 'Ollama seed failed, falling back to Claude');
      responseText = await callClaudeForSeed(prompt);
    }
  } else {
    responseText = await callClaudeForSeed(prompt);
  }

  // Clean response
  let text = responseText.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Response is not a JSON array');
  }

  return parsed as VaultOperation[];
}

async function callClaudeForSeed(prompt: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { getApiKey } = await import('./secrets-vault');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 20000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('');
}

/**
 * Seed the vault from conversation history.
 * Processes sessions in batches, sends to AI for knowledge extraction,
 * and executes the returned vault operations.
 */
export async function seedVault(
  mainWindow: BrowserWindow | null,
  forceReseed: boolean = false,
): Promise<{ notes: number; connections: number }> {
  const now = () => new Date().toISOString();

  // If force re-seed, wipe the vault first
  if (forceReseed) {
    const root = getVaultRoot();
    for (const subdir of VAULT_SUBDIRS) {
      const dirPath = path.join(root, subdir);
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          fs.unlinkSync(path.join(dirPath, file));
        }
      }
    }
    // Also clean index.md, hot.md, log.md
    for (const f of ['index.md', 'hot.md', 'log.md']) {
      const fp = path.join(root, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    logger.info('Vault wiped for re-seed');
  }

  createVaultStructure();

  const db = getDb();

  // Try sessions + messages first
  const sessionsRows = db.prepare(`
    SELECT s.id, s.title, s.created_at
    FROM sessions s
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
    ORDER BY s.created_at ASC
  `).all() as Array<{ id: string; title: string; created_at: string }>;

  let useSummaries = false;

  if (sessionsRows.length === 0) {
    // Fallback to daily_summaries
    const summaryCount = (db.prepare('SELECT COUNT(*) as cnt FROM daily_summaries').get() as { cnt: number }).cnt;
    if (summaryCount === 0) {
      logger.info('No sessions or summaries to seed from');
      return { notes: 0, connections: 0 };
    }
    useSummaries = true;
  }

  let totalBatches: number;
  let totalNotesCreated = 0;
  let totalConnectionsCreated = 0;

  if (useSummaries) {
    // --- Summaries path ---
    const summaries = db.prepare(`
      SELECT date, summary, decisions, facts_extracted
      FROM daily_summaries
      ORDER BY date ASC
    `).all() as Array<{ date: string; summary: string; decisions: string; facts_extracted: string }>;

    totalBatches = Math.ceil(summaries.length / SEED_BATCH_SIZE);
    appendVaultLog(`[${now()}] SEED_START batches:${totalBatches}`);

    const emitProgress = (p: SeedProgress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mgraph:seed-progress', {
          processed: p.processed,
          total: p.total,
          notesCreated: p.notesCreated,
        });
      }
    };

    emitProgress({ processed: 0, total: totalBatches, notesCreated: 0 });

    for (let i = 0; i < totalBatches; i++) {
      const batchSummaries = summaries.slice(i * SEED_BATCH_SIZE, (i + 1) * SEED_BATCH_SIZE);
      const batch: SummaryBatch = { summaries: batchSummaries };

      try {
        const existingNotes = getExistingNotePaths();
        const prompt = SEED_PROMPT_SUMMARIES
          .replace('{{SUMMARIES}}', buildSummaryText(batch).substring(0, 50000))
          .replace('{{EXISTING_NOTES}}', existingNotes.length > 0 ? existingNotes.join('\n') : '(none)');

        const operations = await callAIForSeed(prompt);
        let batchNotes = 0;

        for (const op of operations) {
          // Idempotent: if path exists, switch to update
          const fullPath = path.join(getVaultRoot(), op.path);
          if (op.action === 'create' && fs.existsSync(fullPath)) {
            op.action = 'update';
            op.append = true;
          }

          const result = executeVaultOperation(op);
          if (result.success) {
            batchNotes++;
            appendVaultLog(`[${now()}] ${op.action.toUpperCase()} ${op.path} "${op.title}" (source:seed)`);
          }
        }

        totalNotesCreated += batchNotes;
        appendVaultLog(`[${now()}] SEED_BATCH ${i + 1}/${totalBatches} notes:${batchNotes} (ok)`);
        logger.info({ batch: i + 1, totalBatches, batchNotes }, 'Seed batch completed');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        appendVaultLog(`[${now()}] SEED_BATCH ${i + 1}/${totalBatches} (error: ${errMsg})`);
        logger.error({ batch: i + 1, error: errMsg }, 'Seed batch failed, continuing');
      }

      emitProgress({ processed: i + 1, total: totalBatches, notesCreated: totalNotesCreated });
    }
  } else {
    // --- Sessions + messages path ---
    totalBatches = Math.ceil(sessionsRows.length / SEED_BATCH_SIZE);
    appendVaultLog(`[${now()}] SEED_START batches:${totalBatches}`);

    const emitProgress = (p: SeedProgress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mgraph:seed-progress', {
          processed: p.processed,
          total: p.total,
          notesCreated: p.notesCreated,
        });
      }
    };

    emitProgress({ processed: 0, total: totalBatches, notesCreated: 0 });

    for (let i = 0; i < totalBatches; i++) {
      const batchSessions = sessionsRows.slice(i * SEED_BATCH_SIZE, (i + 1) * SEED_BATCH_SIZE);

      try {
        const sessionData: SessionBatch = { sessions: [] };

        for (const s of batchSessions) {
          const messages = db.prepare(`
            SELECT role, content FROM messages
            WHERE session_id = ?
            ORDER BY created_at ASC
          `).all(s.id) as Array<{ role: string; content: string }>;

          sessionData.sessions.push({
            id: s.id,
            title: s.title || s.id,
            messages,
          });
        }

        const existingNotes = getExistingNotePaths();
        const conversationText = buildConversationText(sessionData);
        const prompt = SEED_PROMPT_CONVERSATIONS
          .replace('{{CONVERSATIONS}}', conversationText.substring(0, 50000))
          .replace('{{EXISTING_NOTES}}', existingNotes.length > 0 ? existingNotes.join('\n') : '(none)');

        const operations = await callAIForSeed(prompt);
        let batchNotes = 0;

        for (const op of operations) {
          // Idempotent: if path exists, switch to update
          const fullPath = path.join(getVaultRoot(), op.path);
          if (op.action === 'create' && fs.existsSync(fullPath)) {
            op.action = 'update';
            op.append = true;
          }

          const result = executeVaultOperation(op);
          if (result.success) {
            batchNotes++;
            appendVaultLog(`[${now()}] ${op.action.toUpperCase()} ${op.path} "${op.title}" (source:seed, session:${batchSessions[0]?.id || 'unknown'})`);
          }
        }

        totalNotesCreated += batchNotes;
        appendVaultLog(`[${now()}] SEED_BATCH ${i + 1}/${totalBatches} notes:${batchNotes} (ok)`);
        logger.info({ batch: i + 1, totalBatches, batchNotes }, 'Seed batch completed');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        appendVaultLog(`[${now()}] SEED_BATCH ${i + 1}/${totalBatches} (error: ${errMsg})`);
        logger.error({ batch: i + 1, error: errMsg }, 'Seed batch failed, continuing');
      }

      emitProgress({ processed: i + 1, total: totalBatches, notesCreated: totalNotesCreated });
    }
  }

  // Finalize: rebuild index and hot
  regenerateVaultIndex();
  updateVaultHot();

  // Count connections from graph
  const graph = buildGraphData();
  totalConnectionsCreated = graph.edges.length;

  appendVaultLog(`[${now()}] SEED_COMPLETE notes:${totalNotesCreated} connections:${totalConnectionsCreated}`);

  // Add REINDEX log entry
  appendVaultLog(`[${now()}] REINDEX notes:${graph.nodes.length} connections:${totalConnectionsCreated}`);

  logger.info({ notes: totalNotesCreated, connections: totalConnectionsCreated }, 'Vault seed complete');

  return { notes: totalNotesCreated, connections: totalConnectionsCreated };
}
