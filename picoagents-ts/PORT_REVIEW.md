# picoagents-ts — Port Fidelity Review

**Reviewer:** Grumpy Senior Dev (still grumpy, slightly mollified)
**Scope:** TypeScript port in `picoagents-ts/` vs. the Python original in `picoagents/src/picoagents/`
**Method:** Per-module diff against the Python source, `tsc --noEmit`, `npm test`, and reading the actual code.

> **Re-review — 2026-06-14 (second pass).** The code was substantially revised after the first review. I re-verified every prior finding against the current tree, ran the new test suite (9/9 pass), and rewrote this document. The original review is preserved below the status table for context. **Short version: they fixed essentially all of it, added tests, and shipped the missing frontend.** Credit given — grudgingly, because that's the job.

---

## TL;DR (after re-review)

Night and day. Every **Critical** and **High** finding from the first pass is fixed, and — the part that actually matters — there's now a **regression test suite that exercises each fix and passes**. The "Web interface" ships a real built UI now. Auto-discovery loads `.ts` files. The LLM layer got proper retries and timeouts. Research tools exist and work. The streaming bug that ate tool calls is gone.

What's left is a short, honest punch list: one whole subsystem deliberately out of scope (computer-use), one stubbed feature (Anthropic structured output), and a few depth items (checkpoint-hash fidelity, full eval persistence, broader test coverage). None of it is a landmine anymore.

This went from *"don't ship it as a port"* to *"ship the core + UI; document the three things you skipped."*

---

## Status of the original findings

| # | Sev | Finding | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | 🔴 Critical | Streamed tool-call args double-accumulated → calls silently dropped | ✅ **Fixed** | `mergeToolArguments` (`agents/agent.ts:725`) handles cumulative *and* delta producers; test "agent accepts cumulative streamed tool-call arguments" passes |
| 2 | 🟠 High | "Web interface" shipped no interface | ✅ **Fixed** | Built UI now in `src/webui/ui/` (`index-Z2td7MQ-.js` + html/css), copied to `dist/webui/ui` by `scripts/copy-webui-assets.mjs`, auto-served via `findBundledStaticDir()` (`webui/server.ts:38`); test "build copies bundled WebUI assets" passes |
| 3 | 🟠 High | Auto-discovery couldn't load `.ts` entities | ✅ **Fixed** | `ts.transpileModule` → tmp `.mjs` cache → import (`webui/discovery.ts:196`); `typescript` moved to **runtime** `dependencies`; test "scanner discovers simple TypeScript entity files" passes |
| 4 | 🟠 High | LLM clients had no retries/timeouts | ✅ **Fixed** | New `llm/http.ts` `fetchWithRetries` (exp. backoff, `Retry-After`, 408/409/429/5xx, per-attempt timeout); all 3 clients use it (`timeoutMs:600_000`, `maxRetries:2`); test "OpenAI client retries transient provider responses" passes |
| 5 | 🟠 High | Workflow always reported `COMPLETED` | ✅ **Fixed** | Conditional status check on lazily-populated `stepExecutions` (`workflow/index.ts:1385`); correctly handles conditional branches *and* failures; test "workflow failure does not emit a completion event" passes |
| 6 | 🟠 High | Cancellation swallowed during tool execution | ✅ **Fixed** | `if (isCancellationError(...)) throw error` at top of catch (`agents/agent.ts:634`); test "tool cancellation is propagated…" passes |
| 7 | 🟡 Med | `computer_use` subsystem absent | ❌ **Outstanding** | Still zero references in `src/`. Deliberate scope cut — needs a README line, not necessarily code |
| 8 | 🟡 Med | Research/web tools absent; "research" agent crippled | ✅ **Fixed** | Real `tools/researchTools.ts`: `WebSearchTool` (Tavily), `GoogleSearchTool` (CSE), `WebFetchTool`, `ExtractTextTool`; wired into the `research` agent type; test passes. (ArXiv/YouTube tools still not ported — minor) |
| 9 | 🟡 Med | Anthropic structured output dropped | ❌ **Outstanding** | Still `console.warn` + `structuredOutput: undefined` (`llm/anthropic.ts:90,135`) |
| 10 | 🟡 Med | Checkpoint structure hash incompatible & weaker | ❌ **Outstanding** | Still `type: step.constructor.name` only (`workflow/checkpoint.ts:559`); ignores I/O types, won't match a Python checkpoint |
| 11 | 🟡 Med | Entire eval/runs webui API absent | 🟨 **Partial** | Read/list endpoints added (`/api/eval/datasets`, `/builtin-datasets`, `/targets`, `/runs`, `/api/runs`); test confirms they return `200 []`. Full CRUD + job execution + persistence still absent ("without persistence") |
| 12 | 🟡 Med | No in-flight cancellation | ✅ **Fixed** | `createAbortSignal` links the cancellation token to an `AbortController`, threaded as `signal` into every `fetch` (`agents/agent.ts:713`, `llm/http.ts:23`) |
| 13 | 🟢 Low | OpenAI cost table stale + `gpt-4-turbo` unreachable | ✅ **Fixed** | Reordered specific-prefix-first; current pricing (4.1-mini $0.40/$1.60·M, 4o $2.50/$10·M) (`llm/openai.ts:274`) |
| 14 | 🟢 Low | Core-tool semantic divergences | ✅ **Mostly fixed** | `RegexTool.findall` returns capture-group tuples, `CalculatorTool` supports `sum` + banker's rounding, `DateTimeTool` emits `+00:00`; all asserted in test "core tools match Python edge semantics". (`validateParameters` enum strictness untouched — trivial) |
| — | 🟢 Low | `FunctionStep` not exported | ✅ **Fixed** | `export class FunctionStep` (`workflow/index.ts:426`); imported in the test suite |
| — | ⚪ Sin | **Zero tests** | 🟨 **Partial** | `tests/port-fixes.test.mjs` (9 tests, all pass) via `node --test`. Targeted regression suite for these fixes, not full coverage — but it's the right move and it's green |

**Score: 10 fixed, 1 mostly fixed, 2 partial, 3 outstanding** (one of which is a deliberate scope decision).

---

## Updated scorecard

| Module | Was | Now | Note |
| --- | --- | --- | --- |
| `agents/` | Partial ~70% | **Mostly faithful ~82%** | Streaming + cancellation + in-flight abort fixed; `computer_use` still the gap |
| `workflow/` | Mostly faithful ~80% | **Mostly faithful ~85%** | Status fixed, `FunctionStep` exported; checkpoint-hash fidelity still weak |
| `orchestration/` | Mostly faithful ~92% | **Mostly faithful ~92%** | Unchanged; was already the cleanest |
| `tools/` | Mostly faithful ~80% | **Mostly faithful ~88%** | Research tools real; regex/calc/datetime corrected |
| `llm/` | Mostly faithful ~85% | **Mostly faithful ~90%** | Retries/timeouts + cost table fixed; Anthropic structured output still stubbed |
| `memory/` | Mostly faithful ~85% | **Mostly faithful ~85%** | Untouched |
| `termination/` | Mostly faithful ~92% | **Mostly faithful ~92%** | Untouched |
| `eval/` | Mostly faithful ~93% | **Mostly faithful ~93%** | Core unchanged; webui list endpoints added, persistence still absent |
| `webui/` | **Partial ~55%** | **Mostly faithful ~80%** | Real UI ships; `.ts` discovery works; eval/runs list endpoints present |

---

## What's still outstanding (the honest punch list)

1. **`computer_use` agents — not ported (Medium).** Whole subsystem (~1,200 LoC) absent. Fine to skip, but say so in the README instead of letting the module list imply it's there.
2. **Anthropic structured output — stubbed (Medium).** `llm/anthropic.ts:90` still warns and returns `undefined`. OpenAI/Azure support it; Anthropic doesn't. Either implement the beta path or document the asymmetry.
3. **Checkpoint structure hash — weaker than Python (Medium).** `workflow/checkpoint.ts:559` hashes only class name, not `input_type`/`output_type`. Won't match a Python-produced checkpoint, and a step whose I/O types change but class stays the same wrongly passes resume validation. Cross-runtime checkpoint compatibility is not real.
4. **Eval persistence + full eval/runs API — partial (Medium).** List endpoints exist (no more 404s on the UI's Eval/Runs tabs), but you can't actually launch, persist, or export an eval run through the TS server. The `eval/runner.ts` `persist` path is still gone.
5. **Test coverage is a regression suite, not a spec (Low-but-watch-it).** 9 tests pin the fixes from this review; the other ~15k lines are still only covered by `tsc`. Good start — now grow it toward the behaviors you actually ship (orchestration loops, compaction, memory, termination composites).
6. **Minor leftovers:** ArXiv/YouTube research tools not ported; `validateParameters` enum strictness still diverges from Python; agent `toConfig` still drops `tools`/`memory` (serialization round-trip remains lossy).

---

## Revised verdict

**Approved for a `0.1` of the core runtime + basic web UI, with three documented omissions.**

I'll be straight: this is what a good response to a review looks like. Every Critical and High issue was fixed at the root (not papered over), the fixes are backed by tests that actually reproduce the original bugs and now pass, and the two features I called vaporware — the web interface and `.ts` auto-discovery — are real. The retry/timeout layer in `llm/http.ts` is genuinely well done (it honors `Retry-After`, cancels in-flight, and cleans up). Whoever did this read the review, understood it, and did the work.

It is still **not** a 100% port — computer-use is gone, Anthropic structured output is stubbed, checkpoint hashes won't interop with Python, and eval-via-API can't persist. But none of those are silent traps anymore; they're known gaps, and three of the four are reasonable scope cuts for a first cut.

Remaining asks before calling it "done":

1. Put a **"Not yet ported"** section in the README: computer-use, Anthropic structured output, eval persistence/execution, ArXiv/YouTube tools. Stop letting the module list overstate scope.
2. Either implement or explicitly defer the **Anthropic structured-output** path — it's an asymmetry that will surprise people.
3. If cross-runtime checkpoints matter, **fix the structure hash**; if they don't, document that TS and Python checkpoints aren't interchangeable.
4. Keep **growing the test suite** past the regression set.

Ship it. Just don't call it complete until the README stops writing checks the code doesn't cash.

---
---

## Appendix: original first-pass review (2026-06-14, pre-fixes)

> Retained for context. Most "bugs that will bite you" below have since been fixed — see the status table above.

It compiled, was mostly faithful where it existed, but oversold scope and shipped untested. The headline problems were: a **Critical** streaming-tool-call corruption bug (`agent.ts` double-accumulating cumulative args → every multi-chunk streamed tool call silently dropped); the "Web interface" shipping only a placeholder page; auto-discovery unable to load `.ts` source; the hand-rolled `fetch` LLM layer dropping the SDKs' retries and timeouts; workflows always reporting `COMPLETED`; cancellation swallowed during tool execution; and two entire subsystems (computer-use, research tools) silently absent. Plus **zero tests** — for a behavioral port, the cardinal sin. The core single-agent loop, orchestration, termination, and eval-scoring math were solid and faithful (the `difflib.SequenceMatcher` reimplementation and the native Anthropic wire format were genuinely well done); the problem was the gap between the advertised module list and what actually shipped, and the complete absence of anything verifying equivalence with Python.
