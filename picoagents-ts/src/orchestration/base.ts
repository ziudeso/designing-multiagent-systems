import { AgentContext } from "../context.js";
import { CancellationToken } from "../cancellation.js";
import { BaseAgent, TaskInput } from "../agents/index.js";
import { dumpComponent, loadComponent } from "../componentConfig.js";
import type { ComponentModel } from "../componentConfig.js";
import { Message, UserMessage } from "../messages.js";
import { BaseTermination } from "../termination/index.js";
import {
  AgentExecutionCompleteEvent,
  AgentExecutionStartEvent,
  AgentResponse,
  AgentSelectionEvent,
  OrchestrationCompleteEvent,
  OrchestrationEvent,
  OrchestrationResponse,
  OrchestrationStartEvent,
  StopMessage,
  Usage
} from "../types.js";

export interface BaseOrchestratorOptions {
  agents: BaseAgent[];
  termination: BaseTermination;
  maxIterations?: number;
  name?: string;
  description?: string;
  exampleTasks?: string[];
}

export abstract class BaseOrchestrator {
  agents: BaseAgent[];
  termination: BaseTermination;
  maxIterations: number;
  name: string;
  description?: string;
  exampleTasks: string[];
  sharedMessages: Message[] = [];
  iterationCount = 0;
  startTime?: number;
  protected lastTerminationCheckCount = 0;

  constructor(options: BaseOrchestratorOptions) {
    if (!options.agents.length) throw new Error("At least one agent is required");
    const names = options.agents.map((agent) => agent.name);
    if (new Set(names).size !== names.length) throw new Error("Agent names must be unique");

    this.agents = [...options.agents];
    this.termination = options.termination;
    this.maxIterations = options.maxIterations ?? 50;
    this.name = options.name ?? this.constructor.name;
    this.description = options.description;
    this.exampleTasks = options.exampleTasks ?? [];
  }

  async run(
    task: TaskInput,
    options: { cancellationToken?: CancellationToken; persist?: boolean } = {}
  ): Promise<OrchestrationResponse> {
    this.resetForRun();
    let finalResult: OrchestrationResponse | undefined;
    try {
      for await (const item of this.runStream(task, {
        cancellationToken: options.cancellationToken,
        verbose: false
      })) {
        if (isOrchestrationResponse(item)) finalResult = item;
      }
      const response = finalResult ?? this.createFallbackResult("No result produced");
      await this.persistRun(response, options.persist);
      return response;
    } catch (error) {
      if (isCancellationError(error)) throw error;
      const elapsedMs = Date.now() - (this.startTime ?? Date.now());
      const response = {
        messages: this.sharedMessages,
        finalResult: `Orchestration failed: ${error instanceof Error ? error.message : String(error)}`,
        usage: new Usage({ durationMs: elapsedMs }),
        stopMessage: new StopMessage({
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          source: "Exception"
        }),
        patternMetadata: this.getPatternMetadata()
      };
      await this.persistRun(response, options.persist);
      return response;
    }
  }

  private async persistRun(response: OrchestrationResponse, enabled?: boolean): Promise<void> {
    if (!enabled) return;
    try {
      const { getDefaultStore } = await import("../store/index.js");
      const store = getDefaultStore();
      if (store && "saveOrchestratorRun" in store) await store.saveOrchestratorRun(this, response);
    } catch {
      // Persistence must never break the run result.
    }
  }

  async *runStream(
    task: TaskInput,
    options: { cancellationToken?: CancellationToken; verbose?: boolean } = {}
  ): AsyncGenerator<Message | OrchestrationEvent | OrchestrationResponse> {
    this.resetForRun();
    this.startTime = Date.now();
    const verbose = options.verbose ?? false;
    const streamedMessages: Message[] = [];
    const agentUsageStats: Usage[] = [];
    let stopMessage: StopMessage | undefined;

    try {
      if (verbose) {
        yield new OrchestrationStartEvent({
          source: "orchestrator",
          task: stringifyTask(task),
          pattern: this.constructor.name
        });
      }

      const initialMessages = this.normalizeTaskToMessages(task);
      this.sharedMessages.push(...initialMessages);
      for (const message of initialMessages) {
        yield message;
        streamedMessages.push(message);
      }

      this.termination.check(initialMessages);
      this.lastTerminationCheckCount = streamedMessages.length;

      while (this.iterationCount < this.maxIterations) {
        if (options.cancellationToken?.isCancelled()) throw new Error("Operation cancelled");

        if (this.iterationCount > 0 && this.termination.isMet()) {
          stopMessage = new StopMessage({
            content: this.termination.getReason(),
            source: this.termination.constructor.name,
            metadata: this.termination.getMetadata()
          });
          break;
        }

        const patternStop = this.shouldStop();
        if (patternStop) {
          stopMessage = patternStop;
          break;
        }

        const nextAgent = await this.selectNextAgent();
        if (verbose) {
          yield new AgentSelectionEvent({
            source: "orchestrator",
            selectedAgent: nextAgent.name,
            selectionReason: `Iteration ${this.iterationCount + 1}`
          });
        }

        const context = await this.prepareContextForAgent(nextAgent);
        if (verbose) {
          yield new AgentExecutionStartEvent({
            source: "orchestrator",
            executingAgent: nextAgent.name,
            contextSize: Array.isArray(context) ? context.length : 1
          });
        }

        const agentMessages: Message[] = [];
        let result: AgentResponse | undefined;

        try {
          for await (const item of nextAgent.runStream(context, {
            cancellationToken: options.cancellationToken,
            verbose
          })) {
            if (options.cancellationToken?.isCancelled()) throw new Error("Operation cancelled");

            if (isMessage(item)) {
              agentMessages.push(item);
              if (!(item instanceof UserMessage)) {
                yield item;
                streamedMessages.push(item);
              }
            } else if (item instanceof AgentResponse) {
              result = item;
            }
          }
        } catch (error) {
          if (verbose) {
            yield new AgentExecutionCompleteEvent({
              source: "orchestrator",
              executingAgent: nextAgent.name,
              success: false,
              messageCount: agentMessages.length
            });
          }
          throw error;
        }

        if (options.cancellationToken?.isCancelled()) throw new Error("Operation cancelled");

        result ??= new AgentResponse({
          context: AgentContext.fromMessages(agentMessages),
          source: nextAgent.name,
          finishReason: "completed_without_response",
          usage: new Usage()
        });
        agentUsageStats.push(result.usage);

        if (verbose) {
          yield new AgentExecutionCompleteEvent({
            source: "orchestrator",
            executingAgent: nextAgent.name,
            success: true,
            messageCount: result.messages.length
          });
        }

        await this.updateSharedState(result);

        const newStreamedMessages = streamedMessages.slice(this.lastTerminationCheckCount);
        this.lastTerminationCheckCount = streamedMessages.length;
        stopMessage = this.termination.check(newStreamedMessages);
        if (stopMessage) break;

        this.iterationCount += 1;
      }

      if (this.iterationCount >= this.maxIterations && !stopMessage) {
        stopMessage = new StopMessage({
          content: `Maximum iterations reached (${this.maxIterations})`,
          source: "MaxIterations"
        });
      }
      stopMessage ??= new StopMessage({
        content: "Orchestration completed normally",
        source: "Completion"
      });

      const finalResult = this.generateFinalResult();
      if (verbose) {
        yield new OrchestrationCompleteEvent({
          source: "orchestrator",
          result: finalResult,
          stopReason: stopMessage.content
        });
      }

      const elapsedMs = Date.now() - (this.startTime ?? Date.now());
      const usage = agentUsageStats.reduce(
        (total, item) => total.add(item),
        new Usage({ durationMs: elapsedMs })
      );

      yield {
        messages: this.sharedMessages,
        finalResult,
        usage,
        stopMessage,
        patternMetadata: this.getPatternMetadata()
      };
    } catch (error) {
      if (!isCancellationError(error)) throw error;

      const elapsedMs = Date.now() - (this.startTime ?? Date.now());
      const usage = agentUsageStats.reduce(
        (total, item) => total.add(item),
        new Usage({ durationMs: elapsedMs })
      );
      if (verbose) {
        yield new OrchestrationCompleteEvent({
          source: "orchestrator",
          result: "Orchestration cancelled",
          stopReason: "Cancellation"
        });
      }
      yield {
        messages: this.sharedMessages,
        finalResult: "Orchestration was cancelled",
        usage,
        stopMessage: new StopMessage({
          content: "Orchestration cancelled",
          source: "CancellationToken"
        }),
        patternMetadata: this.getPatternMetadata()
      };
      throw error;
    }
  }

  abstract selectNextAgent(): Promise<BaseAgent>;
  abstract prepareContextForAgent(agent: BaseAgent): Promise<TaskInput>;
  abstract updateSharedState(result: AgentResponse): Promise<void>;

  protected shouldStop(): StopMessage | undefined {
    return undefined;
  }

  protected normalizeTaskToMessages(task: TaskInput): Message[] {
    if (typeof task === "string") return [new UserMessage({ content: task, source: "user" })];
    if (task instanceof UserMessage) return [task];
    if (Array.isArray(task)) return task;
    return [new UserMessage({ content: String(task), source: "user" })];
  }

  protected extractNewMessages(agentMessages: Message[], sentContext: TaskInput): Message[] {
    if (Array.isArray(sentContext)) {
      return agentMessages.length > sentContext.length ? agentMessages.slice(sentContext.length) : [];
    }
    return agentMessages.length > 1 ? agentMessages.slice(1) : [];
  }

  protected resetForRun(): void {
    this.sharedMessages = [];
    this.iterationCount = 0;
    this.startTime = undefined;
    this.termination.reset();
    this.lastTerminationCheckCount = 0;
  }

  protected generateFinalResult(): string {
    for (let index = this.sharedMessages.length - 1; index >= 0; index -= 1) {
      const message = this.sharedMessages[index];
      if (message?.role === "assistant") return message.content;
    }
    return this.sharedMessages.length ? "Task completed" : "No messages generated";
  }

  getAgentCapabilitiesSummary(): string {
    return this.agents
      .map((agent) => {
        let line = `- ${agent.name}: ${agent.description}`;
        if (agent.tools.length) {
          line += ` | Tools: ${agent.tools.map((tool) => tool.name).join(", ")}`;
        }
        return line;
      })
      .join("\n");
  }

  protected getPatternMetadata(): Record<string, unknown> {
    return {
      pattern: this.constructor.name,
      iterationsCompleted: this.iterationCount,
      agentsCount: this.agents.length,
      messageCount: this.sharedMessages.length
    };
  }

  protected createFallbackResult(reason: string): OrchestrationResponse {
    const elapsedMs = Date.now() - (this.startTime ?? Date.now());
    return {
      messages: this.sharedMessages,
      finalResult: reason,
      usage: new Usage({ durationMs: elapsedMs }),
      stopMessage: new StopMessage({ content: reason, source: "Fallback" }),
      patternMetadata: this.getPatternMetadata()
    };
  }
}

export function serializeBaseOrchestratorConfig(orchestrator: BaseOrchestrator): Record<string, unknown> {
  return {
    agents: orchestrator.agents.map((agent) =>
      dumpComponent(agent as unknown as { toConfig(): Record<string, unknown> })
    ),
    termination: dumpComponent(
      orchestrator.termination as unknown as { toConfig(): Record<string, unknown> }
    ),
    maxIterations: orchestrator.maxIterations,
    name: orchestrator.name,
    description: orchestrator.description,
    exampleTasks: [...orchestrator.exampleTasks]
  };
}

export function loadBaseOrchestratorOptions(config: Record<string, unknown>): BaseOrchestratorOptions {
  const agents = Array.isArray(config.agents)
    ? config.agents.map((agent) => loadComponent(agent as ComponentModel) as unknown as BaseAgent)
    : [];
  const termination = loadComponent(config.termination as ComponentModel) as unknown as BaseTermination;
  return {
    agents,
    termination,
    maxIterations: numberOrUndefined(config.maxIterations ?? config.max_iterations),
    name: stringOrUndefined(config.name),
    description: stringOrUndefined(config.description),
    exampleTasks: Array.isArray(config.exampleTasks ?? config.example_tasks)
      ? ((config.exampleTasks ?? config.example_tasks) as unknown[]).map(String)
      : undefined
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function isMessage(value: unknown): value is Message {
  return Boolean(
    value &&
      typeof value === "object" &&
      "content" in value &&
      "role" in value &&
      "source" in value
  );
}

function isOrchestrationResponse(value: unknown): value is OrchestrationResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      "messages" in value &&
      "usage" in value &&
      "stopMessage" in value
  );
}

function stringifyTask(task: TaskInput): string {
  if (typeof task === "string") return task;
  if (Array.isArray(task)) return task.map((message) => message.content).join("\n");
  return task.content;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "Operation cancelled";
}
