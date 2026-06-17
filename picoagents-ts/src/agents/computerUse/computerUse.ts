import { AgentContext } from "../../context.js";
import { BaseChatCompletionClient } from "../../llm/index.js";
import {
  Message,
  MultiModalMessage,
  ToolMessage
} from "../../messages.js";
import { AgentEvent, AgentResponse, ChatCompletionChunk } from "../../types.js";
import { CancellationToken } from "../../cancellation.js";
import { Agent } from "../agent.js";
import type { BaseAgentOptions, TaskInput } from "../base.js";
import { BaseInterfaceClient } from "./interfaceClients.js";
import { createPlaywrightTools } from "./playwrightTools.js";

export interface ComputerUseAgentOptions extends Omit<
  BaseAgentOptions,
  "name" | "description" | "instructions" | "tools" | "modelClient" | "maxIterations"
> {
  interfaceClient: BaseInterfaceClient;
  modelClient: BaseChatCompletionClient;
  name?: string;
  description?: string;
  instructions?: string;
  useScreenshots?: boolean;
  maxActions?: number;
}

export class ComputerUseAgent extends Agent {
  interfaceClient: BaseInterfaceClient;
  useScreenshots: boolean;
  isInitialized = false;

  constructor(options: ComputerUseAgentOptions) {
    const playwrightTools = createPlaywrightTools(options.interfaceClient);
    super({
      ...options,
      name: options.name ?? "computer_navigator",
      description: options.description ?? "Agent that uses tools to interact with web interfaces",
      instructions: options.instructions ?? defaultInstructions(playwrightTools),
      modelClient: options.modelClient,
      tools: playwrightTools,
      maxIterations: options.maxActions
    });
    this.interfaceClient = options.interfaceClient;
    this.useScreenshots = options.useScreenshots ?? true;
  }

  override async *runStream(
    task?: TaskInput,
    options: {
      context?: AgentContext;
      cancellationToken?: CancellationToken;
      verbose?: boolean;
      streamTokens?: boolean;
    } = {}
  ): AsyncGenerator<Message | AgentEvent | AgentResponse | ChatCompletionChunk> {
    if (!this.isInitialized) {
      await this.interfaceClient.initialize();
      this.isInitialized = true;
    }

    const workingContext = options.context ?? this.context.clone();
    if (this.useScreenshots) {
      const initialState = await this.interfaceClient.getState("hybrid");
      if (initialState.screenshot) {
        yield new MultiModalMessage({
          content: `Initial page - URL: ${initialState.url ?? "N/A"}`,
          source: this.name,
          role: "user",
          mimeType: "image/png",
          data: initialState.screenshot
        });
      }
    }

    for await (const item of super.runStream(task, {
      ...options,
      context: workingContext
    })) {
      yield item;

      if (item instanceof ToolMessage && item.toolName === "observe_page" && this.useScreenshots) {
        try {
          const state = await this.interfaceClient.getState("hybrid");
          if (state.screenshot) {
            const screenshotMessage = new MultiModalMessage({
              content: "Page observation",
              source: this.name,
              role: "user",
              mimeType: "image/png",
              data: state.screenshot
            });
            workingContext.addMessage(screenshotMessage);
            yield screenshotMessage;
          }
        } catch {
          // Screenshot capture is auxiliary and should not fail the agent run.
        }
      }

      if (item instanceof ToolMessage && item.toolName !== "observe_page" && this.useScreenshots) {
        try {
          const state = await this.interfaceClient.getState("hybrid");
          if (state.screenshot) {
            yield new MultiModalMessage({
              content: `After ${item.toolName} - URL: ${state.url ?? "N/A"}`,
              source: this.name,
              role: "user",
              mimeType: "image/png",
              data: state.screenshot
            });
          }
        } catch {
          // Screenshot capture is auxiliary and should not fail the agent run.
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.isInitialized) {
      await this.interfaceClient.close();
      this.isInitialized = false;
    }
  }

  override reset(): void {
    super.reset();
    if (this.isInitialized) {
      void this.close();
    }
  }

}

function defaultInstructions(tools: Array<{ name: string; description: string }>): string {
  const toolsText = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  return `You are an efficient computer use agent focused on task completion.

COMPLETION-FIRST MINDSET:
- After each action, ask yourself: "Do I now have enough information to complete the task?"
- If YES, immediately provide your answer and stop
- If NO, take the next minimal action needed
- Don't perform unnecessary actions once you have the answer

Your process:
1. Understand what specific information you need for the task
2. Take the minimum actions needed to get that information
3. As soon as you have it, provide your answer immediately
4. Only continue if you're missing critical information

Available tools:
${toolsText}

EFFICIENCY EXAMPLES:
Task: "Find the latest blog post title"
Do: navigate(blog-url) -> observe_page() -> provide answer
Do not: navigate -> observe -> scroll -> click links -> eventually stop

Task: "Get company CEO name from about page"
Do: navigate(about-url) -> observe_page() -> provide answer
Do not: navigate -> observe -> click links -> scroll -> eventually find it

Be decisive: if you can see the answer, provide it immediately!`;
}
