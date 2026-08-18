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

/** Node's fetch throws a generic "fetch failed" and hides the real reason in
 * `err.cause` (ENOTFOUND, ECONNREFUSED, TLS…). Surface it so errors are useful. */
function errDetail(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause ? ` [${e.cause.code ?? e.cause.message ?? ''}]` : '';
  return `${String(e?.message ?? err)}${cause}`.slice(0, 180);
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
    const [w, h] = env.IMAGE_SIZE.split('x').map((n) => Number(n));
    const width = Number.isFinite(w) && w > 0 ? w : 1024;
    const height = Number.isFinite(h) && h > 0 ? h : 1024;
    const models = ['flux', 'turbo', 'flux-realism', 'flux-anime', 'flux-3d'];
    const model = models.includes(env.IMAGE_MODEL) ? env.IMAGE_MODEL : 'flux';

    // Two hostnames + up to 2 network attempts each — "fetch failed" is often a
    // transient DNS/connection blip, and the second host is a live fallback.
    const hosts = ['https://image.pollinations.ai', 'https://pollinations.ai'];
    let lastErr = '';
    for (const host of hosts) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const seed = (Date.now() + attempt) % 1_000_000;
          // enhance=true lets Pollinations' own LLM rewrite/expand the prompt
          // (and handle Arabic), a big quality jump for weak/short descriptions.
          const url =
            `${host}/prompt/${encodeURIComponent(prompt)}` +
            `?width=${width}&height=${height}&model=${model}&seed=${seed}&enhance=true&nologo=true&safe=true`;
          const res = await fetch(url, { signal: controller.signal, headers: { accept: 'image/*' } });
          if (!res.ok) {
            const body = (await res.text().catch(() => '')).slice(0, 200);
            log.warn({ status: res.status, body, host }, 'pollinations image error');
            lastErr = `HTTP ${res.status}: ${body}`;
            if (res.status >= 400 && res.status < 500 && res.status !== 429) return setError(lastErr);
            continue; // 429/5xx → retry / next host
          }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 1024) {
            lastErr = 'أعادت صورة فارغة';
            continue;
          }
          return buf;
        } catch (err) {
          lastErr = errDetail(err);
          log.warn({ err, host }, 'pollinations request failed');
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return setError(`request failed: ${lastErr}`);
  }
}

/**
 * Hugging Face Inference API — free tier with a free token. Higher quality than
 * Pollinations when pointed at FLUX.1-dev. Set IMAGE_API_KEY to an HF token and
 * IMAGE_MODEL to a repo id (default black-forest-labs/FLUX.1-dev). Generate only.
 */
class HuggingFaceImageProvider implements ImageProvider {
  readonly name = 'huggingface';

  isConfigured(): boolean {
    return Boolean(env.IMAGE_API_KEY);
  }

  async edit(_image: Buffer, _prompt: string): Promise<Buffer | null> {
    return setError('huggingface: تعديل الصور غير مدعوم — استخدم التوليد فقط.');
  }

  async generate(prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const model = env.IMAGE_MODEL.includes('/') ? env.IMAGE_MODEL : 'black-forest-labs/FLUX.1-dev';
      const [w, h] = env.IMAGE_SIZE.split('x').map((n) => Number(n));
      // Current HF serverless endpoint — the old api-inference.huggingface.co
      // host is deprecated (its DNS no longer resolves → ENOTFOUND).
      const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.IMAGE_API_KEY}`,
          'content-type': 'application/json',
          accept: 'image/png',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { width: Number.isFinite(w) ? w : 1024, height: Number.isFinite(h) ? h : 1024 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 250);
        log.warn({ status: res.status, body }, 'huggingface image error');
        // 503 = model is loading; the caller can just retry shortly.
        if (res.status === 503) return setError('الموديل بيحمّل على Hugging Face، جرّب بعد ثواني.');
        return setError(`HTTP ${res.status}: ${body}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return setError('huggingface أعادت صورة فارغة، جرّب وصفاً آخر.');
      return buf;
    } catch (err) {
      log.warn({ err }, 'huggingface request failed');
      return setError(`request failed: ${errDetail(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Cloudflare Workers AI — reliable free tier (FLUX-1-schnell) on a rock-solid
 * domain (api.cloudflare.com), so it works where niche hosts fail DNS. Needs a
 * free account id + API token. Generate only.
 */
class CloudflareImageProvider implements ImageProvider {
  readonly name = 'cloudflare';

  isConfigured(): boolean {
    return Boolean(env.IMAGE_API_KEY && env.IMAGE_CF_ACCOUNT_ID);
  }

  async edit(_image: Buffer, _prompt: string): Promise<Buffer | null> {
    return setError('cloudflare: تعديل الصور غير مدعوم — استخدم التوليد فقط.');
  }

  async generate(prompt: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const model = env.IMAGE_MODEL.startsWith('@cf/') ? env.IMAGE_MODEL : '@cf/black-forest-labs/flux-1-schnell';
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGE_CF_ACCOUNT_ID}/ai/run/${model}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.IMAGE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, steps: 6 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 250);
        log.warn({ status: res.status, body }, 'cloudflare image error');
        return setError(`HTTP ${res.status}: ${body}`);
      }
      // flux-1-schnell returns JSON { result: { image: "<base64>" } }.
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        const data = (await res.json()) as { result?: { image?: string }; errors?: unknown };
        const b64 = data.result?.image;
        if (typeof b64 === 'string' && b64.length > 100) return Buffer.from(b64, 'base64');
        return setError(`cloudflare: لا صورة (${JSON.stringify(data.errors ?? '').slice(0, 150)})`);
      }
      // Other models may return raw image bytes.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return setError('cloudflare أعادت صورة فارغة.');
      return buf;
    } catch (err) {
      log.warn({ err }, 'cloudflare request failed');
      return setError(`request failed: ${errDetail(err)}`);
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
          : env.IMAGE_PROVIDER === 'huggingface'
            ? new HuggingFaceImageProvider()
            : env.IMAGE_PROVIDER === 'cloudflare'
              ? new CloudflareImageProvider()
              : new OpenAIImageProvider();
  }
  return provider;
}
