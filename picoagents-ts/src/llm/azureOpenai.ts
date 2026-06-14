import { OpenAIChatCompletionClient, OpenAIChatCompletionClientOptions } from "./openai.js";
import { registerComponent } from "../componentConfig.js";
import type { SerializableComponent } from "../componentConfig.js";

export interface AzureOpenAIChatCompletionClientOptions extends Omit<OpenAIChatCompletionClientOptions, "baseUrl" | "organization"> {
  azureEndpoint?: string;
  apiVersion?: string;
  azureDeployment?: string;
  temperature?: number;
}

export class AzureOpenAIChatCompletionClient extends OpenAIChatCompletionClient implements SerializableComponent {
  static override componentType = "model";
  static override componentProvider = "picoagents.llm.AzureOpenAIChatCompletionClient";
  static override componentVersion = 1;

  azureEndpoint: string;
  apiVersion: string;
  azureDeployment: string;

  constructor(options: AzureOpenAIChatCompletionClientOptions = {}) {
    if (!options.azureEndpoint && !process.env.AZURE_OPENAI_ENDPOINT) {
      throw new Error("azureEndpoint is required for Azure OpenAI client");
    }
    super({
      model: options.model ?? "gpt-4.1-mini",
      apiKey: options.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
      defaultOptions: {
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.defaultOptions ?? {})
      }
    });
    this.azureEndpoint = (options.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2024-10-21";
    this.azureDeployment = options.azureDeployment ?? this.model;
  }

  protected override requestModel(): string {
    return this.azureDeployment;
  }

  protected override completionsUrl(): string {
    return `${this.azureEndpoint}/openai/deployments/${encodeURIComponent(this.azureDeployment)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  protected override headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    return headers;
  }

  override toConfig(): Record<string, unknown> {
    return {
      model: this.model,
      azureEndpoint: this.azureEndpoint,
      apiVersion: this.apiVersion,
      azureDeployment: this.azureDeployment,
      defaultOptions: this.defaultOptions,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs
    };
  }

  static override fromConfig(config: any): AzureOpenAIChatCompletionClient {
    return new AzureOpenAIChatCompletionClient(config);
  }
}

registerComponent(AzureOpenAIChatCompletionClient as any);
