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

export type AudioKind = 'audio' | 'document';

export interface ArchiveHit {
  fileId: string;
  title: string;
  duration: number;
  kind: AudioKind;
}

/** Index a track by its Telegram file_id, unless a near-duplicate already exists
 *  (same normalized title and duration within ±2s). Returns whether it was added. */
export async function indexAudio(input: {
  fileId: string;
  title: string;
  artist?: string | null;
  duration?: number;
  source?: 'channel' | 'cache' | 'import';
  kind?: AudioKind;
  query?: string; // the search phrase that found this track (for future lookups)
}): Promise<{ indexed: boolean }> {
  const title = (input.title || '').trim() || 'غير معروف';
  const normTitle = normalizeTitle(title);
  if (!normTitle) return { indexed: false };
  const duration = Math.max(0, Math.floor(input.duration ?? 0));
  const queryKey = input.query ? normalizeTitle(input.query) || null : null;
  try {
    const dup = await prisma.audioArchive.findFirst({
      where: { normTitle, duration: { gte: duration - 2, lte: duration + 2 } },
      select: { id: true, queryKey: true },
    });
    if (dup) {
      // Already stored — but attach the search phrase if it has none yet, so the
      // next search for that phrase hits the archive instead of re-downloading.
      if (queryKey && !dup.queryKey)
        await prisma.audioArchive.update({ where: { id: dup.id }, data: { queryKey } }).catch(() => undefined);
      return { indexed: false };
    }
    await prisma.audioArchive.create({
      data: {
        fileId: input.fileId,
        title: title.slice(0, 200),
        artist: input.artist?.slice(0, 120) ?? null,
        duration,
        normTitle,
        latinKey: latinFold(normTitle),
        queryKey,
        source: input.source ?? 'channel',
        kind: input.kind ?? 'audio',
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
            { queryKey: { contains: needle } },
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
      c.queryKey ? similarity(q, c.queryKey) : 0,
    );
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (best && bestScore >= 0.5)
    return {
      fileId: best.fileId,
      title: best.title,
      duration: best.duration,
      kind: (best.kind as AudioKind) ?? 'audio',
    };
  return null;
}

export async function archiveCount(): Promise<number> {
  return prisma.audioArchive.count().catch(() => 0);
}

export interface ArchiveEntry {
  title: string;
  artist: string | null;
  duration: number;
  kind: AudioKind;
}

/** List archive entries. With a query, returns fuzzy matches ranked by score;
 *  without one, returns the most recently added. Capped at `limit`. */
export async function archiveList(query: string | undefined, limit = 20): Promise<ArchiveEntry[]> {
  const toEntry = (r: { title: string; artist: string | null; duration: number; kind: string }): ArchiveEntry => ({
    title: r.title,
    artist: r.artist,
    duration: r.duration,
    kind: (r.kind as AudioKind) ?? 'audio',
  });

  const q = query ? normalizeTitle(query) : '';
  if (q.length >= 2) {
    const needle = longestToken(q);
    const where =
      needle.length >= 2
        ? { OR: [{ normTitle: { contains: needle } }, { latinKey: { contains: latinFold(needle) } }] }
        : {};
    const rows = await prisma.audioArchive
      .findMany({ where, take: 300, orderBy: { createdAt: 'desc' } })
      .catch(() => []);
    return rows
      .map((r) => ({ r, s: Math.max(similarity(q, r.normTitle), r.latinKey ? similarity(q, r.latinKey) : 0) }))
      .filter((x) => x.s >= 0.35)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => toEntry(x.r));
  }

  const rows = await prisma.audioArchive.findMany({ take: limit, orderBy: { createdAt: 'desc' } }).catch(() => []);
  return rows.map(toEntry);
}
