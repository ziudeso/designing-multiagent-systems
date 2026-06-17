import {
  FunctionStep,
  Workflow,
  WorkflowRunner
} from "picoagents-ts";
import { section } from "../shared/printing.js";

interface NumberInput extends Record<string, unknown> {
  value: number;
}

interface NumberOutput extends Record<string, unknown> {
  result: number;
}

interface StringOutput extends Record<string, unknown> {
  text: string;
}

const numberOutput = (value: Record<string, unknown>): NumberOutput => ({
  result: Number(value.result)
});

export function getWorkflow(): Workflow {
  const doubleStep = new FunctionStep<NumberInput, NumberOutput>({
    stepId: "double",
    metadata: { name: "Double Number" },
    inputValidator: (value) => ({ value: Number(value.value) }),
    outputValidator: numberOutput,
    func: (input) => {
      const result = input.value * 2;
      console.log(`double: ${input.value} -> ${result}`);
      return { result };
    }
  });

  const squareStep = new FunctionStep<NumberOutput, NumberOutput>({
    stepId: "square",
    metadata: { name: "Square Number" },
    inputValidator: numberOutput,
    outputValidator: numberOutput,
    func: (input) => {
      const result = input.result ** 2;
      console.log(`square: ${input.result} -> ${result}`);
      return { result };
    }
  });

  const addTenStep = new FunctionStep<NumberOutput, NumberOutput>({
    stepId: "add_ten",
    metadata: { name: "Add Ten" },
    inputValidator: numberOutput,
    outputValidator: numberOutput,
    func: (input) => {
      const result = input.result + 10;
      console.log(`add_ten: ${input.result} -> ${result}`);
      return { result };
    }
  });

  const formatStep = new FunctionStep<NumberOutput, StringOutput>({
    stepId: "format",
    metadata: { name: "Format Result" },
    inputValidator: numberOutput,
    func: (input) => {
      const text = `Final result: ${input.result}`;
      console.log(`format: ${text}`);
      return { text };
    }
  });

  return new Workflow({
    metadata: { name: "General Pipeline" },
    workflowId: "ts_general_pipeline"
  }).chain(doubleStep, squareStep, addTenStep, formatStep);
}

export const workflow = getWorkflow();

export async function main(): Promise<void> {
  section("General Workflow Pipeline");
  const result = await new WorkflowRunner().run(workflow, { value: 3 });
  console.log(JSON.stringify(result.stepExecutions.format?.outputData, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
