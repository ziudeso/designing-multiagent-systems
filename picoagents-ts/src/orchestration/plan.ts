import { BaseAgent } from "../agents/index.js";
import { BaseChatCompletionClient, StructuredOutputFormat } from "../llm/index.js";
import { Message, UserMessage } from "../messages.js";
import { AgentResponse, StopMessage } from "../types.js";
import { BaseOrchestrator, BaseOrchestratorOptions } from "./base.js";

export interface StepProgressEvaluation {
  step_completed: boolean;
  failure_reason: string;
  confidence_score: number;
  suggested_improvements: string[];
}

export interface PlanStep {
  task: string;
  agent_name: string;
  reasoning: string;
}

export interface ExecutionPlan {
  steps: PlanStep[];
}

export interface PlanBasedOrchestratorOptions extends BaseOrchestratorOptions {
  modelClient: BaseChatCompletionClient;
  maxStepRetries?: number;
}

const executionPlanFormat: StructuredOutputFormat = {
  name: "ExecutionPlan",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: { type: "string" },
            agent_name: { type: "string" },
            reasoning: { type: "string" }
          },
          required: ["task", "agent_name", "reasoning"]
        }
      }
    },
    required: ["steps"]
  }
};

const stepProgressEvaluationFormat: StructuredOutputFormat = {
  name: "StepProgressEvaluation",
  schema: {
    type: "object",
    properties: {
      step_completed: { type: "boolean" },
      failure_reason: { type: "string" },
      confidence_score: { type: "number" },
      suggested_improvements: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["step_completed", "failure_reason", "confidence_score", "suggested_improvements"]
  }
};

export class PlanBasedOrchestrator extends BaseOrchestrator {
  modelClient: BaseChatCompletionClient;
  maxStepRetries: number;
  executionPlan?: ExecutionPlan;
  currentStepIndex = 0;
  currentStepRetryCount = 0;
  initialTask?: string;
  stepAttempts: Record<number, AgentResponse[]> = {};
  stepResults: Record<number, AgentResponse> = {};
  retryInstructions: Record<number, string> = {};
  private agentCapabilitiesCache?: string;

  constructor(options: PlanBasedOrchestratorOptions) {
    super(options);
    this.modelClient = options.modelClient;
    this.maxStepRetries = options.maxStepRetries ?? 3;
  }

  async selectNextAgent(): Promise<BaseAgent> {
    if (!this.executionPlan) {
      if (!this.sharedMessages.length) throw new Error("No initial task found to create plan");
      this.initialTask = this.sharedMessages[0]!.content;
      this.executionPlan = await this.createPlan(this.initialTask);
    }

    if (this.currentStepIndex >= this.executionPlan.steps.length) {
      return this.agents[0]!;
    }

    const currentStep = this.executionPlan.steps[this.currentStepIndex]!;
    return this.findAgentByName(currentStep.agent_name);
  }

  async prepareContextForAgent(_agent: BaseAgent): Promise<string | UserMessage | Message[]> {
    if (!this.executionPlan || this.currentStepIndex >= this.executionPlan.steps.length) {
      return [...this.sharedMessages];
    }

    const currentStep = this.executionPlan.steps[this.currentStepIndex]!;
    const context = this.extractRelevantContext(currentStep);
    context.push(
      new UserMessage({
        content: this.formatStepTask(currentStep),
        source: "plan_orchestrator"
      })
    );
    return context;
  }

  async updateSharedState(result: AgentResponse): Promise<void> {
    const newMessages = result.messages.filter((message) => !(message instanceof UserMessage));
    this.sharedMessages.push(...newMessages);

    if (!this.executionPlan || this.currentStepIndex >= this.executionPlan.steps.length) return;

    this.stepAttempts[this.currentStepIndex] ??= [];
    this.stepAttempts[this.currentStepIndex]!.push(result);

    const currentStep = this.executionPlan.steps[this.currentStepIndex]!;
    const progress = await this.evaluateStepProgress(currentStep, result);

    if (progress.step_completed) {
      this.stepResults[this.currentStepIndex] = result;
      this.currentStepIndex += 1;
      this.currentStepRetryCount = 0;
      return;
    }

    this.currentStepRetryCount += 1;
    if (this.currentStepRetryCount <= this.maxStepRetries) {
      this.retryInstructions[this.currentStepIndex] = this.createRetryInstructions(progress);
    } else {
      this.currentStepIndex += 1;
      this.currentStepRetryCount = 0;
    }
  }

  async createPlan(task: string): Promise<ExecutionPlan> {
    const prompt = `You are a helpful assistant that breaks down tasks into executable steps.

Available agents and their capabilities:
${this.getAgentCapabilitiesSummary()}

User task: ${task}

Generate a concise step-by-step execution plan. For each step:
- Assign it to the best suited agent
- Provide a clear, actionable task description
- Explain briefly why that agent was chosen

Keep it simple and focused.`;

    try {
      const result = await this.modelClient.create(
        [new UserMessage({ content: prompt, source: "planner" })],
        { outputFormat: executionPlanFormat }
      );
      const plan = result.structuredOutput as Partial<ExecutionPlan> | undefined;
      if (plan?.steps?.length) {
        return {
          steps: plan.steps.map((step) => ({
            task: String(step.task),
            agent_name: String(step.agent_name),
            reasoning: String(step.reasoning)
          }))
        };
      }
    } catch {
      // Fall through to fallback plan.
    }

    return this.createFallbackPlan(task);
  }

  override getAgentCapabilitiesSummary(): string {
    this.agentCapabilitiesCache ??= super.getAgentCapabilitiesSummary();
    return this.agentCapabilitiesCache;
  }

  extractRelevantContext(_step: PlanStep): Message[] {
    return this.sharedMessages.length > 5 ? this.sharedMessages.slice(-5) : [...this.sharedMessages];
  }

  async evaluateStepProgress(step: PlanStep, result: AgentResponse): Promise<StepProgressEvaluation> {
    const agentOutput = result.messages
      .filter((message) => !(message instanceof UserMessage))
      .map((message) => message.content)
      .join("\n");

    if (!agentOutput.trim()) {
      return {
        step_completed: false,
        failure_reason: "No meaningful output detected",
        confidence_score: 0.9,
        suggested_improvements: ["Provide more specific instructions", "Add examples of expected output"]
      };
    }

    const prompt = `Evaluate whether the following step was successfully completed based on the agent's output.

Step Task: ${step.task}
Expected Agent: ${step.agent_name}
Reasoning: ${step.reasoning}

Agent's Output:
${agentOutput}

Evaluate whether the step task was completed, why it failed if not, confidence from 0.0 to 1.0, and retry suggestions. Consider the step successful if the agent made meaningful progress toward the stated goal.`;

    try {
      const evalResult = await this.modelClient.create(
        [new UserMessage({ content: prompt, source: "step_evaluator" })],
        { outputFormat: stepProgressEvaluationFormat }
      );
      const value = evalResult.structuredOutput as Partial<StepProgressEvaluation> | undefined;
      if (value && typeof value.step_completed === "boolean") {
        return {
          step_completed: value.step_completed,
          failure_reason: value.failure_reason ?? "None",
          confidence_score: typeof value.confidence_score === "number" ? value.confidence_score : 0.5,
          suggested_improvements: Array.isArray(value.suggested_improvements) ? value.suggested_improvements : []
        };
      }
    } catch {
      // Fall through to heuristic.
    }

    return this.fallbackStepEvaluation(agentOutput);
  }

  protected override shouldStop(): StopMessage | undefined {
    if (this.executionPlan && this.currentStepIndex >= this.executionPlan.steps.length) {
      return new StopMessage({
        content: "Execution plan completed",
        source: "PlanBasedOrchestrator",
        metadata: {
          stepsCompleted: Object.keys(this.stepResults).length,
          totalSteps: this.executionPlan.steps.length
        }
      });
    }
    return undefined;
  }

  protected override resetForRun(): void {
    super.resetForRun();
    this.executionPlan = undefined;
    this.currentStepIndex = 0;
    this.currentStepRetryCount = 0;
    this.initialTask = undefined;
    this.stepAttempts = {};
    this.stepResults = {};
    this.retryInstructions = {};
    this.agentCapabilitiesCache = undefined;
  }

  protected override getPatternMetadata(): Record<string, unknown> {
    return {
      ...super.getPatternMetadata(),
      plan: this.executionPlan,
      currentStepIndex: this.currentStepIndex,
      stepsCompleted: Object.keys(this.stepResults).length,
      totalRetries: Object.values(this.stepAttempts).reduce(
        (sum, attempts) => sum + Math.max(0, attempts.length - 1),
        0
      ),
      currentStepRetryCount: this.currentStepRetryCount,
      maxStepRetries: this.maxStepRetries
    };
  }

  private createFallbackPlan(task: string): ExecutionPlan {
    return {
      steps: [
        {
          task: `Complete the task: ${task}`,
          agent_name: this.agents[0]!.name,
          reasoning: "Single-step fallback plan"
        }
      ]
    };
  }

  private findAgentByName(name: string): BaseAgent {
    const nameLower = name.toLowerCase().trim();
    return (
      this.agents.find((agent) => agent.name.toLowerCase() === nameLower) ??
      this.agents.find((agent) => agent.name.toLowerCase().includes(nameLower) || nameLower.includes(agent.name.toLowerCase())) ??
      this.agents[0]!
    );
  }

  private formatStepTask(step: PlanStep): string {
    let task = `STEP ${this.currentStepIndex + 1}: ${step.task}`;
    if (this.currentStepRetryCount > 0 && this.retryInstructions[this.currentStepIndex]) {
      task += `\n\nRETRY INSTRUCTIONS (Attempt ${this.currentStepRetryCount + 1}):\n${this.retryInstructions[this.currentStepIndex]}`;
    }
    return task;
  }

  private createRetryInstructions(progress: StepProgressEvaluation): string {
    const attempts = this.stepAttempts[this.currentStepIndex]?.length ?? 0;
    const suggestions = progress.suggested_improvements.length
      ? `\nSuggestions:\n${progress.suggested_improvements.map((item) => `- ${item}`).join("\n")}`
      : "";
    return `Previous attempt failed: ${progress.failure_reason || "Unknown reason"}\nThis is retry attempt ${attempts + 1}. Please try a different approach.${suggestions}`;
  }

  private fallbackStepEvaluation(agentOutput: string): StepProgressEvaluation {
    const lower = agentOutput.toLowerCase();
    const hasMeaningfulContent = agentOutput.trim().length > 20;
    const hasError = ["error", "failed", "cannot", "unable", "sorry"].some((word) => lower.includes(word));
    if (hasMeaningfulContent && !hasError) {
      return {
        step_completed: true,
        failure_reason: "None",
        confidence_score: 0.7,
        suggested_improvements: []
      };
    }
    return {
      step_completed: false,
      failure_reason: "Output suggests task was not completed successfully",
      confidence_score: 0.6,
      suggested_improvements: ["Provide clearer instructions", "Break task into smaller parts", "Add specific examples"]
    };
  }
}
