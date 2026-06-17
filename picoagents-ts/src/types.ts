import type { AgentContext, ToolApprovalRequest } from "./context.js";
import type { Message } from "./messages.js";
import type { ToolResult } from "./tools/base.js";

export class Usage {
  durationMs: number;
  llmCalls: number;
  tokensInput: number;
  tokensOutput: number;
  toolCalls: number;
  memoryOperations: number;
  costEstimate?: number;

  constructor(init: Partial<Usage> = {}) {
    this.durationMs = init.durationMs ?? 0;
    this.llmCalls = init.llmCalls ?? 0;
    this.tokensInput = init.tokensInput ?? 0;
    this.tokensOutput = init.tokensOutput ?? 0;
    this.toolCalls = init.toolCalls ?? 0;
    this.memoryOperations = init.memoryOperations ?? 0;
    this.costEstimate = init.costEstimate;
  }

  add(other: Usage): Usage {
    const cost =
      this.costEstimate === undefined && other.costEstimate === undefined
        ? undefined
        : (this.costEstimate ?? 0) + (other.costEstimate ?? 0);
    return collapseZeroUsage(new Usage({
      durationMs: Math.max(this.durationMs, other.durationMs),
      llmCalls: this.llmCalls + other.llmCalls,
      tokensInput: this.tokensInput + other.tokensInput,
      tokensOutput: this.tokensOutput + other.tokensOutput,
      toolCalls: this.toolCalls + other.toolCalls,
      memoryOperations: this.memoryOperations + other.memoryOperations,
      costEstimate: cost
    }));
  }
}

function collapseZeroUsage(usage: Usage): Usage {
  for (const key of [
    "llmCalls",
    "tokensInput",
    "tokensOutput",
    "toolCalls",
    "memoryOperations"
  ] as const) {
    if (usage[key] === 0) {
      (usage as unknown as Record<typeof key, number | undefined>)[key] = undefined;
    }
  }
  if (usage.costEstimate === 0) usage.costEstimate = undefined;
  return usage;
}

export interface AgentResponseInit {
  context?: AgentContext;
  source: string;
  usage: Usage;
  finishReason: string;
  timestamp?: Date | string;
}

export class AgentResponse {
  context?: AgentContext;
  source: string;
  usage: Usage;
  timestamp: Date;
  finishReason: string;

  constructor(init: AgentResponseInit) {
    this.context = init.context;
    this.source = init.source;
    this.usage = init.usage;
    this.timestamp = init.timestamp ? new Date(init.timestamp) : new Date();
    this.finishReason = init.finishReason;
  }

  get messages(): Message[] {
    return this.context?.messages ?? [];
  }

  get needsApproval(): boolean {
    return this.context?.waitingForApproval ?? false;
  }

  get approvalRequests(): ToolApprovalRequest[] {
    return this.context?.pendingApprovalRequests ?? [];
  }

  get finalContent(): string {
    const last = this.messages.at(-1);
    if (!last) return "No messages";
    return last.content.length > 50 ? `${last.content.slice(0, 50)}...` : last.content;
  }
}

export interface ChatCompletionResult {
  message: import("./messages.js").AssistantMessage;
  usage: Usage;
  model: string;
  finishReason: string;
  structuredOutput?: unknown;
}

export interface ChatCompletionChunk {
  content: string;
  isComplete: boolean;
  toolCallChunk?: Record<string, unknown>;
  usage?: Usage;
}

export class BaseEvent {
  timestamp: Date;
  source: string;
  eventType: string;

  constructor(init: { source: string; eventType: string; timestamp?: Date | string }) {
    this.timestamp = init.timestamp ? new Date(init.timestamp) : new Date();
    this.source = init.source;
    this.eventType = init.eventType;
  }
}

export class TaskStartEvent extends BaseEvent {
  task: string;
  constructor(init: { source: string; task: string }) {
    super({ source: init.source, eventType: "task_start" });
    this.task = init.task;
  }
}

export class TaskCompleteEvent extends BaseEvent {
  result: string;
  constructor(init: { source: string; result: string }) {
    super({ source: init.source, eventType: "task_complete" });
    this.result = init.result;
  }
}

export class ModelCallEvent extends BaseEvent {
  inputMessages: Message[];
  model: string;
  constructor(init: { source: string; inputMessages: Message[]; model: string }) {
    super({ source: init.source, eventType: "model_call" });
    this.inputMessages = init.inputMessages;
    this.model = init.model;
  }
}

export class ModelResponseEvent extends BaseEvent {
  response: string;
  hasToolCalls: boolean;
  constructor(init: { source: string; response: string; hasToolCalls?: boolean }) {
    super({ source: init.source, eventType: "model_response" });
    this.response = init.response;
    this.hasToolCalls = init.hasToolCalls ?? false;
  }
}

export class ModelStreamChunkEvent extends BaseEvent {
  chunk: string;
  isFinal: boolean;
  constructor(init: { source: string; chunk: string; isFinal?: boolean }) {
    super({ source: init.source, eventType: "model_stream_chunk" });
    this.chunk = init.chunk;
    this.isFinal = init.isFinal ?? false;
  }
}

export class ToolCallEvent extends BaseEvent {
  toolName: string;
  parameters: Record<string, unknown>;
  callId: string;
  constructor(init: { source: string; toolName: string; parameters: Record<string, unknown>; callId: string }) {
    super({ source: init.source, eventType: "tool_call" });
    this.toolName = init.toolName;
    this.parameters = init.parameters;
    this.callId = init.callId;
  }
}

export class ToolCallResponseEvent extends BaseEvent {
  callId: string;
  result?: ToolResult;
  constructor(init: { source: string; callId: string; result?: ToolResult }) {
    super({ source: init.source, eventType: "tool_call_response" });
    this.callId = init.callId;
    this.result = init.result;
  }
}

export class ToolApprovalEvent extends BaseEvent {
  approvalRequest: ToolApprovalRequest;
  constructor(init: { source: string; approvalRequest: ToolApprovalRequest }) {
    super({ source: init.source, eventType: "tool_approval" });
    this.approvalRequest = init.approvalRequest;
  }
}

export class ToolValidationEvent extends BaseEvent {
  toolName: string;
  isValid: boolean;
  errors?: string[];
  constructor(init: { source: string; toolName: string; isValid: boolean; errors?: string[] }) {
    super({ source: init.source, eventType: "tool_validation" });
    this.toolName = init.toolName;
    this.isValid = init.isValid;
    this.errors = init.errors;
  }
}

export class MemoryUpdateEvent extends BaseEvent {
  operation: string;
  contentSummary: string;
  constructor(init: { source: string; operation: string; contentSummary: string }) {
    super({ source: init.source, eventType: "memory_update" });
    this.operation = init.operation;
    this.contentSummary = init.contentSummary;
  }
}

export class MemoryRetrievalEvent extends BaseEvent {
  query: string;
  resultsCount: number;
  constructor(init: { source: string; query: string; resultsCount: number }) {
    super({ source: init.source, eventType: "memory_retrieval" });
    this.query = init.query;
    this.resultsCount = init.resultsCount;
  }
}

export class ErrorEvent extends BaseEvent {
  errorMessage: string;
  errorType: string;
  isRecoverable: boolean;
  constructor(init: { source: string; errorMessage: string; errorType: string; isRecoverable?: boolean }) {
    super({ source: init.source, eventType: "error" });
    this.errorMessage = init.errorMessage;
    this.errorType = init.errorType;
    this.isRecoverable = init.isRecoverable ?? true;
  }
}

export class FatalErrorEvent extends BaseEvent {
  errorMessage: string;
  errorType: string;
  isRecoverable = false;
  constructor(init: { source: string; errorMessage: string; errorType: string }) {
    super({ source: init.source, eventType: "fatal_error" });
    this.errorMessage = init.errorMessage;
    this.errorType = init.errorType;
  }
}

export type AgentEvent =
  | TaskStartEvent
  | TaskCompleteEvent
  | ModelCallEvent
  | ModelResponseEvent
  | ModelStreamChunkEvent
  | ToolCallEvent
  | ToolCallResponseEvent
  | ToolApprovalEvent
  | ToolValidationEvent
  | MemoryUpdateEvent
  | MemoryRetrievalEvent
  | ErrorEvent
  | FatalErrorEvent;

export class StopMessage {
  content: string;
  source: string;
  metadata: Record<string, unknown>;

  constructor(init: { content: string; source: string; metadata?: Record<string, unknown> }) {
    this.content = init.content;
    this.source = init.source;
    this.metadata = init.metadata ?? {};
  }
}

export interface OrchestrationResponse {
  messages: Message[];
  finalResult: string;
  usage: Usage;
  stopMessage: StopMessage;
  patternMetadata: Record<string, unknown>;
}

export class OrchestrationStartEvent extends BaseEvent {
  task: string;
  pattern: string;
  constructor(init: { source: string; task: string; pattern: string }) {
    super({ source: init.source, eventType: "orchestration_start" });
    this.task = init.task;
    this.pattern = init.pattern;
  }
}

export class OrchestrationCompleteEvent extends BaseEvent {
  result: string;
  stopReason: string;
  constructor(init: { source: string; result: string; stopReason: string }) {
    super({ source: init.source, eventType: "orchestration_complete" });
    this.result = init.result;
    this.stopReason = init.stopReason;
  }
}

export class AgentSelectionEvent extends BaseEvent {
  selectedAgent: string;
  selectionReason?: string;
  constructor(init: { source: string; selectedAgent: string; selectionReason?: string }) {
    super({ source: init.source, eventType: "agent_selection" });
    this.selectedAgent = init.selectedAgent;
    this.selectionReason = init.selectionReason;
  }
}

export class AgentExecutionStartEvent extends BaseEvent {
  executingAgent: string;
  contextSize: number;
  constructor(init: { source: string; executingAgent: string; contextSize: number }) {
    super({ source: init.source, eventType: "agent_execution_start" });
    this.executingAgent = init.executingAgent;
    this.contextSize = init.contextSize;
  }
}

export class AgentExecutionCompleteEvent extends BaseEvent {
  executingAgent: string;
  success: boolean;
  messageCount: number;
  constructor(init: { source: string; executingAgent: string; success: boolean; messageCount: number }) {
    super({ source: init.source, eventType: "agent_execution_complete" });
    this.executingAgent = init.executingAgent;
    this.success = init.success;
    this.messageCount = init.messageCount;
  }
}

export type OrchestrationEvent =
  | OrchestrationStartEvent
  | OrchestrationCompleteEvent
  | AgentSelectionEvent
  | AgentExecutionStartEvent
  | AgentExecutionCompleteEvent;
