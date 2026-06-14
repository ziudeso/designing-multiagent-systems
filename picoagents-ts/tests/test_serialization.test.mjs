import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentConfig,
  AgentContext,
  AssistantMessage,
  FunctionTool,
  OpenAIChatCompletionClient,
  TransformStep,
  UserMessage,
  Workflow,
  dumpComponent,
  loadComponent,
  messageFromObject
} from "../dist/index.js";

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
  assert.equal(restored.steps.format.originalType, "TransformStep");
});

test("FunctionTool refuses component serialization because closures are not portable", () => {
  const fn = new FunctionTool(() => "ok", {
    name: "closure",
    parameters: { type: "object", properties: {}, required: [] }
  });
  assert.throws(() => fn.toConfig(), /cannot be serialized/);
});
