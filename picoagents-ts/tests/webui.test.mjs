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
  PicoAgentsWebUIServer,
  PicoStore,
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
  assert.equal(sessions[0].messageCount, 1);
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
  assert.ok(parsed.some((item) => item.sessionId === "s1"));
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
  assert.equal(wrapped.event.usage.llmCalls, 1);
});

test("WebUI persistence APIs manage runs, datasets, targets, eval jobs, and exports", async () => {
  const dir = await makeTempDir("picoagents-webui-persistence-");
  const store = new PicoStore({
    dbPath: path.join(dir, "picoagents.db"),
    runsDir: path.join(dir, "runs"),
    evalDir: path.join(dir, "eval")
  });
  const webui = new PicoAgentsWebUIServer({ store });
  const evalAgent = createStaticAgent("eval-agent", "ok");
  webui.registerEntity("eval.agent", evalAgent);
  const server = await webui.createHttpServer();
  await listen(server);

  try {
    const baseUrl = serverBaseUrl(server);
    const dataset = await requestJson(baseUrl, "/api/eval/datasets", {
      method: "POST",
      body: {
        name: "webui-dataset",
        tasks: [{ id: "task-1", name: "Task 1", input: "say ok", expectedOutput: "ok" }]
      }
    });
    assert.equal(dataset.taskCount, 1);

    const addedTask = await requestJson(baseUrl, `/api/eval/datasets/${dataset.id}/tasks`, {
      method: "POST",
      body: { id: "task-2", name: "Task 2", input: "say ok again", expectedOutput: "ok" }
    });
    assert.equal(addedTask.datasetId, dataset.id);

    const updatedTask = await requestJson(baseUrl, `/api/eval/datasets/${dataset.id}/tasks/${addedTask.id}`, {
      method: "PUT",
      body: { expectedOutput: "okay" }
    });
    assert.equal(updatedTask.expectedOutput, "okay");
    await requestJson(baseUrl, `/api/eval/datasets/${dataset.id}/tasks/${addedTask.id}`, { method: "DELETE" });

    const target = await requestJson(baseUrl, "/api/eval/targets", {
      method: "POST",
      body: {
        name: "discovered-agent",
        targetType: "discovered_agent",
        entityId: "eval.agent",
        config: {}
      }
    });
    assert.equal(target.targetType, "discovered_agent");

    const evalRun = await requestJson(baseUrl, "/api/eval/runs", {
      method: "POST",
      body: {
        datasetId: dataset.id,
        targetIds: [target.id],
        judgeConfig: { type: "contains" }
      }
    });
    assert.equal(evalRun.datasetId, dataset.id);

    const completed = await waitFor(async () => {
      const current = await requestJson(baseUrl, `/api/eval/runs/${evalRun.id}`);
      return current.status === "completed" || current.status === "error" ? current : undefined;
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.completedTasks, 1);

    const results = await requestJson(baseUrl, `/api/eval/runs/${evalRun.id}/results`);
    assert.equal(results.length, 1);
    assert.equal(results[0].overallScore, 10);

    const exportResponse = await fetch(`${baseUrl}/api/eval/runs/${evalRun.id}/export`);
    assert.equal(exportResponse.status, 200);
    const exported = await exportResponse.json();
    assert.equal(exported.run_id ?? exported.runId, evalRun.id);

    const agentResponse = await evalAgent.run("persisted history");
    const runId = await store.saveAgentRun(evalAgent, agentResponse);
    const runs = await requestJson(baseUrl, "/api/runs");
    assert.ok(runs.some((run) => run.id === runId && run.runType === "agent"));

    const runData = await requestJson(baseUrl, `/api/runs/${runId}/data`);
    assert.equal(runData.response.messages[0].content, "persisted history");
    await requestJson(baseUrl, `/api/runs/${runId}`, { method: "DELETE" });
    const runsAfterDelete = await requestJson(baseUrl, "/api/runs");
    assert.equal(runsAfterDelete.some((run) => run.id === runId), false);
  } finally {
    await closeServer(server);
    await store.close();
  }
});

test("WebUI eval run cancellation marks active background jobs cancelled", async () => {
  const dir = await makeTempDir("picoagents-webui-cancel-");
  const store = new PicoStore({
    dbPath: path.join(dir, "picoagents.db"),
    runsDir: path.join(dir, "runs"),
    evalDir: path.join(dir, "eval")
  });
  const webui = new PicoAgentsWebUIServer({ store });
  webui.registerEntity("slow.agent", createSlowAgent("slow-agent"));
  const server = await webui.createHttpServer();
  await listen(server);

  try {
    const baseUrl = serverBaseUrl(server);
    const dataset = await requestJson(baseUrl, "/api/eval/datasets", {
      method: "POST",
      body: {
        name: "cancel-dataset",
        tasks: [{ id: "slow-task", name: "Slow Task", input: "wait", expectedOutput: "ok" }]
      }
    });
    const target = await requestJson(baseUrl, "/api/eval/targets", {
      method: "POST",
      body: {
        name: "slow-target",
        targetType: "discovered_agent",
        entityId: "slow.agent"
      }
    });
    const evalRun = await requestJson(baseUrl, "/api/eval/runs", {
      method: "POST",
      body: {
        datasetId: dataset.id,
        targetIds: [target.id],
        judgeConfig: { type: "contains" }
      }
    });
    const cancelled = await requestJson(baseUrl, `/api/eval/runs/${evalRun.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, "cancelled");

    const finalRun = await waitFor(async () => {
      const current = await requestJson(baseUrl, `/api/eval/runs/${evalRun.id}`);
      return current.status === "cancelled" ? current : undefined;
    });
    assert.equal(finalRun.status, "cancelled");
  } finally {
    await closeServer(server);
    await store.close();
  }
});

async function requestJson(baseUrl, endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitFor(producer, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await producer();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function createSlowAgent(name) {
  return {
    name,
    async run(task, options = {}) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      options.cancellationToken?.throwIfCancelled();
      const context = new AgentContext();
      context.addMessage(new UserMessage({ content: String(task), source: "user" }));
      context.addMessage(new AssistantMessage({ content: "ok", source: name }));
      return new AgentResponse({
        context,
        source: name,
        finishReason: "stop",
        usage: new Usage({ durationMs: 200, llmCalls: 1, tokensInput: 1, tokensOutput: 1 })
      });
    }
  };
}

function serverBaseUrl(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
