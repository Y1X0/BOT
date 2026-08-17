import { prisma } from '../core/database';

/** Read a bot-wide config value by key (null if unset). */
export async function getGlobal(key: string): Promise<string | null> {
  const row = await prisma.globalConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}

/** Set (or clear, when value is null) a bot-wide config value. */
export async function setGlobal(key: string, value: string | null): Promise<void> {
  if (value == null) {
    await prisma.globalConfig.deleteMany({ where: { key } }).catch(() => undefined);
    return;
  }
  await prisma.globalConfig
    .upsert({ where: { key }, create: { key, value }, update: { value } })
    .catch(() => undefined);
}

const GLOBAL_ID_CARD_KEY = 'idCard';

export interface GlobalIdCard {
  template: string;
  entities: unknown[];
}

/** The bot-wide id-card template applied to every group that hasn't set its own. */
export async function getGlobalIdCard(): Promise<GlobalIdCard | null> {
  const raw = await getGlobal(GLOBAL_ID_CARD_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { template?: string; entities?: unknown[] };
    if (!parsed.template) return null;
    return { template: parsed.template, entities: Array.isArray(parsed.entities) ? parsed.entities : [] };
  } catch {
    return null;
  }
}

export async function setGlobalIdCard(template: string | null, entities: unknown[] | null): Promise<void> {
  if (!template) return void setGlobal(GLOBAL_ID_CARD_KEY, null);
  await setGlobal(GLOBAL_ID_CARD_KEY, JSON.stringify({ template, entities: entities ?? [] }));
}
