import { createLogger } from './logger';

const logger = createLogger('json-extractor');

/**
 * Extract every top-level balanced JSON object substring from `text`.
 * Returns candidates ordered by their start index (earliest first).
 *
 * Algorithm: walk character by character maintaining a depth counter.
 * When depth reaches 0 after a closing brace, we have a complete top-level object.
 * Braces inside JSON string literals are skipped via a simple string-state machine.
 */
export function extractBalancedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    // Find next '{' that is not inside a string
    if (text[i] !== '{') {
      i++;
      continue;
    }

    // We found a potential start of a JSON object
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (i < len) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        i++;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        i++;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        i++;
        continue;
      }

      if (!inString) {
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            candidates.push(text.slice(start, i + 1));
            i++;
            break;
          }
        }
      }

      i++;
    }

    // If we exhausted the string with depth > 0, the brace was unbalanced — skip
    if (depth > 0) {
      i++;
    }
  }

  return candidates;
}

/** Known single-key wrapper names that models tend to emit around the real payload. */
const KNOWN_WRAPPER_KEYS = new Set(['plan', 'data', 'result', 'output']);

/**
 * Unwrap known single-key wrapper objects such as `{ "plan": { ... } }`.
 * Applies idempotently up to 5 iterations.
 * Returns the innermost value if all wrappers match, or the original value if not.
 */
export function unwrapKnownJsonWrappers(value: unknown): unknown {
  let current = value;
  for (let iter = 0; iter < 5; iter++) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      break;
    }
    const obj = current as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== 1) break;
    const key = keys[0];
    if (!KNOWN_WRAPPER_KEYS.has(key)) break;
    const inner = obj[key];
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) break;
    current = inner;
  }
  return current;
}

export interface ExtractJSONOptions<T> {
  /**
   * Parser that validates and returns T. May mutate `outMeta.repaired = true`
   * when it needed a repair fallback (e.g. jsonrepair). When set, the returned
   * tier will be 'jsonrepair' instead of the source name.
   */
  parser: (text: string, outMeta?: { repaired?: boolean }) => T;
  contextLabel: string;
  round?: number;
  sprintId?: string;
}

/**
 * Shape required by extractJSON. Matches StreamProcessorResult's text fields,
 * but excludes `metrics` so callers can pass a synthetic object built from
 * AgentExecutionResult (which carries accumulatedText/textBlocks from cloud-executor)
 * without needing to fabricate metric fields.
 */
export interface ExtractJSONSource {
  output: string;
  accumulatedText: string;
  textBlocks: string[];
}

export function extractJSON<T>(
  result: ExtractJSONSource,
  opts: ExtractJSONOptions<T>,
): { value: T; tier: string } {
  const sources = [
    { name: 'result', text: result.output },
    { name: 'accumulated', text: result.accumulatedText },
    ...result.textBlocks.slice().reverse().map((b, i) => ({
      name: `block[${result.textBlocks.length - 1 - i}]`,
      text: b,
    })),
  ];

  let lastError: Error | null = null;
  for (const src of sources) {
    if (!src.text?.trim()) continue;
    try {
      const meta: { repaired?: boolean } = {};
      const parsed = opts.parser(src.text, meta);
      const tier = meta.repaired ? 'jsonrepair' : src.name;
      if (tier !== 'result') {
        logger.warn({
          contextLabel: opts.contextLabel,
          round: opts.round,
          sprintId: opts.sprintId,
          fallbackTier: tier,
          sourceName: src.name,
          repaired: !!meta.repaired,
          originalLen: result.output.length,
          usedLen: src.text.length,
        }, `${opts.contextLabel} JSON extracted from fallback source`);
      }
      return { value: parsed, tier };
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error(`No valid ${opts.contextLabel} JSON in any source`);
}
