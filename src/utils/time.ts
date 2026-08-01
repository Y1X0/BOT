import { env } from '../config/env';
import type { Locale } from '../locales';

const LOCALE_TAG: Record<Locale, string> = {
  ar: 'ar-SA',
  en: 'en-US',
};

/** Current wall-clock time formatted for the configured timezone. */
export function formatTime(locale: Locale, tz = env.DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: tz,
  }).format(new Date());
}

/** Current date, long form. */
export function formatDate(locale: Locale, tz = env.DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  }).format(new Date());
}

/** Weekday name. */
export function formatDay(locale: Locale, tz = env.DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    weekday: 'long',
    timeZone: tz,
  }).format(new Date());
}
