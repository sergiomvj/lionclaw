import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';

const seedSrc = readFileSync(
  '/Users/macbook2015/Desktop/LionClaw/electron/main/seed-agents/harness-evaluator.ts',
  'utf-8',
);
const bashSrc = readFileSync(
  '/Users/macbook2015/Desktop/LionClaw/electron/main/seed-agents/_shared/bash-validation.ts',
  'utf-8',
);

// Extrai o BASH_VALIDATION_BLOCK content (entre backticks)
const bashMatch = bashSrc.match(/export const BASH_VALIDATION_BLOCK = `([\s\S]*?)`;/);
if (!bashMatch) throw new Error('BASH_VALIDATION_BLOCK not found');
const bashBlock = bashMatch[1];

// Extrai o systemPrompt template literal do evaluator
const promptMatch = seedSrc.match(/systemPrompt: `([\s\S]*?)`,\n\};/);
if (!promptMatch) throw new Error('systemPrompt not found');
let prompt = promptMatch[1];

// Substitui ${BASH_VALIDATION_BLOCK} pelo conteudo
prompt = prompt.replace('${BASH_VALIDATION_BLOCK}', bashBlock);

console.log('Novo prompt length:', prompt.length);
console.log('Preview (primeiros 300 chars):');
console.log(prompt.slice(0, 300));
console.log('---');

// Update no DB
const dbPath = path.join(homedir(), '.lionclaw', 'data', 'lionclaw.db');
const db = new Database(dbPath);
const result = db.prepare("UPDATE agents SET system_prompt = ? WHERE id = 'harness-evaluator'").run(prompt);
console.log('Rows updated:', result.changes);

const check = db.prepare("SELECT length(system_prompt) as len FROM agents WHERE id = 'harness-evaluator'").get();
console.log('New length in DB:', check.len);
db.close();
