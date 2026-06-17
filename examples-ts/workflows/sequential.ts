import {
  Context,
  FunctionStep,
  Workflow,
  WorkflowCompletedEvent,
  WorkflowRunner
} from "picoagents-ts";
import { section } from "../shared/printing.js";

interface NumberInput extends Record<string, unknown> {
  value: number;
}

interface NumberOutput extends Record<string, unknown> {
  result: number;
}

const numberInputSchema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"]
};

const numberOutputSchema = {
  type: "object",
  properties: { result: { type: "integer" } },
  required: ["result"]
};

function validateNumberInput(value: Record<string, unknown>): NumberInput {
  return { value: Number(value.value) };
}

function validateNumberOutput(value: Record<string, unknown>): NumberOutput {
  return { result: Number(value.result) };
}

async function doubleNumber(input: NumberInput, context: Context): Promise<NumberOutput> {
  context.set("operationsPerformed", ["double"]);
  context.set("originalInput", input.value);
  const result = input.value * 2;
  console.log(`double: ${input.value} -> ${result}`);
  return { result };
}

async function squareNumber(input: NumberOutput, context: Context): Promise<NumberOutput> {
  const operations = context.get<string[]>("operationsPerformed", [])!;
  operations.push("square");
  context.set("operationsPerformed", operations);
  context.set("intermediateResults", { afterDouble: input.result });
  const result = input.result ** 2;
  console.log(`square: ${input.result} -> ${result}`);
  return { result };
}

async function addTen(input: NumberOutput, context: Context): Promise<NumberOutput> {
  const operations = context.get<string[]>("operationsPerformed", [])!;
  operations.push("add_ten");
  context.set("operationsPerformed", operations);
  const result = input.result + 10;
  context.set("workflowSummary", {
    originalInput: context.get("originalInput"),
    operations,
    intermediateResults: context.get("intermediateResults", {}),
    finalResult: result
  });
  console.log(`add_ten: ${input.result} -> ${result}`);
  return { result };
}

export function getWorkflow(): Workflow {
  const doubleStep = new FunctionStep<NumberInput, NumberOutput>({
    stepId: "double",
    metadata: { name: "Double Number" },
    inputValidator: validateNumberInput,
    outputValidator: validateNumberOutput,
    inputSchema: numberInputSchema,
    outputSchema: numberOutputSchema,
    func: doubleNumber
  });

  const squareStep = new FunctionStep<NumberOutput, NumberOutput>({
    stepId: "square",
    metadata: { name: "Square Number" },
    inputValidator: validateNumberOutput,
    outputValidator: validateNumberOutput,
    inputSchema: numberOutputSchema,
    outputSchema: numberOutputSchema,
    func: squareNumber
  });

  const addTenStep = new FunctionStep<NumberOutput, NumberOutput>({
    stepId: "add_ten",
    metadata: { name: "Add Ten" },
    inputValidator: validateNumberOutput,
    outputValidator: validateNumberOutput,
    inputSchema: numberOutputSchema,
    outputSchema: numberOutputSchema,
    func: addTen
  });

  return new Workflow({
    metadata: { name: "Sequential Example", description: "double -> square -> add ten" },
    workflowId: "ts_sequential_example"
  }).chain(doubleStep, squareStep, addTenStep);
}

export const workflow = getWorkflow();

export async function main(): Promise<void> {
  section("Sequential Workflow Example");
  console.log("Expected: 3 -> double(6) -> square(36) -> add_ten(46)");

  const runner = new WorkflowRunner();
  let completed: WorkflowCompletedEvent | undefined;

  for await (const event of runner.runStream(workflow, { value: 3 })) {
    console.log(`[${event.eventType}]`);
    if (event instanceof WorkflowCompletedEvent) completed = event;
  }

  console.log(`Final result: ${JSON.stringify(completed?.execution.stepExecutions.add_ten?.outputData)}`);
  console.log(`Shared state: ${JSON.stringify(completed?.execution.state.workflowSummary)}`);
  console.log(`Serialized provider: ${workflow.dumpComponent().provider}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
