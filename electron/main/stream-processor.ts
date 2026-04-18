export interface StreamMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolUses: number;
  apiRequests: number;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolUse?: (toolName: string) => void;
  onMessageStart?: (usage: { inputBase: number; cacheRead: number; cacheCreation: number }) => void;
  onMessageDelta?: (outputTokens: number) => void;
  onMessageStop?: () => void;
  onResult?: (text: string) => void;
  onRawEvent?: (event: Record<string, unknown>) => void;
  shouldAbort?: () => boolean;
}

export interface StreamProcessorResult {
  output: string;
  metrics: StreamMetrics;
}

export async function processAgentStream(
  stream: AsyncIterable<Record<string, unknown>>,
  callbacks: StreamCallbacks,
): Promise<StreamProcessorResult> {
  const metrics: StreamMetrics = {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    toolUses: 0, apiRequests: 0,
  };
  let output = '';
  let accumulatedText = '';

  for await (const msg of stream) {
    if (callbacks.shouldAbort?.()) break;

    if ((msg as { type: string }).type === 'stream_event') {
      const event = (msg as { event: Record<string, unknown> }).event;

      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === 'text_delta') {
          const text = delta.text as string;
          accumulatedText += text;
          callbacks.onText?.(text);
        }
        else if (delta.type === 'thinking_delta') callbacks.onThinking?.(delta.thinking as string);
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === 'tool_use') {
          metrics.toolUses++;
          callbacks.onToolUse?.(block.name as string);
        }
      }

      if (event.type === 'message_start') {
        metrics.apiRequests++;
        const msgData = event.message as Record<string, unknown> | undefined;
        const usage = msgData?.usage as Record<string, number> | undefined;
        if (usage) {
          const inputBase = usage['input_tokens'] ?? 0;
          const cacheRead = usage['cache_read_input_tokens'] ?? 0;
          const cacheCreation = usage['cache_creation_input_tokens'] ?? 0;
          metrics.inputTokens += inputBase + cacheRead + cacheCreation;
          metrics.cacheReadTokens += cacheRead;
          metrics.cacheCreationTokens += cacheCreation;
          callbacks.onMessageStart?.({ inputBase, cacheRead, cacheCreation });
        }
      }

      if (event.type === 'message_delta') {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          const out = usage['output_tokens'] ?? 0;
          metrics.outputTokens += out;
          callbacks.onMessageDelta?.(out);
        }
      }

      if (event.type === 'message_stop') callbacks.onMessageStop?.();

      callbacks.onRawEvent?.(event);
    }

    if ((msg as { type: string }).type === 'result') {
      output = ((msg as Record<string, unknown>)['result'] as string) ?? '';
      callbacks.onResult?.(output);
    }
  }

  // Fallback: if result event had empty output, use accumulated text from stream
  if (!output && accumulatedText) {
    output = accumulatedText;
  }

  return { output, metrics };
}
