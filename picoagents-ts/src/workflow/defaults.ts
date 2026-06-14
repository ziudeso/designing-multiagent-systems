/**
 * Default workflows for picoagents-ts.
 *
 * Ported from Python `defaults.py`. Provides example workflows and step
 * templates for demonstration / UI builder purposes. Each `create*` function
 * returns a serialized `ComponentModel` (via `dumpComponent`).
 *
 * Input/output model "shapes" from the Python pydantic models are expressed
 * here as plain TS interfaces plus accompanying JSON schemas attached to steps.
 */

import { ComponentModel, dumpComponent } from "../componentConfig.js";
import { Agent } from "../agents/index.js";
import { OpenAIChatCompletionClient } from "../llm/index.js";
import {
  EchoStep,
  HttpStep,
  PicoAgentStep,
  TransformStep,
  Workflow
} from "./index.js";
import type { JsonSchema } from "./schemaUtils.js";

// ============================================================================
// Input / Output model shapes (TS interfaces) and their JSON schemas
// ============================================================================

export interface MessageInput {
  message: string;
}

export interface MessageOutput {
  result: string;
}

export interface WebpageInput {
  url: string;
  message?: string;
}

export interface CollectedOutput {
  collected_results: string[];
  total_processed: number;
  processing_summary: string;
}

export interface ConditionalInput {
  message: string;
  priority?: string;
  enable_validation?: boolean;
}

const MESSAGE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"]
};

const MESSAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"]
};

const WEBPAGE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    url: { type: "string", default: "https://httpbin.org/html" },
    message: { type: "string", default: "Starting workflow execution" }
  },
  required: ["url"]
};

const COLLECTED_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    collected_results: { type: "array", items: { type: "string" } },
    total_processed: { type: "integer" },
    processing_summary: { type: "string" }
  },
  required: ["collected_results", "total_processed", "processing_summary"]
};

const CONDITIONAL_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    priority: { type: "string", default: "normal" },
    enable_validation: { type: "boolean", default: true }
  },
  required: ["message"]
};

const HTTP_REQUEST_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    method: { type: "string", default: "GET" },
    headers: { type: "object" },
    data: { type: "object" },
    timeout: { type: "integer", default: 30 }
  },
  required: ["url"]
};

const HTTP_RESPONSE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status_code: { type: "integer" },
    content: { type: "string" },
    headers: { type: "object" },
    url: { type: "string" },
    encoding: { type: "string" },
    elapsed_time: { type: "number" }
  },
  required: ["status_code", "content", "headers", "url", "elapsed_time"]
};

const PICO_AGENT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    task: { type: "string" },
    additional_context: { type: "object" }
  },
  required: ["task"]
};

// ============================================================================
// Echo chain workflow
// ============================================================================

function createEchoSteps(): EchoStep[] {
  const make = (
    stepId: string,
    name: string,
    description: string,
    tags: string[],
    prefix: string,
    suffix: string,
    delaySeconds: number,
    inputSchema: JsonSchema,
    outputSchema: JsonSchema
  ): EchoStep => {
    const step = new EchoStep({
      stepId,
      metadata: { name, description, tags },
      prefix,
      suffix,
      delaySeconds
    });
    step.inputSchema = inputSchema;
    step.outputSchema = outputSchema;
    return step;
  };

  return [
    make(
      "receive",
      "Receive Message",
      "Initial step to receive and broadcast a message to parallel processing streams",
      ["input", "broadcast"],
      "RECEIVED: ",
      " [BROADCASTING TO PARALLEL STREAMS]",
      2,
      MESSAGE_INPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "process_urgent",
      "Process Urgent",
      "Fast processing stream for urgent messages",
      ["processing", "urgent", "fast"],
      "URGENT: ",
      " [FAST-TRACKED]",
      3,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "process_standard",
      "Process Standard",
      "Standard processing stream for regular messages",
      ["processing", "standard", "medium"],
      "STANDARD: ",
      " [PROCESSED]",
      7,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "process_detailed",
      "Process Detailed",
      "Detailed processing stream for complex analysis",
      ["processing", "detailed", "slow"],
      "DETAILED: ",
      " [DEEP-ANALYZED]",
      12,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "validate_urgent",
      "Validate Urgent",
      "Quick validation for urgent processing results",
      ["validation", "urgent"],
      "URGENT-VALIDATED: ",
      " [APPROVED-FAST]",
      1,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "validate_standard",
      "Validate Standard",
      "Standard validation for regular processing results",
      ["validation", "standard"],
      "STANDARD-VALIDATED: ",
      " [APPROVED-NORMAL]",
      4,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    make(
      "validate_detailed",
      "Validate Detailed",
      "Thorough validation for detailed processing results",
      ["validation", "detailed"],
      "DETAILED-VALIDATED: ",
      " [APPROVED-THOROUGH]",
      6,
      MESSAGE_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    ),
    (() => {
      const collect = new TransformStep({
        stepId: "collect",
        metadata: {
          name: "Collect Results",
          description: "Collect and aggregate results from all parallel processing streams",
          tags: ["collection", "aggregation", "fan-in"]
        },
        mappings: {
          collected_results: ["static:Results from all parallel processing streams"],
          total_processed: 3,
          processing_summary: "result"
        },
        inputSchema: MESSAGE_OUTPUT_SCHEMA,
        outputSchema: COLLECTED_OUTPUT_SCHEMA
      });
      // TransformStep is not an EchoStep; cast handled by caller composition.
      return collect as unknown as EchoStep;
    })(),
    make(
      "send",
      "Send Final Results",
      "Send aggregated results from all processing streams",
      ["output", "final"],
      "FINAL RESULTS: ",
      " [DELIVERED TO ALL STAKEHOLDERS]",
      3,
      COLLECTED_OUTPUT_SCHEMA,
      MESSAGE_OUTPUT_SCHEMA
    )
  ];
}

export function createEchoChainWorkflow(): ComponentModel {
  const workflow = new Workflow({
    metadata: {
      name: "Complex Echo Processing Workflow",
      description:
        "Parallel message processing with urgent/standard/detailed streams, validation, and result aggregation",
      version: "2.0.0",
      tags: ["demo", "echo", "parallel", "fan-out", "fan-in", "validation"]
    }
  });

  for (const step of createEchoSteps()) {
    workflow.addStep(step);
  }

  workflow.setStartStep("receive");
  workflow.addEdge("receive", "process_urgent");
  workflow.addEdge("receive", "process_standard");
  workflow.addEdge("receive", "process_detailed");
  workflow.addEdge("process_urgent", "validate_urgent");
  workflow.addEdge("process_standard", "validate_standard");
  workflow.addEdge("process_detailed", "validate_detailed");
  workflow.addEdge("validate_urgent", "collect");
  workflow.addEdge("validate_standard", "collect");
  workflow.addEdge("validate_detailed", "collect");
  workflow.addEdge("collect", "send");
  workflow.addEndStep("send");

  return dumpComponent(workflow);
}

// ============================================================================
// Step templates
// ============================================================================

function createEchoTemplate(): EchoStep {
  const step = new EchoStep({
    stepId: "echo_step",
    metadata: {
      name: "Echo Step",
      description: "Processes text by adding prefix and suffix - customize for your needs",
      tags: ["echo", "text", "basic"]
    },
    prefix: "Processed: ",
    suffix: " (done)",
    delaySeconds: 1
  });
  step.inputSchema = MESSAGE_INPUT_SCHEMA;
  step.outputSchema = MESSAGE_OUTPUT_SCHEMA;
  return step;
}

function createHttpTemplate(): HttpStep {
  const step = new HttpStep({
    stepId: "http_step",
    metadata: {
      name: "HTTP Step",
      description: "Makes HTTP requests to external APIs - customize URL and method",
      tags: ["http", "api", "external"]
    }
  });
  step.inputSchema = HTTP_REQUEST_INPUT_SCHEMA;
  step.outputSchema = HTTP_RESPONSE_OUTPUT_SCHEMA;
  return step;
}

function createTransformTemplate(): TransformStep {
  return new TransformStep({
    stepId: "transform_step",
    metadata: {
      name: "Transform Step",
      description: "Transforms data from one format to another - customize field mappings",
      tags: ["transform", "mapping", "data"]
    },
    mappings: { result: "message" },
    inputSchema: MESSAGE_INPUT_SCHEMA,
    outputSchema: MESSAGE_OUTPUT_SCHEMA
  });
}

function createAgentTemplate(): PicoAgentStep {
  const modelClient = new OpenAIChatCompletionClient({ model: "gpt-4.1-mini" });
  const agent = new Agent({
    name: "picoagent",
    instructions:
      "You are a helpful AI assistant. Customize this instruction for your specific use case.",
    modelClient
  });
  const step = new PicoAgentStep({
    stepId: "picoagent_step",
    metadata: {
      name: "PicoAgent Step",
      description: "AI-powered agent using picoagents - customize the instructions and model",
      tags: ["picoagents", "agent", "ai"]
    },
    agent
  });
  step.inputSchema = PICO_AGENT_INPUT_SCHEMA;
  return step;
}

export function getDefaultSteps(): ComponentModel[] {
  // Step templates are returned as lightweight descriptors. Concrete TS steps
  // are not all registered serializable components, so we emit a minimal
  // ComponentModel describing each template.
  const describe = (step: { stepId: string; constructor: { name: string }; metadata: unknown; inputSchema?: unknown; outputSchema?: unknown }): ComponentModel => ({
    provider: `picoagents.workflow.${step.constructor.name}`,
    componentType: "step",
    version: 1,
    componentVersion: 1,
    label: step.constructor.name,
    config: {
      stepId: step.stepId,
      metadata: step.metadata,
      inputSchema: step.inputSchema,
      outputSchema: step.outputSchema
    }
  });

  return [
    describe(createEchoTemplate()),
    describe(createHttpTemplate()),
    describe(createTransformTemplate()),
    describe(createAgentTemplate())
  ];
}

// ============================================================================
// Simple agent (webpage summarization) workflow
// ============================================================================

export function createSimpleAgentWorkflow(): ComponentModel {
  const workflow = new Workflow({
    metadata: {
      name: "Webpage Summarization",
      description: "Fetch a webpage and summarize its content using AI",
      tags: ["web", "summarization", "ai"]
    }
  });

  const inputTransform = new TransformStep({
    stepId: "input_transform",
    metadata: {
      name: "Input Transform",
      description: "Transform UI input to HTTP request",
      tags: ["transform", "input"]
    },
    mappings: {
      url: "url",
      method: "static:GET",
      timeout: 30,
      headers: {},
      data: {}
    },
    inputSchema: WEBPAGE_INPUT_SCHEMA,
    outputSchema: HTTP_REQUEST_INPUT_SCHEMA
  });

  const httpStep = new HttpStep({
    stepId: "http_fetch",
    metadata: { name: "HTTP Fetch", description: "Fetch webpage content", tags: ["http", "fetch"] }
  });
  httpStep.inputSchema = HTTP_REQUEST_INPUT_SCHEMA;
  httpStep.outputSchema = HTTP_RESPONSE_OUTPUT_SCHEMA;

  const transformToAgent = new TransformStep({
    stepId: "transform_to_agent_input",
    metadata: {
      name: "Transform to Agent Input",
      description: "Transform HTTP response to Agent input",
      tags: ["transform"]
    },
    mappings: {
      task: "static:Please summarize the following HTML content in 2-3 sentences, focusing on the main topic and key information: {content}"
    },
    inputSchema: HTTP_RESPONSE_OUTPUT_SCHEMA,
    outputSchema: PICO_AGENT_INPUT_SCHEMA
  });

  const modelClient = new OpenAIChatCompletionClient({ model: "gpt-4.1-mini" });
  const agent = new Agent({
    name: "web_summarizer",
    instructions:
      "You are a helpful assistant that summarizes web content. Provide concise, informative summaries.",
    modelClient
  });
  const agentStep = new PicoAgentStep({
    stepId: "agent_summarize",
    metadata: {
      name: "PicoAgent Summarize",
      description: "Summarize content using picoagents AI agent",
      tags: ["ai", "summarize", "picoagents"]
    },
    agent
  });
  agentStep.inputSchema = PICO_AGENT_INPUT_SCHEMA;

  workflow.addStep(inputTransform);
  workflow.addStep(httpStep);
  workflow.addStep(transformToAgent);
  workflow.addStep(agentStep);
  workflow.addEdge("input_transform", "http_fetch");
  workflow.addEdge("http_fetch", "transform_to_agent_input");
  workflow.addEdge("transform_to_agent_input", "agent_summarize");
  workflow.setStartStep("input_transform");
  workflow.addEndStep("agent_summarize");

  return dumpComponent(workflow);
}

// ============================================================================
// Conditional workflow
// ============================================================================

export function createConditionalWorkflow(): ComponentModel {
  const workflow = new Workflow({
    metadata: {
      name: "Conditional Processing Workflow",
      description:
        "Demonstrates conditional routing based on message priority and validation settings",
      version: "1.0.0",
      tags: ["demo", "conditional", "routing"]
    }
  });

  const echo = (
    stepId: string,
    name: string,
    description: string,
    tags: string[],
    prefix: string,
    suffix: string,
    delaySeconds: number,
    inputSchema: JsonSchema
  ): EchoStep => {
    const step = new EchoStep({
      stepId,
      metadata: { name, description, tags },
      prefix,
      suffix,
      delaySeconds
    });
    step.inputSchema = inputSchema;
    step.outputSchema = MESSAGE_OUTPUT_SCHEMA;
    return step;
  };

  workflow.addStep(
    echo(
      "receive_conditional",
      "Receive Conditional",
      "Receive message and prepare for conditional routing",
      ["input"],
      "CONDITIONAL INPUT: ",
      " [ROUTING BASED ON CONDITIONS]",
      1,
      CONDITIONAL_INPUT_SCHEMA
    )
  );
  workflow.addStep(
    echo("urgent_process", "Urgent Process", "Fast processing for urgent messages", ["processing", "urgent"], "URGENT FAST-TRACK: ", " [EXPEDITED]", 2, MESSAGE_OUTPUT_SCHEMA)
  );
  workflow.addStep(
    echo("normal_process", "Normal Process", "Standard processing for normal messages", ["processing", "normal"], "NORMAL PROCESSING: ", " [STANDARD]", 5, MESSAGE_OUTPUT_SCHEMA)
  );
  workflow.addStep(
    echo("low_process", "Low Priority Process", "Slow processing for low priority messages", ["processing", "low"], "LOW PRIORITY: ", " [BATCH-PROCESSED]", 8, MESSAGE_OUTPUT_SCHEMA)
  );
  workflow.addStep(
    echo("validation", "Validation", "Optional validation step", ["validation"], "VALIDATED: ", " [APPROVED]", 3, MESSAGE_OUTPUT_SCHEMA)
  );
  workflow.addStep(
    echo("deliver", "Deliver", "Final delivery step", ["output"], "DELIVERED: ", " [COMPLETE]", 1, MESSAGE_OUTPUT_SCHEMA)
  );

  workflow.setStartStep("receive_conditional");

  workflow.addEdge("receive_conditional", "urgent_process", {
    type: "state_based",
    field: "priority",
    operator: "==",
    value: "urgent"
  });
  workflow.addEdge("receive_conditional", "normal_process", {
    type: "state_based",
    field: "priority",
    operator: "==",
    value: "normal"
  });
  workflow.addEdge("receive_conditional", "low_process", {
    type: "state_based",
    field: "priority",
    operator: "==",
    value: "low"
  });

  const validationEnabled = {
    type: "state_based" as const,
    field: "enable_validation",
    operator: "==" as const,
    value: true
  };
  workflow.addEdge("urgent_process", "validation", validationEnabled);
  workflow.addEdge("normal_process", "validation", validationEnabled);
  workflow.addEdge("low_process", "validation", validationEnabled);

  const validationDisabled = {
    type: "state_based" as const,
    field: "enable_validation",
    operator: "==" as const,
    value: false
  };
  workflow.addEdge("urgent_process", "deliver", validationDisabled);
  workflow.addEdge("normal_process", "deliver", validationDisabled);
  workflow.addEdge("low_process", "deliver", validationDisabled);

  workflow.addEdge("validation", "deliver");
  workflow.addEndStep("deliver");

  return dumpComponent(workflow);
}

export function getDefaultWorkflows(): ComponentModel[] {
  return [createEchoChainWorkflow(), createSimpleAgentWorkflow(), createConditionalWorkflow()];
}
