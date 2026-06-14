import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentResponse,
  AgentSelectionEvent,
  CancellationToken,
  MaxMessageTermination,
  RoundRobinOrchestrator,
  TextMentionTermination,
  UserMessage
} from "../dist/index.js";
import { collectAsync, createStaticAgent } from "./helpers.mjs";

test("RoundRobinOrchestrator validates agents", () => {
  assert.throws(
    () => new RoundRobinOrchestrator({ agents: [], termination: new MaxMessageTermination(1) }),
    /At least one agent/
  );
  assert.throws(
    () =>
      new RoundRobinOrchestrator({
        agents: [createStaticAgent("same", "a"), createStaticAgent("same", "b")],
        termination: new MaxMessageTermination(1)
      }),
    /unique/
  );
});

test("RoundRobinOrchestrator selects agents in order and stops on text mention", async () => {
  const first = createStaticAgent("first", "working");
  const second = createStaticAgent("second", "FINAL answer");
  const orchestrator = new RoundRobinOrchestrator({
    agents: [first, second],
    termination: new TextMentionTermination("FINAL"),
    maxIterations: 5
  });

  const result = await orchestrator.run("start");

  assert.equal(result.finalResult, "FINAL answer");
  assert.match(result.stopMessage.content, /Text mention/);
  assert.deepEqual(first.calls.length, 1);
  assert.deepEqual(second.calls.length, 1);
  assert.deepEqual(result.patternMetadata.agentsOrder, ["first", "second"]);
});

test("RoundRobinOrchestrator streams verbose selection events and final response", async () => {
  const orchestrator = new RoundRobinOrchestrator({
    agents: [createStaticAgent("a", "done")],
    termination: new TextMentionTermination("done"),
    maxIterations: 2
  });

  const items = await collectAsync(orchestrator.runStream("task", { verbose: true }));

  assert.ok(items.some((item) => item instanceof UserMessage));
  assert.ok(items.some((item) => item instanceof AgentSelectionEvent));
  assert.ok(items.at(-1).stopMessage);
});

test("RoundRobinOrchestrator reports max iterations when no termination fires", async () => {
  const orchestrator = new RoundRobinOrchestrator({
    agents: [createStaticAgent("a", "keep going")],
    termination: new TextMentionTermination("never"),
    maxIterations: 1
  });

  const result = await orchestrator.run("task");
  assert.match(result.stopMessage.content, /Maximum iterations/);
});

test("RoundRobinOrchestrator propagates cancellation", async () => {
  const token = new CancellationToken();
  token.cancel();
  const orchestrator = new RoundRobinOrchestrator({
    agents: [createStaticAgent("a", "done")],
    termination: new TextMentionTermination("done")
  });

  await assert.rejects(() => orchestrator.run("task", { cancellationToken: token }), /Operation cancelled/);
});

test("RoundRobinOrchestrator can prepare context with shared history", async () => {
  const orchestrator = new RoundRobinOrchestrator({
    agents: [createStaticAgent("a", "one")],
    termination: new MaxMessageTermination(10)
  });
  orchestrator.sharedMessages.push(new UserMessage({ content: "history", source: "user" }));

  const context = await orchestrator.prepareContextForAgent(orchestrator.agents[0]);
  assert.match(context, /history/);
});
