import {
  AssistantMessage,
  Message,
  MultiModalMessage,
  ToolCallRequest,
  ToolMessage
} from "../messages.js";
import type { ChatCompletionChunk, ChatCompletionResult } from "../types.js";
import type { JSONSchema } from "../tools/base.js";

export interface StructuredOutputFormat {
  name: string;
  description?: string;
  schema: JSONSchema;
  strict?: boolean;
}

export abstract class BaseChatCompletionClient {
  model: string;
  apiKey?: string;
  config: Record<string, unknown>;

  constructor(init: { model: string; apiKey?: string; config?: Record<string, unknown> }) {
    this.model = init.model;
    this.apiKey = init.apiKey;
    this.config = init.config ?? {};
  }

  abstract create(
    messages: Message[],
    options?: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      [key: string]: unknown;
    }
  ): Promise<ChatCompletionResult>;

  abstract createStream(
    messages: Message[],
    options?: {
      tools?: Record<string, unknown>[];
      outputFormat?: StructuredOutputFormat;
      [key: string]: unknown;
    }
  ): AsyncGenerator<ChatCompletionChunk>;

  protected convertMessagesToApiFormat(messages: Message[]): Array<Record<string, unknown>> {
    const apiMessages: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message instanceof MultiModalMessage) {
        if (message.isText()) {
          apiMessages.push({ role: message.role, content: message.content });
          continue;
        }

        const content: Array<Record<string, unknown>> = [];
        if (message.content.trim()) {
          content.push({ type: "text", text: message.content });
        }
        if (message.isImage()) {
          if (message.data) {
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${message.mimeType};base64,${message.toBase64()}`
              }
            });
          } else if (message.mediaUrl) {
            content.push({
              type: "image_url",
              image_url: { url: message.mediaUrl }
            });
          }
        }
        apiMessages.push({ role: message.role, content });
        continue;
      }

      const apiMessage: Record<string, unknown> = {
        role: message.role,
        content: message.content
      };

      if (message instanceof AssistantMessage && message.toolCalls?.length) {
        apiMessage.tool_calls = message.toolCalls.map((call) => ({
          id: call.callId,
          type: "function",
          function: {
            name: call.toolName,
            arguments: JSON.stringify(call.parameters)
          }
        }));
      }

      if (message instanceof ToolMessage) {
        apiMessage.tool_call_id = message.toolCallId;
      }

      apiMessages.push(apiMessage);
    }
    return apiMessages;
  }

  protected parseToolCalls(toolCalls: any[] | undefined): ToolCallRequest[] {
    if (!toolCalls?.length) return [];
    const parsed: ToolCallRequest[] = [];
    for (const call of toolCalls) {
      if (call.type && call.type !== "function") continue;
      const args = call.function?.arguments;
      parsed.push(
        new ToolCallRequest({
          toolName: call.function?.name ?? "",
          parameters: typeof args === "string" && args ? safeJsonParse(args) : args ?? {},
          callId: call.id
        })
      );
    }
    return parsed;
  }
}

export class BaseChatCompletionError extends Error {
  statusCode?: number;
  responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = "BaseChatCompletionError";
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

export class RateLimitError extends BaseChatCompletionError {
  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message, statusCode, responseData);
    this.name = "RateLimitError";
  }
}

export class AuthenticationError extends BaseChatCompletionError {
  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message, statusCode, responseData);
    this.name = "AuthenticationError";
  }
}

export class InvalidRequestError extends BaseChatCompletionError {
  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message, statusCode, responseData);
    this.name = "InvalidRequestError";
  }
}

export function normalizeOutputFormat(outputFormat?: StructuredOutputFormat): Record<string, unknown> | undefined {
  if (!outputFormat) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: outputFormat.name,
      description: outputFormat.description ?? `Structured output for ${outputFormat.name}`,
      strict: outputFormat.strict ?? true,
      schema: makeSchemaCompatible(outputFormat.schema)
    }
  };
}

export function makeSchemaCompatible(schema: JSONSchema): JSONSchema {
  const copy: JSONSchema = { ...schema };
  if (copy.$defs && typeof copy.$defs === "object") {
    copy.$defs = Object.fromEntries(
      Object.entries(copy.$defs as Record<string, JSONSchema>).map(([key, value]) => [
        key,
        makeSchemaCompatible(value)
      ])
    );
  }
  if (copy.type === "object") {
    copy.additionalProperties = false;
    const properties = copy.properties ?? {};
    copy.required = Object.keys(properties);
    copy.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, makeSchemaCompatible(value)])
    );
  }
  if (copy.type === "array" && copy.items) {
    copy.items = makeSchemaCompatible(copy.items);
  }
  return copy;
}

function safeJsonParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
