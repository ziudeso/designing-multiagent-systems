import { registerComponent } from "../componentConfig.js";
import type { ComponentType } from "../componentConfig.js";
import { BaseTool, JSONSchema, ToolResult } from "./base.js";

export class ThinkTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.ThinkTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): ThinkTool {
    return new ThinkTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "think",
      description:
        "Pause and reason about the current state, tool results, risks, and next steps."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Detailed reasoning about the current situation."
        }
      },
      required: ["thought"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const thought = String(parameters.thought ?? "");
    return new ToolResult({
      success: true,
      result:
        thought.length > 100
          ? `Reasoning recorded: ${thought.slice(0, 100)}...`
          : `Reasoning recorded: ${thought}`,
      metadata: { thoughtLength: thought.length, toolName: "think" }
    });
  }
}

export class TaskStatusTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.TaskStatusTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): TaskStatusTool {
    return new TaskStatusTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "task_status",
      description:
        "Evaluate whether the current task is complete or incomplete with rationale."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["complete", "incomplete"],
          description: "Task status."
        },
        rationale: {
          type: "string",
          description: "Detailed explanation of the status assessment."
        },
        requirements_met: {
          type: "array",
          items: { type: "string" }
        },
        requirements_pending: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["status", "rationale"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const status = String(parameters.status ?? "");
    const rationale = String(parameters.rationale ?? "");
    const lines = [`Task Status: ${status.toUpperCase()}`, "", "Rationale:", rationale];

    if (Array.isArray(parameters.requirements_met)) {
      lines.push("", "Requirements Met:");
      lines.push(...parameters.requirements_met.map((item) => `  - ${String(item)}`));
    }
    if (Array.isArray(parameters.requirements_pending)) {
      lines.push("", "Requirements Pending:");
      lines.push(...parameters.requirements_pending.map((item) => `  - ${String(item)}`));
    }

    return new ToolResult({
      success: true,
      result: lines.join("\n"),
      metadata: {
        status,
        rationale,
        requirementsMet: parameters.requirements_met ?? [],
        requirementsPending: parameters.requirements_pending ?? []
      }
    });
  }
}

export class CalculatorTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.CalculatorTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): CalculatorTool {
    return new CalculatorTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "calculator",
      description:
        "Evaluate mathematical expressions with basic operators, Math functions, and constants."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Mathematical expression to evaluate."
        }
      },
      required: ["expression"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const expression = String(parameters.expression ?? "");
    try {
      const result = evaluateMathExpression(expression);
      return new ToolResult({
        success: true,
        result: String(result),
        metadata: { expression, result }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to evaluate expression: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { expression }
      });
    }
  }
}

export class DateTimeTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.DateTimeTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): DateTimeTool {
    return new DateTimeTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "datetime",
      description: "Get current time, parse ISO datetime strings, or format timestamps."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["now", "parse", "format"]
        },
        value: { type: "string" },
        format: { type: "string" }
      },
      required: ["operation"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const operation = String(parameters.operation ?? "");
    try {
      let result: string;
      if (operation === "now") {
        result = toPythonUtcIsoString(new Date());
      } else if (operation === "parse") {
        const value = String(parameters.value ?? "");
        if (!value) throw new Error("'value' parameter required for parse operation");
        result = toPythonUtcIsoString(new Date(value));
      } else if (operation === "format") {
        const value = String(parameters.value ?? "");
        if (!value) throw new Error("'value' parameter required for format operation");
        result = formatDate(new Date(value), String(parameters.format ?? "%Y-%m-%d %H:%M:%S"));
      } else {
        throw new Error(`Unknown operation: ${operation}`);
      }
      return new ToolResult({ success: true, result, metadata: { operation } });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `DateTime operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { operation }
      });
    }
  }
}

export class JSONParserTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.JSONParserTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): JSONParserTool {
    return new JSONParserTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "json_parser",
      description: "Parse JSON strings, validate JSON structure, or extract dot-path values."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        json_string: { type: "string" },
        path: { type: "string" }
      },
      required: ["json_string"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    try {
      const parsed = JSON.parse(String(parameters.json_string ?? ""));
      const path = parameters.path === undefined ? undefined : String(parameters.path);
      const result = path ? readPath(parsed, path) : parsed;
      return new ToolResult({ success: true, result, metadata: { path } });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

export class RegexTool extends BaseTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.RegexTool";
  static componentVersion = 1;

  static fromConfig(_config: Record<string, unknown>): RegexTool {
    return new RegexTool();
  }

  toConfig(): Record<string, unknown> {
    return {};
  }

  constructor() {
    super({
      name: "regex",
      description: "Find patterns in text using search, match, findall, and replace operations."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["search", "match", "findall", "replace"]
        },
        pattern: { type: "string" },
        text: { type: "string" },
        replacement: { type: "string" },
        flags: { type: "string" }
      },
      required: ["operation", "pattern", "text"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const operation = String(parameters.operation ?? "");
    const pattern = String(parameters.pattern ?? "");
    const text = String(parameters.text ?? "");
    const replacement = String(parameters.replacement ?? "");
    const flags = normalizeRegexFlags(String(parameters.flags ?? ""));

    try {
      const regex = new RegExp(pattern, flags);
      let result: unknown;
      if (operation === "search") {
        result = text.match(regex)?.[0] ?? null;
      } else if (operation === "match") {
        const anchored = new RegExp(`^(?:${pattern})`, flags);
        result = text.match(anchored)?.[0] ?? null;
      } else if (operation === "findall") {
        result = Array.from(text.matchAll(new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`))).map(
          (match) => {
            const groups = match.slice(1);
            if (!groups.length) return match[0];
            if (groups.length === 1) return groups[0] ?? "";
            return groups.map((group) => group ?? "");
          }
        );
      } else if (operation === "replace") {
        // Python's re.sub replaces ALL non-overlapping occurrences by default.
        // A non-global JS regex only replaces the first match, so force the
        // global flag here to match Python semantics.
        const replaceRegex = flags.includes("g")
          ? regex
          : new RegExp(pattern, `${flags}g`);
        result = text.replace(replaceRegex, replacement);
      } else {
        throw new Error(`Unknown operation: ${operation}`);
      }
      return new ToolResult({
        success: true,
        result,
        metadata: { operation, pattern }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Regex operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { operation, pattern }
      });
    }
  }
}

registerComponent(ThinkTool as any);
registerComponent(TaskStatusTool as any);
registerComponent(CalculatorTool as any);
registerComponent(DateTimeTool as any);
registerComponent(JSONParserTool as any);
registerComponent(RegexTool as any);

export function createCoreTools(): BaseTool[] {
  return [
    new ThinkTool(),
    new TaskStatusTool(),
    new CalculatorTool(),
    new DateTimeTool(),
    new JSONParserTool(),
    new RegexTool()
  ];
}

function evaluateMathExpression(expression: string): number {
  const allowedNames: Record<string, number | ((...args: any[]) => number)> = {
    abs: Math.abs,
    round: pythonRound,
    min: Math.min,
    max: Math.max,
    sum: pythonSum,
    pow: Math.pow,
    sqrt: Math.sqrt,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    log: Math.log,
    log10: Math.log10,
    exp: Math.exp,
    ceil: Math.ceil,
    floor: Math.floor,
    pi: Math.PI,
    e: Math.E
  };

  const identifiers = expression.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const identifier of identifiers) {
    if (!(identifier in allowedNames)) {
      throw new Error(`Identifier '${identifier}' is not allowed`);
    }
  }
  if (/(constructor|prototype|__proto__|globalThis|process|require|import|Function|eval|this)/.test(expression)) {
    throw new Error("Expression contains disallowed syntax");
  }

  const names = Object.keys(allowedNames);
  const values = Object.values(allowedNames);
  const fn = new Function(...names, `"use strict"; return (${expression});`) as (...args: unknown[]) => unknown;
  const result = fn(...values);
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Expression did not produce a finite number");
  }
  return result;
}

function pythonRound(value: unknown, digits: unknown = 0): number {
  const number = Number(value);
  const precision = Number(digits);
  if (!Number.isFinite(number) || !Number.isInteger(precision)) {
    throw new Error("round expects a finite number and integer precision");
  }
  const factor = 10 ** precision;
  const scaled = number * factor;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  let rounded: number;
  if (Math.abs(fraction - 0.5) < Number.EPSILON) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

function pythonSum(...values: unknown[]): number {
  const items = values.length === 1 && Array.isArray(values[0])
    ? values[0]
    : values;
  return items.reduce((total: number, item: unknown) => {
    const number = Number(item);
    if (!Number.isFinite(number)) throw new Error("sum expects finite numbers");
    return total + number;
  }, 0);
}

function toPythonUtcIsoString(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid datetime value");
  const iso = date.toISOString();
  return iso.endsWith(".000Z")
    ? iso.replace(".000Z", "+00:00")
    : iso.replace("Z", "+00:00");
}

function formatDate(date: Date, format: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return format
    .replaceAll("%Y", String(date.getUTCFullYear()))
    .replaceAll("%m", pad(date.getUTCMonth() + 1))
    .replaceAll("%d", pad(date.getUTCDate()))
    .replaceAll("%H", pad(date.getUTCHours()))
    .replaceAll("%M", pad(date.getUTCMinutes()))
    .replaceAll("%S", pad(date.getUTCSeconds()));
}

function readPath(value: unknown, path: string): unknown {
  let current: any = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)];
    } else if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      throw new Error(`Path '${path}' not found in JSON`);
    }
  }
  return current;
}

function normalizeRegexFlags(flags: string): string {
  let result = "";
  if (flags.includes("i")) result += "i";
  if (flags.includes("m")) result += "m";
  if (flags.includes("s")) result += "s";
  if (flags.includes("g")) result += "g";
  return result;
}
