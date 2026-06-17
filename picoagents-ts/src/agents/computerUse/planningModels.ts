import { ActionType } from "./interfaceClients.js";
import type { JSONSchema } from "../../tools/index.js";

export enum InterfaceRepresentation {
  TEXT = "text",
  HTML = "html",
  VISUAL = "visual",
  HYBRID = "hybrid"
}

export enum PlanningStrategy {
  IMPLICIT = "implicit",
  EXPLICIT = "explicit",
  AUTO = "auto"
}

export interface PageObservation {
  url: string;
  title: string;
  summary: string;
  keyElements: string[];
  taskRelevance: string;
  isTaskComplete: boolean;
  confidence: number;
}

export interface NextActionPlan {
  actionType: ActionType;
  selector?: string;
  value?: string;
  coordinates?: Record<string, number>;
  reasoning: string;
  expectedOutcome: string;
  confidence: number;
}

export interface MultiStepPlan {
  steps: NextActionPlan[];
  overallStrategy: string;
  estimatedComplexity: "simple" | "moderate" | "complex";
  requiresExploration: boolean;
}

export interface PlanningDecision {
  chosenStrategy: PlanningStrategy;
  reasoning: string;
  taskComplexity: "simple" | "moderate" | "complex";
}

export interface TaskCompletion {
  isComplete: boolean;
  completionConfidence: number;
  summary: string;
  remainingWork?: string;
}

export interface DOMFilter {
  maxTextLength: number;
  includeHidden: boolean;
  interactiveOnly: boolean;
  excludeTags: string[];
}

export interface InterfaceConfig {
  representation: InterfaceRepresentation;
  domFilter: DOMFilter;
  includeScreenshot: boolean;
  screenshotDescription: boolean;
}

export const defaultDomFilter: DOMFilter = {
  maxTextLength: 2000,
  includeHidden: false,
  interactiveOnly: false,
  excludeTags: ["script", "style", "meta", "link"]
};

export const defaultInterfaceConfig: InterfaceConfig = {
  representation: InterfaceRepresentation.HYBRID,
  domFilter: defaultDomFilter,
  includeScreenshot: true,
  screenshotDescription: true
};

export const pageObservationSchema: JSONSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Current page URL" },
    title: { type: "string", description: "Page title" },
    summary: { type: "string", description: "Brief summary of what's visible on the page" },
    keyElements: {
      type: "array",
      items: { type: "string" },
      description: "Important interactive elements or content"
    },
    taskRelevance: {
      type: "string",
      description: "How this page relates to the current task"
    },
    isTaskComplete: {
      type: "boolean",
      description: "Whether the task appears to be complete"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence in this observation (0-1)"
    }
  },
  required: ["url", "title", "summary", "keyElements", "taskRelevance", "isTaskComplete", "confidence"]
};

export const nextActionPlanSchema: JSONSchema = {
  type: "object",
  properties: {
    actionType: {
      type: "string",
      enum: Object.values(ActionType),
      description: "Type of action to perform"
    },
    selector: {
      type: "string",
      description: "CSS selector for the target element"
    },
    value: {
      type: "string",
      description: "Value to input or URL for navigation"
    },
    coordinates: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" }
      },
      description: "Coordinates for click if selector fails"
    },
    reasoning: {
      type: "string",
      description: "Why this action is being taken"
    },
    expectedOutcome: {
      type: "string",
      description: "What should happen after this action"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence in this action plan (0-1)"
    }
  },
  required: ["actionType", "reasoning", "expectedOutcome", "confidence"]
};

export const multiStepPlanSchema: JSONSchema = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: nextActionPlanSchema,
      description: "Sequence of actions to take"
    },
    overallStrategy: {
      type: "string",
      description: "High-level strategy for completing the task"
    },
    estimatedComplexity: {
      type: "string",
      enum: ["simple", "moderate", "complex"],
      description: "Estimated complexity of the task"
    },
    requiresExploration: {
      type: "boolean",
      description: "Whether this task requires exploration/discovery"
    }
  },
  required: ["steps", "overallStrategy", "estimatedComplexity", "requiresExploration"]
};
