/**
 * Normalize an audio title for fuzzy archive matching. This is the FOUNDATION of
 * the whole search — every stored title and every query passes through it, so it
 * has unit tests. Rules:
 *   - decompose (NFKD) then strip Latin + Arabic combining marks (tashkeel)
 *   - strip tatweel
 *   - unify hamza forms: أ إ آ ٱ -> ا
 *   - alef maqsura ى -> ي, ta marbuta ة -> ه
 *   - lowercase Latin
 *   - drop punctuation/symbols, collapse whitespace
 */
export function normalizeTitle(input: string): string {
  return (input || '')
    .normalize('NFKD')
    // Latin combining diacritics (0300-036F) + Arabic combining marks
    // (harakat 064B-065F, superscript alef 0670, extended 06D6-06ED).
    .replace(/[̀-ًͯ-ٰٟۖ-ۭ]/g, '')
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation/symbols
    .replace(/\s+/g, ' ')
    .trim();
}

/** The longest normalized token in a query — used as the SQL pre-filter needle. */
export function longestToken(normalized: string): string {
  return normalized.split(' ').reduce((a, b) => (b.length > a.length ? b : a), '');
}

/** Levenshtein edit distance (iterative, O(n·m) with a single row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur.push(Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** A rough 0-1 similarity between two normalized strings: exact > substring >
 *  token overlap > edit-distance ratio. Cheap and good enough to rank a small
 *  candidate set (handles typos and transliteration wobble like nancy↔nansy). */
export function similarity(q: string, t: string): number {
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.includes(q) || q.includes(t)) return 0.9;
  const qs = new Set(q.split(' ').filter(Boolean));
  const ts = t.split(' ').filter(Boolean);
  if (qs.size === 0 || ts.length === 0) return 0;
  const overlap = ts.filter((w) => qs.has(w)).length;
  const tokenScore = overlap / Math.max(qs.size, ts.length);
  if (tokenScore > 0) return tokenScore;
  // No shared token → fall back to a whole-string edit-distance ratio, capped
  // below the substring score so exact-ish matches always rank above fuzzy.
  const ratio = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
  return ratio * 0.8;
}
