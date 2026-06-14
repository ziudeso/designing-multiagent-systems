import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { BaseAgent } from "../agents/index.js";
import { BaseOrchestrator } from "../orchestration/index.js";
import { Workflow } from "../workflow/index.js";
import type { AgentInfo, Entity, EntityInfo, OrchestratorInfo, WorkflowInfo } from "./models.js";

export class PicoAgentsScanner {
  entitiesDir: string;
  private entityCache = new Map<string, unknown>();

  constructor(entitiesDir: string) {
    this.entitiesDir = path.resolve(entitiesDir);
  }

  async discoverEntities(): Promise<Entity[]> {
    if (!existsSync(this.entitiesDir)) return [];
    const discovered: Entity[] = [];
    const entries = await fs.readdir(this.entitiesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const fullPath = path.join(this.entitiesDir, entry.name);
      try {
        if (entry.isDirectory()) {
          discovered.push(...(await this.discoverEntitiesInDirectory(fullPath)));
        } else if (entry.isFile() && isLoadableModuleFile(entry.name) && !entry.name.startsWith("_")) {
          discovered.push(...(await this.discoverEntitiesInFile(fullPath, path.parse(entry.name).name)));
        }
      } catch {
        // Keep discovery robust; one bad module should not prevent the UI from starting.
      }
    }

    return discovered;
  }

  getEntityObject(entityId: string): unknown | undefined {
    return this.entityCache.get(entityId);
  }

  clearCache(): void {
    this.entityCache.clear();
  }

  private async discoverEntitiesInDirectory(directory: string): Promise<Entity[]> {
    const baseId = path.basename(directory);
    const candidates = [
      path.join(directory, "index.js"),
      path.join(directory, "index.mjs"),
      path.join(directory, "agent.js"),
      path.join(directory, "workflow.js"),
      path.join(directory, "orchestrator.js"),
      path.join(directory, "index.ts"),
      path.join(directory, "agent.ts"),
      path.join(directory, "workflow.ts"),
      path.join(directory, "orchestrator.ts")
    ];

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const entities = await this.discoverEntitiesInFile(candidate, baseId);
      if (entities.length) return entities;
    }
    return [];
  }

  private async discoverEntitiesInFile(filePath: string, baseId: string): Promise<Entity[]> {
    const module = await importModule(filePath);
    const candidates: Array<[Entity["type"], unknown]> = [
      ["agent", (module as any).agent],
      ["orchestrator", (module as any).orchestrator],
      ["workflow", (module as any).workflow],
      ["agent", (module as any).default]
    ];

    const entities: Entity[] = [];
    for (const [type, object] of candidates) {
      if (!object || !isValidEntity(object, type)) continue;
      const entity = createEntityInfoFromObject(`${baseId}.${type}`, object, {
        source: "directory",
        module_path: filePath,
        has_env: hasEnvFile(filePath)
      });
      if (entity) {
        entities.push(entity);
        this.entityCache.set(entity.id, object);
      }
    }
    return dedupeEntities(entities);
  }
}

export function createEntityInfoFromObject(
  entityId: string,
  entityObject: any,
  options: { source: EntityInfo["source"]; module_path?: string; has_env?: boolean } = { source: "memory" }
): Entity | undefined {
  const common = {
    id: entityId,
    name: entityObject.name ?? entityId,
    description: entityObject.description,
    source: options.source,
    module_path: options.module_path,
    has_env: options.has_env ?? false,
    tools: [] as string[],
    example_tasks: entityObject.exampleTasks ?? entityObject.example_tasks ?? []
  };

  if (isValidEntity(entityObject, "agent")) {
    const tools = Array.isArray(entityObject.tools)
      ? entityObject.tools.map((tool: any) => tool.name ?? String(tool))
      : [];
    return {
      ...common,
      type: "agent",
      tools,
      model: entityObject.modelClient?.model ?? entityObject.model_client?.model,
      memory_type: entityObject.memory ? entityObject.memory.constructor?.name : undefined
    } satisfies AgentInfo;
  }

  if (isValidEntity(entityObject, "workflow")) {
    return {
      ...common,
      type: "workflow",
      steps: entityObject.steps instanceof Map
        ? Array.from(entityObject.steps.keys())
        : Object.keys(entityObject.steps ?? {}),
      input_schema: entityObject.inputSchema ?? entityObject.input_schema,
      start_step: entityObject.startStepId ?? entityObject.start_step_id ?? entityObject.startStep ?? entityObject.start_step
    } satisfies WorkflowInfo;
  }

  if (isValidEntity(entityObject, "orchestrator")) {
    return {
      ...common,
      type: "orchestrator",
      orchestrator_type: entityObject.constructor?.name?.toLowerCase().replace("orchestrator", "") || "custom",
      agents: Array.isArray(entityObject.agents)
        ? entityObject.agents.map((agent: any) => agent.name ?? String(agent))
        : [],
      termination_conditions: entityObject.termination
        ? [entityObject.termination.constructor?.name ?? "Termination"]
        : []
    } satisfies OrchestratorInfo;
  }

  return undefined;
}

export function isValidEntity(object: unknown, expectedType: Entity["type"]): boolean {
  if (!object || typeof object !== "object") return false;

  if (expectedType === "agent") {
    return object instanceof BaseAgent || (
      typeof (object as any).run === "function" &&
      typeof (object as any).runStream === "function" &&
      typeof (object as any).name === "string"
    );
  }

  if (expectedType === "orchestrator") {
    return object instanceof BaseOrchestrator || (
      typeof (object as any).runStream === "function" &&
      Array.isArray((object as any).agents)
    );
  }

  if (expectedType === "workflow") {
    return object instanceof Workflow || (
      typeof (object as any).runStream === "function" ||
      ((object as any).steps && typeof (object as any).steps === "object" && (object as any).startStepId)
    );
  }

  return false;
}

async function importModule(filePath: string): Promise<unknown> {
  if (path.extname(filePath) === ".ts") {
    return importTypeScriptModule(filePath);
  }
  const url = pathToFileURL(filePath);
  url.searchParams.set("v", String(Date.now()));
  return import(url.href);
}

async function importTypeScriptModule(filePath: string): Promise<unknown> {
  const source = await fs.readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      sourceMap: false
    }
  });
  const hash = createHash("sha256")
    .update(filePath)
    .update("\0")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = path.join(os.tmpdir(), "picoagents-ts-discovery");
  await fs.mkdir(cacheDir, { recursive: true });
  const outputPath = path.join(cacheDir, `${path.basename(filePath, ".ts")}-${hash}.mjs`);
  await fs.writeFile(outputPath, transpiled.outputText, "utf8");
  const url = pathToFileURL(outputPath);
  url.searchParams.set("v", String(Date.now()));
  return import(url.href);
}

function isLoadableModuleFile(fileName: string): boolean {
  return [".js", ".mjs", ".cjs", ".ts"].includes(path.extname(fileName));
}

function hasEnvFile(modulePath: string): boolean {
  const statPath = existsSync(modulePath) ? modulePath : path.dirname(modulePath);
  const base = path.extname(statPath) ? path.dirname(statPath) : statPath;
  return existsSync(path.join(base, ".env"));
}

function dedupeEntities(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    if (seen.has(entity.id)) return false;
    seen.add(entity.id);
    return true;
  });
}
