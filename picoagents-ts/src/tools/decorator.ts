import {
  ApprovalMode,
  FunctionTool,
  FunctionToolOptions,
  ToolFunction
} from "./base.js";

export interface ToolDecoratorOptions extends Omit<FunctionToolOptions, "approvalMode"> {
  approvalMode?: ApprovalMode | `${ApprovalMode}`;
}

export function tool(func: ToolFunction, options?: ToolDecoratorOptions): FunctionTool;
export function tool(options?: ToolDecoratorOptions): (func: ToolFunction) => FunctionTool;
export function tool(
  funcOrOptions?: ToolFunction | ToolDecoratorOptions,
  maybeOptions?: ToolDecoratorOptions
): FunctionTool | ((func: ToolFunction) => FunctionTool) {
  if (typeof funcOrOptions === "function") {
    return new FunctionTool(funcOrOptions, normalizeOptions(maybeOptions));
  }

  return (func: ToolFunction) => new FunctionTool(func, normalizeOptions(funcOrOptions));
}

function normalizeOptions(options?: ToolDecoratorOptions): FunctionToolOptions {
  if (!options) return {};
  return {
    ...options,
    approvalMode:
      typeof options.approvalMode === "string"
        ? (options.approvalMode as ApprovalMode)
        : options.approvalMode
  };
}
