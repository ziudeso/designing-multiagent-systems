import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentAsTool,
  AgentResponse,
  AssistantMessage,
  ToolResult
} from "../dist/index.js";
import { collectAsync, createStaticAgent } from "./helpers.mjs";

test("AgentAsTool defaults to last message result strategy", async () => {
  const agent = createStaticAgent("helper", [["first", "last"]]);
  const tool = new AgentAsTool(agent);

  const result = await tool.execute({ task: "do it" });

  assert.equal(result.success, true);
  assert.equal(result.result, "last");
  assert.equal(result.metadata.agentName, "helper");
  assert.equal(result.metadata.messageCount, 3);
  assert.deepEqual(agent.calls, ["do it"]);
});

test("AgentAsTool supports last:N, all, callable, and custom task parameter", async () => {
  const agent = createStaticAgent("helper", [["one", "two", "three"]]);

  const lastTwo = await new AgentAsTool(agent, { resultStrategy: "last:2" }).execute({ task: "x" });
  assert.equal(lastTwo.result, "two\nthree");

  const all = await new AgentAsTool(agent, { resultStrategy: "all" }).execute({ task: "x" });
  assert.equal(all.result, "x\none\ntwo\nthree");

  const custom = await new AgentAsTool(agent, {
    taskParameterName: "question",
    resultStrategy: (messages) => String(messages.length)
  }).execute({ question: "custom task" });
  assert.equal(custom.result, "4");
});

test("AgentAsTool validates invalid strategies", () => {
  const agent = createStaticAgent("helper", "ok");

  assert.throws(() => new AgentAsTool(agent, { resultStrategy: "unknown" }), /Unknown resultStrategy/);
  assert.throws(() => new AgentAsTool(agent, { resultStrategy: "last:0" }), /positive integer/);
  assert.throws(() => new AgentAsTool(agent, { resultStrategy: 42 }), /string or callable/);
});

test("AgentAsTool reports execution failures as ToolResult errors", async () => {
  const agent = {
    name: "broken",
    description: "broken agent",
    async run() {
      throw new Error("boom");
    }
  };

  const result = await new AgentAsTool(agent).execute({ task: "fail" });
  assert.equal(result.success, false);
  assert.match(result.error, /boom/);
  assert.equal(result.metadata.agentName, "broken");
});

test("AgentAsTool executeStream forwards messages and ends with ToolResult", async () => {
  const agent = createStaticAgent("helper", "stream final");
  const tool = new AgentAsTool(agent);

  const items = await collectAsync(tool.executeStream({ task: "stream task" }));

  assert.ok(items.some((item) => item instanceof AssistantMessage));
  assert.ok(items.at(-1) instanceof ToolResult);
  assert.equal(items.at(-1).result, "stream final");
  assert.equal(items.filter((item) => item instanceof AgentResponse).length, 0);
});
