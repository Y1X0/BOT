import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('tts');

export type TtsError = 'disabled' | 'empty' | 'toolong' | 'nokey' | 'api' | 'notspeech';
export interface TtsResult {
  buffer: Buffer;
  ext: 'mp3';
}

/** True when text-to-speech is configured and usable. */
export function ttsReady(): boolean {
  if (!env.TTS_ENABLED) return false;
  if (env.TTS_PROVIDER === 'elevenlabs' || env.TTS_PROVIDER === 'gemini') return !!env.TTS_API_KEY;
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

/** Wrap raw signed-16-bit little-endian mono PCM into an MP3 via ffmpeg (needed
 *  for Gemini, which returns PCM — Telegram only accepts mp3/m4a as audio). */
function pcmToMp3(pcm: Buffer, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '160k', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const out: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.write(pcm);
    p.stdin.end();
  });
}

/** Google Gemini TTS — natural quality, generous free tier (Google AI Studio
 *  key, no card). Returns base64 PCM, which we transcode to MP3. */
async function geminiTts(text: string, voice: string, key: string, model: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`gemini ${res.status}: ${body}`);
  }
  const data = (await res.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  const cand = data.candidates?.[0];
  const part = cand?.content?.parts?.find((p) => p?.inlineData?.data);
  const b64 = part?.inlineData?.data;
  if (!b64) {
    const reason = data.promptFeedback?.blockReason || cand?.finishReason || 'empty';
    // MAX_TOKENS / low free-tier TTS daily cap is the usual cause of "no audio".
    throw new Error(`gemini no audio (${reason})`);
  }
  const rate = Number((part!.inlineData!.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
  return pcmToMp3(Buffer.from(b64, 'base64'), rate);
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
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`elevenlabs ${res.status}: ${body}`);
  }
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
    const voice = (voiceOverride || env.TTS_VOICE).trim();
    // Trim the key — a stray space/newline from a mobile paste yields a 401.
    const key = (env.TTS_API_KEY || '').trim();
    if (env.TTS_PROVIDER === 'elevenlabs') {
      if (!key) return { error: 'nokey' };
      buffer = await elevenTts(clean, voice, key, env.TTS_MODEL.trim());
    } else if (env.TTS_PROVIDER === 'gemini') {
      if (!key) return { error: 'nokey' };
      buffer = await geminiTts(clean, voice, key, env.TTS_MODEL.trim());
    } else {
      buffer = await edgeTts(clean, voice);
    }
    if (!buffer.length) return { error: 'api' };
    return { buffer, ext: 'mp3' };
  } catch (err) {
    const msg = String(err);
    log.warn({ err }, 'tts synthesis failed');
    // Gemini rejects greetings/questions/short prompts (it tries to "answer"
    // them instead of reading them) — surface a clear, friendly hint instead.
    if (/should only be used for TTS|tried to generate text/i.test(msg)) return { error: 'notspeech' };
    return { error: 'api', detail: msg.slice(0, 160) };
  }
}
