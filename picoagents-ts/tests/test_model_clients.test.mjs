import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AnthropicChatCompletionClient,
  AuthenticationError,
  AzureOpenAIChatCompletionClient,
  InvalidRequestError,
  OpenAIChatCompletionClient,
  RateLimitError,
  ToolCallRequest,
  UserMessage,
  buildToolCallsFromChunks
} from "../dist/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("OpenAIChatCompletionClient sends chat requests and parses tool calls", async () => {
  let request;
  const client = new OpenAIChatCompletionClient({
    model: "gpt-test",
    apiKey: "key",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        model: "gpt-test",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"q\":\"x\"}" }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 }
      });
    }
  });

  const result = await client.create([new UserMessage({ content: "hello", source: "user" })], {
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }]
  });

  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.init.headers.authorization, "Bearer key");
  assert.equal(request.body.model, "gpt-test");
  assert.equal(request.body.tool_choice, "auto");
  assert.equal(result.message.toolCalls[0].toolName, "lookup");
  assert.deepEqual(result.message.toolCalls[0].parameters, { q: "x" });
  assert.equal(result.usage.tokensInput, 7);
  assert.equal(result.usage.tokensOutput, 3);
});

test("OpenAIChatCompletionClient maps provider errors", async () => {
  const makeClient = (status) =>
    new OpenAIChatCompletionClient({
      apiKey: "key",
      maxRetries: 0,
      fetchImpl: async () => jsonResponse({ error: { message: "bad" } }, status)
    });

  await assert.rejects(
    () => makeClient(401).create([new UserMessage({ content: "x", source: "user" })]),
    AuthenticationError
  );
  await assert.rejects(
    () => makeClient(400).create([new UserMessage({ content: "x", source: "user" })]),
    InvalidRequestError
  );
  await assert.rejects(
    () => makeClient(429).create([new UserMessage({ content: "x", source: "user" })]),
    RateLimitError
  );
});

test("AzureOpenAIChatCompletionClient uses deployment URL and api-key header", async () => {
  let request;
  const client = new AzureOpenAIChatCompletionClient({
    azureEndpoint: "https://example.openai.azure.com/",
    azureDeployment: "deployment-a",
    apiVersion: "2024-10-21",
    apiKey: "azure-key",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "deployment-a"
      });
    }
  });

  await client.create([new UserMessage({ content: "hello", source: "user" })]);

  assert.match(request.url, /deployments\/deployment-a\/chat\/completions/);
  assert.match(request.url, /api-version=2024-10-21/);
  assert.equal(request.init.headers["api-key"], "azure-key");
  assert.equal(request.body.model, "deployment-a");
});

test("AnthropicChatCompletionClient converts messages and parses tool_use blocks", async () => {
  let request;
  const client = new AnthropicChatCompletionClient({
    model: "claude-test",
    apiKey: "key",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        model: "claude-test",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Thinking" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }
        ],
        usage: { input_tokens: 4, output_tokens: 5 }
      });
    }
  });

  const result = await client.create(
    [new UserMessage({ content: "hello", source: "user" })],
    { tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: {} } }] }
  );

  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "key");
  assert.equal(request.body.max_tokens, 4096);
  assert.equal(request.body.tools[0].name, "lookup");
  assert.equal(result.message.content, "Thinking");
  assert.equal(result.message.toolCalls[0].callId, "toolu_1");
  assert.deepEqual(result.message.toolCalls[0].parameters, { q: "x" });
});

test("buildToolCallsFromChunks rebuilds streamed tool calls", () => {
  const calls = buildToolCallsFromChunks(
    new Map([
      [
        "0",
        {
          id: "call_1",
          function: { name: "lookup", arguments: "{\"q\":\"x\"}" }
        }
      ]
    ])
  );

  assert.equal(calls[0] instanceof ToolCallRequest, true);
  assert.equal(calls[0].toolName, "lookup");
  assert.deepEqual(calls[0].parameters, { q: "x" });
});
