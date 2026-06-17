#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssistantMessage, UserMessage } from "./messages.js";
import { PicoStore, setDefaultStore } from "./store/index.js";
import { Usage } from "./types.js";
import { webui } from "./webui/index.js";
import {
  AgentConfig,
  CallableTarget,
  ContainsJudge,
  Dataset,
  EvalJudge,
  EvalRunner,
  EvalScore,
  ExactMatchJudge,
  FuzzyMatchJudge,
  LLMEvalJudge,
  PicoAgentTarget,
  RunTrajectory,
  Task,
  Target,
  listBuiltinDatasets,
  listEvalResults,
  loadBuiltinDataset,
  loadEvalResults,
  printResults
} from "./eval/index.js";
import type { AgentConfigInit } from "./eval/config.js";
import type { DBTargetConfig, DBTask, DBDataset } from "./store/models.js";

interface ParsedArgs {
  flags: Set<string>;
  values: Record<string, string>;
  lists: Record<string, string[]>;
  positional: string[];
}

const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    printMainHelp();
    return command ? 0 : 1;
  }
  if (command === "--version" || command === "-v") {
    console.log(`picoagents-ts ${VERSION}`);
    return 0;
  }

  if (command === "ui") {
    await handleUi(argv.slice(1));
    return 0;
  }
  if (command === "eval") {
    await handleEval(argv.slice(1));
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function handleUi(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    valueOptions: new Set(["dir", "port", "host", "static-dir"]),
    flagOptions: new Set(["no-open", "help"]),
    aliases: { p: "port", h: "help" }
  });

  if (parsed.flags.has("help")) {
    printUiHelp();
    return;
  }

  const entitiesDir = path.resolve(parsed.values.dir ?? ".");
  if (!existsSync(entitiesDir)) throw new Error(`Directory does not exist: ${entitiesDir}`);
  if (!statSync(entitiesDir).isDirectory()) throw new Error(`Path is not a directory: ${entitiesDir}`);

  await webui({
    entitiesDir,
    port: numberOption(parsed.values.port, 8080),
    host: parsed.values.host ?? "127.0.0.1",
    autoOpen: !parsed.flags.has("no-open"),
    staticDir: parsed.values["static-dir"]
  });
}

async function handleEval(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    printEvalHelp();
    if (!action) throw new UsageError("Missing eval action");
    return;
  }

  if (action === "list") {
    await evalList(argv.slice(1));
    return;
  }
  if (action === "run") {
    await evalRun(argv.slice(1));
    return;
  }
  if (action === "results") {
    await evalResults(argv.slice(1));
    return;
  }

  throw new Error(`Unknown eval action: ${action}`);
}

async function evalList(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    valueOptions: new Set(["store-dir"]),
    flagOptions: new Set(["json", "help"]),
    aliases: { h: "help" }
  });
  if (parsed.flags.has("help")) {
    printEvalListHelp();
    return;
  }

  const store = createStore(parsed.values["store-dir"]);
  try {
    const [builtins, datasets, targets] = await Promise.all([
      listBuiltinDatasets(),
      store.listDatasets(),
      store.listTargetConfigs()
    ]);

    if (parsed.flags.has("json")) {
      console.log(JSON.stringify({ builtinDatasets: builtins, datasets, targets }, null, 2));
      return;
    }

    console.log("Available Evaluation Datasets");
    console.log("=".repeat(50));
    printNameList("Built-in datasets", builtins);
    printRecordList("Persisted datasets", datasets, (dataset) =>
      `${dataset.name} (${dataset.taskCount} tasks, id: ${dataset.id})`
    );
    printRecordList("Targets", targets, (target) =>
      `${target.name} (${target.targetType}, id: ${target.id})`
    );
    console.log();
    console.log("Usage:");
    console.log("  picoagents-ts eval run <dataset_name_or_path>");
    console.log("  picoagents-ts eval run <dataset_id> --target <target_id>");
  } finally {
    await store.close();
  }
}

async function evalRun(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    valueOptions: new Set([
      "configs",
      "output",
      "baseline",
      "task-filter",
      "judge",
      "judge-model",
      "judge-provider",
      "store-dir"
    ]),
    repeatedValueOptions: new Set(["target"]),
    flagOptions: new Set(["parallel-tasks", "parallel-targets", "no-persist", "help"]),
    aliases: { c: "configs", o: "output", h: "help" }
  });

  if (parsed.flags.has("help")) {
    printEvalRunHelp();
    return;
  }

  const datasetName = parsed.positional[0];
  if (!datasetName) throw new UsageError("Missing dataset name or path");

  const store = createStore(parsed.values["store-dir"]);
  setDefaultStore(store);
  try {
    const dataset = await loadDataset(datasetName, store);
    console.log(`Dataset: ${dataset.name} (${dataset.tasks.length} tasks)`);

    const targets = await loadTargets(parsed, store);
    if (!targets.length) throw new Error("No targets configured");
    console.log(`Targets: ${targets.map((target) => target.name).join(", ")}`);

    const judge = createJudge(parsed);
    console.log(`Judge: ${judge.name}`);

    const runner = new EvalRunner(judge, {
      parallelTasks: parsed.flags.has("parallel-tasks"),
      parallelTargets: parsed.flags.has("parallel-targets")
    });

    const taskFilter = parsed.values["task-filter"]
      ? (task: Task) => task.category === parsed.values["task-filter"]
      : undefined;
    if (parsed.values["task-filter"]) {
      console.log(`Filtering tasks by category: ${parsed.values["task-filter"]}`);
    }

    console.log();
    console.log("Running evaluation...");
    const results = await runner.run(dataset, targets, { taskFilter });

    console.log();
    printResults(results, {
      baseline: parsed.values.baseline ?? targets[0]?.name,
      showTaskBreakdown: true,
      showFileAnalysis: true
    });

    const outputDir = path.resolve(parsed.values.output ?? ".picoagents/eval");
    const outputPath = path.join(outputDir, `eval_${results.runId}_${formatTimestamp(results.timestamp)}.json`);
    await results.save(outputPath);
    console.log();
    console.log(`Results saved to: ${outputPath}`);

    if (!parsed.flags.has("no-persist")) {
      const evalRunId = await store.saveEvalRunFromResults(results, outputPath);
      console.log(`Persisted eval run: ${evalRunId}`);
    }
  } finally {
    setDefaultStore(null);
    await store.close();
  }
}

async function evalResults(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    valueOptions: new Set(["dir", "store-dir"]),
    flagOptions: new Set(["show-breakdown", "show-files", "help"]),
    aliases: { h: "help" }
  });

  if (parsed.flags.has("help")) {
    printEvalResultsHelp();
    return;
  }

  const maybePathOrRunId = parsed.positional[0];
  const store = createStore(parsed.values["store-dir"]);
  try {
    if (maybePathOrRunId) {
      const resultPath = await resolveResultPath(maybePathOrRunId, store);
      console.log(`Loading results from: ${resultPath}`);
      const loaded = await loadEvalResults(resultPath);
      printResults(loaded, {
        showTaskBreakdown: parsed.flags.has("show-breakdown"),
        showFileAnalysis: parsed.flags.has("show-files")
      });
      return;
    }

    const resultsDir = path.resolve(parsed.values.dir ?? ".picoagents/eval");
    const files = await listEvalResults(resultsDir);
    const runs = await store.listEvalRuns();

    if (!files.length && !runs.length) {
      console.log(`No evaluation results found in: ${resultsDir}`);
      return;
    }

    console.log("Evaluation Results");
    console.log("=".repeat(50));
    if (files.length) {
      console.log("Files:");
      for (const file of files) console.log(`  - ${file}`);
    }
    if (runs.length) {
      console.log("Persisted runs:");
      for (const run of runs) {
        console.log(`  - ${run.id} ${run.datasetName} [${run.status}] ${run.completedTasks}/${run.totalTasks}`);
      }
    }
    console.log();
    console.log("View a result:");
    console.log("  picoagents-ts eval results <path_or_eval_run_id>");
  } finally {
    await store.close();
  }
}

async function loadDataset(identifier: string, store: PicoStore): Promise<Dataset> {
  const candidatePath = path.resolve(identifier);
  if (existsSync(candidatePath)) {
    console.log(`Loading dataset from: ${candidatePath}`);
    return Dataset.fromJson(candidatePath);
  }

  try {
    console.log(`Loading built-in dataset: ${identifier}`);
    return await loadBuiltinDataset(identifier);
  } catch {
    const datasets = await store.listDatasets();
    const match = datasets.find((dataset) => dataset.id === identifier || dataset.name === identifier);
    if (!match) {
      throw new Error(`Dataset not found: ${identifier}. Use 'picoagents-ts eval list' to see available datasets.`);
    }
    console.log(`Loading persisted dataset: ${match.name} (${match.id})`);
    const loaded = await store.getDataset(match.id);
    if (!loaded) throw new Error(`Dataset not found in store: ${identifier}`);
    return datasetFromDb(loaded);
  }
}

async function loadTargets(parsed: ParsedArgs, store: PicoStore): Promise<Target[]> {
  const targets: Target[] = [];

  for (const identifier of parsed.lists.target ?? []) {
    const config = await findTargetConfig(store, identifier);
    targets.push(targetFromConfig(config));
  }

  if (parsed.values.configs) {
    const entries = await readConfigEntries(parsed.values.configs);
    targets.push(...entries.map(targetFromConfigEntry));
  }

  if (!targets.length) {
    targets.push(
      new PicoAgentTarget(new AgentConfig({ name: "baseline", compaction: null })),
      new PicoAgentTarget(new AgentConfig({ name: "head_tail", compaction: "head_tail" }))
    );
  }

  return targets;
}

async function readConfigEntries(configPath: string): Promise<Array<Record<string, unknown> | string>> {
  const resolved = path.resolve(configPath);
  const data = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.configs)) return data.configs;
  if (isRecord(data)) {
    return Object.entries(data).map(([name, config]) =>
      isRecord(config) ? { name, ...config } : { name, response: String(config), targetType: "static" }
    );
  }
  throw new Error(`Invalid config file: ${resolved}`);
}

async function findTargetConfig(store: PicoStore, identifier: string): Promise<DBTargetConfig> {
  const direct = await store.getTargetConfig(identifier);
  if (direct) return direct;
  const targets = await store.listTargetConfigs();
  const match = targets.find((target) => target.name === identifier);
  if (!match) throw new Error(`Target not found: ${identifier}`);
  return match;
}

function targetFromConfig(target: DBTargetConfig): Target {
  if (target.targetType === "picoagent" || !target.targetType) {
    return new PicoAgentTarget(new AgentConfig(normalizeAgentConfig({
      name: target.name,
      ...target.config
    })));
  }
  if (target.targetType === "static" || target.targetType === "callable") {
    return makeStaticTarget(target.name, stringValue(target.config.response));
  }
  throw new Error(`Target type '${target.targetType}' is not runnable from the CLI`);
}

function targetFromConfigEntry(entry: Record<string, unknown> | string): Target {
  if (typeof entry === "string") return new PicoAgentTarget(AgentConfig.fromString(entry));
  if (entry.targetType === "static" || entry.target_type === "static" || entry.type === "static" || "response" in entry) {
    return makeStaticTarget(String(entry.name ?? "static"), stringValue(entry.response));
  }
  return new PicoAgentTarget(new AgentConfig(normalizeAgentConfig(entry)));
}

function makeStaticTarget(name: string, configuredResponse?: string): Target {
  return new CallableTarget(name, async (task) => {
    const response = configuredResponse ?? task.expectedOutput ?? task.input;
    return new RunTrajectory({
      task,
      messages: [
        new UserMessage({ content: task.input, source: "user" }),
        new AssistantMessage({ content: response, source: name })
      ],
      success: true,
      usage: new Usage({ durationMs: 1, llmCalls: 0, tokensInput: 0, tokensOutput: 0 }),
      metadata: { target_type: "static", target_name: name }
    });
  });
}

function createJudge(parsed: ParsedArgs): EvalJudge {
  const judgeType = parsed.values.judge ?? "mock";
  if (judgeType === "mock") return new MockJudge();
  if (judgeType === "contains" || judgeType === "reference") return new ContainsJudge();
  if (judgeType === "exact" || judgeType === "exact_match") return new ExactMatchJudge();
  if (judgeType === "fuzzy") return new FuzzyMatchJudge();
  if (judgeType === "llm") {
    const config = new AgentConfig({
      name: "judge",
      modelProvider: parsed.values["judge-provider"] ?? "openai",
      modelName: parsed.values["judge-model"] ?? "gpt-4o-mini"
    });
    return new LLMEvalJudge(config.createModelClient());
  }
  throw new Error(`Unknown judge: ${judgeType}`);
}

class MockJudge extends EvalJudge {
  constructor() {
    super("mock_judge");
  }

  async score(trajectory: RunTrajectory, criteria?: string[]): Promise<EvalScore> {
    const dimensions = criteria?.length ? criteria : trajectory.task.evalCriteria.length ? trajectory.task.evalCriteria : ["task_completion"];
    return new EvalScore({
      overall: 0,
      dimensions: Object.fromEntries(dimensions.map((criterion) => [criterion, 0])),
      reasoning: Object.fromEntries(dimensions.map((criterion) => [criterion, "Mock judge - no LLM configured"])),
      trajectory,
      metadata: { mock: true }
    });
  }
}

function datasetFromDb(dataset: DBDataset & { tasks: DBTask[] }): Dataset {
  return new Dataset({
    name: dataset.name,
    version: dataset.version,
    description: dataset.description,
    categories: dataset.categories,
    defaultEvalCriteria: dataset.defaultEvalCriteria,
    metadata: dataset.metadata,
    tasks: dataset.tasks.map((task) => new Task({
      id: task.id,
      name: task.name,
      input: task.input,
      expectedOutput: task.expectedOutput,
      category: task.category,
      evalCriteria: task.evalCriteria,
      rubric: task.rubric,
      metadata: task.metadata
    }))
  });
}

async function resolveResultPath(pathOrRunId: string, store: PicoStore): Promise<string> {
  const candidatePath = path.resolve(pathOrRunId);
  if (existsSync(candidatePath)) return candidatePath;
  const run = await store.getEvalRun(pathOrRunId);
  if (!run?.filePath) throw new Error(`Result not found: ${pathOrRunId}`);
  return run.filePath;
}

function createStore(storeDir?: string): PicoStore {
  if (!storeDir) return new PicoStore();
  const root = path.resolve(storeDir);
  return new PicoStore({
    dbPath: path.join(root, "picoagents.db"),
    runsDir: path.join(root, "runs"),
    evalDir: path.join(root, "eval")
  });
}

function parseArgs(
  argv: string[],
  options: {
    valueOptions?: Set<string>;
    repeatedValueOptions?: Set<string>;
    flagOptions?: Set<string>;
    aliases?: Record<string, string>;
  }
): ParsedArgs {
  const valueOptions = options.valueOptions ?? new Set<string>();
  const repeatedValueOptions = options.repeatedValueOptions ?? new Set<string>();
  const flagOptions = options.flagOptions ?? new Set<string>();
  const aliases = options.aliases ?? {};
  const parsed: ParsedArgs = { flags: new Set(), values: {}, lists: {}, positional: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("-")) {
      parsed.positional.push(raw);
      continue;
    }

    const [optionToken, inlineValue] = raw.startsWith("--")
      ? raw.slice(2).split("=", 2)
      : [aliases[raw.slice(1)] ?? raw.slice(1), undefined];
    const option = optionToken ?? "";

    if (flagOptions.has(option)) {
      parsed.flags.add(option);
      continue;
    }
    if (valueOptions.has(option) || repeatedValueOptions.has(option)) {
      const value = inlineValue ?? argv[++index];
      if (!value) throw new UsageError(`Missing value for --${option}`);
      if (repeatedValueOptions.has(option)) {
        parsed.lists[option] = [...(parsed.lists[option] ?? []), value];
      } else {
        parsed.values[option] = value;
      }
      continue;
    }

    throw new UsageError(`Unknown option: ${raw}`);
  }

  return parsed;
}

function normalizeAgentConfig(config: Record<string, unknown>): AgentConfigInit {
  const extraKwargs = config.extraKwargs ?? config.extra_kwargs;
  return {
    name: String(config.name ?? "target"),
    modelProvider: stringValue(config.modelProvider ?? config.model_provider ?? config.provider),
    modelName: stringValue(config.modelName ?? config.model_name ?? config.model),
    compaction: nullableString(config.compaction ?? config.strategy),
    tokenBudget: numberValue(config.tokenBudget ?? config.token_budget),
    headRatio: numberValue(config.headRatio ?? config.head_ratio),
    systemPrompt: stringValue(config.systemPrompt ?? config.system_prompt ?? config.instructions),
    instructionPreset: stringValue(config.instructionPreset ?? config.instruction_preset),
    tools: Array.isArray(config.tools) ? config.tools.map(String) : undefined,
    maxIterations: numberValue(config.maxIterations ?? config.max_iterations),
    temperature: numberValue(config.temperature),
    workspace: stringValue(config.workspace),
    bashTimeout: numberValue(config.bashTimeout ?? config.bash_timeout),
    extraKwargs: isRecord(extraKwargs) ? extraKwargs : undefined
  };
}

function numberOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`Invalid number: ${value}`);
  return parsed;
}

function printNameList(title: string, values: string[]): void {
  console.log();
  console.log(`${title}:`);
  if (!values.length) {
    console.log("  (none)");
    return;
  }
  for (const value of values) console.log(`  - ${value}`);
}

function printRecordList<T>(title: string, values: T[], format: (value: T) => string): void {
  console.log();
  console.log(`${title}:`);
  if (!values.length) {
    console.log("  (none)");
    return;
  }
  for (const value of values) console.log(`  - ${format(value)}`);
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class UsageError extends Error {}

function printMainHelp(): void {
  console.log(`PicoAgents - Lightweight AI agent framework

Usage:
  picoagents-ts <command> [options]

Commands:
  ui      Launch web interface
  eval    Run evaluations and inspect results

Examples:
  picoagents-ts ui --dir ./agents
  picoagents-ts eval list
  picoagents-ts eval run coding_v1
  picoagents-ts eval results
`);
}

function printUiHelp(): void {
  console.log(`Launch PicoAgents WebUI

Usage:
  picoagents-ts ui [options]

Options:
  --dir <path>          Directory to scan for agents/orchestrators/workflows (default: .)
  --port, -p <number>  Port to run server on (default: 8080)
  --host <host>        Host to bind server to (default: 127.0.0.1)
  --static-dir <path>  Directory containing a built frontend
  --no-open            Do not automatically open a browser
  --help, -h           Show this help
`);
}

function printEvalHelp(): void {
  console.log(`Run evaluations to compare agent configurations

Usage:
  picoagents-ts eval <action> [options]

Actions:
  list       List built-in datasets, persisted datasets, and targets
  run        Run an evaluation dataset
  results    List or view evaluation results
`);
}

function printEvalListHelp(): void {
  console.log(`Usage:
  picoagents-ts eval list [options]

Options:
  --store-dir <path>  Store directory (defaults to ~/.picoagents)
  --json              Print machine-readable JSON
  --help, -h          Show this help
`);
}

function printEvalRunHelp(): void {
  console.log(`Usage:
  picoagents-ts eval run <dataset> [options]

Options:
  -c, --configs <path>       JSON array/map of AgentConfig entries
  --target <id-or-name>      Persisted target config to run (repeatable)
  -o, --output <dir>         Output directory for result JSON (default: .picoagents/eval)
  --baseline <name>          Target name to use as baseline
  --judge <type>             mock, contains, exact, fuzzy, or llm (default: mock)
  --judge-provider <name>    Provider for --judge llm (default: openai)
  --judge-model <name>       Model for --judge llm (default: gpt-4o-mini)
  --task-filter <category>   Run only tasks in a category
  --parallel-tasks           Run tasks in parallel
  --parallel-targets         Run targets in parallel
  --store-dir <path>         Store directory (defaults to ~/.picoagents)
  --no-persist               Write JSON only; do not index in PicoStore
  --help, -h                 Show this help
`);
}

function printEvalResultsHelp(): void {
  console.log(`Usage:
  picoagents-ts eval results [path-or-eval-run-id] [options]

Options:
  --dir <path>         Result directory to list (default: .picoagents/eval)
  --store-dir <path>   Store directory (defaults to ~/.picoagents)
  --show-breakdown     Show per-task breakdown when viewing a result
  --show-files         Show file-read analysis when viewing a result
  --help, -h           Show this help
`);
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntryPoint) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    if (error instanceof UsageError) {
      console.error(error.message);
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
}
