import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { MemoryBackend, MemoryTool } from "../dist/index.js";
import { makeTempDir } from "./helpers.mjs";

test("MemoryBackend validates paths inside the memory directory", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  assert.equal(backend.validatePath("/memories/notes.txt"), path.join(basePath, "notes.txt"));
  assert.throws(() => backend.validatePath("../outside.txt"), /Access denied/);
});

test("MemoryBackend supports create, view, replace, insert, append, search, rename, and delete", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  assert.match(await backend.create("notes/today.md", "one\ntwo\nthree\n"), /created/);
  assert.match(await backend.view("notes/today.md", [2, 3]), /2: two/);
  assert.match(await backend.strReplace("notes/today.md", "two", "TWO"), /edited/);
  assert.match(await backend.insert("notes/today.md", 2, "inserted"), /inserted/);
  assert.match(await backend.append("notes/today.md", "tail"), /appended/);
  assert.match(await backend.search("tail", "/memories"), /today.md/);
  assert.match(await backend.rename("notes/today.md", "notes/archive.md"), /Renamed/);
  assert.equal(await readFile(path.join(basePath, "notes", "archive.md"), "utf8"), "one\ninserted\nTWO\nthree\ntail\n");
  assert.match(await backend.delete("notes/archive.md"), /deleted/);
  await assert.rejects(() => access(path.join(basePath, "notes", "archive.md")));
});

test("MemoryTool dispatches commands and returns structured errors", async () => {
  const basePath = await makeTempDir();
  const tool = new MemoryTool({ basePath });

  const created = await tool.execute({
    command: "create",
    path: "project.md",
    file_text: "remember this"
  });
  assert.equal(created.success, true);
  assert.equal(created.metadata.command, "create");

  const viewed = await tool.execute({ command: "view", path: "project.md" });
  assert.equal(viewed.success, true);
  assert.match(viewed.result, /remember this/);

  const unknown = await tool.execute({ command: "wat" });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /Unknown command/);
});
