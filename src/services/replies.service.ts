import type { CustomReply } from '@prisma/client';
import { prisma } from '../core/database';
import { pickRandom } from '../utils/format';

export async function addReply(
  chatId: number | bigint,
  trigger: string,
  responses: string[],
  createdBy: number | bigint,
  matchType: 'exact' | 'contains' | 'regex' = 'contains',
): Promise<void> {
  const cId = BigInt(chatId);
  await prisma.customReply.upsert({
    where: { chatId_trigger: { chatId: cId, trigger: trigger.toLowerCase() } },
    create: {
      chatId: cId,
      trigger: trigger.toLowerCase(),
      responses: JSON.stringify(responses),
      entities: null,
      matchType,
      createdBy: BigInt(createdBy),
    },
    update: { responses: JSON.stringify(responses), entities: null, matchType },
  });
}

/**
 * Store a "rich" reply captured from an existing message: its exact text plus
 * Telegram entities (custom/premium emoji, bold, etc.). Sending it back with
 * these entities re-renders the premium emoji (requires the bot owner to have
 * Telegram Premium).
 */
export async function addRichReply(
  chatId: number | bigint,
  trigger: string,
  text: string,
  entities: unknown[],
  createdBy: number | bigint,
  matchType: 'exact' | 'contains' | 'regex' = 'contains',
): Promise<void> {
  const cId = BigInt(chatId);
  await prisma.customReply.upsert({
    where: { chatId_trigger: { chatId: cId, trigger: trigger.toLowerCase() } },
    create: {
      chatId: cId,
      trigger: trigger.toLowerCase(),
      responses: JSON.stringify([text]),
      entities: entities.length ? JSON.stringify(entities) : null,
      matchType,
      createdBy: BigInt(createdBy),
    },
    update: { responses: JSON.stringify([text]), entities: entities.length ? JSON.stringify(entities) : null, matchType },
  });
}

export async function deleteReply(
  chatId: number | bigint,
  trigger: string,
): Promise<boolean> {
  try {
    await prisma.customReply.delete({
      where: {
        chatId_trigger: { chatId: BigInt(chatId), trigger: trigger.toLowerCase() },
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listReplies(chatId: number | bigint): Promise<CustomReply[]> {
  return prisma.customReply.findMany({ where: { chatId: BigInt(chatId) } });
}

export interface MatchedReply {
  text: string;
  /** Telegram message entities (custom/premium emoji, formatting) if this is a rich reply. */
  entities?: unknown[];
}

/**
 * Find the first custom reply matching `text` and return a (randomly chosen)
 * response, with its entities when it's a rich (premium-emoji) reply. Returns
 * null if nothing matches.
 */
export async function matchReply(
  chatId: number | bigint,
  text: string,
): Promise<MatchedReply | null> {
  const lower = text.toLowerCase();
  const replies = await prisma.customReply.findMany({
    where: { chatId: BigInt(chatId) },
  });

  for (const reply of replies) {
    let matched = false;
    if (reply.matchType === 'exact') {
      matched = lower === reply.trigger;
    } else if (reply.matchType === 'regex') {
      try {
        matched = new RegExp(reply.trigger, 'i').test(text);
      } catch {
        matched = false;
      }
    } else {
      matched = lower.includes(reply.trigger);
    }

    if (matched) {
      const responses = safeParseResponses(reply.responses);
      if (!responses.length) continue;
      const chosen = pickRandom(responses);
      // Entities only apply to a single-response rich reply; skip them when the
      // chosen response isn't the stored rich text (multi-response replies).
      const rich = (reply as { entities?: string | null }).entities;
      if (rich && responses.length === 1) {
        const entities = safeParseEntities(rich);
        return { text: chosen, entities: entities.length ? entities : undefined };
      }
      return { text: chosen };
    }
  }
  return null;
}

function safeParseEntities(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseResponses(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
