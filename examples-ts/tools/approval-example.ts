import {
  Agent,
  ApprovalMode,
  AssistantMessage,
  tool
} from "picoagents-ts";
import { createExampleModelClient, toolCall } from "../shared/modelClient.js";
import { section } from "../shared/printing.js";

const getWeather = tool(
  ({ city }) => `Weather in ${String(city)}: sunny, 72F with light winds.`,
  {
    name: "get_weather",
    description: "Get weather information for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"]
    }
  }
);

const deleteFile = tool(
  ({ filepath }) => `[SIMULATED] Deleted ${String(filepath)}.`,
  {
    name: "delete_file",
    description: "Delete a file from the filesystem.",
    approvalMode: ApprovalMode.ALWAYS,
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"]
    }
  }
);

const sendEmail = tool(
  ({ to, subject }) => `[SIMULATED] Sent email to ${String(to)} with subject '${String(subject)}'.`,
  {
    name: "send_email",
    description: "Send an email to a recipient.",
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

export const agent = new Agent({
  name: "approval_assistant",
  description: "Assistant that demonstrates tool approval.",
  instructions:
    "Use tools directly. File deletion and email tools require approval from the host application.",
  modelClient: createExampleModelClient([
    new AssistantMessage({
      content: "",
      source: "llm",
      toolCalls: [
        toolCall("get_weather", { city: "New York" }, "call_weather"),
        toolCall("send_email", {
          to: "john@example.com",
          subject: "Weather report",
          body: "Sunny and 72F."
        }, "call_email")
      ]
    }),
    "The weather was checked and the email action was handled according to approval policy."
  ]),
  tools: [getWeather, deleteFile, sendEmail],
  maxIterations: 5
});

export async function main(): Promise<void> {
  section("Tool Approval Example");

  let response = await agent.run(
    "Check the weather in New York and email john@example.com with the report."
  );

  while (response.needsApproval) {
    for (const request of response.approvalRequests) {
      const approved =
        request.toolName === "send_email" &&
        String(request.parameters.to ?? "").endsWith("@example.com");
      console.log(
        `${approved ? "Approved" : "Rejected"} ${request.toolName}: ${JSON.stringify(request.parameters)}`
      );
      response.context?.addApprovalResponse(
        request.createResponse(approved, approved ? "Allowed demo recipient." : "Policy rejected.")
      );
    }

    response = await agent.run(undefined, { context: response.context });
  }

  console.log(`Final status: ${response.finishReason}`);
  console.log(response.finalContent);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
