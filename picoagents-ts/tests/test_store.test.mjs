import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  Agent,
  AssistantMessage,
  EvalResults,
  EvalScore,
  PicoStore,
  RunTrajectory,
  Task,
  TaskResult,
  Usage,
  UserMessage,
  getDefaultStore,
  setDefaultStore
} from "../dist/index.js";
import { createMockClient, makeTempDir } from "./helpers.mjs";

function makeStore(dir) {
  return new PicoStore({
    dbPath: path.join(dir, "picoagents.db"),
    runsDir: path.join(dir, "runs"),
    evalDir: path.join(dir, "eval")
  });
}

function makeAgent(name = "store-agent") {
  return new Agent({
    name,
    instructions: "Reply with the fixture response.",
    modelClient: createMockClient({ model: "store-model", responses: ["stored response"] })
  });
}

function makeTaskResult(taskId = "task-1", targetName = "target-a") {
  const task = new Task({
    id: taskId,
    name: "Store task",
    input: "answer",
    expectedOutput: "ok"
  });
  const messages = [
    new UserMessage({ content: "answer", source: "user" }),
    new AssistantMessage({ content: "ok", source: targetName })
  ];
  const trajectory = new RunTrajectory({
    task,
    messages,
    success: true,
    usage: new Usage({ durationMs: 12, llmCalls: 1, tokensInput: 4, tokensOutput: 2, toolCalls: 0 })
  });
  const score = new EvalScore({
    overall: 8,
    dimensions: { task_completion: 8 },
    reasoning: { task_completion: "completed" },
    trajectory
  });
  return new TaskResult({ taskId, targetName, trajectory, score });
}

test("PicoStore persists and deletes agent runs", async () => {
  const dir = await makeTempDir("picoagents-store-runs-");
  const store = makeStore(dir);
  const compatible = new PicoStore({
    connectionString: `sqlite+aiosqlite:///${path.join(dir, "compatible.db")}`,
    runsDir: path.join(dir, "compatible-runs"),
    evalDir: path.join(dir, "compatible-eval"),
    forceJsonIndex: true
  });
  assert.equal(compatible.dbPath, path.join(dir, "compatible.db"));
  await compatible.close();

  const agent = makeAgent();
  const response = await agent.run("persist this task");

  const runId = await store.saveAgentRun(agent, response, { traceId: "trace-1", tags: ["unit"] });
  const runs = await store.listRuns({ agentName: "store-agent" });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, runId);
  assert.equal(runs[0].model, "store-model");
  assert.equal(runs[0].traceId, "trace-1");
  assert.deepEqual(runs[0].tags, ["unit"]);

  const run = await store.getRun(runId);
  assert.equal(run?.taskInput, "persist this task");
  assert.ok(run?.filePath && existsSync(run.filePath));

  const data = await store.getRunData(runId);
  assert.equal(data?.runType, "agent");
  assert.equal(data?.response.context.messages[0].content, "persist this task");

  assert.equal(await store.deleteRun(runId), true);
  assert.equal(await store.getRun(runId), undefined);
  assert.equal(await store.getRunData(runId), undefined);
  await store.close();
});

test("PicoStore manages datasets and tasks", async () => {
  const dir = await makeTempDir("picoagents-store-datasets-");
  const store = makeStore(dir);

  const dataset = await store.createDataset({
    name: "dataset-a",
    description: "Fixture dataset",
    tasks: [
      {
        id: "task-a",
        name: "Task A",
        input: "What is 2+2?",
        expected_output: "4",
        category: "math",
        eval_criteria: ["correctness"],
        metadata: { difficulty: "easy" }
      }
    ]
  });

  assert.equal(dataset.taskCount, 1);
  assert.equal(dataset.tasks[0].expectedOutput, "4");
  assert.deepEqual(dataset.categories, ["math"]);

  const added = await store.addTask(dataset.id, {
    id: "task-b",
    name: "Task B",
    input: "What is 3+3?",
    expected_output: "6"
  });
  assert.equal(added?.datasetId, dataset.id);

  const updated = await store.updateTask("task-b", { expected_output: "six", metadata: { changed: true } });
  assert.equal(updated?.expectedOutput, "six");
  assert.deepEqual(updated?.metadata, { changed: true });

  const loaded = await store.getDataset(dataset.id);
  assert.equal(loaded?.tasks.length, 2);
  assert.equal(loaded?.taskCount, 2);

  assert.equal(await store.deleteTask("task-b"), true);
  assert.equal((await store.getDataset(dataset.id))?.taskCount, 1);
  assert.equal(await store.deleteDataset(dataset.id), true);
  assert.equal(await store.getDataset(dataset.id), undefined);
  await store.close();
});

test("PicoStore manages target configs and eval results", async () => {
  const dir = await makeTempDir("picoagents-store-eval-");
  const store = makeStore(dir);

  const target = await store.createTargetConfig({
    name: "target-a",
    config: { modelProvider: "openai", modelName: "test-model" },
    description: "Target fixture"
  });
  assert.equal((await store.listTargetConfigs()).length, 1);
  assert.deepEqual((await store.getTargetConfig(target.id))?.config, {
    modelProvider: "openai",
    modelName: "test-model"
  });

  const evalRun = await store.createEvalRun({
    datasetId: "dataset-a",
    datasetName: "Dataset A",
    targetIds: [target.id],
    targetNames: [target.name],
    totalTasks: 1,
    judgeType: "heuristic"
  });
  await store.updateEvalRunProgress(evalRun.id, {
    completedTasks: 1,
    currentTarget: target.name,
    currentTask: "task-1",
    status: "completed",
    completedAt: new Date("2024-01-01T00:00:00Z")
  });

  const updatedEvalRun = await store.getEvalRun(evalRun.id);
  assert.equal(updatedEvalRun?.completedTasks, 1);
  assert.equal(updatedEvalRun?.status, "completed");

  const taskResult = makeTaskResult();
  const evalResultId = await store.saveEvalResult(evalRun.id, taskResult, "run-1");
  const evalResults = await store.getEvalResults(evalRun.id);
  assert.equal(evalResults.length, 1);
  assert.equal(evalResults[0].overallScore, 8);
  assert.equal((await store.getEvalResult(evalResultId))?.runId, "run-1");

  const results = new EvalResults({
    runId: "eval-results-run",
    timestamp: new Date("2024-01-02T00:00:00Z"),
    datasetName: "Dataset A",
    datasetVersion: "1.0.0"
  });
  results.addResult(makeTaskResult("task-2", "target-a"));
  const savedEvalRunId = await store.saveEvalRunFromResults(results);
  const savedEvalRun = await store.getEvalRun(savedEvalRunId);
  assert.equal(savedEvalRun?.datasetName, "Dataset A");
  assert.ok(savedEvalRun?.filePath && existsSync(savedEvalRun.filePath));
  assert.equal((await store.getEvalResults(savedEvalRunId)).length, 1);

  assert.equal(await store.deleteTargetConfig(target.id), true);
  await store.close();
});

test("persist: true writes through the default store", async () => {
  const dir = await makeTempDir("picoagents-store-default-");
  const store = makeStore(dir);
  const previous = getDefaultStore();
  setDefaultStore(store);

  try {
    const agent = makeAgent("default-store-agent");
    await agent.run("persist through default store", { persist: true });
    const runs = await store.listRuns({ agentName: "default-store-agent" });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].taskInput, "persist through default store");
  } finally {
    setDefaultStore(previous);
    await store.close();
  }
});
