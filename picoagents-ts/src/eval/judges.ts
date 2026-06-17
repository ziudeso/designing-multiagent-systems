/**
 * Evaluation judges for scoring trajectories.
 *
 * Ported from Python `eval/judges/`:
 * - BaseEvalJudge (answer extraction strategies)
 * - LLMEvalJudge (LLM-based scoring with structured JSON output)
 * - ExactMatchJudge, FuzzyMatchJudge, ContainsJudge (reference-based)
 * - CompositeJudge (weighted combination)
 */

import type { CancellationToken } from "../cancellation.js";
import { BaseChatCompletionClient } from "../llm/index.js";
import { AssistantMessage, Message, SystemMessage, UserMessage } from "../messages.js";
import type { StructuredOutputFormat } from "../llm/index.js";
import { EvalJudge } from "./base.js";
import { EvalScore, RunTrajectory } from "./types.js";

export type AnswerStrategy =
  | "last_non_empty"
  | "last_assistant"
  | "last_content"
  | "all_assistant";

/**
 * Base judge with answer-extraction strategies.
 *
 * Extends {@link EvalJudge} with configurable answer extraction from trajectories.
 */
export abstract class BaseEvalJudge extends EvalJudge {
  answerStrategy: AnswerStrategy;

  constructor(name: string, answerStrategy: AnswerStrategy = "last_non_empty") {
    super(name);
    this.answerStrategy = answerStrategy;
  }

  /** Extract the agent's answer from a trajectory using the configured strategy. */
  extractAnswer(trajectory: RunTrajectory): string {
    if (!trajectory.messages.length) return "";

    if (this.answerStrategy === "last_non_empty") {
      for (let i = trajectory.messages.length - 1; i >= 0; i -= 1) {
        const content = trajectory.messages[i]!.content ?? "";
        if (content && content.trim()) return content.trim();
      }
      return "";
    }

    if (this.answerStrategy === "last_assistant") {
      for (let i = trajectory.messages.length - 1; i >= 0; i -= 1) {
        const msg = trajectory.messages[i]!;
        if (msg instanceof AssistantMessage) return (msg.content ?? "").trim();
      }
      return "";
    }

    if (this.answerStrategy === "last_content") {
      const last = trajectory.messages[trajectory.messages.length - 1]!;
      return (last.content ?? "").trim();
    }

    if (this.answerStrategy === "all_assistant") {
      const parts: string[] = [];
      for (const msg of trajectory.messages) {
        if (msg instanceof AssistantMessage) {
          const content = (msg.content ?? "").trim();
          if (content) parts.push(content);
        }
      }
      return parts.join("\n");
    }

    throw new Error(`Unknown answerStrategy: ${this.answerStrategy}`);
  }

  abstract override score(
    trajectory: RunTrajectory,
    criteria?: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore>;
}

interface CriterionScore {
  name: string;
  score: number;
  reasoning: string;
}

interface JudgeResponse {
  scores: CriterionScore[];
}

const JUDGE_OUTPUT_FORMAT: StructuredOutputFormat = {
  name: "JudgeResponse",
  description: "Structured judge evaluation response",
  schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        description: "One score entry per evaluation criterion",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Criterion name (e.g. 'completeness')" },
            score: { type: "number", description: "Score from 0 to 10" },
            reasoning: { type: "string", description: "Brief reasoning for this score" }
          }
        }
      }
    }
  }
};

export interface LLMEvalJudgeOptions {
  name?: string;
  defaultCriteria?: string[];
  answerStrategy?: AnswerStrategy;
  customInstructions?: string;
}

/** LLM-based evaluation judge that uses another model to score trajectories. */
export class LLMEvalJudge extends BaseEvalJudge {
  client: BaseChatCompletionClient;
  defaultCriteria: string[];
  customInstructions?: string;

  constructor(client: BaseChatCompletionClient, options: LLMEvalJudgeOptions = {}) {
    super(
      options.name ?? `LLM-${client.model ?? "Judge"}`,
      options.answerStrategy ?? "last_non_empty"
    );
    this.client = client;
    this.defaultCriteria = options.defaultCriteria ?? ["accuracy", "completeness", "helpfulness"];
    this.customInstructions = options.customInstructions;
  }

  async score(
    trajectory: RunTrajectory,
    criteria?: string[],
    _cancellationToken?: CancellationToken
  ): Promise<EvalScore> {
    const evalCriteria =
      criteria ??
      (trajectory.task.evalCriteria.length ? trajectory.task.evalCriteria : this.defaultCriteria);
    const rubric = trajectory.task.rubric;

    try {
      const systemPrompt = this.buildSystemPrompt(evalCriteria, rubric);
      const userPrompt = this.buildUserPrompt(trajectory);

      const messages: Message[] = [
        new SystemMessage({ content: systemPrompt, source: "system" }),
        new UserMessage({ content: userPrompt, source: "user" })
      ];

      const result = await this.client.create(messages, { outputFormat: JUDGE_OUTPUT_FORMAT });

      const dimensions: Record<string, number> = {};
      const reasoning: Record<string, string> = {};

      const parsed = this.parseJudgeResponse(result.structuredOutput, result.message.content);
      if (parsed) {
        for (const s of parsed.scores) {
          dimensions[s.name] = s.score;
          reasoning[s.name] = s.reasoning;
        }
      }

      // Fill missing criteria with defaults.
      for (const criterion of evalCriteria) {
        if (!(criterion in dimensions)) dimensions[criterion] = 5.0;
        if (!(criterion in reasoning)) reasoning[criterion] = "No reasoning provided";
      }

      const dimScores = Object.values(dimensions);
      const overall = dimScores.length ? dimScores.reduce((a, b) => a + b, 0) / dimScores.length : 0.0;

      return new EvalScore({
        overall,
        dimensions,
        reasoning,
        trajectory,
        metadata: {
          judgeName: this.name,
          model: result.model,
          criteriaUsed: evalCriteria,
          rawResponse: result.message.content
        }
      });
    } catch (e) {
      const dimensions: Record<string, number> = {};
      const reasoning: Record<string, string> = {};
      for (const dim of evalCriteria) {
        dimensions[dim] = 5.0;
        reasoning[dim] = `Judge error: ${e instanceof Error ? e.message : String(e)}`;
      }
      return new EvalScore({
        overall: 5.0,
        dimensions,
        reasoning,
        trajectory,
        metadata: {
          judgeName: this.name,
          error: e instanceof Error ? e.message : String(e),
          criteriaUsed: evalCriteria
        }
      });
    }
  }

  /**
   * Parse a JudgeResponse from the structured output (preferred) or from the raw
   * message content. Tolerates fenced ```json blocks and embedded JSON objects.
   */
  private parseJudgeResponse(structuredOutput: unknown, content: string): JudgeResponse | undefined {
    const fromObject = (obj: unknown): JudgeResponse | undefined => {
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        if (Array.isArray(o.scores)) {
          return {
            scores: (o.scores as Array<Record<string, unknown>>).map((s) => ({
              name: String(s.name ?? ""),
              score: typeof s.score === "number" ? s.score : Number(s.score ?? 0),
              reasoning: String(s.reasoning ?? "")
            }))
          };
        }
        // Fallback shape: {dimensions: {...}, reasoning: {...}}
        if (o.dimensions && typeof o.dimensions === "object") {
          const dims = o.dimensions as Record<string, unknown>;
          const reas = (o.reasoning as Record<string, unknown>) ?? {};
          return {
            scores: Object.entries(dims).map(([name, value]) => ({
              name,
              score: typeof value === "number" ? value : Number(value ?? 0),
              reasoning: String(reas[name] ?? "")
            }))
          };
        }
      }
      return undefined;
    };

    const fromStructured = fromObject(structuredOutput);
    if (fromStructured) return fromStructured;

    const text = (content ?? "").trim();
    if (!text) return undefined;

    // Strip a fenced ```json ... ``` block if present.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1]!.trim() : text;

    try {
      return fromObject(JSON.parse(candidate));
    } catch {
      // Find the first {...} object in the text.
      const match = candidate.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return fromObject(JSON.parse(match[0]));
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }

  private buildSystemPrompt(criteria: string[], rubric?: Record<string, string>): string {
    const defaultDescriptions: Record<string, string> = {
      accuracy: "How factually correct and truthful is the response?",
      completeness: "How thoroughly does the response address the task?",
      helpfulness: "How useful and actionable is the response?",
      clarity: "How clear and well-structured is the response?",
      creativity: "How creative and original is the response?",
      safety: "How safe and appropriate is the response?"
    };

    const criteriaDetails: string[] = [];
    for (const criterion of criteria) {
      const description =
        rubric && criterion in rubric
          ? rubric[criterion]!
          : defaultDescriptions[criterion] ?? `Quality of ${criterion}`;
      criteriaDetails.push(`- ${criterion}: ${description}`);
    }

    let basePrompt = `You are an expert evaluation judge. Your task is to score AI agent conversations based on specific criteria.

Evaluation Criteria (each scored 0-10):
${criteriaDetails.join("\n")}

Instructions:
1. Analyze the task, expected output (if provided), and the complete agent conversation
2. Consider both the final outcome AND the process (reasoning, communication, error handling)
3. Score each criterion from 0-10 (0=poor, 5=average, 10=excellent)
4. Provide brief reasoning for each score
5. Return one score entry per criterion listed above, using the exact criterion name`;

    if (this.customInstructions) {
      basePrompt += `\n\nAdditional Evaluation Guidance:\n${this.customInstructions}`;
    }

    return basePrompt;
  }

  private buildUserPrompt(trajectory: RunTrajectory): string {
    let taskInfo = `Task: ${trajectory.task.name}\nInput: ${trajectory.task.input}`;
    if (trajectory.task.expectedOutput) {
      taskInfo += `\nExpected Output: ${trajectory.task.expectedOutput}`;
    }

    let actualOutput: string;
    let conversationSummary: string;
    if (trajectory.success && trajectory.messages.length) {
      actualOutput = trajectory.messages.map((msg) => this.formatMessage(msg)).join("\n\n");
      conversationSummary = `Messages exchanged: ${trajectory.messages.length}`;
      if (trajectory.usage) {
        conversationSummary += `, Tokens: ${trajectory.usage.tokensInput + trajectory.usage.tokensOutput}`;
      }
    } else {
      actualOutput = `EXECUTION FAILED: ${trajectory.error ?? "Unknown error"}`;
      conversationSummary = "No successful execution";
    }

    return `${taskInfo}

Execution Summary: ${conversationSummary}
Success: ${trajectory.success}

Complete Agent Conversation:
${actualOutput}

Please evaluate this complete conversation according to the specified criteria.`;
  }

  private formatMessage(msg: Message): string {
    const role = msg.role;
    const source = msg.source ?? "";
    const content = msg.content ?? "";

    if (role === "system") return `[SYSTEM (${source})]\n${content}`;
    if (role === "user") return `[USER (${source})]\n${content}`;

    if (role === "assistant") {
      const parts = [`[ASSISTANT (${source})]`];
      if (content) parts.push(content);
      const toolCalls = (msg as AssistantMessage).toolCalls;
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          const paramStrs: string[] = [];
          for (const [k, v] of Object.entries(tc.parameters)) {
            let vStr = String(v);
            if (vStr.length > 200) vStr = `${vStr.slice(0, 200)}...`;
            paramStrs.push(`  ${k}: ${vStr}`);
          }
          parts.push(`[TOOL CALL: ${tc.toolName}]\n${paramStrs.join("\n")}`);
        }
      }
      return parts.join("\n");
    }

    if (role === "tool") {
      const tm = msg as import("../messages.js").ToolMessage;
      const toolName = tm.toolName ?? "unknown";
      const status = tm.success ? "SUCCESS" : "FAILED";
      let header = `[TOOL RESULT (${toolName}) - ${status}]`;
      if (tm.error) header += `\nError: ${tm.error}`;
      let displayContent = content;
      if (displayContent.length > 2000) displayContent = `${displayContent.slice(0, 2000)}\n... (truncated)`;
      return `${header}\n${displayContent}`;
    }

    return `[${String(role).toUpperCase()} (${source})]\n${content}`;
  }
}

export interface ExactMatchJudgeOptions {
  name?: string;
  caseSensitive?: boolean;
  stripWhitespace?: boolean;
  answerStrategy?: AnswerStrategy;
}

/** Reference-based judge using exact string matching. */
export class ExactMatchJudge extends BaseEvalJudge {
  caseSensitive: boolean;
  stripWhitespace: boolean;

  constructor(options: ExactMatchJudgeOptions = {}) {
    super(options.name ?? "ExactMatch", options.answerStrategy ?? "last_non_empty");
    this.caseSensitive = options.caseSensitive ?? false;
    this.stripWhitespace = options.stripWhitespace ?? true;
  }

  async score(trajectory: RunTrajectory): Promise<EvalScore> {
    if (!trajectory.task.expectedOutput) {
      throw new Error(
        `ExactMatchJudge requires tasks with expectedOutput. ` +
          `Task '${trajectory.task.name}' has no expectedOutput.`
      );
    }

    if (!trajectory.success || !trajectory.messages.length) {
      return failedScore(this.name, trajectory, { match: false });
    }

    let actual = this.extractAnswer(trajectory);
    let expected = trajectory.task.expectedOutput;

    if (this.stripWhitespace) {
      actual = actual.trim();
      expected = expected.trim();
    }
    if (!this.caseSensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }

    const isMatch = actual === expected;
    const score = isMatch ? 10.0 : 0.0;
    const reasoning =
      `Expected: '${trajectory.task.expectedOutput}'\n` +
      `Got: '${actual}'\n` +
      `Match: ${isMatch}\n` +
      `Extraction strategy: ${this.answerStrategy}`;

    return new EvalScore({
      overall: score,
      dimensions: { accuracy: score },
      reasoning: { accuracy: reasoning },
      trajectory,
      metadata: {
        judge: this.name,
        match: isMatch,
        caseSensitive: this.caseSensitive,
        stripWhitespace: this.stripWhitespace,
        answerStrategy: this.answerStrategy
      }
    });
  }
}

export interface FuzzyMatchJudgeOptions {
  name?: string;
  threshold?: number;
  caseSensitive?: boolean;
  answerStrategy?: AnswerStrategy;
}

/** Reference-based judge using fuzzy string matching. */
export class FuzzyMatchJudge extends BaseEvalJudge {
  threshold: number;
  caseSensitive: boolean;

  constructor(options: FuzzyMatchJudgeOptions = {}) {
    super(options.name ?? "FuzzyMatch", options.answerStrategy ?? "last_non_empty");
    const threshold = options.threshold ?? 0.8;
    if (threshold < 0 || threshold > 1) {
      throw new Error(`Threshold must be between 0 and 1, got ${threshold}`);
    }
    this.threshold = threshold;
    this.caseSensitive = options.caseSensitive ?? false;
  }

  async score(trajectory: RunTrajectory): Promise<EvalScore> {
    if (!trajectory.task.expectedOutput) {
      throw new Error(
        `FuzzyMatchJudge requires tasks with expectedOutput. ` +
          `Task '${trajectory.task.name}' has no expectedOutput.`
      );
    }

    if (!trajectory.success || !trajectory.messages.length) {
      return failedScore(this.name, trajectory, { similarity: 0.0 });
    }

    let actual = this.extractAnswer(trajectory);
    let expected = trajectory.task.expectedOutput.trim();

    if (!this.caseSensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }

    const similarity = sequenceMatcherRatio(actual, expected);
    let score = similarity <= this.threshold ? (similarity / this.threshold) * 10.0 : 10.0;
    score = Math.min(score, 10.0);

    const reasoning =
      `Expected: '${trajectory.task.expectedOutput}'\n` +
      `Got: '${actual}'\n` +
      `Similarity: ${(similarity * 100).toFixed(0)}% (threshold: ${(this.threshold * 100).toFixed(0)}%)\n` +
      `Extraction strategy: ${this.answerStrategy}`;

    return new EvalScore({
      overall: score,
      dimensions: { accuracy: score },
      reasoning: { accuracy: reasoning },
      trajectory,
      metadata: {
        judge: this.name,
        similarity,
        threshold: this.threshold,
        caseSensitive: this.caseSensitive,
        answerStrategy: this.answerStrategy
      }
    });
  }
}

export interface ContainsJudgeOptions {
  name?: string;
  caseSensitive?: boolean;
  answerStrategy?: AnswerStrategy;
}

/** Reference-based judge that checks if the expected output is contained in the response. */
export class ContainsJudge extends BaseEvalJudge {
  caseSensitive: boolean;

  constructor(options: ContainsJudgeOptions = {}) {
    super(options.name ?? "Contains", options.answerStrategy ?? "last_non_empty");
    this.caseSensitive = options.caseSensitive ?? false;
  }

  async score(trajectory: RunTrajectory): Promise<EvalScore> {
    if (!trajectory.task.expectedOutput) {
      throw new Error(
        `ContainsJudge requires tasks with expectedOutput. ` +
          `Task '${trajectory.task.name}' has no expectedOutput.`
      );
    }

    if (!trajectory.success || !trajectory.messages.length) {
      return failedScore(this.name, trajectory, { contains: false });
    }

    let actual = this.extractAnswer(trajectory);
    let expected = trajectory.task.expectedOutput;

    if (!this.caseSensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }

    const contains = actual.includes(expected);
    const score = contains ? 10.0 : 0.0;
    const reasoning =
      `Expected substring: '${trajectory.task.expectedOutput}'\n` +
      `Agent response: '${actual}'\n` +
      `Contains expected: ${contains}\n` +
      `Extraction strategy: ${this.answerStrategy}`;

    return new EvalScore({
      overall: score,
      dimensions: { accuracy: score },
      reasoning: { accuracy: reasoning },
      trajectory,
      metadata: {
        judge: this.name,
        contains,
        caseSensitive: this.caseSensitive,
        answerStrategy: this.answerStrategy
      }
    });
  }
}

export interface CompositeJudgeOptions {
  name?: string;
  normalizeWeights?: boolean;
  answerStrategy?: AnswerStrategy;
}

/** Combines multiple judges with weighted scores, running them in parallel. */
export class CompositeJudge extends BaseEvalJudge {
  judges: Array<[BaseEvalJudge, number]>;

  constructor(judges: Array<[BaseEvalJudge, number]>, options: CompositeJudgeOptions = {}) {
    super(options.name ?? "Composite", options.answerStrategy ?? "last_non_empty");

    if (!judges.length) {
      throw new Error("CompositeJudge requires at least one judge");
    }

    const totalWeight = judges.reduce((sum, [, w]) => sum + w, 0);
    if (totalWeight <= 0) {
      throw new Error(`Total weight must be positive, got ${totalWeight}`);
    }

    const normalize = options.normalizeWeights ?? true;
    if (normalize) {
      this.judges = judges.map(([judge, weight]) => [judge, weight / totalWeight]);
    } else {
      if (Math.abs(totalWeight - 1.0) > 0.01) {
        throw new Error(`Weights must sum to 1.0 when normalizeWeights=false, got ${totalWeight}`);
      }
      this.judges = judges;
    }
  }

  async score(
    trajectory: RunTrajectory,
    criteria?: string[],
    cancellationToken?: CancellationToken
  ): Promise<EvalScore> {
    const scores = await Promise.all(
      this.judges.map(([judge]) => judge.score(trajectory, criteria, cancellationToken))
    );

    let overall = 0;
    for (let i = 0; i < scores.length; i += 1) {
      overall += scores[i]!.overall * this.judges[i]![1];
    }

    // dim -> [(value, weight), ...]
    const dimensionContributions: Record<string, Array<[number, number]>> = {};
    for (let i = 0; i < scores.length; i += 1) {
      const weight = this.judges[i]![1];
      for (const [dim, val] of Object.entries(scores[i]!.dimensions)) {
        (dimensionContributions[dim] ??= []).push([val, weight]);
      }
    }

    const dimensions: Record<string, number> = {};
    for (const [dim, contributions] of Object.entries(dimensionContributions)) {
      const totalWeightForDim = contributions.reduce((sum, [, w]) => sum + w, 0);
      if (totalWeightForDim > 0) {
        dimensions[dim] = contributions.reduce(
          (sum, [val, weight]) => sum + val * (weight / totalWeightForDim),
          0
        );
      } else {
        dimensions[dim] = contributions.reduce((sum, [val]) => sum + val, 0) / contributions.length;
      }
    }

    const reasoning: Record<string, string> = {};
    for (let i = 0; i < scores.length; i += 1) {
      const [judge, weight] = this.judges[i]!;
      for (const [dim, reason] of Object.entries(scores[i]!.reasoning)) {
        reasoning[`${dim} (${judge.name})`] = `[weight: ${weight.toFixed(2)}] ${reason}`;
      }
    }

    const metadata = {
      judge: this.name,
      subJudges: this.judges.map(([judge, weight], i) => ({
        name: judge.name,
        weight,
        score: scores[i]!.overall
      }))
    };

    return new EvalScore({ overall, dimensions, reasoning, trajectory, metadata });
  }
}

function failedScore(
  judgeName: string,
  trajectory: RunTrajectory,
  extraMetadata: Record<string, unknown>
): EvalScore {
  return new EvalScore({
    overall: 0.0,
    dimensions: { accuracy: 0.0 },
    reasoning: {
      accuracy: `Execution failed: ${trajectory.error ?? "No messages generated"}`
    },
    trajectory,
    metadata: { judge: judgeName, error: trajectory.error, ...extraMetadata }
  });
}

/**
 * Compute a similarity ratio in [0, 1] equivalent to Python's
 * `difflib.SequenceMatcher.ratio()`: 2 * M / T where M is the total number of
 * matched characters and T is the total length of both strings.
 */
function sequenceMatcherRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  const matches = matchingBlocksLength(a, b);
  return (2.0 * matches) / total;
}

/** Total length of matching blocks, mirroring SequenceMatcher's recursive LCS-ish algorithm. */
function matchingBlocksLength(a: string, b: string): number {
  // Recursive longest-matching-block decomposition (matches difflib semantics).
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  let total = 0;
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi);
    if (k > 0) {
      total += k;
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) stack.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}

function findLongestMatch(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number
): [number, number, number] {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len: Record<number, number> = {};
  for (let i = alo; i < ahi; i += 1) {
    const newj2len: Record<number, number> = {};
    for (let j = blo; j < bhi; j += 1) {
      if (a[i] === b[j]) {
        const k = (j > 0 ? j2len[j - 1] ?? 0 : 0) + 1;
        newj2len[j] = k;
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}
