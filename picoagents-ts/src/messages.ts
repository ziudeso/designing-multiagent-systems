export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface BaseMessageInit {
  content: string;
  source: string;
  timestamp?: Date | string;
}

export abstract class BaseMessage {
  content: string;
  source: string;
  timestamp: Date;
  abstract role: MessageRole;

  protected constructor(init: BaseMessageInit) {
    this.content = init.content;
    this.source = init.source;
    this.timestamp = init.timestamp ? new Date(init.timestamp) : new Date();
  }

  toString(): string {
    const time = this.timestamp.toTimeString().slice(0, 8);
    return `[${this.source}] ${time} | ${this.content}`;
  }
}

export class SystemMessage extends BaseMessage {
  role: "system" = "system";

  constructor(init: BaseMessageInit) {
    super(init);
  }
}

export interface UserMessageInit extends BaseMessageInit {
  name?: string;
}

export class UserMessage extends BaseMessage {
  role: "user" = "user";
  name?: string;

  constructor(init: UserMessageInit) {
    super(init);
    this.name = init.name;
  }
}

export interface ToolCallRequestInit {
  toolName: string;
  parameters: Record<string, unknown>;
  callId: string;
}

export class ToolCallRequest {
  toolName: string;
  parameters: Record<string, unknown>;
  callId: string;

  constructor(init: ToolCallRequestInit) {
    this.toolName = init.toolName;
    this.parameters = init.parameters;
    this.callId = init.callId;
  }
}

export interface AssistantMessageInit extends BaseMessageInit {
  toolCalls?: ToolCallRequest[];
  structuredContent?: unknown;
  usage?: import("./types.js").Usage;
}

export class AssistantMessage extends BaseMessage {
  role: "assistant" = "assistant";
  toolCalls?: ToolCallRequest[];
  structuredContent?: unknown;
  usage?: import("./types.js").Usage;

  constructor(init: AssistantMessageInit) {
    super(init);
    this.toolCalls = init.toolCalls;
    this.structuredContent = init.structuredContent;
    this.usage = init.usage;
  }

  override toString(): string {
    const time = this.timestamp.toTimeString().slice(0, 8);
    if (this.toolCalls?.length) {
      const tools = this.toolCalls
        .map((call) => `${call.toolName}(${Object.entries(call.parameters).map(([key, value]) => `${key}=${String(value)}`).join(", ")})`)
        .join(", ");
      return this.content.trim()
        ? `[${this.source}] ${time} | ${this.content} [tools: ${tools}]`
        : `[${this.source}] ${time} | [calling tools: ${tools}]`;
    }
    return `[${this.source}] ${time} | ${this.content}`;
  }
}

export interface ToolMessageInit extends BaseMessageInit {
  toolCallId: string;
  toolName: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class ToolMessage extends BaseMessage {
  role: "tool" = "tool";
  toolCallId: string;
  toolName: string;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;

  constructor(init: ToolMessageInit) {
    super(init);
    this.toolCallId = init.toolCallId;
    this.toolName = init.toolName;
    this.success = init.success;
    this.error = init.error;
    this.metadata = init.metadata ?? {};
  }
}

export interface MultiModalMessageInit extends BaseMessageInit {
  role: "user" | "assistant";
  mimeType: string;
  data?: Uint8Array | string;
  mediaUrl?: string;
  metadata?: Record<string, unknown>;
}

export class MultiModalMessage extends BaseMessage {
  role: "user" | "assistant";
  mimeType: string;
  data?: Uint8Array | string;
  mediaUrl?: string;
  metadata: Record<string, unknown>;

  constructor(init: MultiModalMessageInit) {
    super(init);
    if (!init.data && !init.mediaUrl) {
      throw new Error("Either data or mediaUrl must be provided");
    }
    if (init.data && init.mediaUrl) {
      throw new Error("Only one of data or mediaUrl should be provided");
    }
    this.role = init.role;
    this.mimeType = init.mimeType;
    this.data = init.data;
    this.mediaUrl = init.mediaUrl;
    this.metadata = init.metadata ?? {};
  }

  isText(): boolean {
    return this.mimeType.startsWith("text/");
  }

  isImage(): boolean {
    return this.mimeType.startsWith("image/");
  }

  isAudio(): boolean {
    return this.mimeType.startsWith("audio/");
  }

  isVideo(): boolean {
    return this.mimeType.startsWith("video/");
  }

  toBase64(): string | undefined {
    if (!this.data) return undefined;
    if (typeof this.data === "string") return this.data;
    return Buffer.from(this.data).toString("base64");
  }
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | MultiModalMessage;

export function messageFromObject(value: any): Message {
  if (value instanceof SystemMessage || value instanceof UserMessage || value instanceof AssistantMessage || value instanceof ToolMessage || value instanceof MultiModalMessage) {
    return value;
  }

  switch (value?.role) {
    case "system":
      return new SystemMessage(value);
    case "user":
      if (value.mimeType || value.mime_type) {
        return new MultiModalMessage({
          content: value.content,
          source: value.source,
          timestamp: value.timestamp,
          role: "user",
          mimeType: value.mimeType ?? value.mime_type,
          data: value.data,
          mediaUrl: value.mediaUrl ?? value.media_url,
          metadata: value.metadata
        });
      }
      return new UserMessage(value);
    case "assistant":
      if (value.mimeType || value.mime_type) {
        return new MultiModalMessage({
          content: value.content,
          source: value.source,
          timestamp: value.timestamp,
          role: "assistant",
          mimeType: value.mimeType ?? value.mime_type,
          data: value.data,
          mediaUrl: value.mediaUrl ?? value.media_url,
          metadata: value.metadata
        });
      }
      return new AssistantMessage({
        content: value.content,
        source: value.source,
        timestamp: value.timestamp,
        toolCalls: (value.toolCalls ?? value.tool_calls)?.map((call: any) => new ToolCallRequest({
          toolName: call.toolName ?? call.tool_name,
          parameters: call.parameters ?? {},
          callId: call.callId ?? call.call_id
        })),
        structuredContent: value.structuredContent ?? value.structured_content,
        usage: value.usage
      });
    case "tool":
      return new ToolMessage({
        content: value.content,
        source: value.source,
        timestamp: value.timestamp,
        toolCallId: value.toolCallId ?? value.tool_call_id,
        toolName: value.toolName ?? value.tool_name,
        success: value.success,
        error: value.error,
        metadata: value.metadata
      });
    default:
      throw new Error(`Unsupported message object: ${JSON.stringify(value)}`);
  }
}
