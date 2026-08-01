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
      matchType,
      createdBy: BigInt(createdBy),
    },
    update: { responses: JSON.stringify(responses), matchType },
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

/**
 * Find the first custom reply matching `text` and return a (randomly chosen)
 * response. Returns null if nothing matches.
 */
export async function matchReply(
  chatId: number | bigint,
  text: string,
): Promise<string | null> {
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
      if (responses.length) return pickRandom(responses);
    }
  }
  return null;
}

function safeParseResponses(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}
