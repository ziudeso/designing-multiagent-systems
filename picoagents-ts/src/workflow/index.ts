import { randomUUID } from "node:crypto";
import { Agent } from "../agents/index.js";
import { CancellationToken } from "../cancellation.js";
import {
  ComponentModel,
  dumpComponent,
  loadComponent,
  registerComponent
} from "../componentConfig.js";
import {
  CheckpointConfig,
  CheckpointValidationResult,
  InMemoryCheckpointStore,
  WorkflowCheckpoint,
  computeWorkflowStructureHash
} from "./checkpoint.js";
import { coerceValueToSchemaType } from "./schemaUtils.js";
import type { JsonSchema, JsonSchemaField } from "./schemaUtils.js";

export {
  CheckpointConfig,
  CheckpointMetadata,
  CheckpointStore,
  CheckpointValidationResult,
  FileCheckpointStore,
  InMemoryCheckpointStore,
  WorkflowCheckpoint,
  computeWorkflowStructureHash
} from "./checkpoint.js";
export type { WorkflowCheckpointInit } from "./checkpoint.js";
export {
  coerceValueToSchemaType,
  extractPrimaryTypeFromSchema,
  getTypeFromJsonSchemaType
} from "./schemaUtils.js";
export type { JsonSchema, JsonSchemaField, RuntimeTypeKind } from "./schemaUtils.js";
export {
  createEchoChainWorkflow,
  createSimpleAgentWorkflow,
  createConditionalWorkflow,
  getDefaultSteps,
  getDefaultWorkflows
} from "./defaults.js";
export type {
  CollectedOutput,
  ConditionalInput,
  MessageInput,
  MessageOutput,
  WebpageInput
} from "./defaults.js";

export enum StepStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  SKIPPED = "skipped",
  CANCELLED = "cancelled"
}

export enum WorkflowStatus {
  CREATED = "created",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled"
}

export interface EdgeCondition {
  type?: "always" | "outputBased" | "stateBased";
  expression?: string;
  field?: string;
  value?: unknown;
  operator?: "==" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "notIn";
}

export class Edge {
  id: string;
  fromStep: string;
  toStep: string;
  condition: EdgeCondition;

  constructor(init: { fromStep: string; toStep: string; condition?: EdgeCondition | Record<string, unknown>; id?: string }) {
    this.id = init.id ?? randomUUID();
    this.fromStep = init.fromStep;
    this.toStep = init.toStep;
    this.condition = normalizeEdgeCondition(init.condition);
  }
}

export interface StepExecution {
  stepId: string;
  status: StepStatus;
  startTime?: Date;
  endTime?: Date;
  inputData?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  error?: string;
  retryCount: number;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  startTime?: Date;
  endTime?: Date;
  state: Record<string, unknown>;
  stepExecutions: Record<string, StepExecution>;
  error?: string;
}

export interface StepMetadata {
  name: string;
  description?: string;
  tags?: string[];
  maxRetries?: number;
  timeoutSeconds?: number;
}

export interface WorkflowMetadata {
  name: string;
  description?: string;
  version?: string;
  tags?: string[];
  author?: string;
  createdAt?: Date;
}

export class Context {
  state: Record<string, unknown>;
  private progressCallback?: (progress: ProgressData) => void;

  constructor(state: Record<string, unknown> = {}, progressCallback?: (progress: ProgressData) => void) {
    this.state = state;
    this.progressCallback = progressCallback;
  }

  static fromStateRef(state: Record<string, unknown>, progressCallback?: (progress: ProgressData) => void): Context {
    return new Context(state, progressCallback);
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this.state[key] as T | undefined) ?? defaultValue;
  }

  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  emitProgress(message: string, completed?: number, total?: number, metadata: Record<string, unknown> = {}): void {
    this.progressCallback?.({ message, completed, total, metadata });
  }

  toDict(): Record<string, unknown> {
    return { workflowState: this.state, ...this.state };
  }
}

export interface ProgressData {
  message: string;
  completed?: number;
  total?: number;
  metadata: Record<string, unknown>;
}

export interface WorkflowValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  hasCycles: boolean;
  unreachableSteps: string[];
}

export enum WorkflowEventType {
  WORKFLOW_STARTED = "workflow_started",
  WORKFLOW_COMPLETED = "workflow_completed",
  WORKFLOW_FAILED = "workflow_failed",
  WORKFLOW_CANCELLED = "workflow_cancelled",
  STEP_STARTED = "step_started",
  STEP_COMPLETED = "step_completed",
  STEP_FAILED = "step_failed",
  STEP_PROGRESS = "step_progress",
  EDGE_ACTIVATED = "edge_activated",
  WORKFLOW_RESUMED = "workflow_resumed",
  CHECKPOINT_SAVED = "checkpoint_saved"
}

export class WorkflowEvent {
  eventType: WorkflowEventType;
  timestamp: Date;
  workflowId: string;

  constructor(eventType: WorkflowEventType, workflowId: string) {
    this.eventType = eventType;
    this.workflowId = workflowId;
    this.timestamp = new Date();
  }
}

export class WorkflowStartedEvent extends WorkflowEvent {
  initialInput: Record<string, unknown>;
  constructor(workflowId: string, initialInput: Record<string, unknown>) {
    super(WorkflowEventType.WORKFLOW_STARTED, workflowId);
    this.initialInput = initialInput;
  }
}

export class WorkflowCompletedEvent extends WorkflowEvent {
  execution: WorkflowExecution;
  constructor(workflowId: string, execution: WorkflowExecution) {
    super(WorkflowEventType.WORKFLOW_COMPLETED, workflowId);
    this.execution = execution;
  }
}

export class WorkflowFailedEvent extends WorkflowEvent {
  error: string;
  execution?: WorkflowExecution;
  constructor(workflowId: string, error: string, execution?: WorkflowExecution) {
    super(WorkflowEventType.WORKFLOW_FAILED, workflowId);
    this.error = error;
    this.execution = execution;
  }
}

export class WorkflowCancelledEvent extends WorkflowEvent {
  reason: string;
  execution: WorkflowExecution;
  constructor(workflowId: string, execution: WorkflowExecution, reason: string) {
    super(WorkflowEventType.WORKFLOW_CANCELLED, workflowId);
    this.execution = execution;
    this.reason = reason;
  }
}

export class StepStartedEvent extends WorkflowEvent {
  stepId: string;
  inputData: Record<string, unknown>;
  constructor(workflowId: string, stepId: string, inputData: Record<string, unknown>) {
    super(WorkflowEventType.STEP_STARTED, workflowId);
    this.stepId = stepId;
    this.inputData = inputData;
  }
}

export class StepCompletedEvent extends WorkflowEvent {
  stepId: string;
  outputData: Record<string, unknown>;
  durationSeconds: number;
  constructor(workflowId: string, stepId: string, outputData: Record<string, unknown>, durationSeconds: number) {
    super(WorkflowEventType.STEP_COMPLETED, workflowId);
    this.stepId = stepId;
    this.outputData = outputData;
    this.durationSeconds = durationSeconds;
  }
}

export class StepFailedEvent extends WorkflowEvent {
  stepId: string;
  error: string;
  durationSeconds: number;
  constructor(workflowId: string, stepId: string, error: string, durationSeconds: number) {
    super(WorkflowEventType.STEP_FAILED, workflowId);
    this.stepId = stepId;
    this.error = error;
    this.durationSeconds = durationSeconds;
  }
}

export class StepProgressEvent extends WorkflowEvent {
  stepId: string;
  message: string;
  completed?: number;
  total?: number;
  metadata: Record<string, unknown>;
  constructor(workflowId: string, stepId: string, progress: ProgressData) {
    super(WorkflowEventType.STEP_PROGRESS, workflowId);
    this.stepId = stepId;
    this.message = progress.message;
    this.completed = progress.completed;
    this.total = progress.total;
    this.metadata = progress.metadata;
  }
}

export class EdgeActivatedEvent extends WorkflowEvent {
  fromStep: string;
  toStep: string;
  data: Record<string, unknown>;
  constructor(workflowId: string, fromStep: string, toStep: string, data: Record<string, unknown>) {
    super(WorkflowEventType.EDGE_ACTIVATED, workflowId);
    this.fromStep = fromStep;
    this.toStep = toStep;
    this.data = data;
  }
}

export class WorkflowResumedEvent extends WorkflowEvent {
  checkpointId: string;
  completedSteps: string[];
  pendingSteps: string[];
  constructor(workflowId: string, checkpointId: string, completedSteps: string[], pendingSteps: string[]) {
    super(WorkflowEventType.WORKFLOW_RESUMED, workflowId);
    this.checkpointId = checkpointId;
    this.completedSteps = completedSteps;
    this.pendingSteps = pendingSteps;
  }
}

export class CheckpointSavedEvent extends WorkflowEvent {
  checkpointId: string;
  completedSteps: number;
  totalSteps: number;
  constructor(workflowId: string, checkpointId: string, completedSteps: number, totalSteps: number) {
    super(WorkflowEventType.CHECKPOINT_SAVED, workflowId);
    this.checkpointId = checkpointId;
    this.completedSteps = completedSteps;
    this.totalSteps = totalSteps;
  }
}

export type Validator<T> = (value: Record<string, unknown>) => T;

export abstract class BaseStep<Input extends Record<string, unknown> = Record<string, unknown>, Output extends Record<string, unknown> = Record<string, unknown>> {
  stepId: string;
  metadata: Required<StepMetadata>;
  status: StepStatus = StepStatus.PENDING;
  startTime?: Date;
  endTime?: Date;
  error?: string;
  inputValidator?: Validator<Input>;
  outputValidator?: Validator<Output>;
  /** Optional declared JSON schemas, used for output coercion and structure hashing. */
  inputTypeName?: string;
  outputTypeName?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;

  constructor(init: {
    stepId: string;
    metadata: StepMetadata;
    inputValidator?: Validator<Input>;
    outputValidator?: Validator<Output>;
    inputTypeName?: string;
    outputTypeName?: string;
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
  }) {
    this.stepId = init.stepId;
    this.metadata = {
      name: init.metadata.name,
      description: init.metadata.description ?? "",
      tags: init.metadata.tags ?? [],
      maxRetries: init.metadata.maxRetries ?? 0,
      timeoutSeconds: init.metadata.timeoutSeconds ?? 0
    };
    this.inputValidator = init.inputValidator;
    this.outputValidator = init.outputValidator;
    this.inputTypeName = init.inputTypeName;
    this.outputTypeName = init.outputTypeName;
    this.inputSchema = init.inputSchema;
    this.outputSchema = init.outputSchema;
  }

  abstract execute(inputData: Input, context: Context): Promise<Output> | Output;

  async run(inputData: Record<string, unknown>, contextData: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.status = StepStatus.RUNNING;
    this.startTime = new Date();
    this.error = undefined;
    let attempt = 0;

    while (attempt <= this.metadata.maxRetries) {
      try {
        const input = this.validateInputData(inputData);
        const contextObject = contextData.contextObject ?? contextData._context_obj;
        const workflowState = contextData.workflowState ?? contextData.workflow_state;
        const context = contextObject instanceof Context
          ? contextObject
          : Context.fromStateRef((workflowState as Record<string, unknown>) ?? {});
        const operation = Promise.resolve(this.execute(input, context));
        const output = this.metadata.timeoutSeconds
          ? await withTimeout(operation, this.metadata.timeoutSeconds * 1000, `Step ${this.stepId} timed out after ${this.metadata.timeoutSeconds}s`)
          : await operation;
        const validatedOutput = this.coerceOutput(output);
        this.status = StepStatus.COMPLETED;
        this.endTime = new Date();
        return validatedOutput;
      } catch (error) {
        // Timeouts are FATAL and must not be retried (mirrors Python's
        // asyncio.TimeoutError handling in steps/_step.py).
        if (error instanceof StepTimeoutError) {
          this.status = StepStatus.FAILED;
          this.endTime = new Date();
          this.error = error.message;
          throw error;
        }
        attempt += 1;
        if (attempt <= this.metadata.maxRetries) {
          // Python sleeps 1 second between retry attempts.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        this.status = StepStatus.FAILED;
        this.endTime = new Date();
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    throw new Error(`Unexpected error in step ${this.stepId}`);
  }

  /**
   * Coerce/validate the step output. Prefers an explicit outputValidator if
   * declared; otherwise returns the raw output unchanged.
   */
  protected coerceOutput(output: Record<string, unknown>): Record<string, unknown> {
    if (this.outputValidator) {
      return this.outputValidator(output);
    }
    // If a declared output JSON schema is present, apply defensive field-level
    // coercion using the shared schema utility.
    if (this.outputSchema && output && typeof output === "object" && !Array.isArray(output)) {
      const coerced: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(output)) {
        coerced[key] = coerceValueToSchemaType(value, key, this.outputSchema);
      }
      return coerced;
    }
    return output;
  }

  validateInputData(inputData: Record<string, unknown>): Input {
    if (this.inputValidator) {
      return this.inputValidator(inputData);
    }
    if (this.inputSchema) {
      return validateAndCoerceBySchema(inputData, this.inputSchema) as Input;
    }
    return inputData as Input;
  }
}

export class FunctionStep<Input extends Record<string, unknown>, Output extends Record<string, unknown>> extends BaseStep<Input, Output> {
  func: (input: Input, context: Context) => Output | Promise<Output>;

  constructor(init: ConstructorParameters<typeof BaseStep<Input, Output>>[0] & {
    func: (input: Input, context: Context) => Output | Promise<Output>;
  }) {
    super(init);
    this.func = init.func;
  }

  execute(inputData: Input, context: Context): Output | Promise<Output> {
    return this.func(inputData, context);
  }
}

export class EchoStep extends BaseStep {
  static componentType = "step" as const;
  static componentProvider = "picoagents.workflow.EchoStep";
  static componentVersion = 1;

  prefix: string;
  suffix: string;
  delaySeconds: number;

  constructor(init: {
    stepId: string;
    metadata: StepMetadata;
    prefix?: string;
    suffix?: string;
    delaySeconds?: number;
  }) {
    super({
      stepId: init.stepId,
      metadata: init.metadata,
      inputTypeName: "Record",
      outputTypeName: "Record"
    });
    this.prefix = init.prefix ?? "Echo: ";
    this.suffix = init.suffix ?? "";
    this.delaySeconds = init.delaySeconds ?? 0;
  }

  static fromConfig(config: Record<string, unknown> = {}): EchoStep {
    const step = new EchoStep({
      stepId: String(config.stepId ?? config.step_id ?? ""),
      metadata: (config.metadata as StepMetadata) ?? { name: String(config.stepId ?? config.step_id ?? "Echo") },
      prefix: config.prefix as string | undefined,
      suffix: config.suffix as string | undefined,
      delaySeconds: numberOrUndefined(config.delaySeconds ?? config.delay_seconds)
    });
    step.inputSchema = config.inputSchema as JsonSchema | undefined;
    step.outputSchema = config.outputSchema as JsonSchema | undefined;
    step.inputTypeName = (config.inputTypeName ?? config.input_type_name ?? step.inputTypeName) as string | undefined;
    step.outputTypeName = (config.outputTypeName ?? config.output_type_name ?? step.outputTypeName) as string | undefined;
    return step;
  }

  toConfig(): Record<string, unknown> {
    return {
      stepId: this.stepId,
      metadata: this.metadata,
      prefix: this.prefix,
      suffix: this.suffix,
      delaySeconds: this.delaySeconds,
      inputTypeName: this.inputTypeName,
      outputTypeName: this.outputTypeName,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema
    };
  }

  async execute(inputData: Record<string, unknown>, context: Context): Promise<Record<string, unknown>> {
    if (this.delaySeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delaySeconds * 1000));
    }
    const value =
      inputData.message ?? inputData.result ?? inputData.text ?? inputData.content ?? inputData.data ?? Object.values(inputData)[0] ?? "";
    const result = `${this.prefix}${String(value)}${this.suffix}`;
    context.set(`${this.stepId}_echo_info`, {
      original: value,
      prefix: this.prefix,
      suffix: this.suffix,
      result
    });
    return { result };
  }
}

export interface HttpRequestInput extends Record<string, unknown> {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  timeout?: number;
  verifySsl?: boolean;
  verify_ssl?: boolean;
}

export interface HttpResponseOutput extends Record<string, unknown> {
  statusCode: number;
  content: string;
  headers: Record<string, string>;
  url: string;
  encoding?: string;
  elapsedTime: number;
}

export class HttpStep extends BaseStep<HttpRequestInput, HttpResponseOutput> {
  static componentType = "step" as const;
  static componentProvider = "picoagents.workflow.HttpStep";
  static componentVersion = 1;

  constructor(init: { stepId: string; metadata: StepMetadata }) {
    super({
      stepId: init.stepId,
      metadata: init.metadata,
      inputTypeName: "HttpRequestInput",
      outputTypeName: "HttpResponseOutput",
      inputValidator: (value) => {
        if (!value.url || typeof value.url !== "string") throw new Error("url is required");
        return value as HttpRequestInput;
      }
    });
  }

  static fromConfig(config: Record<string, unknown> = {}): HttpStep {
    const step = new HttpStep({
      stepId: String(config.stepId ?? config.step_id ?? ""),
      metadata: (config.metadata as StepMetadata) ?? { name: String(config.stepId ?? config.step_id ?? "HTTP") }
    });
    step.inputSchema = config.inputSchema as JsonSchema | undefined;
    step.outputSchema = config.outputSchema as JsonSchema | undefined;
    step.inputTypeName = (config.inputTypeName ?? config.input_type_name ?? step.inputTypeName) as string | undefined;
    step.outputTypeName = (config.outputTypeName ?? config.output_type_name ?? step.outputTypeName) as string | undefined;
    return step;
  }

  toConfig(): Record<string, unknown> {
    return {
      stepId: this.stepId,
      metadata: this.metadata,
      inputTypeName: this.inputTypeName,
      outputTypeName: this.outputTypeName,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema
    };
  }

  async execute(inputData: HttpRequestInput, context: Context): Promise<HttpResponseOutput> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (inputData.timeout ?? 30) * 1000);
    try {
      const response = await fetch(inputData.url, {
        method: inputData.method ?? "GET",
        headers: inputData.headers,
        body: inputData.data === undefined ? undefined : JSON.stringify(inputData.data),
        signal: controller.signal
      });
      const content = await response.text();
      const elapsed = (Date.now() - start) / 1000;
      context.set(`${this.stepId}_request_info`, {
        url: inputData.url,
        method: inputData.method ?? "GET",
        statusCode: response.status,
        elapsedTime: elapsed,
        contentLength: content.length
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${content.slice(0, 200)}`);
      }
      return {
        statusCode: response.status,
        content,
        headers: Object.fromEntries(response.headers.entries()),
        url: response.url,
        encoding: response.headers.get("content-encoding") ?? undefined,
        elapsedTime: elapsed
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TransformStep extends BaseStep {
  static componentType = "step" as const;
  static componentProvider = "picoagents.workflow.TransformStep";
  static componentVersion = 1;

  mappings: Record<string, unknown>;

  constructor(init: {
    stepId: string;
    metadata: StepMetadata;
    mappings?: Record<string, unknown>;
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
  }) {
    super({
      stepId: init.stepId,
      metadata: init.metadata,
      inputTypeName: init.inputSchema?.title as string | undefined,
      outputTypeName: init.outputSchema?.title as string | undefined,
      inputSchema: init.inputSchema,
      outputSchema: init.outputSchema
    });
    this.mappings = init.mappings ?? {};
  }

  static fromConfig(config: Record<string, unknown> = {}): TransformStep {
    return new TransformStep({
      stepId: String(config.stepId ?? config.step_id ?? ""),
      metadata: (config.metadata as StepMetadata) ?? { name: String(config.stepId ?? config.step_id ?? "Transform") },
      mappings: (config.mappings as Record<string, unknown>) ?? {},
      inputSchema: config.inputSchema as JsonSchema | undefined,
      outputSchema: config.outputSchema as JsonSchema | undefined
    });
  }

  toConfig(): Record<string, unknown> {
    return {
      stepId: this.stepId,
      metadata: this.metadata,
      mappings: this.mappings,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema
    };
  }

  execute(inputData: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [outField, mapping] of Object.entries(this.mappings)) {
      let rawValue: unknown;
      if (typeof mapping === "string") {
        rawValue = mapping.startsWith("static:")
          ? interpolateTemplate(mapping.slice("static:".length), inputData)
          : inputData[mapping];
      } else if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
        rawValue = Object.fromEntries(
          Object.entries(mapping as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === "string" && value.startsWith("static:")
              ? interpolateTemplate(value.slice("static:".length), inputData)
              : typeof value === "string"
                ? inputData[value]
                : value
          ])
        );
      } else {
        rawValue = mapping;
      }
      // Apply optional output coercion via the schema utility when an output
      // JSON schema is declared on the step.
      output[outField] = this.outputSchema
        ? coerceValueToSchemaType(rawValue, outField, this.outputSchema)
        : rawValue;
    }
    return output;
  }
}

export interface PicoAgentInput extends Record<string, unknown> {
  task: string;
  additionalContext?: Record<string, unknown>;
  additional_context?: Record<string, unknown>;
  outputTaskMessages?: boolean;
  output_task_messages?: boolean;
}

export interface PicoAgentOutput extends Record<string, unknown> {
  response: string;
  messages: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export class PicoAgentStep extends BaseStep<PicoAgentInput, PicoAgentOutput> {
  static componentType = "step" as const;
  static componentProvider = "picoagents.workflow.PicoAgentStep";
  static componentVersion = 1;

  agent: Agent;

  constructor(init: { stepId: string; metadata: StepMetadata; agent: Agent }) {
    super({
      stepId: init.stepId,
      metadata: init.metadata,
      inputTypeName: "PicoAgentInput",
      outputTypeName: "PicoAgentOutput",
      inputValidator: (value) => {
        if (!value.task || typeof value.task !== "string") throw new Error("task is required");
        return value as PicoAgentInput;
      }
    });
    this.agent = init.agent;
  }

  static fromConfig(config: Record<string, unknown> = {}): PicoAgentStep {
    const step = new PicoAgentStep({
      stepId: String(config.stepId ?? config.step_id ?? ""),
      metadata: (config.metadata as StepMetadata) ?? { name: String(config.stepId ?? config.step_id ?? "Agent") },
      agent: loadComponent(config.agent as ComponentModel) as Agent
    });
    step.inputSchema = config.inputSchema as JsonSchema | undefined;
    step.outputSchema = config.outputSchema as JsonSchema | undefined;
    step.inputTypeName = (config.inputTypeName ?? config.input_type_name ?? step.inputTypeName) as string | undefined;
    step.outputTypeName = (config.outputTypeName ?? config.output_type_name ?? step.outputTypeName) as string | undefined;
    return step;
  }

  toConfig(): Record<string, unknown> {
    return {
      stepId: this.stepId,
      metadata: this.metadata,
      agent: dumpComponent(this.agent),
      inputTypeName: this.inputTypeName,
      outputTypeName: this.outputTypeName,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema
    };
  }

  async execute(inputData: PicoAgentInput, context: Context): Promise<PicoAgentOutput> {
    const additionalContext =
      inputData.additionalContext ??
      (inputData as Record<string, unknown>).additional_context as Record<string, unknown> | undefined;
    context.set(`${this.stepId}_request_info`, {
      agentName: this.agent.name,
      task: inputData.task,
      timestamp: new Date().toISOString(),
      additionalContext
    });
    try {
      const result = await this.agent.run(inputData.task);
      const finalMessage = [...result.messages].reverse().find((message) => message.role === "assistant") ?? result.messages.at(-1);
      const includeMessages = inputData.outputTaskMessages ?? inputData.output_task_messages ?? true;
      const messages = includeMessages ? result.messages.map((message) => ({
        role: message.role,
        content: message.content,
        source: message.source,
        timestamp: message.timestamp.toISOString()
      })) : [];
      const output = {
        response: finalMessage?.content ?? "No response generated",
        messages,
        usage: { ...result.usage },
        metadata: {
          agentName: this.agent.name,
          messageCount: result.messages.length,
          elapsedTime: result.usage.durationMs / 1000,
          llmCalls: result.usage.llmCalls,
          tokensTotal: result.usage.tokensInput + result.usage.tokensOutput,
          executionTimestamp: new Date().toISOString(),
          ...(additionalContext ? { additionalContext } : {})
        }
      };
      context.set(`${this.stepId}_output`, output);
      return output;
    } catch (error) {
      const message = `PicoAgent execution failed: ${error instanceof Error ? error.message : String(error)}`;
      context.set(`${this.stepId}_error`, {
        error: message,
        timestamp: new Date().toISOString()
      });
      return {
        response: `Error: ${message}`,
        messages: [],
        usage: {},
        metadata: {
          agentName: this.agent.name,
          error: message,
          executionTimestamp: new Date().toISOString()
        }
      };
    }
  }
}

export class Workflow {
  // ---- Serializable component metadata (see componentConfig.ts) ----
  static componentType = "workflow" as const;
  static componentProvider = "picoagents.workflow.Workflow";
  static componentVersion = 1;
  static componentDescription = "Explicit-control-flow workflow of steps and edges";

  id: string;
  metadata: Required<WorkflowMetadata>;
  steps: Record<string, BaseStep> = {};
  edges: Edge[] = [];
  initialState: Record<string, unknown>;
  startStepId?: string;
  endStepIds: string[] = [];

  constructor(init: { metadata: WorkflowMetadata; initialState?: Record<string, unknown>; workflowId?: string }) {
    this.id = init.workflowId ?? randomUUID();
    this.metadata = {
      name: init.metadata.name,
      description: init.metadata.description ?? "",
      version: init.metadata.version ?? "1.0.0",
      tags: init.metadata.tags ?? [],
      author: init.metadata.author ?? "",
      createdAt: init.metadata.createdAt ?? new Date()
    };
    this.initialState = init.initialState ?? {};
  }

  addStep(step: BaseStep): this {
    this.steps[step.stepId] = step;
    return this;
  }

  addEdge(fromStep: string | BaseStep, toStep: string | BaseStep, condition?: EdgeCondition): this {
    const fromStepId = typeof fromStep === "string" ? fromStep : fromStep.stepId;
    const toStepId = typeof toStep === "string" ? toStep : toStep.stepId;
    if (fromStep instanceof BaseStep) this.addStep(fromStep);
    if (toStep instanceof BaseStep) this.addStep(toStep);
    this.edges.push(new Edge({ fromStep: fromStepId, toStep: toStepId, condition }));
    return this;
  }

  setStartStep(step: string | BaseStep): this {
    const stepId = typeof step === "string" ? step : step.stepId;
    if (!this.steps[stepId]) throw new Error(`Step ${stepId} not found in workflow`);
    this.startStepId = stepId;
    return this;
  }

  addEndStep(step: string | BaseStep): this {
    const stepId = typeof step === "string" ? step : step.stepId;
    if (!this.steps[stepId]) throw new Error(`Step ${stepId} not found in workflow`);
    if (!this.endStepIds.includes(stepId)) this.endStepIds.push(stepId);
    return this;
  }

  chain(...steps: BaseStep[]): this {
    if (steps.length < 2) throw new Error("chain() requires at least 2 steps");
    for (let index = 0; index < steps.length - 1; index += 1) {
      this.addEdge(steps[index]!, steps[index + 1]!);
    }
    this.setStartStep(steps[0]!);
    this.addEndStep(steps[steps.length - 1]!);
    return this;
  }

  getStepDependencies(stepId: string): string[] {
    return this.edges.filter((edge) => edge.toStep === stepId).map((edge) => edge.fromStep);
  }

  getStepDependents(stepId: string): string[] {
    return this.edges.filter((edge) => edge.fromStep === stepId).map((edge) => edge.toStep);
  }

  getReadySteps(execution: WorkflowExecution): string[] {
    const ready: string[] = [];
    for (const stepId of Object.keys(this.steps)) {
      const current = execution.stepExecutions[stepId];
      if (current && [StepStatus.RUNNING, StepStatus.COMPLETED, StepStatus.FAILED].includes(current.status)) {
        continue;
      }
      const dependencies = this.getStepDependencies(stepId);
      if (!dependencies.length) {
        if (stepId === this.startStepId && !current) ready.push(stepId);
        continue;
      }

      const incoming = this.edges.filter((edge) => edge.toStep === stepId);
      const fanIn = incoming.every((edge) => (edge.condition.type ?? "always") === "always");
      if (fanIn) {
        if (dependencies.every((depId) => execution.stepExecutions[depId]?.status === StepStatus.COMPLETED)) {
          ready.push(stepId);
        }
      } else if (
        incoming.some(
          (edge) =>
            execution.stepExecutions[edge.fromStep]?.status === StepStatus.COMPLETED &&
            this.evaluateEdgeCondition(edge, execution)
        )
      ) {
        ready.push(stepId);
      }
    }
    return ready;
  }

  evaluateEdgeCondition(edge: Edge, execution: WorkflowExecution): boolean {
    const condition = normalizeEdgeCondition(edge.condition);
    if (!condition.type || condition.type === "always") return true;
    if (condition.type === "outputBased") {
      const output = execution.stepExecutions[edge.fromStep]?.outputData;
      if (!output || !condition.field || !condition.operator) return false;
      return compareValues(output[condition.field], condition.operator, condition.value);
    }
    if (condition.type === "stateBased") {
      if (!condition.field || !condition.operator) return false;
      return compareValues(execution.state[condition.field], condition.operator, condition.value);
    }
    return true;
  }

  validateWorkflow(): WorkflowValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!Object.keys(this.steps).length) errors.push("Workflow has no steps");
    if (!this.startStepId) errors.push("No start step specified");
    if (this.startStepId && !this.steps[this.startStepId]) errors.push(`Start step ${this.startStepId} not found in workflow`);
    if (!this.endStepIds.length) warnings.push("No end steps specified");
    for (const end of this.endStepIds) {
      if (!this.steps[end]) errors.push(`End step ${end} not found in workflow`);
    }
    for (const edge of this.edges) {
      if (!this.steps[edge.fromStep]) errors.push(`Edge references non-existent step: ${edge.fromStep}`);
      if (!this.steps[edge.toStep]) errors.push(`Edge references non-existent step: ${edge.toStep}`);
    }
    const { hasCycles, cycle } = this.detectCycles();
    if (hasCycles) errors.push(`Workflow contains cycles: ${cycle}`);
    const unreachableSteps = this.findUnreachableSteps();
    if (unreachableSteps.length) warnings.push(`Unreachable steps found: ${unreachableSteps.join(", ")}`);

    // Conditional edge validation (ported from Python _validate_conditional_edges).
    const conditional = this.validateConditionalEdges();
    errors.push(...conditional.errors);
    warnings.push(...conditional.warnings);

    errors.push(...this.validateTypeCompatibility());

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      hasCycles,
      unreachableSteps
    };
  }

  /** Validate declared input/output compatibility across connected steps. */
  private validateTypeCompatibility(): string[] {
    const errors: string[] = [];
    for (const edge of this.edges) {
      const fromStep = this.steps[edge.fromStep];
      const toStep = this.steps[edge.toStep];
      if (!fromStep || !toStep) continue;
      if (areStepTypesCompatible(fromStep, toStep)) continue;
      errors.push(
        `Type mismatch: Step '${edge.fromStep}' outputs ${stepTypeLabel(fromStep, "output")} ` +
          `but step '${edge.toStep}' expects ${stepTypeLabel(toStep, "input")}`
      );
    }
    return errors;
  }

  /** Validate conditional edge logic for common issues. */
  private validateConditionalEdges(): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Group edges by target step to check for condition conflicts.
    const edgesByTarget: Record<string, Edge[]> = {};
    for (const edge of this.edges) {
      (edgesByTarget[edge.toStep] ??= []).push(edge);
    }

    for (const [stepId, incomingEdges] of Object.entries(edgesByTarget)) {
      if (incomingEdges.length > 1) {
        const issues = this.checkMultipleConditionalEdges(stepId, incomingEdges);
        errors.push(...issues.errors);
        warnings.push(...issues.warnings);
      }
    }

    // Steps with no outgoing paths that aren't marked as end steps.
    for (const stepId of Object.keys(this.steps)) {
      if (this.endStepIds.includes(stepId)) continue;
      const outgoing = this.edges.filter((edge) => edge.fromStep === stepId);
      if (!outgoing.length) {
        warnings.push(`Step '${stepId}' has no outgoing edges but is not marked as an end step`);
      } else if (this.hasImpossibleConditions(outgoing)) {
        errors.push(
          `Step '${stepId}' has outgoing edges with contradictory conditions - some paths may be unreachable`
        );
      }
    }

    // End step reachability under conditional constraints.
    for (const endStep of this.findUnreachableEndSteps()) {
      errors.push(`End step '${endStep}' cannot be reached due to conditional edge constraints`);
    }

    return { errors, warnings };
  }

  /** Check multiple incoming edges for logical conflicts. */
  private checkMultipleConditionalEdges(stepId: string, edges: Edge[]): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const fieldConditions: Record<string, Array<{ fromStep: string; condition: EdgeCondition }>> = {};
    for (const edge of edges) {
      const condition = edge.condition;
      if ((condition.type === "outputBased" || condition.type === "stateBased") && condition.field) {
        const key = `${condition.type}:${condition.field}`;
        (fieldConditions[key] ??= []).push({ fromStep: edge.fromStep, condition });
      }
    }

    for (const conditions of Object.values(fieldConditions)) {
      if (conditions.length > 1) {
        const trueConditions = conditions.filter((c) => c.condition.value === true && c.condition.operator === "==");
        const falseConditions = conditions.filter((c) => c.condition.value === false && c.condition.operator === "==");
        if (trueConditions.length && falseConditions.length) {
          const fromSteps = conditions.map((c) => c.fromStep);
          warnings.push(
            `Step '${stepId}' has contradictory boolean conditions from steps ${JSON.stringify(fromSteps)} - only one path can execute`
          );
        }
      }
    }

    return { errors, warnings };
  }

  /** Check if outgoing edges have impossible condition combinations. */
  private hasImpossibleConditions(edges: Edge[]): boolean {
    if (edges.length <= 1) return false;

    const fieldGroups: Record<string, EdgeCondition[]> = {};
    for (const edge of edges) {
      const condition = edge.condition;
      if (condition.type === "always") continue;
      if (condition.field && condition.operator && condition.value !== undefined && condition.value !== null) {
        const key = `${condition.type}:${condition.field}`;
        (fieldGroups[key] ??= []).push(condition);
      }
    }

    for (const conditions of Object.values(fieldGroups)) {
      if (conditions.length === edges.length && conditions.every((c) => c.operator === "==")) {
        const values = conditions.map((c) => c.value);
        const unique = new Set(values.map((v) => JSON.stringify(v)));
        if (unique.size === values.length) return true;
      }
    }

    return false;
  }

  /** Find end steps that cannot be reached due to conditional constraints. */
  private findUnreachableEndSteps(): string[] {
    return this.endStepIds.filter((endStepId) => !this.canReachStepConditionally(endStepId, new Set()));
  }

  private canReachStepConditionally(targetStep: string, visiting: Set<string>): boolean {
    if (targetStep === this.startStepId) return true;
    if (visiting.has(targetStep)) return false;
    visiting.add(targetStep);

    const incoming = this.edges.filter((edge) => edge.toStep === targetStep);
    if (!incoming.length) return false;

    for (const edge of incoming) {
      if (this.canReachStepConditionally(edge.fromStep, visiting)) {
        const type = edge.condition.type ?? "always";
        if (type === "always" || type === "outputBased" || type === "stateBased") {
          return true;
        }
      }
    }
    return false;
  }

  /** Get a structured representation of the workflow execution plan. */
  getExecutionPlan(): Record<string, unknown> {
    const steps: Record<string, unknown> = {};
    for (const [stepId, step] of Object.entries(this.steps)) {
      steps[stepId] = {
        stepId: step.stepId,
        type: step.constructor.name,
        metadata: step.metadata,
        inputTypeName: step.inputTypeName,
        outputTypeName: step.outputTypeName,
        inputSchema: step.inputSchema,
        outputSchema: step.outputSchema
      };
    }
    return {
      workflowId: this.id,
      metadata: this.metadata,
      steps,
      edges: this.edges.map((edge) => ({
        id: edge.id,
        fromStep: edge.fromStep,
        toStep: edge.toStep,
        condition: edge.condition
      })),
      startStep: this.startStepId,
      endSteps: this.endStepIds,
      validation: this.validateWorkflow()
    };
  }

  /**
   * Compute a hash of the workflow structure for checkpoint compatibility.
   * Mirrors Python `compute_structure_hash`. Returns a 16-char hex string.
   */
  computeStructureHash(): string {
    return computeWorkflowStructureHash(this.steps, this.edges, this.startStepId, this.endStepIds);
  }

  private detectCycles(): { hasCycles: boolean; cycle?: string } {
    if (!this.startStepId) return { hasCycles: false };
    const visited = new Set<string>();
    const stack = new Set<string>();
    const visit = (stepId: string, path: string[]): string | undefined => {
      if (stack.has(stepId)) return [...path, stepId].join(" -> ");
      if (visited.has(stepId)) return undefined;
      visited.add(stepId);
      stack.add(stepId);
      for (const next of this.getStepDependents(stepId)) {
        const cycle = visit(next, [...path, stepId]);
        if (cycle) return cycle;
      }
      stack.delete(stepId);
      return undefined;
    };
    const cycle = visit(this.startStepId, []);
    return { hasCycles: Boolean(cycle), cycle };
  }

  private findUnreachableSteps(): string[] {
    if (!this.startStepId) return Object.keys(this.steps);
    const reachable = new Set<string>();
    const queue = [this.startStepId];
    while (queue.length) {
      const stepId = queue.pop()!;
      if (reachable.has(stepId)) continue;
      reachable.add(stepId);
      queue.push(...this.getStepDependents(stepId));
    }
    return Object.keys(this.steps).filter((stepId) => !reachable.has(stepId));
  }

  // ==========================================================================
  // Serialization (componentConfig)
  // ==========================================================================

  /**
   * Serialize the workflow's primitive structure to a config object.
   *
   * Registered concrete steps are serialized as component models. Steps that
   * cannot represent their behavior as JSON, such as closure-backed FunctionStep
   * instances, fall back to lightweight descriptors that preserve structure.
   */
  toConfig(): Record<string, unknown> {
    return {
      workflowId: this.id,
      metadata: this.metadata,
      steps: Object.values(this.steps).map((step) =>
        tryDumpWorkflowComponent(step) ?? {
          stepId: step.stepId,
          type: step.constructor.name,
          metadata: step.metadata,
          inputTypeName: step.inputTypeName,
          outputTypeName: step.outputTypeName,
          inputSchema: step.inputSchema,
          outputSchema: step.outputSchema
        }
      ),
      edges: this.edges.map((edge) => ({
        id: edge.id,
        fromStep: edge.fromStep,
        toStep: edge.toStep,
        condition: edge.condition
      })),
      initialState: this.initialState,
      startStepId: this.startStepId,
      endStepIds: this.endStepIds
    };
  }

  /** Dump this workflow to a full ComponentModel. */
  dumpComponent(): ComponentModel {
    return dumpComponent(this);
  }

  /**
   * Rebuild a workflow from a config produced by {@link toConfig}.
   *
   * Reconstructs metadata, edges and start/end step ids. Registered component
   * steps are rebuilt with behavior; descriptor-only steps are restored as
   * placeholders preserving id/metadata/schemas.
   */
  static fromConfig(config: Record<string, unknown>): Workflow {
    const metadata = (config.metadata as WorkflowMetadata) ?? { name: "Workflow" };
    const workflow = new Workflow({
      metadata,
      initialState: (config.initialState as Record<string, unknown>) ?? {},
      workflowId: config.workflowId as string | undefined
    });

    const steps = (config.steps as Array<Record<string, unknown>> | undefined) ?? [];
    for (const stepConfig of steps) {
      const step = isComponentModel(stepConfig)
        ? (loadComponent(stepConfig as ComponentModel) as unknown as BaseStep)
        : new ConfigPlaceholderStep({
            stepId: stepConfig.stepId as string,
            metadata: (stepConfig.metadata as StepMetadata) ?? { name: stepConfig.stepId as string },
            originalType: (stepConfig.type as string) ?? "BaseStep",
            inputTypeName: stepConfig.inputTypeName as string | undefined,
            outputTypeName: stepConfig.outputTypeName as string | undefined,
            inputSchema: stepConfig.inputSchema as JsonSchema | undefined,
            outputSchema: stepConfig.outputSchema as JsonSchema | undefined
          });
      workflow.addStep(step);
    }

    const edges = (config.edges as Array<Record<string, unknown>> | undefined) ?? [];
    for (const edgeConfig of edges) {
      workflow.edges.push(
        new Edge({
          id: edgeConfig.id as string | undefined,
          fromStep: edgeConfig.fromStep as string,
          toStep: edgeConfig.toStep as string,
          condition: edgeConfig.condition as EdgeCondition | undefined
        })
      );
    }

    workflow.startStepId = config.startStepId as string | undefined;
    workflow.endStepIds = (config.endStepIds as string[] | undefined) ?? [];
    return workflow;
  }
}

/**
 * A placeholder step produced by {@link Workflow.fromConfig} that preserves the
 * deserialized identity/metadata of a step whose concrete behavior wasn't
 * serialized. Executing it passes input through unchanged.
 */
export class ConfigPlaceholderStep extends BaseStep {
  originalType: string;

  constructor(init: {
    stepId: string;
    metadata: StepMetadata;
    originalType: string;
    inputTypeName?: string;
    outputTypeName?: string;
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
  }) {
    super({
      stepId: init.stepId,
      metadata: init.metadata,
      inputTypeName: init.inputTypeName,
      outputTypeName: init.outputTypeName,
      inputSchema: init.inputSchema,
      outputSchema: init.outputSchema
    });
    this.originalType = init.originalType;
  }

  execute(inputData: Record<string, unknown>): Record<string, unknown> {
    return { ...inputData };
  }
}

registerComponent(EchoStep as any);
registerComponent(HttpStep as any);
registerComponent(TransformStep as any);
registerComponent(PicoAgentStep as any);
registerComponent(Workflow as any);

export class WorkflowRunner {
  maxConcurrentSteps: number;
  private cancellationTokens = new Map<string, CancellationToken>();
  private cancellationReasons = new Map<string, string>();

  constructor(maxConcurrentSteps = 5) {
    this.maxConcurrentSteps = maxConcurrentSteps;
  }

  async run(
    workflow: Workflow,
    initialInput: Record<string, unknown> = {},
    cancellationToken?: CancellationToken
  ): Promise<WorkflowExecution> {
    let finalExecution: WorkflowExecution | undefined;
    for await (const event of this.runStream(workflow, { initialInput, cancellationToken })) {
      if (event instanceof WorkflowCompletedEvent) finalExecution = event.execution;
      if (event instanceof WorkflowFailedEvent) {
        if (event.execution) finalExecution = event.execution;
        throw new Error(event.error);
      }
      if (event instanceof WorkflowCancelledEvent) {
        finalExecution = event.execution;
        throw new Error(event.reason);
      }
    }
    if (!finalExecution) throw new Error("Workflow completed but no final execution was produced");
    return finalExecution;
  }

  /**
   * Run a workflow and yield real-time events.
   *
   * Supports either positional `(initialInput, cancellationToken)` for backward
   * compatibility, or an options object `{ initialInput, cancellationToken,
   * checkpoint, checkpointConfig }` for resume + auto-save.
   */
  async *runStream(
    workflow: Workflow,
    initialInputOrOptions:
      | Record<string, unknown>
      | {
          initialInput?: Record<string, unknown>;
          cancellationToken?: CancellationToken;
          checkpoint?: WorkflowCheckpoint;
          checkpointConfig?: CheckpointConfig;
        } = {},
    cancellationTokenArg?: CancellationToken
  ): AsyncGenerator<WorkflowEvent> {
    // Normalize arguments: detect the options-object form.
    let initialInput: Record<string, unknown>;
    let cancellationToken: CancellationToken | undefined;
    let checkpoint: WorkflowCheckpoint | undefined;
    let checkpointConfig: CheckpointConfig | undefined;

    if (
      initialInputOrOptions &&
      ("initialInput" in initialInputOrOptions ||
        "cancellationToken" in initialInputOrOptions ||
        "checkpoint" in initialInputOrOptions ||
        "checkpointConfig" in initialInputOrOptions)
    ) {
      const options = initialInputOrOptions as {
        initialInput?: Record<string, unknown>;
        cancellationToken?: CancellationToken;
        checkpoint?: WorkflowCheckpoint;
        checkpointConfig?: CheckpointConfig;
      };
      initialInput = options.initialInput ?? {};
      cancellationToken = options.cancellationToken ?? cancellationTokenArg;
      checkpoint = options.checkpoint;
      checkpointConfig = options.checkpointConfig;
    } else {
      initialInput = initialInputOrOptions as Record<string, unknown>;
      cancellationToken = cancellationTokenArg;
    }

    cancellationToken ??= new CancellationToken();
    this.cancellationTokens.set(workflow.id, cancellationToken);

    try {
    let execution: WorkflowExecution;

    // ---- Checkpoint resume vs. fresh start ----
    if (checkpoint) {
      const validation = this.validateCheckpoint(workflow, checkpoint);
      if (!validation.canResume) {
        yield new WorkflowFailedEvent(workflow.id, `Checkpoint validation failed: ${validation.errors.join("; ")}`);
        return;
      }
      execution = checkpoint.execution;
      execution.status = WorkflowStatus.RUNNING;
      yield new WorkflowResumedEvent(
        workflow.id,
        checkpoint.checkpointId,
        checkpoint.completedStepIds,
        checkpoint.pendingStepIds
      );
    } else {
      yield new WorkflowStartedEvent(workflow.id, initialInput);
      const validation = workflow.validateWorkflow();
      if (!validation.isValid) {
        yield new WorkflowFailedEvent(workflow.id, `Workflow validation failed: ${validation.errors.join("; ")}`);
        return;
      }
      if (Object.keys(initialInput).length > 0 && workflow.startStepId) {
        const startStep = workflow.steps[workflow.startStepId];
        if (startStep) {
          try {
            startStep.validateInputData(initialInput);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            yield new WorkflowFailedEvent(
              workflow.id,
              `Initial input validation failed: Input does not match start step '${workflow.startStepId}': ${message}`
            );
            return;
          }
        }
      }
      execution = {
        id: randomUUID(),
        workflowId: workflow.id,
        status: WorkflowStatus.RUNNING,
        startTime: new Date(),
        state: { ...workflow.initialState, ...initialInput },
        stepExecutions: {}
      };
    }

    // Steps already completed (from a resumed checkpoint).
    const completed = new Set<string>(
      Object.entries(execution.stepExecutions)
        .filter(([, exec]) => exec.status === StepStatus.COMPLETED)
        .map(([stepId]) => stepId)
    );

    // Tracks steps currently running this batch (for cancellation marking).
    const runningStepIds = new Set<string>();
    let stepsSinceLastCheckpoint = 0;

    try {
      while (completed.size < Object.keys(workflow.steps).length) {
        // Granular cancellation check before dispatching any new steps.
        if (cancellationToken?.isCancelled()) {
          const reason = this.cancellationReasons.get(workflow.id) ?? "Cancelled by user";
          // Mark currently-running steps as CANCELLED and emit a failed event per step.
          for (const stepId of runningStepIds) {
            const stepExecution = execution.stepExecutions[stepId];
            if (stepExecution && stepExecution.status === StepStatus.RUNNING) {
              stepExecution.status = StepStatus.CANCELLED;
              stepExecution.endTime = new Date();
              stepExecution.error = reason;
              yield new StepFailedEvent(
                workflow.id,
                stepId,
                reason,
                durationSeconds(stepExecution)
              );
            }
          }
          runningStepIds.clear();
          execution.status = WorkflowStatus.CANCELLED;
          execution.endTime = new Date();
          yield new WorkflowCancelledEvent(workflow.id, execution, reason);
          return;
        }

        const ready = workflow
          .getReadySteps(execution)
          .filter((stepId) => !completed.has(stepId))
          .slice(0, this.maxConcurrentSteps);
        if (!ready.length) {
          const remaining = Object.keys(workflow.steps).filter((stepId) => !completed.has(stepId));
          if (remaining.length) throw new Error(`Workflow stuck: remaining steps ${remaining.join(", ")} cannot be executed`);
          break;
        }

        // Shared async queue: progress events from running steps drain promptly.
        const progressQueue = new AsyncEventQueue<StepProgressEvent>();

        // Dispatch all ready steps; emit STEP_STARTED synchronously for each.
        // Each step promise is keyed so the resolved one can be removed from the
        // pending set after it wins a race.
        type RaceWinner =
          | { kind: "step"; key: string; result: StepResult }
          | { kind: "drain" }
          | { kind: "cancelled" };
        const pending = new Map<string, Promise<RaceWinner>>();
        let keyCounter = 0;
        for (const stepId of ready) {
          const step = workflow.steps[stepId]!;
          const inputData = prepareStepInput(stepId, workflow, execution, initialInput);
          const stepExecution: StepExecution = {
            stepId,
            status: StepStatus.RUNNING,
            startTime: new Date(),
            inputData,
            retryCount: 0
          };
          execution.stepExecutions[stepId] = stepExecution;
          runningStepIds.add(stepId);
          yield new StepStartedEvent(workflow.id, stepId, inputData);

          const context = Context.fromStateRef(execution.state, (progress) => {
            progressQueue.push(new StepProgressEvent(workflow.id, stepId, progress));
          });
          const key = `step_${keyCounter++}`;
          const tagged: Promise<RaceWinner> = step
            .run(inputData, {
              workflowState: execution.state,
              contextObject: context,
              cancellationToken
            })
            .then((outputData): StepResult => ({ stepId, status: "fulfilled", outputData }))
            .catch((error): StepResult => ({ stepId, status: "rejected", error }))
            .then((result): RaceWinner => ({ kind: "step", key, result }));
          pending.set(key, tagged);
        }

        // Race the in-flight steps against the progress drain so progress events
        // are yielded in near-real-time (mirrors Python's queue-drain approach).
        const results: StepResult[] = [];
        while (pending.size > 0) {
          const drainPromise: Promise<RaceWinner> = progressQueue
            .wait()
            .then((): RaceWinner => ({ kind: "drain" }));
          let cleanupCancellationWait: (() => void) | undefined;
          const cancellationPromise: Promise<RaceWinner> | undefined = cancellationToken
            ? new Promise((resolve) => {
                cleanupCancellationWait = cancellationToken!.addCallback(() => resolve({ kind: "cancelled" }));
              })
            : undefined;
          const winner = await Promise.race([
            ...pending.values(),
            drainPromise,
            ...(cancellationPromise ? [cancellationPromise] : [])
          ]);
          cleanupCancellationWait?.();

          // Drain and yield any queued progress events promptly.
          for (const progressEvent of progressQueue.drain()) {
            yield progressEvent;
          }

          if (winner.kind === "cancelled") {
            const reason = this.cancellationReasons.get(workflow.id) ?? "Cancelled by user";
            for (const stepId of runningStepIds) {
              const stepExecution = execution.stepExecutions[stepId];
              if (stepExecution && stepExecution.status === StepStatus.RUNNING) {
                stepExecution.status = StepStatus.CANCELLED;
                stepExecution.endTime = new Date();
                stepExecution.error = reason;
                yield new StepFailedEvent(
                  workflow.id,
                  stepId,
                  reason,
                  durationSeconds(stepExecution)
                );
              }
            }
            runningStepIds.clear();
            execution.status = WorkflowStatus.CANCELLED;
            execution.endTime = new Date();
            yield new WorkflowCancelledEvent(workflow.id, execution, reason);
            return;
          }

          if (winner.kind === "step") {
            results.push(winner.result);
            pending.delete(winner.key);
          }
        }

        // Final drain after all steps settle.
        for (const progressEvent of progressQueue.drain()) {
          yield progressEvent;
        }

        // Process results in completion order.
        for (const result of results) {
          runningStepIds.delete(result.stepId);
          const stepExecution = execution.stepExecutions[result.stepId]!;

          if (result.status === "rejected") {
            stepExecution.status = StepStatus.FAILED;
            stepExecution.endTime = new Date();
            stepExecution.error =
              result.error instanceof Error ? result.error.message : String(result.error);
            yield new StepFailedEvent(
              workflow.id,
              result.stepId,
              stepExecution.error,
              durationSeconds(stepExecution)
            );
            throw new Error(stepExecution.error);
          }

          stepExecution.status = StepStatus.COMPLETED;
          stepExecution.outputData = result.outputData;
          stepExecution.endTime = new Date();
          execution.state[`${result.stepId}_output`] = result.outputData;
          completed.add(result.stepId);
          yield new StepCompletedEvent(
            workflow.id,
            result.stepId,
            result.outputData!,
            durationSeconds(stepExecution)
          );
          for (const edge of workflow.edges.filter((edge) => edge.fromStep === result.stepId)) {
            yield new EdgeActivatedEvent(workflow.id, edge.fromStep, edge.toStep, result.outputData!);
          }

          // Auto-checkpoint logic.
          stepsSinceLastCheckpoint += 1;
          if (checkpointConfig && checkpointConfig.autoSave) {
            if (stepsSinceLastCheckpoint >= checkpointConfig.saveIntervalSteps) {
              const savedCheckpoint = this.createCheckpoint(workflow, execution, "auto");
              await checkpointConfig.store.save(savedCheckpoint);
              yield new CheckpointSavedEvent(
                workflow.id,
                savedCheckpoint.checkpointId,
                completed.size,
                Object.keys(workflow.steps).length
              );
              if (checkpointConfig.autoCleanup) {
                await checkpointConfig.store.cleanupOld(workflow.id, checkpointConfig.keepLastN);
              }
              stepsSinceLastCheckpoint = 0;
            }
          }
        }

        if (workflow.endStepIds.some((stepId) => completed.has(stepId))) break;
      }

      const incompleteExecutions = Object.values(execution.stepExecutions).filter(
        (stepExecution) => stepExecution.status !== StepStatus.COMPLETED
      );
      execution.endTime = new Date();
      if (!incompleteExecutions.length) {
        execution.status = WorkflowStatus.COMPLETED;
        yield new WorkflowCompletedEvent(workflow.id, execution);
      } else {
        execution.status = WorkflowStatus.FAILED;
        execution.error = `Workflow ${workflow.id} failed`;
        yield new WorkflowFailedEvent(workflow.id, execution.error, execution);
      }
    } catch (error) {
      execution.status = WorkflowStatus.FAILED;
      execution.endTime = new Date();
      execution.error = error instanceof Error ? error.message : String(error);
      yield new WorkflowFailedEvent(workflow.id, execution.error, execution);
    }
    } finally {
      if (this.cancellationTokens.get(workflow.id) === cancellationToken) {
        this.cancellationTokens.delete(workflow.id);
      }
      this.cancellationReasons.delete(workflow.id);
    }
  }

  /** Validate whether a checkpoint is compatible with a workflow. */
  validateCheckpoint(workflow: Workflow, checkpoint: WorkflowCheckpoint): CheckpointValidationResult {
    const result = new CheckpointValidationResult({ isValid: true, canResume: true });

    if (checkpoint.workflowId !== workflow.id) {
      result.warnings.push(
        `Checkpoint workflow_id '${checkpoint.workflowId}' differs from current workflow '${workflow.id}'. This is OK if you renamed the workflow.`
      );
    }

    const currentHash = workflow.computeStructureHash();
    if (checkpoint.workflowStructureHash !== currentHash) {
      result.errors.push(
        `Workflow structure has changed since checkpoint was created. Cannot safely resume. Checkpoint hash: ${checkpoint.workflowStructureHash}, Current hash: ${currentHash}`
      );
      result.isValid = false;
      result.canResume = false;
      return result;
    }

    for (const stepId of checkpoint.completedStepIds) {
      if (!workflow.steps[stepId]) {
        result.errors.push(`Checkpoint references completed step '${stepId}' that no longer exists in workflow`);
        result.isValid = false;
        result.canResume = false;
      }
    }

    result.checkpointInfo = {
      createdAt: checkpoint.createdAt.toISOString(),
      completedSteps: checkpoint.completedStepIds.length,
      pendingSteps: checkpoint.pendingStepIds.length,
      checkpointType: checkpoint.checkpointType
    };

    return result;
  }

  /** Create a checkpoint from the current execution state. */
  createCheckpoint(
    workflow: Workflow,
    execution: WorkflowExecution,
    checkpointType = "manual"
  ): WorkflowCheckpoint {
    return WorkflowCheckpoint.fromExecution({
      execution,
      workflowId: workflow.id,
      workflowVersion: workflow.metadata.version,
      workflowStructureHash: workflow.computeStructureHash(),
      allStepIds: Object.keys(workflow.steps),
      checkpointType
    });
  }

  async runStep(step: BaseStep, inputData: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return step.run(inputData, context);
  }

  async cancelWorkflow(workflowId: string, reason = "Cancelled by user"): Promise<boolean> {
    const cancellationToken = this.cancellationTokens.get(workflowId);
    if (!cancellationToken || cancellationToken.isCancelled()) return false;
    this.cancellationReasons.set(workflowId, reason);
    cancellationToken.cancel();
    return true;
  }

  getExecutionStatus(execution: WorkflowExecution): Record<string, unknown> {
    const values = Object.values(execution.stepExecutions);
    const totalSteps = values.length;
    const completedSteps = values.filter((step) => step.status === StepStatus.COMPLETED).length;
    const failedSteps = values.filter((step) => step.status === StepStatus.FAILED).length;
    const runningSteps = values.filter((step) => step.status === StepStatus.RUNNING).length;
    const durationSeconds =
      execution.startTime && execution.endTime
        ? (execution.endTime.getTime() - execution.startTime.getTime()) / 1000
        : undefined;
    return {
      executionId: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
      progress: {
        totalSteps,
        completedSteps,
        failedSteps,
        runningSteps,
        percentage: totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0
      },
      timing: {
        startTime: execution.startTime,
        endTime: execution.endTime,
        durationSeconds
      },
      error: execution.error,
      totalSteps,
      completedSteps,
      failedSteps,
      runningSteps
    };
  }
}

function normalizeEdgeCondition(condition?: EdgeCondition | Record<string, unknown>): EdgeCondition {
  if (!condition) return { type: "always" };
  const rawType = condition.type;
  const rawOperator = condition.operator;
  const type =
    rawType === "output_based"
      ? "outputBased"
      : rawType === "state_based"
        ? "stateBased"
        : rawType === "outputBased" || rawType === "stateBased" || rawType === "always"
          ? rawType
          : "always";
  const operator = rawOperator === "not_in" ? "notIn" : rawOperator;
  return {
    ...condition,
    type,
    operator: isEdgeOperator(operator) ? operator : undefined
  };
}

function isEdgeOperator(value: unknown): value is NonNullable<EdgeCondition["operator"]> {
  return value === "==" ||
    value === "!=" ||
    value === ">" ||
    value === "<" ||
    value === ">=" ||
    value === "<=" ||
    value === "in" ||
    value === "notIn";
}

function compareValues(left: unknown, operator: NonNullable<EdgeCondition["operator"]>, right: unknown): boolean {
  switch (operator) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case "in":
      return Array.isArray(right) ? right.includes(left) : String(right).includes(String(left));
    case "notIn":
      return Array.isArray(right) ? !right.includes(left) : !String(right).includes(String(left));
  }
}

function validateAndCoerceBySchema(
  data: Record<string, unknown>,
  schema: JsonSchema
): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("input must be an object");
  }
  const coerced: Record<string, unknown> = { ...data };
  for (const field of schema.required ?? []) {
    if (coerced[field] === undefined) {
      throw new Error(`required field '${field}' is missing`);
    }
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (coerced[field] === undefined) continue;
    const value = coerceValueToSchemaType(coerced[field], field, schema);
    if (!schemaValueAccepts(value, fieldSchema)) {
      throw new Error(`field '${field}' expected ${schemaTypeLabel(fieldSchema)}`);
    }
    coerced[field] = value;
  }
  return coerced;
}

function schemaValueAccepts(value: unknown, fieldSchema: JsonSchemaField): boolean {
  const candidates = Array.isArray(fieldSchema.anyOf) ? fieldSchema.anyOf : [fieldSchema];
  return candidates.some((candidate) => {
    const type = candidate.type;
    if (!type) return true;
    if (type === "null") return value === null;
    if (value === null || value === undefined) return false;
    if (type === "string") return typeof value === "string";
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "array") return Array.isArray(value);
    if (type === "object") return typeof value === "object" && !Array.isArray(value);
    return true;
  });
}

function schemaTypeLabel(fieldSchema: JsonSchemaField): string {
  if (fieldSchema.type) return fieldSchema.type;
  if (Array.isArray(fieldSchema.anyOf)) {
    return fieldSchema.anyOf.map((item) => item.type ?? "unknown").join(" | ");
  }
  return "unknown";
}

function areStepTypesCompatible(fromStep: BaseStep, toStep: BaseStep): boolean {
  if (fromStep.outputSchema && toStep.inputSchema) {
    return stableStringify(fromStep.outputSchema) === stableStringify(toStep.inputSchema);
  }
  if (fromStep.outputTypeName && toStep.inputTypeName) {
    return fromStep.outputTypeName === toStep.inputTypeName;
  }
  return true;
}

function stepTypeLabel(step: BaseStep, direction: "input" | "output"): string {
  const typeName = direction === "input" ? step.inputTypeName : step.outputTypeName;
  const schema = direction === "input" ? step.inputSchema : step.outputSchema;
  if (typeName) return typeName;
  if (schema?.title && typeof schema.title === "string") return schema.title;
  if (schema) return stableStringify(schema);
  return "unknown";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tryDumpWorkflowComponent(step: BaseStep): ComponentModel | undefined {
  try {
    return dumpComponent(step as unknown as { toConfig(): Record<string, unknown> });
  } catch {
    return undefined;
  }
}

function isComponentModel(value: unknown): value is ComponentModel {
  return Boolean(value && typeof value === "object" && "provider" in value && "config" in value);
}

function prepareStepInput(
  stepId: string,
  workflow: Workflow,
  execution: WorkflowExecution,
  initialInput: Record<string, unknown>
): Record<string, unknown> {
  if (stepId === workflow.startStepId) return { ...initialInput };
  const dependencies = workflow.getStepDependencies(stepId);
  for (const depId of dependencies) {
    const dep = execution.stepExecutions[depId];
    if (dep?.status === StepStatus.COMPLETED && dep.outputData) {
      return { ...dep.outputData };
    }
  }
  return { ...initialInput };
}

function durationSeconds(stepExecution?: StepExecution): number {
  if (!stepExecution?.startTime || !stepExecution.endTime) return 0;
  return (stepExecution.endTime.getTime() - stepExecution.startTime.getTime()) / 1000;
}

/** Result of a single dispatched step run. */
interface StepResult {
  stepId: string;
  status: "fulfilled" | "rejected";
  outputData?: Record<string, unknown>;
  error?: unknown;
}

/**
 * A minimal single-consumer async event queue.
 *
 * Producers `push()` events; the consumer `await`s `wait()` which resolves as
 * soon as at least one event is available, then `drain()`s all buffered events.
 * This lets the runner interleave step completion with prompt progress delivery
 * on JS's single-threaded event loop.
 */
class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private resolvers: Array<() => void> = [];

  push(item: T): void {
    this.buffer.push(item);
    const resolve = this.resolvers.shift();
    if (resolve) resolve();
  }

  /** Resolves when at least one item is available. */
  wait(): Promise<void> {
    if (this.buffer.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Return and clear all currently buffered items. */
  drain(): T[] {
    const items = this.buffer;
    this.buffer = [];
    return items;
  }
}

/**
 * Substitute `{field}` tokens in a template string with values from `data`.
 * Unknown fields are left untouched. Matches Python `defaults.py` reliance on
 * `static:...{content}...` interpolation in TransformStep.
 */
function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  if (!template.includes("{")) return template;
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const trimmed = key.trim();
    if (Object.prototype.hasOwnProperty.call(data, trimmed)) {
      const value = data[trimmed];
      return value === undefined || value === null ? "" : String(value);
    }
    return match;
  });
}

/** Error thrown when a step exceeds its configured timeout. Treated as fatal (never retried). */
export class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
