import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('voiceclone:engine');

/**
 * HTTP client for the external voice engine (a Gradio Space on Hugging Face,
 * free CPU). Docker Spaces require a paid plan, so the engine runs as a Gradio
 * app and we call its REST API:
 *
 *   POST {url}/gradio_api/call/predict   {data:[text, ref_b64, ref_text, lang, secret]}  -> {event_id}
 *   GET  {url}/gradio_api/call/predict/{event_id}  (SSE) -> data: ["<json string>"]
 *
 * The inner JSON string is {audio_b64, format, seconds}. The reference audio is
 * passed base64-encoded (no multipart upload step). Every call carries the
 * shared secret as the last argument; the Space refuses calls without it.
 *
 * Synthesis on CPU is slow, so calls are serialized through a queue (one job at
 * a time) to avoid piling work onto the single free Space.
 */

export type EngineError = 'disabled' | 'unconfigured' | 'timeout' | 'http' | 'empty' | 'network';
export interface EngineResult {
  ogg: Buffer;
  format: string;
  seconds: number;
}

/** True when voice cloning is switched on AND the engine endpoint is configured. */
export function voiceCloneReady(): boolean {
  return env.VOICECLONE_ENABLED && !!env.VOICE_ENGINE_URL && !!env.VOICE_ENGINE_SECRET;
}

const base = (): string => (env.VOICE_ENGINE_URL || '').replace(/\/+$/, '');

// ── Serial queue (CPU Space handles one job at a time) ──
let tail: Promise<unknown> = Promise.resolve();
let active = 0;
let waiting = 0;

/** How many jobs are running (0 or 1) + queued — for a "you're in line" hint. */
export function queueStatus(): { active: number; waiting: number } {
  return { active, waiting };
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  waiting++;
  const run = async (): Promise<T> => {
    waiting--;
    active++;
    try {
      return await job();
    } finally {
      active--;
    }
  };
  const p = tail.then(run, run);
  tail = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * Parse Gradio's SSE response body. It emits a sequence of `event:`/`data:`
 * pairs; the final useful payload is the `data:` of the `complete` event (a JSON
 * array), and a `error` event means the call failed.
 */
function parseGradioSSE(raw: string): { data?: string; error?: string } {
  let curEvent = '';
  let lastData: string | null = null;
  let errored = false;
  let errDetail = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      curEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const d = line.slice(5).trim();
      if (curEvent === 'error') {
        errored = true;
        errDetail = d;
      } else {
        lastData = d;
      }
    }
  }
  if (errored) return { error: errDetail || 'engine error' };
  if (lastData == null) return { error: 'no data in engine response' };
  try {
    const arr = JSON.parse(lastData);
    if (Array.isArray(arr) && typeof arr[0] === 'string') return { data: arr[0] };
    return { error: 'unexpected engine payload' };
  } catch {
    return { error: 'bad engine payload' };
  }
}

/** GET /gradio_api/config — quick reachability probe. Never throws. */
export async function engineHealth(): Promise<{ ok: boolean; detail?: string }> {
  if (!voiceCloneReady()) return { ok: false, detail: 'unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${base()}/gradio_api/config`, { signal: controller.signal });
    return { ok: res.ok, detail: res.ok ? undefined : `http ${res.status}` };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export interface SynthOptions {
  text: string;
  ref: Buffer; // reference audio bytes (the voice to imitate)
  refName?: string; // unused by the Gradio API (kept for call-site compatibility)
  refText?: string; // optional transcript of the reference
  language?: string; // defaults to env.VOICE_ENGINE_LANG
}

/**
 * Synthesize `text` in the reference voice via the Gradio Space. Returns the
 * OGG/Opus bytes, or a typed error. Never throws. Serialized through the queue.
 */
export function synthesizeVoice(opts: SynthOptions): Promise<EngineResult | { error: EngineError; detail?: string }> {
  if (!env.VOICECLONE_ENABLED) return Promise.resolve({ error: 'disabled' as const });
  if (!env.VOICE_ENGINE_URL || !env.VOICE_ENGINE_SECRET) return Promise.resolve({ error: 'unconfigured' as const });

  return enqueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.VOICE_ENGINE_TIMEOUT_SEC * 1000);
    try {
      const refB64 = opts.ref.toString('base64');
      const payload = {
        data: [opts.text, refB64, opts.refText || '', (opts.language || env.VOICE_ENGINE_LANG).trim(), env.VOICE_ENGINE_SECRET],
      };

      const post = await fetch(`${base()}/gradio_api/call/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!post.ok) {
        const body = (await post.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
        return { error: 'http' as const, detail: `post http ${post.status}: ${body}` };
      }
      const started = (await post.json().catch(() => ({}))) as { event_id?: string };
      if (!started.event_id) return { error: 'http' as const, detail: 'no event_id' };

      const get = await fetch(`${base()}/gradio_api/call/predict/${started.event_id}`, { signal: controller.signal });
      if (!get.ok) return { error: 'http' as const, detail: `get http ${get.status}` };
      const raw = await get.text();

      const parsed = parseGradioSSE(raw);
      if (parsed.error || !parsed.data) {
        log.warn({ detail: parsed.error }, 'engine returned an error event');
        return { error: 'http' as const, detail: (parsed.error || 'no data').slice(0, 180) };
      }

      let inner: { audio_b64?: string; format?: string; seconds?: number };
      try {
        inner = JSON.parse(parsed.data);
      } catch {
        return { error: 'http' as const, detail: 'bad inner payload' };
      }
      if (!inner.audio_b64) return { error: 'empty' as const };
      const ogg = Buffer.from(inner.audio_b64, 'base64');
      if (!ogg.length) return { error: 'empty' as const };
      return { ogg, format: inner.format || 'ogg', seconds: Number(inner.seconds) || 0 };
    } catch (err) {
      const msg = String(err);
      if (controller.signal.aborted || /abort/i.test(msg)) return { error: 'timeout' as const };
      log.warn({ err }, 'engine call failed');
      return { error: 'network' as const, detail: msg.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  });
}
