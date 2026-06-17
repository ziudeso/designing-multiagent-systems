/**
 * Evaluation system for picoagents-ts.
 *
 * A framework for testing and comparing picoagents components (agents, models,
 * and orchestrators). Mirrors the public API of the Python
 * `picoagents.eval` package.
 *
 * Notable omissions relative to the Python port (the TS port is a subset):
 * - `CopilotTarget`: omitted (no GitHub Copilot SDK binding).
 *
 * @example
 * ```ts
 * import {
 *   AgentConfig, EvalRunner, Dataset, EvalResults,
 *   PicoAgentTarget, LLMEvalJudge, loadBuiltinDataset, printResults
 * } from "picoagents/eval";
 *
 * const dataset = await loadBuiltinDataset("coding_v1");
 * const runner = new EvalRunner(new LLMEvalJudge(modelClient));
 * const results = await runner.run(dataset, [
 *   new AgentConfig({ name: "baseline", compaction: null }),
 *   new AgentConfig({ name: "head_tail", compaction: "head_tail" })
 * ]);
 * printResults(results);
 * ```
 */

// Eval-specific data types
export { EvalScore, RunTrajectory, Task } from "./types.js";
export type { EvalScoreInit, RunTrajectoryInit, TaskInit } from "./types.js";

// Base classes
export { EvalJudge, Target } from "./base.js";

// Runner
export { EvalRunner } from "./runner.js";
export type { Runnable, EvalRunnerOptions, EvalRunnerRunOptions } from "./runner.js";

// Targets
export {
  AgentEvalTarget,
  CallableTarget,
  ClaudeCodeTarget,
  ModelEvalTarget,
  OrchestratorEvalTarget,
  PicoAgentTarget
} from "./targets.js";
export type { ClaudeCodeTargetOptions } from "./targets.js";

// Judges
export {
  BaseEvalJudge,
  CompositeJudge,
  ContainsJudge,
  ExactMatchJudge,
  FuzzyMatchJudge,
  LLMEvalJudge
} from "./judges.js";
export type {
  AnswerStrategy,
  CompositeJudgeOptions,
  ContainsJudgeOptions,
  ExactMatchJudgeOptions,
  FuzzyMatchJudgeOptions,
  LLMEvalJudgeOptions
} from "./judges.js";

// Dataset
export { Dataset, listBuiltinDatasets, loadBuiltinDataset } from "./dataset.js";
export type { DatasetInit } from "./dataset.js";

// Config
export { AgentConfig } from "./config.js";
export type { AgentConfigInit } from "./config.js";

// Results
export {
  EvalResults,
  TargetSummary,
  TaskResult,
  listEvalResults,
  loadEvalResults
} from "./results.js";
export type { EvalResultsInit, TaskResultInit } from "./results.js";

// Middleware
export { RunMiddleware } from "./middleware.js";

// Analysis
export {
  formatFileReadAnalysis,
  formatSummaryTable,
  formatTaskBreakdown,
  formatTokenGrowth,
  printResults
} from "./analysis.js";
export type { PrintResultsOptions } from "./analysis.js";
