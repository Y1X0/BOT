import ar from './ar.json';
import en from './en.json';

export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const dictionaries: Record<Locale, Record<string, string>> = { ar, en };

/** Wrap a pre-built, trusted HTML snippet (e.g. a user mention) so translate()
 *  interpolates it verbatim instead of HTML-escaping it. */
export class Html {
  /** Duck-typing marker: survives module duplication where `instanceof` fails. */
  readonly isHtml = true as const;
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
export const raw = (html: string): Html => new Html(html);
const isHtmlValue = (v: unknown): v is Html =>
  typeof v === 'object' && v !== null && (v as { isHtml?: boolean }).isHtml === true;

export type Var = string | number | Html;

/**
 * Translate `key` for the given `locale`, interpolating `{var}` placeholders.
 * Falls back to Arabic, then to the key itself, so a missing string is never fatal.
 */
export function translate(locale: Locale, key: string, vars: Record<string, Var> = {}): string {
  const dict = dictionaries[locale] ?? dictionaries.ar;
  let template = dict[key] ?? dictionaries.ar[key] ?? key;

  // Styled strings carry HTML (<b>…</b>); escape interpolated values there so a
  // user's name/text can never break the markup. An Html value is trusted and
  // inserted verbatim. Plain strings interpolate as-is.
  const isHtml = /<\/?[a-z]/i.test(template);
  for (const [name, value] of Object.entries(vars)) {
    const v = isHtmlValue(value) ? value.value : isHtml ? escapeHtml(String(value)) : String(value);
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
  return (key: string, vars?: Record<string, Var>) => translate(locale, key, vars);
}

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
