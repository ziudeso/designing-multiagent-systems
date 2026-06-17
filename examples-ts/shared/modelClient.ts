import {
  AssistantMessage,
  BaseChatCompletionClient,
  OpenAIChatCompletionClient,
  ToolCallRequest,
  Usage
} from "picoagents-ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResult,
  Message,
  StructuredOutputFormat
} from "picoagents-ts";

export type StaticResponse =
  | string
  | AssistantMessage
  | ChatCompletionResult
  | StaticObjectResponse;

interface StaticObjectResponse {
  content?: string;
  toolCalls?: ToolCallRequest[];
  structuredOutput?: unknown;
  finishReason?: string;
  model?: string;
  usage?: Partial<Usage>;
}

export class StaticChatCompletionClient extends BaseChatCompletionClient {
  private responses: StaticResponse[];
  private fallbackResponse: StaticResponse;
  readonly receivedMessages: Message[][] = [];

  constructor(options: {
    model?: string;
    responses?: StaticResponse[];
    fallbackResponse?: StaticResponse;
  } = {}) {
    super({ model: options.model ?? "static-example-model" });
    this.responses = [...(options.responses ?? ["Done."])];
    this.fallbackResponse = options.fallbackResponse ?? "Done.";
  }

  setResponses(responses: StaticResponse[]): void {
    this.responses = [...responses];
  }

  async create(
    messages: Message[],
    _options: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      [key: string]: unknown;
    } = {}
  ): Promise<ChatCompletionResult> {
    this.receivedMessages.push(messages);
    const next = this.responses.length ? this.responses.shift()! : this.fallbackResponse;
    return normalizeResponse(next, this.model);
  }

  async *createStream(
    messages: Message[],
    options: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      [key: string]: unknown;
    } = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    const result = await this.create(messages, options);
    if (result.message.toolCalls?.length) {
      for (const call of result.message.toolCalls) {
        yield {
          content: "",
          isComplete: false,
          toolCallChunk: {
            id: call.callId,
            function: {
              name: call.toolName,
              arguments: JSON.stringify(call.parameters)
            }
          }
        };
      }
    } else if (result.message.content) {
      yield { content: result.message.content, isComplete: false };
    }
    yield { content: "", isComplete: true, usage: result.usage };
  }
}

export function createExampleModelClient(
  responses: StaticResponse[] = ["Done."],
  options: {
    model?: string;
    fallbackResponse?: StaticResponse;
  } = {}
): BaseChatCompletionClient {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const useLiveModel =
    process.env.PICOAGENTS_EXAMPLES_LIVE === "1" && Boolean(process.env.OPENAI_API_KEY);

  if (useLiveModel) {
    return new OpenAIChatCompletionClient({ model });
  }

  return new StaticChatCompletionClient({
    model: "static-example-model",
    responses,
    fallbackResponse: options.fallbackResponse
  });
}

export function toolCall(
  toolName: string,
  parameters: Record<string, unknown>,
  callId = `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`
): ToolCallRequest {
  return new ToolCallRequest({ toolName, parameters, callId });
}

function normalizeResponse(response: StaticResponse, defaultModel: string): ChatCompletionResult {
  if (typeof response === "string") {
    return {
      message: new AssistantMessage({ content: response, source: "llm" }),
      usage: new Usage({ durationMs: 1, llmCalls: 1, tokensInput: 10, tokensOutput: 10 }),
      model: defaultModel,
      finishReason: "stop"
    };
  }

  if (response instanceof AssistantMessage) {
    return {
      message: response,
      usage: new Usage({
        durationMs: 1,
        llmCalls: 1,
        tokensInput: 10,
        tokensOutput: 10,
        toolCalls: response.toolCalls?.length ?? 0
      }),
      model: defaultModel,
      finishReason: response.toolCalls?.length ? "tool_calls" : "stop"
    };
  }

  if (isChatCompletionResult(response)) {
    return response;
  }

  const objectResponse = response as StaticObjectResponse;
  const message = new AssistantMessage({
    content: objectResponse.content ?? "",
    source: "llm",
    toolCalls: objectResponse.toolCalls
  });

  return {
    message,
    structuredOutput: objectResponse.structuredOutput,
    usage: new Usage({
      durationMs: 1,
      llmCalls: 1,
      tokensInput: 10,
      tokensOutput: 10,
      toolCalls: objectResponse.toolCalls?.length ?? 0,
      ...objectResponse.usage
    }),
    model: objectResponse.model ?? defaultModel,
    finishReason: objectResponse.finishReason ?? (objectResponse.toolCalls?.length ? "tool_calls" : "stop")
  };
}

function isChatCompletionResult(value: unknown): value is ChatCompletionResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "message" in value &&
      (value as { message?: unknown }).message instanceof AssistantMessage &&
      "usage" in value &&
      "finishReason" in value
  );
}
