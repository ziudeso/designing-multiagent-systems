/**
 * Evaluation targets - what we run tasks against.
 *
 * Concrete Target implementations for running tasks against different systems:
 * picoagents Agents, direct model calls, orchestrators, the Claude Code CLI,
 * and arbitrary callables. Ported from Python `eval/_targets.py`.
 *
 * Deviations from the Python port:
 * - `CopilotTarget` is OMITTED (no GitHub Copilot SDK binding in the TS port).
 * - `ClaudeCodeTarget` shells out to the Claude Code CLI via `child_process`
 *   instead of the Python `claude-code-sdk` package; the public shape is kept.
 */

import { spawn } from "node:child_process";
import type { BaseAgent } from "../agents/base.js";
import type { CancellationToken } from "../cancellation.js";
import { BaseChatCompletionClient } from "../llm/index.js";
import {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  UserMessage
} from "../messages.js";
import { BaseMiddleware } from "../middleware.js";
import type { BaseOrchestrator } from "../orchestration/index.js";
import { AgentResponse, Usage } from "../types.js";
import { AgentEvent } from "../types.js";
import { BaseEvent } from "../types.js";
import { Target } from "./base.js";
import { AgentConfig } from "./config.js";
import { RunTrajectory, Task } from "./types.js";

/**
 * Target that wraps a picoagents Agent.
 *
 * Safe for concurrent use: `Agent.run()`/`runStream()` use local working-context
 * variables internally, so parallel task execution does not cause shared-state races.
 */
export class AgentEvalTarget extends Target {
  agent: BaseAgent;

  constructor(agent: BaseAgent, name?: string) {
    super(name ?? agent.name ?? "Agent");
    this.agent = agent;
  }

  async run(task: Task, cancellationToken?: CancellationToken): Promise<RunTrajectory> {
    const startTime = Date.now();
    try {
      const response = await this.agent.run(task.input, { cancellationToken });
      const endTime = Date.now();
      return new RunTrajectory({
        task,
        messages: response.messages,
        success: true,
        error: undefined,
        usage: response.usage,
        metadata: {
          targetType: "agent",
          targetName: this.name,
          executionTimeMs: endTime - startTime
        }
      });
    } catch (e) {
      const endTime = Date.now();
      return new RunTrajectory({
        task,
        messages: [],
        success: false,
        error: e instanceof Error ? e.message : String(e),
        usage: new Usage({ durationMs: endTime - startTime }),
        metadata: {
          targetType: "agent",
          targetName: this.name,
          executionTimeMs: endTime - startTime
        }
      });
    }
  }
}

/** Target for direct LLM model calls. */
export class ModelEvalTarget extends Target {
  client: BaseChatCompletionClient;
  systemMessage?: string;

  constructor(client: BaseChatCompletionClient, systemMessage?: string, name?: string) {
    super(name ?? client.model ?? "Model");
    this.client = client;
    this.systemMessage = systemMessage;
  }

  async run(task: Task, _cancellationToken?: CancellationToken): Promise<RunTrajectory> {
    const startTime = Date.now();
    try {
      const messages: Message[] = [];
      if (this.systemMessage) {
        messages.push(new SystemMessage({ content: this.systemMessage, source: "system" }));
      }
      messages.push(new UserMessage({ content: task.input, source: "user" }));

      const result = await this.client.create(messages);
      const endTime = Date.now();
      const responseMessages = [...messages, result.message];

      return new RunTrajectory({
        task,
        messages: responseMessages,
        success: true,
        error: undefined,
        usage: result.usage,
        metadata: {
          targetType: "model",
          targetName: this.name,
          model: result.model,
          finishReason: result.finishReason,
          executionTimeMs: endTime - startTime
        }
      });
    } catch (e) {
      const endTime = Date.now();
      return new RunTrajectory({
        task,
        messages: [],
        success: false,
        error: e instanceof Error ? e.message : String(e),
        usage: new Usage({ durationMs: endTime - startTime }),
        metadata: {
          targetType: "model",
          targetName: this.name,
          executionTimeMs: endTime - startTime
        }
      });
    }
  }
}

/** Target for picoagents orchestrators. */
export class OrchestratorEvalTarget extends Target {
  orchestrator: BaseOrchestrator;

  constructor(orchestrator: BaseOrchestrator, name?: string) {
    super(name ?? orchestrator.constructor.name);
    this.orchestrator = orchestrator;
  }

  async run(task: Task, cancellationToken?: CancellationToken): Promise<RunTrajectory> {
    const startTime = Date.now();
    try {
      const response = await this.orchestrator.run(task.input, { cancellationToken });
      const endTime = Date.now();
      return new RunTrajectory({
        task,
        messages: response.messages,
        success: true,
        error: undefined,
        usage: response.usage,
        metadata: {
          targetType: "orchestrator",
          targetName: this.name,
          pattern: response.patternMetadata?.pattern ?? "unknown",
          iterations:
            response.patternMetadata?.iterationsCompleted ??
            response.patternMetadata?.iterations_completed ??
            0,
          stopReason: response.stopMessage.source,
          executionTimeMs: endTime - startTime
        }
      });
    } catch (e) {
      const endTime = Date.now();
      return new RunTrajectory({
        task,
        messages: [],
        success: false,
        error: e instanceof Error ? e.message : String(e),
        usage: new Usage({ durationMs: endTime - startTime }),
        metadata: {
          targetType: "orchestrator",
          targetName: this.name,
          executionTimeMs: endTime - startTime
        }
      });
    }
  }
}

/**
 * Target that creates an agent from an AgentConfig and runs tasks.
 *
 * Uses `runStream` to capture the full message and event trace.
 */
export class PicoAgentTarget extends Target {
  config: AgentConfig;
  middlewares: BaseMiddleware[];

  constructor(config: AgentConfig, middlewares?: BaseMiddleware[]) {
    super(config.name);
    this.config = config;
    this.middlewares = middlewares ?? [];
  }

  private getAgent(extraMiddlewares?: BaseMiddleware[]) {
    const allMiddlewares = [...this.middlewares, ...(extraMiddlewares ?? [])];
    return this.config.toAgent(allMiddlewares);
  }

  async run(
    task: Task,
    cancellationToken?: CancellationToken,
    options: { middlewares?: BaseMiddleware[] } = {}
  ): Promise<RunTrajectory> {
    const agent = this.getAgent(options.middlewares);

    try {
      const allMessages: Message[] = [];
      const allEvents: AgentEvent[] = [];
      let response: AgentResponse | undefined;

      for await (const item of agent.runStream(task.input, {
        cancellationToken,
        verbose: true
      })) {
        if (item instanceof AgentResponse) {
          response = item;
        } else if (isMessage(item)) {
          allMessages.push(item);
        } else if (item instanceof BaseEvent) {
          allEvents.push(item as AgentEvent);
        }
      }

      if (response === undefined) {
        return new RunTrajectory({
          task,
          messages: allMessages,
          success: false,
          error: "No response from agent",
          usage: new Usage(),
          metadata: { exceptionType: "NoResponse", events: allEvents }
        });
      }

      const contextMessages = response.context ? [...response.context.messages] : [];

      const metadata: Record<string, unknown> = {
        finishReason: response.finishReason,
        toolCalls: response.usage.toolCalls
      };
      if (allEvents.length) {
        metadata.events = allEvents.map((e) => serializeEvent(e));
        metadata.eventCount = allEvents.length;
      }

      return new RunTrajectory({
        task,
        messages: contextMessages.length ? contextMessages : allMessages,
        success: response.finishReason === "stop",
        error: response.finishReason === "stop" ? undefined : response.finishReason,
        usage: new Usage({
          durationMs: response.usage.durationMs,
          llmCalls: response.usage.llmCalls,
          tokensInput: response.usage.tokensInput,
          tokensOutput: response.usage.tokensOutput,
          toolCalls: response.usage.toolCalls
        }),
        metadata
      });
    } catch (e) {
      return new RunTrajectory({
        task,
        messages: [],
        success: false,
        error: e instanceof Error ? e.message : String(e),
        usage: new Usage(),
        metadata: { exceptionType: e instanceof Error ? e.name : typeof e }
      });
    }
  }
}

export interface ClaudeCodeTargetOptions {
  name?: string;
  maxTurns?: number;
  allowedTools?: string[];
  cwd?: string;
  permissionMode?: string;
  model?: string;
  /** Path/command for the Claude Code CLI executable (default: "claude"). */
  cliPath?: string;
}

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<Record<string, unknown>>;
  };
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Target that runs tasks with the Claude Code CLI.
 *
 * Captures the full tool trace (tool uses and results) so that evaluation can
 * inspect file access patterns, tool call counts, and redundancy - not just the
 * final text output.
 *
 * Unlike the Python `ClaudeCodeTarget` (which uses the `claude-code-sdk`
 * package), this port spawns the Claude Code CLI in `--output-format
 * stream-json` mode and parses its JSON message stream. The public interface is
 * kept compatible.
 */
export class ClaudeCodeTarget extends Target {
  maxTurns: number;
  allowedTools: string[];
  cwd?: string;
  permissionMode?: string;
  model?: string;
  cliPath: string;

  constructor(options: ClaudeCodeTargetOptions = {}) {
    super(options.name ?? "claude_code");
    this.maxTurns = options.maxTurns ?? 30;
    this.allowedTools = options.allowedTools ?? ["Read", "Bash", "Glob", "Grep"];
    this.cwd = options.cwd;
    this.permissionMode = options.permissionMode;
    this.model = options.model;
    this.cliPath = options.cliPath ?? "claude";
  }

  async run(task: Task, cancellationToken?: CancellationToken): Promise<RunTrajectory> {
    if (process.env.CLAUDECODE) {
      return new RunTrajectory({
        task,
        messages: [],
        success: false,
        error:
          "Cannot run ClaudeCodeTarget inside a Claude Code session " +
          "(CLAUDECODE env var is set). Run from a plain terminal.",
        usage: new Usage()
      });
    }

    const args = [
      "-p",
      task.input,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(this.maxTurns),
      "--allowedTools",
      this.allowedTools.join(",")
    ];
    if (this.permissionMode) args.push("--permission-mode", this.permissionMode);
    if (this.model) args.push("--model", this.model);

    const allMessages: Message[] = [new UserMessage({ content: task.input, source: "user" })];
    const toolUseIdToName: Record<string, string> = {};
    let iterations = 0;
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;
    let totalCostUsd: number | undefined;
    let usageBreakdown: Record<string, number> = {};
    let success = false;
    let error: string | undefined;

    let raw: string;
    try {
      raw = await this.spawnCli(args, cancellationToken);
    } catch (e) {
      return new RunTrajectory({
        task,
        messages: allMessages,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        usage: new Usage()
      });
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: ClaudeStreamMessage;
      try {
        message = JSON.parse(trimmed) as ClaudeStreamMessage;
      } catch {
        continue;
      }

      if (message.type === "assistant" && message.message) {
        iterations += 1;
        const textParts: string[] = [];
        const toolCalls: ToolCallRequest[] = [];
        for (const block of message.message.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            const id = String(block.id ?? "");
            const blockName = String(block.name ?? "");
            toolCalls.push(
              new ToolCallRequest({
                toolName: blockName,
                parameters: (block.input as Record<string, unknown>) ?? {},
                callId: id
              })
            );
            toolUseIdToName[id] = blockName;
            toolCallCount += 1;
          }
        }
        allMessages.push(
          new AssistantMessage({
            content: textParts.join("\n"),
            source: "assistant",
            toolCalls: toolCalls.length ? toolCalls : undefined
          })
        );
      } else if (message.type === "user" && message.message) {
        for (const block of message.message.content ?? []) {
          if (block.type === "tool_result") {
            const toolUseId = String(block.tool_use_id ?? "");
            let content = "";
            if (typeof block.content === "string") {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              content = block.content
                .map((item: unknown) =>
                  item && typeof item === "object" && "text" in item
                    ? String((item as { text: unknown }).text)
                    : String(item)
                )
                .join("\n");
            }
            const toolName = toolUseIdToName[toolUseId] ?? "";
            allMessages.push(
              new ToolMessage({
                content,
                source: toolName || toolUseId,
                toolCallId: toolUseId,
                toolName,
                success: !(block.is_error ?? false)
              })
            );
          }
        }
      } else if (message.type === "result") {
        success = !message.is_error;
        durationMs = message.duration_ms ?? 0;
        totalCostUsd = message.total_cost_usd;
        if (message.usage) {
          inputTokens =
            (message.usage.input_tokens ?? 0) +
            (message.usage.cache_creation_input_tokens ?? 0) +
            (message.usage.cache_read_input_tokens ?? 0);
          outputTokens = message.usage.output_tokens ?? 0;
          usageBreakdown = Object.fromEntries(
            Object.entries(message.usage).filter(([, v]) => typeof v === "number")
          );
        }
        if (message.is_error) {
          error = message.result ?? "Claude Code returned error";
        }
      }
    }

    const metadata: Record<string, unknown> = {
      targetType: "claude_code",
      targetName: this.name
    };
    if (totalCostUsd !== undefined) metadata.totalCostUsd = totalCostUsd;
    if (Object.keys(usageBreakdown).length) metadata.usageBreakdown = usageBreakdown;

    return new RunTrajectory({
      task,
      messages: allMessages,
      success,
      error,
      usage: new Usage({
        durationMs,
        llmCalls: iterations,
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        toolCalls: toolCallCount
      }),
      metadata
    });
  }

  private spawnCli(args: string[], cancellationToken?: CancellationToken): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        cwd: this.cwd,
        env: { ...process.env, CLAUDECODE: "" }
      });

      let stdout = "";
      let stderr = "";
      const cancel = () => child.kill();
      cancellationToken?.addCallback(cancel);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        reject(
          new Error(
            `Failed to launch Claude Code CLI '${this.cliPath}': ${err.message}. ` +
              "Install the CLI or pass cliPath."
          )
        );
      });
      child.on("close", (code) => {
        if (code === 0 || stdout.trim()) {
          resolve(stdout);
        } else {
          reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr}`));
        }
      });
    });
  }
}

/**
 * Wrap any async callable as a target.
 *
 * Useful for custom agent implementations or quick testing. The callable
 * receives a Task and returns a RunTrajectory.
 */
export class CallableTarget extends Target {
  func: (task: Task) => Promise<RunTrajectory>;

  constructor(name: string, func: (task: Task) => Promise<RunTrajectory>) {
    super(name);
    this.func = func;
  }

  async run(task: Task, _cancellationToken?: CancellationToken): Promise<RunTrajectory> {
    return this.func(task);
  }
}

function isMessage(item: unknown): item is Message {
  return (
    item instanceof SystemMessage ||
    item instanceof UserMessage ||
    item instanceof AssistantMessage ||
    item instanceof ToolMessage
  );
}

/** Serialize an AgentEvent into a JSON-safe plain object for trajectory metadata. */
function serializeEvent(event: AgentEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { type: event.constructor.name };
  for (const [key, value] of Object.entries(event)) {
    if (key === "source") {
      out.source = value;
      continue;
    }
    if (key.startsWith("_")) continue;
    out[key] = value;
  }
  if (!("source" in out)) out.source = (event as { source?: unknown }).source ?? null;
  return out;
}
