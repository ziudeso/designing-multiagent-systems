import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  MultiEditTool,
  SkillsTool,
  TaskTool,
  TodoListSessionsTool,
  TodoReadTool,
  TodoWriteTool,
  createContextEngineeringTools,
  createMultiEditTool,
  createSkillsTool,
  createTaskTool,
  createTodoTools,
  getCurrentSessionId,
  listTodoSessions,
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

    const missingStatus = await new TodoWriteTool().execute({
      todos: [{ content: "A", activeForm: "Doing A" }]
    });
    assert.equal(missingStatus.success, false);
    assert.match(missingStatus.error, /missing 'status'/);

    const missingActiveForm = await new TodoWriteTool().execute({
      todos: [{ content: "A", status: "pending" }]
    });
    assert.equal(missingActiveForm.success, false);
    assert.match(missingActiveForm.error, /missing 'activeForm'/);

    const invalidStatus = await new TodoWriteTool().execute({
      todos: [{ content: "A", status: "blocked", activeForm: "Doing A" }]
    });
    assert.equal(invalidStatus.success, false);
    assert.match(invalidStatus.error, /invalid status/);

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

test("Todo sessions can be listed and read without losing the current session", async () => {
  const dir = await makeTempDir();
  const oldCwd = process.cwd();
  process.chdir(dir);
  setTodoPath(null);
  setSessionId(null);
  try {
    const todosDir = path.join(dir, ".picoagents", "todos");
    await mkdir(todosDir, { recursive: true });
    await writeFile(
      path.join(todosDir, "session_2024-02-01_abc12345.json"),
      JSON.stringify({
        sessionId: "2024-02-01_abc12345",
        todos: [
          { content: "Old task 1", status: "completed", activeForm: "Doing old task 1" },
          { content: "Old task 2", status: "completed", activeForm: "Doing old task 2" }
        ]
      }),
      "utf8"
    );
    await writeFile(
      path.join(todosDir, "session_2024-02-02_def67890.json"),
      JSON.stringify({
        sessionId: "2024-02-02_def67890",
        todos: [{ content: "Recent task", status: "in_progress", activeForm: "Doing recent task" }]
      }),
      "utf8"
    );

    setSessionId(null);
    assert.match(getCurrentSessionId(), /^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/);
    setSessionId("current_session");
    assert.equal(getCurrentSessionId(), "current_session");

    const sessions = listTodoSessions();
    assert.deepEqual(sessions.map((item) => item.sessionId), [
      "2024-02-02_def67890",
      "2024-02-01_abc12345"
    ]);
    assert.deepEqual(sessions.map((item) => item.completed), [0, 2]);

    const listed = await new TodoListSessionsTool().execute({ limit: 1 });
    assert.equal(listed.success, true);
    assert.match(listed.result, /2024-02-02_def67890/);
    assert.doesNotMatch(listed.result, /2024-02-01_abc12345/);
    assert.equal(listed.metadata.sessions.length, 1);

    const read = await new TodoReadTool().execute({ session_id: "2024-02-01_abc12345" });
    assert.equal(read.success, true);
    assert.match(read.result, /Old task 1/);
    assert.match(read.result, /Progress: 2\/2/);
    assert.equal(getCurrentSessionId(), "current_session");
  } finally {
    process.chdir(oldCwd);
    setTodoPath(null);
    setSessionId(null);
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

  const tool = new SkillsTool({ builtinPath: path.join(skillsRoot, "missing"), projectPath: skillsRoot });
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

test("SkillsTool handles empty directories, invalid actions, and summary-only prompts", async () => {
  const emptyRoot = await makeTempDir();
  const emptyTool = new SkillsTool({ builtinPath: path.join(emptyRoot, "missing"), projectPath: emptyRoot });
  const emptyList = await emptyTool.execute({ action: "list" });
  assert.equal(emptyList.success, true);
  assert.match(emptyList.result, /No skills found/);
  assert.equal(emptyTool.getSystemPromptSection(), "");

  const skillsRoot = await makeTempDir();
  await mkdir(path.join(skillsRoot, "typescript"), { recursive: true });
  await writeFile(
    path.join(skillsRoot, "typescript", "SKILL.md"),
    `---
name: ts-testing
description: TypeScript test practices
triggers: test, node:test
---
# Body

Use the full body only after loading.
`,
    "utf8"
  );

  const tool = new SkillsTool({ builtinPath: path.join(skillsRoot, "missing"), projectPath: skillsRoot });
  const missingName = await tool.execute({ action: "load" });
  assert.equal(missingName.success, false);
  assert.match(missingName.error, /'name' parameter is required/);

  const invalid = await tool.execute({ action: "delete", name: "ts-testing" });
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /Unknown action/);

  const section = tool.getSystemPromptSection();
  assert.match(section, /ts-testing/);
  assert.match(section, /TypeScript test practices/);
  assert.doesNotMatch(section, /Use the full body/);
});

test("SkillsTool discovers bundled built-in skills by default", async () => {
  const tool = new SkillsTool();
  const list = await tool.execute({ action: "list" });

  assert.equal(list.success, true);
  assert.match(list.result, /code-review/);
  assert.match(list.result, /debug/);
  assert.ok(list.metadata.skillCount >= 2);
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

test("MultiEditTool treats replacement strings literally", async () => {
  const workspace = await makeTempDir();
  await writeFile(path.join(workspace, "literal.txt"), "alpha beta", "utf8");
  const tool = new MultiEditTool({ workspace });

  const result = await tool.execute({
    path: "literal.txt",
    edits: [{ old_string: "beta", new_string: "$& $1 $$" }]
  });

  assert.equal(result.success, true);
  assert.equal(await readFile(path.join(workspace, "literal.txt"), "utf8"), "alpha $& $1 $$");
});

test("MultiEditTool rejects duplicate matches and applies edits sequentially", async () => {
  const workspace = await makeTempDir();
  const duplicatePath = path.join(workspace, "duplicate.txt");
  await writeFile(duplicatePath, "hello\nhello\nworld\n", "utf8");
  const tool = new MultiEditTool({ workspace });

  const duplicate = await tool.execute({
    path: "duplicate.txt",
    edits: [{ old_string: "hello", new_string: "hi" }]
  });
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error, /2 occurrences/);
  assert.match(duplicate.error, /must be unique/);
  assert.equal(await readFile(duplicatePath, "utf8"), "hello\nhello\nworld\n");

  const sequentialPath = path.join(workspace, "sequential.txt");
  await writeFile(sequentialPath, "AAA", "utf8");
  const sequential = await tool.execute({
    path: "sequential.txt",
    edits: [
      { old_string: "AAA", new_string: "BBB" },
      { old_string: "BBB", new_string: "CCC" }
    ]
  });
  assert.equal(sequential.success, true);
  assert.equal(await readFile(sequentialPath, "utf8"), "CCC");
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

test("TaskTool validates prompt and model client configuration", async () => {
  const missingClient = await new TaskTool().execute({
    prompt: "Explore something",
    description: "explore"
  });
  assert.equal(missingClient.success, false);
  assert.match(missingClient.error, /No model client/);

  const missingPrompt = await new TaskTool({ modelClient: createMockClient() }).execute({
    description: "explore"
  });
  assert.equal(missingPrompt.success, false);
  assert.match(missingPrompt.error, /'prompt' parameter is required/);
});

test("Context tool factory functions expose expected tool groups", () => {
  const taskTool = createTaskTool({ tokenBudget: 30_000, maxIterations: 10 });
  assert.ok(taskTool instanceof TaskTool);
  assert.equal(taskTool.tokenBudget, 30_000);
  assert.equal(taskTool.maxIterations, 10);

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
