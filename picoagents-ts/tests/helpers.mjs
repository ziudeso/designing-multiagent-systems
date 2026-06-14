import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AgentContext,
  AgentResponse,
  AssistantMessage,
  BaseTool,
  ToolResult,
  Usage,
  UserMessage
} from "../dist/index.js";

export async function collectAsync(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export function lastInstance(items, ctor) {
  return items.filter((item) => item instanceof ctor).at(-1);
}

export async function makeTempDir(prefix = "picoagents-ts-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export class EchoTool extends BaseTool {
  constructor(options = {}) {
    super({
      name: options.name ?? "echo",
      description: options.description ?? "Echo a value",
      approvalMode: options.approvalMode
    });
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        value: { type: "string" }
      },
      required: ["value"]
    };
  }

  async execute(parameters) {
    return new ToolResult({
      success: true,
      result: parameters.value,
      metadata: { echoed: true }
    });
  }
}

export function createMockClient(options = {}) {
  const client = {
    model: options.model ?? "test-model",
    callCount: 0,
    streamCallCount: 0,
    receivedMessages: [],
    receivedOptions: [],
    responses: [...(options.responses ?? ["ok"])].map(normalizeResponse),
    streamChunks: [...(options.streamChunks ?? [])],

    setResponses(responses) {
      this.responses = [...responses].map(normalizeResponse);
    },

    async create(messages, callOptions = {}) {
      this.callCount += 1;
      this.receivedMessages.push(messages);
      this.receivedOptions.push(callOptions);
      const response = this.responses.length ? this.responses.shift() : normalizeResponse("ok");
      if (response instanceof Error) throw response;
      return response;
    },

    async *createStream(messages, callOptions = {}) {
      this.streamCallCount += 1;
      this.receivedMessages.push(messages);
      this.receivedOptions.push(callOptions);
      for (const chunk of this.streamChunks) {
        if (chunk instanceof Error) throw chunk;
        yield chunk;
      }
    }
  };
  return client;
}

export function normalizeResponse(value) {
  if (value instanceof Error) return value;
  if (typeof value === "string") {
    return {
      message: new AssistantMessage({ content: value, source: "llm" }),
      usage: new Usage({ durationMs: 1, llmCalls: 1, tokensInput: 5, tokensOutput: 3 }),
      model: "test-model",
      finishReason: "stop"
    };
  }
  if (value instanceof AssistantMessage) {
    return {
      message: value,
      usage: new Usage({ durationMs: 1, llmCalls: 1, tokensInput: 5, tokensOutput: 3 }),
      model: "test-model",
      finishReason: value.toolCalls?.length ? "tool_calls" : "stop"
    };
  }
  return {
    usage: new Usage({ durationMs: 1, llmCalls: 1, tokensInput: 5, tokensOutput: 3 }),
    model: "test-model",
    finishReason: value?.message?.toolCalls?.length ? "tool_calls" : "stop",
    ...value
  };
}

export function createStaticAgent(name, replies, options = {}) {
  const replyList = Array.isArray(replies) ? replies : [replies];
  const agent = {
    name,
    description: options.description ?? `${name} description`,
    instructions: options.instructions ?? "Respond statically.",
    tools: options.tools ?? [],
    context: new AgentContext(),
    maxIterations: 10,
    calls: [],

    async run(task) {
      const callIndex = this.calls.length;
      this.calls.push(task);
      const context = new AgentContext();
      if (task !== undefined) {
        context.addMessage(new UserMessage({ content: String(task), source: "user" }));
      }
      const selected = replyList[Math.min(callIndex, replyList.length - 1)];
      const messages = Array.isArray(selected) ? selected : [selected];
      for (const message of messages) {
        context.addMessage(
          message instanceof AssistantMessage
            ? message
            : new AssistantMessage({ content: String(message), source: name })
        );
      }
      return new AgentResponse({
        context,
        source: name,
        finishReason: "stop",
        usage: new Usage({ durationMs: 1, llmCalls: 1, tokensInput: 1, tokensOutput: 1 })
      });
    },

    async *runStream(task) {
      const response = await this.run(task);
      if (task !== undefined) {
        yield response.messages[0];
      }
      for (const message of response.messages) {
        if (!(message instanceof UserMessage)) yield message;
      }
      yield response;
    }
  };
  return agent;
}
