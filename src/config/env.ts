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

  // Optional self-hosted Local Bot API server root (e.g. http://127.0.0.1:8081).
  // Required to upload files larger than 50MB — the cloud API caps bot uploads
  // at 50MB, a local server raises that to 2000MB.
  TELEGRAM_API_ROOT: z.string().optional(),
  // Max size (MB) the bot will try to UPLOAD. Keep at 50 for the cloud API;
  // raise it (e.g. 300) only when TELEGRAM_API_ROOT points at a local server.
  MEDIA_UPLOAD_LIMIT_MB: z.coerce.number().default(50),

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

  // YouTube audio search/download (requires yt-dlp + ffmpeg in the image)
  YT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  YTDLP_PATH: z.string().default('yt-dlp'),
  // 0 = unlimited. (Telegram's own bot API still caps sends at ~50MB unless a
  // local Bot API server is used.)
  YT_MAX_DURATION_SEC: z.coerce.number().default(0),
  YT_MAX_SIZE_MB: z.coerce.number().default(0),
  YT_MAX_RESULTS: z.coerce.number().default(10),
  // How many downloads run at once *per group* — so two members sending links
  // download in parallel instead of waiting in line. Higher = more CPU/RAM.
  YT_CONCURRENCY_PER_GROUP: z.coerce.number().default(3),
  // Anti-block: YouTube blocks datacenter IPs. Provide cookies to fix it.
  YT_COOKIES: z.string().optional(), // full Netscape cookies.txt content
  YT_COOKIES_FILE: z.string().optional(), // or a path to a cookies file
  YT_PLAYER_CLIENT: z.string().default(''), // e.g. "tv", "web_embedded", "android_vr"
  YT_PROXY: z.string().optional(), // e.g. http://user:pass@host:port (residential)
  YT_FORCE_IPV4: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Piped fallback engine: extracts via a Piped instance (different IP), so it
  // can succeed when yt-dlp is blocked on the server's datacenter IP.
  YT_PIPED_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  YT_PIPED_INSTANCES: z.string().optional(), // comma-separated API base URLs
  YT_INVIDIOUS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  YT_INVIDIOUS_INSTANCES: z.string().optional(),

  // Cobalt backend (self-hosted → own IP → bypasses YouTube's datacenter block).
  // Deploy Cobalt on Railway and put its API URL here, e.g. https://xxx.up.railway.app
  COBALT_API_URL: z.string().optional(),
  COBALT_API_KEY: z.string().optional(), // if the instance sets API_AUTH_REQUIRED

  // Generic link downloader (TikTok, Instagram Reels, X, Facebook, ...)
  DL_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  DL_AUTO: z // auto-download when a known short-video link is posted
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  DL_MAX_SIZE_MB: z.coerce.number().default(50),

  // Web dashboard (opt-in). Login via Telegram widget, owner-only.
  DASHBOARD_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  DASHBOARD_SECRET: z.string().optional(), // cookie signing key (falls back to BOT_TOKEN)

  // Message logging (owner monitor/media/logs). Opt-in — you are responsible
  // for informing group members and complying with local privacy law.
  MESSAGE_LOG_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  MESSAGE_LOG_RETENTION_DAYS: z.coerce.number().default(7),

  // Fun Image Editor (needs an image-generation API key to actually run)
  IMAGE_AI_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  IMAGE_PROVIDER: z
    .enum(['openai', 'gemini', 'pollinations', 'huggingface', 'cloudflare'])
    .default('openai'),
  IMAGE_API_KEY: z.string().optional(),
  IMAGE_CF_ACCOUNT_ID: z.string().optional(), // Cloudflare Workers AI account id
  IMAGE_MODEL: z.string().default('gpt-image-1'),
  IMAGE_SIZE: z.string().default('1024x1024'),
  IMAGE_DAILY_LIMIT: z.coerce.number().default(30), // per chat
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
