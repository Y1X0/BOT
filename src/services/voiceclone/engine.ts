import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('voiceclone:engine');

/**
 * HTTP client for the external voice engine (the Voise FastAPI Space). The model
 * is too heavy to run on this host, so synthesis happens on a separate CPU Space
 * and we call it over HTTPS with a shared secret header.
 *
 * The engine processes requests behind a single global lock (one at a time), so
 * we serialize our calls here too: concurrent users are queued, not fired in
 * parallel, which avoids pile-ups and timeouts on the slow CPU backend.
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

// ── Serial queue (the engine serializes anyway; mirror it to avoid contention) ──
let tail: Promise<unknown> = Promise.resolve();
let active = 0;
let waiting = 0;

/** How many jobs are running (0 or 1) + queued — for a "you're in line" hint. */
export function queueStatus(): { active: number; waiting: number } {
  return { active, waiting };
}

/** Run `job` only after every previously-enqueued job has settled. */
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
  // Keep the chain alive even if this job throws.
  tail = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** GET /health — quick reachability probe. Never throws. */
export async function engineHealth(): Promise<{ ok: boolean; detail?: string }> {
  if (!voiceCloneReady()) return { ok: false, detail: 'unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${base()}/health`, {
      headers: { 'X-Engine-Secret': env.VOICE_ENGINE_SECRET! },
      signal: controller.signal,
    });
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
  refName: string; // filename for the multipart part (extension matters)
  refText?: string; // optional transcript of the reference
  language?: string; // defaults to env.VOICE_ENGINE_LANG
}

/**
 * POST /tts — synthesize `text` in the reference voice. Returns the OGG/Opus
 * bytes the engine produced, or a typed error. Never throws. Serialized through
 * the shared queue.
 */
export function synthesizeVoice(opts: SynthOptions): Promise<EngineResult | { error: EngineError; detail?: string }> {
  if (!env.VOICECLONE_ENABLED) return Promise.resolve({ error: 'disabled' as const });
  if (!env.VOICE_ENGINE_URL || !env.VOICE_ENGINE_SECRET) return Promise.resolve({ error: 'unconfigured' as const });

  return enqueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.VOICE_ENGINE_TIMEOUT_SEC * 1000);
    try {
      const form = new FormData();
      form.append('text', opts.text);
      form.append('language', (opts.language || env.VOICE_ENGINE_LANG).trim());
      if (opts.refText) form.append('ref_text', opts.refText);
      form.append('ref', new Blob([new Uint8Array(opts.ref)]), opts.refName);

      const res = await fetch(`${base()}/tts`, {
        method: 'POST',
        headers: { 'X-Engine-Secret': env.VOICE_ENGINE_SECRET! },
        body: form,
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
        log.warn({ status: res.status }, 'engine /tts non-ok');
        return { error: 'http' as const, detail: `http ${res.status}: ${body}` };
      }

      const data = (await res.json()) as { audio_b64?: string; format?: string; seconds?: number };
      if (!data.audio_b64) return { error: 'empty' as const };
      const ogg = Buffer.from(data.audio_b64, 'base64');
      if (!ogg.length) return { error: 'empty' as const };
      return { ogg, format: data.format || 'ogg', seconds: Number(data.seconds) || 0 };
    } catch (err) {
      const msg = String(err);
      if (controller.signal.aborted || /abort/i.test(msg)) return { error: 'timeout' as const };
      log.warn({ err }, 'engine /tts failed');
      return { error: 'network' as const, detail: msg.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  });
}
