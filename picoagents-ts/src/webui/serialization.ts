import { AgentContext, ToolApprovalResponse } from "../context.js";
import { messageFromObject, Message } from "../messages.js";
import { AgentResponse, Usage } from "../types.js";
import type { WebUIStreamEvent } from "./models.js";

export function parseMessages(values: unknown[] | undefined): Message[] {
  return (values ?? []).map((value) => messageFromObject(value));
}

export function parseApprovalResponses(values: unknown[] | undefined): ToolApprovalResponse[] {
  return (values ?? []).map((value: any) =>
    new ToolApprovalResponse({
      requestId: value.requestId ?? value.request_id,
      toolCallId: value.toolCallId ?? value.tool_call_id,
      approved: Boolean(value.approved),
      reason: value.reason
    })
  );
}

export function serializeEvent(event: unknown): unknown {
  if (event instanceof AgentResponse) {
    return {
      messages: event.context?.messages.map(serializeValue) ?? [],
      usage: serializeUsage(event.usage),
      source: event.source,
      finishReason: event.finishReason,
      finish_reason: event.finishReason,
      timestamp: event.timestamp.toISOString()
    };
  }
  return serializeValue(event);
}

export function wrapStreamEvent(sessionId: string, event: unknown): WebUIStreamEvent {
  return {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    event: serializeEvent(event)
  };
}

export function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function serializeContext(context: AgentContext): Record<string, unknown> {
  return {
    messages: context.messages.map(serializeValue),
    metadata: serializeValue(context.metadata),
    shared_state: serializeValue(context.sharedState),
    environment: serializeValue(context.environment),
    session_id: context.sessionId,
    created_at: context.createdAt.toISOString(),
    pending_approval_requests: context.pendingApprovalRequests.map(serializeValue),
    approval_responses: serializeValue(context.approvalResponses),
    pending_tool_calls: serializeValue(context.pendingToolCalls)
  };
}

export function deserializeContext(value: any): AgentContext {
  const approvalResponses: Record<string, ToolApprovalResponse> = {};
  for (const [key, response] of Object.entries(value.approvalResponses ?? {})) {
    approvalResponses[key] = new ToolApprovalResponse({
      requestId: (response as any).requestId ?? (response as any).request_id,
      toolCallId: (response as any).toolCallId ?? (response as any).tool_call_id,
      approved: Boolean((response as any).approved),
      reason: (response as any).reason
    });
  }

  return new AgentContext({
    messages: parseMessages(value.messages ?? []),
    metadata: value.metadata ?? {},
    sharedState: value.sharedState ?? value.shared_state ?? {},
    environment: value.environment ?? {},
    sessionId: value.sessionId ?? value.session_id,
    createdAt: value.createdAt ?? value.created_at,
    approvalResponses
  });
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Usage) return serializeUsage(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = serializeValue(item);
    }
    return output;
  }
  return value;
}

function serializeUsage(usage: Usage): Record<string, unknown> {
  return {
    durationMs: usage.durationMs,
    duration_ms: usage.durationMs,
    llmCalls: usage.llmCalls,
    llm_calls: usage.llmCalls,
    tokensInput: usage.tokensInput,
    tokens_input: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    tokens_output: usage.tokensOutput,
    toolCalls: usage.toolCalls,
    tool_calls: usage.toolCalls,
    memoryOperations: usage.memoryOperations,
    memory_operations: usage.memoryOperations,
    costEstimate: usage.costEstimate,
    cost_estimate: usage.costEstimate
  };
}
