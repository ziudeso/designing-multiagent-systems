import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentContext } from "../context.js";
import { deserializeContext, serializeContext } from "./serialization.js";
import type { SessionInfo } from "./models.js";

export abstract class SessionStore {
  abstract get(sessionId: string): Promise<AgentContext | undefined>;
  abstract save(sessionId: string, context: AgentContext): Promise<void>;
  abstract list(entityId?: string): Promise<SessionInfo[]>;
  abstract delete(sessionId: string): Promise<boolean>;
  abstract clearAll(): Promise<number>;
}

export class InMemorySessionStore extends SessionStore {
  private sessions = new Map<string, AgentContext>();

  async get(sessionId: string): Promise<AgentContext | undefined> {
    return this.sessions.get(sessionId);
  }

  async save(sessionId: string, context: AgentContext): Promise<void> {
    this.sessions.set(sessionId, context);
  }

  async list(entityId?: string): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    for (const [id, context] of this.sessions.entries()) {
      if (entityId && context.metadata.entityId !== entityId && context.metadata.entity_id !== entityId) {
        continue;
      }
      sessions.push(sessionInfoFromContext(id, context));
    }
    return sortSessions(sessions);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  async clearAll(): Promise<number> {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }
}

export class FileSessionStore extends SessionStore {
  storageDir: string;

  constructor(storageDir = ".picoagents_sessions") {
    super();
    this.storageDir = path.resolve(storageDir);
  }

  async get(sessionId: string): Promise<AgentContext | undefined> {
    try {
      const data = JSON.parse(await fs.readFile(this.pathFor(sessionId), "utf8"));
      return deserializeContext(data);
    } catch {
      return undefined;
    }
  }

  async save(sessionId: string, context: AgentContext): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.writeFile(
      this.pathFor(sessionId),
      JSON.stringify(serializeContext(context), null, 2),
      "utf8"
    );
  }

  async list(entityId?: string): Promise<SessionInfo[]> {
    await fs.mkdir(this.storageDir, { recursive: true });
    const sessions: SessionInfo[] = [];
    for (const entry of await fs.readdir(this.storageDir)) {
      if (!entry.endsWith(".json")) continue;
      const sessionId = entry.slice(0, -".json".length);
      const context = await this.get(sessionId);
      if (!context) continue;
      if (entityId && context.metadata.entityId !== entityId && context.metadata.entity_id !== entityId) {
        continue;
      }
      sessions.push(sessionInfoFromContext(sessionId, context));
    }
    return sortSessions(sessions);
  }

  async delete(sessionId: string): Promise<boolean> {
    try {
      await fs.rm(this.pathFor(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  async clearAll(): Promise<number> {
    await fs.mkdir(this.storageDir, { recursive: true });
    let count = 0;
    for (const entry of await fs.readdir(this.storageDir)) {
      if (!entry.endsWith(".json")) continue;
      await fs.rm(path.join(this.storageDir, entry));
      count += 1;
    }
    return count;
  }

  private pathFor(sessionId: string): string {
    return path.join(this.storageDir, `${sessionId}.json`);
  }
}

export class CachedFileSessionStore extends SessionStore {
  private cache = new Map<string, AgentContext>();
  private fileStore: FileSessionStore;

  constructor(storageDir = ".picoagents_sessions") {
    super();
    this.fileStore = new FileSessionStore(storageDir);
  }

  async get(sessionId: string): Promise<AgentContext | undefined> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const context = await this.fileStore.get(sessionId);
    if (context) this.cache.set(sessionId, context);
    return context;
  }

  async save(sessionId: string, context: AgentContext): Promise<void> {
    this.cache.set(sessionId, context);
    await this.fileStore.save(sessionId, context);
  }

  list(entityId?: string): Promise<SessionInfo[]> {
    return this.fileStore.list(entityId);
  }

  async delete(sessionId: string): Promise<boolean> {
    this.cache.delete(sessionId);
    return this.fileStore.delete(sessionId);
  }

  async clearAll(): Promise<number> {
    this.cache.clear();
    return this.fileStore.clearAll();
  }
}

function sessionInfoFromContext(id: string, context: AgentContext): SessionInfo {
  const lastActivityValue = context.metadata.lastActivity ?? context.metadata.last_activity ?? context.createdAt;
  const lastActivity = lastActivityValue instanceof Date
    ? lastActivityValue.toISOString()
    : new Date(String(lastActivityValue)).toISOString();
  return {
    id,
    entityId: String(context.metadata.entityId ?? context.metadata.entity_id ?? "unknown"),
    entityType: String(context.metadata.entityType ?? context.metadata.entity_type ?? "agent"),
    createdAt: context.createdAt.toISOString(),
    messageCount: context.messages.length,
    lastActivity: lastActivity
  };
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
}
