import type { ChatSettings } from '@prisma/client';
import { prisma } from '../core/database';
import { env } from '../config/env';
import type { Locale } from '../locales';
import { isSupportedLocale } from '../locales';

/**
 * Ensure a Chat + ChatSettings row exists, then return the settings.
 * Idempotent — safe to call on every group message.
 */
export async function ensureChat(
  chatId: number | bigint,
  title?: string,
  type?: string,
): Promise<ChatSettings> {
  const id = BigInt(chatId);

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
  if (settings) return settings;

  // Race-safe fallback if settings row was missing.
  return prisma.chatSettings.create({ data: { chatId: id } });
}

export async function getSettings(chatId: number | bigint): Promise<ChatSettings | null> {
  return prisma.chatSettings.findUnique({ where: { chatId: BigInt(chatId) } });
}

export async function getLocale(chatId: number | bigint): Promise<Locale> {
  const chat = await prisma.chat.findUnique({ where: { id: BigInt(chatId) } });
  if (chat && isSupportedLocale(chat.language)) return chat.language;
  return env.DEFAULT_LANGUAGE;
}

export async function setLocale(chatId: number | bigint, locale: Locale): Promise<void> {
  await prisma.chat.update({ where: { id: BigInt(chatId) }, data: { language: locale } });
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
  'repliesEnabled',
  'reactionsEnabled',
  'gamesEnabled',
  'economyEnabled',
  'xpEnabled',
  'aiEnabled',
  'cleanServiceEnabled',
  'moderationEnabled',
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
