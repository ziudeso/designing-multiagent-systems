export {
  AuthenticationError,
  BaseChatCompletionClient,
  BaseChatCompletionError,
  InvalidRequestError,
  RateLimitError,
  makeSchemaCompatible
} from "./base.js";
export type { StructuredOutputFormat } from "./base.js";
export { OpenAIChatCompletionClient, buildToolCallsFromChunks } from "./openai.js";
export type { OpenAIChatCompletionClientOptions } from "./openai.js";
export { AzureOpenAIChatCompletionClient } from "./azureOpenai.js";
export type { AzureOpenAIChatCompletionClientOptions } from "./azureOpenai.js";
export { AnthropicChatCompletionClient } from "./anthropic.js";
export type { AnthropicChatCompletionClientOptions } from "./anthropic.js";
