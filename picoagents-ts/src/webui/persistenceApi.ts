import { createReadStream, existsSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { listBuiltinDatasets, loadBuiltinDataset } from "../eval/dataset.js";
import type { PicoStore } from "../store/index.js";
import type {
  DBDataset,
  DBEvalResult,
  DBEvalRun,
  DBRun,
  DBTargetConfig,
  DBTask
} from "../store/models.js";
import type { EvalJobManager } from "./evalJobs.js";

export interface PersistenceApiContext {
  pathname: string;
  method: string;
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  headers: Record<string, string>;
  store?: PicoStore | null;
  evalJobs?: EvalJobManager;
}

export async function handlePersistenceApi(context: PersistenceApiContext): Promise<void> {
  if (!context.store) {
    sendJson(context.response, 503, { detail: "Persistence not available" }, context.headers);
    return;
  }

  const { pathname, method } = context;

  const runDataMatch = pathname.match(/^\/api\/runs\/([^/]+)\/data$/);
  if (runDataMatch && method === "GET") return getRunData(context, runDataMatch[1]!);

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") return getRun(context, runMatch[1]!);
  if (runMatch && method === "DELETE") return deleteRun(context, runMatch[1]!);
  if (pathname === "/api/runs" && method === "GET") return listRuns(context);

  if (pathname === "/api/eval/builtin-datasets" && method === "GET") return listBuiltins(context);
  if (pathname === "/api/eval/datasets/import" && method === "POST") return importBuiltin(context);

  const taskMatch = pathname.match(/^\/api\/eval\/datasets\/([^/]+)\/tasks\/([^/]+)$/);
  if (taskMatch && method === "PUT") return updateTask(context, taskMatch[1]!, taskMatch[2]!);
  if (taskMatch && method === "DELETE") return deleteTask(context, taskMatch[1]!, taskMatch[2]!);

  const addTaskMatch = pathname.match(/^\/api\/eval\/datasets\/([^/]+)\/tasks$/);
  if (addTaskMatch && method === "POST") return addTask(context, addTaskMatch[1]!);

  const datasetMatch = pathname.match(/^\/api\/eval\/datasets\/([^/]+)$/);
  if (datasetMatch && method === "GET") return getDataset(context, datasetMatch[1]!);
  if (datasetMatch && method === "DELETE") return deleteDataset(context, datasetMatch[1]!);
  if (pathname === "/api/eval/datasets" && method === "GET") return listDatasets(context);
  if (pathname === "/api/eval/datasets" && method === "POST") return createDataset(context);

  const targetMatch = pathname.match(/^\/api\/eval\/targets\/([^/]+)$/);
  if (targetMatch && method === "GET") return getTarget(context, targetMatch[1]!);
  if (targetMatch && method === "DELETE") return deleteTarget(context, targetMatch[1]!);
  if (pathname === "/api/eval/targets" && method === "GET") return listTargets(context);
  if (pathname === "/api/eval/targets" && method === "POST") return createTarget(context);

  const evalExportMatch = pathname.match(/^\/api\/eval\/runs\/([^/]+)\/export$/);
  if (evalExportMatch && method === "GET") return exportEvalRun(context, evalExportMatch[1]!);

  const evalCancelMatch = pathname.match(/^\/api\/eval\/runs\/([^/]+)\/cancel$/);
  if (evalCancelMatch && method === "POST") return cancelEvalRun(context, evalCancelMatch[1]!);

  const evalResultMatch = pathname.match(/^\/api\/eval\/runs\/([^/]+)\/results\/([^/]+)$/);
  if (evalResultMatch && method === "GET") return getEvalResult(context, evalResultMatch[2]!);

  const evalResultsMatch = pathname.match(/^\/api\/eval\/runs\/([^/]+)\/results$/);
  if (evalResultsMatch && method === "GET") return getEvalResults(context, evalResultsMatch[1]!);

  const evalRunMatch = pathname.match(/^\/api\/eval\/runs\/([^/]+)$/);
  if (evalRunMatch && method === "GET") return getEvalRun(context, evalRunMatch[1]!);
  if (pathname === "/api/eval/runs" && method === "GET") return listEvalRuns(context);
  if (pathname === "/api/eval/runs" && method === "POST") return startEvalRun(context);

  sendJson(context.response, 404, { detail: "Persistence item not found" }, context.headers);
}

async function listRuns({ store, url, response, headers }: PersistenceApiContext): Promise<void> {
  const runs = await store!.listRuns({
    runType: url.searchParams.get("run_type") ?? url.searchParams.get("runType") ?? undefined,
    agentName: url.searchParams.get("agent_name") ?? url.searchParams.get("agentName") ?? undefined,
    limit: intParam(url, "limit", 50),
    offset: intParam(url, "offset", 0)
  });
  sendJson(response, 200, runs.map(runToJson), headers);
}

async function getRun({ store, response, headers }: PersistenceApiContext, runId: string): Promise<void> {
  const run = await store!.getRun(runId);
  if (!run) return sendJson(response, 404, { detail: "Run not found" }, headers);
  sendJson(response, 200, runToJson(run), headers);
}

async function getRunData({ store, response, headers }: PersistenceApiContext, runId: string): Promise<void> {
  const data = await store!.getRunData(runId);
  if (!data) return sendJson(response, 404, { detail: "Run data not found" }, headers);
  sendJson(response, 200, runDataToJson(data), headers);
}

async function deleteRun({ store, response, headers }: PersistenceApiContext, runId: string): Promise<void> {
  const deleted = await store!.deleteRun(runId);
  if (!deleted) return sendJson(response, 404, { detail: "Run not found" }, headers);
  sendJson(response, 200, { status: "deleted", runId }, headers);
}

async function listDatasets({ store, response, headers }: PersistenceApiContext): Promise<void> {
  const datasets = await store!.listDatasets();
  sendJson(response, 200, datasets.map((dataset) => datasetToJson(dataset)), headers);
}

async function createDataset({ store, request, response, headers }: PersistenceApiContext): Promise<void> {
  const body = await readJson<Record<string, any>>(request);
  if (!body.name) return sendJson(response, 400, { detail: "name is required" }, headers);
  const dataset = await store!.createDataset({
    name: String(body.name),
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
    version: body.version,
    description: body.description,
    source: body.source,
    categories: body.categories,
    defaultEvalCriteria: body.default_eval_criteria ?? body.defaultEvalCriteria
  });
  sendJson(response, 200, datasetToJson(dataset, dataset.tasks), headers);
}

async function importBuiltin({ store, request, response, headers }: PersistenceApiContext): Promise<void> {
  const body = await readJson<{ name?: string }>(request);
  if (!body.name) return sendJson(response, 400, { detail: "name is required" }, headers);
  try {
    const dataset = await store!.importBuiltinDataset(body.name);
    sendJson(response, 200, datasetToJson(dataset, dataset.tasks), headers);
  } catch (error) {
    sendJson(response, 404, { detail: error instanceof Error ? error.message : String(error) }, headers);
  }
}

async function listBuiltins({ response, headers }: PersistenceApiContext): Promise<void> {
  const names = await listBuiltinDatasets();
  const datasets = [];
  for (const name of names) {
    try {
      const dataset = await loadBuiltinDataset(name);
      datasets.push({
        name,
        description: dataset.description,
        taskCount: dataset.tasks.length,
        categories: dataset.categories
      });
    } catch {
      datasets.push({ name, description: "", taskCount: 0, categories: [] });
    }
  }
  sendJson(response, 200, datasets, headers);
}

async function getDataset({ store, response, headers }: PersistenceApiContext, datasetId: string): Promise<void> {
  const dataset = await store!.getDataset(datasetId);
  if (!dataset) return sendJson(response, 404, { detail: "Dataset not found" }, headers);
  sendJson(response, 200, datasetToJson(dataset, dataset.tasks), headers);
}

async function deleteDataset({ store, response, headers }: PersistenceApiContext, datasetId: string): Promise<void> {
  const deleted = await store!.deleteDataset(datasetId);
  if (!deleted) return sendJson(response, 404, { detail: "Dataset not found" }, headers);
  sendJson(response, 200, { status: "deleted", datasetId }, headers);
}

async function addTask({ store, request, response, headers }: PersistenceApiContext, datasetId: string): Promise<void> {
  const body = await readJson<Record<string, any>>(request);
  const task = await store!.addTask(datasetId, body);
  if (!task) return sendJson(response, 404, { detail: "Dataset not found" }, headers);
  sendJson(response, 200, taskToJson(task), headers);
}

async function updateTask({ store, request, response, headers }: PersistenceApiContext, _datasetId: string, taskId: string): Promise<void> {
  const updates = await readJson<Record<string, any>>(request);
  const task = await store!.updateTask(taskId, updates);
  if (!task) return sendJson(response, 404, { detail: "Task not found" }, headers);
  sendJson(response, 200, taskToJson(task), headers);
}

async function deleteTask({ store, response, headers }: PersistenceApiContext, _datasetId: string, taskId: string): Promise<void> {
  const deleted = await store!.deleteTask(taskId);
  if (!deleted) return sendJson(response, 404, { detail: "Task not found" }, headers);
  sendJson(response, 200, { status: "deleted", taskId }, headers);
}

async function listTargets({ store, response, headers }: PersistenceApiContext): Promise<void> {
  const targets = await store!.listTargetConfigs();
  sendJson(response, 200, targets.map(targetToJson), headers);
}

async function createTarget({ store, request, response, headers }: PersistenceApiContext): Promise<void> {
  const body = await readJson<Record<string, any>>(request);
  if (!body.name) return sendJson(response, 400, { detail: "name is required" }, headers);
  const target = await store!.createTargetConfig({
    name: String(body.name),
    targetType: body.target_type ?? body.targetType,
    config: body.config,
    entityId: body.entity_id ?? body.entityId,
    description: body.description
  });
  sendJson(response, 200, targetToJson(target), headers);
}

async function getTarget({ store, response, headers }: PersistenceApiContext, targetId: string): Promise<void> {
  const target = await store!.getTargetConfig(targetId);
  if (!target) return sendJson(response, 404, { detail: "Target not found" }, headers);
  sendJson(response, 200, targetToJson(target), headers);
}

async function deleteTarget({ store, response, headers }: PersistenceApiContext, targetId: string): Promise<void> {
  const deleted = await store!.deleteTargetConfig(targetId);
  if (!deleted) return sendJson(response, 404, { detail: "Target not found" }, headers);
  sendJson(response, 200, { status: "deleted", targetId }, headers);
}

async function listEvalRuns({ store, response, headers }: PersistenceApiContext): Promise<void> {
  const runs = await store!.listEvalRuns();
  sendJson(response, 200, runs.map(evalRunToJson), headers);
}

async function startEvalRun({ store, evalJobs, request, response, headers }: PersistenceApiContext): Promise<void> {
  if (!evalJobs) return sendJson(response, 503, { detail: "Eval job manager not available" }, headers);
  const body = await readJson<Record<string, any>>(request);
  const datasetId = String(body.dataset_id ?? body.datasetId ?? "");
  const targetIds = Array.isArray(body.target_ids) ? body.target_ids.map(String) : Array.isArray(body.targetIds) ? body.targetIds.map(String) : [];
  if (!datasetId) return sendJson(response, 400, { detail: "datasetId is required" }, headers);
  if (!targetIds.length) return sendJson(response, 400, { detail: "targetIds is required" }, headers);

  const dataset = await store!.getDataset(datasetId);
  if (!dataset) return sendJson(response, 404, { detail: "Dataset not found" }, headers);

  const targetNames: string[] = [];
  for (const targetId of targetIds) {
    const target = await store!.getTargetConfig(targetId);
    targetNames.push(target?.name ?? targetId);
  }

  const judgeConfig = body.judge_config ?? body.judgeConfig;
  const evalRun = await store!.createEvalRun({
    datasetId,
    datasetName: dataset.name,
    targetIds,
    targetNames,
    totalTasks: dataset.taskCount * targetIds.length,
    judgeType: isRecord(judgeConfig) ? String(judgeConfig.type ?? "") || undefined : undefined,
    judgeConfig: isRecord(judgeConfig) ? judgeConfig : undefined
  });
  await evalJobs.startEvalRun(evalRun.id, datasetId, targetIds, isRecord(judgeConfig) ? judgeConfig : undefined);
  sendJson(response, 200, evalRunToJson(evalRun), headers);
}

async function getEvalRun({ store, response, headers }: PersistenceApiContext, evalRunId: string): Promise<void> {
  const run = await store!.getEvalRun(evalRunId);
  if (!run) return sendJson(response, 404, { detail: "Eval run not found" }, headers);
  sendJson(response, 200, evalRunToJson(run), headers);
}

async function getEvalResults({ store, response, headers }: PersistenceApiContext, evalRunId: string): Promise<void> {
  const results = await store!.getEvalResults(evalRunId);
  sendJson(response, 200, results.map(evalResultToJson), headers);
}

async function getEvalResult({ store, response, headers }: PersistenceApiContext, resultId: string): Promise<void> {
  const result = await store!.getEvalResult(resultId);
  if (!result) return sendJson(response, 404, { detail: "Result not found" }, headers);
  sendJson(response, 200, evalResultToJson(result), headers);
}

async function cancelEvalRun({ evalJobs, response, headers }: PersistenceApiContext, evalRunId: string): Promise<void> {
  if (!evalJobs) return sendJson(response, 503, { detail: "Eval job manager not available" }, headers);
  const cancelled = await evalJobs.cancelEvalRun(evalRunId);
  if (!cancelled) return sendJson(response, 404, { detail: "Eval run not found or not running" }, headers);
  sendJson(response, 200, { status: "cancelled", evalRunId }, headers);
}

async function exportEvalRun({ store, response, headers }: PersistenceApiContext, evalRunId: string): Promise<void> {
  const run = await store!.getEvalRun(evalRunId);
  if (!run) return sendJson(response, 404, { detail: "Eval run not found" }, headers);
  if (!run.filePath) return sendJson(response, 404, { detail: "No export file available" }, headers);
  if (!existsSync(run.filePath)) return sendJson(response, 404, { detail: "Export file not found on disk" }, headers);
  response.writeHead(200, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="eval_${evalRunId}.json"`
  });
  createReadStream(run.filePath).pipe(response);
}

function runToJson(run: DBRun): Record<string, unknown> {
  return {
    id: run.id,
    runType: run.runType,
    agentName: run.agentName,
    model: run.model,
    status: run.status,
    finishReason: run.finishReason,
    taskInput: run.taskInput,
    durationMs: run.durationMs,
    tokensInput: run.tokensInput,
    tokensOutput: run.tokensOutput,
    llmCalls: run.llmCalls,
    toolCalls: run.toolCalls,
    costEstimate: run.costEstimate,
    traceId: run.traceId,
    tags: run.tags,
    parentRunId: run.parentRunId,
    filePath: run.filePath,
    createdAt: run.createdAt
  };
}

function runDataToJson(data: Record<string, any>): Record<string, unknown> {
  const response = data.response && typeof data.response === "object" ? { ...data.response } : {};
  if (!response.messages && response.context?.messages) response.messages = response.context.messages;
  return {
    runId: data.run_id ?? data.runId,
    runType: data.run_type ?? data.runType,
    agentName: data.agent_name ?? data.agentName,
    model: data.model,
    finishReason: data.finish_reason ?? data.finishReason,
    createdAt: data.created_at ?? data.createdAt,
    response
  };
}

function datasetToJson(dataset: DBDataset, tasks?: DBTask[]): Record<string, unknown> {
  return {
    id: dataset.id,
    name: dataset.name,
    version: dataset.version,
    description: dataset.description,
    source: dataset.source,
    categories: dataset.categories,
    defaultEvalCriteria: dataset.defaultEvalCriteria,
    taskCount: dataset.taskCount,
    metadata: dataset.metadata,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    ...(tasks ? { tasks: tasks.map(taskToJson) } : {})
  };
}

function taskToJson(task: DBTask): Record<string, unknown> {
  return {
    id: task.id,
    datasetId: task.datasetId,
    name: task.name,
    input: task.input,
    expectedOutput: task.expectedOutput,
    category: task.category,
    evalCriteria: task.evalCriteria,
    rubric: task.rubric,
    metadata: task.metadata,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function targetToJson(target: DBTargetConfig): Record<string, unknown> {
  return {
    id: target.id,
    name: target.name,
    targetType: target.targetType,
    config: target.config,
    entityId: target.entityId,
    description: target.description,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt
  };
}

function evalRunToJson(run: DBEvalRun): Record<string, unknown> {
  return {
    id: run.id,
    datasetId: run.datasetId,
    datasetName: run.datasetName,
    status: run.status,
    targetIds: run.targetIds,
    targetNames: run.targetNames,
    judgeType: run.judgeType,
    judgeConfig: run.judgeConfig,
    totalTasks: run.totalTasks,
    completedTasks: run.completedTasks,
    currentTarget: run.currentTarget,
    currentTask: run.currentTask,
    errorMessage: run.errorMessage,
    filePath: run.filePath,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt
  };
}

function evalResultToJson(result: DBEvalResult): Record<string, unknown> {
  return {
    id: result.id,
    evalRunId: result.evalRunId,
    runId: result.runId,
    taskId: result.taskId,
    targetName: result.targetName,
    overallScore: result.overallScore,
    dimensions: result.dimensions,
    reasoning: result.reasoning,
    success: result.success,
    error: result.error,
    durationMs: result.durationMs,
    totalTokens: result.totalTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    createdAt: result.createdAt
  };
}

function intParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}
