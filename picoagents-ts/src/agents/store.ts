/**
 * Pluggable persistence store for agent runs.
 *
 * Mirrors Python's `picoagents.store`: when an agent is run with `persist: true`
 * and a default store has been registered, the run's {@link AgentResponse} is
 * handed to the store. By default no store is registered (a no-op), keeping the
 * agent module free of any storage dependency.
 */

import type { AgentResponse } from "../types.js";

/** Minimal interface a persistence backend must implement. */
export interface AgentRunStore {
  /** Persist a completed agent run. */
  saveAgentRun(response: AgentResponse): Promise<void>;
}

let defaultStore: AgentRunStore | null = null;

/** Register (or clear, with `null`) the module-level default store. */
export function setDefaultStore(store: AgentRunStore | null): void {
  defaultStore = store;
}

/** Return the registered default store, or `null` if none is set. */
export function getDefaultStore(): AgentRunStore | null {
  return defaultStore;
}
