import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('transcribe');

export type TranscribeError = 'disabled' | 'nokey' | 'toolarge' | 'download' | 'api' | 'empty';
export interface TranscribeResult {
  text: string;
}

const ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions',
};

/** True when transcription is configured and usable. */
export function transcribeReady(): boolean {
  return env.TRANSCRIBE_ENABLED && !!env.TRANSCRIBE_API_KEY;
}

/**
 * Transcribe an audio file (voice note, audio, video note…) to text using a
 * hosted Whisper API (Groq or OpenAI — both expose the same OpenAI-style
 * /audio/transcriptions endpoint). Downloads the file from Telegram's URL,
 * posts it as multipart, and returns the recognized text. Never throws.
 */
export async function transcribeFromUrl(
  fileUrl: string,
  filename: string,
): Promise<TranscribeResult | { error: TranscribeError; detail?: string }> {
  if (!env.TRANSCRIBE_ENABLED) return { error: 'disabled' };
  const key = env.TRANSCRIBE_API_KEY;
  if (!key) return { error: 'nokey' };

  // 1) Download the audio bytes from Telegram.
  let buf: Buffer;
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return { error: 'download', detail: `http ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    log.warn({ err }, 'audio download failed');
    return { error: 'download' };
  }
  if (buf.length > env.TRANSCRIBE_MAX_MB * 1024 * 1024) return { error: 'toolarge' };

  // 2) POST it to the Whisper endpoint as multipart/form-data.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), filename);
  form.append('model', env.TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  if (env.TRANSCRIBE_LANGUAGE) form.append('language', env.TRANSCRIBE_LANGUAGE);

  const endpoint = ENDPOINTS[env.TRANSCRIBE_PROVIDER] ?? ENDPOINTS.groq;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log.warn({ status: res.status, body: t.slice(0, 200) }, 'transcribe api error');
      return { error: 'api', detail: `${res.status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { text?: string };
    const text = (data.text ?? '').trim();
    if (!text) return { error: 'empty' };
    return { text };
  } catch (err) {
    log.warn({ err }, 'transcribe request failed');
    return { error: 'api' };
  }
}
