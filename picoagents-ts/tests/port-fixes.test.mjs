import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  Agent,
  AgentResponse,
  AssistantMessage,
  BaseTool,
  CalculatorTool,
  DateTimeTool,
  ErrorEvent,
  HeadTailCompaction,
  OpenAIChatCompletionClient,
  PicoStore,
  PicoAgentsWebUIServer,
  PicoAgentsScanner,
  RegexTool,
  ToolCallResponseEvent,
  ToolCallRequest,
  ToolMessage,
  ToolResult,
  Usage,
  UserMessage,
  WebSearchTool,
  Workflow,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowRunner,
  FunctionStep
} from "../dist/index.js";

class EchoTool extends BaseTool {
  constructor() {
    super({ name: "echo", description: "Echo a value" });
  }

  get parameters() {
    return {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    };
  }

  async execute(parameters) {
    return new ToolResult({
      success: true,
      result: parameters.value
    });
  }
}

test("agent accepts cumulative streamed tool-call arguments", async () => {
  let calls = 0;
  const modelClient = {
    model: "fake",
    async create() {
      throw new Error("streaming path expected");
    },
    async *createStream() {
      calls += 1;
      if (calls === 1) {
        yield {
          content: "",
          isComplete: false,
          toolCallChunk: {
            id: "call_1",
            function: { name: "echo", arguments: "{\"value\":" }
          }
        };
        yield {
          content: "",
          isComplete: false,
          toolCallChunk: {
            id: "call_1",
            function: { name: "echo", arguments: "{\"value\":\"ok\"}" }
          }
        };
        yield { content: "", isComplete: true, usage: new Usage({ llmCalls: 1 }) };
        return;
      }
      yield { content: "done", isComplete: false };
      yield { content: "", isComplete: true, usage: new Usage({ llmCalls: 1 }) };
    }
  };

  const agent = new Agent({
    name: "tester",
    instructions: "Use tools when asked.",
    modelClient,
    tools: [new EchoTool()],
    maxIterations: 3
  });

  const items = [];
  for await (const item of agent.runStream("echo ok", { streamTokens: true })) {
    items.push(item);
  }

  const toolMessages = items.filter((item) => item instanceof ToolMessage);
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content, "ok");
  assert.ok(items.some((item) => item instanceof ToolCallResponseEvent && item.callId === "call_1"));
  assert.ok(items.some((item) => item instanceof AgentResponse));
});

test("compaction heuristic uses tokenizer-path message overhead", () => {
  const strategy = new HeadTailCompaction({ tokenBudget: 10 });
  const messages = [new UserMessage({ content: "x".repeat(24), source: "user" })];

  assert.equal(strategy.compact(messages), messages);
  assert.equal(strategy.compactionCount, 0);
});

test("Usage.add collapses zero totals to undefined", () => {
  const usage = new Usage().add(new Usage());

  assert.equal(usage.llmCalls, undefined);
  assert.equal(usage.tokensInput, undefined);
  assert.equal(usage.tokensOutput, undefined);
  assert.equal(usage.toolCalls, undefined);
  assert.equal(usage.memoryOperations, undefined);
});

test("parallel tool calls stream in completion order", async () => {
  class DelayTool extends BaseTool {
    constructor(name, delayMs) {
      super({ name, description: `${name} after ${delayMs}ms` });
      this.delayMs = delayMs;
    }

    get parameters() {
      return { type: "object", properties: {}, required: [] };
    }

    async execute() {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return new ToolResult({ success: true, result: this.name });
    }
  }

  let calls = 0;
  const modelClient = {
    model: "fake",
    async create() {
      calls += 1;
      if (calls > 1) {
        return {
          message: new AssistantMessage({ content: "done", source: "llm" }),
          usage: new Usage({ llmCalls: 1 }),
          model: "fake",
          finishReason: "stop"
        };
      }
      return {
        message: new AssistantMessage({
          content: "",
          source: "llm",
          toolCalls: [
            new ToolCallRequest({ toolName: "slow", parameters: {}, callId: "call_slow" }),
            new ToolCallRequest({ toolName: "fast", parameters: {}, callId: "call_fast" })
          ]
        }),
        usage: new Usage({ llmCalls: 1 }),
        model: "fake",
        finishReason: "tool_calls"
      };
    },
    async *createStream() {
      throw new Error("non-streaming path expected");
    }
  };

  const agent = new Agent({
    name: "tester",
    instructions: "Use tools.",
    modelClient,
    tools: [new DelayTool("slow", 40), new DelayTool("fast", 1)],
    summarizeToolResult: false
  });

  const items = [];
  for await (const item of agent.runStream("run both")) items.push(item);
  const toolMessages = items.filter((item) => item instanceof ToolMessage);

  assert.deepEqual(toolMessages.map((message) => message.toolName), ["fast", "slow"]);
});

test("agent treats mid-loop errors as recoverable and keeps prior finish reason", async () => {
  let calls = 0;
  const modelClient = {
    model: "fake",
    async create() {
      calls += 1;
      if (calls === 1) {
        return {
          message: new AssistantMessage({
            content: "",
            source: "llm",
            toolCalls: [
              new ToolCallRequest({
                toolName: "echo",
                parameters: { value: "ok" },
                callId: "call_recover"
              })
            ]
          }),
          usage: new Usage({ llmCalls: 1, tokensInput: 2, tokensOutput: 1 }),
          model: "fake",
          finishReason: "tool_calls"
        };
      }
      throw new Error("temporary model outage");
    },
    async *createStream() {
      throw new Error("non-streaming path expected");
    }
  };

  const agent = new Agent({
    name: "tester",
    instructions: "Use tools when asked.",
    modelClient,
    tools: [new EchoTool()],
    maxIterations: 3
  });

  const items = [];
  for await (const item of agent.runStream("echo then fail")) items.push(item);

  const error = items.find((item) => item instanceof ErrorEvent);
  const response = items.find((item) => item instanceof AgentResponse);
  assert.equal(error.isRecoverable, true);
  assert.match(error.errorMessage, /temporary model outage/);
  assert.ok(items.some((item) => item instanceof AssistantMessage && item.content.includes("I encountered an error")));
  assert.equal(response.finishReason, "tool_calls");
});

test("tool cancellation is propagated instead of converted into a tool message", async () => {
  class CancellingTool extends EchoTool {
    async execute() {
      throw new Error("Operation cancelled");
    }
  }

  const modelClient = {
    model: "fake",
    async create() {
      return {
        message: new AssistantMessage({
          content: "",
          source: "llm",
          toolCalls: [
            new ToolCallRequest({
              toolName: "echo",
              parameters: { value: "x" },
              callId: "call_cancel"
            })
          ]
        }),
        usage: new Usage({ llmCalls: 1 }),
        model: "fake",
        finishReason: "tool_calls"
      };
    },
    async *createStream() {
      throw new Error("non-streaming path expected");
    }
  };

  const agent = new Agent({
    name: "tester",
    instructions: "Use tools when asked.",
    modelClient,
    tools: [new CancellingTool()]
  });

  await assert.rejects(() => agent.run("cancel"), /Operation cancelled/);
});

test("OpenAI client retries transient provider responses", async () => {
  let calls = 0;
  const client = new OpenAIChatCompletionClient({
    model: "test-model",
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
          model: "test-model"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const result = await client.create([
    new UserMessage({ content: "hello", source: "user" })
  ]);
  assert.equal(result.message.content, "ok");
  assert.equal(calls, 2);
});

test("core tools match Python edge semantics", async () => {
  const regex = await new RegexTool().execute({
    operation: "findall",
    pattern: "(a)(b)",
    text: "ab ab"
  });
  assert.deepEqual(regex.result, [["a", "b"], ["a", "b"]]);

  const calc = await new CalculatorTool().execute({ expression: "sum([1, 2, 3]) + round(2.5)" });
  assert.equal(calc.result, "8");

    const parsed = await new DateTimeTool().execute({
      operation: "parse",
      value: "2025-01-15T10:30:00Z"
    });
    assert.equal(parsed.result, "2025-01-15T10:30:00+00:00");

    const offsetParsed = await new DateTimeTool().execute({
      operation: "parse",
      value: "2025-01-15T10:30:00+05:00"
    });
    assert.equal(offsetParsed.result, "2025-01-15T10:30:00+05:00");

    const offsetFormatted = await new DateTimeTool().execute({
      operation: "format",
      value: "2025-01-15T10:30:00+05:00",
      format: "%Y-%m-%d %H:%M:%S"
    });
    assert.equal(offsetFormatted.result, "2025-01-15 10:30:00");
  });

test("workflow failure does not emit a completion event", async () => {
  const workflow = new Workflow({ metadata: { name: "failure" }, workflowId: "wf_failure" });
  const step = new FunctionStep({
    stepId: "boom",
    metadata: { name: "Boom" },
    func: () => {
      throw new Error("boom");
    }
  });
  workflow.addStep(step).setStartStep(step).addEndStep(step);

  const events = [];
  for await (const event of new WorkflowRunner().runStream(workflow, {})) {
    events.push(event);
  }

  assert.ok(events.some((event) => event instanceof WorkflowFailedEvent));
  assert.ok(!events.some((event) => event instanceof WorkflowCompletedEvent));
});

test("web search tool fails explicitly without credentials", async () => {
  const result = await new WebSearchTool({ apiKey: "" }).execute({ query: "picoagents" });
  assert.equal(result.success, false);
  assert.match(result.error, /Tavily API key not provided/);
});

test("scanner discovers simple TypeScript entity files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "picoagents-ts-discovery-test-"));
  await writeFile(
    path.join(dir, "agent.ts"),
    `
      export const agent = {
        name: "ts-agent",
        async run() {},
        async *runStream() {}
      };
    `,
    "utf8"
  );

  const entities = await new PicoAgentsScanner(dir).discoverEntities();
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, "agent.agent");
  assert.equal(entities[0].type, "agent");
});

test("build copies bundled WebUI assets", () => {
  assert.equal(existsSync(path.join(process.cwd(), "dist", "webui", "ui", "index.html")), true);
});

test("WebUI eval list endpoints are persistence-backed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "picoagents-webui-store-"));
  const store = new PicoStore({
    dbPath: path.join(dir, "picoagents.db"),
    runsDir: path.join(dir, "runs"),
    evalDir: path.join(dir, "eval")
  });
  const server = await new PicoAgentsWebUIServer({ store }).createHttpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/eval/datasets`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await store.close();
  }
});
