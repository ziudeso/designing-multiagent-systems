import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  AgentConfigurationError,
  AgentResponse,
  AssistantMessage,
  MultiModalMessage,
  SystemMessage,
  TaskCompleteEvent,
  TaskStartEvent,
  UserMessage
} from "../dist/index.js";
import { collectAsync, createMockClient } from "./helpers.mjs";

test("Agent initializes with Python-parity defaults", () => {
  const client = createMockClient();
  const agent = new Agent({
    name: "assistant",
    description: "Helpful assistant",
    instructions: "Help with tasks.",
    modelClient: client
  });

  assert.equal(agent.name, "assistant");
  assert.equal(agent.description, "Helpful assistant");
  assert.equal(agent.modelClient, client);
  assert.equal(agent.maxIterations, 10);
  assert.deepEqual(agent.tools, []);
});

test("Agent validates required configuration", () => {
  assert.throws(
    () => new Agent({ name: "", instructions: "x", modelClient: createMockClient() }),
    AgentConfigurationError
  );
  assert.throws(
    () => new Agent({ name: "agent", instructions: "", modelClient: createMockClient() }),
    AgentConfigurationError
  );
});

test("Agent.run accepts string tasks and returns response context", async () => {
  const client = createMockClient({ responses: ["hello from model"] });
  const agent = new Agent({
    name: "assistant",
    instructions: "Reply.",
    modelClient: client
  });

  const response = await agent.run("Say hello");

  assert.ok(response instanceof AgentResponse);
  assert.equal(response.finishReason, "stop");
  assert.equal(response.messages.length, 2);
  assert.equal(response.messages[0].content, "Say hello");
  assert.equal(response.messages.at(-1).content, "hello from model");
  assert.equal(response.finalContent, "hello from model");
  assert.equal(client.receivedMessages[0][0] instanceof SystemMessage, true);
});

test("Agent.run accepts UserMessage and message arrays", async () => {
  const client = createMockClient({ responses: ["first", "second"] });
  const agent = new Agent({
    name: "assistant",
    instructions: "Reply.",
    modelClient: client
  });

  const first = await agent.run(new UserMessage({ content: "user msg", source: "tester" }));
  assert.equal(first.messages[0].source, "tester");

  const second = await agent.run([
    new UserMessage({ content: "one", source: "tester" }),
    new AssistantMessage({ content: "two", source: "assistant" })
  ]);
  assert.equal(second.messages[0].content, "one");
  assert.equal(second.messages[1].content, "two");
  assert.equal(second.messages.at(-1).content, "second");
});

test("Agent.runStream yields task, verbose events, model message, and final response", async () => {
  const client = createMockClient({ responses: ["stream done"] });
  const agent = new Agent({
    name: "streamer",
    instructions: "Reply.",
    modelClient: client
  });

  const items = await collectAsync(agent.runStream("work", { verbose: true }));

  assert.equal(items[0] instanceof UserMessage, true);
  assert.ok(items.some((item) => item instanceof TaskStartEvent));
  assert.ok(items.some((item) => item instanceof TaskCompleteEvent));
  assert.ok(items.some((item) => item instanceof AssistantMessage && item.content === "stream done"));
  assert.ok(items.at(-1) instanceof AgentResponse);
});

test("Agent.reset clears stored context and getInfo reports runtime metadata", () => {
  const agent = new Agent({
    name: "assistant",
    description: "desc",
    instructions: "Reply.",
    modelClient: createMockClient()
  });
  agent.context.addMessage(new UserMessage({ content: "old", source: "user" }));

  const before = agent.getInfo();
  assert.equal(before.name, "assistant");
  assert.equal(before.description, "desc");
  assert.equal(before.model, "test-model");
  assert.equal(before.toolsCount, 0);
  assert.equal(before.messageHistoryLength, 1);

  agent.reset();
  assert.equal(agent.context.messageCount, 0);
});

test("MultiModalMessage validates mutually exclusive data and mediaUrl", () => {
  assert.throws(
    () =>
      new MultiModalMessage({
        role: "user",
        content: "image",
        source: "user",
        mimeType: "image/png"
      }),
    /Either data or mediaUrl/
  );

  assert.throws(
    () =>
      new MultiModalMessage({
        role: "user",
        content: "image",
        source: "user",
        mimeType: "image/png",
        data: "abc",
        mediaUrl: "https://example.com/image.png"
      }),
    /Only one/
  );

  const message = new MultiModalMessage({
    role: "user",
    content: "image",
    source: "user",
    mimeType: "image/png",
    data: new Uint8Array([1, 2, 3])
  });
  assert.equal(message.isImage(), true);
  assert.equal(message.toBase64(), "AQID");
});
