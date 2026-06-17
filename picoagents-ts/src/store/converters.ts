import type { BaseAgent } from "../agents/base.js";
import { AssistantMessage, Message, MultiModalMessage, ToolMessage } from "../messages.js";
import type { AgentResponse, OrchestrationResponse } from "../types.js";
import { Dataset } from "../eval/dataset.js";
import { EvalResults, TaskResult } from "../eval/results.js";
import { Task } from "../eval/types.js";
import {
  DBDataset,
  DBEvalResult,
  DBEvalRun,
  DBRun,
  DBTargetConfig,
  DBTask
} from "./models.js";

export interface AgentConfigLike {
  name: string;
  modelProvider?: string;
  modelName?: string;
  toConfig?: () => Record<string, unknown>;
}

export function agentResponseToDbRun(
  agent: BaseAgent | undefined,
  response: AgentResponse,
  traceId?: string,
  tags?: string[]
): DBRun {
  return new DBRun({
    runType: "agent",
    agentName: agent?.name ?? response.source,
    model: agent?.modelClient?.model,
    status: response.finishReason === "stop" ? "completed" : response.finishReason,
    finishReason: response.finishReason,
    taskInput: extractTaskInput(response.context?.messages ?? []),
    durationMs: response.usage.durationMs,
    tokensInput: response.usage.tokensInput,
    tokensOutput: response.usage.tokensOutput,
    llmCalls: response.usage.llmCalls,
    toolCalls: response.usage.toolCalls,
    costEstimate: response.usage.costEstimate,
    traceId,
    tags,
    createdAt: response.timestamp
  });
}

export function orchestrationResponseToDbRun(
  orchestrator: { name?: string; constructor: { name: string } },
  response: OrchestrationResponse,
  traceId?: string,
  tags?: string[]
): DBRun {
  return new DBRun({
    runType: "orchestrator",
    agentName: orchestrator.name || orchestrator.constructor.name,
    status: "completed",
    finishReason: response.stopMessage?.source ?? "completed",
    taskInput: extractTaskInput(response.messages),
    durationMs: response.usage.durationMs,
    tokensInput: response.usage.tokensInput,
    tokensOutput: response.usage.tokensOutput,
    llmCalls: response.usage.llmCalls,
    toolCalls: response.usage.toolCalls,
    costEstimate: response.usage.costEstimate,
    traceId,
    tags
  });
}

export function datasetToDb(dataset: Dataset): [DBDataset, DBTask[]] {
  const dbDataset = new DBDataset({
    name: dataset.name,
    version: dataset.version,
    description: dataset.description,
    source: "builtin",
    categories: dataset.categories,
    defaultEvalCriteria: dataset.defaultEvalCriteria,
    taskCount: dataset.tasks.length,
    metadata: dataset.metadata
  });
  const tasks = dataset.tasks.map(
    (task) =>
      new DBTask({
        id: task.id,
        datasetId: dbDataset.id,
        name: task.name,
        input: task.input,
        expectedOutput: task.expectedOutput,
        category: task.category,
        evalCriteria: task.evalCriteria,
        rubric: task.rubric,
        metadata: task.metadata
      })
  );
  return [dbDataset, tasks];
}

export function dbToDataset(dbDataset: DBDataset, dbTasks: DBTask[]): Dataset {
  return new Dataset({
    name: dbDataset.name,
    version: dbDataset.version,
    description: dbDataset.description,
    categories: dbDataset.categories,
    defaultEvalCriteria: dbDataset.defaultEvalCriteria,
    metadata: dbDataset.metadata,
    tasks: dbTasks.map(
      (task) =>
        new Task({
          id: task.id,
          name: task.name,
          input: task.input,
          expectedOutput: task.expectedOutput,
          category: task.category,
          evalCriteria: task.evalCriteria,
          rubric: task.rubric,
          metadata: task.metadata
        })
    )
  });
}

export function agentConfigToDbTarget(config: AgentConfigLike): DBTargetConfig {
  return new DBTargetConfig({
    name: config.name,
    targetType: "picoagent",
    config: typeof config.toConfig === "function" ? config.toConfig() : { ...config },
    description: [config.modelProvider, config.modelName].filter(Boolean).join("/") || ""
  });
}

export async function dbTargetToAgentConfig(dbTarget: DBTargetConfig): Promise<unknown> {
  const { AgentConfig } = await import("../eval/config.js");
  return AgentConfig.fromConfig(dbTarget.config ?? {});
}

export function taskResultToDbEvalResult(
  evalRunId: string,
  taskResult: TaskResult,
  runId?: string
): DBEvalResult {
  return new DBEvalResult({
    evalRunId,
    runId,
    taskId: taskResult.taskId,
    targetName: taskResult.targetName,
    overallScore: taskResult.score.overall,
    dimensions: taskResult.score.dimensions,
    reasoning: taskResult.score.reasoning,
    success: taskResult.trajectory.success,
    error: taskResult.trajectory.error,
    durationMs: taskResult.durationMs,
    totalTokens: taskResult.totalTokens,
    inputTokens: taskResult.inputTokens,
    outputTokens: taskResult.outputTokens,
    iterations: taskResult.iterations,
    toolCalls: taskResult.trajectory.usage?.toolCalls ?? 0
  });
}

export function evalResultsToDb(
  results: EvalResults,
  filePath?: string
): [DBEvalRun, DBEvalResult[]] {
  const evalRun = new DBEvalRun({
    id: results.runId,
    datasetId: "",
    datasetName: results.datasetName,
    status: "completed",
    targetNames: results.targetNames,
    totalTasks: results.taskIds.length * results.targetNames.length,
    completedTasks: results.taskIds.length * results.targetNames.length,
    filePath,
    completedAt: new Date()
  });

  const dbResults: DBEvalResult[] = [];
  for (const taskResults of Object.values(results.results)) {
    for (const taskResult of Object.values(taskResults)) {
      dbResults.push(taskResultToDbEvalResult(results.runId, taskResult));
    }
  }
  return [evalRun, dbResults];
}

export function serializeAgentResponse(response: AgentResponse): Record<string, unknown> {
  return {
    source: response.source,
    finishReason: response.finishReason,
    timestamp: response.timestamp.toISOString(),
    usage: serializeUsage(response.usage),
    context: response.context
      ? {
          sessionId: response.context.sessionId,
          metadata: response.context.metadata,
          sharedState: response.context.sharedState,
          environment: response.context.environment,
          messages: response.context.messages.map(serializeMessage)
        }
      : undefined
  };
}

export function serializeOrchestrationResponse(response: OrchestrationResponse): Record<string, unknown> {
  return {
    messages: response.messages.map(serializeMessage),
    finalResult: response.finalResult,
    usage: serializeUsage(response.usage),
    stopMessage: response.stopMessage,
    patternMetadata: response.patternMetadata
  };
}

function extractTaskInput(messages: Message[]): string | undefined {
  const user = messages.find((message) => message.role === "user");
  if (!user) return undefined;
  return user.content.length > 500 ? user.content.slice(0, 500) : user.content;
}

function serializeUsage(usage: {
  durationMs?: number;
  llmCalls?: number;
  tokensInput?: number;
  tokensOutput?: number;
  toolCalls?: number;
  memoryOperations?: number;
  costEstimate?: number;
}): Record<string, unknown> {
  return {
    durationMs: usage.durationMs,
    llmCalls: usage.llmCalls,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    toolCalls: usage.toolCalls,
    memoryOperations: usage.memoryOperations,
    costEstimate: usage.costEstimate
  };
}

function serializeMessage(message: Message): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: message.content,
    source: message.source,
    timestamp: message.timestamp.toISOString()
  };
  if (message instanceof AssistantMessage) {
    if (message.toolCalls?.length) {
      base.toolCalls = message.toolCalls.map((call) => ({
        toolName: call.toolName,
        parameters: call.parameters,
        callId: call.callId
      }));
    }
    if (message.structuredContent !== undefined) base.structuredContent = message.structuredContent;
    if (message.usage) base.usage = serializeUsage(message.usage);
  } else if (message instanceof ToolMessage) {
    base.toolCallId = message.toolCallId;
    base.toolName = message.toolName;
    base.success = message.success;
    base.error = message.error;
    base.metadata = message.metadata;
  } else if (message instanceof MultiModalMessage) {
    base.mimeType = message.mimeType;
    base.mediaUrl = message.mediaUrl;
    base.metadata = message.metadata;
  }
  return base;
}
