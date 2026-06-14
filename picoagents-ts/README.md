# picoagents-ts

TypeScript implementation of the PicoAgents core runtime.

Implemented modules:

- `agents`: async agent loop with tool calling, memory, streaming events, approvals, middleware, deterministic loop hooks, and agent-as-tool composition
- `workflow`: typed DAG workflow runner with parallel/conditional execution, real-time progress, validation, checkpointing/resume, and default workflows
- `tools`: tool base classes, function tools, utility tools, coding tools, research/web tools, memory tool, context-engineering tools (todo/skills/multi-edit/task), and MCP integration
- `llm`: unified chat completion client with OpenAI, Azure OpenAI, and Anthropic fetch clients
- `memory`: in-memory, file-backed, and ChromaDB memory stores
- `termination`: composable termination conditions
- `compaction`: token-aware context compaction strategies (head/tail, sliding window)
- `componentConfig`: component serialization (`dumpComponent`/`loadComponent`) across modules
- `middleware` / `otel`: middleware pipeline plus optional OpenTelemetry instrumentation
- `webui`: bundled WebUI static app, entity discovery, sessions, and streaming execution API

Known scope note: the Python `computer_use` agent subsystem is not yet ported.

```ts
import { Agent, OpenAIChatCompletionClient, tool } from "picoagents-ts";

const add = tool(
  async ({ a, b }: { a: number; b: number }) => a + b,
  {
    name: "add",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" }
      },
      required: ["a", "b"]
    }
  }
);

const agent = new Agent({
  name: "assistant",
  instructions: "Use tools when useful.",
  modelClient: new OpenAIChatCompletionClient({ model: "gpt-4.1-mini" }),
  tools: [add]
});

const result = await agent.run("What is 2 + 3?");
console.log(result.finalContent);
```
