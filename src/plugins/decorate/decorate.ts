/**
 * Text decoration ("زخرفة") — stylises the LETTERS themselves into many
 * variants of the same word:
 *  - Arabic: combining decorative marks over/under each letter, plus light
 *    separators between letters (Arabic has no "fancy font" Unicode blocks,
 *    so decoration is done with native marks).
 *  - Latin: many real Unicode alphabets (bold, italic, script, fraktur,
 *    double-struck, monospace, sans, fullwidth, circled...). Unicode "holes"
 *    in the math-alphanumeric blocks are patched via per-font overrides so
 *    letters never render as tofu boxes.
 * Pure and dependency-free.
 */

interface LatinFont {
  upper: number;
  lower: number;
  digit?: number;
  overrides?: Record<string, string>;
}

const LATIN_FONTS: LatinFont[] = [
  { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce }, // bold
  { upper: 0x1d434, lower: 0x1d44e, overrides: { h: 'ℎ' } }, // italic
  { upper: 0x1d468, lower: 0x1d482 }, // bold italic
  {
    upper: 0x1d49c,
    lower: 0x1d4b6,
    overrides: {
      B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ',
      L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ',
    },
  }, // script
  { upper: 0x1d4d0, lower: 0x1d4ea }, // bold script
  {
    upper: 0x1d504,
    lower: 0x1d51e,
    overrides: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  }, // fraktur
  {
    upper: 0x1d538,
    lower: 0x1d552,
    digit: 0x1d7d8,
    overrides: {
      C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ',
    },
  }, // double-struck
  { upper: 0x1d56c, lower: 0x1d586 }, // bold fraktur
  { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 }, // sans-serif
  { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec }, // sans-serif bold
  { upper: 0x1d608, lower: 0x1d622 }, // sans-serif italic
  { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 }, // monospace
  { upper: 0xff21, lower: 0xff41, digit: 0xff10 }, // fullwidth
  { upper: 0x24b6, lower: 0x24d0 }, // circled
  { upper: 0x1f150, lower: 0x1f150 }, // negative circled 🅐
  { upper: 0x1f130, lower: 0x1f130 }, // squared 🄰
  { upper: 0x1f170, lower: 0x1f170 }, // negative squared 🅰
  { upper: 0x1f110, lower: 0x249c }, // parenthesized 🄐 / ⒜
];

/** Map-based Latin fonts (irregular Unicode) — applied per character. */
const MAP_FONTS: { map: Record<string, string>; reverse?: boolean }[] = [
  {
    // small caps
    map: {
      a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ',
      l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ',
      w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
    },
  },
  {
    // superscript
    map: {
      a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ',
      l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', q: 'q', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
      w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
    },
  },
  {
    // upside-down (string is also reversed)
    reverse: true,
    map: {
      a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ',
      l: 'ʅ', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ',
      w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
    },
  },
];

function mapCharFont(text: string, spec: { map: Record<string, string>; reverse?: boolean }): string {
  const chars = Array.from(text.toLowerCase()).map((ch) => spec.map[ch] ?? ch);
  if (spec.reverse) chars.reverse();
  return chars.join('');
}

function mapLatinFont(text: string, font: LatinFont): string {
  return Array.from(text)
    .map((ch) => {
      if (font.overrides?.[ch]) return font.overrides[ch];
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 65 && c <= 90) return String.fromCodePoint(font.upper + (c - 65));
      if (c >= 97 && c <= 122) return String.fromCodePoint(font.lower + (c - 97));
      if (font.digit && c >= 48 && c <= 57) return String.fromCodePoint(font.digit + (c - 48));
      return ch;
    })
    .join('');
}

/** Decorative combining marks — each yields one distinct style of the letters. */
const MARKS: string[] = [
  'ْ', 'ّ', 'ٰ', 'ً', 'ٖ', 'ۡ',
  '۟', '۠', 'ۖ', 'ۘ', 'ۚ', 'ٟ',
  '́', '̂', '̃', '̅', '̊', '҉',
  '̶', '̲', '॑', '҃', '҂', '̈', '̆', '̐',
];

function applyMark(text: string, mark: string): string {
  return Array.from(text)
    .map((ch) => (ch === ' ' ? ch : ch + mark))
    .join('');
}

/** Symbols inserted BETWEEN letters (keeps the letters, decorates the spacing). */
const SEPARATORS = [
  '·', '˚', '•', '°', '⁛', '⋆', '✦', '✧', '˙', '๑', '‿', '⁀', '♡', '✿', '❁', '⁘', '⳹', '҂', '⌇', '⁙',
];

function joinWith(text: string, sep: string): string {
  return Array.from(text).join(sep);
}

/** Wrap EACH letter with a symbol on both sides (a fuller letter decoration). */
const WRAPS: [string, string][] = [
  ['˚', '˚'], ['⁀', '⁀'], ['⋆', '⋆'], ['๑', '๑'], ['̊', ''], ['ᬼ', ''],
];

function wrapLetters(text: string, l: string, r: string): string {
  return Array.from(text)
    .map((ch) => (ch === ' ' ? ch : `${l}${ch}${r}`))
    .join('');
}

// Arabic vowel marks (حركات) for tashkeel-style decoration.
const HARAKAT = ['َ', 'ُ', 'ِ', 'ْ', 'ّ', 'ً', 'ٌ', 'ٍ', 'ٰ', 'ٓ', 'ٖ', 'ۣ'];

/** Give each letter a different haraka, cycling through the set (offset varies). */
function harakatCycle(text: string, offset: number): string {
  let i = 0;
  return Array.from(text)
    .map((ch) => (ch === ' ' ? ch : ch + HARAKAT[(i++ + offset) % HARAKAT.length]))
    .join('');
}

/** Two stacked marks per letter — one above, one below — for a fuller look. */
const DOUBLE_MARKS: [string, string][] = [
  ['ّ', 'ٍ'], ['ً', 'ٖ'], ['ٰ', 'ۣ'], ['ٓ', 'ٜ'], ['ۨ', 'ٖ'], ['̑', '̭'],
];

function applyDouble(text: string, above: string, below: string): string {
  return Array.from(text)
    .map((ch) => (ch === ' ' ? ch : ch + above + below))
    .join('');
}

/**
 * Decorative frames — [left, right] wrappers placed around the whole word.
 * These are the prettiest and work for BOTH Arabic and Latin, so they lead.
 * Spacing is baked into each side.
 */
const FRAMES: [string, string][] = [
  ['꧁ ', ' ꧂'],
  ['꧁༺ ', ' ༻꧂'],
  ['༒ ', ' ༒'],
  ['✦ ', ' ✦'],
  ['✧ ', ' ✧'],
  ['⋆｡˚ ', ' ˚｡⋆'],
  ['⊹ ₊ ', ' ₊ ⊹'],
  ['☾ ', ' ☽'],
  ['❁ ', ' ❁'],
  ['✿ ', ' ✿'],
  ['❦ ', ' ❦'],
  ['♡ ', ' ♡'],
  ['『 ', ' 』'],
  ['【 ', ' 】'],
  ['「 ', ' 」'],
  ['≼ ', ' ≽'],
  ['➶ ', ' ➷'],
  ['彡★ ', ' ★彡'],
  ['⚡ ', ' ⚡'],
  ['╰☆ ', ' ☆╮'],
  ['✩ ', ' ✩'],
  ['❖ ', ' ❖'],
  ['◈ ', ' ◈'],
  ['➳ ', ' ➳'],
  ['⌁ ', ' ⌁'],
  ['⟢ ', ' ⟣'],
  ['ღ ', ' ღ'],
  ['᯽ ', ' ᯽'],
  ['⊰ ', ' ⊱'],
  ['≋ ', ' ≋'],
  ['⧉ ', ' ⧉'],
  ['⩩ ', ' ⩩'],
  ['⫷ ', ' ⫸'],
  ['⇜ ', ' ⇝'],
  ['❣ ', ' ❣'],
  ['ঔ ', ' ঔ'],
  ['⌜ ', ' ⌟'],
  ['⏣ ', ' ⏣'],
];

const hasLatin = (t: string) => /[A-Za-z]/.test(t);

/**
 * Return a de-duplicated list of decorated variants of `text`. Decorative
 * frames lead (prettiest, work for Arabic & Latin), then Latin fancy alphabets,
 * then a few clean separators and subtle marks. `limit` caps the count.
 */
export function decorate(text: string, limit = 72): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const out: string[] = [];

  // Latin fancy alphabets first for ASCII (the real per-letter restyle).
  if (hasLatin(trimmed)) {
    for (const font of LATIN_FONTS) out.push(mapLatinFont(trimmed, font));
    for (const spec of MAP_FONTS) out.push(mapCharFont(trimmed, spec));
    const bold = mapLatinFont(trimmed, LATIN_FONTS[0]);
    out.push(`꧁ ${bold} ꧂`, `༺ ${bold} ༻`, `▁▂▃ ${bold} ▃▂▁`);
  }

  // Per-letter decoration — the core "زخرفة الحروف" (marks, harakat, wraps).
  for (const mark of MARKS) out.push(applyMark(trimmed, mark));
  // Tashkeel-style: varied harakat across the letters (a few offsets).
  for (let off = 0; off < 6; off++) out.push(harakatCycle(trimmed, off));
  for (const [a, b] of DOUBLE_MARKS) out.push(applyDouble(trimmed, a, b));
  for (const [l, r] of WRAPS) out.push(wrapLetters(trimmed, l, r));
  for (const sep of SEPARATORS) out.push(joinWith(trimmed, sep));

  // Decorative frames around the whole word (also nice).
  for (const [l, r] of FRAMES) out.push(`${l}${trimmed}${r}`);

  // De-duplicate while preserving order, then cap.
  return [...new Set(out)].filter((v) => v !== trimmed).slice(0, limit);
}
