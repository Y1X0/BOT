import type { ChatSettings } from '@prisma/client';
import { prisma } from '../core/database';
import { env } from '../config/env';
import type { Locale } from '../locales';
import { isSupportedLocale } from '../locales';

/**
 * Ensure a Chat + ChatSettings row exists, then return the settings.
 * Idempotent — safe to call on every group message.
 */
// Chats we've already bootstrapped this process — lets the hot path skip the
// upsert (a DB WRITE that otherwise ran on every single group message just to
// keep the title fresh). We still read settings fresh below, so config changes
// apply instantly; only the cosmetic title write is throttled.
const bootstrapped = new Map<string, number>();
const BOOTSTRAP_TTL_MS = 600_000; // re-sync title at most every 10 min

export async function ensureChat(
  chatId: number | bigint,
  title?: string,
  type?: string,
): Promise<ChatSettings> {
  const id = BigInt(chatId);
  const key = id.toString();
  const seen = bootstrapped.get(key);
  const fresh = seen !== undefined && Date.now() - seen < BOOTSTRAP_TTL_MS;

  if (fresh) {
    // Chat known — skip the write, just read the (possibly changed) settings.
    const s = await prisma.chatSettings.findUnique({ where: { chatId: id } });
    if (s) return s;
    bootstrapped.delete(key); // settings row vanished → fall through to re-create
  }

  await prisma.chat.upsert({
    where: { id },
    create: {
      id,
      title: title ?? null,
      type: type ?? 'group',
      language: env.DEFAULT_LANGUAGE,
      settings: { create: {} },
    },
    update: { title: title ?? undefined },
  });

  const settings = await prisma.chatSettings.findUnique({ where: { chatId: id } });
  bootstrapped.set(key, Date.now());
  if (settings) return settings;

  // Race-safe fallback if settings row was missing.
  return prisma.chatSettings.create({ data: { chatId: id } });
}

export async function getSettings(chatId: number | bigint): Promise<ChatSettings | null> {
  return prisma.chatSettings.findUnique({ where: { chatId: BigInt(chatId) } });
}

// Locale changes maybe once in a chat's lifetime, but getLocale ran on every
// message — cache it so the hot path makes no DB read for language.
const localeCache = new Map<string, Locale>();

export async function getLocale(chatId: number | bigint): Promise<Locale> {
  const key = BigInt(chatId).toString();
  const cached = localeCache.get(key);
  if (cached) return cached;
  const chat = await prisma.chat.findUnique({ where: { id: BigInt(chatId) } });
  const locale = chat && isSupportedLocale(chat.language) ? chat.language : env.DEFAULT_LANGUAGE;
  localeCache.set(key, locale);
  return locale;
}

export async function setLocale(chatId: number | bigint, locale: Locale): Promise<void> {
  await prisma.chat.update({ where: { id: BigInt(chatId) }, data: { language: locale } });
  localeCache.set(BigInt(chatId).toString(), locale);
}

/** Boolean settings that /setting can toggle. */
export const TOGGLEABLE_SETTINGS = [
  'welcomeEnabled',
  'farewellEnabled',
  'captchaEnabled',
  'antispamEnabled',
  'floodEnabled',
  'antiLinkEnabled',
  'antiForwardEnabled',
  'filtersEnabled',
  'badwordsEnabled',
  'repliesEnabled',
  'reactionsEnabled',
  'gamesEnabled',
  'economyEnabled',
  'xpEnabled',
  'musicBlocked',
  'aiEnabled',
  'cleanServiceEnabled',
  'moderationEnabled',
  'antiRaidEnabled',
  'weeklyReportEnabled',
  'qotdEnabled',
  'athkarEnabled',
  'dailyAyahEnabled',
  'prayerNotifyEnabled',
] as const;

export type ToggleableSetting = (typeof TOGGLEABLE_SETTINGS)[number];

export function isToggleable(key: string): key is ToggleableSetting {
  return (TOGGLEABLE_SETTINGS as readonly string[]).includes(key);
}

export async function setBoolean(
  chatId: number | bigint,
  key: ToggleableSetting,
  value: boolean,
): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: { [key]: value },
  });
}

export async function setRules(chatId: number | bigint, rules: string): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: { rules },
  });
}

/** Toggle whether the id card renders as a designed image (true) or text. */
export async function setIdCardImage(chatId: number | bigint, enabled: boolean): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: { idCardImage: enabled },
  });
}

/** Set the id-card color theme mode (auto | random | <theme id>). */
export async function setIdCardTheme(chatId: number | bigint, theme: string): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: { idCardTheme: theme },
  });
}

/** Store (or clear, when json is null) custom voice-chat card emojis. */
export async function setVcCardEmoji(chatId: number | bigint, json: string | null): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: { vcCardEmoji: json },
  });
}

/** Store (or clear, when template is null) a custom id-card template + entities. */
export async function setIdCard(
  chatId: number | bigint,
  template: string | null,
  entities: unknown[] | null,
): Promise<void> {
  await prisma.chatSettings.update({
    where: { chatId: BigInt(chatId) },
    data: {
      idCardTemplate: template,
      idCardEntities: template && entities && entities.length ? JSON.stringify(entities) : null,
    },
  });
}
