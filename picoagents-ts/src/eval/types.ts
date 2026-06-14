/**
 * Evaluation-specific data types for picoagents-ts.
 *
 * Ported from the evaluation section of Python `types.py` (Task, RunTrajectory,
 * EvalScore). These are intentionally NOT placed in the global `src/types.ts` -
 * they are eval-only and live alongside the rest of the eval module.
 */

import type { Message } from "../messages.js";
import { Usage } from "../types.js";

export interface TaskInit {
  /** Human-readable task name. */
  name: string;
  /** Input/prompt for the task. */
  input: string;
  /** Expected output for comparison. */
  expectedOutput?: string;
  /** Unique task identifier. */
  id?: string;
  /** Task category for filtering (default: "general"). */
  category?: string;
  /** Criteria to evaluate on. */
  evalCriteria?: string[];
  /** Per-criterion scoring guidance, e.g. {completeness: "10: All files. 5: Most. 0: None."}. */
  rubric?: Record<string, string>;
  /** Additional task metadata. */
  metadata?: Record<string, unknown>;
}

/** A task to run and evaluate. */
export class Task {
  name: string;
  input: string;
  expectedOutput?: string;
  id?: string;
  category: string;
  evalCriteria: string[];
  rubric: Record<string, string>;
  metadata: Record<string, unknown>;

  constructor(init: TaskInit) {
    this.name = init.name;
    this.input = init.input;
    this.expectedOutput = init.expectedOutput;
    this.id = init.id;
    this.category = init.category ?? "general";
    this.evalCriteria = init.evalCriteria ?? [];
    this.rubric = init.rubric ?? {};
    this.metadata = init.metadata ?? {};
  }
}

export interface RunTrajectoryInit {
  /** The task that was run. */
  task: Task;
  /** Complete message sequence. */
  messages: Message[];
  /** Whether execution succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Resource consumption. */
  usage?: Usage;
  /** Additional execution metadata. */
  metadata?: Record<string, unknown>;
}

/** What happened when a task was run against a target. */
export class RunTrajectory {
  task: Task;
  messages: Message[];
  success: boolean;
  error?: string;
  usage?: Usage;
  metadata: Record<string, unknown>;

  constructor(init: RunTrajectoryInit) {
    this.task = init.task;
    this.messages = init.messages;
    this.success = init.success;
    this.error = init.error;
    this.usage = init.usage;
    this.metadata = init.metadata ?? {};
  }
}

export interface EvalScoreInit {
  /** Overall score (0-10 scale). */
  overall: number;
  /** Scores by evaluation dimension. */
  dimensions?: Record<string, number>;
  /** Reasoning for each dimension. */
  reasoning?: Record<string, string>;
  /** The trajectory that was scored. */
  trajectory?: RunTrajectory;
  /** Additional scoring metadata. */
  metadata?: Record<string, unknown>;
}

/** Evaluation score with dimensional breakdown. */
export class EvalScore {
  overall: number;
  dimensions: Record<string, number>;
  reasoning: Record<string, string>;
  trajectory?: RunTrajectory;
  metadata: Record<string, unknown>;

  constructor(init: EvalScoreInit) {
    this.overall = init.overall;
    this.dimensions = init.dimensions ?? {};
    this.reasoning = init.reasoning ?? {};
    this.trajectory = init.trajectory;
    this.metadata = init.metadata ?? {};
  }

  /** Extract the final response from the trajectory. */
  getFinalResponse(): string {
    if (!this.trajectory || !this.trajectory.success || !this.trajectory.messages.length) {
      return `EXECUTION FAILED: ${this.trajectory ? this.trajectory.error ?? "" : "No trajectory"}`;
    }
    const finalMessage = this.trajectory.messages[this.trajectory.messages.length - 1]!;
    return finalMessage.content ?? String(finalMessage);
  }

  /** Get the complete conversation as a formatted string. */
  getFullConversation(): string {
    if (!this.trajectory || !this.trajectory.messages.length) {
      return `EXECUTION FAILED: ${this.trajectory ? this.trajectory.error ?? "" : "No trajectory"}`;
    }
    return this.trajectory.messages.map((msg) => msg.toString()).join("\n");
  }
}
