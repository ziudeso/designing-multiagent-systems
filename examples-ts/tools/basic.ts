import {
  Agent,
  AssistantMessage,
  MemoryTool,
  createCodingTools,
  createCoreTools
} from "picoagents-ts";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export async function demoCoreTools(): Promise<void> {
  section("Core Tools");
  const [think, taskStatus, calculator, datetime, jsonParser, regex] = createCoreTools();

  console.log((await calculator.execute({ expression: "sqrt(144) + 30" })).result);
  console.log((await datetime.execute({ operation: "format", value: "2025-01-15T10:30:00Z" })).result);
  console.log(
    (await jsonParser.execute({
      json_string: JSON.stringify({ a: { b: [1, 2, 3] } }),
      path: "a.b.1"
    })).result
  );
  console.log(
    JSON.stringify(
      (await regex.execute({ operation: "findall", pattern: "(a)(b)", text: "ab ab" })).result
    )
  );
  console.log((await think.execute({ thought: "Use tools for deterministic work." })).result);
  console.log((await taskStatus.execute({ status: "complete", rationale: "All demos ran." })).result);
}

export async function demoMemoryTool(): Promise<void> {
  section("Memory Tool");
  const memoryTool = new MemoryTool({ basePath: await mkdtemp(path.join(tmpdir(), "picoagents-memory-")) });
  await memoryTool.execute({
    command: "create",
    path: "plans/api.md",
    file_text: "- [ ] Design database schema\n- [ ] Implement endpoints\n- [ ] Write tests\n"
  });
  console.log((await memoryTool.execute({ command: "search", query: "database" })).result);
}

export async function demoCodingTools(): Promise<void> {
  section("Coding Tools");
  const workspace = await mkdtemp(path.join(tmpdir(), "picoagents-coding-"));
  const tools = createCodingTools({ workspace });
  const writeFile = tools.find((item) => item.name === "write_file")!;
  const python = tools.find((item) => item.name === "python_repl")!;
  const list = tools.find((item) => item.name === "list_directory")!;

  await writeFile.execute({ file_path: "hello.py", content: "print('Hello, World!')\n" });
  console.log((await python.execute({ code: "print('Hello from Python')" })).result);
  console.log(JSON.stringify((await list.execute({ directory_path: "." })).result, null, 2));
  console.log(await readFile(path.join(workspace, "hello.py"), "utf8"));
}

export async function demoAgentWithTools(): Promise<void> {
  section("Agent With Core Tools");
  const agent = new Agent({
    name: "math_agent",
    description: "Agent that uses core tools.",
    instructions: "Use calculator and datetime tools when helpful.",
    modelClient: createExampleModelClient([
      new AssistantMessage({
        content: "",
        source: "llm",
        toolCalls: [
          toolCall("calculator", { expression: "sqrt(144)" }, "call_calculator"),
          toolCall("datetime", { operation: "now" }, "call_datetime")
        ]
      }),
      "sqrt(144) is 12. I also checked the current timestamp."
    ]),
    tools: createCoreTools()
  });

  const response = await agent.run(
    "Calculate the square root of 144, then tell me the current timestamp."
  );
  console.log(response.finalContent);
}

export async function main(): Promise<void> {
  await demoCoreTools();
  await demoMemoryTool();
  await demoCodingTools();
  await demoAgentWithTools();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
