import { BaseAgent } from "../agents/index.js";
import { registerComponent } from "../componentConfig.js";
import type { ComponentType } from "../componentConfig.js";
import { AssistantMessage, Message } from "../messages.js";
import { AgentResponse } from "../types.js";
import {
  BaseOrchestrator,
  BaseOrchestratorOptions,
  loadBaseOrchestratorOptions,
  serializeBaseOrchestratorConfig
} from "./base.js";

export interface HandoffRequest {
  targetAgent: string;
  reason: string;
  sourceAgent: string;
}

export class HandoffOrchestrator extends BaseOrchestrator {
  static componentType: ComponentType = "orchestrator";
  static componentProvider = "picoagents.orchestration.HandoffOrchestrator";
  static componentVersion = 1;

  private currentAgentIndex = 0;
  handoffHistory: HandoffRequest[] = [];

  constructor(options: BaseOrchestratorOptions) {
    super(options);
  }

  static fromConfig(config: Record<string, unknown> = {}): HandoffOrchestrator {
    return new HandoffOrchestrator(loadBaseOrchestratorOptions(config));
  }

  toConfig(): Record<string, unknown> {
    return serializeBaseOrchestratorConfig(this);
  }

  async selectNextAgent(): Promise<BaseAgent> {
    return this.agents[this.currentAgentIndex]!;
  }

  async prepareContextForAgent(agent: BaseAgent): Promise<string> {
    const history = this.sharedMessages.map((message) => message.toString()).join("\n");
    const handoffNote = this.handoffHistory.length
      ? `\n\nMost recent handoff: ${this.handoffHistory.at(-1)!.sourceAgent} -> ${agent.name}. Reason: ${this.handoffHistory.at(-1)!.reason}`
      : "";

    return `You are participating in a handoff-based multi-agent task. Continue from the shared history and explicitly hand off to another named agent if they are better suited.

Available agents:
${this.agents.map((item) => `- ${item.name}: ${item.description}`).join("\n")}

Shared history:
${history || "(none yet)"}${handoffNote}

It is now your turn.`;
  }

  async updateSharedState(result: AgentResponse): Promise<void> {
    const newMessages: Message[] = result.messages.length > 1 ? result.messages.slice(1) : [];
    this.sharedMessages.push(...newMessages);

    const handoff = this.extractHandoffRequest(result);
    if (handoff) {
      this.handoffHistory.push(handoff);
      const targetIndex = this.agents.findIndex(
        (agent) => agent.name.toLowerCase() === handoff.targetAgent.toLowerCase()
      );
      if (targetIndex >= 0) {
        this.currentAgentIndex = targetIndex;
        return;
      }
    }

    this.currentAgentIndex = (this.currentAgentIndex + 1) % this.agents.length;
  }

  extractHandoffRequest(result: AgentResponse): HandoffRequest | undefined {
    const assistantMessages = result.messages.filter(
      (message): message is AssistantMessage => message instanceof AssistantMessage
    );
    for (let index = assistantMessages.length - 1; index >= 0; index -= 1) {
      const message = assistantMessages[index]!;
      const lower = message.content.toLowerCase();
      for (const agent of this.agents) {
        const target = agent.name.toLowerCase();
        const patterns = [
          `handoff to ${target}`,
          `hand off to ${target}`,
          `transfer to ${target}`,
          `pass to ${target}`,
          `delegate to ${target}`
        ];
        const pattern = patterns.find((item) => lower.includes(item));
        if (pattern) {
          return {
            targetAgent: agent.name,
            reason: extractReason(message.content, pattern),
            sourceAgent: result.source
          };
        }
      }
    }
    return undefined;
  }

  protected override resetForRun(): void {
    super.resetForRun();
    this.currentAgentIndex = 0;
    this.handoffHistory = [];
  }

  protected override getPatternMetadata(): Record<string, unknown> {
    return {
      ...super.getPatternMetadata(),
      currentAgentIndex: this.currentAgentIndex,
      handoffHistory: this.handoffHistory
    };
  }
}

registerComponent(HandoffOrchestrator as any);

function extractReason(content: string, pattern: string): string {
  const index = content.toLowerCase().indexOf(pattern);
  if (index < 0) return "Explicit handoff requested";
  const trailing = content.slice(index + pattern.length).replace(/^[:\-\s]+/, "").trim();
  return trailing || "Explicit handoff requested";
}
