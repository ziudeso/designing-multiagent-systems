/**
 * Context compaction strategies for picoagents-ts.
 *
 * Strategies are called BEFORE each LLM call in the tool loop, and the returned
 * (potentially compacted) message list continues to the next iteration. The key
 * insight is that compaction must happen INSIDE the tool loop with reassignment:
 * `messages = strategy.compact(messages)`. This ensures the compacted list is
 * used for subsequent iterations, actually reducing cumulative token usage.
 *
 * Implementations MUST preserve "atomic groups" - an assistant message with
 * tool_calls must stay together with its corresponding ToolMessage results.
 * Splitting these causes provider API errors.
 *
 * Token counting in Python uses tiktoken; here we approximate with a `len/4`
 * char-based estimate (matching the precedent in `src/termination/index.ts`).
 *
 * Ported from Python `compaction.py`.
 */

import { AssistantMessage, Message, ToolMessage } from "./messages.js";

/**
 * Interface for context compaction strategies.
 *
 * Called BEFORE each LLM call in the tool loop, allowing the strategy to compact
 * the message list. The returned list REPLACES the working message list for
 * subsequent iterations.
 */
export interface CompactionStrategy {
  /**
   * Compact messages for the next LLM call.
   *
   * @param messages Current message list.
   * @returns Messages to use (may be compacted). This list REPLACES the working
   *   list for subsequent iterations.
   */
  compact(messages: Message[]): Message[];
}

/** Select the messages at the given indices (all known-valid by construction). */
function pickMessages(messages: Message[], indices: number[]): Message[] {
  return indices.map((i) => messages[i]!);
}

/** Estimate the token count of a list of messages using a char/4 heuristic. */
function countTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // Role overhead, approximately matching Python's "+ 10" per message.
    total += 10;
    const content = msg.content ?? "";
    total += Math.floor(String(content).length / 4);

    if (msg instanceof AssistantMessage && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        total += 4;
        total += Math.floor(tc.toolName.length / 4);
        total += Math.floor(JSON.stringify(tc.parameters).length / 4);
      }
    }
  }
  return total;
}

/**
 * Group tool_call messages with their results.
 *
 * Providers require every tool_call to have a corresponding result. This ensures
 * we never split a tool call from its results.
 *
 * @returns A list of tuples, where each tuple contains indices that must stay
 *   together.
 */
function findAtomicGroups(messages: Message[]): number[][] {
  const groups: number[][] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg instanceof AssistantMessage && msg.toolCalls?.length) {
      const callIds = new Set<string>(msg.toolCalls.map((tc) => tc.callId));
      const groupIndices = [i];

      let j = i + 1;
      while (j < messages.length && callIds.size > 0) {
        const candidate = messages[j];
        if (candidate instanceof ToolMessage && callIds.has(candidate.toolCallId)) {
          groupIndices.push(j);
          callIds.delete(candidate.toolCallId);
        }
        j += 1;
      }

      groups.push(groupIndices);
      i = Math.max(...groupIndices) + 1;
    } else {
      groups.push([i]);
      i += 1;
    }
  }

  return groups;
}

/**
 * Baseline: no compaction, context grows unbounded.
 *
 * Use this for benchmarking to see how context grows without management, or for
 * short tasks where context limits won't be hit.
 */
export class NoCompaction implements CompactionStrategy {
  compact(messages: Message[]): Message[] {
    return messages;
  }
}

export interface HeadTailCompactionOptions {
  /** Maximum tokens for context (default: 100,000). */
  tokenBudget?: number;
  /** Fraction of budget for head messages (default: 0.2 = 20%). */
  headRatio?: number;
  /** Model name (informational; kept for parity with Python). */
  model?: string;
}

/**
 * Token-aware head+tail compaction strategy.
 *
 * Preserves:
 * - Head: system prompt, initial user message (critical context)
 * - Tail: recent tool calls and results (working memory)
 *
 * Drops middle messages when over budget, respecting atomic groups.
 *
 * After running, check `compactionCount` and `totalTokensSaved` for metrics.
 */
export class HeadTailCompaction implements CompactionStrategy {
  tokenBudget: number;
  headRatio: number;
  model: string;

  compactionCount = 0;
  totalTokensSaved = 0;

  constructor(options: HeadTailCompactionOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? 100_000;
    this.headRatio = options.headRatio ?? 0.2;
    this.model = options.model ?? "gpt-4o";
  }

  compact(messages: Message[]): Message[] {
    if (!messages.length) return messages;

    const currentTokens = countTokens(messages);
    if (currentTokens <= this.tokenBudget) return messages;

    // COMPACTION NEEDED
    this.compactionCount += 1;

    const groups = findAtomicGroups(messages);
    const headBudget = Math.floor(this.tokenBudget * this.headRatio);
    const tailBudget = this.tokenBudget - headBudget;

    // Fill head from start.
    const headGroups: number[][] = [];
    let headTokens = 0;
    for (const group of groups) {
      const groupTokens = countTokens(pickMessages(messages, group));
      if (headTokens + groupTokens <= headBudget) {
        headGroups.push(group);
        headTokens += groupTokens;
      } else {
        break;
      }
    }

    // Fill tail from end (skip head groups).
    const remainingGroups = groups.slice(headGroups.length);
    const tailGroups: number[][] = [];
    let tailTokens = 0;
    for (let idx = remainingGroups.length - 1; idx >= 0; idx -= 1) {
      const group = remainingGroups[idx]!;
      const groupTokens = countTokens(pickMessages(messages, group));
      if (tailTokens + groupTokens <= tailBudget) {
        tailGroups.unshift(group);
        tailTokens += groupTokens;
      } else {
        break;
      }
    }

    // Build compacted list.
    const keptIndices = new Set<number>();
    for (const group of [...headGroups, ...tailGroups]) {
      for (const i of group) keptIndices.add(i);
    }
    const compacted = [...keptIndices].sort((a, b) => a - b).map((i) => messages[i]!);

    // Track savings.
    this.totalTokensSaved += currentTokens - countTokens(compacted);

    return compacted;
  }
}

export interface SlidingWindowCompactionOptions {
  /** Maximum tokens for context (default: 100,000). */
  tokenBudget?: number;
  /** Model name (informational; kept for parity with Python). */
  model?: string;
}

/**
 * Keep only recent messages within budget.
 *
 * Always preserves the system message (if present) plus the most recent messages
 * that fit in the budget. Respects atomic groups. Simpler than
 * {@link HeadTailCompaction} but may lose important early context.
 */
export class SlidingWindowCompaction implements CompactionStrategy {
  tokenBudget: number;
  model: string;

  compactionCount = 0;
  totalTokensSaved = 0;

  constructor(options: SlidingWindowCompactionOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? 100_000;
    this.model = options.model ?? "gpt-4o";
  }

  compact(messages: Message[]): Message[] {
    if (!messages.length) return messages;

    const currentTokens = countTokens(messages);
    if (currentTokens <= this.tokenBudget) return messages;

    // COMPACTION NEEDED
    this.compactionCount += 1;

    let groups = findAtomicGroups(messages);

    // Always keep the system message if present (first message, first group).
    const systemGroups: number[][] = [];
    let systemTokens = 0;
    const firstGroup = groups[0];
    if (firstGroup && messages[firstGroup[0]!]!.role === "system") {
      systemGroups.push(firstGroup);
      systemTokens = countTokens(pickMessages(messages, firstGroup));
      groups = groups.slice(1);
    }

    // Fill from end with remaining budget.
    const remainingBudget = this.tokenBudget - systemTokens;
    const keptGroups: number[][] = [];
    let keptTokens = 0;
    for (let idx = groups.length - 1; idx >= 0; idx -= 1) {
      const group = groups[idx]!;
      const groupTokens = countTokens(pickMessages(messages, group));
      if (keptTokens + groupTokens <= remainingBudget) {
        keptGroups.unshift(group);
        keptTokens += groupTokens;
      } else {
        break;
      }
    }

    // Build compacted list.
    const keptIndices = new Set<number>();
    for (const group of [...systemGroups, ...keptGroups]) {
      for (const i of group) keptIndices.add(i);
    }
    const compacted = [...keptIndices].sort((a, b) => a - b).map((i) => messages[i]!);

    // Track savings.
    this.totalTokensSaved += currentTokens - countTokens(compacted);

    return compacted;
  }
}

/** A compaction strategy expressed as either a function or a `.compact()` object. */
export type CompactionLike = CompactionStrategy | ((messages: Message[]) => Message[]);

/** Normalize a function-or-object compaction into a {@link CompactionStrategy}. */
export function normalizeCompaction(compaction: CompactionLike): CompactionStrategy {
  if (typeof compaction === "function") {
    return { compact: compaction };
  }
  return compaction;
}
