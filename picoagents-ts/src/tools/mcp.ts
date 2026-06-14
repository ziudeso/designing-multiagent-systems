/**
 * MCP (Model Context Protocol) integration for picoagents-ts.
 *
 * Ports the Python `tools/_mcp/` package. Allows agents to use tools from any
 * MCP-compliant server as if they were native picoagents tools.
 *
 * This uses the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`). The
 * SDK is loaded via dynamic import so that simply importing this module does not
 * hard-fail a build when the SDK is not installed; the import is only resolved
 * when a connection is actually established.
 *
 * The TS SDK exposes a single `Client` with `connect(transport)` rather than
 * Python's `ClientSession`, so this port adapts the implementation accordingly
 * while keeping the public API surface (MCPTool, MCPClientManager,
 * server config types, createMcpTools) aligned with the Python package.
 *
 * Example:
 * ```ts
 * import { createMcpTools, StdioServerConfig } from "picoagents/tools";
 *
 * const config = new StdioServerConfig({
 *   serverId: "filesystem",
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 * });
 *
 * const { manager, tools } = await createMcpTools([config]);
 * // ... use tools with an Agent ...
 * await manager.disconnectAll();
 * ```
 */

import { ApprovalMode, BaseTool, JSONSchema, ToolResult } from "./base.js";

// The MCP SDK's `Client` type. We keep it loose (`any`) to avoid a hard compile
// dependency on the SDK's type surface; the runtime import provides the impl.
type MCPClient = any;

export type TransportType = "stdio" | "sse" | "streamable-http";

export interface MCPServerConfigInit {
  serverId: string;
  transport: TransportType;
  env?: Record<string, string>;
}

/** Base configuration for an MCP server connection. */
export class MCPServerConfig {
  serverId: string;
  transport: TransportType;
  env?: Record<string, string>;

  constructor(init: MCPServerConfigInit) {
    this.serverId = init.serverId;
    this.transport = init.transport;
    this.env = init.env;
  }
}

export interface StdioServerConfigInit {
  serverId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Configuration for stdio transport MCP servers.
 *
 * Spawns a subprocess and communicates via stdin/stdout. Best for local
 * development and testing.
 */
export class StdioServerConfig extends MCPServerConfig {
  command: string;
  args: string[];

  constructor(init: StdioServerConfigInit) {
    super({ serverId: init.serverId, transport: "stdio", env: init.env });
    this.command = init.command;
    this.args = init.args;
  }
}

export interface HTTPServerConfigInit {
  serverId: string;
  url: string;
  transport?: "sse" | "streamable-http";
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/**
 * Configuration for HTTP/SSE transport MCP servers.
 *
 * Use this for remote servers or production deployments. Supports both SSE and
 * streamable HTTP transports.
 */
export class HTTPServerConfig extends MCPServerConfig {
  url: string;
  headers?: Record<string, string>;

  constructor(init: HTTPServerConfigInit) {
    super({
      serverId: init.serverId,
      transport: init.transport ?? "streamable-http",
      env: init.env
    });
    this.url = init.url;
    this.headers = init.headers;
  }
}

// =============================================================================
// MCPTool - bridge between MCP tools and picoagents tools
// =============================================================================

export interface MCPToolOptions {
  mcpToolName: string;
  mcpToolDescription: string;
  mcpToolSchema: JSONSchema;
  clientManager: MCPClientManager;
  serverId: string;
  version?: string;
  approvalMode?: ApprovalMode;
}

/**
 * Wraps an MCP server tool as a picoagents BaseTool so it can be used
 * transparently alongside native tools.
 */
export class MCPTool extends BaseTool {
  mcpToolName: string;
  clientManager: MCPClientManager;
  serverId: string;
  private readonly schema: JSONSchema;

  constructor(options: MCPToolOptions) {
    // Namespace tool name by server to avoid conflicts.
    super({
      name: `mcp_${options.serverId}_${options.mcpToolName}`,
      description: options.mcpToolDescription,
      version: options.version,
      approvalMode: options.approvalMode
    });
    this.mcpToolName = options.mcpToolName;
    this.schema = options.mcpToolSchema ?? { type: "object", properties: {}, required: [] };
    this.clientManager = options.clientManager;
    this.serverId = options.serverId;
  }

  get parameters(): JSONSchema {
    return this.schema;
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    try {
      const client = await this.clientManager.getClient(this.serverId);
      const result = await client.callTool({
        name: this.mcpToolName,
        arguments: parameters
      });

      const output = extractResultContent(result);
      const isError = Boolean(result?.isError);

      return new ToolResult({
        success: !isError,
        result: output,
        error: isError ? "MCP tool execution failed" : undefined,
        metadata: {
          toolName: this.name,
          mcpServer: this.serverId,
          mcpTool: this.mcpToolName
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          toolName: this.name,
          exceptionType: error instanceof Error ? error.name : typeof error
        }
      });
    }
  }
}

/**
 * Extract content from an MCP CallTool result.
 *
 * Prefers structured content over text content when available.
 */
function extractResultContent(result: any): unknown {
  if (result && result.structuredContent) {
    return result.structuredContent;
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
      }
    }
    return textParts.length ? textParts.join("\n") : null;
  }
  return content ? String(content) : null;
}

// =============================================================================
// MCPClientManager - manages connections to MCP servers
// =============================================================================

/**
 * Manages connections to MCP servers and provides tool discovery.
 *
 * Handles connecting to multiple MCP servers (stdio, SSE, HTTP), discovering
 * available tools, creating MCPTool instances, lifecycle management, and client
 * caching/reuse.
 */
export class MCPClientManager {
  private servers = new Map<string, MCPServerConfig>();
  private clients = new Map<string, MCPClient>();
  private tools = new Map<string, MCPTool[]>();

  /**
   * Register an MCP server configuration. The server is not connected until
   * {@link connect} is called.
   */
  addServer(config: MCPServerConfig): void {
    if (this.servers.has(config.serverId)) {
      throw new Error(`Server '${config.serverId}' is already registered`);
    }
    this.servers.set(config.serverId, config);
  }

  /**
   * Connect to an MCP server and discover its tools. Establishes the transport,
   * initializes the session, lists tools and creates MCPTool instances.
   */
  async connect(serverId: string): Promise<void> {
    const config = this.servers.get(serverId);
    if (!config) {
      throw new Error(`Unknown server: ${serverId}`);
    }
    if (this.clients.has(serverId)) return; // already connected

    try {
      const client = await createClient(config);
      this.clients.set(serverId, client);
      await this.discoverTools(serverId);
    } catch (error) {
      const client = this.clients.get(serverId);
      if (client) {
        try {
          await client.close();
        } catch {
          // best-effort cleanup
        }
        this.clients.delete(serverId);
      }
      throw new Error(
        `Failed to connect to MCP server '${serverId}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async discoverTools(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)!;
    const toolsResponse = await client.listTools();
    const mcpTools: MCPTool[] = [];
    for (const tool of toolsResponse.tools ?? []) {
      mcpTools.push(
        new MCPTool({
          mcpToolName: tool.name,
          mcpToolDescription: tool.description ?? "",
          mcpToolSchema: tool.inputSchema as JSONSchema,
          clientManager: this,
          serverId
        })
      );
    }
    this.tools.set(serverId, mcpTools);
  }

  /** Get the MCP client for a server, connecting automatically if needed. */
  async getClient(serverId: string): Promise<MCPClient> {
    if (!this.clients.has(serverId)) {
      await this.connect(serverId);
    }
    return this.clients.get(serverId)!;
  }

  /**
   * Get tools from MCP servers. If `serverId` is provided, returns tools from
   * that server; otherwise returns tools from all connected servers.
   */
  getTools(serverId?: string): BaseTool[] {
    if (serverId) {
      return [...(this.tools.get(serverId) ?? [])];
    }
    const all: BaseTool[] = [];
    for (const list of this.tools.values()) all.push(...list);
    return all;
  }

  /** List all registered server IDs. */
  listServers(): string[] {
    return [...this.servers.keys()];
  }

  /** Check if a server is currently connected. */
  isConnected(serverId: string): boolean {
    return this.clients.has(serverId);
  }

  /** Disconnect from an MCP server and clean up its cached tools. */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
      this.clients.delete(serverId);
    }
    this.tools.delete(serverId);
  }

  /** Disconnect from all MCP servers. */
  async disconnectAll(): Promise<void> {
    for (const serverId of [...this.clients.keys()]) {
      await this.disconnect(serverId);
    }
  }
}

/**
 * Create and connect an MCP SDK Client for the given server config using the
 * appropriate transport. Uses dynamic imports so the SDK is only required at
 * runtime when actually connecting.
 */
async function createClient(config: MCPServerConfig): Promise<MCPClient> {
  let ClientCtor: any;
  try {
    ({ Client: ClientCtor } = await import("@modelcontextprotocol/sdk/client/index.js"));
  } catch (error) {
    throw new Error(
      "The '@modelcontextprotocol/sdk' package is required for MCP support. " +
        `Install it with: npm install @modelcontextprotocol/sdk (${
          error instanceof Error ? error.message : String(error)
        })`
    );
  }

  const transport = await createTransport(config);
  const client = new ClientCtor({ name: "picoagents", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Create the appropriate MCP transport for a server config. */
async function createTransport(config: MCPServerConfig): Promise<any> {
  if (config instanceof StdioServerConfig) {
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
    });
  }

  if (config instanceof HTTPServerConfig) {
    if (config.transport === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined
      });
    }
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined
    });
  }

  throw new Error(`Unknown transport: ${config.transport}`);
}

// =============================================================================
// High-level helper
// =============================================================================

export interface CreateMcpToolsResult {
  manager: MCPClientManager;
  tools: BaseTool[];
}

/**
 * Create MCP tools from server configurations. Connects to each server and
 * discovers its tools (when `autoConnect` is true), returning the manager and
 * the discovered tools.
 *
 * Always call `await manager.disconnectAll()` when done to release resources.
 */
export async function createMcpTools(
  serverConfigs: MCPServerConfig[],
  autoConnect = true
): Promise<CreateMcpToolsResult> {
  const manager = new MCPClientManager();

  for (const config of serverConfigs) {
    manager.addServer(config);
  }

  if (autoConnect) {
    for (const config of serverConfigs) {
      await manager.connect(config.serverId);
    }
  }

  return { manager, tools: manager.getTools() };
}
