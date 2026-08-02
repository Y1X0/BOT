/** Pure helpers for the decision/fun tools. */

export const EIGHTBALL = [
  'نعم بالتأكيد ✅',
  'كل المؤشرات تقول نعم 👍',
  'على الأغلب نعم 🙂',
  'ربما 🤔',
  'لا أستطيع التنبؤ الآن 🌫',
  'اسأل مرة أخرى لاحقاً 🔁',
  'لا أعتقد ذلك 🙁',
  'الأرجح لا 👎',
  'بالتأكيد لا ❌',
  'ركّز وحاول مجدداً 🎯',
];

/** Split a free-text list of options on common Arabic/English separators. */
export function parseChoices(text: string): string[] {
  return text
    .split(/\s*[،,|]\s*|\s+(?:او|أو|ولا|or)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pick an element by an injectable rand (for tests). */
export function pick<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}
