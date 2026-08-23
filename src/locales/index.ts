import ar from './ar.json';
import en from './en.json';

export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const dictionaries: Record<Locale, Record<string, string>> = { ar, en };

/**
 * Translate `key` for the given `locale`, interpolating `{var}` placeholders.
 * Falls back to Arabic, then to the key itself, so a missing string is never fatal.
 */
export function translate(
  locale: Locale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const dict = dictionaries[locale] ?? dictionaries.ar;
  let template = dict[key] ?? dictionaries.ar[key] ?? key;

  // Styled strings carry HTML (<b>…</b>); escape interpolated values there so a
  // user's name/text can never break the markup. Plain strings interpolate as-is.
  const isHtml = /<\/?[a-z]/i.test(template);
  for (const [name, value] of Object.entries(vars)) {
    const v = isHtml ? escapeHtml(String(value)) : String(value);
    template = template.replaceAll(`{${name}}`, v);
  }
  return template;
}

/** Escape the five HTML-sensitive characters for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a translator bound to a locale. */
export function makeTranslator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
