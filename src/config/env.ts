import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Central, validated environment configuration.
 * The process exits early with a clear message if required vars are missing,
 * so we never boot into an undefined state.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Telegram
  BOT_TOKEN: z.string().min(20, 'BOT_TOKEN is required and must be a valid token'),
  BOT_USERNAME: z.string().optional(),

  // Bot owner(s) — comma separated Telegram user ids with global privileges
  OWNER_IDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => BigInt(s)),
    ),

  // Runtime mode: 'polling' (default, easiest) or 'webhook' (recommended for Render)
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  WEBHOOK_DOMAIN: z.string().optional(), // e.g. https://my-bot.onrender.com
  WEBHOOK_PATH: z.string().default('/telegraf'),
  WEBHOOK_SECRET: z.string().optional(),

  // HTTP server
  PORT: z.coerce.number().default(3000),

  // Database
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_URL: z.string().default('file:./data/bot.db'),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Optional external APIs
  WEATHER_API_KEY: z.string().optional(),
  DEFAULT_TIMEZONE: z.string().default('Asia/Riyadh'),
  DEFAULT_LANGUAGE: z.enum(['ar', 'en']).default('ar'),

  // AI (optional feature)
  AI_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  AI_DAILY_LIMIT: z.coerce.number().default(50), // per-chat daily AI calls cap

  // Rate limiting (global per-user command throttle)
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(2000),
  RATE_LIMIT_MAX: z.coerce.number().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Print a readable list of what's wrong and exit — never boot half-configured.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');

  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
