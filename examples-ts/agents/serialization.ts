import {
  Agent,
  CalculatorTool,
  OpenAIChatCompletionClient,
  dumpComponent,
  loadComponent
} from "picoagents-ts";
import { section } from "../shared/printing.js";

export function createSerializableAgent(): Agent {
  return new Agent({
    name: "serializable_assistant",
    description: "Agent with serializable model and tool components.",
    instructions: "Use the calculator tool when arithmetic is required.",
    modelClient: new OpenAIChatCompletionClient({ model: "gpt-4.1-mini" }),
    tools: [new CalculatorTool()],
    exampleTasks: ["What is 125 * 48?"]
  });
}

export async function main(): Promise<void> {
  section("Agent Serialization Example");

  const agent = createSerializableAgent();
  const dumped = dumpComponent(agent);
  console.log(`Provider: ${dumped.provider}`);
  console.log(`Component type: ${dumped.componentType}`);
  console.log(`Serialized tools: ${Array.isArray(dumped.config.tools) ? dumped.config.tools.length : 0}`);

  const restored = loadComponent<Agent>(dumped);
  console.log(`Restored agent: ${restored.name}`);
  console.log(`Restored tools: ${restored.tools.map((item) => item.name).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
