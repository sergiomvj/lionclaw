/**
 * stream-processor.test.ts
 *
 * Unit tests for processAgentStream focusing on the accumulatedText and
 * textBlocks fields introduced in Feature 4.
 */

import { describe, it, expect } from 'vitest';
import { processAgentStream } from '../stream-processor';
import type { StreamCallbacks } from '../stream-processor';

// ---------------------------------------------------------------------------
// Helper: build stream events
// ---------------------------------------------------------------------------

async function* toAsync(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

function textDelta(text: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  };
}

function blockStop(): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  };
}

function blockStartToolUse(name: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name },
    },
  };
}

function messageStart(inputTokens = 0, cacheRead = 0, cacheCreation = 0): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      },
    },
  };
}

function messageDelta(outputTokens: number): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      usage: { output_tokens: outputTokens },
    },
  };
}

function resultEvent(text: string): Record<string, unknown> {
  return { type: 'result', result: text };
}

const noCallbacks: StreamCallbacks = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processAgentStream: accumulatedText and textBlocks', () => {

  // Test 1: single continuous text block
  it('accumulates text in a single block correctly', async () => {
    const events = [
      textDelta('hello '),
      textDelta('world'),
      blockStop(),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.accumulatedText).toBe('hello world');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('hello world');
    // No result event -> fallback to accumulatedText
    expect(result.output).toBe('hello world');
  });

  // Test 2: text block + tool_use block + another text block
  it('separates text blocks correctly when interleaved with tool_use', async () => {
    const events = [
      textDelta('A'),
      blockStop(),
      blockStartToolUse('MyTool'),
      blockStop(),
      textDelta('B'),
      blockStop(),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(2);
    expect(result.textBlocks[0]).toBe('A');
    expect(result.textBlocks[1]).toBe('B');
    expect(result.accumulatedText).toBe('AB');
  });

  // Test 3: empty stream
  it('returns empty values for empty stream', async () => {
    const result = await processAgentStream(toAsync([]), noCallbacks);

    expect(result.textBlocks).toEqual([]);
    expect(result.accumulatedText).toBe('');
    expect(result.output).toBe('');
    expect(result.metrics.apiRequests).toBe(0);
    expect(result.metrics.inputTokens).toBe(0);
  });

  // Test 4: result event sets output, text still in accumulatedText
  it('uses result event as output and still tracks accumulatedText', async () => {
    const events = [
      textDelta('some text'),
      blockStop(),
      resultEvent('final answer'),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.output).toBe('final answer');
    expect(result.accumulatedText).toBe('some text');
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('some text');
  });

  // Test 5: unclosed block (no content_block_stop) gets flushed at end
  it('flushes an unclosed text block into textBlocks after stream ends', async () => {
    const events = [
      textDelta('unclosed block content'),
      // Deliberately no blockStop()
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toBe('unclosed block content');
    expect(result.accumulatedText).toBe('unclosed block content');
  });

  // Test 6: AgentSequence bug scenario - JSON block + tool_use + comment block + empty result
  it('handles JSON block + tool_use + comment block with empty result event', async () => {
    const jsonPayload = '{"plans":[{"id":1}]}';
    const commentText = 'Planning complete.';

    const events = [
      // Block 1: JSON output
      textDelta(jsonPayload),
      blockStop(),
      // Block 2: tool_use (no text)
      blockStartToolUse('save_plan'),
      blockStop(),
      // Block 3: comment text
      textDelta(commentText),
      blockStop(),
      // Result event with empty string
      resultEvent(''),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(2);
    expect(result.textBlocks[0]).toBe(jsonPayload);
    expect(result.textBlocks[1]).toBe(commentText);
    expect(result.accumulatedText).toBe(jsonPayload + commentText);
    // result event was empty string, so fallback to accumulatedText
    expect(result.output).toBe(jsonPayload + commentText);
  });

  // Test 7: metrics are tracked alongside text collection
  it('tracks metrics correctly while collecting text blocks', async () => {
    const events = [
      messageStart(10, 2, 3),
      textDelta('hello'),
      blockStop(),
      messageDelta(5),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.metrics.apiRequests).toBe(1);
    // inputTokens = input_tokens + cache_read + cache_creation = 10 + 2 + 3 = 15
    expect(result.metrics.inputTokens).toBe(15);
    expect(result.metrics.cacheReadTokens).toBe(2);
    expect(result.metrics.cacheCreationTokens).toBe(3);
    expect(result.metrics.outputTokens).toBe(5);
    expect(result.accumulatedText).toBe('hello');
    expect(result.textBlocks).toHaveLength(1);
  });

  // Test 8: tool_use blocks with no text do not appear in textBlocks
  it('does not add empty tool_use blocks to textBlocks', async () => {
    const events = [
      blockStartToolUse('ToolA'),
      blockStop(),
      blockStartToolUse('ToolB'),
      blockStop(),
    ];

    const result = await processAgentStream(toAsync(events), noCallbacks);

    expect(result.textBlocks).toHaveLength(0);
    expect(result.accumulatedText).toBe('');
    expect(result.metrics.toolUses).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// onToolUseComplete callback tests
// ---------------------------------------------------------------------------

function inputJsonDelta(partialJson: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: partialJson },
    },
  };
}

describe('processAgentStream: onToolUseComplete', () => {

  // Test 9: onToolUseComplete fires with assembled input from deltas
  it('assembles input_json_delta fragments and calls onToolUseComplete', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{"file_pa'),
      inputJsonDelta('th":"a.ts"}'),
      blockStop(),
    ];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].input).toEqual({ file_path: 'a.ts' });
  });

  // Test 10: onToolUse (legacy) still fires independently
  it('fires onToolUse (legacy) in addition to onToolUseComplete', async () => {
    const legacyCalls: string[] = [];
    const completeCalls: Array<{ name: string; input: unknown }> = [];

    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{"file_path":"b.ts"}'),
      blockStop(),
    ];

    await processAgentStream(toAsync(events), {
      onToolUse: (name) => legacyCalls.push(name),
      onToolUseComplete: (name, input) => completeCalls.push({ name, input }),
    });

    expect(legacyCalls).toEqual(['Read']);
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].input).toEqual({ file_path: 'b.ts' });
  });

  // Test 11: caller that omits onToolUseComplete does not error
  it('works correctly when onToolUseComplete is not provided', async () => {
    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{"file_path":"c.ts"}'),
      blockStop(),
    ];

    const result = await processAgentStream(toAsync(events), {});

    expect(result.metrics.toolUses).toBe(1);
  });

  // Test 12: malformed JSON yields null input without throwing
  it('passes null input when accumulated JSON is malformed', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{bad json'),
      blockStop(),
    ];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Read');
    expect(calls[0].input).toBeNull();
  });

  // Test 13: multiple sequential tool_use blocks each get their own onToolUseComplete
  it('fires onToolUseComplete separately for each sequential tool_use block', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];

    const events = [
      blockStartToolUse('Read'),
      inputJsonDelta('{"file_path":"x.ts"}'),
      blockStop(),
      blockStartToolUse('Glob'),
      inputJsonDelta('{"pattern":"**/*.ts"}'),
      blockStop(),
    ];

    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => calls.push({ name, input }),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'Read', input: { file_path: 'x.ts' } });
    expect(calls[1]).toEqual({ name: 'Glob', input: { pattern: '**/*.ts' } });
  });

  // Test 14: Bug #1 regression - empty block.input {} followed by input_json_delta
  it('handles empty initial block.input followed by input_json_delta without corruption', async () => {
    const events = [
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"file_pa' },
        },
      },
      {
        type: 'stream_event' as const,
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 'th":"foo.ts"}' },
        },
      },
      {
        type: 'stream_event' as const,
        event: { type: 'content_block_stop' },
      },
    ];

    const completes: Array<{ name: string; input: unknown }> = [];
    await processAgentStream(toAsync(events), {
      onToolUseComplete: (name, input) => { completes.push({ name, input }); },
    });

    expect(completes).toEqual([{ name: 'Read', input: { file_path: 'foo.ts' } }]);
  });
});
