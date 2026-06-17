import { CancellationToken } from "../cancellation.js";
import { dumpComponent, loadComponent, registerComponent } from "../componentConfig.js";
import type { ComponentModel, ComponentType } from "../componentConfig.js";
import { AssistantMessage, Message, ToolMessage } from "../messages.js";
import { StopMessage } from "../types.js";

export abstract class BaseTermination {
  protected met = false;
  protected reason = "";
  protected metadata: Record<string, unknown> = {};

  abstract check(newMessages: Message[]): StopMessage | undefined;

  isMet(): boolean {
    return this.met;
  }

  reset(): void {
    this.met = false;
    this.reason = "";
    this.metadata = {};
  }

  getReason(): string {
    return this.reason;
  }

  getMetadata(): Record<string, unknown> {
    return { ...this.metadata };
  }

  or(other: BaseTermination): CompositeTermination {
    return new CompositeTermination([this, other], "any");
  }

  and(other: BaseTermination): CompositeTermination {
    return new CompositeTermination([this, other], "all");
  }

  protected setTermination(reason: string, metadata: Record<string, unknown> = {}): StopMessage {
    this.met = true;
    this.reason = reason;
    this.metadata = metadata;
    return new StopMessage({
      content: reason,
      source: this.constructor.name,
      metadata
    });
  }
}

export class MaxMessageTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.MaxMessageTermination";
  static componentVersion = 1;

  maxMessages: number;
  messageCount = 0;

  constructor(maxMessages: number) {
    super();
    this.maxMessages = maxMessages;
  }

  static fromConfig(config: Record<string, unknown> = {}): MaxMessageTermination {
    return new MaxMessageTermination(Number(config.maxMessages ?? config.max_messages ?? 1));
  }

  toConfig(): Record<string, unknown> {
    return { maxMessages: this.maxMessages };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    this.messageCount += newMessages.length;
    if (this.messageCount >= this.maxMessages) {
      return this.setTermination(
        `Maximum messages reached (${this.messageCount}/${this.maxMessages})`,
        {
          messageCount: this.messageCount,
          maxMessages: this.maxMessages
        }
      );
    }
    return undefined;
  }

  override reset(): void {
    super.reset();
    this.messageCount = 0;
  }
}

export class TextMentionTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.TextMentionTermination";
  static componentVersion = 1;

  text: string;
  caseSensitive: boolean;
  private searchText: string;

  constructor(text: string, caseSensitive = false) {
    super();
    this.text = text;
    this.caseSensitive = caseSensitive;
    this.searchText = caseSensitive ? text : text.toLowerCase();
  }

  static fromConfig(config: Record<string, unknown> = {}): TextMentionTermination {
    return new TextMentionTermination(
      String(config.text ?? ""),
      Boolean(config.caseSensitive ?? config.case_sensitive ?? false)
    );
  }

  toConfig(): Record<string, unknown> {
    return { text: this.text, caseSensitive: this.caseSensitive };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    for (const message of newMessages) {
      const content = this.caseSensitive ? message.content : message.content.toLowerCase();
      if (content.includes(this.searchText)) {
        return this.setTermination(`Text mention found: '${this.text}'`, {
          text: this.text,
          caseSensitive: this.caseSensitive,
          foundIn: message.constructor.name
        });
      }
    }
    return undefined;
  }
}

export class TokenUsageTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.TokenUsageTermination";
  static componentVersion = 1;

  maxTokens: number;
  totalTokens = 0;

  constructor(maxTokens: number) {
    super();
    this.maxTokens = maxTokens;
  }

  static fromConfig(config: Record<string, unknown> = {}): TokenUsageTermination {
    return new TokenUsageTermination(Number(config.maxTokens ?? config.max_tokens ?? 1));
  }

  toConfig(): Record<string, unknown> {
    return { maxTokens: this.maxTokens };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    const newTokens = newMessages.reduce((sum, message) => sum + Math.floor(message.content.length / 4), 0);
    this.totalTokens += newTokens;
    if (this.totalTokens >= this.maxTokens) {
      return this.setTermination(`Token limit exceeded (${this.totalTokens}/${this.maxTokens})`, {
        totalTokens: this.totalTokens,
        maxTokens: this.maxTokens
      });
    }
    return undefined;
  }

  override reset(): void {
    super.reset();
    this.totalTokens = 0;
  }
}

export class TimeoutTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.TimeoutTermination";
  static componentVersion = 1;

  maxDurationSeconds: number;
  startTime: number;

  constructor(maxDurationSeconds: number) {
    super();
    this.maxDurationSeconds = maxDurationSeconds;
    this.startTime = Date.now();
  }

  static fromConfig(config: Record<string, unknown> = {}): TimeoutTermination {
    return new TimeoutTermination(Number(config.maxDurationSeconds ?? config.max_duration_seconds ?? 1));
  }

  toConfig(): Record<string, unknown> {
    return { maxDurationSeconds: this.maxDurationSeconds };
  }

  check(_newMessages: Message[]): StopMessage | undefined {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    if (elapsedSeconds >= this.maxDurationSeconds) {
      return this.setTermination(
        `Timeout reached (${elapsedSeconds.toFixed(1)}s/${this.maxDurationSeconds}s)`,
        {
          elapsedSeconds,
          maxDurationSeconds: this.maxDurationSeconds
        }
      );
    }
    return undefined;
  }

  override reset(): void {
    super.reset();
    this.startTime = Date.now();
  }
}

export class HandoffTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.HandoffTermination";
  static componentVersion = 1;

  target: string;

  constructor(target: string) {
    super();
    this.target = target;
  }

  static fromConfig(config: Record<string, unknown> = {}): HandoffTermination {
    return new HandoffTermination(String(config.target ?? ""));
  }

  toConfig(): Record<string, unknown> {
    return { target: this.target };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    for (const message of newMessages) {
      if (!(message instanceof AssistantMessage)) continue;
      const content = message.content.toLowerCase();
      const target = this.target.toLowerCase();
      const patterns = [
        `handoff to ${target}`,
        `transfer to ${target}`,
        `pass to ${target}`,
        `delegate to ${target}`
      ];
      const pattern = patterns.find((item) => content.includes(item));
      if (pattern) {
        return this.setTermination(`Handoff requested to '${this.target}'`, {
          target: this.target,
          pattern
        });
      }
    }
    return undefined;
  }
}

export class FunctionCallTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.FunctionCallTermination";
  static componentVersion = 1;

  functionName: string;

  constructor(functionName: string) {
    super();
    this.functionName = functionName;
  }

  static fromConfig(config: Record<string, unknown> = {}): FunctionCallTermination {
    return new FunctionCallTermination(String(config.functionName ?? config.function_name ?? ""));
  }

  toConfig(): Record<string, unknown> {
    return { functionName: this.functionName };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    for (const message of newMessages) {
      if (message instanceof ToolMessage && message.toolName === this.functionName) {
        return this.setTermination(`Function '${this.functionName}' was called`, {
          functionName: this.functionName,
          success: message.success
        });
      }
    }
    return undefined;
  }
}

export class ExternalTermination extends BaseTermination {
  checkCallback: () => boolean;

  constructor(checkCallback: () => boolean) {
    super();
    this.checkCallback = checkCallback;
  }

  check(_newMessages: Message[]): StopMessage | undefined {
    try {
      if (this.checkCallback()) {
        return this.setTermination("External termination signal received", {
          source: "external_callback"
        });
      }
    } catch {
      // Callback errors do not terminate orchestration.
    }
    return undefined;
  }
}

export class CancellationTermination extends BaseTermination {
  cancellationToken: CancellationToken;

  constructor(cancellationToken: CancellationToken) {
    super();
    this.cancellationToken = cancellationToken;
  }

  check(_newMessages: Message[]): StopMessage | undefined {
    if (this.cancellationToken.isCancelled()) {
      return this.setTermination("Cancellation token triggered", {
        source: "cancellation_token"
      });
    }
    return undefined;
  }
}

export class CompositeTermination extends BaseTermination {
  static componentType: ComponentType = "termination";
  static componentProvider = "picoagents.termination.CompositeTermination";
  static componentVersion = 1;

  conditions: BaseTermination[];
  mode: "any" | "all";

  constructor(conditions: BaseTermination[], mode: "any" | "all" = "any") {
    super();
    this.conditions = conditions;
    this.mode = mode;
  }

  static fromConfig(config: Record<string, unknown> = {}): CompositeTermination {
    const conditions = Array.isArray(config.conditions)
      ? config.conditions.map((condition) => loadComponent(condition as ComponentModel) as unknown as BaseTermination)
      : [];
    const mode = config.mode === "all" ? "all" : "any";
    return new CompositeTermination(conditions, mode);
  }

  toConfig(): Record<string, unknown> {
    return {
      conditions: this.conditions.map((condition) => dumpComponent(condition as unknown as { toConfig(): Record<string, unknown> })),
      mode: this.mode
    };
  }

  check(newMessages: Message[]): StopMessage | undefined {
    const results = this.conditions
      .map((condition) => condition.check(newMessages))
      .filter((result): result is StopMessage => Boolean(result));

    if (this.mode === "any" && results.length > 0) {
      const first = results[0]!;
      return this.setTermination(`Composite (any): ${first.content}`, {
        mode: "any",
        triggeredConditions: results.map((result) => result.source)
      });
    }

    if (this.mode === "all" && results.length === this.conditions.length) {
      return this.setTermination(
        `Composite (all): ${results.map((result) => result.content).join("; ")}`,
        {
          mode: "all",
          triggeredConditions: results.map((result) => result.source)
        }
      );
    }
    return undefined;
  }

  override reset(): void {
    super.reset();
    for (const condition of this.conditions) condition.reset();
  }

  override isMet(): boolean {
    const values = this.conditions.map((condition) => condition.isMet());
    return this.mode === "any" ? values.some(Boolean) : values.every(Boolean);
  }

  override or(other: BaseTermination): CompositeTermination {
    if (other instanceof CompositeTermination && other.mode === "any") {
      return new CompositeTermination([...this.conditions, ...other.conditions], "any");
    }
    return new CompositeTermination([...this.conditions, other], "any");
  }

  override and(other: BaseTermination): CompositeTermination {
    if (other instanceof CompositeTermination && other.mode === "all") {
      return new CompositeTermination([...this.conditions, ...other.conditions], "all");
    }
    return new CompositeTermination([...this.conditions, other], "all");
  }
}

registerComponent(MaxMessageTermination as any);
registerComponent(TextMentionTermination as any);
registerComponent(TokenUsageTermination as any);
registerComponent(TimeoutTermination as any);
registerComponent(HandoffTermination as any);
registerComponent(FunctionCallTermination as any);
registerComponent(CompositeTermination as any);
