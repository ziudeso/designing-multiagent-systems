import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  AgentConfig,
  AgentContext,
  AIOrchestrator,
  AssistantMessage,
  FunctionTool,
  OpenAIChatCompletionClient,
  PlanBasedOrchestrator,
  RoundRobinOrchestrator,
  ThinkTool,
  TextMentionTermination,
  TransformStep,
  ToolCallRequest,
  UserMessage,
  Workflow,
  dumpComponent,
  loadComponent,
  messageFromObject,
  registerComponent
} from "../dist/index.js";

class SchemaCheckedComponent {
  static componentType = "test";
  static componentProvider = "tests.SchemaCheckedComponent";
  static componentVersion = 2;
  static componentConfigSchema = {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } }
  };

  constructor(value) {
    this.value = value;
  }

  toConfig() {
    return { value: this.value };
  }

  static fromConfig(config) {
    return new SchemaCheckedComponent(config.value);
  }

  static fromConfigPastVersion(config) {
    return new SchemaCheckedComponent(config.legacyValue);
  }
}

registerComponent(SchemaCheckedComponent);

test("messageFromObject supports snake_case and camelCase wire shapes", () => {
  const assistant = messageFromObject({
    role: "assistant",
    content: "",
    source: "agent",
    tool_calls: [{ tool_name: "echo", call_id: "call", parameters: { value: "x" } }]
  });

  assert.ok(assistant instanceof AssistantMessage);
  assert.equal(assistant.toolCalls[0].toolName, "echo");
  assert.equal(assistant.toolCalls[0].callId, "call");

  const user = messageFromObject({ role: "user", content: "hi", source: "user" });
  assert.ok(user instanceof UserMessage);
});

test("AgentContext clone and JSON preserve structured state", () => {
  const context = new AgentContext({
    messages: [new UserMessage({ content: "hi", source: "user" })],
    metadata: { nested: { value: 1 } },
    sharedState: { count: 2 },
    sessionId: "s"
  });

  const clone = context.clone();
  clone.metadata.nested.value = 2;

  assert.equal(context.metadata.nested.value, 1);
  assert.equal(context.toJSON().sessionId, "s");
  assert.equal(context.toString().includes("messages=1"), true);
});

test("AgentContext reset preserves pending approval state", () => {
  const context = new AgentContext({
    messages: [new UserMessage({ content: "hi", source: "user" })],
    metadata: { step: 1 },
    sharedState: { value: "temporary" }
  });
  const firstCall = new ToolCallRequest({
    toolName: "write_file",
    parameters: { file_path: "a.txt" },
    callId: "call_1"
  });
  const secondCall = new ToolCallRequest({
    toolName: "bash_execute",
    parameters: { command: "pwd" },
    callId: "call_2"
  });
  context.addApprovalRequest(firstCall, "write_file");
  context.addApprovalResponse(context.pendingApprovalRequests[0].createResponse(true, "ok"));
  context.addApprovalRequest(secondCall, "bash_execute");

  context.reset();

  assert.equal(context.messages.length, 0);
  assert.deepEqual(context.metadata, {});
  assert.deepEqual(context.sharedState, {});
  assert.equal(context.approvalResponses.call_1.approved, true);
  assert.equal(context.pendingToolCalls.call_1.toolName, "write_file");
  assert.equal(context.pendingApprovalRequests[0].toolCallId, "call_2");
});

test("Component config round-trips registered model and eval config components", () => {
  const client = new OpenAIChatCompletionClient({
    model: "gpt-test",
    baseUrl: "https://example.com/v1",
    defaultOptions: { temperature: 0 }
  });
  const dumpedClient = dumpComponent(client);
  const restoredClient = loadComponent(dumpedClient);
  assert.equal(restoredClient.model, "gpt-test");
  assert.equal(restoredClient.baseUrl, "https://example.com/v1");

  const config = new AgentConfig({ name: "candidate", tools: ["core"], compaction: "sliding" });
  const restoredConfig = loadComponent(dumpComponent(config));
  assert.equal(restoredConfig.name, "candidate");
  assert.equal(restoredConfig.compaction, "sliding");
});

test("Component config validates schema, expected type, and past-version migration", () => {
  const restored = loadComponent(
    {
      provider: "tests.SchemaCheckedComponent",
      componentType: "test",
      componentVersion: 2,
      config: { value: "ok" }
    },
    SchemaCheckedComponent
  );
  assert.equal(restored.value, "ok");

  const migrated = loadComponent(
    {
      provider: "tests.SchemaCheckedComponent",
      componentType: "test",
      componentVersion: 1,
      config: { legacyValue: "old" }
    },
    SchemaCheckedComponent
  );
  assert.equal(migrated.value, "old");

  assert.throws(
    () =>
      loadComponent({
        provider: "tests.SchemaCheckedComponent",
        componentType: "test",
        componentVersion: 2,
        config: {}
      }),
    /missing required field/
  );
  assert.throws(
    () =>
      loadComponent(
        {
          provider: "tests.SchemaCheckedComponent",
          componentType: "test",
          componentVersion: 2,
          config: { value: "ok" }
        },
        Agent
      ),
    /Expected type does not match/
  );
});

test("Agent config round-trips registered model and tools", () => {
  const agent = new Agent({
    name: "serial-agent",
    instructions: "Think before answering.",
    modelClient: new OpenAIChatCompletionClient({ model: "gpt-test" }),
    tools: [new ThinkTool()]
  });

  const restored = loadComponent(dumpComponent(agent));
  assert.equal(restored.name, "serial-agent");
  assert.equal(restored.modelClient.model, "gpt-test");
  assert.deepEqual(restored.tools.map((item) => item.name), ["think"]);
});

test("termination and orchestrator components round-trip through aliases", () => {
  const agent = new Agent({
    name: "worker",
    instructions: "Answer.",
    modelClient: new OpenAIChatCompletionClient({ model: "gpt-test" })
  });
  const orchestrator = new RoundRobinOrchestrator({
    agents: [agent],
    termination: new TextMentionTermination("DONE"),
    maxIterations: 3,
    name: "team"
  });
  const dumped = dumpComponent(orchestrator);
  const restored = loadComponent({
    ...dumped,
    provider: "round_robin_orchestrator"
  });

  assert.equal(restored.name, "team");
  assert.equal(restored.maxIterations, 3);
  assert.equal(restored.agents[0].name, "worker");
  assert.equal(restored.termination.text, "DONE");
});

test("AI and plan orchestrator configs accept snake_case model_client", () => {
  const agent = new Agent({
    name: "worker",
    instructions: "Answer.",
    modelClient: new OpenAIChatCompletionClient({ model: "gpt-worker" })
  });
  const config = {
    agents: [dumpComponent(agent)],
    termination: dumpComponent(new TextMentionTermination("DONE")),
    model_client: dumpComponent(new OpenAIChatCompletionClient({ model: "gpt-selector" }))
  };

  const ai = AIOrchestrator.fromConfig(config);
  const plan = PlanBasedOrchestrator.fromConfig(config);

  assert.equal(ai.modelClient.model, "gpt-selector");
  assert.equal(plan.modelClient.model, "gpt-selector");
});

test("termination components serialize composite conditions", () => {
  const termination = new TextMentionTermination("DONE").or(new TextMentionTermination("STOP", true));
  const restored = loadComponent(dumpComponent(termination));

  assert.equal(restored.mode, "any");
  assert.equal(restored.conditions.length, 2);
  assert.equal(restored.conditions[1].caseSensitive, true);
});

test("Workflow component serialization preserves graph structure", () => {
  const step = new TransformStep({
    stepId: "format",
    metadata: { name: "Format" },
    mappings: { result: "message" }
  });
  const workflow = new Workflow({ metadata: { name: "Serializable" }, workflowId: "wf_component" });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const restored = loadComponent(dumpComponent(workflow));
  assert.equal(restored.id, "wf_component");
  assert.deepEqual(Object.keys(restored.steps), ["format"]);
  assert.equal(restored.steps.format.constructor.name, "TransformStep");
  assert.deepEqual(restored.steps.format.execute({ message: "hello" }), { result: "hello" });
});

test("FunctionTool refuses component serialization because closures are not portable", () => {
  const fn = new FunctionTool(() => "ok", {
    name: "closure",
    parameters: { type: "object", properties: {}, required: [] }
  });
  assert.throws(() => fn.toConfig(), /cannot be serialized/);
});
