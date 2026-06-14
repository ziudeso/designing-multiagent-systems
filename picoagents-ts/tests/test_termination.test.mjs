import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AssistantMessage,
  CancellationTermination,
  CancellationToken,
  CompositeTermination,
  ExternalTermination,
  FunctionCallTermination,
  HandoffTermination,
  MaxMessageTermination,
  TextMentionTermination,
  TimeoutTermination,
  TokenUsageTermination,
  ToolMessage,
  UserMessage
} from "../dist/index.js";

test("MaxMessageTermination tracks cumulative message count", () => {
  const termination = new MaxMessageTermination(2);
  assert.equal(termination.check([new UserMessage({ content: "a", source: "user" })]), undefined);
  const stop = termination.check([new AssistantMessage({ content: "b", source: "agent" })]);
  assert.match(stop.content, /Maximum messages/);
  assert.equal(termination.isMet(), true);
  assert.equal(termination.getMetadata().messageCount, 2);
  termination.reset();
  assert.equal(termination.isMet(), false);
});

test("TextMentionTermination supports case-insensitive and case-sensitive matching", () => {
  assert.ok(
    new TextMentionTermination("done").check([
      new AssistantMessage({ content: "DONE", source: "agent" })
    ])
  );
  assert.equal(
    new TextMentionTermination("done", true).check([
      new AssistantMessage({ content: "DONE", source: "agent" })
    ]),
    undefined
  );
});

test("TokenUsageTermination estimates tokens from content length", () => {
  const termination = new TokenUsageTermination(2);
  const stop = termination.check([new UserMessage({ content: "12345678", source: "user" })]);
  assert.match(stop.content, /Token limit exceeded/);
  assert.equal(termination.totalTokens, 2);
});

test("TimeoutTermination stops after elapsed time", async () => {
  const termination = new TimeoutTermination(0.001);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(termination.check([]).content, /Timeout reached/);
});

test("Function, handoff, external, and cancellation terminations work", () => {
  assert.ok(
    new FunctionCallTermination("search").check([
      new ToolMessage({
        content: "ok",
        source: "agent",
        toolCallId: "call",
        toolName: "search",
        success: true
      })
    ])
  );

  assert.ok(
    new HandoffTermination("writer").check([
      new AssistantMessage({ content: "Please handoff to writer", source: "agent" })
    ])
  );

  assert.ok(new ExternalTermination(() => true).check([]));

  const token = new CancellationToken();
  token.cancel();
  assert.ok(new CancellationTermination(token).check([]));
});

test("CompositeTermination supports any/all and fluent composition", () => {
  const text = new TextMentionTermination("done");
  const count = new MaxMessageTermination(2);
  const any = new CompositeTermination([text, count], "any");
  assert.ok(any.check([new AssistantMessage({ content: "done", source: "agent" })]));
  assert.equal(any.isMet(), true);

  const all = new CompositeTermination([
    new TextMentionTermination("done"),
    new MaxMessageTermination(1)
  ], "all");
  assert.ok(all.check([new AssistantMessage({ content: "done", source: "agent" })]));

  const fluent = new TextMentionTermination("stop").or(new MaxMessageTermination(5));
  assert.equal(fluent.mode, "any");
});
