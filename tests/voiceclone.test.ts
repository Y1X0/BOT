import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSupportedRef,
  validateReferences,
  validateText,
  canApprove,
  canGenerate,
  canRevoke,
  consentHash,
  syntheticFilename,
  syntheticCaption,
  MAX_TEXT_CHARS,
  MIN_REF_SECONDS,
} from '../src/services/voiceclone/policy';

// OWNER_IDS is "111,222" from tests/setup.ts.
const OWNER = 111n;
const OTHER = 999n;

describe('voiceclone policy — references & text', () => {
  it('accepts common audio containers, rejects others', () => {
    expect(isSupportedRef('audio/ogg', 'voice.ogg')).toBe(true);
    expect(isSupportedRef(undefined, 'clip.mp3')).toBe(true);
    expect(isSupportedRef('audio/x-wav', 'rec.wav')).toBe(true);
    expect(isSupportedRef('application/pdf', 'doc.pdf')).toBe(false);
    expect(isSupportedRef(undefined, 'photo.jpg')).toBe(false);
  });

  it('requires at least one clip (insufficient recordings)', () => {
    expect(validateReferences(0, 0)).toEqual({ ok: false, error: 'noclips' });
    expect(validateReferences(1, 0)).toEqual({ ok: true }); // unknown duration passes
    expect(validateReferences(2, 20)).toEqual({ ok: true });
  });

  it('rejects references that are too short when duration is known', () => {
    expect(validateReferences(1, MIN_REF_SECONDS - 1)).toEqual({ ok: false, error: 'tooshort' });
    expect(validateReferences(1, MIN_REF_SECONDS)).toEqual({ ok: true });
  });

  it('validates & trims the text, enforcing the length cap', () => {
    expect(validateText('   ')).toEqual({ ok: false, error: 'empty' });
    expect(validateText('  hi  ')).toEqual({ ok: true, text: 'hi' });
    expect(validateText('x'.repeat(MAX_TEXT_CHARS + 1))).toEqual({ ok: false, error: 'toolong' });
  });
});

describe('voiceclone policy — authorization gates', () => {
  it('only a bot owner may approve (unauthorized approver denied)', () => {
    expect(canApprove(OWNER)).toBe(true);
    expect(canApprove(222)).toBe(true);
    expect(canApprove(OTHER)).toBe(false);
  });

  it('generation allowed only when approved AND caller is requester (or owner)', () => {
    const rec = { status: 'approved', requesterId: OTHER };
    expect(canGenerate(rec, OTHER)).toEqual({ ok: true });
    expect(canGenerate(rec, OWNER)).toEqual({ ok: true }); // owner can always use what they approved
    expect(canGenerate(rec, 555n)).toEqual({ ok: false, reason: 'notrequester' });
  });

  it('blocks generation for pending / rejected / revoked consent', () => {
    expect(canGenerate({ status: 'pending', requesterId: OTHER }, OTHER)).toEqual({ ok: false, reason: 'pending' });
    expect(canGenerate({ status: 'rejected', requesterId: OTHER }, OTHER)).toEqual({ ok: false, reason: 'rejected' });
    expect(canGenerate({ status: 'revoked', requesterId: OTHER }, OTHER)).toEqual({ ok: false, reason: 'revoked' });
    expect(canGenerate({ status: 'weird', requesterId: OTHER }, OTHER)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('revocation: owner always, requester only when revocable', () => {
    expect(canRevoke({ requesterId: OTHER, revocable: true }, OTHER)).toBe(true);
    expect(canRevoke({ requesterId: OTHER, revocable: false }, OTHER)).toBe(false);
    expect(canRevoke({ requesterId: OTHER, revocable: false }, OWNER)).toBe(true); // owner override
    expect(canRevoke({ requesterId: OTHER, revocable: true }, 555n)).toBe(false); // stranger
  });
});

describe('voiceclone policy — labeling & hashing', () => {
  it('consent hash is deterministic and sensitive to every field', () => {
    const base = { requesterId: OTHER, voiceOwner: 'Alice', scope: 'audiobook', declaration: 'I consent' };
    const h = consentHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(consentHash(base)).toBe(h); // deterministic
    expect(consentHash({ ...base, scope: 'other' })).not.toBe(h);
    expect(consentHash({ ...base, declaration: 'I do NOT consent' })).not.toBe(h);
  });

  it('every output is self-labeling as synthetic', () => {
    const name = syntheticFilename('Alice Smith', 3);
    expect(name.startsWith('SYNTHETIC_')).toBe(true);
    expect(name.endsWith('.ogg')).toBe(true);
    const cap = syntheticCaption('Alice', 2.5);
    expect(cap).toMatch(/AI|الذكاء الاصطناعي/);
    expect(cap).toContain('Alice');
  });
});

// ── Engine client (Gradio API; env toggled per-test via dynamic import) ──────

const B64 = (s: string): string => Buffer.from(s).toString('base64');
const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
/** A Gradio SSE "complete" response carrying one JSON string in the data array. */
const sseComplete = (inner: unknown) =>
  ({ ok: true, status: 200, text: async () => `event: complete\ndata: ${JSON.stringify([JSON.stringify(inner)])}\n\n` }) as unknown as Response;
const sseError = (msg: string) =>
  ({ ok: true, status: 200, text: async () => `event: error\ndata: ${JSON.stringify(msg)}\n\n` }) as unknown as Response;

const isPost = (opts?: { method?: string }): boolean => opts?.method === 'POST';

const ENGINE_KEYS = ['VOICECLONE_ENABLED', 'VOICE_ENGINE_URL', 'VOICE_ENGINE_SECRET', 'VOICE_ENGINE_TIMEOUT_SEC', 'VOICE_ENGINE_LANG'];

async function loadEngine(overrides: Record<string, string>) {
  vi.resetModules();
  for (const k of ENGINE_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  return import('../src/services/voiceclone/engine');
}

const CONFIGURED = {
  VOICECLONE_ENABLED: 'true',
  VOICE_ENGINE_URL: 'https://engine.test/',
  VOICE_ENGINE_SECRET: 'sekret',
  VOICE_ENGINE_TIMEOUT_SEC: '0.3',
};

const sampleOpts = () => ({ text: 'hello', ref: Buffer.from('refbytes'), refName: 'ref.ogg' });

describe('voiceclone engine — gating & results', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('is disabled when the flag is off', async () => {
    const eng = await loadEngine({});
    expect(eng.voiceCloneReady()).toBe(false);
    expect(await eng.synthesizeVoice(sampleOpts())).toEqual({ error: 'disabled' });
  });

  it('is unconfigured when enabled but URL/secret missing (engine not ready)', async () => {
    const eng = await loadEngine({ VOICECLONE_ENABLED: 'true' });
    expect(eng.voiceCloneReady()).toBe(false);
    expect(await eng.synthesizeVoice(sampleOpts())).toEqual({ error: 'unconfigured' });
  });

  it('returns decoded OGG bytes on success, passing the secret as the last arg', async () => {
    const eng = await loadEngine(CONFIGURED);
    expect(eng.voiceCloneReady()).toBe(true);
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) =>
      isPost(opts) ? okJson({ event_id: 'e1' }) : sseComplete({ audio_b64: B64('OGGDATA'), format: 'ogg/opus', seconds: 1.4 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await eng.synthesizeVoice(sampleOpts());
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.ogg.toString()).toBe('OGGDATA');
      expect(res.seconds).toBe(1.4);
    }
    // The POST body carries the secret as data[4], and the ref as base64 data[1].
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string })?.method === 'POST')!;
    const body = JSON.parse((postCall[1] as { body: string }).body) as { data: string[] };
    expect(body.data[1]).toBe(Buffer.from('refbytes').toString('base64'));
    expect(body.data[4]).toBe('sekret');
    // Two-step: POST to start, GET to collect.
    expect((fetchMock.mock.calls[0][0] as string)).toContain('/gradio_api/call/predict');
    expect((fetchMock.mock.calls[1][0] as string)).toContain('/gradio_api/call/predict/e1');
  });

  it('maps a non-ok POST to an http error', async () => {
    const eng = await loadEngine(CONFIGURED);
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'busy' }) as unknown as Response) as unknown as typeof fetch;
    expect(await eng.synthesizeVoice(sampleOpts())).toMatchObject({ error: 'http' });
  });

  it('maps a Gradio error event to an http error', async () => {
    const eng = await loadEngine(CONFIGURED);
    global.fetch = vi.fn(async (_url: string, opts?: { method?: string }) =>
      isPost(opts) ? okJson({ event_id: 'e1' }) : sseError('bad secret'),
    ) as unknown as typeof fetch;
    expect(await eng.synthesizeVoice(sampleOpts())).toMatchObject({ error: 'http' });
  });

  it('maps an empty audio payload to an empty error', async () => {
    const eng = await loadEngine(CONFIGURED);
    global.fetch = vi.fn(async (_url: string, opts?: { method?: string }) =>
      isPost(opts) ? okJson({ event_id: 'e1' }) : sseComplete({ audio_b64: '', seconds: 0 }),
    ) as unknown as typeof fetch;
    expect(await eng.synthesizeVoice(sampleOpts())).toEqual({ error: 'empty' });
  });

  it('maps an aborted/slow request to a timeout error', async () => {
    const eng = await loadEngine(CONFIGURED);
    global.fetch = vi.fn((_url: string, opts?: { method?: string; signal?: AbortSignal }) => {
      if (isPost(opts)) return Promise.resolve(okJson({ event_id: 'e1' }));
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    expect(await eng.synthesizeVoice(sampleOpts())).toEqual({ error: 'timeout' });
  });

  it('serializes concurrent calls (never two jobs in flight at once)', async () => {
    const eng = await loadEngine({ ...CONFIGURED, VOICE_ENGINE_TIMEOUT_SEC: '5' });
    let active = 0;
    let maxActive = 0;
    global.fetch = vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (isPost(opts)) {
        active++;
        maxActive = Math.max(maxActive, active);
        return okJson({ event_id: 'e1' });
      }
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return sseComplete({ audio_b64: B64('x'), seconds: 1 });
    }) as unknown as typeof fetch;
    await Promise.all([eng.synthesizeVoice(sampleOpts()), eng.synthesizeVoice(sampleOpts()), eng.synthesizeVoice(sampleOpts())]);
    expect(maxActive).toBe(1);
  });
});
