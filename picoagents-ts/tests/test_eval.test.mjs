import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  AgentConfig,
  AssistantMessage,
  CallableTarget,
  CompositeJudge,
  ContainsJudge,
  Dataset,
  EvalRunner,
  EvalScore,
  ExactMatchJudge,
  FuzzyMatchJudge,
  RunTrajectory,
  Task,
  Usage,
  UserMessage,
  formatSummaryTable
} from "../dist/index.js";
import { makeTempDir } from "./helpers.mjs";

function trajectory(task, content, success = true) {
  return new RunTrajectory({
    task,
    messages: [
      new UserMessage({ content: task.input, source: "user" }),
      new AssistantMessage({ content, source: "agent" })
    ],
    success,
    error: success ? undefined : "failed",
    usage: new Usage({ durationMs: 10, llmCalls: 1, tokensInput: 4, tokensOutput: 6 })
  });
}

test("Reference judges score exact, fuzzy, contains, and composite matches", async () => {
  const task = new Task({ name: "answer", input: "Q", expectedOutput: "Hello world" });
  const run = trajectory(task, "hello world");

  const exact = await new ExactMatchJudge().score(run);
  assert.equal(exact.overall, 10);

  const contains = await new ContainsJudge().score(trajectory(task, "Well, Hello world!"));
  assert.equal(contains.overall, 10);

  const fuzzy = await new FuzzyMatchJudge({ threshold: 0.5 }).score(trajectory(task, "hello wurld"));
  assert.ok(fuzzy.overall > 5);

  const composite = await new CompositeJudge([
    [new ExactMatchJudge(), 1],
    [new ContainsJudge(), 1]
  ]).score(run);
  assert.equal(composite.overall, 10);
  assert.equal(composite.metadata.sub_judges.length, 2);
});

test("BaseEvalJudge answer strategies affect extracted answers", async () => {
  const task = new Task({ name: "answer", input: "Q", expectedOutput: "first\nsecond" });
  const run = new RunTrajectory({
    task,
    messages: [
      new AssistantMessage({ content: "first", source: "agent" }),
      new UserMessage({ content: "tool-ish", source: "user" }),
      new AssistantMessage({ content: "second", source: "agent" })
    ],
    success: true
  });

  const allAssistant = await new ExactMatchJudge({ answerStrategy: "all_assistant" }).score(run);
  assert.equal(allAssistant.overall, 10);

  const lastAssistant = await new ExactMatchJudge({
    answerStrategy: "last_assistant",
    caseSensitive: true
  }).score(new RunTrajectory({
    task: new Task({ name: "last", input: "Q", expectedOutput: "second" }),
    messages: run.messages,
    success: true
  }));
  assert.equal(lastAssistant.overall, 10);
});

test("Dataset serializes, filters, and loads from JSON", async () => {
  const dataset = new Dataset({
    name: "sample",
    version: "1.2.3",
    description: "desc",
    tasks: [
      new Task({ id: "a", name: "A", input: "one", category: "cat" }),
      new Task({ id: "b", name: "B", input: "two", category: "dog" })
    ],
    defaultEvalCriteria: ["accuracy"]
  });

  assert.equal(dataset.length, 2);
  assert.deepEqual(dataset.categories.sort(), ["cat", "dog"]);
  assert.equal(dataset.filterByCategory("cat").tasks.length, 1);
  assert.equal(dataset.filterByIds(["b"]).tasks[0].name, "B");

  const dir = await makeTempDir();
  const file = path.join(dir, "dataset.json");
  await dataset.toJson(file);
  assert.match(await readFile(file, "utf8"), /sample/);
  const loaded = await Dataset.fromJson(file);
  assert.equal(loaded.version, "1.2.3");
  assert.deepEqual(loaded.defaultEvalCriteria, ["accuracy"]);
  assert.deepEqual(loaded.tasks[0].evalCriteria, []);
});

test("EvalRunner evaluates callable targets and stores summaries", async () => {
  const dataset = new Dataset({
    name: "dataset",
    tasks: [new Task({ id: "t1", name: "Task 1", input: "hello", expectedOutput: "ok" })],
    defaultEvalCriteria: ["accuracy"]
  });
  const target = new CallableTarget("callable", async (task) => trajectory(task, "ok"));
  const runner = new EvalRunner(new ExactMatchJudge());

  const results = await runner.run(dataset, [target]);
  const result = results.getResult("callable", "t1");

  assert.equal(result.score.overall, 10);
  assert.equal(results.getSummaries().callable.avgScore, 10);
  assert.match(formatSummaryTable(results), /callable/);
});

test("EvalScore exposes final response and full conversation", () => {
  const task = new Task({ name: "Task", input: "hi" });
  const run = trajectory(task, "final response");
  const score = new EvalScore({ overall: 7, trajectory: run });

  assert.equal(score.getFinalResponse(), "final response");
  assert.match(score.getFullConversation(), /final response/);
});

test("AgentConfig parses strings and creates compaction/tool settings", () => {
  const config = AgentConfig.fromString(
    "candidate:provider=openai,model=gpt-test,strategy=head_tail,token_budget=123,tools=core+coding,max_iterations=4"
  );

  assert.equal(config.name, "candidate");
  assert.equal(config.modelName, "gpt-test");
  assert.equal(config.compaction, "head_tail");
  assert.equal(config.tokenBudget, 123);
  assert.deepEqual(config.tools, ["core", "coding"]);
  assert.equal(config.maxIterations, 4);
  assert.equal(config.createCompaction().constructor.name, "HeadTailCompaction");
  assert.ok(config.createTools().some((tool) => tool.name === "calculator"));
});
