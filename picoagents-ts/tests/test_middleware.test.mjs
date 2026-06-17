import assert from "node:assert/strict";
import { test } from "node:test";

import {
    AgentContext,
    AssistantMessage,
    BaseMiddleware,
    ErrorEvent,
    GuardrailMiddleware,
    LoggingMiddleware,
    MetricsMiddleware,
    MiddlewareChain,
    MiddlewareContext,
    PIIRedactionMiddleware,
    ToolCallRequest,
    ToolResult,
    Usage,
    UserMessage
  } from "../dist/index.js";
import { collectAsync } from "./helpers.mjs";

class TransformMiddleware extends BaseMiddleware {
  async *processRequest(context) {
    context.data = { value: Number(context.data.value) + 1 };
    yield context;
  }

  async *processResponse(_context, result) {
    yield result * 2;
  }
}

class RecoveringMiddleware extends BaseMiddleware {
  async *processError(_context, error) {
    yield new ErrorEvent({
      source: "middleware",
      errorMessage: error.message,
      errorType: error.name
    });
    yield "recovered";
  }
}

test("MiddlewareChain applies request and response middleware in order", async () => {
  const chain = new MiddlewareChain([new TransformMiddleware()]);
  const items = await collectAsync(
    chain.executeStream(
      "operation",
      "agent",
      new AgentContext(),
      { value: 2 },
      async (data) => data.value + 1
    )
  );

  assert.equal(items.at(-1), 8);
});

test("MiddlewareChain can recover from operation errors", async () => {
  const chain = new MiddlewareChain([new RecoveringMiddleware()]);
  const items = await collectAsync(
    chain.executeStream("operation", "agent", new AgentContext(), {}, async () => {
      throw new Error("boom");
    })
  );

  assert.ok(items[0] instanceof ErrorEvent);
  assert.equal(items.at(-1), "recovered");
});

test("GuardrailMiddleware blocks configured tools and patterns", async () => {
  const chain = new MiddlewareChain([
    new GuardrailMiddleware({ blockedTools: ["danger"], blockedPatterns: ["secret"] })
  ]);

  await assert.rejects(
    () =>
      collectAsync(
        chain.executeStream(
          "tool_call",
          "agent",
          new AgentContext(),
          { toolName: "danger", parameters: {} },
          async () => "ok"
        )
      ),
    /blocked by guardrails/
  );

  await assert.rejects(
    () =>
      collectAsync(
        chain.executeStream(
          "tool_call",
          "agent",
          new AgentContext(),
          { toolName: "safe", parameters: { value: "secret" } },
          async () => "ok"
        )
      ),
    /blocked pattern/
  );
});

test("PIIRedactionMiddleware redacts model messages, tool params, and outputs", async () => {
  const chain = new MiddlewareChain([new PIIRedactionMiddleware()]);
  let modelInput;
  const modelItems = await collectAsync(
    chain.executeStream(
      "model_call",
      "agent",
      new AgentContext(),
      [new UserMessage({ content: "Email ada@example.com", source: "user" })],
      async (messages) => {
        modelInput = messages[0].content;
        return {
          message: new AssistantMessage({
            content: "Use card 4111 1111 1111 1111",
            source: "llm"
          }),
          usage: new Usage(),
          model: "test",
          finishReason: "stop"
        };
      }
    )
  );

  const modelResult = modelItems.at(-1);
  assert.equal(modelInput, "Email [EMAIL-REDACTED]");
  assert.equal(modelResult.message.content, "Use card [CC-REDACTED]");

  let toolParams;
  const toolItems = await collectAsync(
    chain.executeStream(
      "tool_call",
      "agent",
      new AgentContext(),
      new ToolCallRequest({
        toolName: "lookup",
        parameters: { query: "Call 555-123-4567" },
        callId: "call_1"
      }),
      async (toolCall) => {
        toolParams = toolCall.parameters;
        return new ToolResult({ success: true, result: "SSN 123-45-6789" });
      }
    )
  );

  const toolResult = toolItems.at(-1);
  assert.equal(toolParams.query, "Call [PHONE-REDACTED]");
  assert.equal(toolResult.result, "SSN [SSN-REDACTED]");
});

test("MetricsMiddleware counts operations and errors", async () => {
  const metrics = new MetricsMiddleware();
  const chain = new MiddlewareChain([metrics]);

  await collectAsync(
    chain.executeStream("model_call", "agent", new AgentContext(), {}, async () => "ok")
  );
  await assert.rejects(
    () =>
      collectAsync(
        chain.executeStream("tool_call", "agent", new AgentContext(), {}, async () => {
          throw new TypeError("bad");
        })
      ),
    /bad/
  );

  const snapshot = metrics.getMetrics();
  assert.equal(snapshot.totalOperations, 2);
  assert.equal(snapshot.operationsByType.model_call, 1);
  assert.equal(snapshot.operationsByType.tool_call, 1);
  assert.equal(snapshot.errorsByType.TypeError, 1);
});

test("LoggingMiddleware writes start and completion records", async () => {
  const logs = [];
  const logger = {
    info: (line) => logs.push(line),
    error: (line) => logs.push(line)
  };
  const chain = new MiddlewareChain([new LoggingMiddleware(logger)]);

  await collectAsync(
    chain.executeStream("model_call", "agent", new AgentContext(), {}, async () => "ok")
  );

  assert.match(logs[0], /Starting model_call/);
  assert.match(logs[1], /Completed model_call/);
});

test("MiddlewareContext carries metadata and agent context", () => {
  const agentContext = new AgentContext({ metadata: { id: "ctx" } });
  const context = new MiddlewareContext({
    operation: "tool_call",
    agentName: "agent",
    agentContext,
    data: { value: 1 },
    metadata: { requestId: "req" }
  });

  assert.equal(context.operation, "tool_call");
  assert.equal(context.agentContext, agentContext);
  assert.equal(context.metadata.requestId, "req");
});
