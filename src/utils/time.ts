import { env } from '../config/env';
import type { Locale } from '../locales';

const LOCALE_TAG: Record<Locale, string> = {
  ar: 'ar-SA',
  en: 'en-US',
};

/** Current wall-clock time formatted for the configured timezone (12-hour). */
export function formatTime(locale: Locale, tz = env.DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: tz,
  }).format(new Date());
}

/** Convert a 24-hour "HH:MM" string to 12-hour Arabic form, e.g. "1:30 م". */
export function to12h(time: string): string {
  const m = time.match(/(\d{1,2}):(\d{2})/);
  if (!m) return time;
  let h = Number(m[1]);
  const period = h >= 12 ? 'م' : 'ص';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${period}`;
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
