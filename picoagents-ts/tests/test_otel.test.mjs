import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  AgentContext,
  MiddlewareContext,
  OTelMiddleware,
  ToolResult,
  Usage,
  UserMessage,
  maybeOtelMiddleware
} from "../dist/index.js";
import { collectAsync } from "./helpers.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeOtelScope = path.resolve(testDir, "../dist/node_modules/@opentelemetry");
const fakeOtelPackage = path.join(fakeOtelScope, "api");

function restoreEnv(original) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withOtelEnv(values, fn) {
  const original = {
    PICOAGENTS_ENABLE_OTEL: process.env.PICOAGENTS_ENABLE_OTEL,
    PICOAGENTS_OTEL_CAPTURE_CONTENT: process.env.PICOAGENTS_OTEL_CAPTURE_CONTENT,
    OTEL_METRICS_ENABLED: process.env.OTEL_METRICS_ENABLED
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    restoreEnv(original);
  }
}

async function installFakeOtelApi() {
  await mkdir(fakeOtelPackage, { recursive: true });
  await writeFile(
    path.join(fakeOtelPackage, "package.json"),
    JSON.stringify({
      name: "@opentelemetry/api",
      version: "0.0.0-test",
      type: "module",
      main: "index.js",
      exports: "./index.js"
    }),
    "utf8"
  );
  await writeFile(
    path.join(fakeOtelPackage, "index.js"),
    `export const trace = {
  getTracer(name) {
    globalThis.__picoagentsOtelTracerName = name;
    return globalThis.__picoagentsOtelTracer;
  }
};

export const metrics = {
  getMeter(name) {
    globalThis.__picoagentsOtelMeterName = name;
    return globalThis.__picoagentsOtelMeter;
  }
};
`,
    "utf8"
  );
}

function createRecordingTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name) {
      const span = {
        name,
        attributes: new Map(),
        statuses: [],
        ended: false,
        setAttribute(key, value) {
          this.attributes.set(key, value);
        },
        setStatus(status) {
          this.statuses.push(status);
        },
        end() {
          this.ended = true;
        }
      };
      spans.push(span);
      return span;
    }
  };
}

function createRecordingMeter() {
  const histograms = [];
  return {
    histograms,
    createHistogram(name, options) {
      const histogram = {
        name,
        options,
        records: [],
        record(value, attributes) {
          this.records.push({ value, attributes });
        }
      };
      histograms.push(histogram);
      return histogram;
    }
  };
}

after(async () => {
  await rm(fakeOtelScope, { recursive: true, force: true });
  delete globalThis.__picoagentsOtelTracer;
  delete globalThis.__picoagentsOtelTracerName;
  delete globalThis.__picoagentsOtelMeter;
  delete globalThis.__picoagentsOtelMeterName;
});

test("OTel is disabled by default and passes middleware values through", async () => {
  await withOtelEnv(
    {
      PICOAGENTS_ENABLE_OTEL: undefined,
      PICOAGENTS_OTEL_CAPTURE_CONTENT: undefined,
      OTEL_METRICS_ENABLED: undefined
    },
    async () => {
      assert.equal(maybeOtelMiddleware(), null);

      const middleware = new OTelMiddleware();
      const context = new MiddlewareContext({
        operation: "model_call",
        agentName: "agent",
        agentContext: new AgentContext(),
        data: [],
        metadata: { model: "gpt-test" }
      });

      const requestItems = await collectAsync(middleware.processRequest(context));
      assert.equal(requestItems.at(-1), context);
      assert.equal(context.metadata._otelSpan, undefined);

      const result = { ok: true };
      const responseItems = await collectAsync(middleware.processResponse(context, result));
      assert.equal(responseItems.at(-1), result);
    }
  );
});

test("OTel records model-call span attributes, content, usage, and status", async () => {
  await installFakeOtelApi();
  await withOtelEnv(
    {
      PICOAGENTS_ENABLE_OTEL: "true",
      PICOAGENTS_OTEL_CAPTURE_CONTENT: "true",
      OTEL_METRICS_ENABLED: "true"
    },
    async () => {
      const tracer = createRecordingTracer();
      const meter = createRecordingMeter();
      globalThis.__picoagentsOtelTracer = tracer;
      globalThis.__picoagentsOtelMeter = meter;

      const middleware = new OTelMiddleware();
      const context = new MiddlewareContext({
        operation: "model_call",
        agentName: "agent",
        agentContext: new AgentContext({ sessionId: "session-1" }),
        data: [new UserMessage({ content: "hello", source: "user" })],
        metadata: { model: "gpt-test" }
      });

      const requestItems = await collectAsync(middleware.processRequest(context));
      assert.equal(requestItems.at(-1), context);
      assert.equal(globalThis.__picoagentsOtelTracerName, "picoagents");
      assert.equal(globalThis.__picoagentsOtelMeterName, "picoagents");

      const span = tracer.spans[0];
      assert.equal(span.name, "chat gpt-test");
      assert.equal(context.metadata._otelSpan, span);
      assert.equal(span.attributes.get("gen_ai.system"), "picoagents");
      assert.equal(span.attributes.get("gen_ai.operation.name"), "model_call");
      assert.equal(span.attributes.get("gen_ai.agent.name"), "agent");
      assert.equal(span.attributes.get("gen_ai.session.id"), "session-1");
      assert.equal(span.attributes.get("gen_ai.request.model"), "gpt-test");
      assert.deepEqual(JSON.parse(span.attributes.get("gen_ai.input.messages")), [
        { role: "user", parts: [{ type: "text", content: "hello" }] }
      ]);

      const completion = {
        usage: new Usage({ tokensInput: 12, tokensOutput: 7 })
      };
      const responseItems = await collectAsync(middleware.processResponse(context, completion));
      assert.equal(responseItems.at(-1), completion);
      assert.equal(span.attributes.get("gen_ai.usage.input_tokens"), 12);
      assert.equal(span.attributes.get("gen_ai.usage.output_tokens"), 7);
      assert.deepEqual(span.statuses.at(-1), { code: 1 });
      assert.equal(span.ended, true);

      const tokenHistogram = meter.histograms.find((histogram) => histogram.name === "gen_ai.client.token.usage");
      const durationHistogram = meter.histograms.find(
        (histogram) => histogram.name === "gen_ai.client.operation.duration"
      );
      assert.equal(tokenHistogram.options.unit, "{token}");
      assert.equal(durationHistogram.options.unit, "s");
      assert.deepEqual(tokenHistogram.records, [
        { value: 12, attributes: { "gen_ai.token.type": "input", "gen_ai.operation.name": "model_call" } },
        { value: 7, attributes: { "gen_ai.token.type": "output", "gen_ai.operation.name": "model_call" } }
      ]);
      assert.equal(durationHistogram.records.length, 1);
      assert.equal(durationHistogram.records[0].attributes["gen_ai.operation.name"], "model_call");
      assert.equal(durationHistogram.records[0].value >= 0, true);
    }
  );
});

test("OTel records tool-call parameters, success, and errors", async () => {
  await installFakeOtelApi();
  await withOtelEnv(
    {
      PICOAGENTS_ENABLE_OTEL: "true",
      PICOAGENTS_OTEL_CAPTURE_CONTENT: "true",
      OTEL_METRICS_ENABLED: undefined
    },
    async () => {
      const tracer = createRecordingTracer();
      globalThis.__picoagentsOtelTracer = tracer;

      const middleware = new OTelMiddleware();
      const context = new MiddlewareContext({
        operation: "tool_call",
        agentName: "agent",
        agentContext: new AgentContext(),
        data: { toolName: "memory", parameters: { command: "view" } }
      });

      await collectAsync(middleware.processRequest(context));
      const span = tracer.spans[0];
      assert.equal(span.name, "tool memory");
      assert.equal(span.attributes.get("gen_ai.tool.name"), "memory");
      assert.equal(span.attributes.get("gen_ai.tool.parameters"), JSON.stringify({ command: "view" }));

      await collectAsync(
        middleware.processResponse(
          context,
          new ToolResult({ success: true, result: "ok" })
        )
      );
      assert.equal(span.attributes.get("gen_ai.tool.success"), true);
      assert.equal(span.ended, true);

      const errorContext = new MiddlewareContext({
        operation: "tool_call",
        agentName: "agent",
        agentContext: new AgentContext(),
        data: { toolName: "memory", parameters: { command: "delete" } }
      });
      await collectAsync(middleware.processRequest(errorContext));
      const errorSpan = tracer.spans[1];
      await assert.rejects(
        async () => {
          await collectAsync(middleware.processError(errorContext, new TypeError("boom")));
        },
        /boom/
      );
      assert.deepEqual(errorSpan.statuses.at(-1), { code: 2, message: "TypeError: boom" });
      assert.equal(errorSpan.attributes.get("error.type"), "TypeError");
      assert.equal(errorSpan.attributes.get("error.message"), "boom");
      assert.equal(errorSpan.ended, true);
    }
  );
});
