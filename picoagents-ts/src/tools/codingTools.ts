import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { registerComponent } from "../componentConfig.js";
import type { ComponentType } from "../componentConfig.js";
import { BaseTool, JSONSchema, ToolResult } from "./base.js";

export interface WorkspaceToolOptions {
  workspace?: string;
}

abstract class WorkspaceTool extends BaseTool {
  workspace: string;

  protected constructor(init: ConstructorParameters<typeof BaseTool>[0] & WorkspaceToolOptions) {
    super(init);
    this.workspace = path.resolve(init.workspace ?? process.cwd());
  }

  protected resolveInsideWorkspace(relativePath: string): string {
    const resolved = path.resolve(this.workspace, relativePath);
    const relative = path.relative(this.workspace, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Access denied: path outside workspace");
    }
    return resolved;
  }
}

export class ReadFileTool extends WorkspaceTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.ReadFileTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions = {}): ReadFileTool {
    return new ReadFileTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace };
  }

  constructor(options: WorkspaceToolOptions = {}) {
    super({
      name: "read_file",
      description: "Read the contents of a file.",
      workspace: options.workspace
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        file_path: { type: "string" },
        encoding: { type: "string" }
      },
      required: ["file_path"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(parameters.file_path ?? "");
    const requestedEncoding = typeof parameters.encoding === "string" ? parameters.encoding : undefined;
    const encoding = requestedEncoding && Buffer.isEncoding(requestedEncoding) ? requestedEncoding : "utf8";
    try {
      const fullPath = this.resolveInsideWorkspace(filePath);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
      const content = await fs.readFile(fullPath, encoding as BufferEncoding);
      return new ToolResult({
        success: true,
        result: content,
        metadata: {
          filePath,
          size: content.length,
          lines: content.split(/\r?\n/).length
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { filePath }
      });
    }
  }
}

export class WriteFileTool extends WorkspaceTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.WriteFileTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions = {}): WriteFileTool {
    return new WriteFileTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace };
  }

  constructor(options: WorkspaceToolOptions = {}) {
    super({
      name: "write_file",
      description:
        "Write or edit file content. Supports full write, str_replace, and insert_at_line.",
      workspace: options.workspace
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        insert_line: { type: "integer" },
        insert_content: { type: "string" },
        encoding: { type: "string" }
      },
      required: ["file_path"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(parameters.file_path ?? "");
    const requestedEncoding = typeof parameters.encoding === "string" ? parameters.encoding : undefined;
    const encoding = requestedEncoding && Buffer.isEncoding(requestedEncoding) ? requestedEncoding : "utf8";
    try {
      const fullPath = this.resolveInsideWorkspace(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      if ("content" in parameters) {
        const content = String(parameters.content ?? "");
        await fs.writeFile(fullPath, content, encoding as BufferEncoding);
        return new ToolResult({
          success: true,
          result: `Successfully wrote ${content.length} characters to ${filePath}`,
          metadata: {
            filePath,
            operation: "write",
            size: content.length,
            lines: content.split(/\r?\n/).length
          }
        });
      }

      if ("old_str" in parameters && "new_str" in parameters) {
        const oldStr = String(parameters.old_str ?? "");
        const newStr = String(parameters.new_str ?? "");
        const current = await fs.readFile(fullPath, encoding as BufferEncoding);
        if (!current.includes(oldStr)) {
          throw new Error(`String to replace not found in file: ${oldStr.slice(0, 50)}`);
        }
        await fs.writeFile(fullPath, current.replace(oldStr, newStr), encoding as BufferEncoding);
        return new ToolResult({
          success: true,
          result: `Successfully replaced text in ${filePath}`,
          metadata: {
            filePath,
            operation: "str_replace",
            oldLength: oldStr.length,
            newLength: newStr.length
          }
        });
      }

      if ("insert_line" in parameters && "insert_content" in parameters) {
        const insertLine = Number(parameters.insert_line);
        let insertContent = String(parameters.insert_content ?? "");
        if (!insertContent.endsWith("\n")) insertContent += "\n";
        let lines: string[] = [];
        try {
          lines = (await fs.readFile(fullPath, encoding as BufferEncoding)).split(/(?<=\n)/);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const index = insertLine - 1;
        if (index < 0 || index > lines.length) {
          throw new Error(`Invalid line number: ${insertLine}. File has ${lines.length} lines.`);
        }
        lines.splice(index, 0, insertContent);
        await fs.writeFile(fullPath, lines.join(""), encoding as BufferEncoding);
        return new ToolResult({
          success: true,
          result: `Successfully inserted content at line ${insertLine} in ${filePath}`,
          metadata: {
            filePath,
            operation: "insert_at_line",
            line: insertLine,
            insertLength: insertContent.length
          }
        });
      }

      throw new Error("Must provide content, old_str/new_str, or insert_line/insert_content");
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { filePath }
      });
    }
  }
}

export class ListDirectoryTool extends WorkspaceTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.ListDirectoryTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions = {}): ListDirectoryTool {
    return new ListDirectoryTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace };
  }

  constructor(options: WorkspaceToolOptions = {}) {
    super({
      name: "list_directory",
      description: "List files and directories at a path.",
      workspace: options.workspace
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        directory_path: { type: "string" },
        recursive: { type: "boolean" }
      },
      required: []
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const directoryPath = String(parameters.directory_path ?? ".");
    const recursive = Boolean(parameters.recursive ?? false);
    try {
      const fullPath = this.resolveInsideWorkspace(directoryPath);
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${directoryPath}`);
      const entries = recursive
        ? await listRecursive(fullPath, fullPath)
        : await listFlat(fullPath);
      entries.sort((a, b) => Number(a.type !== "directory") - Number(b.type !== "directory") || a.name.localeCompare(b.name));
      return new ToolResult({
        success: true,
        result: entries,
        metadata: { directory: directoryPath, count: entries.length }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { directoryPath }
      });
    }
  }
}

export class GrepSearchTool extends WorkspaceTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.GrepSearchTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions = {}): GrepSearchTool {
    return new GrepSearchTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace };
  }

  constructor(options: WorkspaceToolOptions = {}) {
    super({
      name: "grep_search",
      description: "Search for text patterns in files using ripgrep if available.",
      workspace: options.workspace
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        file_pattern: { type: "string" },
        case_sensitive: { type: "boolean" }
      },
      required: ["pattern"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(parameters.pattern ?? "");
    const searchPath = String(parameters.path ?? ".");
    const filePattern = parameters.file_pattern === undefined ? undefined : String(parameters.file_pattern);
    const caseSensitive = parameters.case_sensitive === undefined ? true : Boolean(parameters.case_sensitive);

    try {
      const fullPath = this.resolveInsideWorkspace(searchPath);
      const rgArgs = ["--json"];
      if (!caseSensitive) rgArgs.push("-i");
      if (filePattern) rgArgs.push("-g", filePattern);
      rgArgs.push(pattern, fullPath);

      const rg = await runCommand("rg", rgArgs, this.workspace);
      if (rg.code === 0 || rg.code === 1) {
        const matches = rg.code === 1 ? [] : parseRipgrepJson(rg.stdout);
        return new ToolResult({
          success: true,
          result: matches,
          metadata: { pattern, matches: matches.length }
        });
      }
      throw new Error(rg.stderr || `rg exited with code ${rg.code}`);
    } catch (error) {
      try {
        const fullPath = this.resolveInsideWorkspace(searchPath);
        const grepArgs = ["-rn"];
        if (!caseSensitive) grepArgs.push("-i");
        if (filePattern) grepArgs.push("--include", filePattern);
        grepArgs.push(pattern, fullPath);
        const grep = await runCommand("grep", grepArgs, this.workspace);
        if (grep.code === 0 || grep.code === 1) {
          const matches = grep.code === 1 ? [] : parseGrepOutput(grep.stdout);
          return new ToolResult({
            success: true,
            result: matches,
            metadata: { pattern, matches: matches.length }
          });
        }
        throw new Error(grep.stderr || `grep exited with code ${grep.code}`);
      } catch (fallbackError) {
        return new ToolResult({
          success: false,
          result: null,
          error: `Search failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          metadata: { pattern }
        });
      }
    }
  }
}

export class BashExecuteTool extends WorkspaceTool {
  timeout: number;

  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.BashExecuteTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions & { timeout?: number } = {}): BashExecuteTool {
    return new BashExecuteTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace, timeout: this.timeout };
  }

  constructor(options: WorkspaceToolOptions & { timeout?: number } = {}) {
    super({
      name: "bash_execute",
      description: "Execute shell commands in the workspace.",
      workspace: options.workspace
    });
    this.timeout = options.timeout ?? 30;
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" }
      },
      required: ["command"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const command = String(parameters.command ?? "");
    const timeout = Number(parameters.timeout ?? this.timeout);
    try {
      const result = await runShell(command, this.workspace, timeout);
      return new ToolResult({
        success: result.code === 0,
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          returncode: result.code
        },
        error: result.code === 0 ? undefined : result.stderr,
        metadata: { command, returncode: result.code }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { command }
      });
    }
  }
}

/**
 * Execute Python code as a subprocess (`python3 -c <code>`).
 *
 * DIFFERENCE FROM PYTHON: the Python `PythonREPLTool` runs code IN-PROCESS via
 * `exec()` in an isolated namespace, capturing stdout/stderr, and reports
 * `success = (stderr is empty)`. Node cannot execute Python in-process, so this
 * port shells out to `python3 -c`. Accordingly, success is aligned to the
 * subprocess exit code: `success = (returncode === 0)`. This means a Python
 * program that writes to stderr but exits 0 is treated as a success here (unlike
 * the in-process Python implementation). Metadata keys are kept camelCase.
 */
export class PythonREPLTool extends WorkspaceTool {
  static componentType: ComponentType = "tool";
  static componentProvider = "picoagents.tools.PythonREPLTool";
  static componentVersion = 1;

  static fromConfig(config: WorkspaceToolOptions = {}): PythonREPLTool {
    return new PythonREPLTool(config);
  }

  toConfig(): Record<string, unknown> {
    return { workspace: this.workspace };
  }

  constructor(options: WorkspaceToolOptions = {}) {
    super({
      name: "python_repl",
      description: "Execute Python code in the workspace and return output/errors.",
      workspace: options.workspace
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        code: { type: "string" }
      },
      required: ["code"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const code = String(parameters.code ?? "");
    try {
      const result = await runCommand("python3", ["-c", code], this.workspace);
      return new ToolResult({
        success: result.code === 0,
        result: result.stdout || null,
        error: result.code === 0 ? undefined : result.stderr,
        metadata: { codeLength: code.length, returncode: result.code }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Python execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { codeLength: code.length }
      });
    }
  }
}

registerComponent(ReadFileTool as any);
registerComponent(WriteFileTool as any);
registerComponent(ListDirectoryTool as any);
registerComponent(GrepSearchTool as any);
registerComponent(BashExecuteTool as any);
registerComponent(PythonREPLTool as any);

export function createCodingTools(options: WorkspaceToolOptions = {}): BaseTool[] {
  return [
    new ReadFileTool(options),
    new WriteFileTool(options),
    new ListDirectoryTool(options),
    new GrepSearchTool(options),
    new BashExecuteTool(options),
    new PythonREPLTool(options)
  ];
}

async function listFlat(directory: string): Promise<Array<{ name: string; type: string; size: number | null }>> {
  const names = await fs.readdir(directory);
  return Promise.all(
    names.map(async (name) => {
      const fullPath = path.join(directory, name);
      const stat = await fs.stat(fullPath);
      return {
        name,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.isFile() ? stat.size : null
      };
    })
  );
}

async function listRecursive(root: string, directory: string): Promise<Array<{ name: string; type: string; size: number | null }>> {
  const entries: Array<{ name: string; type: string; size: number | null }> = [];
  for (const name of await fs.readdir(directory)) {
    const fullPath = path.join(directory, name);
    const stat = await fs.stat(fullPath);
    entries.push({
      name: path.relative(root, fullPath),
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.isFile() ? stat.size : null
    });
    if (stat.isDirectory()) entries.push(...(await listRecursive(root, fullPath)));
  }
  return entries;
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function runShell(command: string, cwd: string, timeoutSeconds: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function parseRipgrepJson(stdout: string): Array<{ file: string; line: number; text: string }> {
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.type === "match") {
        matches.push({
          file: data.data?.path?.text,
          line: data.data?.line_number,
          text: String(data.data?.lines?.text ?? "").trim()
        });
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return matches;
}

function parseGrepOutput(stdout: string): Array<{ file: string; line: number; text: string }> {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [file = "", lineNumber = "0", ...rest] = line.split(":");
      return {
        file,
        line: Number(lineNumber),
        text: rest.join(":").trim()
      };
    });
}
