/**
 * Run middleware for metrics collection.
 *
 * RunMiddleware captures detailed iteration-level metrics during agent execution
 * for evaluation analysis: per-iteration token usage, tool calls, file read
 * patterns, and compaction events. Ported from Python `eval/_middleware.py`.
 */

import { BaseMiddleware, MiddlewareContext } from "../middleware.js";
import type { AgentEvent } from "../types.js";

interface IterationRecord {
  index: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolRecord[];
  messageCount: number;
  toolCallCount?: number;
}

interface ToolRecord {
  name: string;
  parameters: Record<string, unknown>;
  success: boolean;
  filePath?: string;
}

interface CompactionEvent {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  messagesBefore: number;
  messagesAfter: number;
}

interface ErrorRecord {
  operation: string;
  errorType: string;
  errorMessage: string;
}

/**
 * Middleware that captures iteration-level metrics during evaluation runs.
 *
 * Tracks per-iteration token usage, tool calls with parameters and results, file
 * read patterns (including duplicates), and compaction events.
 */
export class RunMiddleware extends BaseMiddleware {
  iterations!: IterationRecord[];
  currentIteration!: IterationRecord | null;
  fileReads!: Record<string, number>;
  toolCalls!: ToolRecord[];
  compactionEvents!: CompactionEvent[];
  errors!: ErrorRecord[];

  constructor() {
    super();
    this.reset();
  }

  /** Reset all collected metrics. */
  reset(): void {
    this.iterations = [];
    this.currentIteration = null;
    this.fileReads = {};
    this.toolCalls = [];
    this.compactionEvents = [];
    this.errors = [];
  }

  override async *processRequest(
    context: MiddlewareContext
  ): AsyncGenerator<MiddlewareContext | AgentEvent> {
    if (context.operation === "model_call") {
      this.currentIteration = {
        index: this.iterations.length,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        messageCount: Array.isArray(context.data) ? context.data.length : 0
      };
    }
    yield context;
  }

  override async *processResponse(
    context: MiddlewareContext,
    result: unknown
  ): AsyncGenerator<unknown | AgentEvent> {
    if (context.operation === "model_call" && this.currentIteration !== null) {
      const res = result as { usage?: { tokensInput?: number; tokensOutput?: number }; message?: { toolCalls?: unknown[] } };
      if (res && res.usage) {
        this.currentIteration.inputTokens = res.usage.tokensInput ?? 0;
        this.currentIteration.outputTokens = res.usage.tokensOutput ?? 0;
      }
      if (res && res.message && Array.isArray(res.message.toolCalls)) {
        this.currentIteration.toolCallCount = res.message.toolCalls.length;
      }
      this.iterations.push(this.currentIteration);
      this.currentIteration = null;
    } else if (context.operation === "tool_call") {
      const data = context.data as { toolName?: string; parameters?: Record<string, unknown> } | undefined;
      const toolName = data?.toolName ?? "unknown";
      const parameters = data?.parameters ?? {};
      const explicitSuccess = result ? (result as { success?: unknown }).success : undefined;

      const toolRecord: ToolRecord = {
        name: toolName,
        parameters,
        success: result ? (explicitSuccess === undefined ? true : Boolean(explicitSuccess)) : false
      };

      if (toolName === "read_file" || toolName === "Read" || toolName === "read") {
        const p =
          (parameters.path as string | undefined) ??
          (parameters.file_path as string | undefined) ??
          (parameters.filePath as string | undefined) ??
          (parameters.filename as string | undefined) ??
          "unknown";
        this.fileReads[p] = (this.fileReads[p] ?? 0) + 1;
        toolRecord.filePath = p;
      }

      this.toolCalls.push(toolRecord);
      if (this.currentIteration !== null) {
        this.currentIteration.toolCalls.push(toolRecord);
      }
    }

    yield result;
  }

  override async *processError(
    context: MiddlewareContext,
    error: Error
  ): AsyncGenerator<unknown | AgentEvent> {
    this.errors.push({
      operation: context.operation,
      errorType: error.name || "Error",
      errorMessage: error.message
    });
    throw error;
  }

  /** Get the collected, aggregated metrics. */
  getMetrics(): Record<string, unknown> {
    const totalInput = this.iterations.reduce((sum, it) => sum + (it.inputTokens ?? 0), 0);
    const totalOutput = this.iterations.reduce((sum, it) => sum + (it.outputTokens ?? 0), 0);
    const uniqueFiles = Object.keys(this.fileReads).length;
    const totalReads = Object.values(this.fileReads).reduce((sum, c) => sum + c, 0);
    const duplicateReads = totalReads > uniqueFiles ? totalReads - uniqueFiles : 0;

    return {
      totalTokens: totalInput + totalOutput,
      inputTokens: totalInput,
      outputTokens: totalOutput,

      iterations: this.iterations.length,
      iterationDetails: this.iterations,

      tokenGrowth: this.iterations.map((it, i) => [it.index ?? i, it.inputTokens ?? 0]),

      toolCalls: this.toolCalls.length,
      toolCallDetails: this.toolCalls,
      toolsUsed: [...new Set(this.toolCalls.map((tc) => tc.name))],

      fileReads: this.fileReads,
      uniqueFiles,
      totalFileReads: totalReads,
      duplicateReads,
      duplicateReadRatio: totalReads > 0 ? duplicateReads / totalReads : 0,

      compactionEvents: this.compactionEvents.length,
      compactionDetails: this.compactionEvents,
      tokensSaved: this.compactionEvents.reduce((sum, e) => sum + (e.tokensSaved ?? 0), 0),

      errors: this.errors,
      errorCount: this.errors.length
    };
  }

  /** Record a compaction event. */
  recordCompaction(
    tokensBefore: number,
    tokensAfter: number,
    messagesBefore: number,
    messagesAfter: number
  ): void {
    this.compactionEvents.push({
      tokensBefore,
      tokensAfter,
      tokensSaved: tokensBefore - tokensAfter,
      messagesBefore,
      messagesAfter
    });
  }

  toString(): string {
    const metrics = this.getMetrics();
    return (
      `RunMiddleware(iterations=${metrics.iterations}, ` +
      `tokens=${metrics.totalTokens}, toolCalls=${metrics.toolCalls})`
    );
  }
}
