import {
  Agent,
  AssistantMessage,
  tool
} from "picoagents-ts";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { printAgentItem, section } from "../shared/printing.js";

const getWeather = tool(
  ({ location }) => `The weather in ${String(location)} is sunny, 100F.`,
  {
    name: "get_weather",
    description: "Get weather information for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"]
    }
  }
);

const analyzeData = tool(
  ({ data }) => `Analysis of '${String(data)}': positive trend with seasonal variation.`,
  {
    name: "analyze_data",
    description: "Analyze a small data summary.",
    parameters: {
      type: "object",
      properties: { data: { type: "string" } },
      required: ["data"]
    }
  }
);

export const weatherAgent = new Agent({
  name: "weather_specialist",
  description: "Specialized agent for weather information.",
  instructions: "Use the weather tool and be concise.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [toolCall("get_weather", { location: "San Francisco" }, "weather_tool")]
    }),
    "San Francisco is sunny and 100F."
  ]),
  tools: [getWeather]
});

export const analysisAgent = new Agent({
  name: "data_analyst",
  description: "Specialized agent for data analysis.",
  instructions: "Analyze provided data and be concise.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [toolCall("analyze_data", { data: "outdoor event attendance" }, "analysis_tool")]
    }),
    "Outdoor event attendance shows a positive trend with weather-sensitive variation."
  ]),
  tools: [analyzeData]
});

export const agent = new Agent({
  name: "research_coordinator",
  description: "Coordinates tasks using specialist agents.",
  instructions: "Delegate to the relevant specialist agents and produce a short report.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [
        toolCall("weather_specialist", { task: "Current weather in San Francisco" }, "call_weather_agent"),
        toolCall("data_analyst", { task: "Analyze outdoor event attendance" }, "call_analysis_agent")
      ]
    }),
    "Brief report: San Francisco is sunny and hot, so outdoor event attendance is likely favorable with hydration planning."
  ]),
  tools: [
    weatherAgent.asTool(),
    analysisAgent.asTool({ resultStrategy: "last:2" })
  ],
  exampleTasks: [
    "Provide a brief report on the weather in San Francisco and its impact on outdoor events."
  ]
});

export async function main(): Promise<void> {
  section("Agent As Tool Composition Example");

  for await (const item of agent.runStream(
    "Write a very brief health report on the current weather in San Francisco.",
    { verbose: true }
  )) {
    printAgentItem(item);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
