import { randomUUID } from "node:crypto";

export function shortUuid(): string {
  return randomUUID().slice(0, 8);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class DBRun {
  id: string;
  runType: "agent" | "orchestrator" | "eval_task" | string;
  agentName: string;
  model?: string;
  status: string;
  finishReason?: string;
  taskInput?: string;
  durationMs: number;
  tokensInput: number;
  tokensOutput: number;
  llmCalls: number;
  toolCalls: number;
  costEstimate?: number;
  traceId?: string;
  tags?: string[];
  parentRunId?: string;
  filePath?: string;
  createdAt: string;

  constructor(init: {
    id?: string;
    runType: "agent" | "orchestrator" | "eval_task" | string;
    agentName: string;
    model?: string;
    status?: string;
    finishReason?: string;
    taskInput?: string;
    durationMs?: number;
    tokensInput?: number;
    tokensOutput?: number;
    llmCalls?: number;
    toolCalls?: number;
    costEstimate?: number;
    traceId?: string;
    tags?: string[];
    parentRunId?: string;
    filePath?: string;
    createdAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.runType = init.runType;
    this.agentName = init.agentName;
    this.model = init.model;
    this.status = init.status ?? "completed";
    this.finishReason = init.finishReason;
    this.taskInput = init.taskInput;
    this.durationMs = init.durationMs ?? 0;
    this.tokensInput = init.tokensInput ?? 0;
    this.tokensOutput = init.tokensOutput ?? 0;
    this.llmCalls = init.llmCalls ?? 0;
    this.toolCalls = init.toolCalls ?? 0;
    this.costEstimate = init.costEstimate;
    this.traceId = init.traceId;
    this.tags = init.tags;
    this.parentRunId = init.parentRunId;
    this.filePath = init.filePath;
    this.createdAt = toIso(init.createdAt);
  }
}

export class DBDataset {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  categories: string[];
  defaultEvalCriteria: string[];
  taskCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;

  constructor(init: {
    id?: string;
    name: string;
    version?: string;
    description?: string;
    source?: string;
    categories?: string[];
    defaultEvalCriteria?: string[];
    taskCount?: number;
    metadata?: Record<string, unknown>;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.name = init.name;
    this.version = init.version ?? "1.0.0";
    this.description = init.description ?? "";
    this.source = init.source ?? "user";
    this.categories = init.categories ?? [];
    this.defaultEvalCriteria = init.defaultEvalCriteria ?? ["task_completion"];
    this.taskCount = init.taskCount ?? 0;
    this.metadata = init.metadata ?? {};
    this.createdAt = toIso(init.createdAt);
    this.updatedAt = toIso(init.updatedAt);
  }
}

export class DBTask {
  id: string;
  datasetId: string;
  name: string;
  input: string;
  expectedOutput?: string;
  category: string;
  evalCriteria: string[];
  rubric: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;

  constructor(init: {
    id?: string;
    datasetId: string;
    name?: string;
    input?: string;
    expectedOutput?: string;
    category?: string;
    evalCriteria?: string[];
    rubric?: Record<string, string>;
    metadata?: Record<string, unknown>;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.datasetId = init.datasetId;
    this.name = init.name ?? "";
    this.input = init.input ?? "";
    this.expectedOutput = init.expectedOutput;
    this.category = init.category ?? "general";
    this.evalCriteria = init.evalCriteria ?? [];
    this.rubric = init.rubric ?? {};
    this.metadata = init.metadata ?? {};
    this.createdAt = toIso(init.createdAt);
    this.updatedAt = toIso(init.updatedAt);
  }
}

export class DBTargetConfig {
  id: string;
  name: string;
  targetType: string;
  config: Record<string, unknown>;
  entityId?: string;
  description: string;
  createdAt: string;
  updatedAt: string;

  constructor(init: {
    id?: string;
    name: string;
    targetType?: string;
    config?: Record<string, unknown>;
    entityId?: string;
    description?: string;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.name = init.name;
    this.targetType = init.targetType ?? "picoagent";
    this.config = init.config ?? {};
    this.entityId = init.entityId;
    this.description = init.description ?? "";
    this.createdAt = toIso(init.createdAt);
    this.updatedAt = toIso(init.updatedAt);
  }
}

export class DBEvalRun {
  id: string;
  datasetId: string;
  datasetName: string;
  status: string;
  targetIds: string[];
  targetNames: string[];
  judgeType?: string;
  judgeConfig?: Record<string, unknown>;
  totalTasks: number;
  completedTasks: number;
  currentTarget?: string;
  currentTask?: string;
  errorMessage?: string;
  filePath?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;

  constructor(init: {
    id?: string;
    datasetId: string;
    datasetName?: string;
    status?: string;
    targetIds?: string[];
    targetNames?: string[];
    judgeType?: string;
    judgeConfig?: Record<string, unknown>;
    totalTasks?: number;
    completedTasks?: number;
    currentTarget?: string;
    currentTask?: string;
    errorMessage?: string;
    filePath?: string;
    startedAt?: string | Date;
    completedAt?: string | Date;
    createdAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.datasetId = init.datasetId;
    this.datasetName = init.datasetName ?? "";
    this.status = init.status ?? "pending";
    this.targetIds = init.targetIds ?? [];
    this.targetNames = init.targetNames ?? [];
    this.judgeType = init.judgeType;
    this.judgeConfig = init.judgeConfig;
    this.totalTasks = init.totalTasks ?? 0;
    this.completedTasks = init.completedTasks ?? 0;
    this.currentTarget = init.currentTarget;
    this.currentTask = init.currentTask;
    this.errorMessage = init.errorMessage;
    this.filePath = init.filePath;
    this.startedAt = init.startedAt ? toIso(init.startedAt) : undefined;
    this.completedAt = init.completedAt ? toIso(init.completedAt) : undefined;
    this.createdAt = toIso(init.createdAt);
  }
}

export class DBEvalResult {
  id: string;
  evalRunId: string;
  runId?: string;
  taskId: string;
  targetName: string;
  overallScore: number;
  dimensions: Record<string, number>;
  reasoning: Record<string, string>;
  success: boolean;
  error?: string;
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  toolCalls: number;
  createdAt: string;

  constructor(init: {
    id?: string;
    evalRunId: string;
    runId?: string;
    taskId: string;
    targetName: string;
    overallScore?: number;
    dimensions?: Record<string, number>;
    reasoning?: Record<string, string>;
    success?: boolean;
    error?: string;
    durationMs?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    iterations?: number;
    toolCalls?: number;
    createdAt?: string | Date;
  }) {
    this.id = init.id ?? shortUuid();
    this.evalRunId = init.evalRunId;
    this.runId = init.runId;
    this.taskId = init.taskId;
    this.targetName = init.targetName;
    this.overallScore = init.overallScore ?? 0;
    this.dimensions = init.dimensions ?? {};
    this.reasoning = init.reasoning ?? {};
    this.success = init.success ?? false;
    this.error = init.error;
    this.durationMs = init.durationMs ?? 0;
    this.totalTokens = init.totalTokens ?? 0;
    this.inputTokens = init.inputTokens ?? 0;
    this.outputTokens = init.outputTokens ?? 0;
    this.iterations = init.iterations ?? 0;
    this.toolCalls = init.toolCalls ?? 0;
    this.createdAt = toIso(init.createdAt);
  }
}

function toIso(value: string | Date | undefined): string {
  if (!value) return nowIso();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
