import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  Agent,
  ArxivSearchTool,
  ApprovalMode,
  CalculatorTool,
    DateTimeTool,
    ExtractTextTool,
    FunctionTool,
  JSONParserTool,
  ListDirectoryTool,
  ReadFileTool,
  RegexTool,
  TaskStatusTool,
  ThinkTool,
  ToolResult,
  YouTubeCaptionTool,
  WriteFileTool,
  createCoreTools,
  createResearchTools,
  tool
} from "../dist/index.js";
import { createMockClient, makeTempDir } from "./helpers.mjs";

test("FunctionTool executes explicit schemas and rejects invalid parameters", async () => {
  const fn = new FunctionTool(
    async ({ left, right }) => Number(left) + Number(right),
    {
      name: "add",
      description: "Add numbers",
      parameters: {
        type: "object",
        properties: {
          left: { type: "number" },
          right: { type: "number" }
        },
        required: ["left", "right"]
      }
    }
  );

  const ok = await fn.execute({ left: 2, right: 3 });
  assert.equal(ok.success, true);
  assert.equal(ok.result, 5);

  const invalid = await fn.execute({ left: "2", right: 3 });
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /Invalid parameters/);

  const enumTool = new FunctionTool(({ mode }) => mode, {
    name: "enum_tool",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"]
    }
  });
  assert.equal((await enumTool.execute({ mode: "fast" })).success, true);
  assert.equal((await enumTool.execute({ mode: "medium" })).success, true);
});

test("tool decorator creates FunctionTool instances with metadata", async () => {
  const decorated = tool({
    name: "shout",
    description: "Uppercase text",
    approvalMode: ApprovalMode.ALWAYS,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    }
  })(({ value }) => String(value).toUpperCase());

  assert.equal(decorated.name, "shout");
  assert.equal(decorated.approvalMode, ApprovalMode.ALWAYS);
  assert.equal((await decorated.execute({ value: "hi" })).result, "HI");
});

test("Agent rejects invalid tool entries and exposes protected helper behavior at runtime", () => {
  assert.throws(
    () =>
      new Agent({
        name: "agent",
        instructions: "Reply.",
        modelClient: createMockClient(),
        tools: ["not-a-tool"]
      }),
    /Invalid tool type/
  );

  const think = new ThinkTool();
  const agent = new Agent({
    name: "agent",
    instructions: "Reply.",
    modelClient: createMockClient(),
    tools: [think]
  });
  assert.equal(agent.findTool("think"), think);
  assert.equal(agent.getToolsForLLM()[0].function.name, "think");
});

test("Core tools match Python-visible behavior", async () => {
  const think = await new ThinkTool().execute({ thought: "consider the tradeoffs" });
  assert.equal(think.success, true);
  assert.match(think.result, /Reasoning recorded/);

  const status = await new TaskStatusTool().execute({
    status: "complete",
    rationale: "All checks passed",
    requirements_met: ["tests"]
  });
  assert.match(status.result, /Task Status: COMPLETE/);
  assert.deepEqual(status.metadata.requirementsMet, ["tests"]);

  const calc = await new CalculatorTool().execute({ expression: "sum([1, 2, 3]) + round(2.5)" });
  assert.equal(calc.result, "8");

  const date = await new DateTimeTool().execute({
    operation: "format",
    value: "2025-01-15T10:30:00Z",
    format: "%Y-%m-%d %H:%M:%S"
  });
  assert.equal(date.result, "2025-01-15 10:30:00");

  const json = await new JSONParserTool().execute({
    json_string: JSON.stringify({ a: { b: [1, 2, 3] } }),
    path: "a.b.1"
  });
  assert.equal(json.result, 2);

  const regex = await new RegexTool().execute({
    operation: "findall",
    pattern: "(a)(b)",
    text: "ab ab"
  });
  assert.deepEqual(regex.result, [["a", "b"], ["a", "b"]]);

  assert.deepEqual(
    createCoreTools().map((item) => item.name),
    ["think", "task_status", "calculator", "datetime", "json_parser", "regex"]
  );
});

test("WriteFileTool supports write, replace, insert, and path protection", async () => {
  const workspace = await makeTempDir();
  const writer = new WriteFileTool({ workspace });

  let result = await writer.execute({ file_path: "notes.txt", content: "alpha\nbeta\n" });
  assert.equal(result.success, true);
  assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "alpha\nbeta\n");

  result = await writer.execute({ file_path: "notes.txt", old_str: "beta", new_str: "gamma" });
  assert.equal(result.success, true);

  result = await writer.execute({
    file_path: "notes.txt",
    insert_line: 2,
    insert_content: "inserted"
  });
  assert.equal(result.success, true);
    assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "alpha\ninserted\ngamma\n");

  const denied = await writer.execute({ file_path: "../escape.txt", content: "no" });
  assert.equal(denied.success, false);
  assert.match(denied.error, /outside workspace/);
  });

test("WriteFileTool treats replacement strings literally", async () => {
  const workspace = await makeTempDir();
  const writer = new WriteFileTool({ workspace });

  await writer.execute({ file_path: "notes.txt", content: "alpha beta" });
  const result = await writer.execute({
    file_path: "notes.txt",
    old_str: "beta",
    new_str: "$& $1 $$"
  });

  assert.equal(result.success, true);
  assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "alpha $& $1 $$");
});

test("ReadFileTool and ListDirectoryTool expose workspace files", async () => {
  const workspace = await makeTempDir();
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "a.txt"), "hello", "utf8");

  const read = await new ReadFileTool({ workspace }).execute({ file_path: "src/a.txt" });
  assert.equal(read.success, true);
  assert.equal(read.result, "hello");

  const listed = await new ListDirectoryTool({ workspace }).execute({
    directory_path: ".",
    recursive: true
  });
  assert.equal(listed.success, true);
  assert.ok(listed.result.some((entry) => entry.name === "src/a.txt"));
});

test("Research tools include arXiv search and YouTube captions", async () => {
  const arxiv = new ArxivSearchTool({
    fetchImpl: async () => new Response(`
      <feed>
        <entry>
          <id>http://arxiv.org/abs/2401.00001v1</id>
          <title> Test Paper </title>
          <summary> A useful abstract. </summary>
          <published>2024-01-01T00:00:00Z</published>
          <author><name>Ada Lovelace</name></author>
          <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" />
        </entry>
      </feed>
    `)
  });
  const arxivResult = await arxiv.execute({ query: "agents", max_results: 1 });
  assert.equal(arxivResult.success, true);
  assert.equal(arxivResult.result[0].title, "Test Paper");
  assert.deepEqual(arxivResult.result[0].authors, ["Ada Lovelace"]);

    const youtube = new YouTubeCaptionTool({
      fetchImpl: async () => new Response("<transcript><text>Hello &amp; welcome</text><text>to captions</text></transcript>")
    });
  const captions = await youtube.execute({ video_id: "abcdefghijk", language: "en" });
  assert.equal(captions.success, true);
  assert.equal(captions.result, "Hello & welcome to captions");

    assert.ok(createResearchTools().some((tool) => tool.name === "arxiv_search"));
    assert.ok(createResearchTools().some((tool) => tool.name === "youtube_caption"));
  });

test("ExtractTextTool supports simple selector extraction", async () => {
  const html = `
    <html>
      <body>
        <main id="content"><h1>Hello</h1><p class="summary">Selected &amp; decoded</p></main>
        <aside><p>Ignored</p></aside>
      </body>
    </html>
  `;
  const result = await new ExtractTextTool().execute({ html, selector: "#content" });

  assert.equal(result.success, true);
  assert.match(result.result, /Hello/);
  assert.match(result.result, /Selected & decoded/);
  assert.doesNotMatch(result.result, /Ignored/);
});

test("FunctionTool serialization is rejected for closure-backed tools", () => {
  const fn = new FunctionTool(() => new ToolResult({ success: true, result: "ok" }), {
    name: "closure",
    parameters: { type: "object", properties: {}, required: [] }
  });
  assert.throws(() => fn.toConfig(), /cannot be serialized/);
});
