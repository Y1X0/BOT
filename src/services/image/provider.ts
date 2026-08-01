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
        log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'image api error');
        return null;
      }
      const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const item = data.data?.[0];
      if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
      if (item?.url) {
        const img = await fetch(item.url);
        return img.ok ? Buffer.from(await img.arrayBuffer()) : null;
      }
      return null;
    } catch (err) {
      log.warn({ err }, 'image request failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

let provider: ImageProvider | null = null;
export function getImageProvider(): ImageProvider {
  if (!provider) {
    // Add new providers here; selected via IMAGE_PROVIDER.
    provider = new OpenAIImageProvider();
  }
  return provider;
}
