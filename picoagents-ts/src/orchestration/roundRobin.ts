import { BaseAgent } from "../agents/index.js";
import { Message } from "../messages.js";
import { AgentResponse } from "../types.js";
import { BaseOrchestrator, BaseOrchestratorOptions } from "./base.js";

export class RoundRobinOrchestrator extends BaseOrchestrator {
  currentAgentIndex = 0;

  constructor(options: BaseOrchestratorOptions) {
    super(options);
  }

  async selectNextAgent(): Promise<BaseAgent> {
    const agent = this.agents[this.currentAgentIndex]!;
    this.currentAgentIndex = (this.currentAgentIndex + 1) % this.agents.length;
    return agent;
  }

  async prepareContextForAgent(_agent: BaseAgent): Promise<string> {
    if (!this.sharedMessages.length) {
      return "You are part of a team taking turns to collaboratively address a task. It is now your turn.";
    }

    const history = this.sharedMessages.map((message) => message.toString()).join("\n");
    return `You are part of a team taking turns to collaboratively address a task. Here's the progress/history so far:\n\n${history}\n\nIt is now your turn.`;
  }

  async updateSharedState(result: AgentResponse): Promise<void> {
    const newMessages: Message[] = result.messages.length > 1 ? result.messages.slice(1) : [];
    this.sharedMessages.push(...newMessages);
  }

  protected override resetForRun(): void {
    super.resetForRun();
    this.currentAgentIndex = 0;
  }

  protected override getPatternMetadata(): Record<string, unknown> {
    return {
      ...super.getPatternMetadata(),
      cyclesCompleted: Math.floor(this.iterationCount / this.agents.length),
      currentAgentIndex: this.currentAgentIndex,
      agentsOrder: this.agents.map((agent) => agent.name)
    };
  }
}
