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

  for (const [name, value] of Object.entries(vars)) {
    template = template.replaceAll(`{${name}}`, String(value));
  }
  return template;
}

/** Build a translator bound to a locale. */
export function makeTranslator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
