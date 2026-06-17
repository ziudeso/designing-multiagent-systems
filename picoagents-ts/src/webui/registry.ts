import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Entity } from "./models.js";
import {
  createEntityInfoFromObject,
  PicoAgentsScanner
} from "./discovery.js";

export class EntityRegistry {
  entitiesDir?: string;
  scanner?: PicoAgentsScanner;
  private entities = new Map<string, Entity>();
  private inMemoryEntities = new Map<string, unknown>();

  constructor(entitiesDir?: string) {
    this.entitiesDir = entitiesDir;
    this.scanner = entitiesDir ? new PicoAgentsScanner(entitiesDir) : undefined;
  }

  async refreshEntities(): Promise<void> {
    if (!this.scanner) return;
    const discovered = await this.scanner.discoverEntities();
    for (const entity of discovered) {
      this.entities.set(entity.id, entity);
    }
  }

  registerEntity(entityId: string, entityObject: unknown): Entity | undefined {
    this.inMemoryEntities.set(entityId, entityObject);
    const entityInfo = createEntityInfoFromObject(entityId, entityObject, {
      source: "memory"
    });
    if (entityInfo) this.entities.set(entityId, entityInfo);
    return entityInfo;
  }

  async registerFromFile(filePath: string, entityId: string): Promise<Entity | undefined> {
    const scanner = new PicoAgentsScanner(path.dirname(filePath));
    const discovered = await scanner.discoverEntities();
    const entity = discovered.find((item) => item.id.startsWith(`${path.parse(filePath).name}.`));
    if (!entity) return undefined;
    const object = scanner.getEntityObject(entity.id);
    if (object) this.inMemoryEntities.set(entityId, object);
    const info = object
      ? createEntityInfoFromObject(entityId, object, {
          source: "github",
          modulePath: filePath
        })
      : { ...entity, id: entityId, source: "github", modulePath: filePath };
    if (info) this.entities.set(entityId, info);
    return info;
  }

  async registerFromUrl(url: string, entityId: string): Promise<Entity | undefined> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    const fileName = `${entityId}${path.extname(new URL(url).pathname) || ".js"}`;
    const directory = path.join(tmpdir(), "picoagents_ts_examples");
    const filePath = path.join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, await response.text(), "utf8");
    return this.registerFromFile(filePath, entityId);
  }

  getEntityInfo(entityId: string): Entity | undefined {
    return this.entities.get(entityId);
  }

  getEntityObject(entityId: string): unknown | undefined {
    return this.inMemoryEntities.get(entityId) ?? this.scanner?.getEntityObject(entityId);
  }

  listEntities(): Entity[] {
    return [...this.entities.values()];
  }

  listAgents(): Entity[] {
    return this.listEntities().filter((entity) => entity.type === "agent");
  }

  listOrchestrators(): Entity[] {
    return this.listEntities().filter((entity) => entity.type === "orchestrator");
  }

  listWorkflows(): Entity[] {
    return this.listEntities().filter((entity) => entity.type === "workflow");
  }

  unregisterEntity(entityId: string): boolean {
    const entity = this.entities.get(entityId);
    if (entity && entity.source === "directory") return false;
    const removedMemory = this.inMemoryEntities.delete(entityId);
    const removedInfo = this.entities.delete(entityId);
    return removedMemory || removedInfo;
  }

  async clearCache(): Promise<void> {
    this.scanner?.clearCache();
    this.entities.clear();
    for (const [id, object] of this.inMemoryEntities.entries()) {
      const info = createEntityInfoFromObject(id, object, { source: "memory" });
      if (info) this.entities.set(id, info);
    }
    await this.refreshEntities();
  }
}
