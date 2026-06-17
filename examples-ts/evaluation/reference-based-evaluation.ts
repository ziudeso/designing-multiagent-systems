import {
  AssistantMessage,
  CallableTarget,
  CompositeJudge,
  ContainsJudge,
  Dataset,
  EvalRunner,
  ExactMatchJudge,
  FuzzyMatchJudge,
  RunTrajectory,
  Task,
  Usage,
  UserMessage,
  formatSummaryTable
} from "picoagents-ts";
import { section } from "../shared/printing.js";

function trajectory(task: Task, content: string): RunTrajectory {
  return new RunTrajectory({
    task,
    messages: [
      new UserMessage({ content: task.input, source: "user" }),
      new AssistantMessage({ content, source: "agent" })
    ],
    success: true,
    usage: new Usage({ durationMs: 10, llmCalls: 1, tokensInput: 5, tokensOutput: 5 })
  });
}

export function createDataset(): Dataset {
  return new Dataset({
    name: "reference-demo",
    version: "1.0.0",
    tasks: [
      new Task({
        id: "math",
        name: "Math Simple",
        input: "What is 7 * 8?",
        expectedOutput: "56",
        category: "math"
      }),
      new Task({
        id: "capital",
        name: "Capital",
        input: "What is the capital of Japan?",
        expectedOutput: "Tokyo",
        category: "facts"
      }),
      new Task({
        id: "water",
        name: "Scientific Fact",
        input: "What is the chemical symbol for water?",
        expectedOutput: "H2O",
        category: "facts"
      })
    ],
    defaultEvalCriteria: ["accuracy"]
  });
}

export async function main(): Promise<void> {
  section("Reference-Based Evaluation");

  const dataset = createDataset();
  const exactTarget = new CallableTarget("exact-agent", async (task) => {
    const answers: Record<string, string> = {
      math: "56",
      capital: "Tokyo",
      water: "H2O"
    };
    return trajectory(task, answers[task.id ?? ""] ?? "");
  });
  const verboseTarget = new CallableTarget("verbose-agent", async (task) => {
    const answers: Record<string, string> = {
      math: "The answer is 56.",
      capital: "The capital of Japan is Tokyo.",
      water: "Water is commonly written as H2O."
    };
    return trajectory(task, answers[task.id ?? ""] ?? "");
  });

  const runner = new EvalRunner(
    new CompositeJudge([
      [new ExactMatchJudge(), 0.5],
      [new ContainsJudge(), 0.5]
    ])
  );
  const results = await runner.run(dataset, [exactTarget, verboseTarget]);

  console.log(formatSummaryTable(results));

  section("Judge Comparison");
  const sample = trajectory(dataset.tasks[2]!, "Water is commonly written as H2O.");
  console.log(`Exact: ${(await new ExactMatchJudge().score(sample)).overall}`);
  console.log(`Contains: ${(await new ContainsJudge().score(sample)).overall}`);
  console.log(`Fuzzy: ${(await new FuzzyMatchJudge({ threshold: 0.5 }).score(sample)).overall}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
