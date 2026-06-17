# picoagents-ts — Port Review & Next Steps

**Scope:** the TypeScript port in `picoagents-ts/` vs. the Python original in `picoagents/src/picoagents/`, plus `examples-ts/` vs. `examples/`.
**Method:** per-module read of both sides, `npm test` (builds with `tsc` then runs `node --test`), and the Anthropic structured-output / OTel paths checked against the **live Claude API reference** (not from memory).
**Date:** 2026-06-17.

> **Framing — read this first.** This is a **standalone TypeScript port**. Python is the **behavior spec, not an interop target**. The two runtimes are not expected to exchange config JSON, checkpoint files, eval result files, or share a `picoagents.db`. That single fact reclassifies most of what a naive diff (or an over-eager scan) flags as "bugs":
>
> - **`snake_case` → `camelCase` of internal keys is NOT a defect** when the TS side reads what it writes (config objects, `toJSON`/`toConfig`, store columns, eval result files, checkpoint hashes). The runtime is internally consistent, so these are correct.
> - **`snake_case` MUST be preserved only for external protocols** where the *service*, not Python, is the spec: LLM request/response wire JSON, MCP, the ChromaDB HTTP API, OpenTelemetry attribute keys, and the WebUI routes/bodies the bundled frontend calls. The port **gets these right** (verified — see [Naming](#naming-snake_case--camelcase)).
> - **Cross-runtime artifact equality is a non-goal.** A TS checkpoint hash that differs byte-for-byte from Python's is fine as long as TS reads what TS writes.
>
> So this review weights **behavioral divergences and real bugs heavily**, and **naming lightly**. Naming is collected in one section at the end with an explicit "matters / doesn't matter" verdict.

---

## TL;DR

The port is in **good shape and more faithful than a diff suggests**. Every advertised subsystem is present, the build is clean, and the suite is now at **174 passing tests**. A four-way module-by-module re-verification (core runtime, agents/tools/termination, workflow/orchestration, eval/store/memory/webui) found **no real bugs** — only a handful of minor, *internally-consistent* deviations from the Python spec, plus cosmetic/scope polish.

| Health check | Result |
| --- | --- |
| `tsc` (via `npm run build`) | ✅ clean |
| `npm test` (`node --test`, after build) | ✅ **174 / 174 pass** |
| Built WebUI ships + auto-served (`copy-webui-assets.mjs` in `build`) | ✅ |
| `.ts` entity auto-discovery (`webui/discovery.ts`) | ✅ |

---

## ⚠️ Correction notice — the two prior "headline" items are resolved

An earlier draft of this review listed two open issues: a P0 Anthropic structured-output divergence and a P1 "OTel metrics not ported." **Both were re-checked against the live code and the current Claude API reference and are not actionable.** Recording the correction so they don't get "fixed" back into regressions:

### 1. Anthropic structured output — TS uses the *current GA shape*; Python is on the *legacy beta path*

The TS client sends `body.output_config = { format: { type: "json_schema", schema } }` on the standard `/v1/messages` endpoint, with **no beta header** ([anthropic.ts:288-295](src/llm/anthropic.ts#L288-L295)). Against the **current Claude API** this is exactly right: `output_config.format` is the canonical, **GA** structured-output parameter (no beta header required on Fable 5 / Opus 4.8 / Sonnet 4.6 / Haiku 4.5), and the old top-level `output_format` parameter is **deprecated**.

The Python "spec" uses the *older* path: `betas=["structured-outputs-2025-11-13"]` + a top-level `output_format` field + `client.beta.messages.create` ([_anthropic.py:138-156](../picoagents/src/picoagents/llm/_anthropic.py#L138-L156)). That was correct when written against an early beta; it is now the legacy shape.

**Verdict:** For a standalone port whose job is to reproduce the *behavior* (constrained JSON output) on the *current* API, the TS is correct — arguably more current than Python. The default model `claude-sonnet-4-6` ([anthropic.ts:53](src/llm/anthropic.ts#L53)) supports GA structured outputs. The TS also **validates** the parsed object against the schema (`parseStructuredOutput` → `validateJsonSchema`, [base.ts:192-244](src/llm/base.ts#L192-L244)), so the earlier "raw `JSON.parse`, no validation" nit is also false. **Action:** none required beyond a one-call live smoke test; optionally add a code comment noting the Python spec is on the deprecated beta path. Streaming intentionally ignores `outputFormat` ([anthropic.ts:150](src/llm/anthropic.ts#L150)), matching Python's "not supported in streaming" warning.

### 2. OTel — token + duration metrics *are* ported (only the OTLP provider bootstrap is BYO)

[otel.ts](src/otel.ts) creates the `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` histograms, gated on `OTEL_METRICS_ENABLED` ([otel.ts:77-92](src/otel.ts#L77-L92)), and records them on each response ([otel.ts:154-167](src/otel.ts#L154-L167)). The only thing Python does that TS does not is **bootstrap the OTLP exporters + `MeterProvider`/`TracerProvider` in-library** ([_otel.py:78-147](../picoagents/src/picoagents/_otel.py#L78-L147)); TS relies on an externally-configured global provider — the **idiomatic** JS pattern (the app owns SDK/exporter setup). Moreover TS reads `usage.tokensInput`/`tokensOutput` (the real picoagents `Usage` shape) whereas Python reads OpenAI-style `prompt_tokens`/`completion_tokens` that **don't exist** on picoagents `Usage` — so the TS metrics actually fire where Python's silently would not. **Action:** document OTel as "spans + metrics, bring-your-own provider/exporter." No code change.

---

## Scorecard (re-verified 2026-06-17)

Qualitative verdicts from reading both sides. "Faithful" = behavior matches the Python spec; "Minor deviation" = an internally-consistent difference noted below; no module rated a real gap.

| Module(s) | Verdict | Note |
| --- | --- | --- |
| `types` / `messages` / `context` | Faithful | display `__str__`/`__repr__` not ported (cosmetic); `Usage.add` zero-collapse differs only in the never-hit "costs sum to exactly 0" edge |
| `compaction` | Minor deviation | TS always uses a `len/4` heuristic (+4 role, +4/tool-call); Python uses tiktoken when available, `len/4 + 10` only as fallback. See [P2-1](#p2--minor--scope) |
| `instructions` / `hooks` / `middleware` | Minor deviation | `todo_write` schema is `content/status/activeForm` (Claude-Code style) vs Python `…/id` — **internally consistent** (the TS tool requires `activeForm` too). See [P2-2](#p2--minor--scope) |
| `componentConfig` | Faithful | registry-based lookup vs Python `importlib` (expected JS idiom); version-migration + `validateComponentConfig` + `expected instanceof` all present |
| `cancellation` | Faithful | `Set` of callbacks vs `threading.Lock`; `linkAbortController` vs `link_future` — same behavior |
| `otel` | Faithful* | spans + token/duration histograms present; OTLP provider/exporter setup is BYO by design (see correction #2) |
| `llm` (base/openai/azure) | Faithful | streaming tool-call accumulation keys on `index ?? id` — equivalent to Python's `index if not None else id` (handles `index=0`) |
| `llm` (anthropic) | Faithful | uses current GA `output_config.format` (see correction #1) |
| `agents` (core / base / agentAsTool) | Faithful | parallel tool exec uses a live `AsyncToolEventQueue` with per-call error isolation; no `Promise.all` buffering |
| `tools` (base/core/memory/decorator/mcp) | Faithful | `validateParameters`, `memoryTool.rename` guards, MCP namespacing all match |
| `tools` (context) | Minor deviation | the `research` agent roster includes `arxiv_search` + `youtube_caption`; Python's lists only `web_search/web_fetch/think`. See [P2-3](#p2--minor--scope) |
| `termination` | Faithful | all 10 conditions present; lazy-init/getter-vs-field differences only |
| `workflow` (index/defaults/schemaUtils) | Faithful | per-edge type-compat validation, `cancelWorkflow`, nested execution-status all present |
| `workflow` (checkpoint) | Faithful | structure hash captures I/O type identity + schemas; hash bytes need not match Python (cross-runtime equality is a non-goal) |
| `orchestration` (base/handoff/roundRobin) | Faithful | — |
| `orchestration` (ai/plan) | Minor deviation | selection/planning **prompt text** reworded; `plan.ts` fallback step-eval heuristic is stricter (no positive-keyword path). See [P2-4](#p2--minor--scope) |
| `eval` (all) | Faithful | all judges + targets present; `CopilotTarget` intentionally absent (no Copilot SDK) |
| `store` | Faithful | all methods/tables present; SQLite-only (rejects non-sqlite URLs) — by design |
| `memory` | Faithful | all 4 classes incl. ChromaDB-over-HTTP |
| `webui` | Faithful | route paths + request bodies preserved; accepts both `snake_case`/`camelCase` on input |
| `cli` | Faithful | superset of Python; `--reload`/`--log-level` dropped (scope) |

---

## Next steps — prioritized

There is **no P0/P1 correctness work** left. The remaining items are small and are **quality/parity, not coverage**.

### P2 — minor / scope

1. **Compaction token accuracy.** TS approximates tokens as `len/4` (+4 role, +4/tool-call) on every path ([compaction.ts:46-64](src/compaction.ts#L46-L64)); Python uses tiktoken when installed and only falls back to `len/4 + 10`. The `len/4` heuristic is a *reasonable* standalone choice — note that tiktoken is OpenAI-specific and under-counts Claude tokens anyway, so the real accuracy lever would be the provider's `count_tokens` endpoint, not porting tiktoken. **Action (optional):** leave as-is, or wire a provider token-count call for accuracy-sensitive compaction.
2. **`todo_write` schema differs from Python (intentional, internally consistent).** TS uses `content/status/activeForm` ([contextTools.ts:444-458](src/tools/contextTools.ts#L444-L458)) and the guide matches ([instructions.ts](src/instructions.ts)); Python uses `content/status/id`. Both are self-consistent. **Action:** none, unless you specifically want Python-parity todo semantics — then switch the field and its guide together.
3. **`research` agent tool roster richer than Python.** TS adds `arxiv_search` + `youtube_caption` ([contextTools.ts:84](src/tools/contextTools.ts#L84)) vs Python's `web_search/web_fetch/think` ([_context_tools.py:77](../picoagents/src/picoagents/tools/_context_tools.py#L77)). **Action:** pick the canonical roster and align (the YouTube tool also uses a defunct `timedtext` endpoint — see below).
4. **Orchestration prompt drift.** `ai.ts`/`plan.ts` selection & planning prompts are reworded vs Python, and `plan.ts`'s fallback step-evaluation heuristic ([plan.ts:354-372](src/orchestration/plan.ts#L354-L372)) is stricter than Python's (Python also matches positive-completion keywords). LLM-behavior-affecting only. **Action:** align prompt text + the fallback heuristic if you want behavioral parity; otherwise leave.
5. **Research-tool depth.** YouTube caption tool targets a defunct `timedtext` endpoint; `WebFetch`/`ExtractText` use hand-rolled regex vs Python's `html2text`/BeautifulSoup; `createResearchTools` returns all tools with no dependency gating ([researchTools.ts](src/tools/researchTools.ts)).
6. **Cosmetic display parity.** `__str__`/`__repr__` on messages/events/`Usage` are not ported (TS has `toString()` on some). Display-only; port if pretty-printing parity matters.
7. **Document intentional scope cuts in the README:** `CopilotTarget` not ported (no Copilot SDK); `webui` CLI drops `--reload`/`--log-level`; store is SQLite-only (rejects Postgres URLs); OTel is "spans + metrics, bring-your-own provider."

### Verified non-issues — do **not** "fix"

These were flagged by automated scans but are correct for a standalone port:

| Flag | Reality (verified) |
| --- | --- |
| Anthropic structured output uses a non-spec request shape | `output_config.format` is the **current GA** shape; Python's beta-header path is legacy (correction #1) |
| OTel Gen-AI metrics not ported | token + duration histograms present + recorded; only OTLP provider bootstrap is BYO (correction #2) |
| `parseStructuredOutput` does no schema validation | it calls `validateJsonSchema` and returns `undefined` on mismatch ([base.ts:192-244](src/llm/base.ts#L192-L244)) |
| Workflow structure-hash inputs differ from Python | cross-runtime hash equality is a **non-goal**; TS captures I/O type identity + schemas and is internally consistent ([checkpoint.ts:548-583](src/workflow/checkpoint.ts#L548-L583)) |
| Streaming tool-call keying `index ?? id` can collide | equivalent to Python's `index if not None else call_id`; `??` correctly keeps `index=0` ([openai.ts:214](src/llm/openai.ts#L214)) |
| `todo_write` docs mismatch the tool | guide and tool both use `activeForm` — consistent ([contextTools.ts:429-458](src/tools/contextTools.ts#L429-L458)) |
| `componentConfig` skips migration / schema / `expected` checks | all present ([componentConfig.ts](src/componentConfig.ts)) |
| `Usage.add` returns `0` instead of `None` | `collapseZeroUsage` collapses `0`→`undefined` ([types.ts:41-55](src/types.ts#L41-L55)); only the impossible "positive costs sum to 0" edge differs |
| Parallel tool exec buffers events / no isolation | live `AsyncToolEventQueue`, per-call error isolation ([agent.ts](src/agents/agent.ts)) |

---

## Examples coverage (`examples/` → `examples-ts/`)

Counting only **core picoagents examples** (excluding `examples/frameworks/**`, which are *other-framework* comparison demos, and `examples/app/`): **~22 of ~36** example units are ported. Multi-file example dirs count as one unit.

**Missing TS ports** (port or explicitly skip):

| Python example | Notes |
| --- | --- |
| `agents/agent_anthropic.py` | direct Anthropic client demo |
| `agents/agent_githubmodels.py` | GitHub Models endpoint |
| `agents/computer_use.py` | **subsystem is ported in `src/agents/computerUse/` but has no example** — worth adding |
| `agents/middleware_custom.py` | custom middleware authoring |
| `agents/software_engineer_agent.py` (+ `swe_agent/`) | coding-tools showcase |
| `evaluation/comprehensive-evaluation.py` | larger eval walk-through |
| `evaluation/generate_expected_answers.py` | reference-answer generation |
| `orchestration/ai-driven-research.py` | research-orchestration demo |
| `otel/agent_with_content_capture.py` | exercises `PICOAGENTS_OTEL_CAPTURE_CONTENT` |
| `tools/youtube_caption_demo.py` | ties to the YouTube tool (P2-5) |
| `workflows/data_visualization/` | multi-step workflow example |
| `workflows/yc_analysis/` | multi-step workflow example |

(`tools/test_agent_with_context.py` and `tools/test_approval_basic.py` are test-shaped; treat as optional.) The `examples-ts/dist/` build output is checked in — confirm `examples-ts/.gitignore` covers `dist/`.

---

## Naming: `snake_case` → `camelCase`

Per the framing this is mostly **not actionable** for a standalone port. Recorded so the next implementer doesn't re-litigate it.

### Preserved correctly — leave as-is (external protocol = the real spec)

The port already keeps these `snake_case`, and **must**:

- **LLM wire JSON:** `tool_calls`, `tool_call_id`, `finish_reason`, `max_tokens`, `response_format`, `prompt_tokens`/`completion_tokens` (OpenAI), `input_tokens`/`output_tokens` + `stop_reason` + `input_schema` + `media_type` (Anthropic), `output_config` / `json_schema` (structured output), `stream_options`/`include_usage`, `function.name`/`arguments`, `image_url`.
- **MCP:** tool namespacing `mcp_{serverId}_{tool}`; transport values `stdio`/`sse`/`streamable-http`.
- **ChromaDB HTTP API:** `query_texts`, `n_results`, `get_or_create`, `mime_type`.
- **OTel:** `gen_ai.*` dotted attribute keys; histogram names `gen_ai.client.token.usage` / `gen_ai.client.operation.duration`.
- **WebUI:** route paths are byte-identical; request bodies accept `snake_case` (`entity_id`, `run_type`, `dataset_id`, `target_ids`, `judge_config`, `default_eval_criteria`, …) **and** camelCase.
- **Discriminator string values:** event `eventType` (`"task_start"`, …), `finish_reason` values, `StepStatus`/`WorkflowStatus`/`WorkflowEventType` enums, message `source`/`role` — all byte-identical.

### Renamed to camelCase — fine for standalone (internally consistent)

Constructor options, `toConfig()`/`toJSON()` keys, `metadata` dicts, store **column names** (`runType`, `createdAt`, …), eval result/dataset JSON files, component-config `componentType`/`componentVersion`, checkpoint structure-hash inputs. The TS runtime reads what it writes; several loaders (`messageFromObject`, termination/orchestrator `fromConfig`, `cli.ts` readers, `normalizeEdgeCondition`, the WebUI body parsers) even accept *both* cases on input. **No change needed** unless cross-runtime artifact sharing becomes a goal — in which case the two tables above are your migration map.

### Reference: common renames applied throughout

`duration_ms`→`durationMs`, `tokens_input`→`tokensInput`, `tokens_output`→`tokensOutput`, `cost_estimate`→`costEstimate`, `llm_calls`→`llmCalls`, `finish_reason`→`finishReason`, `tool_calls`→`toolCalls`, `tool_call_id`→`toolCallId`, `tool_name`→`toolName`, `call_id`→`callId`, `shared_state`→`sharedState`, `session_id`→`sessionId`, `created_at`→`createdAt`, `model_client`→`modelClient`, `max_iterations`→`maxIterations`, `output_format`→`outputFormat`, `token_budget`→`tokenBudget`, `head_ratio`→`headRatio`, `from_step`→`fromStep`, `step_id`→`stepId`, `workflow_id`→`workflowId`, `delay_seconds`→`delaySeconds`, `server_id`→`serverId`, `capture_screenshot`→`captureScreenshot`, `is_task_complete`→`isTaskComplete`, `input_type`/`output_type`→`inputTypeName`/`outputTypeName`, `to_dict`/`to_config`→`toJSON`/`toConfig`, `from_config`→`fromConfig`, `is_cancelled`→`isCancelled`, `add_callback`→`addCallback`, `active_form`→`activeForm`. Method/operator idioms: Python `|`/`&` on terminations → `.or()`/`.and()`; Python `__str__`/`__repr__` → (mostly unported) `toString()`.

---

## Verdict

**Ship as `0.1` of the full runtime.** This is no longer "core + caveats": every advertised subsystem is present, `tsc` is clean, **174 tests pass**, and a fresh four-way module re-verification cleared the two former headline issues (they were resolved/inverted against the current API) and found **no real bugs** — only minor, internally-consistent deviations. The work ahead is entirely **quality/parity**: decide the canonical `research` roster and prompt text, refresh research-tool internals (YouTube/HTML extraction), optionally improve compaction token accuracy, port the dozen missing examples (especially a `computer_use` demo for the already-ported subsystem), and add the README scope notes. Treat the naming section as settled — it's correct for a standalone port; don't spend cycles "fixing" it unless cross-runtime artifact sharing becomes a goal.
