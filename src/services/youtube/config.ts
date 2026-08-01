import { env } from '../../config/env';

/**
 * Runtime-adjustable YouTube limits. Seeded from env; `null` means "no limit".
 * Admins can change these live (see the /ytconfig command) without a redeploy.
 */
export interface YoutubeConfig {
  maxDuration: number | null; // seconds; null = unlimited
  maxSize: number | null; // bytes; null = unlimited
  maxResults: number; // search results to show
  concurrentDownloadsPerGroup: number; // queue workers per chat
  maxQueuePerGroup: number; // safety cap on pending jobs per chat
}

export const youtubeConfig: YoutubeConfig = {
  maxDuration: env.YT_MAX_DURATION_SEC > 0 ? env.YT_MAX_DURATION_SEC : null,
  maxSize: env.YT_MAX_SIZE_MB > 0 ? env.YT_MAX_SIZE_MB * 1024 * 1024 : null,
  maxResults: Math.min(Math.max(env.YT_MAX_RESULTS, 1), 25),
  concurrentDownloadsPerGroup: Math.max(env.YT_CONCURRENCY_PER_GROUP, 1),
  maxQueuePerGroup: 50,
};

/** Telegram's hard limit for files a normal bot can send (~50MB). */
export const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024;

/** Update a numeric config key. Accepts null (via "off"/"none") to unset limits. */
export function setConfig(key: keyof YoutubeConfig, value: number | null): boolean {
  if (!(key in youtubeConfig)) return false;
  if (key === 'maxDuration' || key === 'maxSize') {
    (youtubeConfig[key] as number | null) = value;
  } else {
    if (value == null || value < 1) return false;
    (youtubeConfig[key] as number) = value;
  }
  return true;
}
