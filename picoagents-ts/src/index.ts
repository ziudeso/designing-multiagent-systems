export { CancellationToken } from "./cancellation.js";

export {
  AgentContext,
  ToolApprovalRequest,
  ToolApprovalResponse
} from "./context.js";

export {
  AssistantMessage,
  BaseMessage,
  MultiModalMessage,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  UserMessage,
  messageFromObject
} from "./messages.js";
export type { BaseMessageInit, Message, MessageRole } from "./messages.js";

export {
  AgentResponse,
  AgentExecutionCompleteEvent,
  AgentExecutionStartEvent,
  AgentSelectionEvent,
  BaseEvent,
  ErrorEvent,
  FatalErrorEvent,
  MemoryRetrievalEvent,
  MemoryUpdateEvent,
  ModelCallEvent,
  ModelResponseEvent,
  ModelStreamChunkEvent,
  OrchestrationCompleteEvent,
  OrchestrationStartEvent,
  StopMessage,
  TaskCompleteEvent,
  TaskStartEvent,
  ToolApprovalEvent,
  ToolCallEvent,
  ToolCallResponseEvent,
  ToolValidationEvent,
  Usage
} from "./types.js";
export type {
  AgentEvent,
  ChatCompletionChunk,
  ChatCompletionResult,
  OrchestrationEvent,
  OrchestrationResponse
} from "./types.js";

export * from "./componentConfig.js";
export * from "./instructions.js";
export * from "./middleware.js";
export * from "./hooks.js";
export * from "./otel.js";
export * from "./compaction.js";

export * from "./agents/index.js";
export * from "./llm/index.js";
export * from "./memory/index.js";
export * from "./orchestration/index.js";
export * from "./termination/index.js";
export * from "./tools/index.js";
export * from "./workflow/index.js";
export * from "./eval/index.js";
export * from "./store/index.js";
export * from "./webui/index.js";

// Disambiguate names that exist in more than one module (the barrel is flat).
// `CompactionStrategy` is the canonical interface from ./compaction.js (the agents
// module re-exports a structurally-compatible alias). `CompositeTermination` resolves
// to the agent-termination class; the hooks variant remains reachable as the return
// value of `MaxRestartsTermination.or()/.and()`.
export type { CompactionStrategy } from "./compaction.js";
export { CompositeTermination } from "./termination/index.js";

export const version = "0.1.0";
