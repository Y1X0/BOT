/** Pure helpers for the reputation feature. */

const THANKS = [
  'شكرا', 'مشكور', 'مشكوره', 'تسلم', 'تسلمين', 'يسلمو', 'يعطيك العافيه',
  'يعطيكي العافيه', 'الله يعطيك العافيه', 'ثانكس', 'ثانكيو', 'thanks',
  'thank you', 'thx', 'tysm', 'شكرن',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

/** Does the text express thanks (any language token we recognize)? */
export function isThanks(text: string): boolean {
  const n = normalize(text);
  return THANKS.some((w) => n.includes(normalize(w)));
}

/** Milliseconds left on a cooldown, 0 if ready. */
export function cooldownLeft(lastTs: number | undefined, now: number, windowMs: number): number {
  if (lastTs === undefined) return 0;
  const left = windowMs - (now - lastTs);
  return left > 0 ? left : 0;
}
