/**
 * Context engineering tools for picoagents-ts.
 *
 * Ports `picoagents/tools/_context_tools.py`. Provides tools for context
 * management following Anthropic's context engineering patterns:
 *
 * 1. TaskTool - Spawn sub-agents in isolated contexts (Isolation strategy)
 * 2. TodoWriteTool / TodoReadTool / TodoListSessionsTool - Track task progress
 * 3. SkillsTool - Progressive disclosure of domain expertise
 * 4. MultiEditTool - Atomic multi-edit for files
 *
 * Persistence uses Node `fs`/`path`/`os` under a `.picoagents` directory in the
 * current working directory (todos) and `~/.picoagents/skills` (user skills).
 * Tool names and parameter schemas stay snake_case because they are LLM-facing
 * tool contracts; internal metadata keys are camelCase.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseChatCompletionClient } from "../llm/index.js";
import { BaseTool, JSONSchema, ToolResult } from "./base.js";
import { ThinkTool } from "./coreTools.js";
import { GrepSearchTool, ListDirectoryTool, ReadFileTool } from "./codingTools.js";
import { ArxivSearchTool, WebFetchTool, WebSearchTool, YouTubeCaptionTool } from "./researchTools.js";

// Imported only for type usage in TaskTool; the actual Agent class is loaded
// lazily inside execute() to avoid import cycles.
import type { Agent } from "../agents/index.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Task Tool - Context Isolation via Sub-agents
// =============================================================================

interface AgentTypeConfig {
  description: string;
  instructions: string;
  /** Tool names to assemble for this sub-agent, or null to inherit coordinator tools. */
  toolNames: string[] | null;
}

/** Agent type configurations for sub-agents (mirrors Python AGENT_TYPES). */
export const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  explore: {
    description: "Fast agent for exploring codebases",
    instructions: `You are a codebase exploration specialist.

Your role:
1. Quickly find files, code patterns, and answer questions about the codebase
2. Use glob and grep efficiently to locate relevant code
3. Read files to understand implementations
4. Provide concise, accurate summaries

Guidelines:
- Be thorough but efficient - don't read unnecessary files
- Focus on answering the specific question asked
- Return structured findings (file paths, line numbers, key code snippets)
- Keep your final response under 500 tokens
- Your response will be passed to another agent, so make it self-contained
`,
    toolNames: ["read_file", "list_directory", "grep_search", "think"]
  },
  research: {
    description: "Agent for web research and information gathering",
    instructions: `You are a research assistant.

Your role:
1. Thoroughly research the given topic using web search and fetch
2. Gather relevant information from multiple sources
3. Synthesize findings into a clear, concise summary
4. Return only the essential information needed

Guidelines:
- Be thorough in research but concise in response
- Focus on facts and actionable information
- Cite sources when relevant
- Target 200-500 tokens for your final response
- Your response will be passed to another agent, so make it self-contained
`,
    toolNames: ["web_search", "web_fetch", "arxiv_search", "youtube_caption", "think"]
  },
  general: {
    description: "General-purpose agent for complex multi-step tasks",
    instructions: `You are a capable assistant handling a delegated task.

Your role:
1. Complete the assigned task thoroughly
2. Use available tools as needed
3. Return a clear summary of what was accomplished

Guidelines:
- Focus on the specific task assigned
- Be thorough but concise in your response
- Include relevant details the coordinator needs
- Target 300-600 tokens for your final response
`,
    toolNames: null // Uses coordinator's tools
  }
};

export interface TaskToolOptions {
  coordinator?: Agent;
  modelClient?: BaseChatCompletionClient;
  tokenBudget?: number;
  maxIterations?: number;
}

/**
 * Spawn sub-agents to handle tasks in isolated contexts.
 *
 * The Task tool enables context isolation - sub-agents run in their own context
 * windows, preventing context pollution in the coordinator. Only the distilled
 * result crosses back.
 */
export class TaskTool extends BaseTool {
  coordinator?: Agent;
  modelClient?: BaseChatCompletionClient;
  tokenBudget: number;
  maxIterations: number;

  constructor(options: TaskToolOptions = {}) {
    super({
      name: "task",
      description:
        "Launch a sub-agent to handle a complex task in isolated context. " +
        "Use when: (1) you need to explore a codebase without polluting context, " +
        "(2) a task requires many tool calls that would bloat context, " +
        "(3) you want to delegate research to a specialist, " +
        "(4) the task has clear input/output boundaries. " +
        "Agent types: 'explore' (codebase search), 'research' (web), 'general' (all tools)."
    });
    this.coordinator = options.coordinator;
    this.modelClient = options.modelClient;
    this.tokenBudget = options.tokenBudget ?? 50_000;
    this.maxIterations = options.maxIterations ?? 20;
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the task for the sub-agent"
        },
        description: {
          type: "string",
          description: "Short 3-5 word summary of what the sub-agent will do"
        },
        agent_type: {
          type: "string",
          enum: ["explore", "research", "general"],
          description:
            "Type of sub-agent: 'explore' for codebase search, " +
            "'research' for web research, 'general' for other tasks",
          default: "general"
        }
      },
      required: ["prompt", "description"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(parameters.prompt ?? "");
    const description = String(parameters.description ?? "");
    const agentType = String(parameters.agent_type ?? "general");

    if (!prompt) {
      return new ToolResult({
        success: false,
        result: "",
        error: "'prompt' parameter is required"
      });
    }

    try {
      // Lazy imports to avoid circular dependencies.
      const { Agent } = await import("../agents/index.js");
      const { HeadTailCompaction } = await import("../compaction.js");

      const config: AgentTypeConfig = AGENT_TYPES[agentType] ?? AGENT_TYPES.general!;

      // Determine model client.
      let client = this.modelClient;
      if (!client && this.coordinator) client = this.coordinator.modelClient;
      if (!client) {
        return new ToolResult({
          success: false,
          result: "",
          error: "No model client available. Provide modelClient or coordinator."
        });
      }

      const subTools = this.getToolsForType(agentType, config);

      const headTail = new HeadTailCompaction({
        tokenBudget: this.tokenBudget,
        headRatio: 0.2
      });

      const subAgent = new Agent({
        name: `sub_${agentType}`,
        description: config.description,
        instructions: config.instructions,
        modelClient: client,
        tools: subTools,
        compaction: (messages) => headTail.compact(messages),
        maxIterations: this.maxIterations
      });

      const response = await subAgent.run(prompt);

      // Extract content from the last assistant message.
      let content = "";
      const messages = response.context?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg && msg.role === "assistant") {
          content = msg.content ?? "";
          break;
        }
      }
      if (!content) content = "(No response from sub-agent)";

      const usage = response.usage;
      const usageInfo =
        `\n\n[Sub-agent (${agentType}): ` +
        `${usage.llmCalls} LLM calls, ` +
        `${usage.tokensInput} input tokens, ` +
        `${usage.toolCalls} tool calls]`;

      return new ToolResult({
        success: true,
        result: content + usageInfo,
        metadata: {
          agentType,
          description,
          llmCalls: usage.llmCalls,
          tokensInput: usage.tokensInput,
          toolCalls: usage.toolCalls
        }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: "",
        error: `Sub-agent failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private getToolsForType(_agentType: string, config: AgentTypeConfig): BaseTool[] {
    const toolNames = config.toolNames;

    if (toolNames === null) {
      // General agent - inherit coordinator's tools (except task itself).
      if (this.coordinator) {
        return this.coordinator.tools.filter((t) => t.name !== "task");
      }
      return [];
    }

    // Specific tool set - assemble a minimal tool map.
    const toolMap = new Map<string, BaseTool>([
      ["think", new ThinkTool()],
      ["read_file", new ReadFileTool()],
      ["list_directory", new ListDirectoryTool()],
      ["grep_search", new GrepSearchTool()],
      ["web_search", new WebSearchTool()],
      ["web_fetch", new WebFetchTool()],
      ["arxiv_search", new ArxivSearchTool()],
      ["youtube_caption", new YouTubeCaptionTool()]
    ]);

    const tools: BaseTool[] = [];
    for (const name of toolNames) {
      const tool = toolMap.get(name);
      if (tool) tools.push(tool);
    }
    return tools;
  }
}

// =============================================================================
// Todo Tools - Task Progress Tracking
// =============================================================================

interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
}

interface SessionInfo {
  sessionId: string;
  path: string;
  created: number;
  todoCount: number;
  completed: number;
}

// Global todo storage configuration (module-level, mirrors Python globals).
let _todoPath: string | null = null;
let _sessionId: string | null = null;

function getWorkspace(): string {
  const workspace = path.join(process.cwd(), ".picoagents");
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

function ensureSessionId(): string {
  if (_sessionId === null) {
    // Generate session ID: date + short UUID.
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
    const shortId = randomUUID().replace(/-/g, "").slice(0, 8);
    _sessionId = `${dateStr}_${shortId}`;
  }
  return _sessionId;
}

function getTodosDir(): string {
  const todosDir = path.join(getWorkspace(), "todos");
  fs.mkdirSync(todosDir, { recursive: true });
  return todosDir;
}

function getTodoPath(): string {
  if (_todoPath !== null) return _todoPath;
  const sessionId = ensureSessionId();
  return path.join(getTodosDir(), `session_${sessionId}.json`);
}

/** Set custom todo storage path (for testing). Pass null to reset to default. */
export function setTodoPath(filePath: string | null): void {
  _todoPath = filePath;
}

/** Set a custom session ID (useful for resuming sessions). Pass null to reset. */
export function setSessionId(sessionId: string | null): void {
  _sessionId = sessionId;
}

/** Get the current session ID (creating one if needed). */
export function getCurrentSessionId(): string {
  return ensureSessionId();
}

/**
 * Load todos from the current session's todo file.
 *
 * Returns [] if no todo file exists or it cannot be parsed. Exported because
 * the hooks module depends on `loadTodos` being available from the tools
 * barrel.
 */
export function loadTodos(): TodoItem[] {
  const filePath = getTodoPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Support both old format (list) and new format (dict with metadata).
    if (Array.isArray(data)) return data as TodoItem[];
    return (data?.todos ?? []) as TodoItem[];
  } catch {
    return [];
  }
}

function saveTodos(todos: TodoItem[]): void {
  const filePath = getTodoPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const nowIso = new Date().toISOString();
  const data = {
    sessionId: ensureSessionId(),
    createdAt: nowIso,
    updatedAt: nowIso,
    todos
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** List all todo sessions with their metadata (newest first). */
export function listTodoSessions(): SessionInfo[] {
  const todosDir = path.join(getWorkspace(), "todos");
  if (!fs.existsSync(todosDir)) return [];

  const files = fs
    .readdirSync(todosDir)
    .filter((f) => f.startsWith("session_") && f.endsWith(".json"))
    .sort()
    .reverse();

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    const fullPath = path.join(todosDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const todos: TodoItem[] = Array.isArray(data) ? data : data?.todos ?? [];
      const sessionId = file.replace(/^session_/, "").replace(/\.json$/, "");
      const stat = fs.statSync(fullPath);
      sessions.push({
        sessionId,
        path: fullPath,
        created: stat.mtimeMs,
        todoCount: todos.length,
        completed: todos.filter((t) => t.status === "completed").length
      });
    } catch {
      continue;
    }
  }
  return sessions;
}

export class TodoWriteTool extends BaseTool {
  constructor() {
    super({
      name: "todo_write",
      description:
        "Create or update the task list for this session. " +
        "Use for complex multi-step tasks (3+ steps). " +
        "Each todo needs: content (str), status ('pending'|'in_progress'|'completed'), " +
        "activeForm (str). Only ONE task should be 'in_progress' at a time."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "List of todo items",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "What needs to be done (imperative form)"
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Task status"
              },
              activeForm: {
                type: "string",
                description: "Present tense description (e.g., 'Running tests')"
              }
            },
            required: ["content", "status", "activeForm"]
          }
        }
      },
      required: ["todos"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const todos = (parameters.todos ?? []) as TodoItem[];
    const validStatuses = new Set(["pending", "in_progress", "completed"]);

    for (let i = 0; i < todos.length; i += 1) {
      const todo = todos[i]!;
      if (todo.content === undefined) {
        return new ToolResult({ success: false, result: "", error: `Todo ${i + 1} missing 'content'` });
      }
      if (todo.status === undefined) {
        return new ToolResult({ success: false, result: "", error: `Todo ${i + 1} missing 'status'` });
      }
      if (!validStatuses.has(todo.status)) {
        return new ToolResult({
          success: false,
          result: "",
          error: `Todo ${i + 1} has invalid status '${todo.status}'`
        });
      }
      if (todo.activeForm === undefined) {
        return new ToolResult({ success: false, result: "", error: `Todo ${i + 1} missing 'activeForm'` });
      }
    }

    const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
    if (inProgressCount > 1) {
      return new ToolResult({
        success: false,
        result: "",
        error: `${inProgressCount} tasks marked 'in_progress'. Only one allowed.`
      });
    }

    saveTodos(todos);

    const completed = todos.filter((t) => t.status === "completed").length;
    const pending = todos.filter((t) => t.status === "pending").length;
    const inProgress = inProgressCount;
    const current = todos.find((t) => t.status === "in_progress");
    const currentMsg = current ? `Current: ${current.activeForm}` : "No task in progress";

    const result =
      `Todo list updated: ${completed} completed, ${inProgress} in progress, ` +
      `${pending} pending. ${currentMsg}`;

    return new ToolResult({
      success: true,
      result,
      metadata: { completed, pending, inProgress }
    });
  }
}

export class TodoReadTool extends BaseTool {
  constructor() {
    super({
      name: "todo_read",
      description: "Read the current todo list with status of all tasks."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional session ID to read from (defaults to current session)"
        }
      }
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = parameters.session_id === undefined ? undefined : String(parameters.session_id);

    let originalSession: string | null = null;
    let switched = false;
    if (sessionId) {
      originalSession = _sessionId;
      setSessionId(sessionId);
      switched = true;
    }

    try {
      const todos = loadTodos();
      if (!todos.length) {
        return new ToolResult({
          success: true,
          result: "No todos. Use todo_write to create a task list."
        });
      }

      const lines: string[] = [];
      for (const todo of todos) {
        const status = todo.status ?? "pending";
        const content = todo.content ?? "";
        let icon = "○";
        if (status === "completed") icon = "✓";
        else if (status === "in_progress") icon = "→";
        lines.push(`${icon} ${content}`);
      }

      const completed = todos.filter((t) => t.status === "completed").length;
      const total = todos.length;
      const currentSession = ensureSessionId();
      const result = `Session: ${currentSession}\nProgress: ${completed}/${total}\n\n${lines.join("\n")}`;

      return new ToolResult({
        success: true,
        result,
        metadata: { completed, total, sessionId: currentSession }
      });
    } finally {
      if (switched) setSessionId(originalSession);
    }
  }
}

export class TodoListSessionsTool extends BaseTool {
  constructor() {
    super({
      name: "todo_sessions",
      description:
        "List all todo sessions. Use to find past work or resume a previous session. " +
        "Returns session IDs that can be passed to todo_read."
    });
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max number of sessions to return (default 10)",
          default: 10
        }
      }
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const limit = Number(parameters.limit ?? 10);
    const sessions = listTodoSessions().slice(0, limit);

    if (!sessions.length) {
      return new ToolResult({ success: true, result: "No previous sessions found." });
    }

    const lines: string[] = [`Found ${sessions.length} session(s):\n`];
    for (const session of sessions) {
      const created = formatDateTime(new Date(session.created));
      lines.push(
        `• ${session.sessionId}: ${session.completed}/${session.todoCount} completed (${created})`
      );
    }
    lines.push(`\nCurrent session: ${ensureSessionId()}`);
    lines.push("Use todo_read(session_id='...') to view a specific session.");

    return new ToolResult({
      success: true,
      result: lines.join("\n"),
      metadata: { sessions, currentSession: ensureSessionId() }
    });
  }
}

function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

// =============================================================================
// Skills Tool - Progressive Disclosure
// =============================================================================

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(content);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const rawLine of match[1]!.split("\n")) {
    const line = rawLine.trim();
    const idx = line.indexOf(":");
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

function getSkillBody(content: string): string {
  const match = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(content);
  if (match) return content.slice(match[0].length);
  return content;
}

export interface SkillsToolOptions {
  builtinPath?: string;
  userPath?: string;
  projectPath?: string;
  extraPaths?: string[];
}

type DiscoveredSkill = { skillMd: string; meta: Record<string, string> };

/**
 * Discover and load skills for domain-specific guidance.
 *
 * Skills are SKILL.md files (with YAML frontmatter) inside skill folders.
 * Progressive disclosure: 'list' shows only summaries, 'load' fetches full
 * content on demand.
 */
export class SkillsTool extends BaseTool {
  skillPaths: string[] = [];

  constructor(options: SkillsToolOptions = {}) {
    super({
      name: "skills",
      description:
        "Discover and load skills for domain-specific guidance. " +
        "Use action='list' to see available skills (summaries only). " +
        "Use action='load' with name to get full content."
    });

    // Build list of skill paths (later paths override earlier).
    const builtinPath = options.builtinPath ?? getDefaultBuiltinSkillsPath();
    if (builtinPath) this.skillPaths.push(builtinPath);
    if (options.userPath) {
      this.skillPaths.push(options.userPath);
    } else {
      const defaultUser = path.join(os.homedir(), ".picoagents", "skills");
      if (fs.existsSync(defaultUser)) this.skillPaths.push(defaultUser);
    }
    if (options.projectPath) this.skillPaths.push(options.projectPath);
    if (options.extraPaths) this.skillPaths.push(...options.extraPaths);
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "load"],
          description: "'list' for summaries, 'load' for full content"
        },
        name: {
          type: "string",
          description: "Skill name to load (required for 'load' action)"
        }
      },
      required: ["action"]
    };
  }

  private discoverSkills(): Map<string, DiscoveredSkill> {
    const skills = new Map<string, DiscoveredSkill>();

    for (const skillsPath of this.skillPaths) {
      if (!fs.existsSync(skillsPath)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsPath, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        try {
          const content = fs.readFileSync(skillMd, "utf8");
          const meta = parseSkillFrontmatter(content);
          const skillName = meta.name ?? entry.name;
          skills.set(skillName, { skillMd, meta });
        } catch {
          skills.set(entry.name, {
            skillMd,
            meta: { name: entry.name, description: "Error reading skill" }
          });
        }
      }
    }
    return skills;
  }

  /**
   * Return skill metadata for system prompt injection.
   *
   * Pre-populates the system prompt with skill names and descriptions so the
   * model knows what skills exist without calling list first.
   */
  getSystemPromptSection(): string {
    const discovered = this.discoverSkills();
    if (!discovered.size) return "";

    const lines = [
      "\n## Available Skills\n",
      "Use `skills(action='load', name='...')` to load full instructions when a skill matches the task.\n"
    ];
    for (const name of [...discovered.keys()].sort()) {
      const { meta } = discovered.get(name)!;
      const desc = meta.description ?? "No description";
      lines.push(`- **${name}**: ${desc}`);
    }
    return lines.join("\n");
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const action = String(parameters.action ?? "list");
    const name = String(parameters.name ?? "");
    const discovered = this.discoverSkills();

    if (action === "list") {
      if (!discovered.size) {
        const pathsStr = this.skillPaths.length
          ? this.skillPaths.map((p) => `  - ${p}`).join("\n")
          : "  (no paths configured)";
        const result =
          "No skills found.\n\n" +
          `Skills are loaded from:\n${pathsStr}\n\n` +
          "Each skill should be a folder with a SKILL.md file.";
        return new ToolResult({ success: true, result });
      }

      const lines = ["# Available Skills\n"];
      lines.push("Use `skills(action='load', name='...')` to load full content.\n");
      for (const skillName of [...discovered.keys()].sort()) {
        const { meta } = discovered.get(skillName)!;
        const description = meta.description ?? "No description";
        const triggers = meta.triggers ?? "";
        lines.push(`### ${skillName}`);
        lines.push(description);
        if (triggers) lines.push(`_Triggers: ${triggers}_`);
        lines.push("");
      }

      return new ToolResult({
        success: true,
        result: lines.join("\n"),
        metadata: { skillCount: discovered.size }
      });
    }

    if (action === "load") {
      if (!name) {
        return new ToolResult({
          success: false,
          result: "",
          error: "'name' parameter is required for 'load' action"
        });
      }
      if (!discovered.has(name)) {
        const available = [...discovered.keys()].sort();
        let msg = `Skill '${name}' not found.`;
        if (available.length) msg += `\n\nAvailable skills: ${available.join(", ")}`;
        return new ToolResult({ success: false, result: "", error: msg });
      }

      const { skillMd, meta } = discovered.get(name)!;
      try {
        const content = fs.readFileSync(skillMd, "utf8");
        const skillName = meta.name ?? name;
        const body = getSkillBody(content);
        return new ToolResult({
          success: true,
          result: `# Skill: ${skillName}\n\n${body}`
        });
      } catch (error) {
        return new ToolResult({
          success: false,
          result: "",
          error: `Error loading skill '${name}': ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    return new ToolResult({
      success: false,
      result: "",
      error: `Unknown action: '${action}'. Use 'list' or 'load'.`
    });
  }
}

function getDefaultBuiltinSkillsPath(): string | undefined {
  const candidates = [
    path.resolve(MODULE_DIR, "../skills"),
    path.resolve(MODULE_DIR, "../../src/skills")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// =============================================================================
// Multi-Edit Tool - Atomic File Edits
// =============================================================================

export interface MultiEditToolOptions {
  workspace?: string;
}

interface MultiEdit {
  old_string?: string;
  new_string?: string;
}

/**
 * Make multiple edits to a file atomically.
 *
 * All edits succeed or fail together. Each edit needs `old_string` (must be
 * unique in the file) and `new_string`. Edits are applied sequentially, so
 * later edits see results of earlier ones. On any failure the file is left
 * unchanged.
 */
export class MultiEditTool extends BaseTool {
  workspace: string;

  constructor(options: MultiEditToolOptions = {}) {
    super({
      name: "multi_edit",
      description:
        "Make multiple edits to a file atomically. All succeed or fail together. " +
        "Each edit needs 'old_string' (unique in file) and 'new_string'. " +
        "Edits are applied sequentially."
    });
    this.workspace = path.resolve(options.workspace ?? process.cwd());
  }

  get parameters(): JSONSchema {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit"
        },
        edits: {
          type: "array",
          description: "List of edits to apply",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description: "Text to find (must be unique)"
              },
              new_string: {
                type: "string",
                description: "Text to replace with"
              }
            },
            required: ["old_string", "new_string"]
          }
        }
      },
      required: ["path", "edits"]
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const pathStr = String(parameters.path ?? "");
    const edits = (parameters.edits ?? []) as MultiEdit[];

    if (!pathStr) {
      return new ToolResult({ success: false, result: "", error: "'path' is required" });
    }
    if (!edits.length) {
      return new ToolResult({ success: false, result: "", error: "'edits' list is required" });
    }

    try {
      // Expand ~ then resolve. Absolute paths outside the workspace are allowed
      // for flexibility, mirroring the Python implementation.
      const expanded = pathStr.startsWith("~")
        ? path.join(os.homedir(), pathStr.slice(1))
        : pathStr;
      const fullPath = path.resolve(this.workspace, expanded);

      if (!fs.existsSync(fullPath)) {
        return new ToolResult({ success: false, result: "", error: `File not found: ${fullPath}` });
      }

      let content = fs.readFileSync(fullPath, "utf8");

      // Validate all edits have required fields first.
      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i]!;
        if (edit.old_string === undefined || edit.new_string === undefined) {
          return new ToolResult({
            success: false,
            result: "",
            error: `Edit ${i + 1} missing 'old_string' or 'new_string'`
          });
        }
      }

      // Apply edits sequentially against an in-memory copy (atomic rollback:
      // we only write to disk once all edits succeed).
      const applied: string[] = [];
      for (let i = 0; i < edits.length; i += 1) {
        const oldStr = edits[i]!.old_string as string;
        const newStr = edits[i]!.new_string as string;
        const count = countOccurrences(content, oldStr);

        if (count === 0) {
          return new ToolResult({
            success: false,
            result: "",
            error:
              `Edit ${i + 1} failed - could not find text.\n` +
              `Applied ${applied.length} edit(s) before failure.\n` +
              `File unchanged (atomic rollback).`
          });
        }
        if (count > 1) {
          return new ToolResult({
            success: false,
            result: "",
            error:
              `Edit ${i + 1} failed - found ${count} occurrences (must be unique).\n` +
              `Applied ${applied.length} edit(s) before failure.\n` +
              `File unchanged (atomic rollback).`
          });
        }

        content = content.replace(oldStr, () => newStr);
        applied.push(`Edit ${i + 1}: replaced ${oldStr.length} chars with ${newStr.length} chars`);
      }

      fs.writeFileSync(fullPath, content, "utf8");
      const result = `Successfully applied ${edits.length} edit(s) to ${pathStr}:\n${applied.join("\n")}`;

      return new ToolResult({
        success: true,
        result,
        metadata: { editsApplied: edits.length, path: fullPath }
      });
    } catch (error) {
      return new ToolResult({
        success: false,
        result: "",
        error: `Multi-edit failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createTaskTool(options: TaskToolOptions = {}): TaskTool {
  return new TaskTool(options);
}

export function createTodoTools(includeSessions = false): BaseTool[] {
  const tools: BaseTool[] = [new TodoWriteTool(), new TodoReadTool()];
  if (includeSessions) tools.push(new TodoListSessionsTool());
  return tools;
}

export function createSkillsTool(options: SkillsToolOptions = {}): SkillsTool {
  return new SkillsTool(options);
}

export function createMultiEditTool(options: MultiEditToolOptions = {}): MultiEditTool {
  return new MultiEditTool(options);
}

export interface ContextEngineeringToolsOptions {
  coordinator?: Agent;
  modelClient?: BaseChatCompletionClient;
  skillsPath?: string;
  workspace?: string;
}

/**
 * Create all context engineering tools: TaskTool (isolation),
 * TodoWriteTool/TodoReadTool (progress tracking), SkillsTool (progressive
 * disclosure), and MultiEditTool (atomic edits).
 */
export function createContextEngineeringTools(
  options: ContextEngineeringToolsOptions = {}
): BaseTool[] {
  return [
    createTaskTool({ coordinator: options.coordinator, modelClient: options.modelClient }),
    ...createTodoTools(),
    createSkillsTool({ projectPath: options.skillsPath }),
    createMultiEditTool({ workspace: options.workspace })
  ];
}
