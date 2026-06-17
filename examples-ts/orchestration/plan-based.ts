import {
  Agent,
  MaxMessageTermination,
  PlanBasedOrchestrator,
  TextMentionTermination
} from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export function getOrchestrator(): PlanBasedOrchestrator {
  const researcher = new Agent({
    name: "researcher",
    description: "Research specialist who gathers concise facts.",
    instructions: "Return two or three key points.",
    modelClient: createExampleModelClient([
      "Key points: renewable energy lowers operational emissions, improves energy independence, and can reduce long-term price volatility."
    ])
  });

  const writer = new Agent({
    name: "writer",
    description: "Technical writer who creates clear summaries.",
    instructions: "Transform research into concise, structured content.",
    modelClient: createExampleModelClient([
      "Renewable energy benefits include lower emissions, stronger energy resilience, and more predictable long-term costs."
    ])
  });

  const reviewer = new Agent({
    name: "reviewer",
    description: "Quality reviewer for accuracy and completeness.",
    instructions: "Respond APPROVED if the content meets standards.",
    modelClient: createExampleModelClient([
      "APPROVED: accurate, concise, and complete for a short guide."
    ])
  });

  const planner = createExampleModelClient([
    {
      content: "plan",
      structuredOutput: {
        steps: [
          {
            task: "Gather three concise benefits of renewable energy.",
            agentName: "researcher",
            reasoning: "The researcher should collect the factual base."
          },
          {
            task: "Write a short guide from the research notes.",
            agentName: "writer",
            reasoning: "The writer turns notes into prose."
          },
          {
            task: "Review the guide for accuracy and completeness.",
            agentName: "reviewer",
            reasoning: "The reviewer checks quality."
          }
        ]
      }
    },
    {
      content: "complete",
      structuredOutput: {
        stepCompleted: true,
        failureReason: "None",
        confidenceScore: 0.9,
        suggestedImprovements: []
      }
    },
    {
      content: "complete",
      structuredOutput: {
        stepCompleted: true,
        failureReason: "None",
        confidenceScore: 0.88,
        suggestedImprovements: []
      }
    },
    {
      content: "complete",
      structuredOutput: {
        stepCompleted: true,
        failureReason: "None",
        confidenceScore: 0.95,
        suggestedImprovements: []
      }
    }
  ]);

  return new PlanBasedOrchestrator({
    name: "renewable_energy_plan",
    description: "Plan-based research, writing, and review workflow.",
    agents: [researcher, writer, reviewer],
    termination: new MaxMessageTermination(15).or(new TextMentionTermination("APPROVED")),
    modelClient: planner,
    maxIterations: 15,
    maxStepRetries: 2
  });
}

export const orchestrator = getOrchestrator();

export async function main(): Promise<void> {
  section("Plan-Based Orchestration Example");
  const result = await orchestrator.run(
    "Research and write a short guide about the benefits of renewable energy sources."
  );

  console.log(`Final output: ${result.finalResult}`);
  console.log(`Stop reason: ${result.stopMessage.content}`);
  console.log(`Metadata: ${JSON.stringify(result.patternMetadata, null, 2)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
