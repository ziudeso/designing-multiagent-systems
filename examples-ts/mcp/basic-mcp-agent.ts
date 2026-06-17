import {
  Agent,
  ApprovalMode,
  AssistantMessage,
  StdioServerConfig,
  createMcpTools
} from "picoagents-ts";
import path from "node:path";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export async function main(): Promise<void> {
  section("MCP Filesystem Agent Example");

  const targetDir = path.resolve(process.argv[2] ?? process.cwd());
  const config = new StdioServerConfig({
    serverId: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", targetDir]
  });

  let manager: Awaited<ReturnType<typeof createMcpTools>>["manager"] | undefined;
  try {
    const result = await createMcpTools([config]);
    manager = result.manager;
    const tools = result.tools;

    console.log(`Connected to MCP filesystem server for: ${targetDir}`);
    console.log(`Discovered ${tools.length} tools:`);
    for (const item of tools) {
      console.log(`- ${item.name}`);
      if (/write|delete|create/i.test(item.name)) {
        item.approvalMode = ApprovalMode.ALWAYS;
      }
    }

    const listTool = tools.find((item) => /list.*directory|list_directory/i.test(item.name));
    const writeTool = tools.find((item) => /write.*file|write_file/i.test(item.name));

    const agent = new Agent({
      name: "filesystem_agent",
      description: "Agent that can analyze folders using MCP filesystem tools.",
      instructions:
        "Use filesystem tools to inspect directories. Write operations require host approval.",
      modelClient: createExampleModelClient([
        listTool
          ? new AssistantMessage({
              content: "",
              source: "llm",
              toolCalls: [toolCall(listTool.name, { path: targetDir }, "call_mcp_list")]
            })
          : "No list tool was discovered.",
        "Directory inspection completed.",
        writeTool
          ? new AssistantMessage({
              content: "",
              source: "llm",
              toolCalls: [
                toolCall(
                  writeTool.name,
                  {
                    path: path.join(targetDir, "sample.txt"),
                    content: "Hello from picoagents-ts MCP approval example."
                  },
                  "call_mcp_write"
                )
              ]
            })
          : "No write tool was discovered.",
        "Write operation was handled according to approval policy."
      ]),
      tools
    });

    const analysis = await agent.run("Analyze the files in this directory.");
    console.log(`Analysis: ${analysis.finalContent}`);

    let writeResponse = await agent.run("Create sample.txt with a short hello message.");
    while (writeResponse.needsApproval) {
      for (const request of writeResponse.approvalRequests) {
        const approved = process.env.PICOAGENTS_MCP_APPROVE_WRITE === "1";
        console.log(
          `${approved ? "Approving" : "Rejecting"} ${request.toolName}: ${JSON.stringify(request.parameters)}`
        );
        writeResponse.context?.addApprovalResponse(
          request.createResponse(
            approved,
            approved ? "Explicitly approved by environment variable." : "Default example policy rejects writes."
          )
        );
      }
      writeResponse = await agent.run(undefined, { context: writeResponse.context });
    }

    console.log(`Write task: ${writeResponse.finalContent}`);
  } catch (error) {
    console.log("Skipping MCP demo.");
    console.log(error instanceof Error ? error.message : String(error));
  } finally {
    await manager?.disconnectAll();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
