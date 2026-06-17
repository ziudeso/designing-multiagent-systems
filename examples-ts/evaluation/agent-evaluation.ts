import {
  Agent,
  AgentEvalTarget,
  Dataset,
  EvalRunner,
  ExactMatchJudge,
  ModelEvalTarget,
  Task,
  formatSummaryTable
} from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export async function main(): Promise<void> {
  section("Agent Evaluation Example");

  const dataset = new Dataset({
    name: "agent-demo",
    tasks: [
      new Task({
        id: "math",
        name: "Math",
        input: "What is 7 * 8?",
        expectedOutput: "56"
      }),
      new Task({
        id: "capital",
        name: "Capital",
        input: "What is the capital of Japan?",
        expectedOutput: "Tokyo"
      })
    ],
    defaultEvalCriteria: ["accuracy"]
  });

  const modelTarget = new ModelEvalTarget(
    createExampleModelClient(["56", "Tokyo"]),
    "Answer with only the final answer.",
    "direct-model"
  );

  const agent = new Agent({
    name: "answer_agent",
    description: "Answers with short factual responses.",
    instructions: "Answer with only the final answer.",
    modelClient: createExampleModelClient(["56", "Tokyo"])
  });

  const runner = new EvalRunner(new ExactMatchJudge());
  const results = await runner.run(dataset, [
    modelTarget,
    new AgentEvalTarget(agent, "single-agent")
  ]);

  console.log(formatSummaryTable(results));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
