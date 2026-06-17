import {
  Agent,
  AgentResponse,
  AssistantMessage,
  ToolMessage,
  tool
} from "picoagents-ts";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { printAgentItem, section } from "../shared/printing.js";

const getWeather = tool(
  ({ location }) => `The weather in ${String(location)} is sunny, 75F.`,
  {
    name: "get_weather",
    description: "Get current weather for a given location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or location name." }
      },
      required: ["location"]
    }
  }
);

const calculate = tool(
  ({ expression }) => {
    const expr = String(expression);
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) {
      return `Unsupported expression: ${expr}`;
    }
    const result = Function(`"use strict"; return (${expr});`)() as unknown;
    return `The result of ${expr} is ${String(result)}.`;
  },
  {
    name: "calculate",
    description: "Evaluate a basic arithmetic expression.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Arithmetic expression." }
      },
      required: ["expression"]
    }
  }
);

export const agent = new Agent({
  name: "basic_assistant",
  description: "A helpful assistant with weather and calculator tools.",
  instructions:
    "You are a helpful assistant with access to weather and calculation tools. Use them when appropriate.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [
        toolCall("get_weather", { location: "New York" }, "call_weather"),
        toolCall("calculate", { expression: "12 * 15" }, "call_calc")
      ]
    }),
    "The weather in New York is sunny, 75F. 12 * 15 is 180."
  ]),
  tools: [getWeather, calculate],
  exampleTasks: [
    "What's the weather in San Francisco?",
    "Calculate 125 * 48",
    "What's the weather in Tokyo and what's 15% of 240?"
  ]
});

export async function main(): Promise<void> {
  section("Basic Agent Example");
  console.log(`Agent: ${agent.name}`);
  console.log(`Tools: ${agent.tools.map((item) => item.name).join(", ")}\n`);

  for await (const item of agent.runStream(
    "What's the weather in New York and what is 12 * 15?",
    { streamTokens: false, verbose: true }
  )) {
    if (item instanceof AgentResponse) {
      console.log(`\nFinal: ${item.finalContent}`);
    } else if (item instanceof ToolMessage) {
      console.log(`Tool ${item.toolName}: ${item.content}`);
    } else {
      printAgentItem(item);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
