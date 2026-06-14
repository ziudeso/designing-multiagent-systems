/**
 * OpenTelemetry integration for picoagents-ts.
 *
 * Provides an {@link OTelMiddleware} that instruments model and tool calls
 * following the OpenTelemetry Gen-AI semantic conventions. Enabled with
 * `PICOAGENTS_ENABLE_OTEL=true`.
 *
 * The `@opentelemetry/api` package is an OPTIONAL dependency: it is loaded via an
 * indirect dynamic import so the build does not require it. If it is not
 * installed (or OTel is disabled), the middleware becomes a transparent pass-through.
 *
 * Ported from Python `_otel.py`.
 */

import { BaseMiddleware, MiddlewareContext } from "./middleware.js";
import type { AgentEvent } from "./types.js";

type AnyYield = unknown | AgentEvent;

function isEnabled(): boolean {
  return ["true", "1", "yes"].includes((process.env.PICOAGENTS_ENABLE_OTEL ?? "false").toLowerCase());
}

function shouldCaptureContent(): boolean {
  return ["true", "1", "yes"].includes(
    (process.env.PICOAGENTS_OTEL_CAPTURE_CONTENT ?? "false").toLowerCase()
  );
}

/** Lazily load `@opentelemetry/api` without a static dependency. */
async function loadOtelApi(): Promise<any | null> {
  try {
    // Indirection prevents the bundler/TS from requiring the module at build time.
    const moduleName = "@opentelemetry/api";
    return await import(/* @vite-ignore */ moduleName);
  } catch {
    return null;
  }
}

/**
 * OpenTelemetry middleware. Emits one span per model_call / tool_call following
 * Gen-AI semantic conventions. Content capture is opt-in via
 * `PICOAGENTS_OTEL_CAPTURE_CONTENT=true`.
 */
export class OTelMiddleware extends BaseMiddleware {
  private enabled: boolean;
  private captureContent: boolean;
  private tracer: any = null;
  private ready: Promise<void>;

  constructor() {
    super();
    this.enabled = isEnabled();
    this.captureContent = shouldCaptureContent();
    this.ready = this.enabled ? this.setup() : Promise.resolve();
  }

  private async setup(): Promise<void> {
    const otel = await loadOtelApi();
    if (!otel) {
      this.enabled = false;
      return;
    }
    try {
      this.tracer = otel.trace.getTracer("picoagents");
    } catch {
      this.enabled = false;
    }
  }

  async *processRequest(context: MiddlewareContext): AsyncGenerator<MiddlewareContext | AgentEvent> {
    await this.ready;
    if (!this.enabled || !this.tracer) {
      yield context;
      return;
    }

    let spanName: string;
    if (context.operation === "model_call") {
      spanName = `chat ${this.getModelName(context)}`;
    } else if (context.operation === "tool_call") {
      spanName = `tool ${this.getToolName(context)}`;
    } else {
      spanName = `${context.operation} ${context.agentName}`;
    }

    const span = this.tracer.startSpan(spanName);
    span.setAttribute("gen_ai.system", "picoagents");
    span.setAttribute("gen_ai.operation.name", context.operation);
    span.setAttribute("gen_ai.agent.name", context.agentName);
    if (context.agentContext.sessionId) {
      span.setAttribute("gen_ai.session.id", context.agentContext.sessionId);
    }
    if (context.operation === "model_call") {
      span.setAttribute("gen_ai.request.model", this.getModelName(context));
      if (this.captureContent && Array.isArray(context.data)) {
        try {
          span.setAttribute("gen_ai.input.messages", JSON.stringify(this.formatMessages(context.data)));
        } catch {
          /* ignore */
        }
      }
    } else if (context.operation === "tool_call") {
      span.setAttribute("gen_ai.tool.name", this.getToolName(context));
      const data = context.data as { parameters?: unknown } | undefined;
      if (this.captureContent && data?.parameters !== undefined) {
        try {
          span.setAttribute("gen_ai.tool.parameters", JSON.stringify(data.parameters));
        } catch {
          /* ignore */
        }
      }
    }

    context.metadata._otelSpan = span;
    context.metadata._otelStart = Date.now();
    yield context;
  }

  async *processResponse(context: MiddlewareContext, result: unknown): AsyncGenerator<AnyYield> {
    await this.ready;
    const span = context.metadata._otelSpan as any;
    if (!this.enabled || !span) {
      yield result;
      return;
    }
    try {
      const usage = (result as { usage?: { tokensInput?: number; tokensOutput?: number } })?.usage;
      if (context.operation === "model_call" && usage) {
        if (usage.tokensInput !== undefined) span.setAttribute("gen_ai.usage.input_tokens", usage.tokensInput);
        if (usage.tokensOutput !== undefined) span.setAttribute("gen_ai.usage.output_tokens", usage.tokensOutput);
      } else if (context.operation === "tool_call") {
        const success = (result as { success?: boolean })?.success;
        if (success !== undefined) span.setAttribute("gen_ai.tool.success", success);
      }
      span.setStatus?.({ code: 1 }); // OK
    } catch {
      /* ignore */
    } finally {
      span.end?.();
    }
    yield result;
  }

  async *processError(context: MiddlewareContext, error: Error): AsyncGenerator<AnyYield> {
    await this.ready;
    const span = context.metadata._otelSpan as any;
    if (this.enabled && span) {
      try {
        span.setStatus?.({ code: 2, message: String(error) }); // ERROR
        span.setAttribute("error.type", error.name);
        span.setAttribute("error.message", error.message);
      } catch {
        /* ignore */
      } finally {
        span.end?.();
      }
    }
    throw error;
  }

  private getModelName(context: MiddlewareContext): string {
    return (context.metadata.model as string) ?? "unknown";
  }

  private getToolName(context: MiddlewareContext): string {
    const data = context.data as { toolName?: string } | undefined;
    return data?.toolName ?? "unknown";
  }

  private formatMessages(messages: Array<{ content?: string; source?: string }>): unknown[] {
    return messages
      .map((msg) => {
        const role = msg.source && msg.source !== "user" ? "assistant" : "user";
        const parts: unknown[] = [];
        if (msg.content) parts.push({ type: "text", content: msg.content });
        return parts.length ? { role, parts } : null;
      })
      .filter(Boolean);
  }
}

/** Returns an OTelMiddleware if OTel is enabled via env, else null. */
export function maybeOtelMiddleware(): OTelMiddleware | null {
  return isEnabled() ? new OTelMiddleware() : null;
}
