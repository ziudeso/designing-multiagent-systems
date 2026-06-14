/**
 * AgentAsTool wrapper - allows any agent to be used as a tool by other agents.
 *
 * Wraps a {@link BaseAgent} and exposes it as a {@link BaseTool}, enabling
 * hierarchical composition where specialized agents are used as tools by
 * higher-level coordinating agents.
 *
 * Ported from Python `_agent_as_tool.py`.
 */

import type { CancellationToken } from "../cancellation.js";
import { Message } from "../messages.js";
import { BaseTool, JSONSchema, ToolResult } from "../tools/base.js";
import { AgentEvent, AgentResponse } from "../types.js";
import type { BaseAgent } from "./base.js";

/** A result-extraction strategy: a named string strategy or a custom callback. */
export type ResultStrategy = string | ((messages: Message[]) => string);

export interface AgentAsToolOptions {
  /** Parameter name for the task input (default: "task"). */
  taskParameterName?: string;
  /** Strategy for extracting the result from messages (default: "last"). */
  resultStrategy?: ResultStrategy;
}

/**
 * Wraps any {@link BaseAgent} to expose it as a tool that other agents can use.
 *
 * The `resultStrategy` controls how agent messages are summarized:
 * - "last" (default): return only the last message
 * - "last:N": return the last N messages concatenated
 * - "all": return all messages concatenated
 * - callback: custom function that takes messages and returns a string
 */
export class AgentAsTool extends BaseTool {
  agent: BaseAgent;
  taskParameterName: string;
  resultStrategy: ResultStrategy;

  constructor(agent: BaseAgent, options: AgentAsToolOptions = {}) {
    super({ name: agent.name, description: agent.description });
    this.agent = agent;
    this.taskParameterName = options.taskParameterName ?? "task";
    this.resultStrategy = options.resultStrategy ?? "last";
    this.validateResultStrategy();
  }

  private validateResultStrategy(): void {
    if (typeof this.resultStrategy === "function") return;

    if (typeof this.resultStrategy !== "string") {
      throw new TypeError("resultStrategy must be a string or callable");
    }

    if (this.resultStrategy === "all" || this.resultStrategy === "last") return;

    if (this.resultStrategy.startsWith("last:")) {
      const n = Number(this.resultStrategy.split(":")[1]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(
          `Invalid resultStrategy format: ${this.resultStrategy}. ` +
            "Expected 'last:N' where N is a positive integer"
        );
      }
      return;
    }

    throw new Error(
      `Unknown resultStrategy: ${this.resultStrategy}. ` +
        "Expected 'last', 'last:N', 'all', or a callable"
    );
  }

  private extractResult(messages: Message[]): string {
    if (!messages.length) return "";

    if (typeof this.resultStrategy === "function") {
      return this.resultStrategy(messages);
    }

    if (this.resultStrategy === "last") {
      return messages[messages.length - 1]!.content;
    }

    if (this.resultStrategy === "all") {
      return messages.map((msg) => msg.content).join("\n");
    }

    if (this.resultStrategy.startsWith("last:")) {
      const n = Number(this.resultStrategy.split(":")[1]);
      const selected = messages.slice(-n);
      return selected.map((msg) => msg.content).join("\n");
    }

    // Should never reach here due to validation.
    return messages[messages.length - 1]!.content;
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        [this.taskParameterName]: {
          type: "string",
          description: `Task for ${this.agent.name} to complete`
        }
      },
      required: [this.taskParameterName]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const task = String(parameters[this.taskParameterName] ?? "");

    try {
      const response = await this.agent.run(task);
      const finalContent = this.extractResult(response.messages);

      return new ToolResult({
        success: true,
        result: finalContent,
        metadata: {
          agentName: this.agent.name,
          messageCount: response.messages.length,
          usage: response.usage ?? null
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: "",
        error: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { agentName: this.agent.name }
      });
    }
  }

  async *executeStream(
    parameters: Record<string, unknown>,
    cancellationToken?: CancellationToken
  ): AsyncGenerator<Message | AgentEvent | ToolResult> {
    const task = String(parameters[this.taskParameterName] ?? "");

    let finalResponse: AgentResponse | undefined;
    let errorMessage: string | undefined;

    try {
      for await (const item of this.agent.runStream(task, {
        cancellationToken,
        verbose: false,
        streamTokens: false
      })) {
        if (item instanceof AgentResponse) {
          finalResponse = item;
        } else {
          // Forward agent messages and events.
          yield item as Message | AgentEvent;
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    if (errorMessage !== undefined) {
      yield new ToolResult({
        success: false,
        result: "",
        error: `Agent execution failed: ${errorMessage}`,
        metadata: { agentName: this.agent.name }
      });
      return;
    }

    const finalContent =
      finalResponse && finalResponse.messages.length
        ? this.extractResult(finalResponse.messages)
        : "";

    yield new ToolResult({
      success: true,
      result: finalContent,
      metadata: {
        agentName: this.agent.name,
        messageCount: finalResponse ? finalResponse.messages.length : 0,
        usage: finalResponse?.usage ?? null
      }
    });
  }
}
