import { spawn } from "node:child_process";
import { Server } from "node:http";
import path from "node:path";
import { Entity } from "./models.js";
import { PicoAgentsScanner } from "./discovery.js";
import { EntityRegistry } from "./registry.js";
import { ExecutionEngine } from "./execution.js";
import { SessionManager } from "./sessions.js";
import {
  PicoAgentsWebUIServer,
  PicoAgentsWebUIServerOptions,
  createApp
} from "./server.js";

export { PicoAgentsScanner } from "./discovery.js";
export { EntityRegistry } from "./registry.js";
export { ExecutionEngine } from "./execution.js";
export { EvalJobManager } from "./evalJobs.js";
export {
  CachedFileSessionStore,
  FileSessionStore,
  InMemorySessionStore,
  SessionStore
} from "./sessionStore.js";
export { SessionManager } from "./sessions.js";
export {
  PicoAgentsWebUIServer,
  createApp
} from "./server.js";
export type { PicoAgentsWebUIServerOptions } from "./server.js";
export type {
  AddExampleRequest,
  AgentInfo,
  Entity,
  EntityInfo,
  HealthResponse,
  OrchestratorInfo,
  RunEntityRequest,
  SessionInfo,
  WebUIStreamEvent,
  WorkflowInfo
} from "./models.js";

export interface LaunchOptions extends PicoAgentsWebUIServerOptions {
  port?: number;
  host?: string;
  autoOpen?: boolean;
}

export async function launch(options: LaunchOptions = {}): Promise<Server> {
  return webui(options);
}

export async function webui(options: LaunchOptions = {}): Promise<Server> {
  const port = options.port ?? 8080;
  const host = options.host ?? "127.0.0.1";
  const server = new PicoAgentsWebUIServer(options);
  const httpServer = await server.createHttpServer();

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  const url = `http://${host}:${port}`;
  console.log(`Starting PicoAgents WebUI on ${url}`);
  if (options.autoOpen ?? true) openBrowser(url);
  return httpServer;
}

export class WebUIServer {
  private server: PicoAgentsWebUIServer;
  port: number;
  host: string;
  private httpServer?: Server;

  constructor(options: LaunchOptions = {}) {
    this.server = new PicoAgentsWebUIServer(options);
    this.port = options.port ?? 8080;
    this.host = options.host ?? "127.0.0.1";
  }

  registerEntity(entityId: string, entityObject: unknown): Entity | undefined {
    return this.server.registerEntity(entityId, entityObject);
  }

  async getHttpServer(): Promise<Server> {
    this.httpServer ??= await this.server.createHttpServer();
    return this.httpServer;
  }

  async start(autoOpen = false): Promise<Server> {
    const httpServer = await this.getHttpServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(this.port, this.host, resolve);
    });
    const url = `http://${this.host}:${this.port}`;
    console.log(`Serving ${this.server.registry.listEntities().length} entities at ${url}`);
    if (autoOpen) openBrowser(url);
    return httpServer;
  }
}

export async function serve(options: {
  entities?: unknown[];
  entitiesDir?: string;
  port?: number;
  host?: string;
  autoOpen?: boolean;
  staticDir?: string;
} = {}): Promise<Server> {
  const server = new WebUIServer({
    entitiesDir: options.entitiesDir,
    port: options.port,
    host: options.host,
    staticDir: options.staticDir
  });

  options.entities?.forEach((entity, index) => {
    const entityId = (entity as any).name ?? `entity_${index}`;
    server.registerEntity(entityId, entity);
  });

  return server.start(options.autoOpen ?? true);
}

export async function scanEntities(directory: string): Promise<Entity[]> {
  return new PicoAgentsScanner(path.resolve(directory)).discoverEntities();
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
