/**
 * Checkpoint storage backends for workflow execution state.
 *
 * Ported from Python `core/_checkpoint.py`. Provides:
 * - WorkflowCheckpoint data model
 * - CheckpointMetadata / CheckpointValidationResult
 * - Abstract CheckpointStore base class
 * - Concrete implementations (FileCheckpointStore, InMemoryCheckpointStore)
 * - CheckpointConfig
 * - computeWorkflowStructureHash()
 */

import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { StepStatus } from "./index.js";
import type { BaseStep, Edge, WorkflowExecution } from "./index.js";

// ============================================================================
// Core Data Models
// ============================================================================

export interface WorkflowCheckpointInit {
  workflowId: string;
  workflowStructureHash: string;
  execution: WorkflowExecution;
  workflowVersion?: string;
  checkpointId?: string;
  createdAt?: Date;
  checkpointType?: string;
  completedStepIds?: string[];
  pendingStepIds?: string[];
}

/**
 * Checkpoint containing workflow execution state.
 *
 * Storage-agnostic: the checkpoint object is the same regardless of where it is
 * stored (file, memory, database, etc.).
 */
export class WorkflowCheckpoint {
  workflowId: string;
  workflowVersion: string;
  workflowStructureHash: string;
  checkpointId: string;
  createdAt: Date;
  /** "manual" | "auto" | "on_step" | "on_error" */
  checkpointType: string;
  execution: WorkflowExecution;
  completedStepIds: string[];
  pendingStepIds: string[];

  constructor(init: WorkflowCheckpointInit) {
    this.workflowId = init.workflowId;
    this.workflowVersion = init.workflowVersion ?? "1.0.0";
    this.workflowStructureHash = init.workflowStructureHash;
    this.checkpointId = init.checkpointId ?? randomUUID();
    this.createdAt = init.createdAt ?? new Date();
    this.checkpointType = init.checkpointType ?? "manual";
    this.execution = init.execution;
    this.completedStepIds = init.completedStepIds ?? [];
    this.pendingStepIds = init.pendingStepIds ?? [];
  }

  /** Create checkpoint from workflow execution state. */
  static fromExecution(init: {
    execution: WorkflowExecution;
    workflowId: string;
    workflowVersion: string;
    workflowStructureHash: string;
    allStepIds: string[];
    checkpointType?: string;
  }): WorkflowCheckpoint {
    const completedStepIds = Object.entries(init.execution.stepExecutions)
      .filter(([, stepExec]) => stepExec.status === StepStatus.COMPLETED)
      .map(([stepId]) => stepId);

    const pendingStepIds = init.allStepIds.filter((stepId) => {
      const stepExec = init.execution.stepExecutions[stepId];
      return !stepExec || stepExec.status === StepStatus.PENDING;
    });

    return new WorkflowCheckpoint({
      workflowId: init.workflowId,
      workflowVersion: init.workflowVersion,
      workflowStructureHash: init.workflowStructureHash,
      checkpointType: init.checkpointType ?? "manual",
      execution: init.execution,
      completedStepIds,
      pendingStepIds
    });
  }

  /** Serialize to a plain JSON-friendly object. */
  toJSON(): Record<string, unknown> {
    return {
      workflowId: this.workflowId,
      workflowVersion: this.workflowVersion,
      workflowStructureHash: this.workflowStructureHash,
      checkpointId: this.checkpointId,
      createdAt: this.createdAt.toISOString(),
      checkpointType: this.checkpointType,
      execution: serializeExecution(this.execution),
      completedStepIds: this.completedStepIds,
      pendingStepIds: this.pendingStepIds
    };
  }

  /** Rebuild from a previously serialized plain object. */
  static fromJSON(data: Record<string, unknown>): WorkflowCheckpoint {
    return new WorkflowCheckpoint({
      workflowId: data.workflowId as string,
      workflowVersion: data.workflowVersion as string | undefined,
      workflowStructureHash: data.workflowStructureHash as string,
      checkpointId: data.checkpointId as string | undefined,
      createdAt: data.createdAt ? new Date(data.createdAt as string) : undefined,
      checkpointType: data.checkpointType as string | undefined,
      execution: deserializeExecution(data.execution as Record<string, unknown>),
      completedStepIds: (data.completedStepIds as string[] | undefined) ?? [],
      pendingStepIds: (data.pendingStepIds as string[] | undefined) ?? []
    });
  }
}

function serializeExecution(execution: WorkflowExecution): Record<string, unknown> {
  const stepExecutions: Record<string, unknown> = {};
  for (const [stepId, exec] of Object.entries(execution.stepExecutions)) {
    stepExecutions[stepId] = {
      ...exec,
      startTime: exec.startTime ? exec.startTime.toISOString() : undefined,
      endTime: exec.endTime ? exec.endTime.toISOString() : undefined
    };
  }
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    startTime: execution.startTime ? execution.startTime.toISOString() : undefined,
    endTime: execution.endTime ? execution.endTime.toISOString() : undefined,
    state: execution.state,
    stepExecutions,
    error: execution.error
  };
}

function deserializeExecution(data: Record<string, unknown>): WorkflowExecution {
  const rawStepExecutions = (data.stepExecutions as Record<string, Record<string, unknown>>) ?? {};
  const stepExecutions: WorkflowExecution["stepExecutions"] = {};
  for (const [stepId, exec] of Object.entries(rawStepExecutions)) {
    stepExecutions[stepId] = {
      stepId: exec.stepId as string,
      status: exec.status as StepStatus,
      startTime: exec.startTime ? new Date(exec.startTime as string) : undefined,
      endTime: exec.endTime ? new Date(exec.endTime as string) : undefined,
      inputData: exec.inputData as Record<string, unknown> | undefined,
      outputData: exec.outputData as Record<string, unknown> | undefined,
      error: exec.error as string | undefined,
      retryCount: (exec.retryCount as number | undefined) ?? 0
    };
  }
  return {
    id: data.id as string,
    workflowId: data.workflowId as string,
    status: data.status as WorkflowExecution["status"],
    startTime: data.startTime ? new Date(data.startTime as string) : undefined,
    endTime: data.endTime ? new Date(data.endTime as string) : undefined,
    state: (data.state as Record<string, unknown>) ?? {},
    stepExecutions,
    error: data.error as string | undefined
  };
}

/**
 * Lightweight checkpoint metadata (without full execution state).
 *
 * Useful for listing/searching checkpoints without loading full data.
 */
export class CheckpointMetadata {
  checkpointId: string;
  workflowId: string;
  workflowVersion: string;
  createdAt: Date;
  checkpointType: string;
  completedSteps: number;
  pendingSteps: number;
  totalSteps: number;
  sizeBytes?: number;

  constructor(init: {
    checkpointId: string;
    workflowId: string;
    workflowVersion: string;
    createdAt: Date;
    checkpointType: string;
    completedSteps: number;
    pendingSteps: number;
    totalSteps: number;
    sizeBytes?: number;
  }) {
    this.checkpointId = init.checkpointId;
    this.workflowId = init.workflowId;
    this.workflowVersion = init.workflowVersion;
    this.createdAt = init.createdAt;
    this.checkpointType = init.checkpointType;
    this.completedSteps = init.completedSteps;
    this.pendingSteps = init.pendingSteps;
    this.totalSteps = init.totalSteps;
    this.sizeBytes = init.sizeBytes;
  }

  static fromCheckpoint(checkpoint: WorkflowCheckpoint, sizeBytes?: number): CheckpointMetadata {
    return new CheckpointMetadata({
      checkpointId: checkpoint.checkpointId,
      workflowId: checkpoint.workflowId,
      workflowVersion: checkpoint.workflowVersion,
      createdAt: checkpoint.createdAt,
      checkpointType: checkpoint.checkpointType,
      completedSteps: checkpoint.completedStepIds.length,
      pendingSteps: checkpoint.pendingStepIds.length,
      totalSteps: checkpoint.completedStepIds.length + checkpoint.pendingStepIds.length,
      sizeBytes
    });
  }
}

/** Result of checkpoint validation. */
export class CheckpointValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  canResume: boolean;
  checkpointInfo: Record<string, unknown>;

  constructor(init: { isValid: boolean; canResume?: boolean } = { isValid: true }) {
    this.isValid = init.isValid;
    this.errors = [];
    this.warnings = [];
    this.canResume = init.canResume ?? false;
    this.checkpointInfo = {};
  }
}

// ============================================================================
// Abstract Base Class: CheckpointStore
// ============================================================================

/** Abstract base class for checkpoint storage backends. */
export abstract class CheckpointStore {
  /** Save checkpoint to storage. */
  abstract save(checkpoint: WorkflowCheckpoint): Promise<void>;
  /** Load checkpoint by ID. */
  abstract load(checkpointId: string): Promise<WorkflowCheckpoint | undefined>;
  /** Load the most recent checkpoint for a workflow. */
  abstract loadLatest(workflowId: string): Promise<WorkflowCheckpoint | undefined>;
  /** Delete checkpoint by ID; returns true if deleted. */
  abstract delete(checkpointId: string): Promise<boolean>;
  /** List checkpoint metadata without loading full data. */
  abstract listMetadata(workflowId?: string, limit?: number): Promise<CheckpointMetadata[]>;
  /** Remove old checkpoints, keeping only the N most recent; returns count deleted. */
  abstract cleanupOld(workflowId: string, keepLastN?: number): Promise<number>;
}

// ============================================================================
// Concrete Implementation: FileCheckpointStore
// ============================================================================

/**
 * File-based checkpoint storage.
 *
 * Layout: {basePath}/{workflowId}/{checkpointId}.json
 */
export class FileCheckpointStore extends CheckpointStore {
  basePath: string;

  constructor(basePath: string) {
    super();
    this.basePath = basePath;
  }

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  private getWorkflowDir(workflowId: string): string {
    return path.join(this.basePath, workflowId);
  }

  private getCheckpointPath(workflowId: string, checkpointId: string): string {
    return path.join(this.getWorkflowDir(workflowId), `${checkpointId}.json`);
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    const dir = this.getWorkflowDir(checkpoint.workflowId);
    await this.ensureDir(dir);
    const checkpointPath = this.getCheckpointPath(checkpoint.workflowId, checkpoint.checkpointId);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint.toJSON(), null, 2), "utf-8");
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint | undefined> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.basePath);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const workflowDir = path.join(this.basePath, entry);
      const stat = await fs.stat(workflowDir).catch(() => undefined);
      if (!stat?.isDirectory()) continue;
      const checkpointPath = path.join(workflowDir, `${checkpointId}.json`);
      const data = await fs.readFile(checkpointPath, "utf-8").catch(() => undefined);
      if (data !== undefined) {
        return WorkflowCheckpoint.fromJSON(JSON.parse(data));
      }
    }
    return undefined;
  }

  async loadLatest(workflowId: string): Promise<WorkflowCheckpoint | undefined> {
    const workflowDir = this.getWorkflowDir(workflowId);
    let files: string[];
    try {
      files = (await fs.readdir(workflowDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return undefined;
    }
    if (!files.length) return undefined;

    const withMtime = await Promise.all(
      files.map(async (file) => {
        const full = path.join(workflowDir, file);
        const stat = await fs.stat(full);
        return { full, mtime: stat.mtimeMs };
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const data = await fs.readFile(withMtime[0]!.full, "utf-8");
    return WorkflowCheckpoint.fromJSON(JSON.parse(data));
  }

  async delete(checkpointId: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.basePath);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const workflowDir = path.join(this.basePath, entry);
      const stat = await fs.stat(workflowDir).catch(() => undefined);
      if (!stat?.isDirectory()) continue;
      const checkpointPath = path.join(workflowDir, `${checkpointId}.json`);
      try {
        await fs.unlink(checkpointPath);
        return true;
      } catch {
        // Not in this directory.
      }
    }
    return false;
  }

  async listMetadata(workflowId?: string, limit = 100): Promise<CheckpointMetadata[]> {
    const metadataList: CheckpointMetadata[] = [];
    let searchDirs: string[];
    if (workflowId) {
      searchDirs = [this.getWorkflowDir(workflowId)];
    } else {
      let entries: string[];
      try {
        entries = await fs.readdir(this.basePath);
      } catch {
        return [];
      }
      searchDirs = [];
      for (const entry of entries) {
        const dir = path.join(this.basePath, entry);
        const stat = await fs.stat(dir).catch(() => undefined);
        if (stat?.isDirectory()) searchDirs.push(dir);
      }
    }

    for (const dir of searchDirs) {
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        const data = await fs.readFile(full, "utf-8").catch(() => undefined);
        if (data === undefined) continue;
        const checkpoint = WorkflowCheckpoint.fromJSON(JSON.parse(data));
        const stat = await fs.stat(full).catch(() => undefined);
        metadataList.push(CheckpointMetadata.fromCheckpoint(checkpoint, stat?.size));
      }
    }

    metadataList.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return metadataList.slice(0, limit);
  }

  async cleanupOld(workflowId: string, keepLastN = 5): Promise<number> {
    const workflowDir = this.getWorkflowDir(workflowId);
    let files: string[];
    try {
      files = (await fs.readdir(workflowDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return 0;
    }
    const withMtime = await Promise.all(
      files.map(async (file) => {
        const full = path.join(workflowDir, file);
        const stat = await fs.stat(full);
        return { full, mtime: stat.mtimeMs };
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const toDelete = withMtime.slice(keepLastN);
    for (const { full } of toDelete) {
      await fs.unlink(full).catch(() => undefined);
    }
    return toDelete.length;
  }
}

// ============================================================================
// Concrete Implementation: InMemoryCheckpointStore
// ============================================================================

/** In-memory checkpoint storage (fast, ephemeral, useful for testing). */
export class InMemoryCheckpointStore extends CheckpointStore {
  private checkpoints = new Map<string, WorkflowCheckpoint>();
  private byWorkflow = new Map<string, string[]>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    const list = this.byWorkflow.get(checkpoint.workflowId) ?? [];
    if (!list.includes(checkpoint.checkpointId)) {
      list.push(checkpoint.checkpointId);
    }
    this.byWorkflow.set(checkpoint.workflowId, list);
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint | undefined> {
    return this.checkpoints.get(checkpointId);
  }

  async loadLatest(workflowId: string): Promise<WorkflowCheckpoint | undefined> {
    const ids = this.byWorkflow.get(workflowId) ?? [];
    const checkpoints = ids
      .map((id) => this.checkpoints.get(id))
      .filter((c): c is WorkflowCheckpoint => c !== undefined);
    if (!checkpoints.length) return undefined;
    checkpoints.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return checkpoints[0];
  }

  async delete(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return false;
    this.checkpoints.delete(checkpointId);
    const list = this.byWorkflow.get(checkpoint.workflowId);
    if (list) {
      const idx = list.indexOf(checkpointId);
      if (idx >= 0) list.splice(idx, 1);
    }
    return true;
  }

  async listMetadata(workflowId?: string, limit = 100): Promise<CheckpointMetadata[]> {
    let checkpoints: WorkflowCheckpoint[];
    if (workflowId) {
      const ids = this.byWorkflow.get(workflowId) ?? [];
      checkpoints = ids
        .map((id) => this.checkpoints.get(id))
        .filter((c): c is WorkflowCheckpoint => c !== undefined);
    } else {
      checkpoints = [...this.checkpoints.values()];
    }
    const metadataList = checkpoints.map((cp) => CheckpointMetadata.fromCheckpoint(cp));
    metadataList.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return metadataList.slice(0, limit);
  }

  async cleanupOld(workflowId: string, keepLastN = 5): Promise<number> {
    const ids = this.byWorkflow.get(workflowId) ?? [];
    const checkpoints = ids
      .map((id) => this.checkpoints.get(id))
      .filter((c): c is WorkflowCheckpoint => c !== undefined);
    checkpoints.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const toDelete = checkpoints.slice(keepLastN);
    for (const cp of toDelete) {
      await this.delete(cp.checkpointId);
    }
    return toDelete.length;
  }

  /** Clear all checkpoints (useful for testing). */
  clear(): void {
    this.checkpoints.clear();
    this.byWorkflow.clear();
  }
}

// ============================================================================
// Checkpoint Configuration
// ============================================================================

/** Configuration for checkpoint behavior with reasonable defaults. */
export class CheckpointConfig {
  store: CheckpointStore;
  autoSave: boolean;
  saveIntervalSteps: number;
  autoCleanup: boolean;
  keepLastN: number;

  constructor(init: {
    store?: CheckpointStore;
    autoSave?: boolean;
    saveIntervalSteps?: number;
    autoCleanup?: boolean;
    keepLastN?: number;
  } = {}) {
    this.store = init.store ?? new InMemoryCheckpointStore();
    this.autoSave = init.autoSave ?? true;
    this.saveIntervalSteps = init.saveIntervalSteps ?? 1;
    this.autoCleanup = init.autoCleanup ?? false;
    this.keepLastN = init.keepLastN ?? 5;
  }
}

// ============================================================================
// Helper: Compute Workflow Structure Hash
// ============================================================================

/**
 * Compute hash of workflow structure for checkpoint compatibility.
 *
 * Hash includes step IDs and class names, edge connections (from/to/condition
 * type) and start/end step IDs. It deliberately excludes step/workflow metadata
 * so safe resume is possible even if metadata changes.
 *
 * Returns a 16-character hex hash string.
 */
export function computeWorkflowStructureHash(
  steps: Record<string, BaseStep>,
  edges: Edge[],
  startStepId: string | undefined,
  endStepIds: string[]
): string {
  const sortedStepIds = Object.keys(steps).sort();
  const stepsStructure: Record<string, unknown> = {};
  for (const stepId of sortedStepIds) {
    const step = steps[stepId]!;
    stepsStructure[stepId] = {
      type: step.constructor.name
    };
  }

  const sortedEdges = [...edges].sort((a, b) => {
    if (a.fromStep !== b.fromStep) return a.fromStep < b.fromStep ? -1 : 1;
    return a.toStep < b.toStep ? -1 : a.toStep > b.toStep ? 1 : 0;
  });

  const structure = {
    steps: stepsStructure,
    edges: sortedEdges.map((edge) => ({
      from: edge.fromStep,
      to: edge.toStep,
      condition_type: edge.condition.type ?? "always"
    })),
    start_step: startStepId ?? null,
    end_steps: [...endStepIds].sort()
  };

  const jsonStr = stableStringify(structure);
  return createHash("sha256").update(jsonStr).digest("hex").slice(0, 16);
}

/** Deterministic JSON stringify with sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
