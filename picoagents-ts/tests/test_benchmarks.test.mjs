import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  AgentConfig,
  AssistantMessage,
  CallableTarget,
  Dataset,
  EvalJudge,
  EvalResults,
  EvalScore,
  EvalRunner,
  RunMiddleware,
  RunTrajectory,
  Task,
  TaskResult,
  Usage,
  UserMessage,
  formatFileReadAnalysis,
  formatSummaryTable,
  formatTaskBreakdown,
  loadEvalResults
} from "../dist/index.js";
import { makeTempDir } from "./helpers.mjs";

class MockJudge extends EvalJudge {
  constructor(score = 8) {
    super("mock_judge");
    this.defaultScore = score;
    this.callCount = 0;
  }

  async score(trajectory, criteria = ["task_completion"]) {
    this.callCount += 1;
    return new EvalScore({
      overall: this.defaultScore,
      dimensions: Object.fromEntries(criteria.map((criterion) => [criterion, this.defaultScore])),
      reasoning: Object.fromEntries(criteria.map((criterion) => [criterion, "Mock score"])),
      trajectory,
      metadata: { mock: true }
    });
  }
}

function createSampleTask(id = "test_task", category = "general") {
  return new Task({
    id,
    name: `Task ${id}`,
    input: `Complete ${id}`,
    category,
    evalCriteria: ["task_completion", "efficiency"],
    rubric: {
      task_completion: "Task completed successfully",
      efficiency: "Completed with minimal resources"
    }
  });
}

function createSampleDataset(count = 3) {
  return new Dataset({
    name: "test_dataset",
    description: "A test dataset",
    version: "1.0",
    tasks: Array.from({ length: count }, (_, index) =>
      createSampleTask(`task_${index}`, index % 2 === 0 ? "test" : "other")
    ),
    defaultEvalCriteria: ["task_completion"]
  });
}

function createTrajectory(task, tokens = 600) {
  return new RunTrajectory({
    task,
    messages: [
      new UserMessage({ content: task.input, source: "user" }),
      new AssistantMessage({ content: "Done", source: "assistant" })
    ],
    success: true,
    usage: new Usage({
      durationMs: 100,
      llmCalls: 3,
      tokensInput: tokens / 2,
      tokensOutput: tokens / 2
    })
  });
}

function createTaskResult(taskId, targetName, score = 8, tokens = 1000) {
  const task = createSampleTask(taskId);
  const trajectory = createTrajectory(task, tokens);
  const evalScore = new EvalScore({
    overall: score,
    dimensions: { task_completion: score },
    reasoning: { task_completion: "Test" },
    trajectory
  });
  return new TaskResult({
    taskId,
    targetName,
    trajectory,
    score: evalScore,
    filesRead: { "file1.txt": 2, "file2.txt": 1 },
    uniqueFiles: 2,
    duplicateReads: 1
  });
}

test("benchmark AgentConfig, Task, and Dataset helpers match expected defaults", async () => {
  const config = new AgentConfig({ name: "test" });
  assert.equal(config.name, "test");
  assert.equal(config.modelProvider, "openai");
  assert.equal(config.modelName, "gpt-4o-mini");
  assert.equal(config.compaction, null);
  assert.equal(config.tokenBudget, 50_000);
  assert.equal(config.maxIterations, 30);

  const parsed = AgentConfig.fromString("candidate:strategy=head_tail,token_budget=80000");
  assert.equal(parsed.name, "candidate");
  assert.equal(parsed.compaction, "head_tail");
  assert.equal(parsed.tokenBudget, 80_000);

  const task = createSampleTask();
  assert.equal(task.category, "general");
  assert.deepEqual(task.evalCriteria, ["task_completion", "efficiency"]);

  const dataset = createSampleDataset(6);
  assert.equal(dataset.length, 6);
  assert.equal(dataset.filterByCategory("test").tasks.length, 3);
  assert.equal(dataset.getTask("task_1").id, "task_1");

  const dir = await makeTempDir("picoagents-benchmark-dataset-");
  const file = path.join(dir, "dataset.json");
  await dataset.toJson(file);
  const loaded = await Dataset.fromJson(file);
  assert.equal(loaded.name, "test_dataset");
  assert.equal(loaded.tasks.length, 6);
});

test("benchmark EvalResults summaries, comparisons, and persistence round-trip", async () => {
  const results = new EvalResults({ datasetName: "test", datasetVersion: "1.0" });
  for (const taskId of ["task_1", "task_2"]) {
    results.addResult(createTaskResult(taskId, "baseline", 7, 1000));
    results.addResult(createTaskResult(taskId, "optimized", 8, 600));
  }

  const summaries = results.getSummaries();
  assert.equal(summaries.baseline.taskCount, 2);
  assert.equal(summaries.baseline.totalTokens, 2000);
  assert.equal(summaries.optimized.totalTokens, 1200);

  const comparison = results.compareTargets("baseline");
  assert.equal(comparison.baseline.isBaseline, true);
  assert.equal(comparison.optimized.isBaseline, false);
  assert.equal(comparison.optimized.tokenDiffPct, -40);
  assert.equal(comparison.optimized.scoreDiff, 1);

  const dir = await makeTempDir("picoagents-benchmark-results-");
  const file = path.join(dir, "results.json");
  await results.save(file);
  const loaded = await loadEvalResults(file);
  assert.equal(loaded.datasetName, "test");
  assert.deepEqual(loaded.targetNames.sort(), ["baseline", "optimized"]);
});

test("benchmark RunMiddleware records compaction and reset state", () => {
  const middleware = new RunMiddleware();
  assert.equal(middleware.getMetrics().iterations, 0);
  assert.equal(middleware.getMetrics().totalTokens, 0);

  middleware.recordCompaction(10_000, 6_000, 50, 30);
  assert.equal(middleware.getMetrics().compactionEvents, 1);
  assert.equal(middleware.getMetrics().tokensSaved, 4_000);

  middleware.reset();
  assert.equal(middleware.getMetrics().compactionEvents, 0);
  assert.equal(middleware.getMetrics().tokensSaved, 0);
});

test("benchmark EvalRunner executes callable targets and task filters", async () => {
  const judge = new MockJudge(8);
  const target = new CallableTarget("simple", async (task) => createTrajectory(task, 500));
  const dataset = createSampleDataset(6);
  const runner = new EvalRunner(judge);

  const results = await runner.run(dataset, [target], {
    taskFilter: (task) => task.category === "test"
  });

  assert.deepEqual(results.targetNames, ["simple"]);
  assert.equal(results.taskIds.length, 3);
  assert.equal(judge.callCount, 3);
});

test("benchmark analysis formatters include summary, task, and file sections", () => {
  const results = new EvalResults({ datasetName: "test", datasetVersion: "1.0" });
  results.addResult(createTaskResult("test_task", "baseline", 8, 1000));
  results.addResult(createTaskResult("test_task", "optimized", 8, 700));

  assert.match(formatSummaryTable(results), /baseline/);
  assert.match(formatSummaryTable(results), /Tokens/);
  assert.match(formatTaskBreakdown(results), /Per-Task Breakdown/);
  assert.match(formatFileReadAnalysis(results), /File Read Analysis/);
});
