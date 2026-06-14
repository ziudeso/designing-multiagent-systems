import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Agent,
  ApprovalMode,
  AssistantMessage,
  ToolApprovalEvent,
  ToolCallRequest,
  ToolMessage,
  ToolResult
} from "../dist/index.js";
import { EchoTool, collectAsync, createMockClient } from "./helpers.mjs";

test("Tool approval pauses execution and resumes after approval", async () => {
  const client = createMockClient({
    responses: [
      new AssistantMessage({
        content: "",
        source: "llm",
        toolCalls: [
          new ToolCallRequest({
            toolName: "echo",
            parameters: { value: "approved" },
            callId: "call_1"
          })
        ]
      }),
      "final"
    ]
  });
  const agent = new Agent({
    name: "agent",
    instructions: "Use tools.",
    modelClient: client,
    tools: [new EchoTool({ approvalMode: ApprovalMode.ALWAYS })]
  });

  const first = await agent.run("echo");
  assert.equal(first.finishReason, "approval_needed");
  assert.equal(first.needsApproval, true);
  assert.equal(first.approvalRequests.length, 1);
  assert.equal(first.approvalRequests[0].toolName, "echo");

  first.context.addApprovalResponse(first.approvalRequests[0].createResponse(true, "ok"));
  const second = await agent.run(undefined, { context: first.context });
  assert.equal(second.finishReason, "stop");
  assert.ok(second.messages.some((item) => item instanceof ToolMessage && item.content === "approved"));
  assert.equal(second.messages.at(-1).content, "final");
});

test("Rejected approvals create failed tool messages", async () => {
  const client = createMockClient({
    responses: [
      new AssistantMessage({
        content: "",
        source: "llm",
        toolCalls: [
          new ToolCallRequest({
            toolName: "echo",
            parameters: { value: "nope" },
            callId: "call_reject"
          })
        ]
      }),
      "after rejection"
    ]
  });
  const agent = new Agent({
    name: "agent",
    instructions: "Use tools.",
    modelClient: client,
    tools: [new EchoTool({ approvalMode: ApprovalMode.ALWAYS })]
  });

  const first = await agent.run("echo");
  first.context.addApprovalResponse(first.approvalRequests[0].createResponse(false, "not allowed"));
  const second = await agent.run(undefined, { context: first.context });

  const rejected = second.messages.find((item) => item instanceof ToolMessage);
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "Approval denied");
  assert.match(rejected.content, /not allowed/);
});

test("runStream emits ToolApprovalEvent when approval is required", async () => {
  const client = createMockClient({
    responses: [
      new AssistantMessage({
        content: "",
        source: "llm",
        toolCalls: [
          new ToolCallRequest({
            toolName: "echo",
            parameters: { value: "x" },
            callId: "call_stream"
          })
        ]
      })
    ]
  });
  const agent = new Agent({
    name: "agent",
    instructions: "Use tools.",
    modelClient: client,
    tools: [new EchoTool({ approvalMode: ApprovalMode.ALWAYS })]
  });

  const items = await collectAsync(agent.runStream("echo", { verbose: true }));
  const event = items.find((item) => item instanceof ToolApprovalEvent);
  assert.ok(event);
  assert.equal(event.approvalRequest.toolCallId, "call_stream");
});

test("ToolApprovalRequest creates matching responses", async () => {
  const client = createMockClient({
    responses: [
      new AssistantMessage({
        content: "",
        source: "llm",
        toolCalls: [
          new ToolCallRequest({
            toolName: "echo",
            parameters: { value: "x" },
            callId: "call_response"
          })
        ]
      })
    ]
  });
  const agent = new Agent({
    name: "agent",
    instructions: "Use tools.",
    modelClient: client,
    tools: [new EchoTool({ approvalMode: ApprovalMode.ALWAYS })]
  });

  const response = await agent.run("echo");
  const approval = response.approvalRequests[0].createResponse(true, "approved");
  assert.equal(approval.requestId, response.approvalRequests[0].requestId);
  assert.equal(approval.toolCallId, "call_response");
  assert.equal(approval.approved, true);
});
