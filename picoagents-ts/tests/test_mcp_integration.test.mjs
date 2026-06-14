import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HTTPServerConfig,
  MCPClientManager,
  MCPServerConfig,
  MCPTool,
  StdioServerConfig,
  createMcpTools
} from "../dist/index.js";

test("MCP server config classes preserve transport-specific fields", () => {
  const base = new MCPServerConfig({ serverId: "base", transport: "stdio", env: { A: "B" } });
  assert.equal(base.serverId, "base");
  assert.equal(base.transport, "stdio");
  assert.deepEqual(base.env, { A: "B" });

  const stdio = new StdioServerConfig({ serverId: "fs", command: "npx", args: ["server"] });
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, "npx");

  const http = new HTTPServerConfig({ serverId: "remote", url: "https://example.com/mcp" });
  assert.equal(http.transport, "streamable-http");
  assert.equal(http.url, "https://example.com/mcp");
});

test("MCPClientManager registers servers and rejects duplicates", () => {
  const manager = new MCPClientManager();
  manager.addServer(new StdioServerConfig({ serverId: "fs", command: "node", args: [] }));

  assert.deepEqual(manager.listServers(), ["fs"]);
  assert.equal(manager.isConnected("fs"), false);
  assert.throws(
    () => manager.addServer(new StdioServerConfig({ serverId: "fs", command: "node", args: [] })),
    /already registered/
  );
});

test("MCPTool calls manager clients and maps text content", async () => {
  const manager = {
    async getClient(serverId) {
      assert.equal(serverId, "server");
      return {
        async callTool(request) {
          return {
            content: [{ type: "text", text: `called ${request.name} with ${request.arguments.value}` }]
          };
        }
      };
    }
  };
  const tool = new MCPTool({
    mcpToolName: "echo",
    mcpToolDescription: "Echo",
    mcpToolSchema: { type: "object", properties: { value: { type: "string" } } },
    clientManager: manager,
    serverId: "server"
  });

  assert.equal(tool.name, "mcp_server_echo");
  const result = await tool.execute({ value: "x" });
  assert.equal(result.success, true);
  assert.equal(result.result, "called echo with x");
  assert.equal(result.metadata.mcpServer, "server");
});

test("MCPTool surfaces MCP error responses", async () => {
  const manager = {
    async getClient() {
      return {
        async callTool() {
          return { isError: true, content: [{ type: "text", text: "bad" }] };
        }
      };
    }
  };
  const result = await new MCPTool({
    mcpToolName: "fail",
    mcpToolDescription: "Fail",
    mcpToolSchema: {},
    clientManager: manager,
    serverId: "server"
  }).execute({});

  assert.equal(result.success, false);
  assert.equal(result.error, "MCP tool execution failed");
});

test("createMcpTools can register without connecting", async () => {
  const config = new StdioServerConfig({ serverId: "fs", command: "node", args: [] });
  const { manager, tools } = await createMcpTools([config], false);

  assert.deepEqual(manager.listServers(), ["fs"]);
  assert.deepEqual(tools, []);
});
