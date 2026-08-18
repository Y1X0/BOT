import { createLogger } from '../../core/logger';

const log = createLogger('image:vision');
const TIMEOUT_MS = 45_000;

/**
 * Describe an image as compact, comma-separated visual keywords using
 * Pollinations' free vision endpoint. Used for "poor man's img2img": we turn the
 * uploaded photo into a detailed description, merge it with the requested edit,
 * and regenerate — so the free text-to-image model keeps the subject's features
 * instead of relying on an unsupported image input. Returns null on any failure
 * (the caller then falls back to the edit instruction alone).
 */
export async function describeImage(image: Buffer): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const dataUri = `data:image/jpeg;base64,${image.toString('base64')}`;
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Describe this image for redrawing it. Give ONLY concise comma-separated visual keywords covering: main subject, facial features (face shape, eyes, hair, beard), clothing and colors, pose, background, lighting. No sentences, no preamble.',
              },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'vision describe failed');
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 3 ? text.slice(0, 600) : null;
  } catch (err) {
    log.warn({ err }, 'vision describe error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
