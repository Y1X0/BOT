/**
 * Lightweight content safety for the Fun Image Editor. The feature is PG-only,
 * so free-text /imagine prompts are screened against a blocklist before any
 * API call, and a PG guardrail is appended to every generation prompt so the
 * model itself stays wholesome. This is a cheap first line of defense — the
 * provider's own safety systems are the second.
 */

// Disallowed intents: nudity/sexual, gore/violence, and targeted humiliation.
// Matched case-insensitively as substrings after light normalization, in both
// Arabic and English. Keep additions specific to avoid false positives.
const BLOCKLIST: string[] = [
  // sexual / nudity (en)
  'nude',
  'naked',
  'nsfw',
  'porn',
  'sex',
  'sexual',
  'erotic',
  'nipple',
  'boob',
  'breast',
  'lingerie',
  'bikini',
  'underwear',
  'topless',
  'undress',
  'strip',
  'fetish',
  'genital',
  // sexual / nudity (ar)
  'عاري',
  'عارية',
  'عاريه',
  'عري',
  'تعري',
  'جنسي',
  'جنسيه',
  'اباحي',
  'إباحي',
  'اباحيه',
  'بورن',
  'سكس',
  'مثير',
  'مثيره',
  'بكيني',
  'ملابس داخلية',
  'ملابس داخليه',
  'خلع الملابس',
  'حلمة',
  'صدر عاري',
  // gore / violence (en)
  'gore',
  'behead',
  'decapitat',
  'mutilat',
  'bloody corpse',
  // gore / violence (ar)
  'دموي',
  'مقطوع الراس',
  'قطع راس',
  'تشويه',
  'جثة',
  'جثه',
];

/** PG guardrail appended to every free-text generation prompt. */
export const PG_SUFFIX =
  ' — The image must be strictly PG and suitable for all ages: fully clothed,' +
  ' modest, non-sexual, non-violent, and never humiliating or offensive.';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // Arabic diacritics
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

/**
 * Returns true if the prompt is safe to send. A false result means the request
 * should be politely refused. Pure and side-effect free for easy testing.
 */
export function isPromptAllowed(prompt: string): boolean {
  const n = normalize(prompt);
  return !BLOCKLIST.some((bad) => n.includes(normalize(bad)));
}
