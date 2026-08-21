/**
 * Optional error monitoring. Fully dormant unless SENTRY_DSN is set — no DSN,
 * no network, no overhead. When set, unhandled errors and explicitly captured
 * ones are reported to Sentry with a stack trace, so you stop diagnosing the
 * bot by asking "what does the log say?".
 */
import { createLogger } from './logger';

const log = createLogger('sentry');

type SentryModule = typeof import('@sentry/node');
let sentry: SentryModule | null = null;

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const mod = await import('@sentry/node');
    mod.init({
      dsn,
      environment: process.env.NODE_ENV || 'production',
      release: process.env.RELEASE || undefined,
      // Errors only — no performance tracing overhead by default.
      tracesSampleRate: 0,
    });
    sentry = mod;
    log.info('Sentry error monitoring enabled');
  } catch (err) {
    log.warn({ err }, 'Sentry init failed');
  }
}

/** Report an error to Sentry (no-op when disabled). Never throws. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* monitoring must never break the caller */
  }
}

export function isSentryEnabled(): boolean {
  return sentry !== null;
}
