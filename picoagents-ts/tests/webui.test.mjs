import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  AgentContext,
  AgentResponse,
  AssistantMessage,
  EntityRegistry,
  ExecutionEngine,
  FileSessionStore,
  InMemorySessionStore,
  PicoAgentsScanner,
  SessionManager,
  Usage,
  UserMessage
} from "../dist/index.js";
import {
  deserializeContext,
  parseApprovalResponses,
  parseMessages,
  serializeContext,
  sseData,
  wrapStreamEvent
} from "../dist/webui/serialization.js";
import { createStaticAgent, makeTempDir } from "./helpers.mjs";

test("PicoAgentsScanner discovers JavaScript and TypeScript agent entities", async () => {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, "agent.ts"),
    `
      export const agent = {
        name: "ts-agent",
        description: "TypeScript agent",
        tools: [{ name: "search" }],
        async run() {},
        async *runStream() {}
      };
    `,
    "utf8"
  );

  const scanner = new PicoAgentsScanner(dir);
  const entities = await scanner.discoverEntities();

  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, "agent.agent");
  assert.equal(entities[0].type, "agent");
  assert.deepEqual(entities[0].tools, ["search"]);
  assert.ok(scanner.getEntityObject("agent.agent"));
});

test("EntityRegistry registers in-memory entities and protects directory entities", async () => {
  const registry = new EntityRegistry();
  const agent = createStaticAgent("memory-agent", "ok", { tools: [{ name: "echo" }] });

  const info = registry.registerEntity("memory.agent", agent);
  assert.equal(info.type, "agent");
  assert.equal(registry.getEntityObject("memory.agent"), agent);
  assert.equal(registry.listAgents().length, 1);
  assert.equal(registry.unregisterEntity("memory.agent"), true);
});

test("Session stores and managers persist contexts", async () => {
  const manager = new SessionManager(new InMemorySessionStore());
  const context = await manager.getOrCreate("session-1", "agent-1");
  context.addMessage(new UserMessage({ content: "hello", source: "user" }));
  await manager.update("session-1", context);

  const sessions = await manager.list("agent-1");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].message_count, 1);
  assert.equal(await manager.delete("session-1"), true);
  assert.equal(await manager.clearAll(), 0);
});

test("FileSessionStore round-trips serialized contexts", async () => {
  const dir = await makeTempDir();
  const store = new FileSessionStore(dir);
  const context = new AgentContext({ sessionId: "s1", metadata: { entityId: "agent" } });
  context.addMessage(new AssistantMessage({ content: "hi", source: "agent" }));

  await store.save("s1", context);
  const restored = await store.get("s1");

  assert.equal(restored.sessionId, "s1");
  assert.equal(restored.messages[0].content, "hi");
  assert.equal((await store.clearAll()), 1);
});

test("WebUI serialization parses messages and approval responses", () => {
  const messages = parseMessages([
    { role: "user", content: "hi", source: "user" },
    { role: "assistant", content: "hello", source: "agent" }
  ]);
  assert.ok(messages[0] instanceof UserMessage);
  assert.ok(messages[1] instanceof AssistantMessage);

  const responses = parseApprovalResponses([
    { request_id: "req", tool_call_id: "call", approved: true, reason: "ok" }
  ]);
  assert.equal(responses[0].requestId, "req");
  assert.equal(responses[0].toolCallId, "call");

  const context = new AgentContext({ messages, sessionId: "s" });
  const restored = deserializeContext(serializeContext(context));
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.sessionId, "s");
});

test("ExecutionEngine streams agent output as SSE events and updates sessions", async () => {
  const manager = new SessionManager(new InMemorySessionStore());
  const engine = new ExecutionEngine(manager);
  const agent = createStaticAgent("agent", "streamed");

  const chunks = [];
  for await (const chunk of engine.executeAgentStream({
    agent,
    messages: [new UserMessage({ content: "hello", source: "user" })],
    sessionId: "s1",
    streamTokens: false
  })) {
    chunks.push(chunk);
  }

  assert.ok(chunks.every((chunk) => chunk.startsWith("data: ")));
  const parsed = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length)));
  assert.ok(parsed.some((item) => item.session_id === "s1"));
  assert.ok(await manager.get("s1"));
});

test("SSE wrappers serialize AgentResponse metadata", () => {
  const response = new AgentResponse({
    context: new AgentContext({
      messages: [new AssistantMessage({ content: "done", source: "agent" })]
    }),
    source: "agent",
    finishReason: "stop",
    usage: new Usage({ llmCalls: 1 })
  });

  const wrapped = wrapStreamEvent("s", response);
  const encoded = sseData(wrapped);

  assert.match(encoded, /^data: /);
  assert.equal(wrapped.event.finishReason, "stop");
  assert.equal(wrapped.event.usage.llm_calls, 1);
});
