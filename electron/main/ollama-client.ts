import { createLogger } from './logger';
import { executeLocalTool } from './local-tool-executor';

const logger = createLogger('local-llm');

export type LocalLLMProvider = 'ollama' | 'lmstudio' | 'openai-compatible';

const TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeL2(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

export async function checkOllamaAvailable(
  baseUrl: string,
  model: string,
  provider: LocalLLMProvider = 'ollama',
): Promise<{ available: boolean; models: string[] }> {
  try {
    if (provider === 'ollama') {
      const res = await fetchWithTimeout(`${baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) return { available: false, models: [] };
      const json = (await res.json()) as { models: Array<{ name: string }> };
      const models = json.models?.map((m) => m.name) ?? [];
      const available = models.some((m) => m.startsWith(model.split(':')[0]));
      return { available, models };
    } else {
      const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: 'GET' });
      if (!res.ok) return { available: false, models: [] };
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const models = json.data?.map((m) => m.id) ?? [];
      const available = models.some((m) => m === model || m.includes(model));
      return { available, models };
    }
  } catch {
    return { available: false, models: [] };
  }
}

async function tryGenerateEmbedding(
  baseUrl: string,
  model: string,
  text: string,
): Promise<number[] | null> {
  const res = await fetchWithTimeout(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
  }
  const json = (await res.json()) as { embedding?: number[]; error?: string };
  if (json.error) throw new Error(`Ollama error: ${json.error}`);
  if (!Array.isArray(json.embedding)) throw new Error('No embedding in response');
  return normalizeL2(json.embedding);
}

export async function generateEmbedding(
  baseUrl: string,
  model: string,
  text: string,
  retries = 2,
): Promise<number[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tryGenerateEmbedding(baseUrl, model, text);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        logger.error({ err, model, attempt }, 'Embedding generation failed after retries');
        return null;
      }
      logger.warn({ err, model, attempt }, 'Embedding attempt failed, retrying...');
      // Wait briefly before retry (model might be loading)
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

export async function generateEmbeddings(
  baseUrl: string,
  model: string,
  texts: string[],
): Promise<(number[] | null)[]> {
  return Promise.all(texts.map((t) => generateEmbedding(baseUrl, model, t)));
}

export async function ollamaChat(
  baseUrl: string,
  model: string,
  prompt: string,
  provider: LocalLLMProvider = 'ollama',
): Promise<string> {
  const isOllama = provider === 'ollama';
  const url = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM chat HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;

  let content: string | undefined;
  if (isOllama) {
    const msg = json.message as { content?: string } | undefined;
    content = msg?.content;
  } else {
    const choices = json.choices as Array<{ message: { content?: string } }> | undefined;
    content = choices?.[0]?.message?.content;
  }

  if (!content) throw new Error('Empty response from LLM chat');
  return content;
}

// ============================================================
// Types para ollamaChatWithTools e ollamaChatStream
// ============================================================

/** Formato de tool no padrao Ollama (identico ao OpenAI function-calling) */
export interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Uma chamada de tool retornada pelo modelo Ollama */
interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** Mensagem no historico de conversa para /api/chat */
interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

/** Resposta crua de /api/chat (stream: false) */
interface OllamaChatApiResponse {
  model: string;
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  eval_count?: number;
  prompt_eval_count?: number;
  done?: boolean;
}

/** Registro de uma tool executada durante a sessao */
export interface OllamaToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

/** Resultado final de ollamaChatWithTools */
export interface OllamaChatResult {
  content: string;
  model: string;
  tokensUsed: number;
  promptTokens: number;
  toolCalls: OllamaToolCallRecord[];
}

/** Opcoes para ollamaChatWithTools */
export interface OllamaChatWithToolsOptions {
  /** Numero maximo de rounds de tool-calling (default: 10) */
  maxRounds?: number;
  /** Temperature do modelo (0-1) */
  temperature?: number;
  /** Diretorio de trabalho para ferramentas de filesystem/shell */
  cwd?: string;
  /** Callback chamado a cada chunk de texto gerado pelo modelo */
  onText?: (chunk: string) => void;
  /** Callback chamado ao executar uma tool */
  onToolUse?: (record: OllamaToolCallRecord) => void;
  /** Provider do modelo local (default: 'ollama') */
  provider?: LocalLLMProvider;
}

// Timeout generoso para modelos locais que podem ser lentos
const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

async function fetchChatNonStreaming(
  baseUrl: string,
  messages: OllamaChatMessage[],
  model: string,
  tools: OllamaToolSchema[] | undefined,
  temperature: number | undefined,
  provider: LocalLLMProvider = 'ollama',
): Promise<OllamaChatApiResponse> {
  const isOllama = provider === 'ollama';
  const url = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (isOllama) {
    const options: Record<string, unknown> = {};
    if (temperature !== undefined) options.temperature = temperature;
    if (Object.keys(options).length > 0) body.options = options;
  } else {
    if (temperature !== undefined) body.temperature = temperature;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${isOllama ? 'Ollama' : provider} ${url} HTTP ${res.status}: ${text.substring(0, 300)}`);
    }

    if (isOllama) {
      return (await res.json()) as OllamaChatApiResponse;
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<{
      message: { content?: string; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }> }
    }> | undefined;
    const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

    const rawToolCalls = choices?.[0]?.message?.tool_calls;
    const toolCalls: OllamaToolCall[] | undefined = rawToolCalls?.map((tc) => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      },
    }));

    return {
      model: (data.model as string) || model,
      message: {
        content: choices?.[0]?.message?.content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      },
      eval_count: usage?.completion_tokens ?? usage?.total_tokens,
      prompt_eval_count: usage?.prompt_tokens,
      done: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat com tool-calling loop para Ollama.
 *
 * Envia a mensagem inicial, verifica se o modelo solicitou tool calls,
 * executa cada tool via executeLocalTool, devolve os resultados ao modelo
 * e repete ate nao haver mais tool calls ou atingir maxRounds.
 *
 * @param baseUrl      - URL base do Ollama (ex: "http://localhost:11434")
 * @param model        - Nome do modelo (ex: "llama3.1")
 * @param systemPrompt - Prompt de sistema (inserido como primeira mensagem)
 * @param prompt       - Mensagem inicial do usuario
 * @param tools        - Schemas das tools no formato Ollama
 * @param options      - Opcoes adicionais (maxRounds, temperature, callbacks, cwd)
 */
export async function ollamaChatWithTools(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  prompt: string,
  tools: OllamaToolSchema[],
  options: OllamaChatWithToolsOptions = {},
): Promise<OllamaChatResult> {
  const {
    maxRounds = 10,
    temperature,
    cwd = process.cwd(),
    onText,
    onToolUse,
    provider = 'ollama',
  } = options;

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const toolCallLog: OllamaToolCallRecord[] = [];
  let totalOutputTokens = 0;
  let totalPromptTokens = 0;
  let finalContent = '';
  let finalModel = model;

  logger.info(
    { model, baseUrl, provider, tools: tools.map((t) => t.function.name), maxRounds },
    'ollamaChatWithTools started',
  );

  for (let round = 0; round < maxRounds; round++) {
    const apiResponse = await fetchChatNonStreaming(
      baseUrl,
      messages,
      model,
      tools,
      temperature,
      provider,
    );

    totalOutputTokens += apiResponse.eval_count ?? 0;
    totalPromptTokens += apiResponse.prompt_eval_count ?? 0;
    finalModel = apiResponse.model || model;

    const msgContent = apiResponse.message?.content ?? '';
    const toolCalls = apiResponse.message?.tool_calls;

    // Sem tool calls = resposta final
    if (!toolCalls || toolCalls.length === 0) {
      finalContent = msgContent;
      if (onText && msgContent) {
        onText(msgContent);
      }
      logger.info({ round, model: finalModel }, 'ollamaChatWithTools finished (no more tool calls)');
      break;
    }

    // Adiciona resposta do assistente com tool calls ao historico
    messages.push({
      role: 'assistant',
      content: msgContent,
      tool_calls: toolCalls,
    });

    // Executa cada tool e adiciona resultado ao historico
    for (const call of toolCalls) {
      const toolName = call.function.name;
      const toolArgs = call.function.arguments;

      logger.info({ tool: toolName, round }, 'Executing tool call');

      const toolResult = await executeLocalTool(toolName, toolArgs, cwd);

      const record: OllamaToolCallRecord = {
        tool: toolName,
        input: toolArgs,
        output: toolResult.result,
        isError: toolResult.isError,
      };
      toolCallLog.push(record);

      if (onToolUse) {
        onToolUse(record);
      }

      const toolMessage: OllamaChatMessage = {
        role: 'tool',
        content: toolResult.result,
      };
      if (call.id) {
        toolMessage.tool_call_id = call.id;
      }
      messages.push(toolMessage);
    }

    // Se chegamos ao ultimo round sem resposta final, forca uma ultima chamada sem tools
    if (round === maxRounds - 1) {
      logger.warn({ model, maxRounds }, 'Max rounds reached, forcing final response without tools');
      const finalResponse = await fetchChatNonStreaming(
        baseUrl,
        messages,
        model,
        undefined,
        temperature,
        provider,
      );
      finalContent = finalResponse.message?.content ?? '[Limite de rounds atingido sem resposta final]';
      totalOutputTokens += finalResponse.eval_count ?? 0;
      totalPromptTokens += finalResponse.prompt_eval_count ?? 0;
      if (onText && finalContent) {
        onText(finalContent);
      }
    }
  }

  return {
    content: finalContent,
    model: finalModel,
    tokensUsed: totalOutputTokens,
    promptTokens: totalPromptTokens,
    toolCalls: toolCallLog,
  };
}

// ============================================================
// ollamaChatStream - streaming com AbortSignal
// ============================================================

/** Tipo de chunk emitido pelo AsyncGenerator */
export type OllamaStreamChunkType = 'text' | 'tool_call' | 'done';

export interface OllamaStreamChunk {
  type: OllamaStreamChunkType;
  /** Texto parcial (apenas quando type === 'text') */
  text?: string;
  /** Informacao de tool call (apenas quando type === 'tool_call') */
  toolCall?: {
    name: string;
    arguments: Record<string, unknown>;
    id?: string;
  };
  /** Metricas finais (apenas quando type === 'done') */
  done?: {
    model: string;
    tokensUsed: number;
    promptTokens: number;
  };
}

/** Chunk de streaming retornado pela Ollama API */
interface OllamaStreamApiChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

/** Opcoes para ollamaChatStream */
export interface OllamaChatStreamOptions {
  /** System prompt inserido como primeira mensagem */
  systemPrompt?: string;
  /** Temperature do modelo */
  temperature?: number;
  /** Tools no formato Ollama (opcional) */
  tools?: OllamaToolSchema[];
  /** AbortSignal para cancelamento externo */
  signal?: AbortSignal;
  /** Provider do modelo local (default: 'ollama') */
  provider?: LocalLLMProvider;
}

/**
 * Chat com streaming real-time para Ollama.
 *
 * Retorna um AsyncGenerator que emite chunks conforme chegam do modelo.
 * Suporta cancelamento via AbortSignal.
 *
 * Exemplo de uso:
 *   for await (const chunk of ollamaChatStream(url, model, prompt, opts)) {
 *     if (chunk.type === 'text') process.stdout.write(chunk.text ?? '');
 *   }
 *
 * @param baseUrl - URL base do Ollama
 * @param model   - Nome do modelo
 * @param prompt  - Mensagem do usuario
 * @param options - Opcoes (systemPrompt, temperature, tools, signal)
 */
export async function* ollamaChatStream(
  baseUrl: string,
  model: string,
  prompt: string,
  options: OllamaChatStreamOptions = {},
): AsyncGenerator<OllamaStreamChunk> {
  const { systemPrompt, temperature, tools, signal, provider = 'ollama' } = options;
  const isOllama = provider === 'ollama';

  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const url = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (isOllama) {
    const ollamaOptions: Record<string, unknown> = {};
    if (temperature !== undefined) ollamaOptions.temperature = temperature;
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions;
  } else {
    if (temperature !== undefined) body.temperature = temperature;
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), CHAT_TIMEOUT_MS);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      yield { type: 'done', done: { model, tokensUsed: 0, promptTokens: 0 } };
      return;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new Error(`${isOllama ? 'Ollama' : provider} stream HTTP ${res.status}: ${text.substring(0, 300)}`);
  }

  const body_ = res.body;
  if (!body_) {
    clearTimeout(timer);
    throw new Error('LLM response has no body');
  }

  const reader = body_.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalModel = model;
  let totalOutputTokens = 0;
  let totalPromptTokens = 0;

  try {
    if (isOllama) {
      yield* parseOllamaNDJSONStream(reader, decoder, buffer, finalModel, totalOutputTokens, totalPromptTokens);
    } else {
      yield* parseOpenAISSEStream(reader, decoder, buffer, finalModel, totalOutputTokens, totalPromptTokens);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function* parseOllamaNDJSONStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  finalModel: string,
  totalOutputTokens: number,
  totalPromptTokens: number,
): AsyncGenerator<OllamaStreamChunk> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let chunk: OllamaStreamApiChunk;
      try {
        chunk = JSON.parse(trimmed) as OllamaStreamApiChunk;
      } catch {
        logger.warn({ line: trimmed }, 'Failed to parse stream line');
        continue;
      }

      if (chunk.model) finalModel = chunk.model;
      if (chunk.eval_count) totalOutputTokens = chunk.eval_count;
      if (chunk.prompt_eval_count) totalPromptTokens = chunk.prompt_eval_count;

      const textContent = chunk.message?.content;
      if (textContent) {
        yield { type: 'text', text: textContent };
      }

      const toolCalls = chunk.message?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
          yield {
            type: 'tool_call',
            toolCall: {
              name: call.function.name,
              arguments: call.function.arguments,
              ...(call.id ? { id: call.id } : {}),
            },
          };
        }
      }

      if (chunk.done) break;
    }
  }

  yield {
    type: 'done',
    done: { model: finalModel, tokensUsed: totalOutputTokens, promptTokens: totalPromptTokens },
  };
}

interface OpenAIStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{ delta: OpenAIStreamDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function* parseOpenAISSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  finalModel: string,
  totalOutputTokens: number,
  totalPromptTokens: number,
): AsyncGenerator<OllamaStreamChunk> {
  const toolCallAccumulator = new Map<number, { id?: string; name: string; args: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;

      const dataPrefix = 'data: ';
      const jsonStr = trimmed.startsWith(dataPrefix) ? trimmed.slice(dataPrefix.length) : trimmed;

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
      } catch {
        logger.warn({ line: trimmed }, 'Failed to parse OpenAI stream line');
        continue;
      }

      if (chunk.model) finalModel = chunk.model;
      if (chunk.usage) {
        totalOutputTokens = chunk.usage.completion_tokens ?? chunk.usage.total_tokens ?? 0;
        totalPromptTokens = chunk.usage.prompt_tokens ?? 0;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          } else {
            toolCallAccumulator.set(tc.index, {
              id: tc.id,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, tc] of toolCallAccumulator) {
          if (tc.name) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.args); } catch { /* empty */ }
            yield {
              type: 'tool_call',
              toolCall: { name: tc.name, arguments: args, ...(tc.id ? { id: tc.id } : {}) },
            };
          }
        }
        toolCallAccumulator.clear();
      }
    }
  }

  for (const [, tc] of toolCallAccumulator) {
    if (tc.name) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.args); } catch { /* empty */ }
      yield {
        type: 'tool_call',
        toolCall: { name: tc.name, arguments: args, ...(tc.id ? { id: tc.id } : {}) },
      };
    }
  }

  yield {
    type: 'done',
    done: { model: finalModel, tokensUsed: totalOutputTokens, promptTokens: totalPromptTokens },
  };
}
