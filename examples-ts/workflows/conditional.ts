import {
  FunctionStep,
  StepStatus,
  Workflow,
  WorkflowRunner
} from "picoagents-ts";
import type { Context } from "picoagents-ts";
import { section } from "../shared/printing.js";

interface NumberInput extends Record<string, unknown> {
  value: number;
}

interface ClassifyOutput extends Record<string, unknown> {
  category: "high" | "low";
  value: number;
}

interface ProcessedOutput extends Record<string, unknown> {
  result: string;
  originalValue: number;
  multiplier: number;
}

function validateNumberInput(value: Record<string, unknown>): NumberInput {
  return { value: Number(value.value) };
}

function validateClassifyOutput(value: Record<string, unknown>): ClassifyOutput {
  const category = value.category === "high" ? "high" : "low";
  return { category, value: Number(value.value) };
}

async function classifyNumber(input: NumberInput, _context: Context): Promise<ClassifyOutput> {
  const category = input.value >= 50 ? "high" : "low";
  console.log(`classify: ${input.value} -> ${category}`);
  return { category, value: input.value };
}

async function processHigh(input: ClassifyOutput): Promise<ProcessedOutput> {
  const multiplier = 10;
  return {
    result: `High value processed: ${input.value * multiplier}`,
    originalValue: input.value,
    multiplier
  };
}

async function processLow(input: ClassifyOutput): Promise<ProcessedOutput> {
  const multiplier = 2;
  return {
    result: `Low value processed: ${input.value * multiplier}`,
    originalValue: input.value,
    multiplier
  };
}

export function getWorkflow(): Workflow {
  const classify = new FunctionStep<NumberInput, ClassifyOutput>({
    stepId: "classify",
    metadata: { name: "Classify Number" },
    inputValidator: validateNumberInput,
    outputValidator: validateClassifyOutput,
    func: classifyNumber
  });
  const high = new FunctionStep<ClassifyOutput, ProcessedOutput>({
    stepId: "process_high",
    metadata: { name: "Process High Value" },
    inputValidator: validateClassifyOutput,
    func: processHigh
  });
  const low = new FunctionStep<ClassifyOutput, ProcessedOutput>({
    stepId: "process_low",
    metadata: { name: "Process Low Value" },
    inputValidator: validateClassifyOutput,
    func: processLow
  });

  const workflow = new Workflow({
    metadata: {
      name: "Conditional Branching Workflow",
      description: "Routes to processors based on input value."
    },
    workflowId: "ts_conditional_example"
  });

  workflow.addStep(classify).addStep(high).addStep(low);
  workflow.addEdge("classify", "process_high", {
    type: "outputBased",
    field: "category",
    operator: "==",
    value: "high"
  });
  workflow.addEdge("classify", "process_low", {
    type: "outputBased",
    field: "category",
    operator: "!=",
    value: "high"
  });
  workflow.setStartStep("classify");
  workflow.addEndStep("process_high").addEndStep("process_low");
  return workflow;
}

export const workflow = getWorkflow();

async function runExample(value: number): Promise<void> {
  const result = await new WorkflowRunner().run(workflow, { value });
  const completedEnd = workflow.endStepIds.find(
    (stepId) => result.stepExecutions[stepId]?.status === StepStatus.COMPLETED
  );
  console.log(`${value} -> ${completedEnd}: ${JSON.stringify(result.stepExecutions[completedEnd!]?.outputData)}`);
}

export async function main(): Promise<void> {
  section("Conditional Branching Workflow Example");
  await runExample(75);
  await runExample(25);
  await runExample(50);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
