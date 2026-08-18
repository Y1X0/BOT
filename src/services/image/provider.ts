import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('image:provider');

/**
 * Image AI provider abstraction — swap implementations by setting IMAGE_PROVIDER.
 * `edit` transforms an existing photo per a prompt (preserving the subject);
 * `generate` creates a new image from a text prompt.
 */
export interface ImageProvider {
  readonly name: string;
  isConfigured(): boolean;
  edit(image: Buffer, prompt: string): Promise<Buffer | null>;
  generate(prompt: string): Promise<Buffer | null>;
}

const TIMEOUT_MS = 120_000;

// Last low-level failure reason, surfaced to the bot owner for debugging.
let lastImageError = '';
export function getLastImageError(): string {
  return lastImageError;
}
function setError(reason: string): null {
  lastImageError = reason;
  return null;
}

/** OpenAI images (gpt-image-1): /v1/images/edits and /v1/images/generations. */
class OpenAIImageProvider implements ImageProvider {
  readonly name = 'openai';

  isConfigured(): boolean {
    return Boolean(env.IMAGE_API_KEY);
  }

  async edit(image: Buffer, prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    const form = new FormData();
    form.append('model', env.IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('size', env.IMAGE_SIZE);
    form.append('image', new Blob([image], { type: 'image/png' }), 'input.png');
    return this.post('https://api.openai.com/v1/images/edits', form);
  }

  async generate(prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    const form = new FormData();
    form.append('model', env.IMAGE_MODEL);
    form.append('prompt', prompt);
    form.append('size', env.IMAGE_SIZE);
    return this.post('https://api.openai.com/v1/images/generations', form);
  }

  private async post(url: string, form: FormData): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.IMAGE_API_KEY}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        log.warn({ status: res.status, body }, 'image api error');
        return setError(`HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const item = data.data?.[0];
      if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
      if (item?.url) {
        const img = await fetch(item.url);
        return img.ok ? Buffer.from(await img.arrayBuffer()) : setError('image url fetch failed');
      }
      return setError('no image in response');
    } catch (err) {
      log.warn({ err }, 'image request failed');
      return setError(`request failed: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Google Gemini image model ("Nano Banana", gemini-2.5-flash-image) via the
 * Generative Language API. One endpoint does both edit (image + text parts)
 * and generate (text only). Free tier, no ID verification required.
 */
class GeminiImageProvider implements ImageProvider {
  readonly name = 'gemini';

  isConfigured(): boolean {
    return Boolean(env.IMAGE_API_KEY);
  }

  private model(): string {
    // Fall back to a real Gemini image model if IMAGE_MODEL is left at the
    // OpenAI default, so users only have to set the key.
    return env.IMAGE_MODEL.startsWith('gemini') ? env.IMAGE_MODEL : 'gemini-2.5-flash-image';
  }

  async edit(image: Buffer, prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    return this.generateContent([
      { text: prompt },
      { inline_data: { mime_type: 'image/png', data: image.toString('base64') } },
    ]);
  }

  async generate(prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    return this.generateContent([{ text: prompt }]);
  }

  private async generateContent(parts: unknown[]): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model()}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.IMAGE_API_KEY ?? '',
        },
        // Image models must be told to return an image, or they reply with text.
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        log.warn({ status: res.status, body }, 'gemini image api error');
        return setError(`HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { data?: string };
              inline_data?: { data?: string };
              text?: string;
            }>;
          };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
      };
      const cand = data.candidates?.[0];
      const outParts = cand?.content?.parts ?? [];
      for (const part of outParts) {
        const b64 = part.inlineData?.data ?? part.inline_data?.data;
        if (b64) return Buffer.from(b64, 'base64');
      }
      log.warn({ finishReason: cand?.finishReason, block: data.promptFeedback?.blockReason }, 'gemini returned no image part');
      return setError(
        data.promptFeedback?.blockReason
          ? `blocked: ${data.promptFeedback.blockReason}`
          : `no image (finishReason: ${cand?.finishReason ?? 'unknown'}, model: ${this.model()})`,
      );
    } catch (err) {
      log.warn({ err }, 'gemini image request failed');
      return setError(`request failed: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pollinations.ai — free, keyless text-to-image (FLUX). No API key, no billing,
 * no quota to run out of. Generation only (no image-to-image edit).
 */
class PollinationsImageProvider implements ImageProvider {
  readonly name = 'pollinations';

  isConfigured(): boolean {
    return true; // no key required
  }

  async edit(_image: Buffer, _prompt: string): Promise<Buffer | null> {
    return setError('pollinations: تعديل الصور غير مدعوم — استخدم التوليد فقط.');
  }

  async generate(prompt: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const [w, h] = env.IMAGE_SIZE.split('x').map((n) => Number(n));
      const width = Number.isFinite(w) && w > 0 ? w : 1024;
      const height = Number.isFinite(h) && h > 0 ? h : 1024;
      const models = ['flux', 'turbo', 'flux-realism', 'flux-anime', 'flux-3d'];
      const model = models.includes(env.IMAGE_MODEL) ? env.IMAGE_MODEL : 'flux';
      const seed = Date.now() % 1_000_000;
      const url =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
        `?width=${width}&height=${height}&model=${model}&seed=${seed}&nologo=true&safe=true`;
      const res = await fetch(url, { signal: controller.signal, headers: { accept: 'image/*' } });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        log.warn({ status: res.status, body }, 'pollinations image error');
        return setError(`HTTP ${res.status}: ${body}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // A tiny body usually means an error page, not a real image.
      if (buf.length < 1024) return setError('pollinations أعادت صورة فارغة، جرّب وصفاً آخر.');
      return buf;
    } catch (err) {
      log.warn({ err }, 'pollinations request failed');
      return setError(`request failed: ${String((err as Error)?.message ?? err).slice(0, 150)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

let provider: ImageProvider | null = null;
export function getImageProvider(): ImageProvider {
  if (!provider) {
    // Selected via IMAGE_PROVIDER. Add new providers to this switch.
    provider =
      env.IMAGE_PROVIDER === 'gemini'
        ? new GeminiImageProvider()
        : env.IMAGE_PROVIDER === 'pollinations'
          ? new PollinationsImageProvider()
          : new OpenAIImageProvider();
  }
  return provider;
}
