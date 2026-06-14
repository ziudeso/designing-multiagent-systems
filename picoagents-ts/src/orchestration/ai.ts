import { BaseAgent } from "../agents/index.js";
import { BaseChatCompletionClient, StructuredOutputFormat } from "../llm/index.js";
import { Message, UserMessage } from "../messages.js";
import { BaseOrchestrator, BaseOrchestratorOptions } from "./base.js";
import { AgentResponse } from "../types.js";

export interface AgentSelection {
  selected_agent: string;
  reasoning: string;
  confidence: number;
}

export interface AIOrchestratorOptions extends BaseOrchestratorOptions {
  modelClient: BaseChatCompletionClient;
}

const agentSelectionFormat: StructuredOutputFormat = {
  name: "AgentSelection",
  schema: {
    type: "object",
    properties: {
      selected_agent: { type: "string", description: "Name of the selected agent" },
      reasoning: { type: "string", description: "Explanation for the selected agent" },
      confidence: { type: "number", description: "Confidence from 0.0 to 1.0" }
    },
    required: ["selected_agent", "reasoning", "confidence"]
  }
};

export class AIOrchestrator extends BaseOrchestrator {
  modelClient: BaseChatCompletionClient;
  selectionHistory: Array<{
    selectedAgent: string;
    iteration: number;
    reasoning: string;
    confidence: number;
    conversationLength: number;
  }> = [];
  private agentCapabilitiesCache?: string;

  constructor(options: AIOrchestratorOptions) {
    super(options);
    this.modelClient = options.modelClient;
  }

  async selectNextAgent(): Promise<BaseAgent> {
    const capabilities = this.getAgentCapabilitiesSummary();
    const conversationContext = this.formatConversationForSelection();
    const prompt = `You are coordinating a team of AI agents working collaboratively on a task.

Available agents and their capabilities:
${capabilities}

Recent conversation history:
${conversationContext}

Based on the conversation context and each agent's capabilities, choose which agent should respond next to move the task forward. Consider what response is needed, which skills/tools best match, natural flow, and avoiding repetitive selections unless justified.

Select the most appropriate agent and explain your reasoning in one clean line.`;

    let selectedName = this.getFallbackAgentName();
    let reasoning = "Fallback selection";
    let confidence = 0.3;

    try {
      const result = await this.modelClient.create(
        [new UserMessage({ content: prompt, source: "orchestrator" })],
        { outputFormat: agentSelectionFormat }
      );
      const selection = result.structuredOutput as Partial<AgentSelection> | undefined;
      if (selection?.selected_agent) {
        selectedName = selection.selected_agent;
        reasoning = selection.reasoning ?? "Structured selection";
        confidence = typeof selection.confidence === "number" ? selection.confidence : 0.5;
      } else {
        selectedName = this.extractAgentNameFromText(result.message.content);
        reasoning = "Fallback selection from text response";
        confidence = 0.5;
      }
    } catch (error) {
      reasoning = `Fallback due to LLM error: ${error instanceof Error ? error.message : String(error)}`;
      confidence = 0.1;
    }

    const selectedAgent = this.findAgentByName(selectedName);
    this.selectionHistory.push({
      selectedAgent: selectedAgent.name,
      iteration: this.iterationCount,
      reasoning,
      confidence,
      conversationLength: this.sharedMessages.length
    });
    return selectedAgent;
  }

  async prepareContextForAgent(_agent: BaseAgent): Promise<string> {
    if (!this.sharedMessages.length) {
      return "You are part of a team taking turns to collaboratively address a task. It is now your turn.";
    }
    const history = this.sharedMessages.map((message) => message.toString()).join("\n");
    return `You are part of a team taking turns to collaboratively address a task. Here's the progress/history so far:\n\n${history}\n\nIt is now your turn.`;
  }

  async updateSharedState(result: AgentResponse): Promise<void> {
    this.sharedMessages.push(...(result.messages.length > 1 ? result.messages.slice(1) : []));
  }

  override getAgentCapabilitiesSummary(): string {
    this.agentCapabilitiesCache ??= super.getAgentCapabilitiesSummary();
    return this.agentCapabilitiesCache;
  }

  protected override resetForRun(): void {
    super.resetForRun();
    this.selectionHistory = [];
    this.agentCapabilitiesCache = undefined;
  }

  protected override getPatternMetadata(): Record<string, unknown> {
    const uniqueAgents = new Set(this.selectionHistory.map((item) => item.selectedAgent));
    const averageConfidence =
      this.selectionHistory.length === 0
        ? 0
        : this.selectionHistory.reduce((sum, item) => sum + item.confidence, 0) / this.selectionHistory.length;
    return {
      ...super.getPatternMetadata(),
      selectionHistory: this.selectionHistory.map((item) => ({
        agent: item.selectedAgent,
        iteration: item.iteration,
        confidence: item.confidence
      })),
      uniqueAgentsSelected: uniqueAgents.size,
      agentDiversity: this.agents.length ? uniqueAgents.size / this.agents.length : 0,
      averageConfidence: Math.round(averageConfidence * 1000) / 1000,
      recentReasoning: this.selectionHistory.slice(-5).map((item) => item.reasoning),
      modelUsed: this.modelClient.model
    };
  }

  protected findAgentByName(name: string): BaseAgent {
    const nameLower = name.toLowerCase().trim();
    return (
      this.agents.find((agent) => agent.name.toLowerCase() === nameLower) ??
      this.agents.find((agent) => agent.name.toLowerCase().includes(nameLower) || nameLower.includes(agent.name.toLowerCase())) ??
      this.agents[0]!
    );
  }

  protected formatConversationForSelection(): string {
    if (!this.sharedMessages.length) return "No conversation yet.";
    return `History so far:\n\n${this.sharedMessages.map((message) => message.toString()).join("\n")}`;
  }

  protected extractAgentNameFromText(text: string): string {
    const lower = text.toLowerCase();
    return this.agents.find((agent) => lower.includes(agent.name.toLowerCase()))?.name ?? this.agents[0]!.name;
  }

  protected getFallbackAgentName(): string {
    if (this.selectionHistory.length) {
      const lastName = this.selectionHistory.at(-1)!.selectedAgent;
      const index = this.agents.findIndex((agent) => agent.name === lastName);
      if (index >= 0) return this.agents[(index + 1) % this.agents.length]!.name;
    }
    return this.agents[0]!.name;
  }
}
