import {
  AssistantMessage,
  Message,
  ToolCallRequest
} from "../messages.js";
import { ChatCompletionChunk, ChatCompletionResult, Usage } from "../types.js";
import { registerComponent } from "../componentConfig.js";
import type { SerializableComponent } from "../componentConfig.js";
import {
  AuthenticationError,
  BaseChatCompletionClient,
  BaseChatCompletionError,
  InvalidRequestError,
  RateLimitError,
  StructuredOutputFormat,
  normalizeOutputFormat,
  parseStructuredOutput
} from "./base.js";
import { fetchWithRetries } from "./http.js";

export interface OpenAIChatCompletionClientOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  fetchImpl?: typeof fetch;
  defaultOptions?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class OpenAIChatCompletionClient extends BaseChatCompletionClient implements SerializableComponent {
  static componentType = "model";
  static componentProvider = "picoagents.llm.OpenAIChatCompletionClient";
  static componentVersion = 1;

  baseUrl: string;
  organization?: string;
  protected fetchImpl: typeof fetch;
  protected defaultOptions: Record<string, unknown>;
  protected timeoutMs: number;
  protected maxRetries: number;
  protected retryDelayMs: number;

  constructor(options: OpenAIChatCompletionClientOptions = {}) {
    super({
      model: options.model ?? "gpt-4.1-mini",
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY
    });
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.organization = options.organization;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultOptions = options.defaultOptions ?? {};
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  toConfig(): Record<string, unknown> {
    return {
      model: this.model,
      baseUrl: this.baseUrl,
      organization: this.organization,
      defaultOptions: this.defaultOptions,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs
    };
  }

  static fromConfig(config: any): OpenAIChatCompletionClient {
    return new OpenAIChatCompletionClient(config);
  }

  async create(
    messages: Message[],
    options: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      signal?: AbortSignal;
      [key: string]: unknown;
    } = {}
  ): Promise<ChatCompletionResult> {
    const start = Date.now();
    const { tools, outputFormat, signal, ...requestOptions } = options;
    const body: Record<string, unknown> = {
      model: this.requestModel(),
      messages: this.convertMessagesToApiFormat(messages),
      ...this.defaultOptions,
      ...requestOptions
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const responseFormat = normalizeOutputFormat(outputFormat);
    if (responseFormat) body.response_format = responseFormat;

    const json = await this.postJson(this.completionsUrl(), body, signal);
    const choice = json.choices?.[0];
    const assistantContent = choice?.message?.content ?? "";
    const toolCalls = this.parseToolCalls(choice?.message?.tool_calls);
    const usageData = json.usage;
    const usage = new Usage({
      durationMs: Date.now() - start,
      llmCalls: 1,
      tokensInput: usageData?.prompt_tokens ?? 0,
      tokensOutput: usageData?.completion_tokens ?? 0,
      toolCalls: toolCalls.length,
      costEstimate: usageData ? this.estimateCost(usageData.prompt_tokens ?? 0, usageData.completion_tokens ?? 0) : undefined
    });

    let structuredOutput: unknown;
    if (outputFormat && typeof assistantContent === "string" && assistantContent.trim()) {
      structuredOutput = parseStructuredOutput(assistantContent, outputFormat);
    }

    return {
      message: new AssistantMessage({
        content: assistantContent,
        source: "llm",
        toolCalls: toolCalls.length ? toolCalls : undefined
      }),
      usage,
      model: json.model ?? this.model,
      finishReason: choice?.finish_reason ?? "stop",
      structuredOutput
    };
  }

  async *createStream(
    messages: Message[],
    options: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      streamOptions?: Record<string, unknown>;
      signal?: AbortSignal;
      [key: string]: unknown;
    } = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    const { tools, outputFormat, streamOptions, signal, ...requestOptions } = options;
    if (outputFormat) {
      console.warn("Structured output is not yet supported in streaming mode");
    }
    const body: Record<string, unknown> = {
      model: this.requestModel(),
      messages: this.convertMessagesToApiFormat(messages),
      stream: true,
      stream_options: streamOptions ?? { include_usage: true },
      ...this.defaultOptions,
      ...requestOptions
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await fetchWithRetries(this.completionsUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    }, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      signal
    });
    if (!response.ok) await throwProviderError(response);
    if (!response.body) throw new BaseChatCompletionError("Streaming response body is empty");

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    const toolCallChunks = new Map<number | string, any>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (!data || data === "[DONE]") continue;
        const chunk = JSON.parse(data);

        if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
          // Final usage-only chunk: emit the single terminal chunk and stop.
          yield {
            content: "",
            isComplete: true,
            usage: new Usage({
              durationMs: 0,
              llmCalls: 1,
              tokensInput: chunk.usage.prompt_tokens ?? 0,
              tokensOutput: chunk.usage.completion_tokens ?? 0
            })
          };
          return;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (delta.content) {
          yield { content: delta.content, isComplete: false };
        }

        if (delta.tool_calls?.length) {
          for (const toolDelta of delta.tool_calls) {
            const key = toolDelta.index ?? toolDelta.id;
            const current = toolCallChunks.get(key) ?? {
              id: toolDelta.id,
              function: { name: "", arguments: "" }
            };
            if (toolDelta.id) current.id = toolDelta.id;
            if (toolDelta.function?.name) current.function.name = toolDelta.function.name;
            if (toolDelta.function?.arguments) {
              current.function.arguments += toolDelta.function.arguments;
            }
            toolCallChunks.set(key, current);
            yield {
              content: "",
              isComplete: false,
              toolCallChunk: current
            };
          }
        }
      }
    }

    yield { content: "", isComplete: true };
  }

  protected requestModel(): string {
    return this.model;
  }

  protected completionsUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.organization) headers["openai-organization"] = this.organization;
    return headers;
  }

  protected async postJson(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const response = await fetchWithRetries(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    }, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      signal
    });
    if (!response.ok) await throwProviderError(response);
    return response.json();
  }

  protected estimateCost(tokensInput: number, tokensOutput: number): number | undefined {
    const pricing = [
      { prefix: "gpt-4-turbo", input: 0.01 / 1000, output: 0.03 / 1000 },
      { prefix: "gpt-4.1-mini", input: 0.40 / 1_000_000, output: 1.60 / 1_000_000 },
      { prefix: "gpt-4.1", input: 2.00 / 1_000_000, output: 8.00 / 1_000_000 },
      { prefix: "gpt-4o-mini", input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
      { prefix: "gpt-4o", input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
      { prefix: "gpt-4", input: 0.03 / 1000, output: 0.06 / 1000 },
      { prefix: "gpt-3.5-turbo", input: 0.0005 / 1000, output: 0.0015 / 1000 }
    ];
    const row = pricing.find((item) => this.model.startsWith(item.prefix));
    if (!row) return undefined;
    return tokensInput * row.input + tokensOutput * row.output;
  }
}

registerComponent(OpenAIChatCompletionClient as any);

export function buildToolCallsFromChunks(chunks: Map<string, any> | Record<string, any>): ToolCallRequest[] {
  const values = chunks instanceof Map ? Array.from(chunks.values()) : Object.values(chunks);
  return values
    .filter((chunk) => chunk?.id && chunk?.function?.name)
    .map(
      (chunk) =>
        new ToolCallRequest({
          toolName: chunk.function.name,
          parameters: chunk.function.arguments ? JSON.parse(chunk.function.arguments) : {},
          callId: chunk.id
        })
    );
}

async function throwProviderError(response: Response): Promise<never> {
  const text = await response.text();
  let responseData: unknown = text;
  try {
    responseData = JSON.parse(text);
  } catch {
    // Keep raw text.
  }
  const message =
    typeof responseData === "object" && responseData && "error" in responseData
      ? JSON.stringify((responseData as any).error)
      : text;
  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(`Authentication failed: ${message}`, response.status, responseData);
  }
  if (response.status === 429) {
    throw new RateLimitError(`Rate limit exceeded: ${message}`, response.status, responseData);
  }
  if (response.status >= 400 && response.status < 500) {
    throw new InvalidRequestError(`Invalid request: ${message}`, response.status, responseData);
  }
  throw new BaseChatCompletionError(`Provider API error: ${message}`, response.status, responseData);
}
