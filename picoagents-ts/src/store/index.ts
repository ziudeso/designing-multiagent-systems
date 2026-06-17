import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BaseAgent } from "../agents/base.js";
import { loadBuiltinDataset } from "../eval/dataset.js";
import type { EvalResults, TaskResult } from "../eval/results.js";
import type { AgentResponse, OrchestrationResponse } from "../types.js";
import {
  agentResponseToDbRun,
  datasetToDb,
  evalResultsToDb,
  orchestrationResponseToDbRun,
  serializeAgentResponse,
  serializeOrchestrationResponse,
  taskResultToDbEvalResult
} from "./converters.js";
import {
  DBDataset,
  DBEvalResult,
  DBEvalRun,
  DBRun,
  DBTargetConfig,
  DBTask,
  nowIso
} from "./models.js";

export * from "./models.js";
export * from "./converters.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".picoagents");

type TableName = "runs" | "datasets" | "tasks" | "targetConfigs" | "evalRuns" | "evalResults";

interface TableSpec<T> {
  sqlName: string;
  ctor: new (init: any) => T;
  columns: string[];
  jsonColumns: Set<string>;
  boolColumns?: Set<string>;
}

const TABLES: Record<TableName, TableSpec<any>> = {
  runs: {
    sqlName: "runs",
    ctor: DBRun,
    columns: [
      "id",
      "runType",
      "agentName",
      "model",
      "status",
      "finishReason",
      "taskInput",
      "durationMs",
      "tokensInput",
      "tokensOutput",
      "llmCalls",
      "toolCalls",
      "costEstimate",
      "traceId",
      "tags",
      "parentRunId",
      "filePath",
      "createdAt"
    ],
    jsonColumns: new Set(["tags"])
  },
  datasets: {
    sqlName: "datasets",
    ctor: DBDataset,
    columns: [
      "id",
      "name",
      "version",
      "description",
      "source",
      "categories",
      "defaultEvalCriteria",
      "taskCount",
      "metadata",
      "createdAt",
      "updatedAt"
    ],
    jsonColumns: new Set(["categories", "defaultEvalCriteria", "metadata"])
  },
  tasks: {
    sqlName: "tasks",
    ctor: DBTask,
    columns: [
      "id",
      "datasetId",
      "name",
      "input",
      "expectedOutput",
      "category",
      "evalCriteria",
      "rubric",
      "metadata",
      "createdAt",
      "updatedAt"
    ],
    jsonColumns: new Set(["evalCriteria", "rubric", "metadata"])
  },
  targetConfigs: {
    sqlName: "target_configs",
    ctor: DBTargetConfig,
    columns: ["id", "name", "targetType", "config", "entityId", "description", "createdAt", "updatedAt"],
    jsonColumns: new Set(["config"])
  },
  evalRuns: {
    sqlName: "eval_runs",
    ctor: DBEvalRun,
    columns: [
      "id",
      "datasetId",
      "datasetName",
      "status",
      "targetIds",
      "targetNames",
      "judgeType",
      "judgeConfig",
      "totalTasks",
      "completedTasks",
      "currentTarget",
      "currentTask",
      "errorMessage",
      "filePath",
      "startedAt",
      "completedAt",
      "createdAt"
    ],
    jsonColumns: new Set(["targetIds", "targetNames", "judgeConfig"])
  },
  evalResults: {
    sqlName: "eval_results",
    ctor: DBEvalResult,
    columns: [
      "id",
      "evalRunId",
      "runId",
      "taskId",
      "targetName",
      "overallScore",
      "dimensions",
      "reasoning",
      "success",
      "error",
      "durationMs",
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "iterations",
      "toolCalls",
      "createdAt"
    ],
    jsonColumns: new Set(["dimensions", "reasoning"]),
    boolColumns: new Set(["success"])
  }
};

interface StoreBackend {
  initialize(): Promise<void>;
  close(): Promise<void>;
  insert<T>(table: TableName, row: T): Promise<T>;
  update<T>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined>;
  get<T>(table: TableName, id: string): Promise<T | undefined>;
  all<T>(table: TableName): Promise<T[]>;
  delete(table: TableName, id: string): Promise<boolean>;
}

export interface PicoStoreOptions {
  /** SQLite path. Defaults to `~/.picoagents/picoagents.db`. */
  dbPath?: string;
  /** Python-compatible sqlite connection string. Only sqlite URLs are supported. */
  connectionString?: string;
  /** Directory for full agent/orchestrator run JSON payloads. */
  runsDir?: string;
  /** Directory for full eval JSON payloads. */
  evalDir?: string;
  /** Force the dependency-free JSON index fallback, useful for tests or old Node runtimes. */
  forceJsonIndex?: boolean;
}

export interface SaveRunOptions {
  traceId?: string;
  tags?: string[];
}

export interface ListRunsOptions {
  runType?: string;
  agentName?: string;
  limit?: number;
  offset?: number;
}

export interface CreateDatasetOptions {
  name: string;
  tasks?: Array<Record<string, any>>;
  version?: string;
  description?: string;
  source?: string;
  categories?: string[];
  defaultEvalCriteria?: string[];
}

export interface CreateTargetConfigOptions {
  name: string;
  targetType?: string;
  config?: Record<string, unknown>;
  entityId?: string;
  description?: string;
}

export interface CreateEvalRunOptions {
  datasetId: string;
  datasetName: string;
  targetIds: string[];
  targetNames: string[];
  totalTasks: number;
  judgeType?: string;
  judgeConfig?: Record<string, unknown>;
}

export interface UpdateEvalRunProgressOptions {
  completedTasks?: number;
  currentTarget?: string;
  currentTask?: string;
  status?: string;
  errorMessage?: string;
  filePath?: string;
  startedAt?: string | Date;
  completedAt?: string | Date;
}

export interface AgentRunStore {
  saveAgentRun(agent: BaseAgent, response: AgentResponse, options?: SaveRunOptions): Promise<string | void>;
}

export class PicoStore implements AgentRunStore {
  readonly dbPath: string;
  readonly runsDir: string;
  readonly evalDir: string;
  readonly connectionString: string;
  private backend?: StoreBackend;
  private initialized = false;
  private readonly forceJsonIndex: boolean;

  constructor(options: PicoStoreOptions | string = {}) {
    const opts: PicoStoreOptions = typeof options === "string" ? { connectionString: options } : options;
    const defaultDbPath = path.join(DEFAULT_DB_DIR, "picoagents.db");
    this.dbPath = opts.dbPath ?? parseSqliteConnectionString(opts.connectionString) ?? defaultDbPath;
    this.connectionString = opts.connectionString ?? `sqlite:///${this.dbPath}`;
    this.runsDir = opts.runsDir ?? path.join(DEFAULT_DB_DIR, "runs");
    this.evalDir = opts.evalDir ?? path.join(DEFAULT_DB_DIR, "eval");
    this.forceJsonIndex = opts.forceJsonIndex ?? false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(this.evalDir, { recursive: true });
    this.backend = await createBackend(this.dbPath, this.forceJsonIndex);
    await this.backend.initialize();
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.backend) await this.backend.close();
    this.initialized = false;
    this.backend = undefined;
  }

  async saveAgentRun(
    agentOrResponse: BaseAgent | AgentResponse,
    responseOrOptions?: AgentResponse | SaveRunOptions,
    maybeOptions: SaveRunOptions = {}
  ): Promise<string> {
    await this.initialize();
    const hasAgent = isAgentResponse(agentOrResponse) === false;
    const agent = hasAgent ? (agentOrResponse as BaseAgent) : undefined;
    const response = hasAgent
      ? (responseOrOptions as AgentResponse)
      : (agentOrResponse as AgentResponse);
    const options = hasAgent ? maybeOptions : ((responseOrOptions as SaveRunOptions | undefined) ?? {});

    const dbRun = agentResponseToDbRun(agent, response, options.traceId, options.tags);
    const filePath = path.join(this.runsDir, `run_${dbRun.id}.json`);
    const jsonData = {
      runId: dbRun.id,
      runType: "agent",
      agentName: dbRun.agentName,
      model: dbRun.model,
      finishReason: response.finishReason,
      createdAt: response.timestamp.toISOString(),
      response: serializeAgentResponse(response)
    };
    await writeJson(filePath, jsonData);
    dbRun.filePath = filePath;
    await this.backend!.insert("runs", dbRun);
    return dbRun.id;
  }

  async saveOrchestratorRun(
    orchestrator: { name?: string; constructor: { name: string } },
    response: OrchestrationResponse,
    options: SaveRunOptions = {}
  ): Promise<string> {
    await this.initialize();
    const dbRun = orchestrationResponseToDbRun(orchestrator, response, options.traceId, options.tags);
    const filePath = path.join(this.runsDir, `run_${dbRun.id}.json`);
    await writeJson(filePath, {
      runId: dbRun.id,
      runType: "orchestrator",
      agentName: dbRun.agentName,
      finishReason: dbRun.finishReason,
      createdAt: nowIso(),
      response: serializeOrchestrationResponse(response)
    });
    dbRun.filePath = filePath;
    await this.backend!.insert("runs", dbRun);
    return dbRun.id;
  }

  async listRuns(options: ListRunsOptions = {}): Promise<DBRun[]> {
    await this.initialize();
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    return (await this.backend!.all<DBRun>("runs"))
      .filter((run) => !options.runType || run.runType === options.runType)
      .filter((run) => !options.agentName || run.agentName === options.agentName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit);
  }

  async getRun(runId: string): Promise<DBRun | undefined> {
    await this.initialize();
    return this.backend!.get<DBRun>("runs", runId);
  }

  async getRunData(runId: string): Promise<Record<string, unknown> | undefined> {
    const run = await this.getRun(runId);
    if (!run?.filePath || !fsSync.existsSync(run.filePath)) return undefined;
    return JSON.parse(await fs.readFile(run.filePath, "utf8"));
  }

  async deleteRun(runId: string): Promise<boolean> {
    await this.initialize();
    const run = await this.getRun(runId);
    if (!run) return false;
    if (run.filePath) await fs.rm(run.filePath, { force: true });
    return this.backend!.delete("runs", runId);
  }

  async createDataset(options: CreateDatasetOptions): Promise<DBDataset & { tasks: DBTask[] }> {
    await this.initialize();
    const tasks = options.tasks ?? [];
    const dataset = new DBDataset({
      name: options.name,
      version: options.version,
      description: options.description,
      source: options.source,
      categories: options.categories ?? unique(tasks.map((task) => String(task.category ?? "general"))),
      defaultEvalCriteria: options.defaultEvalCriteria,
      taskCount: tasks.length
    });
    const dbTasks = tasks.map((task) => makeTask(dataset.id, task));
    await this.backend!.insert("datasets", dataset);
    for (const task of dbTasks) await this.backend!.insert("tasks", task);
    return Object.assign(dataset, { tasks: dbTasks });
  }

  async importBuiltinDataset(name: string): Promise<DBDataset & { tasks: DBTask[] }> {
    const dataset = await loadBuiltinDataset(name);
    const [dbDataset, dbTasks] = datasetToDb(dataset);
    dbDataset.source = "builtin";
    await this.initialize();
    await this.backend!.insert("datasets", dbDataset);
    for (const task of dbTasks) await this.backend!.insert("tasks", task);
    return Object.assign(dbDataset, { tasks: dbTasks });
  }

  async listDatasets(): Promise<DBDataset[]> {
    await this.initialize();
    return (await this.backend!.all<DBDataset>("datasets")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDataset(datasetId: string): Promise<(DBDataset & { tasks: DBTask[] }) | undefined> {
    await this.initialize();
    const dataset = await this.backend!.get<DBDataset>("datasets", datasetId);
    if (!dataset) return undefined;
    const tasks = (await this.backend!.all<DBTask>("tasks")).filter((task) => task.datasetId === datasetId);
    return Object.assign(dataset, { tasks });
  }

  async deleteDataset(datasetId: string): Promise<boolean> {
    await this.initialize();
    const dataset = await this.backend!.get<DBDataset>("datasets", datasetId);
    if (!dataset) return false;
    const tasks = (await this.backend!.all<DBTask>("tasks")).filter((task) => task.datasetId === datasetId);
    for (const task of tasks) await this.backend!.delete("tasks", task.id);
    return this.backend!.delete("datasets", datasetId);
  }

  async addTask(datasetId: string, taskData: Record<string, any>): Promise<DBTask | undefined> {
    await this.initialize();
    const dataset = await this.backend!.get<DBDataset>("datasets", datasetId);
    if (!dataset) return undefined;
    const task = makeTask(datasetId, taskData);
    await this.backend!.insert("tasks", task);
    await this.backend!.update<DBDataset>("datasets", datasetId, {
      taskCount: dataset.taskCount + 1,
      updatedAt: nowIso()
    });
    return task;
  }

  async updateTask(taskId: string, updates: Record<string, any>): Promise<DBTask | undefined> {
    await this.initialize();
    const normalized = normalizeTaskUpdates(updates);
    normalized.updatedAt = nowIso();
    return this.backend!.update<DBTask>("tasks", taskId, normalized as Partial<DBTask>);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    await this.initialize();
    const task = await this.backend!.get<DBTask>("tasks", taskId);
    if (!task) return false;
    const deleted = await this.backend!.delete("tasks", taskId);
    const dataset = await this.backend!.get<DBDataset>("datasets", task.datasetId);
    if (dataset) {
      await this.backend!.update<DBDataset>("datasets", dataset.id, {
        taskCount: Math.max(0, dataset.taskCount - 1),
        updatedAt: nowIso()
      });
    }
    return deleted;
  }

  async createTargetConfig(options: CreateTargetConfigOptions): Promise<DBTargetConfig> {
    await this.initialize();
    const config = new DBTargetConfig(options);
    await this.backend!.insert("targetConfigs", config);
    return config;
  }

  async listTargetConfigs(): Promise<DBTargetConfig[]> {
    await this.initialize();
    return (await this.backend!.all<DBTargetConfig>("targetConfigs")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getTargetConfig(configId: string): Promise<DBTargetConfig | undefined> {
    await this.initialize();
    return this.backend!.get<DBTargetConfig>("targetConfigs", configId);
  }

  async deleteTargetConfig(configId: string): Promise<boolean> {
    await this.initialize();
    return this.backend!.delete("targetConfigs", configId);
  }

  async createEvalRun(options: CreateEvalRunOptions): Promise<DBEvalRun> {
    await this.initialize();
    const run = new DBEvalRun(options);
    await this.backend!.insert("evalRuns", run);
    return run;
  }

  async listEvalRuns(): Promise<DBEvalRun[]> {
    await this.initialize();
    return (await this.backend!.all<DBEvalRun>("evalRuns")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getEvalRun(evalRunId: string): Promise<DBEvalRun | undefined> {
    await this.initialize();
    return this.backend!.get<DBEvalRun>("evalRuns", evalRunId);
  }

  async updateEvalRunProgress(evalRunId: string, updates: UpdateEvalRunProgressOptions): Promise<void> {
    await this.initialize();
    const normalized = { ...updates };
    if (normalized.startedAt) normalized.startedAt = new Date(normalized.startedAt).toISOString();
    if (normalized.completedAt) normalized.completedAt = new Date(normalized.completedAt).toISOString();
    await this.backend!.update<DBEvalRun>("evalRuns", evalRunId, normalized as Partial<DBEvalRun>);
  }

  async saveEvalRunFromResults(results: EvalResults, filePath?: string): Promise<string> {
    await this.initialize();
    const targetPath =
      filePath ?? path.join(this.evalDir, `eval_${results.runId}_${new Date(results.timestamp).toISOString().replace(/[:.]/g, "-")}.json`);
    if (!filePath) await results.save(targetPath);
    const [run, dbResults] = evalResultsToDb(results, targetPath);
    await this.backend!.insert("evalRuns", run);
    for (const result of dbResults) await this.backend!.insert("evalResults", result);
    return run.id;
  }

  async saveEvalResult(evalRunId: string, taskResult: TaskResult, runId?: string): Promise<string> {
    await this.initialize();
    const result = taskResultToDbEvalResult(evalRunId, taskResult, runId);
    await this.backend!.insert("evalResults", result);
    return result.id;
  }

  async getEvalResults(evalRunId: string): Promise<DBEvalResult[]> {
    await this.initialize();
    return (await this.backend!.all<DBEvalResult>("evalResults")).filter((result) => result.evalRunId === evalRunId);
  }

  async getEvalResult(resultId: string): Promise<DBEvalResult | undefined> {
    await this.initialize();
    return this.backend!.get<DBEvalResult>("evalResults", resultId);
  }
}

let defaultStore: AgentRunStore | PicoStore | null | undefined;

export function setDefaultStore(store: AgentRunStore | PicoStore | null): void {
  defaultStore = store;
}

export function getDefaultStore(): AgentRunStore | PicoStore | null {
  if (defaultStore === undefined) defaultStore = new PicoStore();
  return defaultStore;
}

class SqliteBackend implements StoreBackend {
  private db?: any;
  constructor(private readonly dbPath: string, private readonly sqliteModule: any) {}

  async initialize(): Promise<void> {
    const DatabaseSync = this.sqliteModule.DatabaseSync;
    this.db = new DatabaseSync(this.dbPath);
    for (const [name, spec] of Object.entries(TABLES) as Array<[TableName, TableSpec<any>]>) {
      const columns = spec.columns.map((column) => `${quoteIdent(column)} ${columnType(column, spec)}`).join(", ");
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${spec.sqlName} (${columns}, PRIMARY KEY(id))`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${spec.sqlName}_createdAt ON ${spec.sqlName}(createdAt)`);
      if (name === "runs") this.db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_runType ON runs(runType)`);
      if (name === "tasks") this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_datasetId ON tasks(datasetId)`);
      if (name === "evalResults") this.db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_results_evalRunId ON eval_results(evalRunId)`);
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async insert<T>(table: TableName, row: T): Promise<T> {
    const spec = TABLES[table];
    const cols = spec.columns.filter((column) => column in (row as Record<string, unknown>));
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO ${spec.sqlName} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...cols.map((column) => encodeColumn(spec, column, (row as any)[column])));
    return row;
  }

  async update<T>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const spec = TABLES[table];
    const cols = spec.columns.filter((column) => column !== "id" && column in (updates as Record<string, unknown>));
    if (!cols.length) return this.get<T>(table, id);
    const assignments = cols.map((column) => `${quoteIdent(column)} = ?`).join(", ");
    this.db.prepare(`UPDATE ${spec.sqlName} SET ${assignments} WHERE id = ?`).run(
      ...cols.map((column) => encodeColumn(spec, column, (updates as any)[column])),
      id
    );
    return this.get<T>(table, id);
  }

  async get<T>(table: TableName, id: string): Promise<T | undefined> {
    const spec = TABLES[table];
    const row = this.db.prepare(`SELECT * FROM ${spec.sqlName} WHERE id = ?`).get(id);
    return row ? hydrate(spec, row) as T : undefined;
  }

  async all<T>(table: TableName): Promise<T[]> {
    const spec = TABLES[table];
    return this.db.prepare(`SELECT * FROM ${spec.sqlName}`).all().map((row: any) => hydrate(spec, row) as T);
  }

  async delete(table: TableName, id: string): Promise<boolean> {
    const spec = TABLES[table];
    const result = this.db.prepare(`DELETE FROM ${spec.sqlName} WHERE id = ?`).run(id);
    return Number(result.changes ?? 0) > 0;
  }
}

class JsonIndexBackend implements StoreBackend {
  private data: Record<TableName, any[]> = {
    runs: [],
    datasets: [],
    tasks: [],
    targetConfigs: [],
    evalRuns: [],
    evalResults: []
  };

  constructor(private readonly indexPath: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
    } catch {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  async insert<T>(table: TableName, row: T): Promise<T> {
    const rows = this.data[table];
    const index = rows.findIndex((item) => item.id === (row as any).id);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    await this.flush();
    return row;
  }

  async update<T>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const rows = this.data[table];
    const index = rows.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    rows[index] = { ...rows[index], ...updates };
    await this.flush();
    return rows[index] as T;
  }

  async get<T>(table: TableName, id: string): Promise<T | undefined> {
    return this.data[table].find((item) => item.id === id) as T | undefined;
  }

  async all<T>(table: TableName): Promise<T[]> {
    return [...this.data[table]] as T[];
  }

  async delete(table: TableName, id: string): Promise<boolean> {
    const before = this.data[table].length;
    this.data[table] = this.data[table].filter((item) => item.id !== id);
    await this.flush();
    return this.data[table].length !== before;
  }

  private async flush(): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(this.data, null, 2));
  }
}

async function createBackend(dbPath: string, forceJsonIndex: boolean): Promise<StoreBackend> {
  if (!forceJsonIndex) {
    const sqlite = await loadNodeSqlite();
    if (sqlite?.DatabaseSync) return new SqliteBackend(dbPath, sqlite);
  }
  return new JsonIndexBackend(dbPath.replace(/\.db$/, ".json"));
}

async function loadNodeSqlite(): Promise<any | undefined> {
  try {
    const moduleName = "node:sqlite";
    return await import(moduleName);
  } catch {
    return undefined;
  }
}

function parseSqliteConnectionString(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  for (const prefix of ["sqlite+aiosqlite:///", "sqlite:///"]) {
    if (connectionString.startsWith(prefix)) return connectionString.slice(prefix.length);
  }
  if (connectionString.startsWith("sqlite+aiosqlite://")) return connectionString.slice("sqlite+aiosqlite://".length);
  if (connectionString.startsWith("sqlite://")) return connectionString.slice("sqlite://".length);
  throw new Error(`Unsupported PicoStore connection string: ${connectionString}`);
}

function makeTask(datasetId: string, taskData: Record<string, any>): DBTask {
  return new DBTask({
    id: taskData.id,
    datasetId,
    name: taskData.name,
    input: taskData.input,
    expectedOutput: taskData.expectedOutput ?? taskData.expected_output,
    category: taskData.category,
    evalCriteria: taskData.evalCriteria ?? taskData.eval_criteria,
    rubric: taskData.rubric,
    metadata: taskData.metadata
  });
}

function normalizeTaskUpdates(updates: Record<string, any>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key === "expected_output") normalized.expectedOutput = value;
    else if (key === "eval_criteria") normalized.evalCriteria = value;
    else normalized[key] = value;
  }
  return normalized;
}

function isAgentResponse(value: unknown): value is AgentResponse {
  return Boolean(value && typeof value === "object" && "finishReason" in value && "usage" in value && "source" in value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function columnType(column: string, spec: TableSpec<any>): string {
  if (column === "id") return "TEXT";
  if (spec.jsonColumns.has(column)) return "TEXT";
  if (spec.boolColumns?.has(column)) return "INTEGER";
  if (["durationMs", "tokensInput", "tokensOutput", "llmCalls", "toolCalls", "taskCount", "totalTasks", "completedTasks", "iterations", "totalTokens", "inputTokens", "outputTokens"].includes(column)) return "INTEGER";
  if (["costEstimate", "overallScore"].includes(column)) return "REAL";
  return "TEXT";
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function encodeColumn(spec: TableSpec<any>, column: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (spec.jsonColumns.has(column)) return JSON.stringify(value ?? null);
  if (spec.boolColumns?.has(column)) return value ? 1 : 0;
  return value;
}

function hydrate<T>(spec: TableSpec<T>, row: Record<string, unknown>): T {
  const data: Record<string, unknown> = {};
  for (const column of spec.columns) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (spec.jsonColumns.has(column)) {
      try {
        const parsed = JSON.parse(String(value));
        data[column] = parsed === null ? undefined : parsed;
      } catch {
        data[column] = undefined;
      }
    } else if (spec.boolColumns?.has(column)) {
      data[column] = Boolean(value);
    } else {
      data[column] = value;
    }
  }
  return new spec.ctor(data);
}
