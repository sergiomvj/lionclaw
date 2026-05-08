/**
 * permission-guard-git.test.ts
 *
 * Unit tests for Sprint 2 guardrails: git state-changing commands denied directly
 * by FORBIDDEN_GIT_PATTERNS before reaching the modal confirmation flow.
 *
 * Coverage:
 * - Each FORBIDDEN_GIT_PATTERNS entry returns behavior: 'deny' with the standard message.
 * - Read-only git commands (status, diff, log, show, branch --list, ls-files) are allowed.
 * - Non-git commands (npm install, etc.) are not blocked by the git guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock logger ----
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---- Mock db ----
vi.mock('../db', () => ({
  insertAuditEntry: vi.fn(),
}));

// ---- Mock ask-question ----
vi.mock('../ask-question', () => ({
  sendAskQuestion: vi.fn(),
}));

// ---- Mock repo-profiler ----
vi.mock('../repo-profiler', () => ({
  EXCLUDED_FROM_AUDIT_PATTERNS: [],
}));

// ---- Mock electron ----
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import { createPermissionGuard } from '../permission-guard';

const DENY_MESSAGE = 'Comandos git que modificam state (commit, push, reset, rebase, merge, etc) sao proibidos. O usuario faz controle de versao manualmente. Use Write/Edit para arquivos, e git status/diff/log para inspecao.';

function makeGuard() {
  return createPermissionGuard(() => null);
}

describe('permission-guard: FORBIDDEN_GIT_PATTERNS', () => {
  let guard: ReturnType<typeof makeGuard>;

  beforeEach(() => {
    guard = makeGuard();
  });

  const forbiddenCommands = [
    { label: 'git commit', cmd: 'git commit -m "feat: add feature"' },
    { label: 'git commit --amend', cmd: 'git commit --amend --no-edit' },
    { label: 'git push', cmd: 'git push origin main' },
    { label: 'git push --force', cmd: 'git push --force origin main' },
    { label: 'git reset', cmd: 'git reset HEAD~1' },
    { label: 'git reset --hard', cmd: 'git reset --hard HEAD' },
    { label: 'git reset --soft', cmd: 'git reset --soft HEAD~1' },
    { label: 'git reset --mixed', cmd: 'git reset --mixed HEAD' },
    { label: 'git rebase', cmd: 'git rebase main' },
    { label: 'git rebase -i', cmd: 'git rebase -i HEAD~3' },
    { label: 'git merge', cmd: 'git merge feature-branch' },
    { label: 'git merge --no-ff', cmd: 'git merge --no-ff feature-branch' },
    { label: 'git rm', cmd: 'git rm src/old-file.ts' },
    { label: 'git rm -r', cmd: 'git rm -r old-directory/' },
    { label: 'git stash drop', cmd: 'git stash drop stash@{0}' },
    { label: 'git tag', cmd: 'git tag v1.0.0' },
    { label: 'git tag annotated', cmd: 'git tag -a v1.0.0 -m "Release"' },
    { label: 'git remote add', cmd: 'git remote add upstream https://github.com/foo/bar.git' },
    { label: 'git remote set-url', cmd: 'git remote set-url origin https://github.com/foo/bar.git' },
    { label: 'git remote remove', cmd: 'git remote remove upstream' },
    { label: 'git remote rename', cmd: 'git remote rename origin upstream' },
    { label: 'git push -f', cmd: 'git push -f origin main' },
    { label: 'git fetch --force', cmd: 'git fetch --force origin' },
  ];

  for (const { label, cmd } of forbiddenCommands) {
    it(`denies "${label}" directly without modal`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toBe(DENY_MESSAGE);
    });
  }

  const allowedGitCommands = [
    { label: 'git status', cmd: 'git status' },
    { label: 'git diff', cmd: 'git diff HEAD' },
    { label: 'git diff --cached', cmd: 'git diff --cached' },
    { label: 'git log', cmd: 'git log --oneline -10' },
    { label: 'git show', cmd: 'git show HEAD:src/file.ts' },
    { label: 'git branch --list', cmd: 'git branch --list' },
    { label: 'git ls-files', cmd: 'git ls-files src/' },
    { label: 'git ls-files --others', cmd: 'git ls-files --others --exclude-standard' },
    // Switching branches is non-destructive and must not be blocked
    { label: 'git checkout main (branch switch)', cmd: 'git checkout main' },
    { label: 'git checkout -b new-branch', cmd: 'git checkout -b new-branch' },
    // Stash save is non-destructive
    { label: 'git stash (save)', cmd: 'git stash' },
    // Staging files is non-destructive
    { label: 'git add .', cmd: 'git add .' },
    { label: 'git add src/', cmd: 'git add src/' },
  ];

  for (const { label, cmd } of allowedGitCommands) {
    it(`allows read-only "${label}"`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('allow');
    });
  }

  // ---- New patterns added in Sprint 2 gap fix ----

  const newForbiddenCommands = [
    {
      label: 'git checkout -- file.txt (discard local changes)',
      cmd: 'git checkout -- file.txt',
    },
    {
      label: 'git checkout -- src/ (discard directory changes)',
      cmd: 'git checkout -- src/',
    },
    {
      label: 'git clean -fd (delete untracked files)',
      cmd: 'git clean -fd',
    },
    {
      label: 'git clean -f (delete untracked files, short form)',
      cmd: 'git clean -f',
    },
    {
      label: 'git clean -fxd (also removes ignored files)',
      cmd: 'git clean -fxd',
    },
  ];

  for (const { label, cmd } of newForbiddenCommands) {
    it(`denies "${label}" directly without modal`, async () => {
      const result = await guard('Bash', { command: cmd });
      expect(result.behavior).toBe('deny');
      expect((result as { behavior: 'deny'; message: string }).message).toBe(DENY_MESSAGE);
    });
  }

  const nonGitCommands = [
    { label: 'npm install', cmd: 'npm install' },
    { label: 'npx tsc', cmd: 'npx tsc --noEmit' },
    { label: 'npm run build', cmd: 'npm run build' },
    { label: 'ls', cmd: 'ls -la' },
    { label: 'cat file', cmd: 'cat src/index.ts' },
  ];

  for (const { label, cmd } of nonGitCommands) {
    it(`does not block non-git command "${label}"`, async () => {
      const result = await guard('Bash', { command: cmd });
      // Should be allow (not denied by git guard); may be allow or confirm for other reasons
      // but must not carry the git-specific deny message
      if (result.behavior === 'deny') {
        expect((result as { behavior: 'deny'; message: string }).message).not.toBe(DENY_MESSAGE);
      } else {
        expect(result.behavior).toBe('allow');
      }
    });
  }
});
