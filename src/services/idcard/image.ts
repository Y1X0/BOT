import { renderCardPng, renderCardMp4, renderOwnerCardPng, renderOwnerCardMp4, getLastMp4Error } from './canvas';

// Last video-render failure reason, surfaced by the /idcardtest diagnostic.
export function getLastVideoError(): string {
  return getLastMp4Error();
}

export interface IdCardImageData {
  name: string;
  username: string;
  id: string;
  rank: string;
  stats: string;
  title: string;
  level: string;
  xp: string;
  messages: string;
  interaction: string;
  joined: string;
  avatarDataUri?: string; // base64 profile photo, if available
  initial: string; // fallback avatar letter
}

/** Data for the group-owner card (a grander variant of the id card). */
export interface OwnerCardData {
  name: string;
  username: string; // @handle or a placeholder
  id: string;
  members: string; // member count, formatted
  date: string; // creation or join date
  dateLabel: string; // e.g. 'تاريخ الإنشاء' / 'تاريخ الانضمام'
  avatarDataUri?: string;
  initial: string;
}

/** A color theme for the card. */
export interface CardTheme {
  id: string;
  label: string;
  a: string; // accent
  a2: string; // accent light
  bg1: string; // tint gradient top (rgba)
  bg2: string; // tint gradient bottom (rgba)
  ph1: string; // placeholder-avatar gradient
  ph2: string;
  top: string; // header decoration
  foot: string; // footer label
}

export const CARD_THEMES: CardTheme[] = [
  { id: 'gold', label: '👑 ذهبي', a: '#e8c86a', a2: '#f6e3a6', bg1: 'rgba(20,14,40,.86)', bg2: 'rgba(8,8,16,.94)', ph1: '#2a2350', ph2: '#15131f', top: '👑 ✦ 👑', foot: 'V I P' },
  { id: 'neon', label: '💎 نيون', a: '#37e0ff', a2: '#a8f6ff', bg1: 'rgba(6,20,34,.88)', bg2: 'rgba(4,6,16,.95)', ph1: '#10314a', ph2: '#0a1420', top: '⟨ ✦ ⟩', foot: 'C Y B E R' },
  { id: 'emerald', label: '🌿 زمرّد', a: '#4be39a', a2: '#bff5cf', bg1: 'rgba(8,34,24,.88)', bg2: 'rgba(4,14,10,.95)', ph1: '#123f2d', ph2: '#0a1a12', top: '❦ ✦ ❦', foot: 'E L I T E' },
  { id: 'sunset', label: '🌅 غروب', a: '#ff8a5c', a2: '#ffd08a', bg1: 'rgba(42,16,28,.88)', bg2: 'rgba(16,8,14,.95)', ph1: '#3a1626', ph2: '#180a12', top: '☀ ✦ ☀', foot: 'S T A R' },
  { id: 'ocean', label: '🌊 محيط', a: '#5aa9ff', a2: '#b8dbff', bg1: 'rgba(10,24,46,.88)', bg2: 'rgba(5,10,22,.95)', ph1: '#123256', ph2: '#0a1526', top: '≈ ✦ ≈', foot: 'P R O' },
  { id: 'rose', label: '🌸 وردي', a: '#ff7ab0', a2: '#ffc2dd', bg1: 'rgba(42,14,30,.88)', bg2: 'rgba(18,8,14,.95)', ph1: '#3a1428', ph2: '#180a12', top: '✿ ✦ ✿', foot: 'V I P' },
  { id: 'mono', label: '⚪ فضّي', a: '#d9d9e0', a2: '#ffffff', bg1: 'rgba(28,28,36,.9)', bg2: 'rgba(10,10,14,.96)', ph1: '#2a2a34', ph2: '#131318', top: '◆ ✦ ◆', foot: 'M E M B E R' },
];

export const CARD_THEME_IDS = CARD_THEMES.map((t) => t.id);

/** djb2-ish hash so a given id maps to a stable theme. */
function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Resolve which theme to use. mode: 'auto' → a stable per-user theme (each
 * member gets a different look, so the group sees variety); 'random' → a
 * different one each time; a specific theme id → that theme; else default.
 */
export function resolveCardTheme(mode: string | null | undefined, userId: string, roll: number): string {
  const m = mode || 'auto';
  if (m === 'random') return CARD_THEME_IDS[roll % CARD_THEME_IDS.length];
  if (m === 'auto') return CARD_THEME_IDS[hashId(userId) % CARD_THEME_IDS.length];
  return CARD_THEME_IDS.includes(m) ? m : CARD_THEME_IDS[0];
}

/**
 * Render the static profile card to a JPEG. Uses @napi-rs/canvas (pure CPU, no
 * browser) — an order of magnitude faster and far lighter than Chromium.
 */
export async function renderIdCardImage(d: IdCardImageData, themeId?: string): Promise<Buffer> {
  const theme = CARD_THEMES.find((x) => x.id === themeId) ?? CARD_THEMES[0];
  return renderCardPng(d, theme);
}

/**
 * Render the ANIMATED premium card (gold shine sweep) as a short looping MP4.
 * Frames are drawn on CPU with canvas and piped to ffmpeg — no browser, no
 * screen recording. Returns null on any failure (caller falls back to image).
 */
export async function renderIdCardVideo(d: IdCardImageData, themeId?: string): Promise<{ buffer: Buffer; ext: string } | null> {
  const theme = CARD_THEMES.find((x) => x.id === themeId) ?? CARD_THEMES[0];
  return renderCardMp4(d, theme);
}

/** Render the group-owner card (gold-on-black luxury) to a JPEG. */
export async function renderOwnerCardImage(d: OwnerCardData): Promise<Buffer> {
  return renderOwnerCardPng(d);
}

/** Render the ANIMATED group-owner card (gold shine sweep) as a looping MP4. */
export async function renderOwnerCardVideo(d: OwnerCardData): Promise<{ buffer: Buffer; ext: string } | null> {
  return renderOwnerCardMp4(d);
}
