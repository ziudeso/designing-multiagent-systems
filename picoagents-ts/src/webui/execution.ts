import { CancellationToken } from "../cancellation.js";
import { AgentContext, ToolApprovalResponse } from "../context.js";
import { Message } from "../messages.js";
import { AgentResponse } from "../types.js";
import { WorkflowRunner } from "../workflow/index.js";
import { SessionManager } from "./sessions.js";
import {
  parseApprovalResponses,
  sseData,
  wrapStreamEvent
} from "./serialization.js";

export class ExecutionEngine {
  sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  async executeAgent(agent: any, messages: Message[], sessionId?: string): Promise<AgentResponse> {
    const id = sessionId ?? this.sessionManager.createSessionId();
    const entityId = agent.id ?? agent.name ?? "unknown";
    const context = await this.sessionManager.getOrCreate(id, entityId, "agent");
    for (const message of messages) context.addMessage(message);
    const result = await agent.run(undefined, { context });
    if (result.context) await this.sessionManager.update(id, result.context);
    return result;
  }

  async *executeAgentStream(options: {
    agent: any;
    messages: Message[];
    sessionId?: string;
    streamTokens?: boolean;
    approvalResponses?: ToolApprovalResponse[] | unknown[];
    cancellationToken?: CancellationToken;
  }): AsyncGenerator<string> {
    const sessionId = options.sessionId ?? this.sessionManager.createSessionId();
    const entityId = options.agent.id ?? options.agent.name ?? "unknown";
    const context = await this.sessionManager.getOrCreate(sessionId, entityId, "agent");

    for (const response of parseApprovalResponses(options.approvalResponses)) {
      context.addApprovalResponse(response);
    }
    for (const message of options.messages) context.addMessage(message);

    try {
      for await (const event of options.agent.runStream(undefined, {
        context,
        verbose: true,
        streamTokens: options.streamTokens ?? true,
        cancellationToken: options.cancellationToken
      })) {
        yield sseData(wrapStreamEvent(sessionId, event));
      }
      await this.sessionManager.update(sessionId, context);
    } catch (error) {
      yield sseData(
        wrapStreamEvent(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  async *executeOrchestratorStream(options: {
    orchestrator: any;
    messages: Message[];
    sessionId?: string;
    cancellationToken?: CancellationToken;
  }): AsyncGenerator<string> {
    const sessionId = options.sessionId ?? this.sessionManager.createSessionId();
    const entityId = options.orchestrator.id ?? options.orchestrator.name ?? "unknown";
    const context = await this.sessionManager.getOrCreate(sessionId, entityId, "orchestrator");
    for (const message of options.messages) context.addMessage(message);

    try {
      for await (const event of options.orchestrator.runStream(context.messages, {
        cancellationToken: options.cancellationToken,
        verbose: true
      })) {
        if (isOrchestrationResponse(event)) {
          context.messages = [...event.messages];
        }
        yield sseData(wrapStreamEvent(sessionId, event));
      }
      await this.sessionManager.update(sessionId, context);
    } catch (error) {
      yield sseData(
        wrapStreamEvent(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  async *executeWorkflowStream(options: {
    workflow: any;
    inputData: unknown;
    sessionId?: string;
    cancellationToken?: CancellationToken;
  }): AsyncGenerator<string> {
    const sessionId = options.sessionId ?? this.sessionManager.createSessionId();
    const entityId = options.workflow.id ?? options.workflow.name ?? "unknown";
    const context = await this.sessionManager.getOrCreate(sessionId, entityId, "workflow");
    context.metadata.lastInput = options.inputData;

    try {
      const runner = new WorkflowRunner();
      for await (const event of runner.runStream(
        options.workflow,
        isRecord(options.inputData) ? options.inputData : { input: options.inputData },
        options.cancellationToken
      )) {
        yield sseData(wrapStreamEvent(sessionId, event));
      }
      await this.sessionManager.update(sessionId, context);
    } catch (error) {
      yield sseData(
        wrapStreamEvent(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOrchestrationResponse(value: unknown): value is { messages: Message[] } {
  return Boolean(value && typeof value === "object" && "messages" in value && "stopMessage" in value);
}
