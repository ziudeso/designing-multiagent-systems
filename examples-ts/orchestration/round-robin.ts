import {
  Agent,
  BaseEvent,
  MaxMessageTermination,
  RoundRobinOrchestrator,
  TextMentionTermination
} from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export function getOrchestrator(): RoundRobinOrchestrator {
  const poet = new Agent({
    name: "poet",
    description: "Haiku poet.",
    instructions: "Write short haiku.",
    modelClient: createExampleModelClient(
      ["Cherry light drifts down\nsoft branches remember rain\nspring opens the gate"],
      { fallbackResponse: "Fresh petals fall light\nmorning gathers quiet rain\nspring returns again" }
    )
  });

  const critic = new Agent({
    name: "critic",
    description: "Poetry critic who provides concise, constructive feedback.",
    instructions:
      "Review haiku for imagery, syllable count, seasonal words, and emotional impact. Respond APPROVED when satisfied.",
    modelClient: createExampleModelClient(["APPROVED: vivid seasonal imagery and a clear spring mood."])
  });

  return new RoundRobinOrchestrator({
    name: "poet_critic_team",
    description: "Poet and critic collaborate in turns.",
    agents: [poet, critic],
    termination: new MaxMessageTermination(8).or(new TextMentionTermination("APPROVED")),
    maxIterations: 4,
    exampleTasks: ["Write a haiku about cherry blossoms in spring."]
  });
}

export const orchestrator = getOrchestrator();

export async function main(): Promise<void> {
  section("Round-Robin Orchestration Example");
  const task = "Write a haiku about cherry blossoms in spring.";
  for await (const item of orchestrator.runStream(task, { verbose: true })) {
    if ("stopMessage" in item) {
      console.log(`Final result: ${item.finalResult}`);
      console.log(`Stop reason: ${item.stopMessage.content}`);
    } else if (item instanceof BaseEvent) {
      console.log(`[event:${item.eventType}] ${item.source}`);
    } else {
      console.log(item.toString());
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
