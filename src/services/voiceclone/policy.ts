import { createHash } from 'node:crypto';
import { isBotOwner } from '../../utils/permissions';

/**
 * Pure decision logic for the consent-gated voice-cloning feature. No database,
 * no network, no Telegram — just the rules. Kept separate so every gate (who may
 * approve, when generation is allowed, what references are acceptable, how output
 * is labeled) is independently unit-testable and impossible to silently bypass.
 */

export type ConsentStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** At least one reference clip, and enough total audio for the clone to work. */
export const MIN_REF_CLIPS = 1;
export const MIN_REF_SECONDS = 6;
/** The engine trims a single reference to ~15s; collecting a bit more is fine. */
export const MAX_REF_SECONDS = 60;
/** Engine MAX_TEXT — longer prompts are rejected upstream, so cap here first. */
export const MAX_TEXT_CHARS = 400;
/** Reasonable ceiling on reference clips kept per request. */
export const MAX_REF_CLIPS = 10;

/** Container/MIME types we accept as a voice reference. */
export function isSupportedRef(mime?: string, name?: string): boolean {
  const n = (name ?? '').toLowerCase();
  if (/\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm|mp4)$/.test(n)) return true;
  const m = (mime ?? '').toLowerCase();
  if (/^audio\//.test(m)) return true;
  return /ogg|opus|mpeg|mp4|wav|x-wav|flac|aac|webm/.test(m);
}

export type RefError = 'noclips' | 'tooshort';

/** Are the collected references sufficient to submit a request? */
export function validateReferences(
  count: number,
  totalSeconds: number,
): { ok: true } | { ok: false; error: RefError } {
  if (count < MIN_REF_CLIPS) return { ok: false, error: 'noclips' };
  // Telegram reports a duration for voice/audio; when it's known, enforce a floor.
  if (totalSeconds > 0 && totalSeconds < MIN_REF_SECONDS) return { ok: false, error: 'tooshort' };
  return { ok: true };
}

export type TextError = 'empty' | 'toolong';

/** Validate (and trim) the text to be spoken. */
export function validateText(text: string): { ok: true; text: string } | { ok: false; error: TextError } {
  const clean = (text ?? '').trim();
  if (!clean) return { ok: false, error: 'empty' };
  if (clean.length > MAX_TEXT_CHARS) return { ok: false, error: 'toolong' };
  return { ok: true, text: clean };
}

/**
 * Who may approve or reject a pending consent request — ONLY a global bot owner.
 * This gate is deliberately the single source of truth; the plugin must route
 * every approval through it so an ordinary user can never self-approve.
 */
export function canApprove(approverId: number | bigint): boolean {
  return isBotOwner(approverId);
}

export type GenerateDenial = 'pending' | 'rejected' | 'revoked' | 'notrequester' | 'unknown';

/**
 * May `userId` synthesize speech from this consent record right now?
 * Allowed only when the record is APPROVED and the caller is its requester (or a
 * bot owner, who can always exercise a consent they approved). Anything not
 * explicitly approved is denied.
 */
export function canGenerate(
  rec: { status: string; requesterId: bigint },
  userId: number | bigint,
): { ok: true } | { ok: false; reason: GenerateDenial } {
  switch (rec.status) {
    case 'approved':
      break;
    case 'pending':
      return { ok: false, reason: 'pending' };
    case 'rejected':
      return { ok: false, reason: 'rejected' };
    case 'revoked':
      return { ok: false, reason: 'revoked' };
    default:
      return { ok: false, reason: 'unknown' };
  }
  const uid = BigInt(userId);
  if (rec.requesterId === uid || isBotOwner(uid)) return { ok: true };
  return { ok: false, reason: 'notrequester' };
}

/** Who may revoke an approved consent: the original requester, or a bot owner. */
export function canRevoke(
  rec: { requesterId: bigint; revocable: boolean },
  userId: number | bigint,
): boolean {
  const uid = BigInt(userId);
  if (isBotOwner(uid)) return true;
  return rec.revocable && rec.requesterId === uid;
}

/** Tamper-evidence hash of the consent declaration + its key metadata. */
export function consentHash(parts: {
  requesterId: number | bigint;
  voiceOwner: string;
  scope: string;
  declaration: string;
}): string {
  const h = createHash('sha256');
  h.update(`${parts.requesterId}\n${parts.voiceOwner}\n${parts.scope}\n${parts.declaration}`);
  return h.digest('hex');
}

const sanitize = (s: string): string => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').slice(0, 40) || 'voice';

/**
 * Filename for a synthesized clip. Always carries the SYNTHETIC_ prefix so the
 * output is self-labeling even once it leaves Telegram. Mirrors the engine's
 * own naming (SYNTHETIC_<owner>_<ts>_<n>).
 */
export function syntheticFilename(voiceOwner: string, seq: number): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `SYNTHETIC_${sanitize(voiceOwner)}_${ts}_${seq}.ogg`;
}

/**
 * The caption sent with every generated clip. Non-optional disclosure that the
 * audio is AI-generated — this is the core harm-mitigation and must never be
 * dropped or made toggleable.
 */
export function syntheticCaption(voiceOwner: string, seconds?: number): string {
  const dur = seconds && seconds > 0 ? ` · ${seconds.toFixed(1)}s` : '';
  return (
    '🔊 صوت مُولّد بالذكاء الاصطناعي (AI) — ليس تسجيلاً حقيقياً.\n' +
    `🎙 مُقلّد لصوت: ${voiceOwner}${dur}\n` +
    '⚠️ استُخدم بموافقة موثّقة. يُمنع استخدامه للتضليل أو انتحال الهوية.'
  );
}
