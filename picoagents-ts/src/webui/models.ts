export type EntityType = "agent" | "orchestrator" | "workflow";
export type EntitySource = "directory" | "memory" | "github";

export interface EntityInfo {
  id: string;
  name?: string;
  description?: string;
  type: EntityType;
  source: EntitySource | string;
  modulePath?: string;
  tools: string[];
  hasEnv: boolean;
  exampleTasks: string[];
}

export interface AgentInfo extends EntityInfo {
  type: "agent";
  model?: string;
  memoryType?: string;
}

export interface OrchestratorInfo extends EntityInfo {
  type: "orchestrator";
  orchestratorType: string;
  agents: string[];
  terminationConditions: string[];
}

export interface WorkflowInfo extends EntityInfo {
  type: "workflow";
  steps: string[];
  inputSchema?: Record<string, unknown>;
  startStep?: string;
}

export type Entity = AgentInfo | OrchestratorInfo | WorkflowInfo;

export interface WebUIStreamEvent {
  sessionId: string;
  timestamp: string;
  event: unknown;
}

export interface HealthResponse {
  status: string;
  entitiesDir?: string;
  entitiesCount: number;
}

export interface AddExampleRequest {
  exampleId: string;
  githubPath: string;
  category: "agent" | "workflow" | "orchestrator" | string;
}

export interface RunEntityRequest {
  messages?: unknown[];
  inputData?: unknown;
  sessionId?: string;
  streamTokens?: boolean;
  approvalResponses?: unknown[];
}

export interface SessionInfo {
  id: string;
  entityId: string;
  entityType: EntityType | string;
  createdAt: string;
  messageCount: number;
  lastActivity: string;
}
