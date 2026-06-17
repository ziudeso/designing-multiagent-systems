import {
  AIOrchestrator,
  Agent,
  MaxMessageTermination,
  TextMentionTermination
} from "picoagents-ts";
import { createExampleModelClient } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

export function getOrchestrator(): AIOrchestrator {
  const writer = new Agent({
    name: "writer",
    description: "Creative writer who drafts concise content.",
    instructions: "Write clear, structured prose in four lines or fewer.",
    modelClient: createExampleModelClient([
      "Remote work can improve productivity by reducing commute time, supporting deep-focus blocks, and widening access to quiet work environments."
    ])
  });

  const editor = new Agent({
    name: "editor",
    description: "Editor who reviews clarity and flow.",
    instructions: "Review content and respond APPROVED when it is clear enough.",
    modelClient: createExampleModelClient([
      "APPROVED: clear claim, concrete benefits, and concise wording."
    ])
  });

  const selector = createExampleModelClient([
    {
      content: "writer",
      structuredOutput: {
        selected_agent: "writer",
        reasoning: "The task needs an initial draft.",
        confidence: 0.92
      }
    },
    {
      content: "editor",
      structuredOutput: {
        selected_agent: "editor",
        reasoning: "The draft should be reviewed for clarity.",
        confidence: 0.88
      }
    }
  ]);

  return new AIOrchestrator({
    name: "ai_writer_editor",
    description: "AI-selected writer/editor collaboration.",
    agents: [writer, editor],
    termination: new MaxMessageTermination(10).or(new TextMentionTermination("APPROVED")),
    modelClient: selector,
    maxIterations: 10
  });
}

export const orchestrator = getOrchestrator();

export async function main(): Promise<void> {
  section("AI-Driven Orchestration Example");
  const result = await orchestrator.run(
    "Write a note about the benefits of remote work for productivity."
  );

  console.log(`Final output: ${result.finalResult}`);
  console.log(`Stop reason: ${result.stopMessage.content}`);
  console.log(`Metadata: ${JSON.stringify(result.patternMetadata, null, 2)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
