import {
  AssistantMessage,
  Message,
  MultiModalMessage,
  ToolCallRequest,
  ToolMessage
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
  StructuredOutputFormat
} from "./base.js";
import { fetchWithRetries } from "./http.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicChatCompletionClientOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultOptions?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class AnthropicChatCompletionClient
  extends BaseChatCompletionClient
  implements SerializableComponent
{
  static componentType = "model";
  static componentProvider = "picoagents.llm.AnthropicChatCompletionClient";
  static componentVersion = 1;

  baseUrl: string;
  protected fetchImpl: typeof fetch;
  protected defaultOptions: Record<string, unknown>;
  protected timeoutMs: number;
  protected maxRetries: number;
  protected retryDelayMs: number;

  constructor(options: AnthropicChatCompletionClientOptions = {}) {
    super({
      model: options.model ?? "claude-sonnet-4-6",
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY
    });
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
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
      defaultOptions: this.defaultOptions,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs
    };
  }

  static fromConfig(config: any): AnthropicChatCompletionClient {
    return new AnthropicChatCompletionClient(config);
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
    if (outputFormat) {
      // Structured output is not yet supported for the Anthropic client.
      console.warn("Structured output is not yet supported in the Anthropic client");
    }

    const body = this.buildRequestBody(messages, tools, requestOptions);

    const json = await this.postJson(this.messagesUrl(), body, signal);

    let assistantContent = "";
    const toolCalls: ToolCallRequest[] = [];
    for (const block of json.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        assistantContent += block.text;
      } else if (block?.type === "tool_use") {
        toolCalls.push(
          new ToolCallRequest({
            toolName: block.name ?? "",
            parameters: block.input && typeof block.input === "object" ? block.input : {},
            callId: block.id
          })
        );
      }
    }

    const usageData = json.usage;
    const tokensInput = usageData?.input_tokens ?? 0;
    const tokensOutput = usageData?.output_tokens ?? 0;
    const usage = new Usage({
      durationMs: Date.now() - start,
      llmCalls: 1,
      tokensInput,
      tokensOutput,
      toolCalls: toolCalls.length,
      costEstimate: usageData ? this.estimateCost(tokensInput, tokensOutput) : undefined
    });

    return {
      message: new AssistantMessage({
        content: assistantContent,
        source: "llm",
        toolCalls: toolCalls.length ? toolCalls : undefined
      }),
      usage,
      model: json.model ?? this.model,
      finishReason: json.stop_reason ?? "stop",
      structuredOutput: undefined
    };
  }

  async *createStream(
    messages: Message[],
    options: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      signal?: AbortSignal;
      [key: string]: unknown;
    } = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    const { tools, outputFormat, signal, ...requestOptions } = options;
    if (outputFormat) {
      console.warn("Structured output is not yet supported in streaming mode");
    }

    const body = this.buildRequestBody(messages, tools, requestOptions);
    body.stream = true;

    const response = await fetchWithRetries(this.messagesUrl(), {
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
    const toolCallChunks = new Map<number, any>();
    let tokensInput = 0;
    let tokensOutput = 0;
    let emittedTerminal = false;

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
        const event = JSON.parse(data);

        switch (event.type) {
          case "message_start": {
            const u = event.message?.usage;
            if (u) {
              tokensInput = u.input_tokens ?? tokensInput;
              tokensOutput = u.output_tokens ?? tokensOutput;
            }
            break;
          }
          case "content_block_start": {
            const block = event.content_block;
            if (block?.type === "tool_use") {
              const current = {
                id: block.id,
                function: { name: block.name ?? "", arguments: "" }
              };
              toolCallChunks.set(event.index, current);
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta ?? {};
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              yield { content: delta.text, isComplete: false };
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const current =
                toolCallChunks.get(event.index) ?? {
                  id: `call_${event.index}`,
                  function: { name: "", arguments: "" }
                };
              current.function.arguments += delta.partial_json;
              toolCallChunks.set(event.index, current);
              yield { content: "", isComplete: false, toolCallChunk: current };
            }
            break;
          }
          case "message_delta": {
            const u = event.usage;
            if (u) {
              tokensOutput = u.output_tokens ?? tokensOutput;
            }
            break;
          }
          case "message_stop": {
            yield {
              content: "",
              isComplete: true,
              usage: new Usage({
                durationMs: 0,
                llmCalls: 1,
                tokensInput,
                tokensOutput,
                toolCalls: toolCallChunks.size
              })
            };
            emittedTerminal = true;
            return;
          }
          default:
            break;
        }
      }
    }

    // Stream ended without a message_stop event: emit a single terminal chunk.
    if (!emittedTerminal) {
      yield {
        content: "",
        isComplete: true,
        usage: new Usage({
          durationMs: 0,
          llmCalls: 1,
          tokensInput,
          tokensOutput,
          toolCalls: toolCallChunks.size
        })
      };
    }
  }

  protected buildRequestBody(
    messages: Message[],
    tools: Record<string, unknown>[] | undefined,
    requestOptions: Record<string, unknown>
  ): Record<string, unknown> {
    const { system, apiMessages } = this.convertMessagesToAnthropicFormat(messages);

    const { max_tokens, maxTokens, ...rest } = requestOptions;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: apiMessages,
      max_tokens: (max_tokens as number) ?? (maxTokens as number) ?? DEFAULT_MAX_TOKENS,
      ...this.defaultOptions,
      ...rest
    };
    if (system) body.system = system;
    if (tools?.length) body.tools = this.convertToolsToAnthropicFormat(tools);
    return body;
  }

  protected convertMessagesToAnthropicFormat(messages: Message[]): {
    system?: string;
    apiMessages: Array<Record<string, unknown>>;
  } {
    let system: string | undefined;
    const apiMessages: Array<Record<string, unknown>> = [];

    for (const message of messages) {
      if (message.role === "system") {
        system = system ? `${system}\n\n${message.content}` : message.content;
        continue;
      }

      if (message instanceof MultiModalMessage) {
        const contentParts: Array<Record<string, unknown>> = [];
        if (message.content && message.content.trim()) {
          contentParts.push({ type: "text", text: message.content });
        }
        if (message.isImage()) {
          if (message.data) {
            contentParts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: message.mimeType,
                data: message.toBase64()
              }
            });
          } else if (message.mediaUrl) {
            console.warn("Anthropic API doesn't support image URLs directly");
          }
        }
        apiMessages.push({
          role: message.role,
          content: contentParts.length ? contentParts : message.content
        });
        continue;
      }

      if (message instanceof AssistantMessage && message.toolCalls?.length) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (message.content) {
          contentBlocks.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: call.callId,
            name: call.toolName,
            input: call.parameters
          });
        }
        apiMessages.push({ role: "assistant", content: contentBlocks });
        continue;
      }

      if (message instanceof ToolMessage) {
        apiMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content
            }
          ]
        });
        continue;
      }

      apiMessages.push({ role: message.role, content: message.content });
    }

    return { system, apiMessages };
  }

  protected convertToolsToAnthropicFormat(
    tools: Record<string, unknown>[]
  ): Array<Record<string, unknown>> {
    const anthropicTools: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
      if (tool.type === "function") {
        const fn = (tool.function ?? {}) as Record<string, unknown>;
        anthropicTools.push({
          name: fn.name,
          description: fn.description ?? "",
          input_schema: fn.parameters ?? {}
        });
      }
    }
    return anthropicTools;
  }

  protected messagesUrl(): string {
    return `${this.baseUrl}/messages`;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
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
    // Pricing in USD per token (mirrors the Python pricing map structure).
    const pricing = [
      { prefix: "claude-fable-5", input: 10.0 / 1_000_000, output: 50.0 / 1_000_000 },
      { prefix: "claude-mythos-5", input: 10.0 / 1_000_000, output: 50.0 / 1_000_000 },
      { prefix: "claude-opus-4", input: 5.0 / 1_000_000, output: 25.0 / 1_000_000 },
      { prefix: "claude-sonnet-4", input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
      { prefix: "claude-haiku-4", input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
      { prefix: "claude-3-5-sonnet", input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
      { prefix: "claude-3-opus", input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
      { prefix: "claude-3-sonnet", input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
      { prefix: "claude-3-haiku", input: 0.25 / 1_000_000, output: 1.25 / 1_000_000 }
    ];
    const row =
      pricing.find((item) => this.model.startsWith(item.prefix)) ??
      pricing.find((item) => item.prefix === "claude-sonnet-4");
    if (!row) return undefined;
    return tokensInput * row.input + tokensOutput * row.output;
  }
}

registerComponent(AnthropicChatCompletionClient as any);

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
