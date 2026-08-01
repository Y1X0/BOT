/**
 * Text decoration ("زخرفة"). Produces many stylised variants of a word:
 *  - decorative frames/symbols around it (works for Arabic & Latin),
 *  - combining marks over each letter (underline, strike, sparkle...),
 *  - fancy Unicode fonts for Latin letters (bold, circled, fullwidth).
 * Pure and dependency-free.
 */

/** Symbol frames wrapped around the whole text. */
const FRAMES: Array<(s: string) => string> = [
  (s) => `『 ${s} 』`,
  (s) => `【 ${s} 】`,
  (s) => `❁ ${s} ❁`,
  (s) => `✿ ${s} ✿`,
  (s) => `♡ ${s} ♡`,
  (s) => `☆ ${s} ☆`,
  (s) => `✧･ﾟ ${s} ･ﾟ✧`,
  (s) => `⟦ ${s} ⟧`,
  (s) => `-ˏˋ ${s} ´ˎ-`,
  (s) => `╰☆╮ ${s} ╰☆╮`,
  (s) => `➶ ${s} ➶`,
  (s) => `♛ ${s} ♛`,
  (s) => `✰ ${s} ✰`,
  (s) => `꧁ ${s} ꧂`,
  (s) => `⌜ ${s} ⌝`,
];

/** Combining marks placed after each visible character. */
const COMBINING: string[] = [
  '̲', // underline
  '̶', // strikethrough
  '̅', // overline
  '҉', // cyrillic millions sign (sparkle-like)
  '̣', // dot below
];

function applyCombining(text: string, mark: string): string {
  return Array.from(text)
    .map((ch) => (ch === ' ' ? ch : ch + mark))
    .join('');
}

function mapLatin(
  text: string,
  upperBase: number,
  lowerBase: number,
  digitBase?: number,
): string {
  return Array.from(text)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 65 && c <= 90) return String.fromCodePoint(upperBase + (c - 65));
      if (c >= 97 && c <= 122) return String.fromCodePoint(lowerBase + (c - 97));
      if (digitBase && c >= 48 && c <= 57) return String.fromCodePoint(digitBase + (c - 48));
      return ch;
    })
    .join('');
}

const hasLatin = (t: string) => /[A-Za-z]/.test(t);

/**
 * Return a de-duplicated list of decorated variants for `text`.
 * `limit` caps the count so replies stay readable.
 */
export function decorate(text: string, limit = 20): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const out: string[] = [];

  // Latin fancy fonts first — they're the highlight for ASCII words and
  // must not be pushed off the end by the (many) frame variants.
  if (hasLatin(trimmed)) {
    out.push(mapLatin(trimmed, 0x1d400, 0x1d41a, 0x1d7ce)); // bold
    out.push(mapLatin(trimmed, 0x24b6, 0x24d0)); // circled
    out.push(mapLatin(trimmed, 0xff21, 0xff41, 0xff10)); // fullwidth
  }

  for (const frame of FRAMES) out.push(frame(trimmed));
  for (const mark of COMBINING) out.push(applyCombining(trimmed, mark));

  // De-duplicate while preserving order, then cap.
  return [...new Set(out)].slice(0, limit);
}
