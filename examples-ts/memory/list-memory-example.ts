import {
  Agent,
  ListMemory,
  MemoryContent
} from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export async function main(): Promise<void> {
  section("List Memory Example");

  const memory = new ListMemory(10);
  await memory.add(new MemoryContent({ content: "Alice works on TypeScript ports." }));
  await memory.add(new MemoryContent({ content: "Bob specializes in Python workflows." }));

  const query = await memory.query("TypeScript", 2);
  console.log(`Search results: ${query.results.map((item) => item.content).join(" | ")}`);

  const agent = new Agent({
    name: "memory_agent",
    instructions: "Answer using relevant context from memory.",
    modelClient: createExampleModelClient(["Alice is the person working on TypeScript ports."]),
    memory
  });

  const response = await agent.run("Who is working on TypeScript ports?");
  console.log(response.finalContent);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
