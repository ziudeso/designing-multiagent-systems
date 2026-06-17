import {
  AgentResponse,
  AssistantMessage,
  BaseEvent,
  ToolMessage
} from "picoagents-ts";
import type { AgentEvent, ChatCompletionChunk, Message } from "picoagents-ts";

export function printAgentItem(
  item: Message | AgentEvent | AgentResponse | ChatCompletionChunk
): void {
  if (item instanceof AgentResponse) {
    console.log(`Final response (${item.finishReason}): ${item.finalContent}`);
    return;
  }
  if (item instanceof AssistantMessage || item instanceof ToolMessage) {
    console.log(item.toString());
    return;
  }
  if (item instanceof BaseEvent) {
    console.log(`[event:${item.eventType}] ${item.source}`);
    return;
  }
  if ("content" in item && typeof item.content === "string") {
    process.stdout.write(item.content);
    return;
  }
  console.log(String(item));
}

export function section(title: string): void {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}
