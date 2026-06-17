import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import { ApprovalMode, BaseTool, JSONSchema, ToolResult } from "./base.js";

export class MemoryBackend {
  basePath: string;

  constructor(basePath: string = "./memories") {
    this.basePath = path.resolve(basePath);
    fsSync.mkdirSync(this.basePath, { recursive: true });
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  validatePath(memoryPath: string): string {
    let normalized = memoryPath.startsWith("/memories")
      ? memoryPath.slice("/memories".length)
      : memoryPath;
    normalized = normalized.replace(/^\/+/, "");
    const fullPath = path.resolve(this.basePath, normalized);
    const relative = path.relative(this.basePath, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Access denied: path '${memoryPath}' is outside memory directory`);
    }
    return fullPath;
  }

  async view(memoryPath: string, viewRange?: number[]): Promise<string> {
    await this.ensureReady();
    const fullPath = this.validatePath(memoryPath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const items = await fs.readdir(fullPath, { withFileTypes: true });
      const lines = [`Directory: ${memoryPath}`];
      if (!items.length) {
        lines.push("(empty)");
      } else {
        for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`  - ${item.name}${item.isDirectory() ? "/" : ""}`);
        }
      }
      return lines.join("\n");
    }

    const content = await fs.readFile(fullPath, "utf8");
    let lines = content.split(/\r?\n/);
    let start = 1;
    if (viewRange?.length === 2) {
      start = Math.max(1, Number(viewRange[0]));
      const end = Math.min(lines.length, Number(viewRange[1]));
      lines = lines.slice(start - 1, end);
    }
    return lines.map((line, index) => `${String(index + start).padStart(5, " ")}: ${line}`).join("\n");
  }

  async create(memoryPath: string, fileText: string): Promise<string> {
    await this.ensureReady();
    const fullPath = this.validatePath(memoryPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, fileText, "utf8");
    return `File created successfully at ${memoryPath}`;
  }

  async strReplace(memoryPath: string, oldStr: string, newStr: string): Promise<string> {
    const fullPath = this.validatePath(memoryPath);
    const content = await fs.readFile(fullPath, "utf8");
    if (!content.includes(oldStr)) {
      throw new Error(`Text not found in file: '${oldStr.slice(0, 50)}'`);
    }
    await fs.writeFile(fullPath, content.replace(oldStr, () => newStr), "utf8");
    return `File ${memoryPath} has been edited successfully`;
  }

  async insert(memoryPath: string, insertLine: number, insertText: string): Promise<string> {
    const fullPath = this.validatePath(memoryPath);
    let text = insertText;
    if (!text.endsWith("\n")) text += "\n";
    const lines = (await fs.readFile(fullPath, "utf8")).split(/(?<=\n)/);
    const line = Math.max(1, Math.min(insertLine, lines.length + 1));
    lines.splice(line - 1, 0, text);
    await fs.writeFile(fullPath, lines.join(""), "utf8");
    return `Text inserted at line ${line} in ${memoryPath}`;
  }

  async delete(memoryPath: string): Promise<string> {
    const fullPath = this.validatePath(memoryPath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const items = await fs.readdir(fullPath);
      if (items.length) throw new Error(`Directory not empty: ${memoryPath}`);
      await fs.rmdir(fullPath);
      return `Directory deleted: ${memoryPath}`;
    }
    await fs.unlink(fullPath);
    return `File deleted: ${memoryPath}`;
  }

  async rename(oldPath: string, newPath: string): Promise<string> {
    const oldFullPath = this.validatePath(oldPath);
    const newFullPath = this.validatePath(newPath);
    try {
      await fs.stat(oldFullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Source path does not exist: ${oldPath}`);
      }
      throw error;
    }
    try {
      await fs.stat(newFullPath);
      throw new Error(`Destination path already exists: ${newPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(newFullPath), { recursive: true });
    await fs.rename(oldFullPath, newFullPath);
    return `Renamed ${oldPath} to ${newPath}`;
  }

  async search(query: string, memoryPath: string = "/memories"): Promise<string> {
    await this.ensureReady();
    const fullPath = this.validatePath(memoryPath);
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) throw new Error(`Path must be a directory: ${memoryPath}`);
    const matches: Array<{ file: string; line: number; content: string }> = [];
    await searchFiles(this.basePath, fullPath, query.toLowerCase(), matches);
    if (!matches.length) return `No matches found for '${query}' in ${memoryPath}`;
    const lines = [`Found ${matches.length} match(es) for '${query}':`, ""];
    for (const match of matches.slice(0, 50)) {
      lines.push(`  ${match.file}:${match.line} - ${match.content.slice(0, 80)}`);
    }
    if (matches.length > 50) lines.push(``, `... and ${matches.length - 50} more matches`);
    return lines.join("\n");
  }

  async append(memoryPath: string, text: string): Promise<string> {
    const fullPath = this.validatePath(memoryPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    let appendText = text;
    try {
      const existing = await fs.readFile(fullPath, "utf8");
      if (existing && !existing.endsWith("\n")) appendText = `\n${appendText}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!appendText.endsWith("\n")) appendText += "\n";
    await fs.appendFile(fullPath, appendText, "utf8");
    return `Text appended to ${memoryPath}`;
  }
}

export class MemoryTool extends BaseTool {
  backend: MemoryBackend;

  constructor(init: { basePath?: string; approvalMode?: ApprovalMode } = {}) {
    super({
      name: "memory",
      description:
        "Store and retrieve information in persistent memory files. Operations: view, create, str_replace, insert, delete, rename, search, append.",
      approvalMode: init.approvalMode
    });
    this.backend = new MemoryBackend(init.basePath);
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["view", "create", "str_replace", "insert", "delete", "rename", "search", "append"]
        },
        path: { type: "string" },
        view_range: { type: "array", items: { type: "integer" } },
        file_text: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        insert_line: { type: "integer" },
        insert_text: { type: "string" },
        old_path: { type: "string" },
        new_path: { type: "string" },
        query: { type: "string" },
        append_text: { type: "string" }
      },
      required: ["command"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const command = String(parameters.command ?? "");
    try {
      let result: string;
      const metadata: Record<string, unknown> = { command };
      if (command === "view") {
        result = await this.backend.view(String(parameters.path ?? "/memories"), parameters.view_range as number[] | undefined);
      } else if (command === "create") {
        const fileText = String(parameters.file_text ?? "");
        result = await this.backend.create(String(parameters.path), fileText);
        metadata.size = fileText.length;
      } else if (command === "str_replace") {
        result = await this.backend.strReplace(String(parameters.path), String(parameters.old_str ?? ""), String(parameters.new_str ?? ""));
      } else if (command === "insert") {
        result = await this.backend.insert(String(parameters.path), Number(parameters.insert_line), String(parameters.insert_text ?? ""));
      } else if (command === "delete") {
        result = await this.backend.delete(String(parameters.path));
      } else if (command === "rename") {
        result = await this.backend.rename(String(parameters.old_path), String(parameters.new_path));
      } else if (command === "search") {
        result = await this.backend.search(String(parameters.query ?? ""), String(parameters.path ?? "/memories"));
      } else if (command === "append") {
        result = await this.backend.append(String(parameters.path), String(parameters.append_text ?? ""));
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
      return new ToolResult({
        success: true,
        result,
        metadata
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: null,
        error: `Memory operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { command }
      });
    }
  }
}

async function searchFiles(
  basePath: string,
  directory: string,
  queryLower: string,
  matches: Array<{ file: string; line: number; content: string }>
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await searchFiles(basePath, fullPath, queryLower, matches);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const content = await fs.readFile(fullPath, "utf8");
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.toLowerCase().includes(queryLower)) {
          matches.push({
            file: path.relative(basePath, fullPath),
            line: index + 1,
            content: line.trim()
          });
        }
      });
    } catch {
      // Skip unreadable files.
    }
  }
}
