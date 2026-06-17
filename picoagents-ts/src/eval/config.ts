/**
 * Agent configuration for evaluation.
 *
 * Defines AgentConfig - a complete specification of how to set up an agent for
 * evaluation comparison (model, compaction strategy, system prompt, tools, ...).
 * Ported from Python `eval/_config.py`.
 *
 */

import { Agent } from "../agents/agent.js";
import { BaseMiddleware } from "../middleware.js";
import {
  CompactionStrategy,
  HeadTailCompaction,
  NoCompaction,
  SlidingWindowCompaction
} from "../compaction.js";
import { registerComponent } from "../componentConfig.js";
import type { SerializableComponent } from "../componentConfig.js";
import { getInstructions } from "../instructions.js";
import {
  AnthropicChatCompletionClient,
  AzureOpenAIChatCompletionClient,
  BaseChatCompletionClient,
  OpenAIChatCompletionClient
} from "../llm/index.js";
import { BaseTool, createCodingTools, createCoreTools } from "../tools/index.js";

export interface AgentConfigInit {
  /** Unique identifier for this configuration. */
  name: string;
  /** Model provider: "openai", "azure", "anthropic" (default: "openai"). */
  modelProvider?: string;
  /** Model name (default: "gpt-4o-mini"). */
  modelName?: string;
  /** Compaction strategy: undefined/null, "head_tail", "sliding". */
  compaction?: string | null;
  /** Maximum tokens for context (default: 50,000). */
  tokenBudget?: number;
  /** Fraction of budget for head messages in head_tail (default: 0.3). */
  headRatio?: number;
  /** System prompt (default: "You are a helpful assistant."). */
  systemPrompt?: string;
  /** Instruction preset used to build system instructions. */
  instructionPreset?: string;
  /** Tool categories to include (default: ["coding"]). */
  tools?: string[];
  /** Maximum agent iterations (default: 30). */
  maxIterations?: number;
  /** Sampling temperature (default: 0.0). */
  temperature?: number;
  /** Root directory for file tools. */
  workspace?: string;
  /** Bash command timeout in seconds (default: 300). */
  bashTimeout?: number;
  /** Custom tool instances (overrides tool categories when set). */
  toolInstances?: BaseTool[];
  /** Additional kwargs passed to the agent constructor. */
  extraKwargs?: Record<string, unknown>;
}

/**
 * Complete agent configuration for evaluation.
 *
 * Specifies all the knobs that can be tuned when comparing agent performance:
 * model, compaction strategy, system prompt, tools, etc.
 */
export class AgentConfig implements SerializableComponent {
  static componentType = "agent" as const;
  static componentProvider = "picoagents.eval.AgentConfig";
  static componentVersion = 1;

  name: string;
  modelProvider: string;
  modelName: string;
  compaction?: string | null;
  tokenBudget: number;
  headRatio: number;
  systemPrompt: string;
  instructionPreset?: string;
  tools: string[];
  maxIterations: number;
  temperature: number;
  workspace?: string;
  bashTimeout: number;
  toolInstances?: BaseTool[];
  extraKwargs: Record<string, unknown>;

  constructor(init: AgentConfigInit) {
    this.name = init.name;
    this.modelProvider = init.modelProvider ?? "openai";
    this.modelName = init.modelName ?? "gpt-4o-mini";
    this.compaction = init.compaction ?? null;
    this.tokenBudget = init.tokenBudget ?? 50_000;
    this.headRatio = init.headRatio ?? 0.3;
    this.systemPrompt = init.systemPrompt ?? "You are a helpful assistant.";
    this.instructionPreset = init.instructionPreset;
    this.tools = init.tools ?? ["coding"];
    this.maxIterations = init.maxIterations ?? 30;
    this.temperature = init.temperature ?? 0.0;
    this.workspace = init.workspace;
    this.bashTimeout = init.bashTimeout ?? 300;
    this.toolInstances = init.toolInstances;
    this.extraKwargs = init.extraKwargs ?? {};
  }

  /** Serialize configuration to a plain object. */
  toConfig(): Record<string, unknown> {
    return {
      name: this.name,
      modelProvider: this.modelProvider,
      modelName: this.modelName,
      compaction: this.compaction,
      tokenBudget: this.tokenBudget,
      headRatio: this.headRatio,
      systemPrompt: this.systemPrompt,
      instructionPreset: this.instructionPreset,
      tools: this.tools,
      maxIterations: this.maxIterations,
      temperature: this.temperature,
      workspace: this.workspace,
      bashTimeout: this.bashTimeout,
      extraKwargs: this.extraKwargs
    };
  }

  static fromConfig(config: Record<string, unknown>): AgentConfig {
    return new AgentConfig({
      name: String(config.name ?? ""),
      modelProvider: stringValue(config.modelProvider ?? config.model_provider ?? config.provider),
      modelName: stringValue(config.modelName ?? config.model_name ?? config.model),
      compaction: nullableString(config.compaction ?? config.strategy),
      tokenBudget: numberValue(config.tokenBudget ?? config.token_budget),
      headRatio: numberValue(config.headRatio ?? config.head_ratio),
      systemPrompt: stringValue(config.systemPrompt ?? config.system_prompt ?? config.instructions),
      instructionPreset: stringValue(config.instructionPreset ?? config.instruction_preset),
      tools: config.tools as string[] | undefined,
      maxIterations: numberValue(config.maxIterations ?? config.max_iterations),
      temperature: numberValue(config.temperature),
      workspace: stringValue(config.workspace),
      bashTimeout: numberValue(config.bashTimeout ?? config.bash_timeout),
      extraKwargs: asRecord(config.extraKwargs ?? config.extra_kwargs)
    });
  }

  /**
   * Parse configuration from a CLI-style string.
   *
   * Format: `name:key=value,key=value,...`
   */
  static fromString(configStr: string): AgentConfig {
    if (!configStr.includes(":")) {
      return new AgentConfig({ name: configStr });
    }

    const colon = configStr.indexOf(":");
    const name = configStr.slice(0, colon);
    const paramsStr = configStr.slice(colon + 1);
    const params: AgentConfigInit = { name };

    for (const param of paramsStr.split(",")) {
      if (!param.includes("=")) continue;
      const eq = param.indexOf("=");
      const key = param.slice(0, eq).trim();
      const value = param.slice(eq + 1).trim();

      if (key === "token_budget" || key === "tokenBudget") {
        params.tokenBudget = parseInt(value, 10);
      } else if (key === "max_iterations" || key === "maxIterations") {
        params.maxIterations = parseInt(value, 10);
      } else if (key === "bash_timeout" || key === "bashTimeout") {
        params.bashTimeout = parseInt(value, 10);
      } else if (key === "temperature") {
        params.temperature = parseFloat(value);
      } else if (key === "head_ratio" || key === "headRatio") {
        params.headRatio = parseFloat(value);
      } else if (key === "tools") {
        params.tools = value.split("+");
      } else if (key === "strategy") {
        params.compaction = value !== "none" ? value : null;
      } else if (key === "model") {
        params.modelName = value;
      } else if (key === "provider") {
        params.modelProvider = value;
      } else {
        // Unknown keys are assigned by name.
        (params as unknown as Record<string, unknown>)[key] = value;
      }
    }

    return new AgentConfig(params);
  }

  /** Create the appropriate model client based on the provider. */
  createModelClient(): BaseChatCompletionClient {
    if (this.modelProvider === "openai") {
      return new OpenAIChatCompletionClient({ model: this.modelName });
    }
    if (this.modelProvider === "azure") {
      return new AzureOpenAIChatCompletionClient({
        azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
        azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? this.modelName,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
        ...(this.temperature > 0 ? { temperature: this.temperature } : {})
      });
    }
    if (this.modelProvider === "anthropic") {
      return new AnthropicChatCompletionClient({
        model: this.modelName,
        apiKey: process.env.ANTHROPIC_API_KEY
      });
    }
    throw new Error(`Unknown model provider: ${this.modelProvider}`);
  }

  /** Create the compaction strategy based on configuration. */
  createCompaction(): CompactionStrategy {
    if (this.compaction === null || this.compaction === undefined || this.compaction === "none") {
      return new NoCompaction();
    }
    if (this.compaction === "head_tail") {
      return new HeadTailCompaction({
        tokenBudget: this.tokenBudget,
        headRatio: this.headRatio
      });
    }
    if (this.compaction === "sliding") {
      return new SlidingWindowCompaction({ tokenBudget: this.tokenBudget });
    }
    throw new Error(`Unknown compaction strategy: ${this.compaction}`);
  }

  /** Create tools based on configuration. */
  createTools(): BaseTool[] {
    if (this.toolInstances !== undefined) {
      return [...this.toolInstances];
    }

    const allTools: BaseTool[] = [];
    for (const toolCategory of this.tools) {
      if (toolCategory === "coding") {
        allTools.push(
          ...createCodingTools({
            workspace: this.workspace,
            bashTimeout: this.bashTimeout
          })
        );
      } else if (toolCategory === "core") {
        allTools.push(...createCoreTools());
      }
    }
    return allTools;
  }

  /**
   * Instantiate an Agent from this configuration.
   *
   * @param middlewares Optional list of middleware to add to the agent.
   */
  toAgent(middlewares?: BaseMiddleware[]): Agent {
    const modelClient = this.createModelClient();
    const compaction = this.createCompaction();
    const tools = this.createTools();

    const instructions = this.instructionPreset
      ? getInstructions(this.instructionPreset, tools.map((tool) => tool.name))
      : this.systemPrompt;

    return new Agent({
      name: this.name,
      description: `Eval agent: ${this.name}`,
      instructions,
      modelClient,
      tools,
      compaction,
      maxIterations: this.maxIterations,
      middlewares: middlewares ?? [],
      ...this.extraKwargs
    });
  }

  toString(): string {
    return (
      `AgentConfig(name=${JSON.stringify(this.name)}, ` +
      `model=${this.modelProvider}:${this.modelName}, ` +
      `strategy=${this.compaction}, budget=${this.tokenBudget})`
    );
  }
}

registerComponent(AgentConfig as any);

function stringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value);
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
