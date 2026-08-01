import type { AudioCache } from '@prisma/client';
import { prisma } from '../../core/database';

/**
 * Audio cache keyed by YouTube video id. Stores the Telegram file_id of a
 * successfully sent track so the same song is fetched from YouTube only once
 * and re-sent instantly (and load on YouTube drops dramatically).
 */
export async function getCachedAudio(videoId: string): Promise<AudioCache | null> {
  return prisma.audioCache.findUnique({ where: { videoId } });
}

export async function cacheAudio(
  videoId: string,
  fileId: string,
  title: string,
  duration: number | null,
): Promise<void> {
  await prisma.audioCache.upsert({
    where: { videoId },
    create: { videoId, fileId, title, duration: duration ?? null },
    update: { fileId, title, duration: duration ?? null },
  });
}

/** Count a cache hit (best-effort analytics). */
export async function bumpCacheHit(videoId: string): Promise<void> {
  await prisma.audioCache
    .update({ where: { videoId }, data: { hits: { increment: 1 } } })
    .catch(() => undefined);
}

/** Drop a stale entry (e.g. Telegram rejected the file_id). */
export async function dropCachedAudio(videoId: string): Promise<void> {
  await prisma.audioCache.delete({ where: { videoId } }).catch(() => undefined);
}
