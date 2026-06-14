/**
 * Middleware system for picoagents-ts.
 *
 * Middleware intercepts agent operations (model calls, tool calls, memory access)
 * and can emit events for observability, transform requests/responses, pause
 * execution for approval, or recover from errors. Each hook is an async generator
 * that yields {@link AgentEvent}s and, as its final value, the context or result.
 *
 * Ported from Python `_middleware.py`.
 */

import { AgentContext } from "./context.js";
import { BaseEvent, ToolApprovalEvent } from "./types.js";
import type { AgentEvent } from "./types.js";

export interface MiddlewareContextInit {
  operation: string;
  agentName: string;
  agentContext: AgentContext;
  data: unknown;
  metadata?: Record<string, unknown>;
}

/** Context passed through the middleware chain. */
export class MiddlewareContext {
  operation: string;
  agentName: string;
  agentContext: AgentContext;
  data: unknown;
  metadata: Record<string, unknown>;

  constructor(init: MiddlewareContextInit) {
    this.operation = init.operation;
    this.agentName = init.agentName;
    this.agentContext = init.agentContext;
    this.data = init.data;
    this.metadata = init.metadata ?? {};
  }
}

type RequestYield = MiddlewareContext | AgentEvent;
type ResponseYield = unknown | AgentEvent;

/**
 * Base class for middleware components.
 *
 * Subclasses override the async-generator methods. The final value yielded by
 * `processRequest` MUST be the (possibly modified) {@link MiddlewareContext};
 * the final value yielded by `processResponse` MUST be the result.
 */
export abstract class BaseMiddleware {
  /** Process before the operation runs. Yield events, then the context. */
  async *processRequest(context: MiddlewareContext): AsyncGenerator<RequestYield> {
    yield context;
  }

  /** Process after the operation succeeds. Yield events, then the result. */
  async *processResponse(_context: MiddlewareContext, result: unknown): AsyncGenerator<ResponseYield> {
    yield result;
  }

  /** Handle an operation error. Yield events then either rethrow or yield a recovery value. */
  async *processError(_context: MiddlewareContext, error: Error): AsyncGenerator<ResponseYield> {
    throw error;
  }
}

/** Executes a chain of middleware as an async-generator pipeline. */
export class MiddlewareChain {
  middlewares: BaseMiddleware[];

  constructor(middlewares: BaseMiddleware[] = []) {
    this.middlewares = middlewares;
  }

  add(middleware: BaseMiddleware): void {
    this.middlewares.push(middleware);
  }

  remove(middleware: BaseMiddleware): void {
    const idx = this.middlewares.indexOf(middleware);
    if (idx >= 0) this.middlewares.splice(idx, 1);
  }

  /**
   * Execute the chain: pre-process (forward), run `func`, post-process (reverse).
   * Yields events along the way and the final result last.
   */
  async *executeStream(
    operation: string,
    agentName: string,
    agentContext: AgentContext,
    data: unknown,
    func: (data: unknown) => Promise<unknown>,
    metadata?: Record<string, unknown>
  ): AsyncGenerator<ResponseYield> {
    let ctx = new MiddlewareContext({
      operation,
      agentName,
      agentContext,
      data,
      metadata: metadata ?? {}
    });

    // PHASE 1: pre-process (forward order)
    for (const middleware of this.middlewares) {
      try {
        let finalCtx: MiddlewareContext | null = null;
        for await (const item of middleware.processRequest(ctx)) {
          if (item instanceof MiddlewareContext) {
            finalCtx = item;
          } else if (item instanceof BaseEvent) {
            yield item;
            if (item instanceof ToolApprovalEvent) {
              return; // pause: wait for approval
            }
          }
        }
        if (finalCtx === null) {
          return; // middleware paused without yielding context
        }
        ctx = finalCtx;
      } catch (error) {
        const recovered = yield* this.runErrorHandlers(ctx, error as Error);
        if (recovered.handled) return;
        throw error;
      }
    }

    // PHASE 2: execute the operation
    let result: unknown;
    try {
      result = await func(ctx.data);
    } catch (error) {
      const recovered = yield* this.runErrorHandlers(ctx, error as Error);
      if (recovered.handled) return;
      throw error;
    }

    // PHASE 3: post-process (reverse order)
    for (const middleware of [...this.middlewares].reverse()) {
      try {
        let finalResult: unknown = undefined;
        let sawResult = false;
        for await (const item of middleware.processResponse(ctx, result)) {
          if (item instanceof BaseEvent) {
            yield item;
          } else {
            finalResult = item;
            sawResult = true;
          }
        }
        if (sawResult) result = finalResult;
      } catch (error) {
        const recovered = yield* this.runErrorHandlers(ctx, error as Error);
        if (recovered.handled) return;
        throw error;
      }
    }

    yield result;
  }

  private async *runErrorHandlers(
    ctx: MiddlewareContext,
    error: Error
  ): AsyncGenerator<ResponseYield, { handled: boolean }> {
    for (const errorMw of [...this.middlewares].reverse()) {
      try {
        for await (const item of errorMw.processError(ctx, error)) {
          if (item instanceof BaseEvent) {
            yield item;
          } else {
            // Recovery value
            yield item;
            return { handled: true };
          }
        }
      } catch {
        continue;
      }
    }
    return { handled: false };
  }
}

// ---------------------------------------------------------------------------
// Example middleware implementations
// ---------------------------------------------------------------------------

/** Logs all agent operations to the console. */
export class LoggingMiddleware extends BaseMiddleware {
  private logger: Pick<Console, "info" | "error">;

  constructor(logger?: Pick<Console, "info" | "error">) {
    super();
    this.logger = logger ?? console;
  }

  async *processRequest(context: MiddlewareContext): AsyncGenerator<RequestYield> {
    this.logger.info(`[${context.agentName}] Starting ${context.operation}`);
    context.metadata.startTime = Date.now();
    yield context;
  }

  async *processResponse(context: MiddlewareContext, result: unknown): AsyncGenerator<ResponseYield> {
    const start = (context.metadata.startTime as number) ?? Date.now();
    const duration = (Date.now() - start) / 1000;
    this.logger.info(`[${context.agentName}] Completed ${context.operation} in ${duration.toFixed(2)}s`);
    yield result;
  }

  async *processError(context: MiddlewareContext, error: Error): AsyncGenerator<ResponseYield> {
    this.logger.error(`[${context.agentName}] Error in ${context.operation}: ${error}`);
    throw error;
  }
}

/** Rate limits operations per chain using a sliding 60s window. */
export class RateLimitMiddleware extends BaseMiddleware {
  private maxCalls: number;
  private callTimes: number[] = [];

  constructor(maxCallsPerMinute = 60) {
    super();
    this.maxCalls = maxCallsPerMinute;
  }

  async *processRequest(context: MiddlewareContext): AsyncGenerator<RequestYield> {
    let now = Date.now();
    this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
    if (this.callTimes.length >= this.maxCalls) {
      const oldest = this.callTimes[0] ?? now;
      const waitMs = 60_000 - (now - oldest);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        now = Date.now();
      }
    }
    this.callTimes.push(now);
    yield context;
  }
}

/** Enforces safety guardrails: blocks tools by name and content by pattern. */
export class GuardrailMiddleware extends BaseMiddleware {
  private blockedTools: string[];
  private blockedPatterns: RegExp[];

  constructor(options: { blockedTools?: string[]; blockedPatterns?: string[] } = {}) {
    super();
    this.blockedTools = options.blockedTools ?? [];
    this.blockedPatterns = (options.blockedPatterns ?? []).map((p) => new RegExp(p));
  }

  async *processRequest(context: MiddlewareContext): AsyncGenerator<RequestYield> {
    if (context.operation === "tool_call") {
      const data = context.data as { toolName?: string; parameters?: unknown } | undefined;
      if (data?.toolName && this.blockedTools.includes(data.toolName)) {
        throw new Error(`Tool '${data.toolName}' is blocked by guardrails`);
      }
      const paramsStr = JSON.stringify(data?.parameters ?? {});
      for (const pattern of this.blockedPatterns) {
        if (pattern.test(paramsStr)) {
          throw new Error(`Tool parameters match blocked pattern: ${pattern.source}`);
        }
      }
    } else if (context.operation === "model_call" && Array.isArray(context.data)) {
      for (const msg of context.data as Array<{ content?: string }>) {
        if (typeof msg.content === "string") {
          for (const pattern of this.blockedPatterns) {
            if (pattern.test(msg.content)) {
              throw new Error(`Message contains blocked pattern: ${pattern.source}`);
            }
          }
        }
      }
    }
    yield context;
  }
}

/** Collects basic metrics about agent operations. */
export class MetricsMiddleware extends BaseMiddleware {
  metrics = {
    totalOperations: 0,
    operationsByType: {} as Record<string, number>,
    errorsByType: {} as Record<string, number>,
    totalDuration: 0,
    operationDurations: [] as Array<[string, number]>
  };

  async *processRequest(context: MiddlewareContext): AsyncGenerator<RequestYield> {
    this.metrics.totalOperations += 1;
    this.metrics.operationsByType[context.operation] =
      (this.metrics.operationsByType[context.operation] ?? 0) + 1;
    context.metadata.metricsStartTime = Date.now();
    yield context;
  }

  async *processResponse(context: MiddlewareContext, result: unknown): AsyncGenerator<ResponseYield> {
    const start = (context.metadata.metricsStartTime as number) ?? Date.now();
    const duration = (Date.now() - start) / 1000;
    this.metrics.totalDuration += duration;
    this.metrics.operationDurations.push([context.operation, duration]);
    if (this.metrics.operationDurations.length > 100) {
      this.metrics.operationDurations = this.metrics.operationDurations.slice(-100);
    }
    yield result;
  }

  async *processError(context: MiddlewareContext, error: Error): AsyncGenerator<ResponseYield> {
    const errorType = error.name || "Error";
    this.metrics.errorsByType[errorType] = (this.metrics.errorsByType[errorType] ?? 0) + 1;
    throw error;
  }

  getMetrics(): Record<string, unknown> {
    const avg =
      this.metrics.totalOperations > 0
        ? this.metrics.totalDuration / this.metrics.totalOperations
        : 0;
    return { ...this.metrics, averageDuration: avg };
  }
}
