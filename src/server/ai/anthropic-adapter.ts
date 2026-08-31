import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import type { LlmClient, LlmCompletionInput, LlmCompletionResult } from '@/server/ai/llm';

type Fetcher = typeof fetch;

type GeminiClientOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetcher?: Fetcher;
};

type GeminiChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export class AnthropicMessagesClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(options: GeminiClientOptions = {}) {
    this.apiKey = options.apiKey ?? env.GEMINI_API_KEY;
    this.model = options.model ?? env.GEMINI_MODEL;

    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai';

    this.fetcher = options.fetcher ?? fetch;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    if (!this.apiKey || !this.model) {
      throw new AppError('internal', 'Gemini API key or model is not configured', {
        expose: false,
      });
    }

    const messages = [
      {
        role: 'system' as const,
        content: input.system,
      },
      ...input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: input.maxTokens,
        temperature: input.temperature ?? 0.2,
      }),
    });

    const body = (await readJson(response)) as GeminiChatResponse;

    if (!response.ok) {
      throw new AppError('upstream_error', 'Gemini API failed', {
        cause: {
          status: response.status,
          body,
        },
        expose: false,
      });
    }

    const text = body.choices?.[0]?.message?.content?.trim() ?? '';

    if (!text) {
      throw new AppError('upstream_error', 'Gemini returned an empty response', {
        cause: body,
        expose: false,
      });
    }

    return {
      text,
      model: body.model ?? this.model,
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
      stopReason: body.choices?.[0]?.finish_reason ?? null,
      raw: body,
    };
  }
}

export function createAnthropicClientForModel(model: string): AnthropicMessagesClient | null {
  if (!env.GEMINI_API_KEY || !model) {
    return null;
  }

  return new AnthropicMessagesClient({
    model,
  });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      raw: text,
    };
  }
}
