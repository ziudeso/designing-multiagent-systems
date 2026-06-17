import { MemoryTool } from "picoagents-ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { section } from "../shared/printing.js";

export async function main(): Promise<void> {
  section("Memory Tool Example");

  const basePath = await mkdtemp(path.join(tmpdir(), "picoagents-memory-tool-"));
  const memory = new MemoryTool({ basePath });

  console.log(
    (await memory.execute({
      command: "create",
      path: "/memories/project.md",
      file_text: "Project: TypeScript examples\nStatus: in progress\n"
    })).result
  );

  console.log((await memory.execute({ command: "append", path: "/memories/project.md", append_text: "Next: run typecheck" })).result);
  console.log((await memory.execute({ command: "search", query: "typecheck" })).result);
  console.log((await memory.execute({ command: "view", path: "/memories/project.md" })).result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
