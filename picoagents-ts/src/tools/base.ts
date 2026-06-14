import type { CancellationToken } from "../cancellation.js";
import type { AgentEvent } from "../types.js";
import type { Message } from "../messages.js";

export type JSONSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JSONSchema;
  [key: string]: unknown;
};

export enum ApprovalMode {
  NEVER = "never_require",
  ALWAYS = "always_require"
}

export class ToolResult {
  success: boolean;
  result: unknown;
  error?: string;
  metadata: Record<string, unknown>;

  constructor(init: {
    success: boolean;
    result: unknown;
    error?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.success = init.success;
    this.result = init.result;
    this.error = init.error;
    this.metadata = init.metadata ?? {};
  }
}

export abstract class BaseTool {
  name: string;
  description: string;
  version: string;
  approvalMode: ApprovalMode;

  constructor(init: {
    name: string;
    description: string;
    version?: string;
    approvalMode?: ApprovalMode;
  }) {
    this.name = init.name;
    this.description = init.description;
    this.version = init.version ?? "1.0.0";
    this.approvalMode = init.approvalMode ?? ApprovalMode.NEVER;
  }

  abstract get parameters(): JSONSchema;

  abstract execute(parameters: Record<string, unknown>): Promise<ToolResult>;

  async *executeStream(
    parameters: Record<string, unknown>,
    _cancellationToken?: CancellationToken
  ): AsyncGenerator<Message | AgentEvent | ToolResult> {
    yield await this.execute(parameters);
  }

  supportsStreaming(): boolean {
    const prototype = Object.getPrototypeOf(this) as { executeStream?: unknown };
    return prototype.executeStream !== BaseTool.prototype.executeStream;
  }

  validateParameters(params: Record<string, unknown>): boolean {
    const schema = this.parameters;
    const required = schema.required ?? [];
    for (const field of required) {
      if (!(field in params)) return false;
    }

    const properties = schema.properties ?? {};
    for (const [name, value] of Object.entries(params)) {
      const property = properties[name];
      if (!property?.type) continue;
      if (!checkJsonType(value, property.type)) return false;
    }
    return true;
  }

  toLLMFormat(): Record<string, unknown> {
    const versionedName =
      this.version === "1.0.0" ? this.name : `${this.name}_v${this.version}`;
    return {
      type: "function",
      function: {
        name: versionedName,
        description: this.description,
        parameters: this.parameters
      }
    };
  }
}

export type ToolFunction = (
  parameters: Record<string, unknown>
) => unknown | Promise<unknown>;

export interface FunctionToolOptions {
  name?: string;
  description?: string;
  parameters?: JSONSchema;
  version?: string;
  approvalMode?: ApprovalMode;
}

/**
 * Tracks function names we've already warned about, so the no-parameters
 * warning is emitted at most once per distinct tool name.
 */
const warnedNoParameters = new Set<string>();

export class FunctionTool extends BaseTool {
  func: ToolFunction;
  private readonly schema: JSONSchema;

  constructor(func: ToolFunction, options: FunctionToolOptions = {}) {
    const toolName = options.name ?? func.name ?? "function_tool";
    super({
      name: toolName,
      description:
        options.description ?? "Execute a TypeScript function with object parameters",
      version: options.version,
      approvalMode: options.approvalMode
    });
    this.func = func;

    // LANGUAGE LIMITATION: The Python FunctionTool introspects the wrapped
    // function's signature and type hints to build a JSON-schema for its
    // parameters. TypeScript erases parameter types at runtime, so there is no
    // way to introspect them here. Rather than fabricate an inaccurate schema,
    // we fall back to an empty-object schema and emit a one-time warning so the
    // caller knows to pass an explicit `parameters` schema for the LLM to see
    // any arguments. The explicit-parameters path below is fully supported.
    if (options.parameters) {
      this.schema = options.parameters;
    } else {
      if (!warnedNoParameters.has(toolName)) {
        warnedNoParameters.add(toolName);
        console.warn(
          `FunctionTool '${toolName}' was created without an explicit 'parameters' ` +
            `schema. TypeScript cannot introspect runtime types, so this tool exposes ` +
            `NO parameters to the LLM. Pass 'parameters' (a JSON schema) to expose its arguments.`
        );
      }
      this.schema = {
        type: "object",
        properties: {},
        required: []
      };
    }
  }

  get parameters(): JSONSchema {
    return this.schema;
  }

  /**
   * FunctionTool cannot be serialized: it closes over an arbitrary function
   * which has no JSON representation. Mirrors Python's `dump_component`
   * NotImplementedError guard. Use a dedicated BaseTool subclass for tools that
   * must be serializable.
   */
  toConfig(): Record<string, unknown> {
    throw new Error(
      `FunctionTool '${this.name}' cannot be serialized: it wraps a closure. ` +
        `Create a custom BaseTool subclass for serializable tools.`
    );
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (!this.validateParameters(parameters)) {
        return new ToolResult({
          success: false,
          result: null,
          error: "Invalid parameters provided",
          metadata: { toolName: this.name }
        });
      }
      const result = await this.func(parameters);
      return new ToolResult({
        success: true,
        result,
        metadata: { toolName: this.name }
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

function checkJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
