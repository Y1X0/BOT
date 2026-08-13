import { prisma } from '../core/database';

export interface EmojiItem {
  e: string; // base emoji character (fallback for non-Premium viewers)
  id: string; // custom_emoji_id
}

const MAX = 100;

interface RawEntity {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
}

/** Pull custom-emoji {char,id} pairs out of a message's text + entities. */
export function extractCustomEmoji(text: string, entities: readonly RawEntity[] = []): EmojiItem[] {
  const out: EmojiItem[] = [];
  for (const e of entities) {
    if (e?.type === 'custom_emoji' && e.custom_emoji_id) {
      const ch = text.substring(e.offset, e.offset + e.length) || '⭐';
      out.push({ e: ch, id: e.custom_emoji_id });
    }
  }
  return out;
}

export async function getSavedEmoji(userId: number | bigint): Promise<EmojiItem[]> {
  const row = await prisma.savedEmoji.findUnique({ where: { userId: BigInt(userId) } });
  if (!row) return [];
  try {
    const arr = JSON.parse(row.items) as EmojiItem[];
    return Array.isArray(arr) ? arr.filter((x) => x && x.id) : [];
  } catch {
    return [];
  }
}

/** Append new emoji, de-duplicating by id, capped at MAX. Returns the new total. */
export async function addSavedEmoji(userId: number | bigint, items: EmojiItem[]): Promise<number> {
  const existing = await getSavedEmoji(userId);
  const seen = new Set(existing.map((x) => x.id));
  for (const it of items) {
    if (it.id && !seen.has(it.id)) {
      existing.push({ e: it.e || '⭐', id: it.id });
      seen.add(it.id);
    }
  }
  const capped = existing.slice(0, MAX);
  await prisma.savedEmoji.upsert({
    where: { userId: BigInt(userId) },
    create: { userId: BigInt(userId), items: JSON.stringify(capped) },
    update: { items: JSON.stringify(capped) },
  });
  return capped.length;
}

export async function clearSavedEmoji(userId: number | bigint): Promise<void> {
  await prisma.savedEmoji
    .update({ where: { userId: BigInt(userId) }, data: { items: '[]' } })
    .catch(() => undefined);
}
