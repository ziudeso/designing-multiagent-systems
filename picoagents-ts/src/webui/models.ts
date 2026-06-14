export type EntityType = "agent" | "orchestrator" | "workflow";
export type EntitySource = "directory" | "memory" | "github";

export interface EntityInfo {
  id: string;
  name?: string;
  description?: string;
  type: EntityType;
  source: EntitySource | string;
  module_path?: string;
  tools: string[];
  has_env: boolean;
  example_tasks: string[];
}

export interface AgentInfo extends EntityInfo {
  type: "agent";
  model?: string;
  memory_type?: string;
}

export interface OrchestratorInfo extends EntityInfo {
  type: "orchestrator";
  orchestrator_type: string;
  agents: string[];
  termination_conditions: string[];
}

export interface WorkflowInfo extends EntityInfo {
  type: "workflow";
  steps: string[];
  input_schema?: Record<string, unknown>;
  start_step?: string;
}

export type Entity = AgentInfo | OrchestratorInfo | WorkflowInfo;

export interface WebUIStreamEvent {
  session_id: string;
  timestamp: string;
  event: unknown;
}

export interface HealthResponse {
  status: string;
  entities_dir?: string;
  entities_count: number;
}

export interface AddExampleRequest {
  example_id: string;
  github_path: string;
  category: "agent" | "workflow" | "orchestrator" | string;
}

export interface RunEntityRequest {
  messages?: unknown[];
  input_data?: unknown;
  session_id?: string;
  stream_tokens?: boolean;
  approval_responses?: unknown[];
}

export interface SessionInfo {
  id: string;
  entity_id: string;
  entity_type: EntityType | string;
  created_at: string;
  message_count: number;
  last_activity: string;
}
