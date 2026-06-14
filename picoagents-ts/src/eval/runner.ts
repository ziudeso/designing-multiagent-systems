/**
 * Evaluation runner - orchestrates evaluation execution.
 *
 * EvalRunner executes tasks against targets, scores results with judges, and
 * collects metrics. Ported from Python `eval/_runner.py`.
 *
 * `run()` accepts any mix of Target, AgentConfig, or BaseAgent instances; they
 * are auto-resolved to the appropriate Target wrapper.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BaseAgent } from "../agents/base.js";
import type { CancellationToken } from "../cancellation.js";
import { Usage } from "../types.js";
import { EvalJudge, Target } from "./base.js";
import { AgentConfig } from "./config.js";
import { Dataset } from "./dataset.js";
import { RunMiddleware } from "./middleware.js";
import { EvalResults, TaskResult } from "./results.js";
import { AgentEvalTarget, PicoAgentTarget } from "./targets.js";
import { EvalScore, RunTrajectory, Task } from "./types.js";

/**
 * Anything that can be passed to `EvalRunner.run()` as a target.
 * - `Target`: used as-is
 * - `AgentConfig`: wrapped in `PicoAgentTarget` (fresh agent per task)
 * - `BaseAgent`: wrapped in `AgentEvalTarget` (reuses instance)
 */
export type Runnable = Target | AgentConfig | BaseAgent;

export interface EvalRunnerOptions {
  /** Run tasks in parallel (default: false for fair comparison). */
  parallelTasks?: boolean;
  /** Run targets in parallel (default: false). */
  parallelTargets?: boolean;
}

export interface EvalRunnerRunOptions {
  taskFilter?: (task: Task) => boolean;
  cancellationToken?: CancellationToken;
}

/** Runs evaluation tasks against targets and scores the results. */
export class EvalRunner {
  judge: EvalJudge;
  parallelTasks: boolean;
  parallelTargets: boolean;

  constructor(judge: EvalJudge, options: EvalRunnerOptions = {}) {
    this.judge = judge;
    this.parallelTasks = options.parallelTasks ?? false;
    this.parallelTargets = options.parallelTargets ?? false;
  }

  // --- Simple mode ---

  /** Evaluate a target on multiple tasks (simple mode). */
  async evaluate(
    target: Target,
    tasks: Task[],
    criteria?: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore[]> {
    if (this.parallelTasks) {
      return Promise.all(
        tasks.map((task) => this.evaluateSingle(target, task, criteria, cancellationToken))
      );
    }
    const scores: EvalScore[] = [];
    for (const task of tasks) {
      if (cancellationToken?.isCancelled()) break;
      scores.push(await this.evaluateSingle(target, task, criteria, cancellationToken));
    }
    return scores;
  }

  private async evaluateSingle(
    target: Target,
    task: Task,
    criteria?: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore> {
    try {
      const trajectory = await target.run(task, cancellationToken);
      return await this.judge.score(trajectory, criteria, cancellationToken);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failedTrajectory = new RunTrajectory({
        task,
        messages: [],
        success: false,
        error: message,
        usage: new Usage(),
        metadata: { error: message }
      });
      const dims = criteria ?? ["accuracy"];
      const dimensions: Record<string, number> = {};
      const reasoning: Record<string, string> = {};
      for (const dim of dims) {
        dimensions[dim] = 0.0;
        reasoning[dim] = `Execution failed: ${message}`;
      }
      return new EvalScore({
        overall: 0.0,
        dimensions,
        reasoning,
        trajectory: failedTrajectory,
        metadata: { error: message, judge: this.judge.name }
      });
    }
  }

  // --- Full mode ---

  private static resolveTarget(item: Runnable): Target {
    if (item instanceof Target) return item;
    if (item instanceof AgentConfig) return new PicoAgentTarget(item);
    if (item instanceof BaseAgent) return new AgentEvalTarget(item);
    throw new TypeError(
      `Expected Target, AgentConfig, or BaseAgent, got ${(item as object)?.constructor?.name ?? typeof item}`
    );
  }

  /**
   * Execute a full evaluation of a dataset against multiple targets.
   *
   * Each PicoAgentTarget task (with no explicit workspace) runs in an isolated
   * temp directory so targets don't share filesystem state.
   */
  async run(
    dataset: Dataset,
    targets: Runnable[],
    options: EvalRunnerRunOptions = {}
  ): Promise<EvalResults> {
    const { taskFilter, cancellationToken } = options;
    const resolvedTargets = targets.map((t) => EvalRunner.resolveTarget(t));
    let tasks = [...dataset.tasks];
    if (taskFilter) tasks = tasks.filter(taskFilter);

    const results = new EvalResults({
      datasetName: dataset.name,
      datasetVersion: dataset.version
    });

    if (this.parallelTargets) {
      const targetResults = await Promise.allSettled(
        resolvedTargets.map((target) => this.runTarget(target, tasks, dataset, cancellationToken))
      );
      for (const settled of targetResults) {
        if (settled.status !== "fulfilled") continue;
        for (const taskResult of settled.value) results.addResult(taskResult);
      }
    } else {
      for (const target of resolvedTargets) {
        if (cancellationToken?.isCancelled()) break;
        const taskResults = await this.runTarget(target, tasks, dataset, cancellationToken);
        for (const taskResult of taskResults) results.addResult(taskResult);
      }
    }

    return results;
  }

  private async runTarget(
    target: Target,
    tasks: Task[],
    dataset: Dataset,
    cancellationToken?: CancellationToken
  ): Promise<TaskResult[]> {
    if (this.parallelTasks) {
      const settled = await Promise.allSettled(
        tasks.map((task) => this.runSingleTask(target, task, dataset, cancellationToken))
      );
      return settled
        .filter((s): s is PromiseFulfilledResult<TaskResult> => s.status === "fulfilled")
        .map((s) => s.value);
    }

    const results: TaskResult[] = [];
    for (const task of tasks) {
      if (cancellationToken?.isCancelled()) break;
      results.push(await this.runSingleTask(target, task, dataset, cancellationToken));
    }
    return results;
  }

  private async runSingleTask(
    target: Target,
    task: Task,
    dataset: Dataset,
    cancellationToken?: CancellationToken
  ): Promise<TaskResult> {
    const middleware = new RunMiddleware();
    const taskId = task.id ?? task.name;

    const needsTemp = target instanceof PicoAgentTarget && target.config.workspace === undefined;
    let taskWorkspace: string | undefined;
    if (needsTemp) {
      taskWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), `eval_${target.name}_${taskId}_`));
    }

    let trajectory: RunTrajectory;
    try {
      if (target instanceof PicoAgentTarget) {
        let taskTarget: PicoAgentTarget;
        if (needsTemp && taskWorkspace) {
          // Copy config with the temp workspace (never mutates the original).
          const taskConfig = new AgentConfig({ ...target.config, workspace: taskWorkspace });
          taskTarget = new PicoAgentTarget(taskConfig, target.middlewares);
        } else {
          taskTarget = target;
        }
        trajectory = await taskTarget.run(task, cancellationToken, { middlewares: [middleware] });
      } else if (target instanceof AgentEvalTarget) {
        target.agent.middlewareChain.add(middleware);
        try {
          trajectory = await target.run(task, cancellationToken);
        } finally {
          target.agent.middlewareChain.remove(middleware);
        }
      } else {
        trajectory = await target.run(task, cancellationToken);
      }
    } finally {
      if (taskWorkspace) {
        await fs.rm(taskWorkspace, { recursive: true, force: true });
      }
    }

    const criteria = task.evalCriteria.length ? task.evalCriteria : dataset.defaultEvalCriteria;
    const score = await this.scoreTrajectory(trajectory, criteria, cancellationToken);
    const metrics = middleware.getMetrics();

    return new TaskResult({
      taskId,
      targetName: target.name,
      trajectory,
      score,
      filesRead: (metrics.file_reads as Record<string, number>) ?? {},
      uniqueFiles: (metrics.unique_files as number) ?? 0,
      duplicateReads: (metrics.duplicate_reads as number) ?? 0,
      compactionEvents: (metrics.compaction_events as number) ?? 0,
      tokensSaved: (metrics.tokens_saved as number) ?? 0,
      metrics
    });
  }

  private async scoreTrajectory(
    trajectory: RunTrajectory,
    criteria: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore> {
    try {
      return await this.judge.score(trajectory, criteria, cancellationToken);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const dimensions: Record<string, number> = {};
      const reasoning: Record<string, string> = {};
      for (const c of criteria) {
        dimensions[c] = 0.0;
        reasoning[c] = `Judge error: ${message}`;
      }
      return new EvalScore({
        overall: 0.0,
        dimensions,
        reasoning,
        trajectory,
        metadata: { judge_error: message }
      });
    }
  }
}
