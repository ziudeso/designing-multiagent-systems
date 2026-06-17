import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CancellationToken } from "../cancellation.js";
import { getDefaultStore, PicoStore } from "../store/index.js";
import { AgentResponse } from "../types.js";
import { EvalJobManager } from "./evalJobs.js";
import { ExecutionEngine } from "./execution.js";
import type { AddExampleRequest, Entity, HealthResponse, RunEntityRequest } from "./models.js";
import { handlePersistenceApi } from "./persistenceApi.js";
import { EntityRegistry } from "./registry.js";
import {
  parseMessages,
  serializeContext,
  serializeEvent
} from "./serialization.js";
import { SessionManager } from "./sessions.js";

export interface PicoAgentsWebUIServerOptions {
  entitiesDir?: string;
  enableCors?: boolean;
  corsOrigins?: string[];
  staticDir?: string;
  /** Persistence store for runs/eval APIs. Pass `null` or `enablePersistence: false` to disable. */
  store?: PicoStore | null;
  enablePersistence?: boolean;
}

export class PicoAgentsWebUIServer {
  entitiesDir?: string;
  enableCors: boolean;
  corsOrigins: string[];
  staticDir?: string;
  registry: EntityRegistry;
  sessionManager: SessionManager;
  executionEngine: ExecutionEngine;
  store?: PicoStore;
  evalJobs?: EvalJobManager;
  private initialized = false;

  constructor(options: PicoAgentsWebUIServerOptions = {}) {
    this.entitiesDir = options.entitiesDir;
    this.enableCors = options.enableCors ?? true;
    this.corsOrigins = options.corsOrigins ?? ["*"];
    this.staticDir = options.staticDir ?? findBundledStaticDir();
    this.registry = new EntityRegistry(options.entitiesDir);
    this.sessionManager = new SessionManager();
    this.executionEngine = new ExecutionEngine(this.sessionManager);
    if (options.enablePersistence !== false && options.store !== null) {
      this.store = options.store ?? resolveDefaultStore();
      this.evalJobs = new EvalJobManager(this.store, { registry: this.registry });
    }
  }

  registerEntity(entityId: string, entityObject: unknown): Entity | undefined {
    return this.registry.registerEntity(entityId, entityObject);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.registry.refreshEntities();
    await this.store?.initialize();
    this.initialized = true;
  }

  async createHttpServer(): Promise<Server> {
    await this.initialize();
    return createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        sendJson(response, 500, {
          detail: error instanceof Error ? error.message : String(error)
        }, this.corsHeaders(request));
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const method = request.method ?? "GET";
    const corsHeaders = this.corsHeaders(request);

    if (method === "OPTIONS") {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      const body: HealthResponse = {
        status: "healthy",
        entitiesDir: this.entitiesDir,
        entitiesCount: this.registry.listEntities().length
      };
      sendJson(response, 200, body, corsHeaders);
      return;
    }

    if (method === "GET" && pathname === "/api/entities") {
      sendJson(response, 200, this.registry.listEntities(), corsHeaders);
      return;
    }

    if (method === "POST" && pathname === "/api/entities/add") {
      const body = await readJson<Record<string, any> & AddExampleRequest>(request);
      const githubPath = body.githubPath ?? body.github_path;
      const exampleId = body.exampleId ?? body.example_id;
      const baseUrl = "https://raw.githubusercontent.com/victordibia/designing-multiagent-systems/main";
      const entity = await this.registry.registerFromUrl(
        `${baseUrl}/${githubPath}`,
        exampleId
      );
      if (!entity) {
        sendJson(response, 500, { detail: `Failed to register example: ${exampleId}` }, corsHeaders);
        return;
      }
      sendJson(response, 200, entity, corsHeaders);
      return;
    }

    const entityMatch = pathname.match(/^\/api\/entities\/([^/]+)$/);
    if (entityMatch && method === "GET") {
      const entity = this.registry.getEntityInfo(entityMatch[1]!);
      if (!entity) sendJson(response, 404, { detail: `Entity ${entityMatch[1]} not found` }, corsHeaders);
      else sendJson(response, 200, entity, corsHeaders);
      return;
    }

    if (entityMatch && method === "DELETE") {
      const removed = this.registry.unregisterEntity(entityMatch[1]!);
      if (!removed) {
        sendJson(response, 404, {
          detail: `Entity ${entityMatch[1]} not found or cannot be removed`
        }, corsHeaders);
      } else {
        sendJson(response, 200, {
          status: "success",
          entityId: entityMatch[1],
          message: "Entity removed successfully"
        }, corsHeaders);
      }
      return;
    }

    const runMatch = pathname.match(/^\/api\/entities\/([^/]+)\/run$/);
    if (runMatch && method === "POST") {
      await this.handleRunEntity(runMatch[1]!, request, response, corsHeaders);
      return;
    }

    const streamMatch = pathname.match(/^\/api\/entities\/([^/]+)\/run\/stream$/);
    if (streamMatch && method === "POST") {
      await this.handleRunEntityStream(streamMatch[1]!, request, response, corsHeaders);
      return;
    }

    if (method === "GET" && pathname === "/api/sessions") {
      sendJson(
        response,
        200,
        await this.sessionManager.list(url.searchParams.get("entityId") ?? url.searchParams.get("entity_id") ?? undefined),
        corsHeaders
      );
      return;
    }

    if (method === "POST" && pathname === "/api/sessions") {
      const body = await readJson<Record<string, any>>(request);
      const entityId = body.entityId ?? body.entity_id;
      const entityType = body.entityType ?? body.entity_type ?? "agent";
      if (!entityId) {
        sendJson(response, 400, { detail: "entityId is required" }, corsHeaders);
        return;
      }
      const sessionId = this.sessionManager.createSessionId();
      const context = await this.sessionManager.getOrCreate(sessionId, entityId, entityType);
      sendJson(response, 200, {
        id: sessionId,
        entityId,
        entityType,
        createdAt: context.createdAt.toISOString(),
        messageCount: 0,
        lastActivity: context.createdAt.toISOString()
      }, corsHeaders);
      return;
    }

    const sessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sessionMessagesMatch && method === "GET") {
      const context = await this.sessionManager.get(sessionMessagesMatch[1]!);
      if (!context) sendJson(response, 404, { detail: `Session ${sessionMessagesMatch[1]} not found` }, corsHeaders);
      else sendJson(response, 200, { sessionId: sessionMessagesMatch[1], messages: context.messages }, corsHeaders);
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "GET") {
      const context = await this.sessionManager.get(sessionMatch[1]!);
      if (!context) sendJson(response, 404, { detail: `Session ${sessionMatch[1]} not found` }, corsHeaders);
      else sendJson(response, 200, serializeContext(context), corsHeaders);
      return;
    }

    if (sessionMatch && method === "DELETE") {
      const deleted = await this.sessionManager.delete(sessionMatch[1]!);
      if (!deleted) sendJson(response, 404, { detail: `Session ${sessionMatch[1]} not found` }, corsHeaders);
      else sendJson(response, 200, { status: "deleted", sessionId: sessionMatch[1] }, corsHeaders);
      return;
    }

    if (method === "POST" && pathname === "/api/cache/clear") {
      await this.registry.clearCache();
      sendJson(response, 200, { status: "cache_cleared" }, corsHeaders);
      return;
    }

    if (method === "GET" && pathname === "/api/stats") {
      const entities = this.registry.listEntities();
      const sessions = await this.sessionManager.list();
      sendJson(response, 200, {
        entities: {
          total: entities.length,
          byType: {
            agents: entities.filter((entity) => entity.type === "agent").length,
            orchestrators: entities.filter((entity) => entity.type === "orchestrator").length,
            workflows: entities.filter((entity) => entity.type === "workflow").length
          }
        },
        sessions: {
          totalSessions: sessions.length,
          totalMessages: sessions.reduce((sum, session) => sum + session.messageCount, 0)
        }
      }, corsHeaders);
      return;
    }

    if (pathname.startsWith("/api/runs") || pathname.startsWith("/api/eval")) {
      await handlePersistenceApi({
        pathname,
        method,
        url,
        request,
        response,
        headers: corsHeaders,
        store: this.store,
        evalJobs: this.evalJobs
      });
      return;
    }

    if (method === "GET") {
      await this.serveFrontend(pathname, response, corsHeaders);
      return;
    }

    sendJson(response, 404, { detail: "Not found" }, corsHeaders);
  }

  private async handleRunEntity(
    entityId: string,
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>
  ): Promise<void> {
    const entity = this.registry.getEntityObject(entityId) as any;
    const info = this.registry.getEntityInfo(entityId);
    if (!entity || !info) {
      sendJson(response, 404, { detail: `Entity ${entityId} not found` }, headers);
      return;
    }
    if (info.type !== "agent") {
      sendJson(response, 400, { detail: `Non-streaming execution not supported for ${info.type}` }, headers);
      return;
    }
    const body = await readJson<RunEntityRequest>(request);
    if (!body.messages?.length) {
      sendJson(response, 400, { detail: "Messages required for agent execution" }, headers);
      return;
    }
    const result = await this.executionEngine.executeAgent(
      entity,
      parseMessages(body.messages),
      body.sessionId ?? (body as any).session_id
    );
    sendJson(response, 200, serializeEvent(result), headers);
  }

  private async handleRunEntityStream(
    entityId: string,
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>
  ): Promise<void> {
    const entity = this.registry.getEntityObject(entityId) as any;
    const info = this.registry.getEntityInfo(entityId);
    if (!entity || !info) {
      sendJson(response, 404, { detail: `Entity ${entityId} not found` }, headers);
      return;
    }

    const body = await readJson<RunEntityRequest>(request);
    const token = new CancellationToken();
    response.on("close", () => {
      if (!response.writableEnded) token.cancel();
    });

    response.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    let stream: AsyncGenerator<string>;
    if (info.type === "agent") {
      const approvalResponses = body.approvalResponses ?? (body as any).approval_responses;
      if (!body.messages?.length && !approvalResponses?.length) {
        response.write(`data: ${JSON.stringify({ error: "Messages required for agent execution" })}\n\n`);
        response.end();
        return;
      }
      stream = this.executionEngine.executeAgentStream({
        agent: entity,
        messages: parseMessages(body.messages),
        sessionId: body.sessionId ?? (body as any).session_id,
        streamTokens: body.streamTokens ?? (body as any).stream_tokens ?? true,
        approvalResponses,
        cancellationToken: token
      });
    } else if (info.type === "orchestrator") {
      if (!body.messages?.length) {
        response.write(`data: ${JSON.stringify({ error: "Messages required for orchestrator execution" })}\n\n`);
        response.end();
        return;
      }
      stream = this.executionEngine.executeOrchestratorStream({
        orchestrator: entity,
        messages: parseMessages(body.messages),
        sessionId: body.sessionId ?? (body as any).session_id,
        cancellationToken: token
      });
    } else {
      const inputData = body.inputData ?? (body as any).input_data;
      if (inputData === undefined) {
        response.write(`data: ${JSON.stringify({ error: "Input data required for workflow execution" })}\n\n`);
        response.end();
        return;
      }
      stream = this.executionEngine.executeWorkflowStream({
        workflow: entity,
        inputData,
        sessionId: body.sessionId ?? (body as any).session_id,
        cancellationToken: token
      });
    }

    for await (const chunk of stream) {
      response.write(chunk);
    }
    response.end();
  }

  private corsHeaders(request: IncomingMessage): Record<string, string> {
    if (!this.enableCors) return {};
    const origin = request.headers.origin;
    const allowOrigin = this.corsOrigins.includes("*")
      ? "*"
      : origin && this.corsOrigins.includes(origin)
        ? origin
        : this.corsOrigins[0] ?? "*";
    const headers: Record<string, string> = {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    };
    if (allowOrigin !== "*") {
      headers["access-control-allow-credentials"] = "true";
    }
    return headers;
  }

  private async serveFrontend(pathname: string, response: ServerResponse, headers: Record<string, string>): Promise<void> {
    if (this.staticDir) {
      const candidate = safeStaticPath(this.staticDir, pathname === "/" ? "/index.html" : pathname);
      if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
        response.writeHead(200, { ...headers, "content-type": contentType(candidate) });
        createReadStream(candidate).pipe(response);
        return;
      }
      const index = safeStaticPath(this.staticDir, "/index.html");
      if (index && existsSync(index) && statSync(index).isFile() && !path.extname(pathname)) {
        response.writeHead(200, { ...headers, "content-type": contentType(index) });
        createReadStream(index).pipe(response);
        return;
      }
    }

    if (pathname === "/") {
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      response.end(defaultHtml());
      return;
    }

    sendJson(response, 404, { detail: "Not found" }, headers);
  }
}

export async function createApp(options: PicoAgentsWebUIServerOptions = {}): Promise<Server> {
  return new PicoAgentsWebUIServer(options).createHttpServer();
}

function resolveDefaultStore(): PicoStore {
  const store = getDefaultStore();
  return store instanceof PicoStore ? store : new PicoStore();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function safeStaticPath(root: string, pathname: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, pathname.replace(/^\/+/, ""));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function findBundledStaticDir(): string | undefined {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "ui"),
    path.resolve(moduleDir, "../../src/webui/ui")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
}

function defaultHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PicoAgents WebUI</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f8; color: #151518; }
      main { max-width: 920px; margin: 0 auto; padding: 40px 20px; }
      h1 { font-size: 32px; margin: 0 0 8px; }
      p { color: #555862; line-height: 1.5; }
      code { background: #ececf0; padding: 2px 5px; border-radius: 4px; }
      .panel { border: 1px solid #dddfe5; background: white; border-radius: 8px; padding: 18px; margin-top: 20px; }
      a { color: #0b57d0; }
    </style>
  </head>
  <body>
    <main>
      <h1>PicoAgents WebUI API</h1>
      <p>The TypeScript WebUI server is running. Use the API endpoints below or provide a built frontend through <code>staticDir</code>.</p>
      <div class="panel">
        <p><a href="/api/health">/api/health</a></p>
        <p><a href="/api/entities">/api/entities</a></p>
        <p><a href="/api/stats">/api/stats</a></p>
      </div>
    </main>
  </body>
</html>`;
}
