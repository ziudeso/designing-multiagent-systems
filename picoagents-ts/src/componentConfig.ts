/**
 * Component configuration / serialization system for picoagents-ts.
 *
 * Mirrors the Python `_component_config.py` design: components can be dumped to a
 * JSON-serializable `ComponentModel` and loaded back into instances. Because
 * TypeScript has no runtime module/class lookup by string, loading is backed by an
 * explicit registry that components populate via {@link registerComponent}.
 */

export type ComponentType =
  | "model"
  | "agent"
  | "tool"
  | "termination"
  | "orchestrator"
  | "step"
  | "workflow"
  | "memory"
  | (string & {});

/** Serializable description of a component, mirroring Python's `ComponentModel`. */
export interface ComponentModel {
  /** Provider string identifying the concrete class, e.g. "picoagents.agents.Agent". */
  provider: string;
  /** Logical type of the component. */
  componentType?: ComponentType;
  /** Version of the component specification schema. */
  version?: number;
  /** Version of the specific component implementation. */
  componentVersion?: number;
  /** Human-readable description. */
  description?: string;
  /** Display label (defaults to the class name). */
  label?: string;
  /** Configuration data passed to the class's `fromConfig`. */
  config: Record<string, unknown>;
}

export interface ComponentConfigSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string | string[]; required?: string[]; properties?: Record<string, unknown> }>;
}

export type ComponentConfigValidator =
  | ComponentConfigSchema
  | ((config: Record<string, unknown>) => Record<string, unknown>);

/**
 * Interface a class must satisfy to be a serializable component.
 *
 * Instances expose `toConfig()`; the constructor (static side) carries the
 * component metadata plus a `fromConfig` factory. See {@link ComponentClass}.
 */
export interface SerializableComponent {
  toConfig(): Record<string, unknown>;
}

/** Static side of a serializable component class. */
export interface ComponentClass<T extends SerializableComponent = SerializableComponent> {
  new (...args: any[]): T;
  /** Logical component type. */
  componentType: ComponentType;
  /** Provider string used as the registry key. */
  componentProvider: string;
  /** Implementation version (defaults to 1). */
  componentVersion?: number;
  /** Optional description; falls back to nothing. */
  componentDescription?: string;
  /** Optional display label; falls back to the class name. */
  componentLabel?: string;
  /** Build an instance from validated config. */
  fromConfig(config: any): T;
  /** Optional migration hook for configs written by older component versions. */
  fromConfigPastVersion?(config: Record<string, unknown>, version: number): T;
  _fromConfigPastVersion?(config: Record<string, unknown>, version: number): T;
  /** Optional lightweight schema/validator for config payloads. */
  componentConfigSchema?: ComponentConfigValidator;
}

const REGISTRY = new Map<string, ComponentClass>();

/** Aliases that map short/legacy provider names to canonical providers. */
export const WELL_KNOWN_PROVIDERS: Record<string, string> = {
  openai_chat_completion_client: "picoagents.llm.OpenAIChatCompletionClient",
  OpenAIChatCompletionClient: "picoagents.llm.OpenAIChatCompletionClient",
  model_client: "picoagents.llm.OpenAIChatCompletionClient",
  anthropic_chat_completion_client: "picoagents.llm.AnthropicChatCompletionClient",
  AnthropicChatCompletionClient: "picoagents.llm.AnthropicChatCompletionClient",
  azure_openai_chat_completion_client: "picoagents.llm.AzureOpenAIChatCompletionClient",
  AzureOpenAIChatCompletionClient: "picoagents.llm.AzureOpenAIChatCompletionClient",
  agent: "picoagents.agents.Agent",
  Agent: "picoagents.agents.Agent",
  list_memory: "picoagents.memory.ListMemory",
  ListMemory: "picoagents.memory.ListMemory",
  file_memory: "picoagents.memory.FileMemory",
  FileMemory: "picoagents.memory.FileMemory",
  memory: "picoagents.memory.ListMemory",
  max_message_termination: "picoagents.termination.MaxMessageTermination",
  MaxMessageTermination: "picoagents.termination.MaxMessageTermination",
  text_mention_termination: "picoagents.termination.TextMentionTermination",
  TextMentionTermination: "picoagents.termination.TextMentionTermination",
  composite_termination: "picoagents.termination.CompositeTermination",
  CompositeTermination: "picoagents.termination.CompositeTermination",
  token_usage_termination: "picoagents.termination.TokenUsageTermination",
  TokenUsageTermination: "picoagents.termination.TokenUsageTermination",
  timeout_termination: "picoagents.termination.TimeoutTermination",
  TimeoutTermination: "picoagents.termination.TimeoutTermination",
  handoff_termination: "picoagents.termination.HandoffTermination",
  HandoffTermination: "picoagents.termination.HandoffTermination",
  function_call_termination: "picoagents.termination.FunctionCallTermination",
  FunctionCallTermination: "picoagents.termination.FunctionCallTermination",
  termination: "picoagents.termination.MaxMessageTermination",
  round_robin_orchestrator: "picoagents.orchestration.RoundRobinOrchestrator",
  RoundRobinOrchestrator: "picoagents.orchestration.RoundRobinOrchestrator",
  ai_orchestrator: "picoagents.orchestration.AIOrchestrator",
  AIOrchestrator: "picoagents.orchestration.AIOrchestrator",
  plan_based_orchestrator: "picoagents.orchestration.PlanBasedOrchestrator",
  PlanBasedOrchestrator: "picoagents.orchestration.PlanBasedOrchestrator",
  handoff_orchestrator: "picoagents.orchestration.HandoffOrchestrator",
  HandoffOrchestrator: "picoagents.orchestration.HandoffOrchestrator",
  orchestrator: "picoagents.orchestration.RoundRobinOrchestrator",
  workflow: "picoagents.workflow.Workflow",
  Workflow: "picoagents.workflow.Workflow",
  echo_step: "picoagents.workflow.EchoStep",
  EchoStep: "picoagents.workflow.EchoStep",
  http_step: "picoagents.workflow.HttpStep",
  HttpStep: "picoagents.workflow.HttpStep",
  transform_step: "picoagents.workflow.TransformStep",
  TransformStep: "picoagents.workflow.TransformStep",
  picoagent_step: "picoagents.workflow.PicoAgentStep",
  PicoAgentStep: "picoagents.workflow.PicoAgentStep"
};

/** Register a component class so it can be loaded from a `ComponentModel`. */
export function registerComponent(cls: ComponentClass): void {
  REGISTRY.set(cls.componentProvider, cls);
}

/** Look up a registered component class by provider string. */
export function getRegisteredComponent(provider: string): ComponentClass | undefined {
  return REGISTRY.get(provider);
}

/**
 * Dump a component instance to a `ComponentModel`.
 *
 * The instance's constructor must carry the static component metadata
 * (`componentType`, `componentProvider`, ...) and the instance must implement
 * `toConfig()`.
 */
export function dumpComponent(instance: SerializableComponent): ComponentModel {
  const cls = instance.constructor as ComponentClass;
  if (!cls.componentProvider) {
    throw new TypeError(
      `Cannot dump component '${cls.name}': missing static componentProvider`
    );
  }
  if (!cls.componentType) {
    throw new TypeError(`Cannot dump component '${cls.name}': missing static componentType`);
  }
  return {
    provider: cls.componentProvider,
    componentType: cls.componentType,
    version: cls.componentVersion ?? 1,
    componentVersion: cls.componentVersion ?? 1,
    description: cls.componentDescription,
    label: cls.componentLabel ?? cls.name,
    config: instance.toConfig()
  };
}

/**
 * Load a component from a `ComponentModel` (or plain object).
 *
 * @throws if the provider is unknown or not registered.
 */
export function loadComponent<T extends SerializableComponent = SerializableComponent>(
  model: ComponentModel | Record<string, unknown>,
  expected?: new (...args: any[]) => T
): T {
  const m = model as ComponentModel;
  let provider = m.provider;
  if (!provider) {
    throw new Error("Invalid component model: missing provider");
  }
  const alias = WELL_KNOWN_PROVIDERS[provider];
  if (alias) {
    provider = alias;
  }
  const cls = REGISTRY.get(provider);
  if (!cls) {
    throw new Error(
      `Unknown component provider '${provider}'. Did you import/register the class?`
    );
  }
  const currentVersion = cls.componentVersion ?? 1;
  const loadedVersion = m.componentVersion ?? m.version ?? currentVersion;
  let instance: SerializableComponent;

  if (loadedVersion < currentVersion) {
    const migrate = cls.fromConfigPastVersion ?? cls._fromConfigPastVersion;
    if (!migrate) {
      throw new Error(
        `Tried to load component '${provider}' at version ${currentVersion} ` +
          `from config version ${loadedVersion}, but no migration hook is implemented`
      );
    }
    instance = migrate.call(cls, m.config ?? {}, loadedVersion);
  } else {
    const config = validateComponentConfig(m.config ?? {}, cls.componentConfigSchema);
    instance = cls.fromConfig(config);
  }

  if (expected && !(instance instanceof expected)) {
    throw new TypeError("Expected type does not match");
  }
  return instance as T;
}

function validateComponentConfig(
  config: Record<string, unknown>,
  schema?: ComponentConfigValidator
): Record<string, unknown> {
  if (!schema) return config;
  if (typeof schema === "function") return schema(config);
  if (schema.type && schema.type !== "object") {
    throw new Error(`Unsupported component config schema type: ${schema.type}`);
  }
  for (const field of schema.required ?? []) {
    if (!(field in config)) {
      throw new Error(`Invalid component config: missing required field '${field}'`);
    }
  }
  const properties = schema.properties ?? {};
  for (const [field, value] of Object.entries(config)) {
    const fieldSchema = properties[field];
    if (!fieldSchema?.type) continue;
    const expectedTypes = Array.isArray(fieldSchema.type) ? fieldSchema.type : [fieldSchema.type];
    if (!expectedTypes.some((expected) => checkConfigType(value, expected))) {
      throw new Error(`Invalid component config: field '${field}' expected ${expectedTypes.join(" | ")}`);
    }
  }
  return config;
}

function checkConfigType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
