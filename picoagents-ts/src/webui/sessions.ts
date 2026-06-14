import { randomUUID } from "node:crypto";
import { AgentContext } from "../context.js";
import { InMemorySessionStore, SessionStore } from "./sessionStore.js";
import type { SessionInfo } from "./models.js";

export class SessionManager {
  store: SessionStore;

  constructor(store: SessionStore = new InMemorySessionStore()) {
    this.store = store;
  }

  async getOrCreate(sessionId: string, entityId: string, entityType = "agent"): Promise<AgentContext> {
    let context = await this.store.get(sessionId);
    if (!context) {
      context = new AgentContext({
        sessionId,
        metadata: {
          entityId,
          entityType,
          lastActivity: new Date()
        }
      });
      await this.store.save(sessionId, context);
    }
    return context;
  }

  get(sessionId: string): Promise<AgentContext | undefined> {
    return this.store.get(sessionId);
  }

  async update(sessionId: string, context: AgentContext): Promise<void> {
    context.metadata.lastActivity = new Date();
    await this.store.save(sessionId, context);
  }

  list(entityId?: string): Promise<SessionInfo[]> {
    return this.store.list(entityId);
  }

  delete(sessionId: string): Promise<boolean> {
    return this.store.delete(sessionId);
  }

  clearAll(): Promise<number> {
    return this.store.clearAll();
  }

  createSessionId(): string {
    return randomUUID();
  }
}
