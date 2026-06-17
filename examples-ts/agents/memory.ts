import {
  Agent,
  FileMemory,
  ListMemory,
  MemoryContent
} from "picoagents-ts";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export async function main(): Promise<void> {
  section("List Memory Example");

  const memory = new ListMemory(10);
  await memory.add(
    new MemoryContent({
      content: "User prefers concise responses and likes TypeScript examples."
    })
  );

  const agent = new Agent({
    name: "memory_assistant",
    description: "Assistant that receives relevant memory as context.",
    instructions: "Use relevant memory context when answering.",
    modelClient: createExampleModelClient([
      "2 + 2 = 4. Keeping it concise, as requested."
    ]),
    memory
  });

  const response = await agent.run("What's 2 + 2?");
  console.log(response.finalContent);
  console.log(`Memory items: ${memory.memories.length}`);

  section("File Memory Example");

  const fileMemory = new FileMemory(path.join(tmpdir(), "picoagents-ts-memory.json"), 10);
  await fileMemory.add(
    new MemoryContent({
      content: "Persist this preference across runs.",
      metadata: { source: "example" }
    })
  );
  const stats = await fileMemory.getStats();
  console.log(`File memory path: ${stats.filePath}`);
  console.log(`Stored items: ${stats.currentMemories}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
