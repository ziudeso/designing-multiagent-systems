import { promises as fs } from "node:fs";
import path from "node:path";
import { registerComponent } from "../componentConfig.js";

export type MemoryPayload = string | Record<string, unknown>;

export class MemoryContent {
  content: MemoryPayload;
  mimeType: string;
  metadata: Record<string, unknown>;
  timestamp: Date;

  constructor(init: {
    content: MemoryPayload;
    mimeType?: string;
    metadata?: Record<string, unknown>;
    timestamp?: Date | string;
  }) {
    this.content = init.content;
    this.mimeType = init.mimeType ?? "text/plain";
    this.metadata = init.metadata ?? {};
    this.timestamp = init.timestamp ? new Date(init.timestamp) : new Date();
  }

  toJSON(): Record<string, unknown> {
    return {
      content: this.content,
      mimeType: this.mimeType,
      metadata: this.metadata,
      timestamp: this.timestamp.toISOString()
    };
  }
}

export class MemoryQueryResult {
  results: MemoryContent[];

  constructor(results: MemoryContent[] = []) {
    this.results = results;
  }
}

export abstract class BaseMemory {
  maxMemories: number;

  constructor(maxMemories: number = 1000) {
    this.maxMemories = maxMemories;
  }

  abstract add(content: MemoryContent): Promise<void>;
  abstract query(query: string, limit?: number): Promise<MemoryQueryResult>;
  abstract getContext(maxItems?: number): Promise<MemoryQueryResult>;
  abstract clear(): Promise<void>;

  async getStats(): Promise<Record<string, unknown>> {
    return {
      maxMemories: this.maxMemories,
      implementation: this.constructor.name
    };
  }
}

export class ListMemory extends BaseMemory {
  memories: MemoryContent[] = [];

  async add(content: MemoryContent): Promise<void> {
    this.memories.push(content);
    if (this.memories.length > this.maxMemories) {
      this.memories = this.memories.slice(-this.maxMemories);
    }
  }

  async query(query: string, limit: number = 10): Promise<MemoryQueryResult> {
    const queryLower = query.toLowerCase();
    const matches: MemoryContent[] = [];
    for (let index = this.memories.length - 1; index >= 0; index -= 1) {
      const memory = this.memories[index];
      if (!memory) continue;
      const content = typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content);
      if (content.toLowerCase().includes(queryLower)) {
        matches.push(memory);
        if (matches.length >= limit) break;
      }
    }
    return new MemoryQueryResult(matches);
  }

  async getContext(maxItems: number = 10): Promise<MemoryQueryResult> {
    return new MemoryQueryResult(this.memories.slice(-maxItems));
  }

  async clear(): Promise<void> {
    this.memories = [];
  }

  override async getStats(): Promise<Record<string, unknown>> {
    return {
      ...(await super.getStats()),
      currentMemories: this.memories.length,
      isPersistent: false
    };
  }

  static componentType = "memory" as const;
  static componentProvider = "picoagents.memory.ListMemory";
  static componentVersion = 1;

  toConfig(): Record<string, unknown> {
    return {
      maxMemories: this.maxMemories,
      memories: this.memories.map((memory) => memory.toJSON())
    };
  }

  static fromConfig(config: any): ListMemory {
    const instance = new ListMemory(config?.maxMemories ?? config?.max_memories ?? 1000);
    const memories: any[] = config?.memories ?? [];
    instance.memories = memories.map(
      (value) =>
        new MemoryContent({
          content: value.content,
          mimeType: value.mimeType ?? value.mime_type,
          metadata: value.metadata,
          timestamp: value.timestamp
        })
    );
    return instance;
  }
}

export class FileMemory extends BaseMemory {
  filePath: string;
  memories: MemoryContent[] = [];

  constructor(filePath: string, maxMemories: number = 1000) {
    super(maxMemories);
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const values = JSON.parse(raw) as any[];
      this.memories = values.map(
        (value) =>
          new MemoryContent({
            content: value.content,
            mimeType: value.mimeType ?? value.mime_type,
            metadata: value.metadata,
            timestamp: value.timestamp
          })
      );
    } catch {
      this.memories = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.memories.map((memory) => memory.toJSON()), null, 2),
      "utf8"
    );
  }

  async add(content: MemoryContent): Promise<void> {
    await this.load();
    this.memories.push(content);
    if (this.memories.length > this.maxMemories) {
      this.memories = this.memories.slice(-this.maxMemories);
    }
    await this.save();
  }

  async query(query: string, limit: number = 10): Promise<MemoryQueryResult> {
    await this.load();
    const memory = new ListMemory(this.maxMemories);
    memory.memories = this.memories;
    return memory.query(query, limit);
  }

  async getContext(maxItems: number = 10): Promise<MemoryQueryResult> {
    await this.load();
    return new MemoryQueryResult(this.memories.slice(-maxItems));
  }

  async clear(): Promise<void> {
    this.memories = [];
    try {
      await fs.rm(this.filePath);
    } catch {
      // Ignore missing files.
    }
  }

  override async getStats(): Promise<Record<string, unknown>> {
    await this.load();
    return {
      ...(await super.getStats()),
      currentMemories: this.memories.length,
      filePath: this.filePath,
      isPersistent: true
    };
  }

  static componentType = "memory" as const;
  static componentProvider = "picoagents.memory.FileMemory";
  static componentVersion = 1;

  toConfig(): Record<string, unknown> {
    return {
      filePath: this.filePath,
      maxMemories: this.maxMemories
    };
  }

  static fromConfig(config: any): FileMemory {
    return new FileMemory(
      config?.filePath ?? config?.file_path,
      config?.maxMemories ?? config?.max_memories ?? 1000
    );
  }
}

export enum DistanceMetric {
  COSINE = "cosine",
  L2 = "l2",
  IP = "ip"
}

export interface ChromaDBMemoryOptions {
  collectionName?: string;
  maxMemories?: number;
  baseUrl?: string;
  tenant?: string;
  database?: string;
  distanceMetric?: DistanceMetric;
  k?: number;
  scoreThreshold?: number;
  fetchImpl?: typeof fetch;
}

export class ChromaDBMemory extends BaseMemory {
  collectionName: string;
  baseUrl: string;
  tenant: string;
  database: string;
  distanceMetric: DistanceMetric;
  k: number;
  scoreThreshold: number;
  private fetchImpl: typeof fetch;
  private collectionId?: string;

  constructor(options: ChromaDBMemoryOptions = {}) {
    super(options.maxMemories ?? 1000);
    this.collectionName = options.collectionName ?? "agent_memory";
    this.baseUrl = (options.baseUrl ?? "http://localhost:8000").replace(/\/$/, "");
    this.tenant = options.tenant ?? "default_tenant";
    this.database = options.database ?? "default_database";
    this.distanceMetric = options.distanceMetric ?? DistanceMetric.COSINE;
    this.k = options.k ?? 10;
    this.scoreThreshold = options.scoreThreshold ?? 0.7;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async add(content: MemoryContent): Promise<void> {
    const collectionId = await this.getCollectionId();
    const id = crypto.randomUUID();
    const document =
      typeof content.content === "string" ? content.content : JSON.stringify(content.content);
    await this.request(`/api/v1/collections/${collectionId}/add`, {
      method: "POST",
      body: {
        ids: [id],
        documents: [document],
        metadatas: [
          {
            ...content.metadata,
            timestamp: content.timestamp.toISOString(),
            mime_type: content.mimeType
          }
        ]
      }
    });

    await this.enforceMemoryLimit();
  }

  private async enforceMemoryLimit(): Promise<void> {
    const collectionId = await this.getCollectionId();
    const count = await this.count();
    if (count <= this.maxMemories) return;

    const response = await this.request(`/api/v1/collections/${collectionId}/get`, {
      method: "POST",
      body: { include: ["metadatas"] }
    });
    const ids: string[] = response.ids ?? [];
    const metadatas: Array<Record<string, unknown>> = response.metadatas ?? [];
    if (ids.length === 0) return;

    const itemsWithTimestamps = ids.map((memoryId, index) => {
      const timestamp = (metadatas[index]?.timestamp as string) ?? "1970-01-01T00:00:00";
      return { id: memoryId, timestamp };
    });
    itemsWithTimestamps.sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    const numToRemove = itemsWithTimestamps.length - this.maxMemories;
    if (numToRemove > 0) {
      const idsToRemove = itemsWithTimestamps.slice(0, numToRemove).map((item) => item.id);
      await this.request(`/api/v1/collections/${collectionId}/delete`, {
        method: "POST",
        body: { ids: idsToRemove }
      });
    }
  }

  private async count(): Promise<number> {
    const collectionId = await this.getCollectionId();
    const response = await this.request(`/api/v1/collections/${collectionId}/count`, {
      method: "GET"
    });
    if (typeof response === "number") return response;
    return Number(response.count ?? response ?? 0) || 0;
  }

  async query(query: string, limit?: number): Promise<MemoryQueryResult> {
    const collectionId = await this.getCollectionId();
    const count = await this.count();
    if (count === 0) {
      return new MemoryQueryResult([]);
    }
    const nResults = Math.min(limit ?? this.k, count);
    const response = await this.request(`/api/v1/collections/${collectionId}/query`, {
      method: "POST",
      body: {
        query_texts: [query],
        n_results: nResults,
        include: ["documents", "metadatas", "distances"]
      }
    });
    const documents: string[] = response.documents?.[0] ?? [];
    const metadatas: Array<Record<string, unknown>> = response.metadatas?.[0] ?? [];
    const distances: number[] = response.distances?.[0] ?? [];
    const memories: MemoryContent[] = [];
    documents.forEach((document, index) => {
      const distance = distances[index];
      if (distance !== undefined && distance > this.scoreThreshold) return;
      memories.push(memoryFromDocument(document, metadatas[index]));
    });
    return new MemoryQueryResult(memories);
  }

  async getContext(maxItems: number = 10): Promise<MemoryQueryResult> {
    const collectionId = await this.getCollectionId();
    const response = await this.request(`/api/v1/collections/${collectionId}/get`, {
      method: "POST",
      body: {
        include: ["documents", "metadatas"]
      }
    });
    const documents: string[] = response.documents ?? [];
    const metadatas: Array<Record<string, unknown>> = response.metadatas ?? [];
    const memories = documents.map((document, index) => memoryFromDocument(document, metadatas[index]));
    memories.sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
    return new MemoryQueryResult(memories.slice(0, maxItems));
  }

  async clear(): Promise<void> {
    try {
      const collectionId = await this.getCollectionId();
      await this.request(`/api/v1/collections/${collectionId}`, { method: "DELETE" });
    } finally {
      // Reset cached id and recreate the collection (delete-then-recreate intent).
      this.collectionId = undefined;
      await this.getCollectionId();
    }
  }

  override async getStats(): Promise<Record<string, unknown>> {
    let currentMemories = 0;
    try {
      currentMemories = await this.count();
    } catch {
      currentMemories = 0;
    }
    return {
      ...(await super.getStats()),
      currentMemories,
      collectionName: this.collectionName,
      baseUrl: this.baseUrl,
      distanceMetric: this.distanceMetric,
      k: this.k,
      scoreThreshold: this.scoreThreshold,
      // The HTTP ChromaDB client always targets a running (persistent) server.
      isPersistent: Boolean(this.baseUrl)
    };
  }

  private async getCollectionId(): Promise<string> {
    if (this.collectionId) return this.collectionId;
    const response = await this.request("/api/v1/collections", {
      method: "POST",
      body: {
        name: this.collectionName,
        metadata: { "hnsw:space": this.distanceMetric },
        get_or_create: true
      }
    });
    const collectionId = String(response.id ?? response.name ?? this.collectionName);
    this.collectionId = collectionId;
    return collectionId;
  }

  private async request(pathname: string, init: { method: string; body?: unknown }): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: init.method,
      headers: { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    if (!response.ok) {
      throw new Error(`ChromaDB request failed (${response.status}): ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  static componentType = "memory" as const;
  static componentProvider = "picoagents.memory.ChromaDBMemory";
  static componentVersion = 1;

  toConfig(): Record<string, unknown> {
    return {
      collectionName: this.collectionName,
      maxMemories: this.maxMemories,
      baseUrl: this.baseUrl,
      tenant: this.tenant,
      database: this.database,
      distanceMetric: this.distanceMetric,
      k: this.k,
      scoreThreshold: this.scoreThreshold
    };
  }

  static fromConfig(config: any): ChromaDBMemory {
    return new ChromaDBMemory({
      collectionName: config?.collectionName ?? config?.collection_name,
      maxMemories: config?.maxMemories ?? config?.max_memories,
      baseUrl: config?.baseUrl ?? config?.base_url,
      tenant: config?.tenant,
      database: config?.database,
      distanceMetric: config?.distanceMetric ?? config?.distance_metric,
      k: config?.k,
      scoreThreshold: config?.scoreThreshold ?? config?.score_threshold
    });
  }
}

registerComponent(ListMemory as any);
registerComponent(FileMemory as any);
registerComponent(ChromaDBMemory as any);

function memoryFromDocument(document: string, metadata: Record<string, unknown> = {}): MemoryContent {
  let content: MemoryPayload = document;
  try {
    const parsed = JSON.parse(document);
    if (parsed && typeof parsed === "object") content = parsed;
  } catch {
    // Keep text content.
  }
  const { timestamp, mime_type, ...rest } = metadata;
  return new MemoryContent({
    content,
    mimeType: typeof mime_type === "string" ? mime_type : "text/plain",
    metadata: rest,
    timestamp: typeof timestamp === "string" ? timestamp : undefined
  });
}
