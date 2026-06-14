import { AgentContext } from "../context.js";
import { CancellationToken } from "../cancellation.js";
import { CompactionLike } from "../compaction.js";
import { BaseEndHook, BaseStartHook } from "../hooks.js";
import { BaseChatCompletionClient, StructuredOutputFormat } from "../llm/index.js";
import { BaseMemory } from "../memory/index.js";
import { BaseMiddleware, MiddlewareChain } from "../middleware.js";
import {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  UserMessage
} from "../messages.js";
import { BaseTool, FunctionTool, ToolFunction } from "../tools/index.js";
import type { AgentEvent, AgentResponse, ChatCompletionChunk } from "../types.js";
import { AgentAsTool, AgentAsToolOptions } from "./agentAsTool.js";

export type TaskInput = string | UserMessage | Message[];

/**
 * A compaction strategy accepted by the agent loop: either a plain function or
 * an object exposing a `.compact()` method. Normalized internally via
 * {@link normalizeCompaction}.
 */
export type CompactionStrategy = CompactionLike;

export interface BaseAgentOptions {
  name: string;
  instructions: string;
  modelClient: BaseChatCompletionClient;
  description?: string;
  tools?: Array<BaseTool | ToolFunction>;
  memory?: BaseMemory;
  context?: AgentContext;
  maxIterations?: number;
  outputFormat?: StructuredOutputFormat;
  summarizeToolResult?: boolean;
  requiredTools?: string[];
  exampleTasks?: string[];
  compaction?: CompactionStrategy;
  middlewares?: BaseMiddleware[];
  startHooks?: BaseStartHook[];
  endHooks?: BaseEndHook[];
}

export abstract class BaseAgent {
  name: string;
  description: string;
  instructions: string;
  modelClient: BaseChatCompletionClient;
  tools: BaseTool[];
  memory?: BaseMemory;
  context: AgentContext;
  maxIterations: number;
  outputFormat?: StructuredOutputFormat;
  summarizeToolResult: boolean;
  requiredTools: string[];
  exampleTasks: string[];
  compaction?: CompactionStrategy;
  middlewareChain: MiddlewareChain;
  startHooks: BaseStartHook[];
  endHooks: BaseEndHook[];

  constructor(options: BaseAgentOptions) {
    this.name = options.name;
    this.description = options.description ?? "";
    this.instructions = options.instructions;
    this.modelClient = options.modelClient;
    this.tools = this.processTools(options.tools ?? []);
    this.memory = options.memory;
    this.context = options.context ?? new AgentContext();
    this.maxIterations = options.maxIterations ?? 10;
    this.outputFormat = options.outputFormat;
    this.summarizeToolResult = options.summarizeToolResult ?? true;
    this.requiredTools = options.requiredTools ?? [];
    this.exampleTasks = options.exampleTasks ?? [];
    this.compaction = options.compaction;
    this.middlewareChain = new MiddlewareChain(options.middlewares ?? []);
    this.startHooks = options.startHooks ?? [];
    this.endHooks = options.endHooks ?? [];
    this.validateConfiguration();
  }

  abstract run(
    task?: TaskInput,
    options?: { context?: AgentContext; cancellationToken?: CancellationToken; persist?: boolean }
  ): Promise<AgentResponse>;

  abstract runStream(
    task?: TaskInput,
    options?: {
      context?: AgentContext;
      cancellationToken?: CancellationToken;
      verbose?: boolean;
      streamTokens?: boolean;
    }
  ): AsyncGenerator<Message | AgentEvent | AgentResponse | ChatCompletionChunk>;

  reset(): void {
    this.context.reset();
  }

  getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      type: this.constructor.name,
      model: this.modelClient.model,
      toolsCount: this.tools.length,
      hasMemory: Boolean(this.memory),
      hasMiddlewares: this.middlewareChain.middlewares.length > 0,
      messageHistoryLength: this.context.messageCount
    };
  }

  /**
   * Get current conversation data for application-managed memory storage.
   *
   * Returns a summary of the agent's conversation context that applications can
   * use to decide what to persist.
   */
  getConversationData(): Record<string, unknown> {
    const userMessages = this.context.messages.filter(
      (msg): msg is UserMessage => msg instanceof UserMessage
    );
    const assistantMessages = this.context.messages.filter(
      (msg): msg is AssistantMessage => msg instanceof AssistantMessage
    );
    const toolMessages = this.context.messages.filter(
      (msg): msg is ToolMessage => msg instanceof ToolMessage
    );

    return {
      agentName: this.name,
      totalMessages: this.context.messageCount,
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      toolMessages: toolMessages.length,
      toolsUsed: [...new Set(toolMessages.filter((msg) => msg.success).map((msg) => msg.toolName))],
      lastUserMessage: userMessages.length ? userMessages[userMessages.length - 1]!.content : null,
      lastAssistantMessage: assistantMessages.length
        ? assistantMessages[assistantMessages.length - 1]!.content
        : null,
      sessionId: this.context.sessionId,
      metadata: this.context.metadata,
      conversationHistory: this.context.messages.map((msg) => ({
        type: msg.constructor.name,
        content: msg.content.length > 200 ? `${msg.content.slice(0, 200)}...` : msg.content,
        timestamp: msg.timestamp
      }))
    };
  }

  /**
   * Convert this agent into a tool that other agents can use, enabling
   * hierarchical composition.
   */
  asTool(options: AgentAsToolOptions = {}): AgentAsTool {
    return new AgentAsTool(this, options);
  }

  protected validateConfiguration(): void {
    if (!this.name || typeof this.name !== "string") {
      throw new AgentConfigurationError("Agent name must be a non-empty string");
    }
    if (!this.instructions) {
      throw new AgentConfigurationError("Agent instructions cannot be empty", this.name);
    }
    if (!this.modelClient) {
      throw new AgentConfigurationError("Model client is required", this.name);
    }
  }

  protected processTools(tools: Array<BaseTool | ToolFunction>): BaseTool[] {
    return tools.map((tool) => {
      if (tool instanceof BaseTool) return tool;
      if (typeof tool === "function") return new FunctionTool(tool);
      throw new AgentConfigurationError(`Invalid tool type: ${typeof tool}`, this.name);
    });
  }

  protected findTool(name: string): BaseTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  protected getToolsForLLM(): Record<string, unknown>[] {
    return this.tools.map((tool) => tool.toLLMFormat());
  }

  protected convertTaskToMessages(task: TaskInput): Message[] {
    if (typeof task === "string") {
      return [new UserMessage({ content: task, source: "user" })];
    }
    if (task instanceof UserMessage) return [task];
    if (Array.isArray(task)) return task;
    throw new AgentExecutionError(`Unsupported task type: ${typeof task}`, this.name);
  }

  protected async prepareLLMMessages(taskMessages: Message[], context?: AgentContext): Promise<Message[]> {
    const workingContext = context ?? this.context;
    let systemContent = this.instructions;

    if (this.requiredTools.length > 0) {
      systemContent += `\n\nIMPORTANT: You MUST use these tools in your response: ${this.requiredTools.join(", ")}. Do not respond without calling these tools.`;
    }

    if (this.memory) {
      try {
        const memoryResult = await this.memory.getContext(5);
        const contextItems = memoryResult.results.map((item) =>
          typeof item.content === "string" ? item.content : JSON.stringify(item.content)
        );
        if (contextItems.length) {
          systemContent += `\n\nRelevant context from memory:\n${contextItems.join("\n")}`;
        }
      } catch {
        // Memory should not break the agent loop.
      }
    }

    for (const tool of this.tools) {
      const dynamicTool = tool as BaseTool & { getSystemPromptSection?: () => string };
      if (typeof dynamicTool.getSystemPromptSection === "function") {
        try {
          const section = dynamicTool.getSystemPromptSection();
          if (section) systemContent += section;
        } catch {
          // Ignore dynamic prompt errors.
        }
      }
    }

    return [
      new SystemMessage({ content: systemContent, source: "system" }),
      ...workingContext.messages,
      ...taskMessages
    ];
  }
}

export class AgentError extends Error {
  agentName?: string;

  constructor(message: string, agentName?: string) {
    super(agentName ? `Agent '${agentName}': ${message}` : message);
    this.name = "AgentError";
    this.agentName = agentName;
  }
}

export class AgentExecutionError extends AgentError {
  constructor(message: string, agentName?: string) {
    super(message, agentName);
    this.name = "AgentExecutionError";
  }
}

export class AgentConfigurationError extends AgentError {
  constructor(message: string, agentName?: string) {
    super(message, agentName);
    this.name = "AgentConfigurationError";
  }
}

export class AgentToolError extends AgentError {
  constructor(message: string, agentName?: string) {
    super(message, agentName);
    this.name = "AgentToolError";
  }
}

export class AgentMemoryError extends AgentError {
  constructor(message: string, agentName?: string) {
    super(message, agentName);
    this.name = "AgentMemoryError";
  }
}

export class AgentTimeoutError extends AgentError {
  constructor(message: string, agentName?: string) {
    super(message, agentName);
    this.name = "AgentTimeoutError";
  }
}
