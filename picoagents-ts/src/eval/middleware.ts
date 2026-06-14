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
  input_tokens: number;
  output_tokens: number;
  tool_calls: ToolRecord[];
  message_count: number;
  tool_call_count?: number;
}

interface ToolRecord {
  name: string;
  parameters: Record<string, unknown>;
  success: boolean;
  file_path?: string;
}

interface CompactionEvent {
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
  messages_before: number;
  messages_after: number;
}

interface ErrorRecord {
  operation: string;
  error_type: string;
  error_message: string;
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
        input_tokens: 0,
        output_tokens: 0,
        tool_calls: [],
        message_count: Array.isArray(context.data) ? context.data.length : 0
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
        this.currentIteration.input_tokens = res.usage.tokensInput ?? 0;
        this.currentIteration.output_tokens = res.usage.tokensOutput ?? 0;
      }
      if (res && res.message && Array.isArray(res.message.toolCalls)) {
        this.currentIteration.tool_call_count = res.message.toolCalls.length;
      }
      this.iterations.push(this.currentIteration);
      this.currentIteration = null;
    } else if (context.operation === "tool_call") {
      const data = context.data as { toolName?: string; parameters?: Record<string, unknown> } | undefined;
      const toolName = data?.toolName ?? "unknown";
      const parameters = data?.parameters ?? {};

      const toolRecord: ToolRecord = {
        name: toolName,
        parameters,
        success: result ? Boolean((result as { success?: unknown }).success) : false
      };

      if (toolName === "read_file" || toolName === "Read" || toolName === "read") {
        const p =
          (parameters.path as string | undefined) ??
          (parameters.file_path as string | undefined) ??
          (parameters.filename as string | undefined) ??
          "unknown";
        this.fileReads[p] = (this.fileReads[p] ?? 0) + 1;
        toolRecord.file_path = p;
      }

      this.toolCalls.push(toolRecord);
      if (this.currentIteration !== null) {
        this.currentIteration.tool_calls.push(toolRecord);
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
      error_type: error.name || "Error",
      error_message: error.message
    });
    throw error;
  }

  /** Get the collected, aggregated metrics. */
  getMetrics(): Record<string, unknown> {
    const totalInput = this.iterations.reduce((sum, it) => sum + (it.input_tokens ?? 0), 0);
    const totalOutput = this.iterations.reduce((sum, it) => sum + (it.output_tokens ?? 0), 0);
    const uniqueFiles = Object.keys(this.fileReads).length;
    const totalReads = Object.values(this.fileReads).reduce((sum, c) => sum + c, 0);
    const duplicateReads = totalReads > uniqueFiles ? totalReads - uniqueFiles : 0;

    return {
      total_tokens: totalInput + totalOutput,
      input_tokens: totalInput,
      output_tokens: totalOutput,

      iterations: this.iterations.length,
      iteration_details: this.iterations,

      token_growth: this.iterations.map((it, i) => [it.index ?? i, it.input_tokens ?? 0]),

      tool_calls: this.toolCalls.length,
      tool_call_details: this.toolCalls,
      tools_used: [...new Set(this.toolCalls.map((tc) => tc.name))],

      file_reads: this.fileReads,
      unique_files: uniqueFiles,
      total_file_reads: totalReads,
      duplicate_reads: duplicateReads,
      duplicate_read_ratio: totalReads > 0 ? duplicateReads / totalReads : 0,

      compaction_events: this.compactionEvents.length,
      compaction_details: this.compactionEvents,
      tokens_saved: this.compactionEvents.reduce((sum, e) => sum + (e.tokens_saved ?? 0), 0),

      errors: this.errors,
      error_count: this.errors.length
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
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_saved: tokensBefore - tokensAfter,
      messages_before: messagesBefore,
      messages_after: messagesAfter
    });
  }

  toString(): string {
    const metrics = this.getMetrics();
    return (
      `RunMiddleware(iterations=${metrics.iterations}, ` +
      `tokens=${metrics.total_tokens}, tool_calls=${metrics.tool_calls})`
    );
  }
}
