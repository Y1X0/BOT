import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('tts');

export type TtsError = 'disabled' | 'empty' | 'toolong' | 'nokey' | 'api';
export interface TtsResult {
  buffer: Buffer;
  ext: 'mp3';
}

/** True when text-to-speech is configured and usable. */
export function ttsReady(): boolean {
  if (!env.TTS_ENABLED) return false;
  if (env.TTS_PROVIDER === 'elevenlabs') return !!env.TTS_API_KEY;
  return true; // edge needs no key
}

/** Microsoft Edge neural voices — free, no key. The library handles the
 *  Sec-MS-GEC token, so it works on normal internet. */
async function edgeTts(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge tts timeout')), 60_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    audioStream.on('data', (c: Buffer) => chunks.push(c));
    audioStream.on('end', done);
    audioStream.on('close', () => chunks.length && done());
    audioStream.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  try {
    (tts as { close?: () => void }).close?.();
  } catch {
    /* ignore */
  }
  return Buffer.concat(chunks);
}

/** ElevenLabs — premium quality, needs an API key. */
async function elevenTts(text: string, voiceId: string, key: string, model: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthesize `text` to an MP3 voice-over. Uses the configured provider (Edge
 * neural by default — free), returns the audio bytes. Never throws.
 */
export async function synthesize(
  text: string,
  voiceOverride?: string,
): Promise<TtsResult | { error: TtsError; detail?: string }> {
  if (!env.TTS_ENABLED) return { error: 'disabled' };
  const clean = text.trim();
  if (!clean) return { error: 'empty' };
  if (clean.length > env.TTS_MAX_CHARS) return { error: 'toolong' };

  try {
    let buffer: Buffer;
    if (env.TTS_PROVIDER === 'elevenlabs') {
      if (!env.TTS_API_KEY) return { error: 'nokey' };
      buffer = await elevenTts(clean, voiceOverride || env.TTS_VOICE, env.TTS_API_KEY, env.TTS_MODEL);
    } else {
      buffer = await edgeTts(clean, voiceOverride || env.TTS_VOICE);
    }
    if (!buffer.length) return { error: 'api' };
    return { buffer, ext: 'mp3' };
  } catch (err) {
    log.warn({ err }, 'tts synthesis failed');
    return { error: 'api', detail: String(err).slice(0, 120) };
  }
}
