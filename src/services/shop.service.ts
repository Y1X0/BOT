import { prisma } from '../core/database';
import { getBalance, addCoins } from './economy.service';

export interface ShopItem {
  id: string;
  name: string; // includes emoji, becomes the equipped title
  price: number;
  desc: string;
}

/** Shop catalog — all items are titles for now. */
export const SHOP_ITEMS: ShopItem[] = [
  { id: 'star', name: '⭐️ نجم الجروب', price: 1000, desc: 'لقب النجم' },
  { id: 'vip', name: '💎 VIP', price: 2000, desc: 'لقب مميّز' },
  { id: 'legend', name: '🔥 أسطورة', price: 3000, desc: 'لقب الأسطورة' },
  { id: 'king', name: '👑 ملك الجروب', price: 5000, desc: 'أرقى لقب' },
];

export function findItem(id: string): ShopItem | undefined {
  return SHOP_ITEMS.find((i) => i.id === id.toLowerCase());
}

export type BuyResult =
  | { ok: true; item: ShopItem }
  | { ok: false; reason: 'not_found' | 'owned' | 'insufficient' };

export async function buyItem(
  chatId: number | bigint,
  userId: number | bigint,
  itemId: string,
): Promise<BuyResult> {
  const item = findItem(itemId);
  if (!item) return { ok: false, reason: 'not_found' };
  const cId = BigInt(chatId);
  const uId = BigInt(userId);

  const owned = await prisma.shopPurchase.findUnique({
    where: { chatId_userId_itemId: { chatId: cId, userId: uId, itemId: item.id } },
  });
  if (owned) return { ok: false, reason: 'owned' };

  if ((await getBalance(cId, uId)) < item.price) return { ok: false, reason: 'insufficient' };

  await addCoins(cId, uId, -item.price);
  await prisma.shopPurchase.create({ data: { chatId: cId, userId: uId, itemId: item.id } });
  // Auto-equip the newly bought title.
  await prisma.member
    .update({ where: { chatId_userId: { chatId: cId, userId: uId } }, data: { title: item.name } })
    .catch(() => undefined);
  return { ok: true, item };
}

export async function listOwned(chatId: number | bigint, userId: number | bigint): Promise<ShopItem[]> {
  const rows = await prisma.shopPurchase.findMany({
    where: { chatId: BigInt(chatId), userId: BigInt(userId) },
  });
  const ids = new Set(rows.map((r) => r.itemId));
  return SHOP_ITEMS.filter((i) => ids.has(i.id));
}

export async function equipTitle(
  chatId: number | bigint,
  userId: number | bigint,
  itemId: string,
): Promise<boolean> {
  const item = findItem(itemId);
  if (!item) return false;
  const owned = await prisma.shopPurchase.findUnique({
    where: { chatId_userId_itemId: { chatId: BigInt(chatId), userId: BigInt(userId), itemId: item.id } },
  });
  if (!owned) return false;
  await prisma.member
    .update({ where: { chatId_userId: { chatId: BigInt(chatId), userId: BigInt(userId) } }, data: { title: item.name } })
    .catch(() => undefined);
  return true;
}
