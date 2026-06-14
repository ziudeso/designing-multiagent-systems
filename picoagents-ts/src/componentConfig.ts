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
}

const REGISTRY = new Map<string, ComponentClass>();

/** Aliases that map short/legacy provider names to canonical providers. */
export const WELL_KNOWN_PROVIDERS: Record<string, string> = {
  openai_chat_completion_client: "picoagents.llm.OpenAIChatCompletionClient",
  OpenAIChatCompletionClient: "picoagents.llm.OpenAIChatCompletionClient",
  model_client: "picoagents.llm.OpenAIChatCompletionClient",
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
  termination: "picoagents.termination.MaxMessageTermination",
  workflow: "picoagents.workflow.Workflow",
  Workflow: "picoagents.workflow.Workflow"
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
  model: ComponentModel | Record<string, unknown>
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
  return cls.fromConfig(m.config ?? {}) as T;
}
