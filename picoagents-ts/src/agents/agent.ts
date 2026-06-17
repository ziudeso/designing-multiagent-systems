import { AgentContext } from "../context.js";
import { CancellationToken } from "../cancellation.js";
import { CompactionStrategy, normalizeCompaction } from "../compaction.js";
import { dumpComponent, loadComponent, registerComponent } from "../componentConfig.js";
import type { ComponentModel } from "../componentConfig.js";
import { LoopContext } from "../hooks.js";
import { maybeOtelMiddleware } from "../otel.js";
import { MiddlewareChain } from "../middleware.js";
import {
  AssistantMessage,
  Message,
  ToolCallRequest,
  ToolMessage,
  UserMessage
} from "../messages.js";
import { ApprovalMode, ToolResult } from "../tools/index.js";
import {
  AgentEvent,
  AgentResponse,
  ChatCompletionResult,
  ChatCompletionChunk,
  ErrorEvent,
  ModelCallEvent,
  ModelResponseEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  ToolApprovalEvent,
  ToolCallEvent,
  ToolCallResponseEvent,
  Usage
} from "../types.js";
import { BaseAgent, BaseAgentOptions, TaskInput } from "./base.js";
import { getDefaultStore } from "./store.js";

export class Agent extends BaseAgent {
  static componentType = "agent" as const;
  static componentProvider = "picoagents.agents.Agent";
  static componentVersion = 1;

  /** Effective middleware chain for the current run (set at runStream start). */
  private activeChain?: MiddlewareChain;

  constructor(options: BaseAgentOptions) {
    super(options);
  }

  async run(
    task?: TaskInput,
    options: { context?: AgentContext; cancellationToken?: CancellationToken; persist?: boolean } = {}
  ): Promise<AgentResponse> {
    let finalResponse: AgentResponse | undefined;
    const workingContext = options.context ?? this.context.clone();

    try {
      for await (const item of this.runStream(task, {
        context: workingContext,
        cancellationToken: options.cancellationToken,
        verbose: false,
        streamTokens: false
      })) {
        if (item instanceof AgentResponse) finalResponse = item;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Operation cancelled") {
        throw error;
      }
      const message = new AssistantMessage({
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        source: this.name
      });
      workingContext.addMessage(message);
      return new AgentResponse({
        context: workingContext,
        source: this.name,
        finishReason: "error",
        usage: new Usage()
      });
    }

    const response =
      finalResponse ??
      new AgentResponse({
        context: workingContext,
        source: this.name,
        finishReason: "no_response",
        usage: new Usage()
      });

    if (options.persist) {
      const store = getDefaultStore();
      if (store) {
        try {
          await store.saveAgentRun(this, response);
        } catch {
          // Persistence must never break the run result.
        }
      }
    }

    return response;
  }

  async *runStream(
    task?: TaskInput,
    options: {
      context?: AgentContext;
      cancellationToken?: CancellationToken;
      verbose?: boolean;
      streamTokens?: boolean;
    } = {}
  ): AsyncGenerator<Message | AgentEvent | AgentResponse | ChatCompletionChunk> {
    const start = Date.now();
    const verbose = options.verbose ?? false;
    const streamTokens = options.streamTokens ?? false;
    const cancellationToken = options.cancellationToken;
    const workingContext = options.context ?? this.context.clone();
    const messagesYielded: Message[] = [];
    let llmCalls = 0;
    let tokensInput = 0;
    let tokensOutput = 0;
    let lastAssistantMessage = new AssistantMessage({
      content: "Task completed",
      source: this.name
    });
    let finishReason = "stop";

    try {
      cancellationToken?.throwIfCancelled();

      if (task !== undefined) {
        const taskMessages = this.convertTaskToMessages(task);
        for (const message of taskMessages) workingContext.addMessage(message);
        const userMessage = taskMessages[0];
        if (userMessage) {
          yield userMessage;
          messagesYielded.push(userMessage);
          if (verbose) yield new TaskStartEvent({ source: this.name, task: userMessage.content });
        }
      }

      if (task === undefined && workingContext.messages.length) {
        const last = workingContext.messages.at(-1);
        if (last instanceof AssistantMessage && last.toolCalls?.length) {
          const hasApprovals = last.toolCalls.some((call) =>
            Boolean(workingContext.approvalResponses[call.callId])
          );
          if (hasApprovals) {
            const llmMessages = await this.prepareLLMMessages([], workingContext);
            for (const toolCall of last.toolCalls) {
              for await (const item of this.executeToolCall(toolCall, llmMessages, workingContext, cancellationToken)) {
                yield item;
                if (isMessage(item)) messagesYielded.push(item);
              }
            }
          }
        }
      }

      let llmMessages = await this.prepareLLMMessages([], workingContext);

      // Build the effective middleware chain, prepending the OTel middleware
      // when OTel is enabled. Mirrors Python's _agent.py model_call/tool_call.
      const otelMiddleware = maybeOtelMiddleware();
      const effectiveChain = otelMiddleware
        ? new MiddlewareChain([otelMiddleware, ...this.middlewareChain.middlewares])
        : this.middlewareChain;
      const useChain = effectiveChain.middlewares.length > 0;
      this.activeChain = effectiveChain;

      // Normalize compaction (function OR object with .compact()).
      const compactionStrategy = this.compaction
        ? normalizeCompaction(this.compaction as CompactionStrategy)
        : undefined;

      // === DETERMINISTIC START HOOKS ===
      // Run before the first LLM call. These are deterministic code, not LLM
      // controlled. Hooks can inject UserMessages (e.g., "create a plan first").
      let loopContext: LoopContext | undefined;
      if (this.startHooks.length || this.endHooks.length) {
        loopContext = {
          agentContext: workingContext,
          llmMessages,
          agentName: this.name,
          iteration: 0,
          restartCount: 0,
          metadata: {},
          modelClient: this.modelClient as unknown as LoopContext["modelClient"]
        };
        for (const hook of this.startHooks) {
          const injection = await hook.onStart(loopContext);
          if (injection) {
            const hookMsg = new UserMessage({ content: injection, source: "hook" });
            workingContext.addMessage(hookMsg);
            llmMessages.push(hookMsg);
          }
        }
      }

      let iteration = 0;

      while (iteration < this.maxIterations) {
        try {
          cancellationToken?.throwIfCancelled();
          if (compactionStrategy) llmMessages = compactionStrategy.compact(llmMessages);
          const tools = this.tools.length ? this.getToolsForLLM() : undefined;

          if (verbose) {
            yield new ModelCallEvent({
              source: this.name,
              inputMessages: llmMessages,
              model: this.modelClient.model
            });
          }

          let completion: ChatCompletionResult;
          if (streamTokens) {
            // STREAMING PATH: stream tokens and accumulate the result.
            // Argument fragments are concatenated per call_id; chunks lacking an
            // explicit id append to the last seen call_id. Mirrors Python.
            let streamedContent = "";
            const accumulatedToolCalls = new Map<
              string,
              { id: string; name: string; arguments: string }
            >();
            let lastCallId: string | undefined;
            let streamingUsage = new Usage({ llmCalls: 1 });

            const streamAbort = createAbortSignal(cancellationToken);
            try {
              for await (const chunk of this.modelClient.createStream(llmMessages, {
                tools,
                outputFormat: this.outputFormat,
                signal: streamAbort.signal
              })) {
                cancellationToken?.throwIfCancelled();
                if (!chunk.isComplete) {
                  yield chunk;
                  if (chunk.content) streamedContent += chunk.content;
                  if (chunk.toolCallChunk) {
                    const tc = chunk.toolCallChunk as {
                      id?: unknown;
                      function?: { name?: unknown; arguments?: unknown };
                    };
                    const chunkId = tc.id != null ? String(tc.id) : undefined;
                    if (chunkId) lastCallId = chunkId;
                    const effectiveCallId = chunkId ?? lastCallId;
                    if (effectiveCallId) {
                      let entry = accumulatedToolCalls.get(effectiveCallId);
                      if (!entry) {
                        entry = { id: effectiveCallId, name: "", arguments: "" };
                        accumulatedToolCalls.set(effectiveCallId, entry);
                      }
                      const fnName = tc.function?.name;
                      if (typeof fnName === "string" && fnName) entry.name = fnName;
                      const fnArgs = tc.function?.arguments;
                      if (typeof fnArgs === "string") {
                        entry.arguments = mergeToolArguments(entry.arguments, fnArgs);
                      }
                    }
                  }
                } else if (chunk.usage) {
                  streamingUsage = chunk.usage;
                }
              }
            } finally {
              streamAbort.cleanup();
            }

            const streamedToolCalls: ToolCallRequest[] = [];
            for (const entry of accumulatedToolCalls.values()) {
              // Validate name+arguments before building the request.
              if (!entry.name || !entry.arguments) continue;
              try {
                streamedToolCalls.push(
                  new ToolCallRequest({
                    toolName: entry.name,
                    parameters: JSON.parse(entry.arguments),
                    callId: entry.id
                  })
                );
              } catch {
                // Skip malformed streamed tool call arguments.
              }
            }

            completion = {
              message: new AssistantMessage({
                content: streamedContent,
                source: "llm",
                toolCalls: streamedToolCalls.length ? streamedToolCalls : undefined
              }),
              usage: new Usage({
                durationMs: streamingUsage.durationMs,
                llmCalls: 1,
                tokensInput: streamingUsage.tokensInput,
                tokensOutput: streamingUsage.tokensOutput,
                toolCalls: streamedToolCalls.length,
                memoryOperations: streamingUsage.memoryOperations,
                costEstimate: streamingUsage.costEstimate
              }),
              model: this.modelClient.model,
              finishReason: streamedToolCalls.length ? "tool_calls" : "stop"
            };
          } else if (useChain) {
            // NON-STREAMING PATH with middleware: route the model call through the
            // chain. Events are yielded; the final result is a ChatCompletionResult.
            // If the chain returns without a result, a middleware paused (approval).
            let completionResult: ChatCompletionResult | undefined;
            let paused = false;
            const modelAbort = createAbortSignal(cancellationToken);
            try {
              for await (const item of effectiveChain.executeStream(
                "model_call",
                this.name,
                workingContext,
                llmMessages,
                async (data) =>
                  this.modelClient.create(data as Message[], {
                    tools,
                    outputFormat: this.outputFormat,
                    signal: modelAbort.signal
                  }),
                { model: this.modelClient.model }
              )) {
                if (isChatCompletionResult(item)) {
                  completionResult = item;
                } else {
                  yield item as AgentEvent;
                  if (item instanceof ToolApprovalEvent) {
                    paused = true;
                  }
                }
              }
            } finally {
              modelAbort.cleanup();
            }
            if (paused) return;
            if (!completionResult) return; // middleware paused without a result
            completion = completionResult;
          } else {
            const modelAbort = createAbortSignal(cancellationToken);
            try {
              completion = await this.modelClient.create(llmMessages, {
                tools,
                outputFormat: this.outputFormat,
                signal: modelAbort.signal
              });
            } finally {
              modelAbort.cleanup();
            }
          }

          llmCalls += 1;
          tokensInput += completion.usage.tokensInput;
          tokensOutput += completion.usage.tokensOutput;
          finishReason = completion.finishReason;

          const assistantMessage = new AssistantMessage({
            content: completion.message.content,
            source: this.name,
            toolCalls: completion.message.toolCalls,
            structuredContent: completion.structuredOutput,
            usage: completion.usage
          });
          lastAssistantMessage = assistantMessage;

          if (!assistantMessage.toolCalls?.length) {
            yield assistantMessage;
            messagesYielded.push(assistantMessage);
          }

          if (verbose) {
            yield new ModelResponseEvent({
              source: this.name,
              response: assistantMessage.content,
              hasToolCalls: Boolean(assistantMessage.toolCalls?.length)
            });
          }

          workingContext.addMessage(assistantMessage);
          llmMessages.push(assistantMessage);

          if (assistantMessage.toolCalls?.length) {
            let approvalNeeded = false;
            const toolItems =
              assistantMessage.toolCalls.length > 1
                ? this.collectParallelToolCalls(assistantMessage.toolCalls, llmMessages, workingContext, cancellationToken)
                : this.collectSequentialToolCalls(assistantMessage.toolCalls, llmMessages, workingContext, cancellationToken);

            for await (const item of toolItems) {
              yield item;
              if (isMessage(item)) messagesYielded.push(item);
              if (item instanceof ToolApprovalEvent) approvalNeeded = true;
            }

            if (approvalNeeded) {
              finishReason = "approval_needed";
              break;
            }

            if (!this.summarizeToolResult) break;
            iteration += 1;
            continue;
          }

          // No tool calls - check end hooks before stopping. End hooks are
          // deterministic code; the FIRST hook to return a non-null string injects
          // it as a UserMessage and resumes the loop (increment restartCount).
          let shouldContinue = false;
          if (loopContext) {
            loopContext.iteration = iteration;
            loopContext.llmMessages = llmMessages;
            for (const hook of this.endHooks) {
              const injection = await hook.onEnd(loopContext);
              if (injection) {
                const resumeMsg = new UserMessage({ content: injection, source: "hook" });
                workingContext.addMessage(resumeMsg);
                llmMessages.push(resumeMsg);
                loopContext.restartCount += 1;
                shouldContinue = true;
                break; // First hook to inject wins.
              }
            }
          }

          if (shouldContinue) {
            iteration += 1;
            continue;
          }

          break;
        } catch (error) {
          if (isCancellationError(error, cancellationToken)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          yield new ErrorEvent({
            source: this.name,
            errorMessage: message,
            errorType: error instanceof Error ? error.name : typeof error,
            isRecoverable: true
          });
          const errorMessage = new AssistantMessage({
            content: `I encountered an error: ${message}`,
            source: this.name
          });
          workingContext.addMessage(errorMessage);
          yield errorMessage;
          messagesYielded.push(errorMessage);
          break;
        }
      }

      if (iteration >= this.maxIterations) finishReason = "max_iterations";
      if (verbose) {
        yield new TaskCompleteEvent({ source: this.name, result: lastAssistantMessage.content });
      }

      const toolCalls = messagesYielded.filter((message) => message instanceof ToolMessage).length;
      yield new AgentResponse({
        context: workingContext,
        source: this.name,
        finishReason,
        usage: new Usage({
          durationMs: Date.now() - start,
          llmCalls,
          tokensInput,
          tokensOutput,
          toolCalls
        })
      });
    } catch (error) {
      const cancelled = error instanceof Error && error.message === "Operation cancelled";
      yield new ErrorEvent({
        source: this.name,
        errorMessage: cancelled ? "Agent execution was cancelled" : error instanceof Error ? error.message : String(error),
        errorType: cancelled ? "CancelledError" : error instanceof Error ? error.name : typeof error,
        isRecoverable: !cancelled
      });
      const errorMessage = new AssistantMessage({
        content: cancelled
          ? "Agent execution was cancelled"
          : `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
        source: this.name
      });
      workingContext.addMessage(errorMessage);
      yield errorMessage;
      yield new AgentResponse({
        context: workingContext,
        source: this.name,
        finishReason: cancelled ? "cancelled" : "error",
        usage: new Usage({
          durationMs: Date.now() - start,
          llmCalls,
          tokensInput,
          tokensOutput,
          toolCalls: messagesYielded.filter((message) => message instanceof ToolMessage).length
        })
      });
      if (cancelled) throw error;
    }
  }

  private async *collectSequentialToolCalls(
    toolCalls: ToolCallRequest[],
    llmMessages: Message[],
    context: AgentContext,
    cancellationToken?: CancellationToken
  ): AsyncGenerator<Message | AgentEvent> {
    for (const toolCall of toolCalls) {
      for await (const item of this.executeToolCall(toolCall, llmMessages, context, cancellationToken)) {
        yield item;
      }
    }
  }

  private async *collectParallelToolCalls(
    toolCalls: ToolCallRequest[],
    llmMessages: Message[],
    context: AgentContext,
    cancellationToken?: CancellationToken
  ): AsyncGenerator<Message | AgentEvent> {
    type QueueItem =
      | { kind: "item"; item: Message | AgentEvent }
      | { kind: "error"; toolCall: ToolCallRequest; error: unknown }
      | { kind: "done" };
    const queue = new AsyncToolEventQueue<QueueItem>();
    let remaining = toolCalls.length;

    for (const toolCall of toolCalls) {
      void (async () => {
        try {
          cancellationToken?.throwIfCancelled();
          for await (const item of this.executeToolCall(toolCall, llmMessages, context, cancellationToken)) {
            queue.push({ kind: "item", item });
          }
        } catch (error) {
          queue.push({ kind: "error", toolCall, error });
        } finally {
          queue.push({ kind: "done" });
        }
      })();
    }

    while (remaining > 0) {
      const queued = await queue.shift();
      if (queued.kind === "done") {
        remaining -= 1;
        continue;
      }
      if (queued.kind === "item") {
        yield queued.item;
        continue;
      }
      if (isCancellationError(queued.error, cancellationToken)) {
        throw queued.error;
      }
      const message = new ToolMessage({
        content: `Tool execution failed: ${queued.error instanceof Error ? queued.error.message : String(queued.error)}`,
        source: this.name,
        toolCallId: queued.toolCall.callId,
        toolName: queued.toolCall.toolName,
        success: false,
        error: queued.error instanceof Error ? queued.error.message : String(queued.error)
      });
      context.addMessage(message);
      llmMessages.push(message);
      yield new ToolCallResponseEvent({ source: this.name, callId: queued.toolCall.callId });
      yield message;
    }
  }

  private async *executeToolCall(
    toolCall: ToolCallRequest,
    llmMessages: Message[],
    context: AgentContext,
    cancellationToken?: CancellationToken
  ): AsyncGenerator<Message | AgentEvent> {
    cancellationToken?.throwIfCancelled();
    yield new ToolCallEvent({
      source: this.name,
      toolName: toolCall.toolName,
      parameters: toolCall.parameters,
      callId: toolCall.callId
    });

    const tool = this.findTool(toolCall.toolName);
    if (!tool) {
      const result = new ToolMessage({
        content: `Tool '${toolCall.toolName}' not found`,
        source: this.name,
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
        success: false,
        error: `Tool '${toolCall.toolName}' not found`
      });
      context.addMessage(result);
      llmMessages.push(result);
      yield new ToolCallResponseEvent({ source: this.name, callId: toolCall.callId });
      yield result;
      return;
    }

    if (tool.approvalMode === ApprovalMode.ALWAYS) {
      const approval = context.getApprovalResponse(toolCall.callId);
      if (!approval) {
        const approvalRequest = context.addApprovalRequest(toolCall, toolCall.toolName);
        yield new ToolApprovalEvent({ source: this.name, approvalRequest });
        return;
      }
      if (!approval.approved) {
        const result = new ToolMessage({
          content: `Tool execution denied: ${approval.reason ?? "User declined approval"}`,
          source: this.name,
          toolCallId: toolCall.callId,
          toolName: toolCall.toolName,
          success: false,
          error: "Approval denied"
        });
        context.addMessage(result);
        llmMessages.push(result);
        yield new ToolCallResponseEvent({ source: this.name, callId: toolCall.callId });
        yield result;
        return;
      }
    }

    try {
      let toolResult: ToolResult | undefined;
        if (tool.supportsStreaming()) {
          for await (const item of tool.executeStream(toolCall.parameters, cancellationToken)) {
            if (item instanceof ToolResult) {
              toolResult = item;
              const message = toolResultToMessage(toolResult, toolCall, this.name);
              context.addMessage(message);
              llmMessages.push(message);
              yield new ToolCallResponseEvent({
                source: this.name,
                callId: toolCall.callId,
                result: toolResult
              });
              yield message;
            } else {
              yield item;
            }
          }
      } else if (this.activeChain && this.activeChain.middlewares.length > 0) {
        // Route the tool call through the middleware chain. Events are yielded;
        // the final result is a ToolResult. If the chain returns without a
        // result, a middleware paused (approval) and we stop without a message.
        let paused = false;
        for await (const item of this.activeChain.executeStream(
          "tool_call",
          this.name,
          context,
          toolCall,
          async (data) => {
            cancellationToken?.throwIfCancelled();
            const result = await tool.execute((data as ToolCallRequest).parameters);
            cancellationToken?.throwIfCancelled();
            return result;
          }
        )) {
          if (item instanceof ToolResult) {
            toolResult = item;
          } else {
            yield item as Message | AgentEvent;
            if (item instanceof ToolApprovalEvent) paused = true;
          }
        }
        if (paused) return;
        if (!toolResult) return; // middleware paused without a result
        const message = toolResultToMessage(toolResult, toolCall, this.name);
        context.addMessage(message);
        llmMessages.push(message);
        yield new ToolCallResponseEvent({
          source: this.name,
          callId: toolCall.callId,
          result: toolResult
        });
        yield message;
      } else {
        cancellationToken?.throwIfCancelled();
        toolResult = await tool.execute(toolCall.parameters);
        cancellationToken?.throwIfCancelled();
        const message = toolResultToMessage(toolResult, toolCall, this.name);
        context.addMessage(message);
        llmMessages.push(message);
        yield new ToolCallResponseEvent({
          source: this.name,
          callId: toolCall.callId,
          result: toolResult
        });
        yield message;
      }
    } catch (error) {
      if (isCancellationError(error, cancellationToken)) throw error;
      const message = new ToolMessage({
        content: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        source: this.name,
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      context.addMessage(message);
      llmMessages.push(message);
      yield message;
    }
  }

  /**
   * Serialize the agent's primitive configuration. Closure-backed tools and
   * other non-registered components are skipped because they have no portable
   * JSON representation.
   */
  toConfig(): Record<string, unknown> {
    const modelClient = tryDumpComponent(this.modelClient);
    const tools = this.tools
      .map((tool) => tryDumpComponent(tool))
      .filter((tool): tool is ComponentModel => Boolean(tool));
    const memory = this.memory ? tryDumpComponent(this.memory) : undefined;

    return {
      name: this.name,
      description: this.description,
      instructions: this.instructions,
      maxIterations: this.maxIterations,
      summarizeToolResult: this.summarizeToolResult,
      requiredTools: [...this.requiredTools],
      exampleTasks: [...this.exampleTasks],
      outputFormat: this.outputFormat,
      modelClient,
      tools,
      memory
    };
  }

  static fromConfig(config: Record<string, unknown>): Agent {
    const modelClient = loadIfComponent(config.modelClient ?? config.model_client) as BaseAgentOptions["modelClient"];
    const tools = Array.isArray(config.tools)
      ? config.tools.map((tool) => loadIfComponent(tool)).filter(Boolean) as BaseAgentOptions["tools"]
      : undefined;
    const memory = loadIfComponent(config.memory) as BaseAgentOptions["memory"];

    return new Agent({
      name: String(config.name ?? ""),
      instructions: String(config.instructions ?? ""),
      description: config.description as string | undefined,
      modelClient,
      tools,
      memory,
      maxIterations: config.maxIterations as number | undefined,
      outputFormat: config.outputFormat as BaseAgentOptions["outputFormat"],
      summarizeToolResult: config.summarizeToolResult as boolean | undefined,
      requiredTools: config.requiredTools as string[] | undefined,
      exampleTasks: config.exampleTasks as string[] | undefined
    });
  }
}

registerComponent(Agent as any);

function tryDumpComponent(value: unknown): ComponentModel | undefined {
  try {
    return dumpComponent(value as any);
  } catch {
    return undefined;
  }
}

function loadIfComponent(value: unknown): unknown {
  if (isComponentModel(value)) return loadComponent(value);
  return value;
}

function isComponentModel(value: unknown): value is ComponentModel {
  return Boolean(value && typeof value === "object" && "provider" in value && "config" in value);
}

function isChatCompletionResult(item: unknown): item is ChatCompletionResult {
  return (
    typeof item === "object" &&
    item !== null &&
    "message" in item &&
    "usage" in item &&
    "finishReason" in item
  );
}

function isMessage(item: unknown): item is Message {
  return (
    item instanceof UserMessage ||
    item instanceof AssistantMessage ||
    item instanceof ToolMessage
  );
}

function createAbortSignal(cancellationToken?: CancellationToken): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!cancellationToken) {
    return { cleanup: () => undefined };
  }
  const controller = new AbortController();
  const cleanup = cancellationToken.addCallback(() => controller.abort());
  return { signal: controller.signal, cleanup };
}

function mergeToolArguments(current: string, incoming: string): string {
  // Bundled clients emit the complete accumulated argument string on every
  // streamed tool chunk, while custom clients may emit true deltas. Accept both.
  return incoming.startsWith(current) ? incoming : current + incoming;
}

function isCancellationError(error: unknown, cancellationToken?: CancellationToken): boolean {
  return (
    Boolean(cancellationToken?.isCancelled()) ||
    (error instanceof Error && error.message === "Operation cancelled")
  );
}

function toolResultToMessage(toolResult: ToolResult, toolCall: ToolCallRequest, source: string): ToolMessage {
  return new ToolMessage({
    content: toolResult.success ? String(toolResult.result) : `Error: ${toolResult.error}`,
    source,
    toolCallId: toolCall.callId,
    toolName: toolCall.toolName,
    success: toolResult.success,
    error: toolResult.error,
    metadata: toolResult.metadata
  });
}

class AsyncToolEventQueue<T> {
  private buffer: T[] = [];
  private resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(item);
      return;
    }
    this.buffer.push(item);
  }

  shift(): Promise<T> {
    const item = this.buffer.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}
