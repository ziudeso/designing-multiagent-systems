# picoagents-ts

TypeScript implementation of the PicoAgents core runtime.

Implemented modules:

- `agents`: async agent loop with tool calling, memory, streaming events, approvals, middleware, deterministic loop hooks, agent-as-tool composition, and computer-use browser automation agents/tools
- `workflow`: typed DAG workflow runner with parallel/conditional execution, real-time progress, validation, checkpointing/resume, and default workflows
- `tools`: tool base classes, function tools, utility tools, coding tools, research/web tools, memory tool, context-engineering tools (todo/skills/multi-edit/task), and MCP integration
- `llm`: unified chat completion client with OpenAI, Azure OpenAI, and Anthropic fetch clients
- `memory`: in-memory, file-backed, and ChromaDB memory stores
- `termination`: composable termination conditions
- `compaction`: token-aware context compaction strategies (head/tail, sliding window)
- `componentConfig`: component serialization (`dumpComponent`/`loadComponent`) across modules
- `middleware` / `otel`: middleware pipeline plus optional OpenTelemetry instrumentation
- `store`: SQLite-backed `PicoStore` persistence for runs, datasets, tasks, targets, and eval results
- `webui`: bundled camelCase WebUI static app, vendored rebuildable frontend source, entity discovery, sessions, streaming execution API, and persisted runs/eval APIs
- `cli`: unified `picoagents-ts` command with `ui` and `eval` subcommands

## Optional dependencies

`ComputerUseAgent` and `PlaywrightWebClient` are ported, but Playwright remains
an optional peer dependency so the base runtime does not install browser
automation by default:

```bash
npm install playwright
```

## Known divergences

- Workflow checkpoints are runtime-local. TypeScript checkpoints validate
  against the TypeScript workflow structure hash, including declared step
  input/output types or schemas, and should not be treated as interchangeable
  with Python-produced checkpoints.
- ChromaDB memory uses the Chroma HTTP API and requires a running ChromaDB
  server. The Python embedded/in-process Chroma client is not ported.
- OpenTelemetry support uses the JavaScript global providers/exporters. Spans are
  emitted when `PICOAGENTS_ENABLE_OTEL=true`; token and duration histograms are
  also recorded when `OTEL_METRICS_ENABLED=true`.
- Compaction token counts use a dependency-free character estimate, so exact
  thresholds can differ from Python tokenizer-backed runs.
- Structured output responses are parsed as JSON and checked against the
  declared JSON Schema for required fields and basic JSON types.
- `CopilotTarget` is omitted because there is no Node Copilot SDK binding in
  this package.
- The SQLite store backend uses `node:sqlite`, which requires Node 22+. On Node
  20 the store falls back to the JSON backend.
- Anthropic structured output uses the current GA `output_config.format` request
  shape. Python may still use the transitional beta `output_format` path until
  it is updated.

## CLI

```bash
picoagents-ts ui --dir ./agents
picoagents-ts eval list
picoagents-ts eval run ./dataset.json --configs ./configs.json --judge exact
picoagents-ts eval results
```

The package also keeps the older `picoagentsui-ts` WebUI launcher bin for
compatibility.

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
