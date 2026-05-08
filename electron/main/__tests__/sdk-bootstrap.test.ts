import { describe, it, expect } from 'vitest';
import {
  getClaudeCodeExecutablePath,
  ensureNodeInPath,
  ensureAuthForSDK,
} from '../pipeline-shared/sdk-bootstrap';

describe('pipeline-shared/sdk-bootstrap', () => {
  it('exports getClaudeCodeExecutablePath as a function returning a non-empty string', () => {
    expect(typeof getClaudeCodeExecutablePath).toBe('function');
    const cliPath = getClaudeCodeExecutablePath();
    expect(typeof cliPath).toBe('string');
    expect(cliPath.length).toBeGreaterThan(0);
    expect(cliPath.endsWith('cli.js')).toBe(true);
  });

  it('exports ensureNodeInPath as a sync function (idempotent guard)', () => {
    expect(typeof ensureNodeInPath).toBe('function');
    // Idempotent: should not throw on repeated calls.
    expect(() => ensureNodeInPath()).not.toThrow();
    expect(() => ensureNodeInPath()).not.toThrow();
  });

  it('exports ensureAuthForSDK as an async function', async () => {
    expect(typeof ensureAuthForSDK).toBe('function');
    // Should resolve to undefined; never throws on missing creds (it warns).
    await expect(ensureAuthForSDK()).resolves.toBeUndefined();
  });
});
