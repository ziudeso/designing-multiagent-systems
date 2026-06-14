import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  AssistantMessage,
  HeadTailCompaction,
  NoCompaction,
  SlidingWindowCompaction,
  SystemMessage,
  ToolCallRequest,
  ToolMessage,
  UserMessage
} from "../dist/index.js";
import { createMockClient } from "./helpers.mjs";

function makeMessages(count = 14) {
  const messages = [new SystemMessage({ content: "system prompt", source: "system" })];
  for (let i = 0; i < count; i += 1) {
    messages.push(new UserMessage({ content: `user ${i} ${"x".repeat(40)}`, source: "user" }));
    messages.push(new AssistantMessage({ content: `assistant ${i} ${"y".repeat(40)}`, source: "agent" }));
  }
  return messages;
}

function addAtomicGroup(messages, id) {
  messages.push(
    new AssistantMessage({
      content: "",
      source: "agent",
      toolCalls: [
        new ToolCallRequest({
          toolName: "lookup",
          parameters: { value: id },
          callId: id
        })
      ]
    })
  );
  messages.push(
    new ToolMessage({
      content: `result ${id}`,
      source: "agent",
      toolCallId: id,
      toolName: "lookup",
      success: true
    })
  );
}

test("NoCompaction returns the same message array", () => {
  const messages = makeMessages(2);
  assert.equal(new NoCompaction().compact(messages), messages);
});

test("HeadTailCompaction preserves early and recent messages and records statistics", () => {
  const messages = makeMessages(18);
  const strategy = new HeadTailCompaction({ tokenBudget: 120, headRatio: 0.3 });

  const compacted = strategy.compact(messages);

  assert.ok(compacted.length < messages.length);
  assert.equal(compacted[0], messages[0]);
  assert.equal(compacted.at(-1), messages.at(-1));
  assert.equal(strategy.compactionCount, 1);
  assert.ok(strategy.totalTokensSaved > 0);
});

test("SlidingWindowCompaction keeps the system prompt and recent tail", () => {
  const messages = makeMessages(18);
  const strategy = new SlidingWindowCompaction({ tokenBudget: 100 });

  const compacted = strategy.compact(messages);

  assert.ok(compacted.length < messages.length);
  assert.equal(compacted[0], messages[0]);
  assert.equal(compacted.at(-1), messages.at(-1));
});

test("Compaction never splits assistant tool calls from their tool results", () => {
  const messages = makeMessages(8);
  addAtomicGroup(messages, "call_old");
  messages.push(...makeMessages(8).slice(1));
  addAtomicGroup(messages, "call_new");

  const compacted = new HeadTailCompaction({ tokenBudget: 120, headRatio: 0.2 }).compact(messages);
  const keptToolCallIds = compacted
    .filter((msg) => msg instanceof AssistantMessage && msg.toolCalls?.length)
    .flatMap((msg) => msg.toolCalls.map((call) => call.callId));

  for (const callId of keptToolCallIds) {
    assert.ok(
      compacted.some((msg) => msg instanceof ToolMessage && msg.toolCallId === callId),
      `missing tool result for ${callId}`
    );
  }
});

test("Agent accepts function-style compaction strategies inside the loop", async () => {
  const seenLengths = [];
  const client = createMockClient({ responses: ["first", "second"] });
  const agent = new Agent({
    name: "compact-agent",
    instructions: "Reply.",
    modelClient: client,
    maxIterations: 1,
    compaction: (messages) => {
      seenLengths.push(messages.length);
      return messages.slice(-2);
    }
  });

  await agent.run("hello");
  assert.deepEqual(seenLengths, [2]);
});
