/**
 * Deterministic loop hooks for picoagents-ts.
 *
 * Hooks provide deterministic control points around the LLM-controlled tool loop:
 *   - start hooks run before the first LLM call and can inject instructions.
 *   - end hooks run when the agent would stop and can resume the loop.
 *
 * Hook logic is plain deterministic code; the LLM only sees the injected message.
 * Ported from Python `_hooks.py`.
 */

import { AgentContext } from "./context.js";
import { Message, SystemMessage, UserMessage } from "./messages.js";

/** Shared state passed to hooks during a single agent run. */
export interface LoopContextInit {
  agentContext: AgentContext;
  llmMessages: Message[];
  agentName: string;
  iteration?: number;
  restartCount?: number;
  metadata?: Record<string, unknown>;
  modelClient?: { create(messages: Message[]): Promise<{ message: { content: string } }> };
}

export class LoopContext {
  agentContext: AgentContext;
  llmMessages: Message[];
  agentName: string;
  iteration: number;
  restartCount: number;
  metadata: Record<string, unknown>;
  modelClient?: { create(messages: Message[]): Promise<{ message: { content: string } }> };

  constructor(init: LoopContextInit) {
    this.agentContext = init.agentContext;
    this.llmMessages = init.llmMessages;
    this.agentName = init.agentName;
    this.iteration = init.iteration ?? 0;
    this.restartCount = init.restartCount ?? 0;
    this.metadata = init.metadata ?? {};
    this.modelClient = init.modelClient;
  }
}

// ---------------------------------------------------------------------------
// Termination conditions (control when end hooks stop restarting the loop)
// ---------------------------------------------------------------------------

/** Controls when end hooks should stop restarting the agent loop. */
export abstract class TerminationCondition {
  abstract shouldTerminate(context: LoopContext): boolean;

  reset(): void {
    /* no-op by default */
  }

  /** Combine with OR — terminate if EITHER condition is met. */
  or(other: TerminationCondition): CompositeTermination {
    return new CompositeTermination([this, other], "any");
  }

  /** Combine with AND — terminate only if BOTH conditions are met. */
  and(other: TerminationCondition): CompositeTermination {
    return new CompositeTermination([this, other], "all");
  }
}

/** Terminate after a maximum number of loop restarts. */
export class MaxRestartsTermination extends TerminationCondition {
  maxRestarts: number;

  constructor(maxRestarts = 2) {
    super();
    this.maxRestarts = maxRestarts;
  }

  shouldTerminate(context: LoopContext): boolean {
    return context.restartCount >= this.maxRestarts;
  }
}

/** Combines multiple termination conditions with AND/OR logic. */
export class CompositeTermination extends TerminationCondition {
  conditions: TerminationCondition[];
  mode: "any" | "all";

  constructor(conditions: TerminationCondition[], mode: "any" | "all" = "any") {
    super();
    this.conditions = conditions;
    this.mode = mode;
  }

  shouldTerminate(context: LoopContext): boolean {
    const results = this.conditions.map((c) => c.shouldTerminate(context));
    return this.mode === "any" ? results.some(Boolean) : results.every(Boolean);
  }

  reset(): void {
    for (const c of this.conditions) c.reset();
  }

  or(other: TerminationCondition): CompositeTermination {
    if (this.mode === "any") {
      if (other instanceof CompositeTermination && other.mode === "any") {
        return new CompositeTermination([...this.conditions, ...other.conditions], "any");
      }
      return new CompositeTermination([...this.conditions, other], "any");
    }
    return new CompositeTermination([this, other], "any");
  }

  and(other: TerminationCondition): CompositeTermination {
    if (this.mode === "all") {
      if (other instanceof CompositeTermination && other.mode === "all") {
        return new CompositeTermination([...this.conditions, ...other.conditions], "all");
      }
      return new CompositeTermination([...this.conditions, other], "all");
    }
    return new CompositeTermination([this, other], "all");
  }
}

// ---------------------------------------------------------------------------
// Hook base classes
// ---------------------------------------------------------------------------

/** Base class for hooks that run before the first LLM call. */
export abstract class BaseStartHook {
  /** Return text to inject as a UserMessage, or null to do nothing. */
  abstract onStart(context: LoopContext): Promise<string | null>;
}

/** Base class for hooks that run when the agent would stop. */
export abstract class BaseEndHook {
  /** Return text to inject (and resume the loop), or null to allow stop. */
  abstract onEnd(context: LoopContext): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Concrete implementations
// ---------------------------------------------------------------------------

const DEFAULT_PLANNING_INSTRUCTION =
  "Before starting any work, you MUST:\n" +
  "1. Analyze the task and break it into clear, actionable steps\n" +
  "2. Use the todo_write tool to create a structured task list\n" +
  "3. Each todo needs: content (what to do), status ('pending'), activeForm (present tense)\n" +
  "4. Mark the first task as 'in_progress' before starting it\n" +
  "5. Only ONE task should be 'in_progress' at a time\n\n" +
  "As you work, update the todo list: mark tasks 'completed' when done, " +
  "set the next task to 'in_progress'.";

/** Start hook that injects a planning instruction before the first LLM call. */
export class PlanningHook extends BaseStartHook {
  instruction: string;

  constructor(instruction?: string) {
    super();
    this.instruction = instruction ?? DEFAULT_PLANNING_INSTRUCTION;
  }

  async onStart(_context: LoopContext): Promise<string | null> {
    return this.instruction;
  }
}

interface TodoItem {
  content?: string;
  status?: string;
}

/** Best-effort load of the current todo list from the context-tools module. */
async function loadTodosSafe(): Promise<TodoItem[]> {
  try {
    const mod: any = await import("./tools/index.js");
    if (typeof mod.loadTodos === "function") {
      return (mod.loadTodos() as TodoItem[]) ?? [];
    }
  } catch {
    // context tools not available
  }
  return [];
}

/** End hook that checks todo-list completion before allowing the agent to stop. */
export class CompletionCheckHook extends BaseEndHook {
  termination: TerminationCondition;

  constructor(options: { termination?: TerminationCondition; maxRestarts?: number } = {}) {
    super();
    this.termination = options.termination ?? new MaxRestartsTermination(options.maxRestarts ?? 2);
  }

  async onEnd(context: LoopContext): Promise<string | null> {
    if (this.termination.shouldTerminate(context)) return null;

    const todos = await loadTodosSafe();
    if (!todos.length) return null;

    const incomplete = todos.filter((t) => t.status !== "completed");
    if (!incomplete.length) return null;

    const total = todos.length;
    const completed = total - incomplete.length;
    const items = incomplete
      .map((t) => `  - [${t.status ?? "pending"}] ${t.content ?? ""}`)
      .join("\n");

    return (
      `You have ${incomplete.length} incomplete tasks ` +
      `(${completed}/${total} completed):\n${items}\n\n` +
      "Continue working on the next pending task. " +
      "Update the todo list as you make progress. " +
      "Do not ask for user input - proceed autonomously."
    );
  }
}

/** End hook that uses an LLM to judge whether the task is complete. */
export class LLMCompletionCheckHook extends BaseEndHook {
  modelClient?: LoopContext["modelClient"];
  termination: TerminationCondition;

  constructor(
    options: {
      modelClient?: LoopContext["modelClient"];
      termination?: TerminationCondition;
      maxRestarts?: number;
    } = {}
  ) {
    super();
    this.modelClient = options.modelClient;
    this.termination = options.termination ?? new MaxRestartsTermination(options.maxRestarts ?? 2);
  }

  private buildConversationSummary(messages: Message[], maxChars = 6000): string {
    const lines: string[] = [];
    let totalChars = 0;

    for (const msg of messages) {
      const role = (msg as { role?: string }).role ?? "";
      const content = msg.content ?? "";
      const source = (msg as { source?: string }).source ?? "";
      let line = "";

      if (role === "user" && source !== "hook") {
        continue;
      } else if (role === "user" && source === "hook") {
        line = `[HOOK] ${content.slice(0, 200)}`;
      } else if (role === "assistant") {
        const toolCalls = (msg as { toolCalls?: Array<{ toolName: string; parameters: unknown }> }).toolCalls;
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            const params = JSON.stringify(tc.parameters).slice(0, 100);
            const callLine = `[CALL] ${tc.toolName}(${params})`;
            lines.push(callLine);
            totalChars += callLine.length;
          }
          if (content.trim()) {
            line = `[TEXT] ${content.slice(0, 300)}`;
          } else {
            continue;
          }
        } else {
          line = `[RESPONSE] ${content.slice(0, 500)}`;
        }
      } else if (role === "tool") {
        const size = content.length;
        const preview = content.slice(0, 150).replace(/\n/g, " ");
        const toolName = (msg as { toolName?: string }).toolName ?? "?";
        line = `[RESULT] ${toolName} (${size} chars): ${preview}`;
      } else {
        continue;
      }

      if (totalChars + line.length > maxChars) {
        lines.push(`... (${messages.length - lines.length} more messages truncated)`);
        break;
      }
      lines.push(line);
      totalChars += line.length;
    }

    return lines.join("\n");
  }

  async onEnd(context: LoopContext): Promise<string | null> {
    if (this.termination.shouldTerminate(context)) return null;

    const client = this.modelClient ?? context.modelClient;
    if (!client) return null;

    let task = "";
    for (const msg of context.llmMessages) {
      if ((msg as { role?: string }).role === "user") {
        task = msg.content;
        break;
      }
    }
    if (!task) return null;

    const summary = this.buildConversationSummary(context.llmMessages);

    const judgeMessages = [
      new SystemMessage({
        content:
          "You are a strict task completion judge. Given a task and a log of what an " +
          "agent has done, determine if the task is COMPLETE.\n\n" +
          "The log shows every tool call the agent made, what results it got, and what " +
          "text it produced.\n\n" +
          "Reply with exactly one of:\n" +
          "- COMPLETE: <reason>\n" +
          "- INCOMPLETE: <what specific work remains>\n\n" +
          "Be strict. Judge based on what the agent ACTUALLY DID (the tool calls and " +
          "results), not what it CLAIMS to have done in its response text.",
        source: "system"
      }),
      new UserMessage({
        content: `## Original Task\n${task}\n\n## Agent Activity Log\n${summary}\n\nIs the task COMPLETE or INCOMPLETE?`,
        source: "judge"
      })
    ];

    try {
      const result = await client.create(judgeMessages);
      const responseText = result.message.content.trim();
      if (responseText.toUpperCase().startsWith("COMPLETE")) {
        return null;
      }
      const reason = responseText.includes(":")
        ? responseText.split(/:(.+)/)[1]?.trim() ?? "The task is not yet complete."
        : "The task is not yet complete.";
      return (
        `You are not done yet. ${reason}\n\n` +
        "Continue working on the task. Do not stop until the task is fully complete. " +
        "Do not ask for user input."
      );
    } catch {
      return null;
    }
  }
}
