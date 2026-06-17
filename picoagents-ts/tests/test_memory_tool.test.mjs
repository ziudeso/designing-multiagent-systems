import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { MemoryBackend, MemoryTool } from "../dist/index.js";
import { makeTempDir } from "./helpers.mjs";

test("MemoryBackend validates paths inside the memory directory", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  await access(basePath);
  assert.equal(backend.validatePath("/memories/notes.txt"), path.join(basePath, "notes.txt"));
  assert.throws(() => backend.validatePath("../outside.txt"), /Access denied/);
});

test("MemoryBackend views empty and populated directories", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  const empty = await backend.view("/memories");
  assert.match(empty, /Directory: \/memories/);
  assert.match(empty, /\(empty\)/);

  await backend.create("/memories/file2.txt", "two");
  await backend.create("/memories/file1.txt", "one");
  await backend.create("/memories/nested/file3.txt", "three");

  const root = await backend.view("/memories");
  assert.match(root, /file1\.txt/);
  assert.match(root, /file2\.txt/);
  assert.match(root, /nested\//);
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

test("MemoryBackend rename requires source and refuses destination overwrite", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  await backend.create("source.txt", "source");
  await backend.create("dest.txt", "dest");

  await assert.rejects(() => backend.rename("missing.txt", "new.txt"), /Source path does not exist/);
  await assert.rejects(() => backend.rename("source.txt", "dest.txt"), /Destination path already exists/);
  assert.equal(await readFile(path.join(basePath, "source.txt"), "utf8"), "source");
  assert.equal(await readFile(path.join(basePath, "dest.txt"), "utf8"), "dest");
});

test("MemoryBackend treats replacement strings literally", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  await backend.create("literal.txt", "alpha beta");
  await backend.strReplace("literal.txt", "beta", "$& $1 $$");

  assert.equal(await readFile(path.join(basePath, "literal.txt"), "utf8"), "alpha $& $1 $$");
});

test("MemoryBackend reports failed replacements and refuses non-empty directory deletion", async () => {
  const basePath = await makeTempDir();
  const backend = new MemoryBackend(basePath);

  await backend.create("/memories/test.txt", "Hello world");
  await assert.rejects(
    () => backend.strReplace("/memories/test.txt", "Goodbye", "Hi"),
    /Text not found/
  );

  await backend.create("/memories/dir/file.txt", "Content");
  await assert.rejects(() => backend.delete("/memories/dir"), /Directory not empty/);
});

test("MemoryTool dispatches commands and returns structured errors", async () => {
  const basePath = await makeTempDir();
  const tool = new MemoryTool({ basePath });

  assert.equal(tool.name, "memory");
  assert.ok(tool.description.includes("persistent memory"));
  assert.deepEqual(new Set(tool.parameters.properties.command.enum), new Set([
    "view",
    "create",
    "str_replace",
    "insert",
    "delete",
    "rename",
    "search",
    "append"
  ]));

  const created = await tool.execute({
    command: "create",
    path: "project.md",
    file_text: "remember this"
  });
  assert.equal(created.success, true);
  assert.equal(created.metadata.command, "create");
  assert.equal(created.metadata.size, "remember this".length);

  const viewed = await tool.execute({ command: "view", path: "project.md" });
  assert.equal(viewed.success, true);
  assert.match(viewed.result, /remember this/);

  const unknown = await tool.execute({ command: "wat" });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /Unknown command/);
});
