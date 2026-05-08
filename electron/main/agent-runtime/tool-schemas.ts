/**
 * tool-schemas.ts
 *
 * Converts builtin tool names to OllamaToolSchema format for local/external runtimes.
 * Extracted from harness-engine.ts (private function builtinToolsToOllamaSchemas).
 *
 * Cloud runtime does not use this — it sends tool names as strings to the SDK.
 */

import type { OllamaToolSchema } from '../ollama-client';

const BUILTIN_SCHEMAS: Record<string, OllamaToolSchema> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'number', description: 'Line offset (0-based).' },
          limit: { type: 'number', description: 'Max lines to read.' },
        },
        required: ['file_path'],
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file, creating it if necessary.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace a substring in a file with new content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          old_string: { type: 'string', description: 'Exact string to replace.' },
          new_string: { type: 'string', description: 'Replacement string.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match.' },
          path: { type: 'string', description: 'Base directory path.' },
        },
        required: ['pattern'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search for a regex pattern in files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search.' },
          path: { type: 'string', description: 'Directory or file to search.' },
          glob: { type: 'string', description: 'File glob filter.' },
        },
        required: ['pattern'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeout: { type: 'number', description: 'Timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  },
};

/**
 * Convert an array of builtin tool names (e.g. ['Read', 'Write', 'Bash'])
 * into OllamaToolSchema objects for use with local/external runtimes.
 * MCP tool names (starting with 'mcp__') are filtered out — they are not
 * supported in local/external mode.
 */
export function builtinToolsToOllamaSchemas(toolNames: string[]): OllamaToolSchema[] {
  return toolNames
    .filter((n) => !n.startsWith('mcp__'))
    .map((n) => BUILTIN_SCHEMAS[n])
    .filter((s): s is OllamaToolSchema => s !== undefined);
}
