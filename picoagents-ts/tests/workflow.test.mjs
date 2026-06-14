import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CheckpointConfig,
  CheckpointSavedEvent,
  EdgeActivatedEvent,
  FunctionStep,
  InMemoryCheckpointStore,
  StepCompletedEvent,
  StepProgressEvent,
  StepStatus,
  TransformStep,
  Workflow,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowRunner,
  WorkflowStatus
} from "../dist/index.js";
import { collectAsync } from "./helpers.mjs";

test("FunctionStep executes with shared workflow context", async () => {
  const step = new FunctionStep({
    stepId: "add",
    metadata: { name: "Add" },
    func: (input, context) => {
      context.set("seen", true);
      return { total: Number(input.a) + Number(input.b) };
    }
  });

  const output = await step.run({ a: 2, b: 3 }, { workflow_state: {} });
  assert.deepEqual(output, { total: 5 });
  assert.equal(step.status, StepStatus.COMPLETED);
});

test("Workflow chain validation and execution complete successfully", async () => {
  const first = new FunctionStep({
    stepId: "first",
    metadata: { name: "First" },
    func: (input) => ({ value: `${input.message} one` })
  });
  const second = new FunctionStep({
    stepId: "second",
    metadata: { name: "Second" },
    func: (input) => ({ value: `${input.value} two` })
  });
  const workflow = new Workflow({ metadata: { name: "Chain" }, workflowId: "wf_chain" });
  workflow.chain(first, second);

  const validation = workflow.validateWorkflow();
  assert.equal(validation.isValid, true);

  const execution = await new WorkflowRunner().run(workflow, { message: "start" });
  assert.equal(execution.status, WorkflowStatus.COMPLETED);
  assert.equal(execution.stepExecutions.second.outputData.value, "start one two");
});

test("Workflow conditional edges run the matching branch", async () => {
  const start = new FunctionStep({
    stepId: "start",
    metadata: { name: "Start" },
    func: () => ({ priority: "high" })
  });
  const high = new FunctionStep({
    stepId: "high",
    metadata: { name: "High" },
    func: () => ({ result: "high path" })
  });
  const low = new FunctionStep({
    stepId: "low",
    metadata: { name: "Low" },
    func: () => ({ result: "low path" })
  });
  const workflow = new Workflow({ metadata: { name: "Conditional" }, workflowId: "wf_cond" });
  workflow.addStep(start).addStep(high).addStep(low);
  workflow.setStartStep(start).addEndStep(high).addEndStep(low);
  workflow.addEdge("start", "high", {
    type: "output_based",
    field: "priority",
    operator: "==",
    value: "high"
  });
  workflow.addEdge("start", "low", {
    type: "output_based",
    field: "priority",
    operator: "!=",
    value: "high"
  });

  const execution = await new WorkflowRunner().run(workflow, {});
  assert.equal(execution.stepExecutions.high.status, StepStatus.COMPLETED);
  assert.equal(execution.stepExecutions.low, undefined);
});

test("Workflow validation detects cycles and missing endpoints", () => {
  const a = new FunctionStep({ stepId: "a", metadata: { name: "A" }, func: () => ({}) });
  const b = new FunctionStep({ stepId: "b", metadata: { name: "B" }, func: () => ({}) });
  const workflow = new Workflow({ metadata: { name: "Cycle" } });
  workflow.addStep(a).addStep(b).setStartStep(a).addEndStep(b);
  workflow.addEdge("a", "b").addEdge("b", "a");

  const validation = workflow.validateWorkflow();
  assert.equal(validation.isValid, false);
  assert.equal(validation.hasCycles, true);
  assert.ok(validation.errors.some((error) => error.includes("cycles")));
});

test("WorkflowRunner streams progress, edge, checkpoint, and completion events", async () => {
  const start = new FunctionStep({
    stepId: "start",
    metadata: { name: "Start" },
    func: (_input, context) => {
      context.emitProgress("halfway", 1, 2, { phase: "test" });
      return { value: "done" };
    }
  });
  const finish = new TransformStep({
    stepId: "finish",
    metadata: { name: "Finish" },
    mappings: { result: "value" }
  });
  const workflow = new Workflow({ metadata: { name: "Events" }, workflowId: "wf_events" });
  workflow.chain(start, finish);
  const store = new InMemoryCheckpointStore();

  const events = await collectAsync(
    new WorkflowRunner().runStream(workflow, {
      initialInput: {},
      checkpointConfig: new CheckpointConfig({ store, autoSave: true, saveIntervalSteps: 1 })
    })
  );

  assert.ok(events.some((event) => event instanceof StepProgressEvent));
  assert.ok(events.some((event) => event instanceof EdgeActivatedEvent));
  assert.ok(events.some((event) => event instanceof CheckpointSavedEvent));
  assert.ok(events.some((event) => event instanceof WorkflowCompletedEvent));
  assert.ok((await store.listMetadata("wf_events")).length >= 1);
});

test("WorkflowRunner emits failure events and marks execution failed", async () => {
  const step = new FunctionStep({
    stepId: "boom",
    metadata: { name: "Boom" },
    func: () => {
      throw new Error("boom");
    }
  });
  const workflow = new Workflow({ metadata: { name: "Failure" }, workflowId: "wf_failure_port" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const events = await collectAsync(new WorkflowRunner().runStream(workflow, {}));
  const failed = events.find((event) => event instanceof WorkflowFailedEvent);
  assert.ok(failed);
  assert.equal(failed.execution.status, WorkflowStatus.FAILED);
});

test("Workflow checkpoints validate and resume compatible executions", async () => {
  const first = new FunctionStep({
    stepId: "first",
    metadata: { name: "First" },
    func: () => ({ value: "one" })
  });
  const second = new FunctionStep({
    stepId: "second",
    metadata: { name: "Second" },
    func: (input) => ({ value: `${input.value} two` })
  });
  const workflow = new Workflow({ metadata: { name: "Resume" }, workflowId: "wf_resume" });
  workflow.chain(first, second);

  const runner = new WorkflowRunner();
  const partial = {
    id: "exec",
    workflowId: workflow.id,
    status: WorkflowStatus.RUNNING,
    startTime: new Date(),
    state: { first_output: { value: "one" } },
    stepExecutions: {
      first: {
        stepId: "first",
        status: StepStatus.COMPLETED,
        outputData: { value: "one" },
        retryCount: 0
      }
    }
  };
  const checkpoint = runner.createCheckpoint(workflow, partial, "manual");
  const validation = runner.validateCheckpoint(workflow, checkpoint);
  assert.equal(validation.canResume, true);

  const events = await collectAsync(
    runner.runStream(workflow, { checkpoint, initialInput: { ignored: true } })
  );
  assert.ok(events[0] instanceof WorkflowResumedEvent);
  const completed = events.find((event) => event instanceof WorkflowCompletedEvent);
  assert.equal(completed.execution.stepExecutions.second.outputData.value, "one two");
});

test("Workflow serialization round-trips graph structure", () => {
  const step = new TransformStep({
    stepId: "format",
    metadata: { name: "Format" },
    mappings: { result: "message" }
  });
  const workflow = new Workflow({ metadata: { name: "Serializable" }, workflowId: "wf_serial" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const restored = Workflow.fromConfig(workflow.toConfig());
  assert.equal(restored.id, "wf_serial");
  assert.deepEqual(Object.keys(restored.steps), ["format"]);
  assert.equal(restored.startStepId, "format");
  assert.deepEqual(restored.endStepIds, ["format"]);
});
