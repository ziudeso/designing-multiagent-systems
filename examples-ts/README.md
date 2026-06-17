# PicoAgents TypeScript Examples

Runnable examples for the local `picoagents-ts` package.

## Quick Start

```bash
cd picoagents-ts
npm install
npm run build

cd ../examples-ts
npm install
npm run example:basic-agent
```

Examples run offline by default with a deterministic `StaticChatCompletionClient`
from `shared/modelClient.ts`. To run agent examples against OpenAI instead:

```bash
export OPENAI_API_KEY=...
export PICOAGENTS_EXAMPLES_LIVE=1
npm run example:basic-agent
```

## Examples

| Directory | What it Covers |
| --- | --- |
| `agents/` | Basic agents, structured output, memory, middleware, agent-as-tool composition, serialization |
| `tools/` | Tool categories and approval flow |
| `workflows/` | Sequential, conditional, fluent, and checkpointed workflows |
| `orchestration/` | Round-robin, AI-selected, and plan-based coordination |
| `evaluation/` | Reference-based and agent evaluation |
| `memory/` | List memory and file-backed memory tool examples |
| `mcp/` | MCP filesystem tool integration |
| `otel/` | OpenTelemetry instrumentation toggle |
| `webui/` | Serving in-memory agents and orchestrators |

The Python-only notebook, framework-comparison, full-stack app, and larger data
visualization case studies are intentionally not duplicated here.
