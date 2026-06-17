import {
  CheckpointConfig,
  CheckpointSavedEvent,
  FileCheckpointStore,
  FunctionStep,
  StepCompletedEvent,
  Workflow,
  WorkflowCompletedEvent,
  WorkflowResumedEvent,
  WorkflowRunner
} from "picoagents-ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { section } from "../shared/printing.js";

interface DataInput extends Record<string, unknown> {
  text: string;
}

interface DataOutput extends Record<string, unknown> {
  result: string;
}

const validateInput = (value: Record<string, unknown>): DataInput => ({
  text: String(value.text)
});

const validateOutput = (value: Record<string, unknown>): DataOutput => ({
  result: String(value.result)
});

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function fetchData(input: DataInput): Promise<DataOutput> {
  await pause();
  return { result: `Fetched: ${input.text}` };
}

async function processData(input: DataOutput): Promise<DataOutput> {
  await pause();
  return { result: `Processed: ${input.result}` };
}

async function validateData(input: DataOutput): Promise<DataOutput> {
  await pause();
  return { result: `Validated: ${input.result}` };
}

async function saveData(input: DataOutput): Promise<DataOutput> {
  await pause();
  return { result: `Saved: ${input.result}` };
}

export function buildWorkflow(): Workflow {
  const fetchStep = new FunctionStep<DataInput, DataOutput>({
    stepId: "fetch",
    metadata: { name: "Fetch Data" },
    inputValidator: validateInput,
    outputValidator: validateOutput,
    func: fetchData
  });

  const processStep = new FunctionStep<DataOutput, DataOutput>({
    stepId: "process",
    metadata: { name: "Process Data" },
    inputValidator: validateOutput,
    outputValidator: validateOutput,
    func: processData
  });

  const validateStep = new FunctionStep<DataOutput, DataOutput>({
    stepId: "validate",
    metadata: { name: "Validate Data" },
    inputValidator: validateOutput,
    outputValidator: validateOutput,
    func: validateData
  });

  const saveStep = new FunctionStep<DataOutput, DataOutput>({
    stepId: "save",
    metadata: { name: "Save Data" },
    inputValidator: validateOutput,
    outputValidator: validateOutput,
    func: saveData
  });

  return new Workflow({
    metadata: { name: "Data Pipeline", version: "1.0.0" },
    workflowId: "ts_checkpoint_pipeline"
  }).chain(
    fetchStep,
    processStep,
    validateStep,
    saveStep
  );
}

export async function main(): Promise<void> {
  section("Workflow Checkpoint Example");

  const checkpointDir = await mkdtemp(path.join(tmpdir(), "picoagents-checkpoints-"));
  const store = new FileCheckpointStore(checkpointDir);
  const checkpointConfig = new CheckpointConfig({
    store,
    autoSave: true,
    saveIntervalSteps: 1,
    autoCleanup: true,
    keepLastN: 3
  });

  const workflow = buildWorkflow();
  const runner = new WorkflowRunner();

  let checkpointCount = 0;
  for await (const event of runner.runStream(workflow, {
    initialInput: { text: "sales_data.csv" },
    checkpointConfig
  })) {
    if (event instanceof StepCompletedEvent) {
      console.log(`completed: ${event.stepId}`);
    }
    if (event instanceof CheckpointSavedEvent) {
      checkpointCount += 1;
      console.log(`checkpoint: ${event.checkpointId}`);
      if (checkpointCount === 2) {
        console.log("simulated interruption after two checkpoints");
        break;
      }
    }
  }

  const checkpoint = await store.loadLatest(workflow.id);
  if (!checkpoint) throw new Error("Expected checkpoint to exist");

  console.log(`resuming from checkpoint with completed steps: ${checkpoint.completedStepIds.join(", ")}`);

  for await (const event of runner.runStream(workflow, {
    initialInput: { text: "sales_data.csv" },
    checkpoint,
    checkpointConfig
  })) {
    if (event instanceof WorkflowResumedEvent) {
      console.log(`resumed: ${event.checkpointId}`);
    }
    if (event instanceof StepCompletedEvent) {
      console.log(`completed after resume: ${event.stepId}`);
    }
    if (event instanceof WorkflowCompletedEvent) {
      console.log(`final: ${JSON.stringify(event.execution.stepExecutions.save?.outputData)}`);
    }
  }

  const metadata = await store.listMetadata(workflow.id);
  console.log(`checkpoints kept: ${metadata.length}`);
  console.log(`checkpoint dir: ${checkpointDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
