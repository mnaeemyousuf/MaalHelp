import { env } from '../config/env';
import { db, t } from '../db';
import { AppError } from '../core/errors';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export interface ChatOptions {
  tenantId: string | null;
  userId: string | null;
  feature: 'copilot' | 'briefing' | 'document' | 'report' | 'anomaly';
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'any';
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface ChatResult {
  message: ChatMessage;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  latencyMs: number;
}

export class AiUnavailableError extends AppError {
  constructor(message: string) { super(503, 'AI_UNAVAILABLE', message); }
}

/** Sliding one-minute window per tenant. */
const windows = new Map<string, number[]>();
function checkRateLimit(tenantId: string | null): void {
  const key = tenantId ?? 'platform';
  const now = Date.now();
  const list = (windows.get(key) ?? []).filter((ts) => now - ts < 60_000);
  if (list.length >= env.AI_RATE_LIMIT_PER_MINUTE) throw new AppError(429, 'AI_RATE_LIMITED', 'AI request limit reached for your company. Please wait a minute and try again.');
  list.push(now);
  windows.set(key, list);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin, dependency-free client for the Mistral API. The key never leaves the
 * server. All calls are logged to ai_usage (tokens, cost, latency, status)
 * without prompt contents or secrets.
 */
export class MistralService {
  get configured(): boolean {
    return Boolean(env.MISTRAL_API_KEY);
  }

  get chatModel(): string {
    return env.MISTRAL_CHAT_MODEL;
  }

  private async request<T>(path: string, body: unknown): Promise<{ data: T; latencyMs: number }> {
    if (!env.MISTRAL_API_KEY) throw new AiUnavailableError('The AI model is not configured. Set MISTRAL_API_KEY on the server.');
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.MISTRAL_MAX_RETRIES; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(`${env.MISTRAL_API_URL.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.MISTRAL_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(env.MISTRAL_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - started;
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`Mistral HTTP ${res.status}`);
          const retryAfter = Number(res.headers.get('retry-after')) * 1000;
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 8000) : 600 * 2 ** attempt);
          continue;
        }
        const data = (await res.json()) as T & { message?: string; detail?: unknown };
        if (!res.ok) throw new AiUnavailableError(`The AI service rejected the request (HTTP ${res.status}).`);
        return { data, latencyMs };
      } catch (err) {
        if (err instanceof AiUnavailableError) throw err;
        lastError = err;
        if (attempt < env.MISTRAL_MAX_RETRIES) await sleep(600 * 2 ** attempt);
      }
    }
    throw new AiUnavailableError(`The AI service is unreachable right now (${lastError instanceof Error ? lastError.message : 'unknown error'}).`);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    checkRateLimit(opts.tenantId);
    const model = opts.model ?? env.MISTRAL_CHAT_MODEL;
    try {
      const { data, latencyMs } = await this.request<{ choices: { message: ChatMessage }[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string }>('/chat/completions', {
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 900,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto', parallel_tool_calls: true } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      });
      const usage = { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0, totalTokens: data.usage?.total_tokens ?? 0 };
      await this.track(opts, model, usage, latencyMs, 'ok');
      const message = data.choices?.[0]?.message;
      if (!message) throw new AiUnavailableError('The AI service returned an empty response.');
      return { message, usage, model: data.model ?? model, latencyMs };
    } catch (err) {
      await this.track(opts, model, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 0, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Structured output: asks for a JSON object and parses it. */
  async json<T>(system: string, user: string, opts: ChatOptions): Promise<T> {
    const res = await this.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { ...opts, json: true, temperature: 0 });
    try {
      return JSON.parse(String(res.message.content ?? '{}')) as T;
    } catch {
      throw new AiUnavailableError('The AI service returned malformed structured output.');
    }
  }

  /** Document OCR (PDF or image) via the Mistral OCR endpoint; returns markdown text per page. */
  async ocr(file: { base64: string; mimeType: string }, opts: Omit<ChatOptions, 'feature'>): Promise<string> {
    checkRateLimit(opts.tenantId);
    const model = env.MISTRAL_OCR_MODEL;
    const isImage = file.mimeType.startsWith('image/');
    const dataUrl = `data:${file.mimeType};base64,${file.base64}`;
    try {
      const { data, latencyMs } = await this.request<{ pages?: { markdown: string }[]; usage_info?: { pages_processed?: number } }>('/ocr', {
        model,
        document: isImage ? { type: 'image_url', image_url: dataUrl } : { type: 'document_url', document_url: dataUrl },
      });
      await this.track({ ...opts, feature: 'document' }, model, { promptTokens: 0, completionTokens: 0, totalTokens: (data.usage_info?.pages_processed ?? 1) * 1000 }, latencyMs, 'ok');
      return (data.pages ?? []).map((p) => p.markdown).join('\n\n---\n\n');
    } catch (err) {
      await this.track({ ...opts, feature: 'document' }, model, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 0, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async track(opts: Pick<ChatOptions, 'tenantId' | 'userId' | 'feature'>, model: string, usage: ChatResult['usage'], latencyMs: number, status: 'ok' | 'error' | 'fallback', error?: string): Promise<void> {
    const cost = (usage.promptTokens / 1e6) * env.AI_COST_INPUT_PER_MTOK + (usage.completionTokens / 1e6) * env.AI_COST_OUTPUT_PER_MTOK;
    try {
      await db().insert(t.aiUsage).values({
        tenantId: opts.tenantId, userId: opts.userId || null, feature: opts.feature, model, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens, costUsd: Math.round(cost * 1e6) / 1e6, latencyMs, status, error: error ? error.slice(0, 500) : null,
      });
    } catch { /* usage tracking must never break the request */ }
  }
}

export const mistral = new MistralService();
