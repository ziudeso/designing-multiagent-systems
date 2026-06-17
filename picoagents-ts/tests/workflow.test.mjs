import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CheckpointConfig,
  CheckpointSavedEvent,
  Context,
  EdgeActivatedEvent,
  EchoStep,
  FunctionStep,
  InMemoryCheckpointStore,
  PicoAgentStep,
  StepCompletedEvent,
  StepStartedEvent,
  StepProgressEvent,
  StepStatus,
  TransformStep,
  Workflow,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowRunner,
  WorkflowStatus,
  computeWorkflowStructureHash,
  getDefaultSteps
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

  const output = await step.run({ a: 2, b: 3 }, { workflowState: {} });
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
    type: "outputBased",
    field: "priority",
    operator: "==",
    value: "high"
  });
  workflow.addEdge("start", "low", {
    type: "outputBased",
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

test("Workflow validation rejects incompatible connected step schemas", () => {
  const first = new FunctionStep({
    stepId: "first",
    metadata: { name: "First" },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    },
    func: () => ({ value: "one" })
  });
  const second = new FunctionStep({
    stepId: "second",
    metadata: { name: "Second" },
    inputSchema: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"]
    },
    func: () => ({ result: "two" })
  });
  const workflow = new Workflow({ metadata: { name: "Types" }, workflowId: "wf_types" });
  workflow.chain(first, second);

  const validation = workflow.validateWorkflow();

  assert.equal(validation.isValid, false);
  assert.ok(validation.errors.some((error) => error.includes("Type mismatch")));
});

test("WorkflowRunner exposes nested execution status", async () => {
  const step = new FunctionStep({
    stepId: "only",
    metadata: { name: "Only" },
    func: () => ({ result: "done" })
  });
  const workflow = new Workflow({ metadata: { name: "Status" }, workflowId: "wf_status" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const execution = await new WorkflowRunner().run(workflow, {});
  const status = new WorkflowRunner().getExecutionStatus(execution);

  assert.equal(status.progress.totalSteps, 1);
  assert.equal(status.progress.completedSteps, 1);
  assert.equal(status.progress.percentage, 100);
  assert.ok("timing" in status);
  assert.equal(status.error, undefined);
});

test("WorkflowRunner can cancel a registered running workflow", async () => {
  const step = new FunctionStep({
    stepId: "slow",
    metadata: { name: "Slow" },
    func: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result: "late" };
    }
  });
  const workflow = new Workflow({ metadata: { name: "Cancel" }, workflowId: "wf_cancel" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);
  const runner = new WorkflowRunner();
  const iterator = runner.runStream(workflow, {});
  const events = [];

  events.push((await iterator.next()).value);
  events.push((await iterator.next()).value);
  assert.equal(await runner.cancelWorkflow("wf_cancel", "test stop"), true);

  for await (const event of iterator) events.push(event);

  const cancelled = events.find((event) => event instanceof WorkflowCancelledEvent);
  assert.ok(cancelled);
  assert.equal(cancelled.reason, "test stop");
  assert.equal(cancelled.execution.status, WorkflowStatus.CANCELLED);
  assert.equal(await runner.cancelWorkflow("wf_cancel"), false);
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

test("WorkflowRunner validates initial input against start step schema before step execution", async () => {
  const step = new FunctionStep({
    stepId: "typed_start",
    metadata: { name: "Typed Start" },
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"]
    },
    func: () => ({ result: "ok" })
  });
  const workflow = new Workflow({ metadata: { name: "Initial Input Validation" }, workflowId: "wf_initial_input" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const events = await collectAsync(new WorkflowRunner().runStream(workflow, { other: "value" }));

  const failed = events.find((event) => event instanceof WorkflowFailedEvent);
  assert.ok(failed);
  assert.match(failed.error, /Initial input validation failed/);
  assert.ok(!events.some((event) => event instanceof StepStartedEvent));
});

test("PicoAgentStep returns error-shaped output instead of failing workflow step", async () => {
  const agent = {
    name: "broken-agent",
    async run() {
      throw new Error("model unavailable");
    }
  };
  const step = new PicoAgentStep({
    stepId: "agent_step",
    metadata: { name: "Agent Step" },
    agent
  });
  const context = new Context();

  const output = await step.execute({ task: "answer" }, context);

  assert.match(output.response, /Error: PicoAgent execution failed: model unavailable/);
  assert.deepEqual(output.messages, []);
  assert.equal(output.metadata.agentName, "broken-agent");
  assert.match(context.get("agent_step_error").error, /model unavailable/);
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

test("Workflow structure hash includes declared input and output schemas", () => {
  const makeStep = (messageType) => new FunctionStep({
    stepId: "typed",
    metadata: { name: "Typed" },
    inputSchema: {
      type: "object",
      properties: { message: { type: messageType } },
      required: ["message"]
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"]
    },
    func: () => ({ result: "ok" })
  });

  const first = makeStep("string");
  const second = makeStep("integer");

  assert.notEqual(
    computeWorkflowStructureHash({ typed: first }, [], "typed", ["typed"]),
    computeWorkflowStructureHash({ typed: second }, [], "typed", ["typed"])
  );
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

test("Default step templates preserve concrete step config", () => {
  const [echo, http, transform, agent] = getDefaultSteps();

  assert.equal(echo.provider, "picoagents.workflow.EchoStep");
  assert.equal(echo.config.prefix, "Processed: ");
  assert.equal(echo.config.suffix, " (done)");
  assert.equal(echo.config.delaySeconds, 1);
  assert.equal(http.config.inputSchema.properties.verify_ssl.default, true);
  assert.deepEqual(transform.config.mappings, { result: "message" });
  assert.equal(agent.config.agent.config.modelClient.config.model, "gpt-4.1-mini");
});
