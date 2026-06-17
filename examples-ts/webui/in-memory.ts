import {
  Agent,
  ApprovalMode,
  AssistantMessage,
  MaxMessageTermination,
  RoundRobinOrchestrator,
  serve,
  tool
} from "picoagents-ts";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";

const getWeather = tool(
  ({ location }) => `The weather in ${String(location)} is sunny and 72F.`,
  {
    name: "get_weather",
    description: "Get current weather for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"]
    }
  }
);

const calculate = tool(
  ({ expression }) => {
    const expr = String(expression);
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) return `Unsupported expression: ${expr}`;
    return `The result is ${String(Function(`"use strict"; return (${expr});`)())}`;
  },
  {
    name: "calculate",
    description: "Perform basic arithmetic calculations.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"]
    }
  }
);

const sendEmail = tool(
  ({ to, subject }) => `Email sent to ${String(to)} with subject '${String(subject)}'.`,
  {
    name: "send_email",
    description: "Send an email. Requires approval.",
    approvalMode: ApprovalMode.ALWAYS,
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" }
      },
      required: ["to", "subject", "body"]
    }
  }
);

export const weatherAgent = new Agent({
  name: "weather_assistant",
  description: "Provides weather information for locations.",
  instructions: "Use the weather tool to provide weather information.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [toolCall("get_weather", { location: "Seattle" }, "call_weather")]
    }),
    "Seattle is sunny and 72F."
  ], { fallbackResponse: "Ask me for weather in a city." }),
  tools: [getWeather]
});

export const mathAgent = new Agent({
  name: "math_assistant",
  description: "Helps with arithmetic calculations.",
  instructions: "Use the calculator tool to solve math problems.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [toolCall("calculate", { expression: "15 * 3" }, "call_calc")]
    }),
    "15 * 3 is 45."
  ], { fallbackResponse: "Ask me for an arithmetic calculation." }),
  tools: [calculate]
});

export const generalAgent = new Agent({
  name: "general_assistant",
  description: "General assistant with weather and math tools.",
  instructions: "Use the available tools when helpful.",
  modelClient: createExampleModelClient(["I can help with weather and arithmetic."]),
  tools: [getWeather, calculate]
});

export const approvalAgent = new Agent({
  name: "approval_demo",
  description: "Demo agent with approval-required email tool.",
  instructions: "Use send_email for email tasks. The host application handles approval.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [
        toolCall("send_email", {
          to: "demo@example.com",
          subject: "PicoAgents TS",
          body: "Hello from the WebUI approval demo."
        }, "call_email")
      ]
    }),
    "The email action was processed according to approval policy."
  ]),
  tools: [sendEmail]
});

export const assistantTeam = new RoundRobinOrchestrator({
  name: "assistant_team",
  description: "Weather and math assistants take turns.",
  agents: [weatherAgent, mathAgent],
  termination: new MaxMessageTermination(4),
  maxIterations: 4
});

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8070);
  console.log(`Starting picoagents-ts WebUI on http://127.0.0.1:${port}`);
  await serve({
    entities: [weatherAgent, mathAgent, generalAgent, assistantTeam, approvalAgent],
    port,
    autoOpen: true
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
