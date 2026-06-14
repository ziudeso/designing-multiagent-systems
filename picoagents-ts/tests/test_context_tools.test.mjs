import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  MultiEditTool,
  SkillsTool,
  TaskTool,
  TodoReadTool,
  TodoWriteTool,
  createContextEngineeringTools,
  createMultiEditTool,
  createSkillsTool,
  createTodoTools,
  loadTodos,
  setSessionId,
  setTodoPath
} from "../dist/index.js";
import { createMockClient, makeTempDir } from "./helpers.mjs";

test("Todo tools persist and read the current session", async () => {
  const dir = await makeTempDir();
  const todoPath = path.join(dir, "todos.json");
  setTodoPath(todoPath);
  setSessionId("session-test");
  try {
    const write = new TodoWriteTool();
    const written = await write.execute({
      todos: [
        { content: "Write tests", status: "completed", activeForm: "Writing tests" },
        { content: "Run tests", status: "in_progress", activeForm: "Running tests" }
      ]
    });
    assert.equal(written.success, true);
    assert.deepEqual(loadTodos().map((todo) => todo.content), ["Write tests", "Run tests"]);

    const read = await new TodoReadTool().execute({});
    assert.equal(read.success, true);
    assert.match(read.result, /Session: session-test/);
    assert.match(read.result, /Progress: 1\/2/);
  } finally {
    setTodoPath(null);
    setSessionId(null);
  }
});

test("TodoWriteTool validates required fields and single in-progress item", async () => {
  const dir = await makeTempDir();
  setTodoPath(path.join(dir, "todos.json"));
  try {
    const missing = await new TodoWriteTool().execute({ todos: [{ status: "pending" }] });
    assert.equal(missing.success, false);
    assert.match(missing.error, /missing 'content'/);

    const multiple = await new TodoWriteTool().execute({
      todos: [
        { content: "A", status: "in_progress", activeForm: "Doing A" },
        { content: "B", status: "in_progress", activeForm: "Doing B" }
      ]
    });
    assert.equal(multiple.success, false);
    assert.match(multiple.error, /Only one allowed/);
  } finally {
    setTodoPath(null);
  }
});

test("SkillsTool lists, loads, and injects frontmatter summaries", async () => {
  const skillsRoot = await makeTempDir();
  await mkdir(path.join(skillsRoot, "review"), { recursive: true });
  await writeFile(
    path.join(skillsRoot, "review", "SKILL.md"),
    `---
name: code-review
description: Review code changes
triggers: pull requests
---
# Instructions

Find bugs first.
`,
    "utf8"
  );

  const tool = new SkillsTool({ projectPath: skillsRoot });
  const list = await tool.execute({ action: "list" });
  assert.equal(list.success, true);
  assert.match(list.result, /code-review/);
  assert.equal(list.metadata.skillCount, 1);
  assert.match(tool.getSystemPromptSection(), /Review code changes/);

  const loaded = await tool.execute({ action: "load", name: "code-review" });
  assert.equal(loaded.success, true);
  assert.match(loaded.result, /Find bugs first/);

  const missing = await tool.execute({ action: "load", name: "missing" });
  assert.equal(missing.success, false);
  assert.match(missing.error, /not found/);
});

test("MultiEditTool applies all edits atomically and rolls back on failure", async () => {
  const workspace = await makeTempDir();
  const filePath = path.join(workspace, "file.txt");
  await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
  const tool = new MultiEditTool({ workspace });

  const ok = await tool.execute({
    path: "file.txt",
    edits: [
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "gamma", new_string: "GAMMA" }
    ]
  });
  assert.equal(ok.success, true);
  assert.equal(await readFile(filePath, "utf8"), "ALPHA\nbeta\nGAMMA\n");

  const failed = await tool.execute({
    path: "file.txt",
    edits: [
      { old_string: "ALPHA", new_string: "alpha" },
      { old_string: "missing", new_string: "nope" }
    ]
  });
  assert.equal(failed.success, false);
  assert.match(failed.error, /atomic rollback/);
  assert.equal(await readFile(filePath, "utf8"), "ALPHA\nbeta\nGAMMA\n");
});

test("TaskTool delegates to sub-agents with usage metadata", async () => {
  const client = createMockClient({ responses: ["delegated result"] });
  const result = await new TaskTool({ modelClient: client, maxIterations: 1 }).execute({
    prompt: "Research this",
    description: "research",
    agent_type: "general"
  });

  assert.equal(result.success, true);
  assert.match(result.result, /delegated result/);
  assert.match(result.result, /Sub-agent/);
  assert.equal(result.metadata.agentType, "general");
  assert.equal(client.callCount, 1);
});

test("Context tool factory functions expose expected tool groups", () => {
  assert.deepEqual(createTodoTools(true).map((item) => item.name), [
    "todo_write",
    "todo_read",
    "todo_sessions"
  ]);
  assert.ok(createSkillsTool() instanceof SkillsTool);
  assert.ok(createMultiEditTool() instanceof MultiEditTool);
  assert.deepEqual(createContextEngineeringTools().map((item) => item.name), [
    "task",
    "todo_write",
    "todo_read",
    "skills",
    "multi_edit"
  ]);
});
