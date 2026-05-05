import { z } from "zod/v4"

export type OpenAICompatibleChatModelId = string

export const openaiCompatibleProviderOptions = z.object({
  /**
   * A unique identifier representing your end-user, which can help the provider to
   * monitor and detect abuse.
   */
  user: z.string().optional(),

  /**
   * Controls provider-side thinking / reasoning mode for OpenAI-compatible
   * backends such as llama-server and DashScope.
   */
  enable_thinking: z.boolean().optional(),

  /**
   * Extra chat template kwargs for llama.cpp-style servers.
   */
  chat_template_kwargs: z.record(z.string(), z.unknown()).optional(),

  /**
   * Reasoning effort for reasoning models. Defaults to `medium`.
   */
  reasoningEffort: z.string().optional(),

  /**
   * Controls the verbosity of the generated text. Defaults to `medium`.
   */
  textVerbosity: z.string().optional(),

  /**
   * Copilot thinking_budget used for Anthropic models.
   */
  thinking_budget: z.number().optional(),
})

export type OpenAICompatibleProviderOptions = z.infer<typeof openaiCompatibleProviderOptions>
