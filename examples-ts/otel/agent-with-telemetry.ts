process.env.PICOAGENTS_ENABLE_OTEL ??= "true";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://localhost:4318";
process.env.OTEL_SERVICE_NAME ??= "picoagents-ts-example";
process.env.PICOAGENTS_OTEL_CAPTURE_CONTENT ??= "true";

import {
  Agent,
  AssistantMessage,
  tool
} from "picoagents-ts";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

const getWeather = tool(
  ({ location }) => `The weather in ${String(location)} is sunny and 72F.`,
  {
    name: "get_weather",
    description: "Get weather for a location.",
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
    return `Result: ${String(Function(`"use strict"; return (${expr});`)())}`;
  },
  {
    name: "calculate",
    description: "Evaluate arithmetic.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"]
    }
  }
);

export const agent = new Agent({
  name: "weather_assistant",
  description: "Assistant with telemetry-enabled model and tool calls.",
  instructions: "Use tools to answer weather and arithmetic questions.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [
        toolCall("get_weather", { location: "San Francisco" }, "call_weather"),
        toolCall("calculate", { expression: "42 * 137" }, "call_calc")
      ]
    }),
    "San Francisco is sunny and 72F. 42 * 137 is 5754."
  ]),
  tools: [getWeather, calculate]
});

export async function main(): Promise<void> {
  section("OpenTelemetry Agent Example");
  const response = await agent.run(
    "What's the weather in San Francisco and what is 42 * 137?"
  );
  console.log(response.finalContent);
  console.log("If an OpenTelemetry SDK/exporter is installed and configured, spans are emitted automatically.");
  console.log(`OTLP endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
