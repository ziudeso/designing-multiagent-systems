import {
  AssistantMessage,
  Message,
  ToolCallRequest,
  UserMessage
} from "./messages.js";

export interface ToolApprovalResponseInit {
  requestId: string;
  toolCallId: string;
  approved: boolean;
  reason?: string;
}

export class ToolApprovalResponse {
  requestId: string;
  toolCallId: string;
  approved: boolean;
  reason?: string;

  constructor(init: ToolApprovalResponseInit) {
    this.requestId = init.requestId;
    this.toolCallId = init.toolCallId;
    this.approved = init.approved;
    this.reason = init.reason;
  }
}

export interface ToolApprovalRequestInit {
  requestId: string;
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  originalToolCall: ToolCallRequest;
}

export class ToolApprovalRequest {
  requestId: string;
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  originalToolCall: ToolCallRequest;

  constructor(init: ToolApprovalRequestInit) {
    this.requestId = init.requestId;
    this.toolCallId = init.toolCallId;
    this.toolName = init.toolName;
    this.parameters = init.parameters;
    this.originalToolCall = init.originalToolCall;
  }

  createResponse(approved: boolean, reason?: string): ToolApprovalResponse {
    return new ToolApprovalResponse({
      requestId: this.requestId,
      toolCallId: this.toolCallId,
      approved,
      reason
    });
  }
}

export interface AgentContextInit {
  messages?: Message[];
  metadata?: Record<string, unknown>;
  sharedState?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  sessionId?: string;
  createdAt?: Date | string;
  pendingApprovalRequests?: ToolApprovalRequest[];
  approvalResponses?: Record<string, ToolApprovalResponse>;
  pendingToolCalls?: Record<string, ToolCallRequest>;
}

export class AgentContext {
  messages: Message[];
  metadata: Record<string, unknown>;
  sharedState: Record<string, unknown>;
  environment: Record<string, unknown>;
  sessionId?: string;
  createdAt: Date;
  pendingApprovalRequests: ToolApprovalRequest[];
  approvalResponses: Record<string, ToolApprovalResponse>;
  pendingToolCalls: Record<string, ToolCallRequest>;

  constructor(init: AgentContextInit = {}) {
    this.messages = init.messages ? [...init.messages] : [];
    this.metadata = { ...(init.metadata ?? {}) };
    this.sharedState = { ...(init.sharedState ?? {}) };
    this.environment = { ...(init.environment ?? {}) };
    this.sessionId = init.sessionId;
    this.createdAt = init.createdAt ? new Date(init.createdAt) : new Date();
    this.pendingApprovalRequests = init.pendingApprovalRequests
      ? [...init.pendingApprovalRequests]
      : [];
    this.approvalResponses = { ...(init.approvalResponses ?? {}) };
    this.pendingToolCalls = { ...(init.pendingToolCalls ?? {}) };
  }

  static fromMessages(messages: Message[]): AgentContext {
    return new AgentContext({ messages });
  }

  clone(): AgentContext {
    return new AgentContext({
      messages: [...this.messages],
      metadata: structuredCloneSafe(this.metadata),
      sharedState: structuredCloneSafe(this.sharedState),
      environment: structuredCloneSafe(this.environment),
      sessionId: this.sessionId,
      createdAt: new Date(this.createdAt),
      pendingApprovalRequests: [...this.pendingApprovalRequests],
      approvalResponses: { ...this.approvalResponses },
      pendingToolCalls: { ...this.pendingToolCalls }
    });
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  getLastUserMessage(): UserMessage | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message instanceof UserMessage) return message;
    }
    return undefined;
  }

  getLastAssistantMessage(): AssistantMessage | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message instanceof AssistantMessage) return message;
    }
    return undefined;
  }

  clearMessages(): void {
    this.messages = [];
  }

  reset(): void {
    this.messages = [];
    this.sharedState = {};
    this.metadata = {};
  }

  get messageCount(): number {
    return this.messages.length;
  }

  get isEmpty(): boolean {
    return this.messages.length === 0;
  }

  get waitingForApproval(): boolean {
    return this.pendingApprovalRequests.length > 0;
  }

  addApprovalRequest(toolCall: ToolCallRequest, toolName: string): ToolApprovalRequest {
    const request = new ToolApprovalRequest({
      requestId: `approval_${toolCall.callId}`,
      toolCallId: toolCall.callId,
      toolName,
      parameters: toolCall.parameters,
      originalToolCall: toolCall
    });
    this.pendingApprovalRequests.push(request);
    this.pendingToolCalls[toolCall.callId] = toolCall;
    return request;
  }

  addApprovalResponse(response: ToolApprovalResponse): void {
    this.approvalResponses[response.toolCallId] = response;
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.toolCallId !== response.toolCallId
    );
  }

  getApprovalResponse(toolCallId: string): ToolApprovalResponse | undefined {
    return this.approvalResponses[toolCallId];
  }

  getApprovedToolCalls(): ToolCallRequest[] {
    const approved: ToolCallRequest[] = [];
    for (const [callId, response] of Object.entries(this.approvalResponses)) {
      const call = this.pendingToolCalls[callId];
      if (response.approved && call) {
        approved.push(call);
        delete this.approvalResponses[callId];
        delete this.pendingToolCalls[callId];
      }
    }
    return approved;
  }

  getRejectedToolCalls(): Array<[string, ToolCallRequest]> {
    const rejected: Array<[string, ToolCallRequest]> = [];
    for (const [callId, response] of Object.entries(this.approvalResponses)) {
      const call = this.pendingToolCalls[callId];
      if (!response.approved && call) {
        rejected.push([callId, call]);
        delete this.approvalResponses[callId];
        delete this.pendingToolCalls[callId];
      }
    }
    return rejected;
  }

  toJSON(): Record<string, unknown> {
    return {
      messages: this.messages,
      metadata: this.metadata,
      sharedState: this.sharedState,
      environment: this.environment,
      sessionId: this.sessionId,
      createdAt: this.createdAt.toISOString(),
      pendingApprovalRequests: this.pendingApprovalRequests,
      approvalResponses: this.approvalResponses,
      pendingToolCalls: this.pendingToolCalls
    };
  }

  toString(): string {
    const approvalInfo = this.waitingForApproval
      ? `, ${this.pendingApprovalRequests.length} pending approvals`
      : "";
    return `AgentContext(messages=${this.messageCount}, session=${this.sessionId ?? "none"}${approvalInfo})`;
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON clone.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
