/**
 * Evaluation results and storage.
 *
 * Defines TaskResult, TargetSummary, and EvalResults - the data structures for
 * storing and analyzing evaluation execution results, plus JSON file persistence
 * (loadEvalResults / listEvalResults). Ported from Python `eval/_results.py`.
 *
 * Persistence uses Node `fs`/`path`. The default output directory mirrors Python:
 * `./.picoagents/eval/`. The on-disk JSON schema is preserved so `loadEvalResults`
 * round-trips files written by `EvalResults.save()`.
 */

import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  UserMessage
} from "../messages.js";
import { Usage } from "../types.js";
import { EvalScore, RunTrajectory, Task } from "./types.js";

export interface TaskResultInit {
  taskId: string;
  targetName: string;
  trajectory: RunTrajectory;
  score: EvalScore;
  filesRead?: Record<string, number>;
  uniqueFiles?: number;
  duplicateReads?: number;
  compactionEvents?: number;
  tokensSaved?: number;
  metrics?: Record<string, unknown>;
}

/** Result of running one task with one target. */
export class TaskResult {
  taskId: string;
  targetName: string;
  trajectory: RunTrajectory;
  score: EvalScore;
  filesRead: Record<string, number>;
  uniqueFiles: number;
  duplicateReads: number;
  compactionEvents: number;
  tokensSaved: number;
  metrics: Record<string, unknown>;

  constructor(init: TaskResultInit) {
    this.taskId = init.taskId;
    this.targetName = init.targetName;
    this.trajectory = init.trajectory;
    this.score = init.score;
    this.filesRead = init.filesRead ?? {};
    this.uniqueFiles = init.uniqueFiles ?? 0;
    this.duplicateReads = init.duplicateReads ?? 0;
    this.compactionEvents = init.compactionEvents ?? 0;
    this.tokensSaved = init.tokensSaved ?? 0;
    this.metrics = init.metrics ?? {};
  }

  get totalTokens(): number {
    return this.trajectory.usage
      ? this.trajectory.usage.tokensInput + this.trajectory.usage.tokensOutput
      : 0;
  }

  get inputTokens(): number {
    return this.trajectory.usage ? this.trajectory.usage.tokensInput : 0;
  }

  get outputTokens(): number {
    return this.trajectory.usage ? this.trajectory.usage.tokensOutput : 0;
  }

  get iterations(): number {
    return this.trajectory.usage ? this.trajectory.usage.llmCalls : 0;
  }

  get durationMs(): number {
    return this.trajectory.usage ? this.trajectory.usage.durationMs : 0;
  }

  /** Serialize the result to a plain object (includes full message trace). */
  toDict(): Record<string, unknown> {
    return {
      task_id: this.taskId,
      target_name: this.targetName,
      score: {
        overall: this.score.overall,
        dimensions: this.score.dimensions,
        reasoning: this.score.reasoning,
        metadata: this.score.metadata ?? {}
      },
      total_tokens: this.totalTokens,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      iterations: this.iterations,
      duration_ms: this.durationMs,
      files_read: this.filesRead,
      unique_files: this.uniqueFiles,
      duplicate_reads: this.duplicateReads,
      compaction_events: this.compactionEvents,
      tokens_saved: this.tokensSaved,
      metrics: this.metrics,
      success: this.trajectory.success,
      error: this.trajectory.error ?? null,
      trace: {
        messages: serializeMessages(this.trajectory.messages),
        events: (this.trajectory.metadata.events as unknown[]) ?? [],
        event_count: (this.trajectory.metadata.event_count as number) ?? 0
      }
    };
  }

  toString(): string {
    return (
      `TaskResult(task=${JSON.stringify(this.taskId)}, target=${JSON.stringify(this.targetName)}, ` +
      `score=${this.score.overall.toFixed(1)}, tokens=${this.totalTokens})`
    );
  }
}

/** Aggregated statistics for a single target across all tasks. */
export class TargetSummary {
  targetName: string;
  taskCount = 0;
  avgScore = 0.0;
  minScore = 0.0;
  maxScore = 0.0;
  totalTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  avgTokensPerTask = 0.0;
  totalIterations = 0;
  avgIterationsPerTask = 0.0;
  totalDurationMs = 0;
  avgDurationPerTaskMs = 0.0;
  totalUniqueFiles = 0;
  totalDuplicateReads = 0;
  duplicateReadRatio = 0.0;
  totalCompactionEvents = 0;
  totalTokensSaved = 0;
  successCount = 0;
  successRate = 0.0;

  constructor(init: Partial<TargetSummary> & { targetName: string }) {
    this.targetName = init.targetName;
    Object.assign(this, init);
  }

  toDict(): Record<string, unknown> {
    return {
      target_name: this.targetName,
      task_count: this.taskCount,
      avg_score: this.avgScore,
      min_score: this.minScore,
      max_score: this.maxScore,
      total_tokens: this.totalTokens,
      avg_tokens_per_task: this.avgTokensPerTask,
      total_iterations: this.totalIterations,
      avg_iterations_per_task: this.avgIterationsPerTask,
      total_duration_ms: this.totalDurationMs,
      avg_duration_per_task_ms: this.avgDurationPerTaskMs,
      total_unique_files: this.totalUniqueFiles,
      total_duplicate_reads: this.totalDuplicateReads,
      duplicate_read_ratio: this.duplicateReadRatio,
      total_compaction_events: this.totalCompactionEvents,
      total_tokens_saved: this.totalTokensSaved,
      success_count: this.successCount,
      success_rate: this.successRate
    };
  }
}

export interface EvalResultsInit {
  runId?: string;
  timestamp?: Date;
  datasetName?: string;
  datasetVersion?: string;
  metadata?: Record<string, unknown>;
}

/** Complete results from an evaluation run (target x task matrix + summaries). */
export class EvalResults {
  runId: string;
  timestamp: Date;
  datasetName: string;
  datasetVersion: string;
  targetNames: string[] = [];
  taskIds: string[] = [];
  results: Record<string, Record<string, TaskResult>> = {};
  metadata: Record<string, unknown>;

  private summariesCache: Record<string, TargetSummary> | null = null;

  constructor(init: EvalResultsInit = {}) {
    this.runId = init.runId ?? randomUUID().slice(0, 8);
    this.timestamp = init.timestamp ?? new Date();
    this.datasetName = init.datasetName ?? "";
    this.datasetVersion = init.datasetVersion ?? "";
    this.metadata = init.metadata ?? {};
  }

  /** Add a task result. */
  addResult(result: TaskResult): void {
    if (!(result.targetName in this.results)) {
      this.results[result.targetName] = {};
      if (!this.targetNames.includes(result.targetName)) {
        this.targetNames.push(result.targetName);
      }
    }
    this.results[result.targetName]![result.taskId] = result;
    if (!this.taskIds.includes(result.taskId)) {
      this.taskIds.push(result.taskId);
    }
    this.summariesCache = null;
  }

  /** Get a specific result. */
  getResult(targetName: string, taskId: string): TaskResult | undefined {
    return this.results[targetName]?.[taskId];
  }

  /** Compute (and cache) summaries for each target. */
  getSummaries(): Record<string, TargetSummary> {
    if (this.summariesCache !== null) return this.summariesCache;

    const summaries: Record<string, TargetSummary> = {};
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

    for (const targetName of this.targetNames) {
      const targetResults = Object.values(this.results[targetName] ?? {});
      if (!targetResults.length) continue;

      const scores = targetResults.map((r) => r.score.overall);
      const tokens = targetResults.map((r) => r.totalTokens);
      const iterations = targetResults.map((r) => r.iterations);
      const durations = targetResults.map((r) => r.durationMs);
      const uniqueFiles = targetResults.map((r) => r.uniqueFiles);
      const duplicateReads = targetResults.map((r) => r.duplicateReads);
      const compactionEvents = targetResults.map((r) => r.compactionEvents);
      const tokensSaved = targetResults.map((r) => r.tokensSaved);
      const successes = targetResults.map((r) => (r.trajectory.success ? 1 : 0));
      const totalFiles = sum(uniqueFiles) + sum(duplicateReads);
      const n = targetResults.length;

      summaries[targetName] = new TargetSummary({
        targetName,
        taskCount: n,
        avgScore: scores.length ? sum(scores) / scores.length : 0,
        minScore: scores.length ? Math.min(...scores) : 0,
        maxScore: scores.length ? Math.max(...scores) : 0,
        totalTokens: sum(tokens),
        totalInputTokens: sum(targetResults.map((r) => r.inputTokens)),
        totalOutputTokens: sum(targetResults.map((r) => r.outputTokens)),
        avgTokensPerTask: tokens.length ? sum(tokens) / tokens.length : 0,
        totalIterations: sum(iterations),
        avgIterationsPerTask: iterations.length ? sum(iterations) / iterations.length : 0,
        totalDurationMs: sum(durations),
        avgDurationPerTaskMs: durations.length ? sum(durations) / durations.length : 0,
        totalUniqueFiles: sum(uniqueFiles),
        totalDuplicateReads: sum(duplicateReads),
        duplicateReadRatio: totalFiles > 0 ? sum(duplicateReads) / totalFiles : 0,
        totalCompactionEvents: sum(compactionEvents),
        totalTokensSaved: sum(tokensSaved),
        successCount: sum(successes),
        successRate: successes.length ? sum(successes) / successes.length : 0
      });
    }

    this.summariesCache = summaries;
    return summaries;
  }

  /** Generate comparison metrics vs a baseline target. */
  compareTargets(baseline?: string): Record<string, Record<string, unknown>> {
    const summaries = this.getSummaries();
    if (!Object.keys(summaries).length) return {};

    const baselineName = baseline ?? (this.targetNames.length ? this.targetNames[0]! : undefined);
    if (!baselineName || !(baselineName in summaries)) return {};

    const baselineSummary = summaries[baselineName]!;
    const comparison: Record<string, Record<string, unknown>> = {};

    for (const [targetName, summary] of Object.entries(summaries)) {
      const comp: Record<string, unknown> = {
        target_name: targetName,
        is_baseline: targetName === baselineName
      };

      if (baselineSummary.totalTokens > 0) {
        const tokenDiff = summary.totalTokens - baselineSummary.totalTokens;
        comp.token_diff = tokenDiff;
        comp.token_diff_pct = (tokenDiff / baselineSummary.totalTokens) * 100;
      } else {
        comp.token_diff = 0;
        comp.token_diff_pct = 0;
      }

      comp.score_diff = summary.avgScore - baselineSummary.avgScore;

      if (baselineSummary.totalIterations > 0) {
        const iterDiff = summary.totalIterations - baselineSummary.totalIterations;
        comp.iteration_diff = iterDiff;
        comp.iteration_diff_pct = (iterDiff / baselineSummary.totalIterations) * 100;
      } else {
        comp.iteration_diff = 0;
        comp.iteration_diff_pct = 0;
      }

      if (baselineSummary.totalDurationMs > 0) {
        const durDiff = summary.totalDurationMs - baselineSummary.totalDurationMs;
        comp.duration_diff_ms = durDiff;
        comp.duration_diff_pct = (durDiff / baselineSummary.totalDurationMs) * 100;
      } else {
        comp.duration_diff_ms = 0;
        comp.duration_diff_pct = 0;
      }

      comparison[targetName] = comp;
    }

    return comparison;
  }

  /** Serialize results to a plain object. */
  toDict(): Record<string, unknown> {
    const summaries = this.getSummaries();
    return {
      run_id: this.runId,
      timestamp: this.timestamp.toISOString(),
      dataset_name: this.datasetName,
      dataset_version: this.datasetVersion,
      target_names: this.targetNames,
      task_ids: this.taskIds,
      results: Object.fromEntries(
        Object.entries(this.results).map(([target, tasks]) => [
          target,
          Object.fromEntries(Object.entries(tasks).map(([taskId, result]) => [taskId, result.toDict()]))
        ])
      ),
      summaries: Object.fromEntries(Object.entries(summaries).map(([name, s]) => [name, s.toDict()])),
      metadata: this.metadata
    };
  }

  /** Serialize results to a JSON string. */
  toJson(): string {
    return JSON.stringify(this.toDict(), null, 2);
  }

  /**
   * Save results to a JSON file.
   *
   * @param filePath Output path (default: `./.picoagents/eval/eval_{runId}_{ts}.json`).
   * @returns The path the file was written to.
   */
  async save(filePath?: string): Promise<string> {
    let target = filePath;
    if (!target) {
      const outputDir = path.join(process.cwd(), ".picoagents", "eval");
      await fs.mkdir(outputDir, { recursive: true });
      const ts = formatTimestamp(this.timestamp);
      target = path.join(outputDir, `eval_${this.runId}_${ts}.json`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, this.toJson());
    return target;
  }

  toString(): string {
    return (
      `EvalResults(run_id=${JSON.stringify(this.runId)}, dataset=${JSON.stringify(this.datasetName)}, ` +
      `targets=${this.targetNames.length}, tasks=${this.taskIds.length})`
    );
  }
}

/**
 * Load evaluation results from a JSON file, reconstructing full TaskResults
 * including scores, rationale, and message traces.
 */
export async function loadEvalResults(filePath: string): Promise<EvalResults> {
  const data = JSON.parse(await fs.readFile(filePath, "utf-8"));

  const results = new EvalResults({
    runId: data.run_id,
    timestamp: new Date(data.timestamp),
    datasetName: data.dataset_name,
    datasetVersion: data.dataset_version ?? "",
    metadata: data.metadata ?? {}
  });

  for (const [targetName, tasks] of Object.entries(data.results ?? {})) {
    for (const [taskId, resultData] of Object.entries(tasks as Record<string, any>)) {
      const trace = resultData.trace ?? {};
      const messages = deserializeMessages(trace.messages ?? []);

      const trajectory = new RunTrajectory({
        task: new Task({ name: taskId, input: "" }),
        messages,
        success: resultData.success ?? false,
        error: resultData.error ?? undefined,
        usage: new Usage({
          durationMs: resultData.duration_ms ?? 0,
          llmCalls: resultData.iterations ?? 0,
          tokensInput: resultData.input_tokens ?? 0,
          tokensOutput: resultData.output_tokens ?? 0
        }),
        metadata: { events: trace.events ?? [] }
      });

      const scoreData = resultData.score ?? {};
      const score = new EvalScore({
        overall: scoreData.overall ?? 0.0,
        dimensions: scoreData.dimensions ?? {},
        reasoning: scoreData.reasoning ?? {},
        trajectory,
        metadata: scoreData.metadata ?? {}
      });

      results.addResult(
        new TaskResult({
          taskId,
          targetName,
          trajectory,
          score,
          filesRead: resultData.files_read ?? {},
          uniqueFiles: resultData.unique_files ?? 0,
          duplicateReads: resultData.duplicate_reads ?? 0,
          compactionEvents: resultData.compaction_events ?? 0,
          tokensSaved: resultData.tokens_saved ?? 0,
          metrics: resultData.metrics ?? {}
        })
      );
    }
  }

  return results;
}

/**
 * List saved evaluation result files (newest first).
 *
 * @param outputDir Directory to search (default: `./.picoagents/eval/`).
 */
export async function listEvalResults(outputDir?: string): Promise<string[]> {
  const dir = outputDir ?? path.join(process.cwd(), ".picoagents", "eval");
  if (!existsSync(dir)) return [];

  const files = (await fs.readdir(dir)).filter(
    (f) => (f.startsWith("eval_") || f.startsWith("benchmark_")) && f.endsWith(".json")
  );
  const full = files.map((f) => path.join(dir, f));
  return full.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function serializeMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    const msgDict: Record<string, unknown> = {
      type: msg.constructor.name,
      content: msg.content ?? null,
      source: msg.source ?? null
    };

    if (msg instanceof AssistantMessage && msg.toolCalls?.length) {
      msgDict.tool_calls = msg.toolCalls.map((tc) => ({
        tool_name: tc.toolName,
        parameters: tc.parameters,
        call_id: tc.callId
      }));
      if (msg.usage) {
        msgDict.usage = {
          tokens_input: msg.usage.tokensInput,
          tokens_output: msg.usage.tokensOutput
        };
      }
    } else if (msg instanceof AssistantMessage && msg.usage) {
      msgDict.usage = {
        tokens_input: msg.usage.tokensInput,
        tokens_output: msg.usage.tokensOutput
      };
    }

    if (msg instanceof ToolMessage) {
      msgDict.tool_call_id = msg.toolCallId;
      msgDict.tool_name = msg.toolName;
      msgDict.success = msg.success;
      if (msg.error) msgDict.error = msg.error;
      if (Object.keys(msg.metadata).length) msgDict.metadata = msg.metadata;
    }

    return msgDict;
  });
}

function deserializeMessages(serialized: Array<Record<string, any>>): Message[] {
  const messages: Message[] = [];
  for (const msgData of serialized) {
    if (msgData.content === null || msgData.content === undefined) continue;
    const type = msgData.type;
    const content = String(msgData.content);
    const source = msgData.source ?? "unknown";

    try {
      if (type === "SystemMessage") {
        messages.push(new SystemMessage({ content, source }));
      } else if (type === "UserMessage") {
        messages.push(new UserMessage({ content, source }));
      } else if (type === "AssistantMessage") {
        let toolCalls: ToolCallRequest[] | undefined;
        if (Array.isArray(msgData.tool_calls) && msgData.tool_calls.length) {
          toolCalls = msgData.tool_calls.map(
            (tc: Record<string, any>) =>
              new ToolCallRequest({
                toolName: tc.tool_name,
                parameters: tc.parameters ?? {},
                callId: tc.call_id ?? ""
              })
          );
        }
        messages.push(new AssistantMessage({ content, source, toolCalls }));
      } else if (type === "ToolMessage") {
        messages.push(
          new ToolMessage({
            content,
            source,
            toolCallId: msgData.tool_call_id ?? "",
            toolName: msgData.tool_name ?? "unknown",
            success: msgData.success ?? true,
            error: msgData.error,
            metadata: msgData.metadata
          })
        );
      }
    } catch {
      // Skip messages that fail to reconstruct.
    }
  }
  return messages;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
