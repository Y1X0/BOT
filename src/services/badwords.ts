/**
 * Arabic profanity detector for group moderation. Normalizes text (diacritics,
 * letter variants, repeated letters, spacing-based evasion) then matches a
 * curated list of vulgar/sexual/family insults. Tuned to avoid collisions with
 * ordinary words (e.g. "كسر" break, "كسل" laziness are NOT flagged).
 */

const DIACRITICS = /[ً-ٰٟـ]/g; // harakat + tatweel

/** Normalize Arabic/Latin text for matching. */
export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^ء-يa-z\s]/g, ' ') // keep Arabic + latin letters + spaces
    .replace(/(.)\1{2,}/g, '$1$1') // collapse 3+ repeats → 2
    .replace(/\s+/g, ' ')
    .trim();
}

// Whole-token insults (matched as exact normalized words).
const EXACT = new Set([
  'خول', 'خوله', 'خولات', 'زنا', 'خرا', 'خره', 'خري', 'عير', 'عيري', 'شراميط',
  'لبوه', 'دعاره', 'زبي', 'كسك', 'كسها', 'طز', 'منيوكه', 'متناكه', 'قحبه',
]);

// Prefix roots: a token starting with one of these is an insult (covers inflections).
const PREFIXES = [
  'كسم', 'كساخ', 'كسخت', 'كسمك', 'كسام', 'طيز', 'زبر', 'عرص', 'معرص',
  'منيوك', 'متناك', 'منيك', 'نياك', 'انيك', 'قحب', 'شرموط', 'زاني', 'زواني',
  'عاهر', 'داعر', 'شرمو',
];

// The worst family/sexual phrases — matched even when spaced out to evade filters
// (e.g. "ك س م ك"). Checked against the whole string with spaces removed.
const JOINED = ['كسمك', 'كسامك', 'كساختك', 'كسختك', 'انيكك', 'انيك', 'متناك', 'كسمها', 'كسمكم'];

/** Bare "نيك" only when it's a standalone token (avoids rare in-word collisions). */
const STANDALONE = new Set(['نيك', 'نيكك', 'نيكه']);

export function containsBadword(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  const tokens = norm.split(' ');
  for (const tok of tokens) {
    // Also test the token with a leading "ال" (definite article) removed, so
    // "الشرموطه" matches the "شرموط" root just like "شرموطه" does.
    const bare = tok.startsWith('ال') && tok.length > 4 ? tok.slice(2) : tok;
    for (const form of bare === tok ? [tok] : [tok, bare]) {
      if (EXACT.has(form) || STANDALONE.has(form)) return true;
      for (const p of PREFIXES) {
        if (form.startsWith(p)) return true;
      }
    }
  }
  const despaced = norm.replace(/\s+/g, '');
  for (const j of JOINED) {
    if (despaced.includes(j)) return true;
  }
  return false;
}
