// src/lib/ark-client.ts

export interface ArkConfig {
  apiKey: string;
  baseURL?: string;
}

let cachedArkDispatcher: any | null | undefined;

async function getArkDispatcher(): Promise<any | undefined> {
  if (cachedArkDispatcher !== undefined) return cachedArkDispatcher ?? undefined;

  const raw = Number.parseInt(process.env.ARK_CONNECT_TIMEOUT_MS ?? '20000', 10);
  const connectTimeoutMs = Number.isFinite(raw) ? Math.min(60000, Math.max(1000, raw)) : 20000;

  try {
    // Node.js fetch uses Undici under the hood; "dispatcher" lets us control connect timeout.
    // Use dynamic import so builds/environments without direct undici access can still work.
    const undici: any = await import('undici');
    const Agent = undici?.Agent;
    if (!Agent) {
      cachedArkDispatcher = null;
      return undefined;
    }

    cachedArkDispatcher = new Agent({
      connect: {
        timeout: connectTimeoutMs,
      },
    });
    return cachedArkDispatcher;
  } catch {
    cachedArkDispatcher = null;
    return undefined;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{
    type: string;
    text?: string;
    image_url?: { url: string; detail?: string };
  }>;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatCompletionResponseWithMeta extends ChatCompletionResponse {
  model?: string;
  service_tier?: string;
  created?: number;
  object?: string;
}

export class ArkApiError extends Error {
  status: number;
  code?: string;
  type?: string;
  requestId?: string;
  rawBody?: string;

  constructor(message: string, options: { status: number; code?: string; type?: string; requestId?: string; rawBody?: string }) {
    super(message);
    this.name = 'ArkApiError';
    this.status = options.status;
    this.code = options.code;
    this.type = options.type;
    this.requestId = options.requestId;
    this.rawBody = options.rawBody;
  }
}

/**
 * 调用方舟大模型 Chat API
 */
export async function callArkChat(
  messages: ChatMessage[],
  model: string,
  config: ArkConfig,
  options?: { temperature?: number; maxTokens?: number; thinking?: boolean; timeoutMs?: number; signal?: AbortSignal }
): Promise<string> {
  const { apiKey, baseURL = 'https://ark.cn-beijing.volces.com/api/v3' } = config;

  const payload: any = {
    model: model,
    messages: messages,
    temperature: options?.temperature ?? 0.1,
    max_tokens: options?.maxTokens ?? 4096,
  };

  if (options?.thinking === true) {
    payload.thinking = { type: 'enabled' };
  } else {
    // Ark may include reasoning_content by default; explicitly disable to reduce tokens/latency.
    payload.thinking = { type: 'disabled' };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs;
  const externalSignal = options?.signal;

  const abortFromExternal = () => {
    try {
      controller.abort(externalSignal?.reason);
    } catch {
      controller.abort();
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  const timeoutId = typeof timeoutMs === 'number' && timeoutMs > 0
    ? setTimeout(() => {
      // Use AbortError semantics.
      controller.abort(new DOMException('Request timed out', 'AbortError'));
    }, timeoutMs)
    : null;

  const dispatcher = await getArkDispatcher();

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  if (externalSignal) {
    externalSignal.removeEventListener('abort', abortFromExternal);
  }

  if (!response.ok) {
    const errorText = await response.text();

    let parsedCode: string | undefined;
    let parsedType: string | undefined;
    let parsedMessage: string | undefined;
    let parsedRequestId: string | undefined;

    try {
      const parsed = JSON.parse(errorText);
      parsedCode = parsed?.error?.code;
      parsedType = parsed?.error?.type;
      parsedMessage = parsed?.error?.message;
      parsedRequestId = parsed?.error?.request_id || parsed?.request_id || parsed?.requestId;
    } catch {
      // ignore JSON parse error
    }

    const message = parsedMessage
      ? `方舟 API 调用失败 (${response.status} ${parsedCode ?? ''}): ${parsedMessage}`.trim()
      : `方舟 API 调用失败 (${response.status}): ${errorText}`;

    throw new ArkApiError(message, {
      status: response.status,
      code: parsedCode,
      type: parsedType,
      requestId: parsedRequestId,
      rawBody: errorText,
    });
  }

  const data: ChatCompletionResponse = await response.json();
  return data.choices[0]?.message?.content || '';
}

export async function callArkChatDetailed(
  messages: ChatMessage[],
  model: string,
  config: ArkConfig,
  options?: { temperature?: number; maxTokens?: number; thinking?: boolean; timeoutMs?: number; signal?: AbortSignal }
): Promise<{ content: string; reasoningContent?: string; usage?: ChatCompletionResponseWithMeta['usage']; serviceTier?: string; id?: string; model?: string }> {
  const { apiKey, baseURL = 'https://ark.cn-beijing.volces.com/api/v3' } = config;

  const payload: any = {
    model: model,
    messages: messages,
    temperature: options?.temperature ?? 0.1,
    max_tokens: options?.maxTokens ?? 4096,
  };

  if (options?.thinking === true) {
    payload.thinking = { type: 'enabled' };
  } else {
    payload.thinking = { type: 'disabled' };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs;
  const externalSignal = options?.signal;

  const abortFromExternal = () => {
    try {
      controller.abort(externalSignal?.reason);
    } catch {
      controller.abort();
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  const timeoutId = typeof timeoutMs === 'number' && timeoutMs > 0
    ? setTimeout(() => {
      controller.abort(new DOMException('Request timed out', 'AbortError'));
    }, timeoutMs)
    : null;

  const dispatcher = await getArkDispatcher();

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  if (externalSignal) {
    externalSignal.removeEventListener('abort', abortFromExternal);
  }

  if (!response.ok) {
    const errorText = await response.text();

    let parsedCode: string | undefined;
    let parsedType: string | undefined;
    let parsedMessage: string | undefined;
    let parsedRequestId: string | undefined;

    try {
      const parsed = JSON.parse(errorText);
      parsedCode = parsed?.error?.code;
      parsedType = parsed?.error?.type;
      parsedMessage = parsed?.error?.message;
      parsedRequestId = parsed?.error?.request_id || parsed?.request_id || parsed?.requestId;
    } catch {
      // ignore JSON parse error
    }

    const message = parsedMessage
      ? `方舟 API 调用失败 (${response.status} ${parsedCode ?? ''}): ${parsedMessage}`.trim()
      : `方舟 API 调用失败 (${response.status}): ${errorText}`;

    throw new ArkApiError(message, {
      status: response.status,
      code: parsedCode,
      type: parsedType,
      requestId: parsedRequestId,
      rawBody: errorText,
    });
  }

  const data: ChatCompletionResponseWithMeta = await response.json();
  return {
    content: data.choices[0]?.message?.content || '',
    reasoningContent: data.choices[0]?.message?.reasoning_content || '',
    usage: data.usage,
    serviceTier: data.service_tier,
    id: data.id,
    model: data.model,
  };
}

/**
 * 并发调用两个模型
 */
export async function callArkParallel(
  messages: ChatMessage[],
  model1: string,
  model2: string,
  config: ArkConfig
): Promise<[string, string]> {
  const [result1, result2] = await Promise.all([
    callArkChat(messages, model1, config, { temperature: 0.1 }),
    callArkChat(messages, model2, config, { temperature: 0.1 }),
  ]);
  return [result1, result2];
}