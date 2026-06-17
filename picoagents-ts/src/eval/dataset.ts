/**
 * Dataset definitions for evaluation.
 *
 * Defines Dataset - a collection of tasks with evaluation criteria. Ported from
 * Python `eval/_dataset.py`. Built-in datasets live as JSON files under
 * `src/eval/datasets/` (the Python port ships no built-ins, so this directory is
 * currently empty; user JSON files placed there are discovered at runtime).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Task } from "./types.js";

export interface DatasetInit {
  name: string;
  version?: string;
  description?: string;
  tasks?: Task[];
  categories?: string[];
  defaultEvalCriteria?: string[];
  metadata?: Record<string, unknown>;
}

/** A collection of tasks for evaluation. */
export class Dataset {
  name: string;
  version: string;
  description: string;
  tasks: Task[];
  categories: string[];
  defaultEvalCriteria: string[];
  metadata: Record<string, unknown>;

  constructor(init: DatasetInit) {
    this.name = init.name;
    this.version = init.version ?? "1.0.0";
    this.description = init.description ?? "";
    this.tasks = init.tasks ?? [];
    this.defaultEvalCriteria = init.defaultEvalCriteria ?? ["task_completion"];
    this.metadata = init.metadata ?? {};
    // Populate categories from tasks if not provided.
    this.categories =
      init.categories && init.categories.length
        ? init.categories
        : [...new Set(this.tasks.map((t) => t.category))];
  }

  /** Serialize dataset to a plain object. */
  toDict(): Record<string, unknown> {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      categories: this.categories,
      defaultEvalCriteria: this.defaultEvalCriteria,
      tasks: this.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        input: t.input,
        category: t.category,
        evalCriteria: t.evalCriteria,
        expectedOutput: t.expectedOutput,
        rubric: t.rubric,
        metadata: t.metadata
      })),
      metadata: this.metadata
    };
  }

  static fromDict(data: Record<string, any>): Dataset {
    const tasks: Task[] = (data.tasks ?? []).map(
      (t: Record<string, any>) =>
        new Task({
          name: t.name,
          input: t.input,
          id: t.id,
          category: t.category ?? "general",
          evalCriteria: t.eval_criteria ?? t.evalCriteria ?? ["task_completion"],
          expectedOutput: t.expected_output ?? t.expectedOutput,
          rubric: t.rubric ?? {},
          metadata: t.metadata ?? {}
        })
    );
    return new Dataset({
      name: data.name,
      version: data.version ?? "1.0.0",
      description: data.description ?? "",
      tasks,
      categories: data.categories ?? [],
      defaultEvalCriteria: data.default_eval_criteria ?? data.defaultEvalCriteria ?? ["task_completion"],
      metadata: data.metadata ?? {}
    });
  }

  /** Load a dataset from a JSON file. */
  static async fromJson(filePath: string): Promise<Dataset> {
    const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return Dataset.fromDict(data);
  }

  /** Save the dataset to a JSON file. */
  async toJson(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(this.toDict(), null, 2));
  }

  /** Return the subset of tasks matching a category. */
  filterByCategory(category: string): Dataset {
    const filtered = this.tasks.filter((t) => t.category === category);
    return new Dataset({
      name: `${this.name}_${category}`,
      version: this.version,
      description: `${this.description} (filtered: ${category})`,
      tasks: filtered,
      categories: [category],
      defaultEvalCriteria: this.defaultEvalCriteria,
      metadata: { ...this.metadata, filteredFrom: this.name }
    });
  }

  /** Return the subset of tasks matching the given IDs. */
  filterByIds(taskIds: string[]): Dataset {
    const idSet = new Set(taskIds);
    const filtered = this.tasks.filter((t) => t.id !== undefined && idSet.has(t.id));
    return new Dataset({
      name: `${this.name}_subset`,
      version: this.version,
      description: `${this.description} (subset)`,
      tasks: filtered,
      categories: [...new Set(filtered.map((t) => t.category))],
      defaultEvalCriteria: this.defaultEvalCriteria,
      metadata: { ...this.metadata, filteredFrom: this.name }
    });
  }

  /** Return the subset of tasks matching a predicate. */
  filter(predicate: (task: Task) => boolean): Dataset {
    const filtered = this.tasks.filter(predicate);
    return new Dataset({
      name: `${this.name}_filtered`,
      version: this.version,
      description: `${this.description} (custom filter)`,
      tasks: filtered,
      categories: [...new Set(filtered.map((t) => t.category))],
      defaultEvalCriteria: this.defaultEvalCriteria,
      metadata: { ...this.metadata, filteredFrom: this.name }
    });
  }

  /** Get a task by ID. */
  getTask(taskId: string): Task | undefined {
    return this.tasks.find((t) => t.id === taskId);
  }

  get length(): number {
    return this.tasks.length;
  }

  [Symbol.iterator](): Iterator<Task> {
    return this.tasks[Symbol.iterator]();
  }

  toString(): string {
    return `Dataset(name=${JSON.stringify(this.name)}, tasks=${this.tasks.length}, categories=${JSON.stringify(this.categories)})`;
  }
}

function datasetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "datasets");
}

/**
 * Load a built-in evaluation dataset by name (e.g. "coding_v1").
 *
 * @throws If the dataset is not found.
 */
export async function loadBuiltinDataset(name: string): Promise<Dataset> {
  const dir = datasetsDir();
  const filePath = path.join(dir, `${name}.json`);
  try {
    await fs.access(filePath);
    return Dataset.fromJson(filePath);
  } catch {
    const available = await listBuiltinDatasets();
    throw new Error(`Dataset '${name}' not found. Available: ${JSON.stringify(available)}`);
  }
}

/** List available built-in datasets. */
export async function listBuiltinDatasets(): Promise<string[]> {
  const dir = datasetsDir();
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
