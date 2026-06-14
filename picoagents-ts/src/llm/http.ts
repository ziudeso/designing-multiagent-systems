import { BaseChatCompletionError } from "./base.js";

export interface FetchWithRetriesOptions {
  fetchImpl: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
  retryDelayMs: number;
  signal?: AbortSignal;
}

export async function fetchWithRetries(
  url: string,
  init: RequestInit,
  options: FetchWithRetriesOptions
): Promise<Response> {
  const maxRetries = Math.max(0, options.maxRetries);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let timedOut = false;
    const controller = new AbortController();
    const cleanup: Array<() => void> = [];

    if (options.signal) {
      if (options.signal.aborted) throw new Error("Operation cancelled");
      const abortFromParent = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener("abort", abortFromParent, { once: true });
      cleanup.push(() => options.signal?.removeEventListener("abort", abortFromParent));
    }

    if (options.timeoutMs > 0) {
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      cleanup.push(() => clearTimeout(timeout));
    }

    try {
      const response = await options.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });
      if (
        response.ok ||
        !isRetryableStatus(response.status) ||
        attempt >= maxRetries
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      await waitForRetry(retryDelayMs(attempt, options.retryDelayMs, response.headers), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Operation cancelled");
      if (attempt < maxRetries && isRetryableFetchError(error)) {
        await waitForRetry(retryDelayMs(attempt, options.retryDelayMs), options.signal);
        continue;
      }
      if (timedOut) {
        throw new BaseChatCompletionError(`Request timed out after ${options.timeoutMs}ms`);
      }
      throw error instanceof Error
        ? error
        : new BaseChatCompletionError(`Fetch failed: ${String(error)}`);
    } finally {
      for (const clean of cleanup) clean();
    }
  }

  throw new BaseChatCompletionError("Fetch retry loop exited unexpectedly");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.name === "AbortError" || error.name === "TypeError" || error instanceof BaseChatCompletionError;
}

function retryDelayMs(attempt: number, baseDelayMs: number, headers?: Headers): number {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.max(0, baseDelayMs) * 2 ** attempt;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) return Promise.reject(new Error("Operation cancelled"));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Operation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
