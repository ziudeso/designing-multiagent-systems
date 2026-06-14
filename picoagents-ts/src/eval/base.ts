/**
 * Base classes for the evaluation system.
 *
 * Defines the abstract base classes: Target (what we run tasks against) and
 * EvalJudge (what scores the results). Ported from Python `eval/_base.py`.
 */

import type { CancellationToken } from "../cancellation.js";
import { EvalScore, RunTrajectory, Task } from "./types.js";

/**
 * Abstract base class for anything that can run tasks.
 *
 * A target wraps a system under test (agent, model, etc.) and provides a uniform
 * interface: give it a Task, get back a RunTrajectory.
 */
export abstract class Target {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Execute the task and return the complete trajectory.
   *
   * @param task The task to execute.
   * @param cancellationToken Optional token to cancel execution.
   */
  abstract run(task: Task, cancellationToken?: CancellationToken): Promise<RunTrajectory>;

  toString(): string {
    return `${this.constructor.name}(name=${JSON.stringify(this.name)})`;
  }
}

/** Abstract base class for evaluation judges. */
export abstract class EvalJudge {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Score a run trajectory.
   *
   * @param trajectory The execution trajectory to score.
   * @param criteria Optional list of evaluation dimensions to score. If not
   *   provided, uses `trajectory.task.evalCriteria`, falling back to defaults.
   * @param cancellationToken Optional token to cancel scoring.
   */
  abstract score(
    trajectory: RunTrajectory,
    criteria?: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore>;
}
