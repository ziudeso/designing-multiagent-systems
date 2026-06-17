/**
 * TypeScript types for PicoAgents persistence, runs, and evaluation.
 * Aligned with store/_models.py DB tables.
 */

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface Run {
  id: string;
  runType: "agent" | "orchestrator" | "eval_task";
  agentName: string;
  model?: string;
  status: "completed" | "error" | "cancelled";
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
}

export interface RunData {
  runId: string;
  runType: string;
  agentName: string;
  model?: string;
  response: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface Dataset {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "user" | "builtin" | "generated";
  categories?: string[];
  defaultEvalCriteria?: string[];
  taskCount: number;
  metadata?: Record<string, any>;
  tasks?: EvalTask[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalTask {
  id: string;
  datasetId: string;
  name: string;
  input: string;
  expectedOutput?: string;
  category: string;
  evalCriteria?: string[];
  rubric?: Record<string, any>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface BuiltinDataset {
  name: string;
  description: string;
  taskCount: number;
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Target Configs
// ---------------------------------------------------------------------------

export interface TargetConfig {
  id: string;
  name: string;
  targetType: "picoagent" | "claude_code" | "discovered_agent";
  config?: Record<string, any>;
  entityId?: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Eval Runs
// ---------------------------------------------------------------------------

export interface EvalRun {
  id: string;
  datasetId: string;
  datasetName: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  targetIds?: string[];
  targetNames?: string[];
  judgeType?: string;
  judgeConfig?: Record<string, any>;
  totalTasks: number;
  completedTasks: number;
  currentTarget?: string;
  currentTask?: string;
  errorMessage?: string;
  filePath?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Eval Results
// ---------------------------------------------------------------------------

export interface EvalResult {
  id: string;
  evalRunId: string;
  runId?: string;
  taskId: string;
  targetName: string;
  overallScore: number;
  dimensions?: Record<string, number>;
  reasoning?: Record<string, string>;
  success: boolean;
  error?: string;
  durationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  toolCalls: number;
  createdAt: string;
}
