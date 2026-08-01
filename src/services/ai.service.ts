import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('ai-service');

/**
 * Per-chat daily usage counter (in-memory). Resets on the calendar day.
 * Guards against runaway API cost. For multi-instance use a shared store.
 */
const usage = new Map<string, { day: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function canUseAi(chatId: number | bigint): boolean {
  const key = String(chatId);
  const entry = usage.get(key);
  const day = today();
  if (!entry || entry.day !== day) return true;
  return entry.count < env.AI_DAILY_LIMIT;
}

function recordUse(chatId: number | bigint): void {
  const key = String(chatId);
  const day = today();
  const entry = usage.get(key);
  if (!entry || entry.day !== day) {
    usage.set(key, { day, count: 1 });
  } else {
    entry.count += 1;
  }
}

const SYSTEM_PROMPT =
  'أنت مساعد ودود داخل مجموعة تيليجرام. أجب باختصار وبلغة المستخدم. تجنّب المحتوى المسيء.';

/**
 * Ask the configured AI provider a question. Returns null on any failure so
 * the caller can degrade gracefully. Never throws.
 */
export async function askAi(chatId: number | bigint, prompt: string): Promise<string | null> {
  if (!env.AI_API_KEY) return null;
  if (!canUseAi(chatId)) return null;

  try {
    const answer =
      env.AI_PROVIDER === 'openai'
        ? await askOpenAi(prompt)
        : await askAnthropic(prompt);
    if (answer) recordUse(chatId);
    return answer;
  } catch (err) {
    log.warn({ err }, 'AI request failed');
    return null;
  }
}

async function askAnthropic(prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.AI_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text?.trim() ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

async function askOpenAi(prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } finally {
    clearTimeout(timeout);
  }
}
