import path from "node:path";
import { CancellationToken } from "../cancellation.js";
import { Dataset } from "../eval/dataset.js";
import { AgentConfig } from "../eval/config.js";
import { EvalResults } from "../eval/results.js";
import { ContainsJudge, ExactMatchJudge, FuzzyMatchJudge, LLMEvalJudge } from "../eval/judges.js";
import type { EvalJudge, Target } from "../eval/base.js";
import { EvalRunner } from "../eval/runner.js";
import { AgentEvalTarget, OrchestratorEvalTarget, PicoAgentTarget } from "../eval/targets.js";
import { Task } from "../eval/types.js";
import type { BaseAgent } from "../agents/base.js";
import type { BaseOrchestrator } from "../orchestration/index.js";
import type { PicoStore } from "../store/index.js";
import type { DBDataset, DBTargetConfig, DBTask } from "../store/models.js";
import type { EntityRegistry } from "./registry.js";

export interface EvalJobManagerOptions {
  registry?: EntityRegistry;
}

export class EvalJobManager {
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly cancellationTokens = new Map<string, CancellationToken>();
  private readonly registry?: EntityRegistry;

  constructor(private readonly store: PicoStore, options: EvalJobManagerOptions = {}) {
    this.registry = options.registry;
  }

  async startEvalRun(
    evalRunId: string,
    datasetId: string,
    targetIds: string[],
    judgeConfig?: Record<string, unknown>
  ): Promise<void> {
    const token = new CancellationToken();
    this.cancellationTokens.set(evalRunId, token);
    const job = this.execute(evalRunId, datasetId, targetIds, judgeConfig, token)
      .finally(() => {
        this.activeJobs.delete(evalRunId);
        this.cancellationTokens.delete(evalRunId);
      });
    this.activeJobs.set(evalRunId, job);
  }

  async cancelEvalRun(evalRunId: string): Promise<boolean> {
    const token = this.cancellationTokens.get(evalRunId);
    if (!token) return false;
    token.cancel();
    await this.store.updateEvalRunProgress(evalRunId, {
      status: "cancelled",
      completedAt: new Date()
    });
    return true;
  }

  isRunning(evalRunId: string): boolean {
    return this.activeJobs.has(evalRunId);
  }

  private async execute(
    evalRunId: string,
    datasetId: string,
    targetIds: string[],
    judgeConfig: Record<string, unknown> | undefined,
    cancellationToken: CancellationToken
  ): Promise<void> {
    try {
      await this.store.updateEvalRunProgress(evalRunId, {
        status: "running",
        startedAt: new Date()
      });

      const datasetData = await this.store.getDataset(datasetId);
      if (!datasetData) throw new Error(`Dataset ${datasetId} not found`);
      const dataset = toDataset(datasetData);
      const targets = await this.loadTargets(targetIds);
      if (!targets.length) throw new Error("No valid targets found");

      const runner = new EvalRunner(this.createJudge(judgeConfig), {
        parallelTasks: false,
        parallelTargets: false
      });
      const results = new EvalResults({
        runId: evalRunId,
        datasetName: dataset.name,
        datasetVersion: dataset.version
      });

      let completed = 0;
      for (const target of targets) {
        if (cancellationToken.isCancelled()) break;
        await this.store.updateEvalRunProgress(evalRunId, { currentTarget: target.name });

        for (const task of dataset.tasks) {
          if (cancellationToken.isCancelled()) break;
          await this.store.updateEvalRunProgress(evalRunId, {
            currentTask: task.name || task.id
          });

          const taskResult = await runner.runSingleTask(target, task, dataset, cancellationToken);
          results.addResult(taskResult);
          await this.store.saveEvalResult(evalRunId, taskResult);

          completed += 1;
          await this.store.updateEvalRunProgress(evalRunId, { completedTasks: completed });
        }
      }

      if (cancellationToken.isCancelled()) {
        await this.store.updateEvalRunProgress(evalRunId, {
          status: "cancelled",
          completedAt: new Date()
        });
        return;
      }

      const filePath = path.join(
        this.store.evalDir,
        `eval_${evalRunId}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      );
      await results.save(filePath);
      await this.store.updateEvalRunProgress(evalRunId, {
        status: "completed",
        filePath,
        completedAt: new Date()
      });
    } catch (error) {
      await this.store.updateEvalRunProgress(evalRunId, {
        status: cancellationToken.isCancelled() ? "cancelled" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date()
      });
    }
  }

  private async loadTargets(targetIds: string[]): Promise<Target[]> {
    const targets: Target[] = [];
    for (const targetId of targetIds) {
      const config = await this.store.getTargetConfig(targetId);
      if (!config) continue;
      const target = this.targetFromConfig(config);
      if (target) targets.push(target);
    }
    return targets;
  }

  private targetFromConfig(targetConfig: DBTargetConfig): Target | undefined {
    if (
      (
        targetConfig.targetType === "discovered_agent" ||
        targetConfig.targetType === "discovered_orchestrator" ||
        targetConfig.entityId
      ) &&
      this.registry
    ) {
      const entityId = targetConfig.entityId ?? String(targetConfig.config.entityId ?? "");
      const entity = entityId ? this.registry.getEntityObject(entityId) : undefined;
      if (isRunnableOrchestrator(entity)) return new OrchestratorEvalTarget(entity, targetConfig.name);
      if (isRunnableAgent(entity)) return new AgentEvalTarget(entity, targetConfig.name);
    }

    if (targetConfig.targetType === "picoagent" || !targetConfig.targetType) {
      const config = normalizeAgentConfig(targetConfig.name, targetConfig.config);
      return new PicoAgentTarget(new AgentConfig(config));
    }

    return undefined;
  }

  private createJudge(judgeConfig: Record<string, unknown> | undefined): EvalJudge {
    const type = String(judgeConfig?.type ?? "llm");
    if (type === "contains" || type === "reference") {
      return new ContainsJudge({
        caseSensitive: Boolean(judgeConfig?.caseSensitive ?? judgeConfig?.case_sensitive ?? false)
      });
    }
    if (type === "exact" || type === "exact_match") {
      return new ExactMatchJudge({
        caseSensitive: Boolean(judgeConfig?.caseSensitive ?? judgeConfig?.case_sensitive ?? false)
      });
    }
    if (type === "fuzzy") {
      return new FuzzyMatchJudge({
        threshold: Number(judgeConfig?.threshold ?? 0.8),
        caseSensitive: Boolean(judgeConfig?.caseSensitive ?? judgeConfig?.case_sensitive ?? false)
      });
    }

    const modelConfig = asRecord(judgeConfig?.model);
    const config = new AgentConfig(normalizeAgentConfig("judge", modelConfig));
    return new LLMEvalJudge(config.createModelClient(), {
      defaultCriteria: Array.isArray(judgeConfig?.criteria) ? judgeConfig.criteria as string[] : undefined
    });
  }
}

function toDataset(datasetData: DBDataset & { tasks: DBTask[] }): Dataset {
  return new Dataset({
    name: datasetData.name,
    version: datasetData.version,
    description: datasetData.description,
    categories: datasetData.categories,
    defaultEvalCriteria: datasetData.defaultEvalCriteria,
    metadata: datasetData.metadata,
    tasks: datasetData.tasks.map((task) => new Task({
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

function normalizeAgentConfig(name: string, config: Record<string, unknown>): ConstructorParameters<typeof AgentConfig>[0] {
  return {
    name: String(config.name ?? name),
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
    extraKwargs: asRecord(config.extraKwargs ?? config.extra_kwargs)
  };
}

function isRunnableAgent(value: unknown): value is BaseAgent {
  return Boolean(
    value &&
      typeof value === "object" &&
      "run" in value &&
      "name" in value &&
      !isRunnableOrchestrator(value)
  );
}

function isRunnableOrchestrator(value: unknown): value is BaseOrchestrator {
  return Boolean(
    value &&
      typeof value === "object" &&
      "run" in value &&
      "agents" in value &&
      "termination" in value
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
