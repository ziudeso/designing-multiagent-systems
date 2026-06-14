export class CancellationToken {
  private cancelled = false;
  private callbacks = new Set<() => void>();

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch {
        // Ignore cancellation callback errors.
      }
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  addCallback(callback: () => void): () => void {
    if (this.cancelled) {
      callback();
      return () => undefined;
    }
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  linkAbortController(controller: AbortController): AbortController {
    this.addCallback(() => controller.abort());
    return controller;
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error("Operation cancelled");
    }
  }
}
