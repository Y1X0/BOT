import { prisma } from '../../core/database';
import { createLogger } from '../../core/logger';
import { normalizeTitle, longestToken, similarity } from './normalize';

const log = createLogger('archive');

// Best-effort Arabic→Latin phonetic fold so a Latin query ("nancy") can match a
// stored Arabic title ("نانسي"). Rough by design — ranking uses edit distance.
const AR2LAT: Record<string, string> = {
  ا: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'th',
  ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a',
  غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', و: 'w',
  ي: 'y', ء: '', ؤ: 'w', ئ: 'y',
};

function latinFold(norm: string): string {
  return [...norm].map((ch) => AR2LAT[ch] ?? ch).join('');
}

export interface ArchiveHit {
  fileId: string;
  title: string;
  duration: number;
}

/** Index a track by its Telegram file_id, unless a near-duplicate already exists
 *  (same normalized title and duration within ±2s). Returns whether it was added. */
export async function indexAudio(input: {
  fileId: string;
  title: string;
  artist?: string | null;
  duration?: number;
  source?: 'channel' | 'cache' | 'import';
}): Promise<{ indexed: boolean }> {
  const title = (input.title || '').trim() || 'غير معروف';
  const normTitle = normalizeTitle(title);
  if (!normTitle) return { indexed: false };
  const duration = Math.max(0, Math.floor(input.duration ?? 0));
  try {
    const dup = await prisma.audioArchive.findFirst({
      where: { normTitle, duration: { gte: duration - 2, lte: duration + 2 } },
      select: { id: true },
    });
    if (dup) return { indexed: false };
    await prisma.audioArchive.create({
      data: {
        fileId: input.fileId,
        title: title.slice(0, 200),
        artist: input.artist?.slice(0, 120) ?? null,
        duration,
        normTitle,
        latinKey: latinFold(normTitle),
        source: input.source ?? 'channel',
      },
    });
    return { indexed: true };
  } catch (err) {
    // Unique fileId conflict or DB hiccup — never throw into the caller.
    log.debug({ err }, 'indexAudio skipped');
    return { indexed: false };
  }
}

/** Search the archive for a query. SQL pre-filters on the longest token (capped
 *  at 300 rows), then ranks candidates in JS. Returns the best hit above the
 *  confidence threshold, or null. */
export async function archiveSearch(query: string): Promise<ArchiveHit | null> {
  const q = normalizeTitle(query);
  if (q.length < 2) return null;
  const needle = longestToken(q);
  const hasLatin = /[a-z]/.test(q);

  const where =
    needle.length >= 2
      ? {
          OR: [
            { normTitle: { contains: needle } },
            ...(hasLatin ? [{ latinKey: { contains: needle } }] : [{ latinKey: { contains: latinFold(needle) } }]),
          ],
        }
      : {};

  const candidates = await prisma.audioArchive
    .findMany({ where, take: 300, orderBy: { createdAt: 'desc' } })
    .catch(() => []);
  if (!candidates.length) return null;

  let best: (typeof candidates)[number] | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = Math.max(
      similarity(q, c.normTitle),
      c.latinKey ? similarity(q, c.latinKey) : 0,
    );
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (best && bestScore >= 0.5) return { fileId: best.fileId, title: best.title, duration: best.duration };
  return null;
}

export async function archiveCount(): Promise<number> {
  return prisma.audioArchive.count().catch(() => 0);
}
