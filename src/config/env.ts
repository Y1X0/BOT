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

  // Bulk-import target: the channel the assistant copies imported audio into.
  // Also indexed like any other channel. 0 = no dedicated import target.
  MUSIC_STORAGE_CHANNEL_ID: z.coerce.number().default(0),

  // Index audio from EVERY channel the bot is admin in (default), not just the
  // storage channel. Set to false to restrict indexing to MUSIC_STORAGE_CHANNEL_ID.
  ARCHIVE_ALL_CHANNELS: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0')
    .pipe(z.boolean()),

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

  // Onboarding buttons: support contact (@user / username / full t.me link) and
  // an optional channel link. Shown on the bot's welcome message.
  SUPPORT_CONTACT: z.string().optional(),
  BOT_CHANNEL_URL: z.string().optional(),

  // Developer card (/dev · المطور). Identity of the bot's developer; all optional
  // — DEV_ID falls back to the first OWNER_IDS entry, and name/username/avatar are
  // pulled live from Telegram when not overridden here.
  DEV_ID: z.string().optional(), // Telegram user id of the developer
  DEV_NAME: z.string().optional(), // display name override
  DEV_USERNAME: z.string().optional(), // @handle override (with or without @)
  DEV_TITLE: z.string().default('مطوّر ومصمّم البوت'),
  DEV_TAGLINE: z.string().default('صُنع بإتقان وشغف'),
  DEV_CONTACT: z.string().optional(), // button link: @user / username / full URL

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
  // Cookies for login-gated downloads (Instagram, private/age-gated posts). Paste
  // a Netscape cookies.txt as DL_COOKIES_CONTENT, or point DL_COOKIES at a file.
  // Use a THROWAWAY account. yt-dlp only sends each cookie to its own domain.
  DL_COOKIES: z.string().optional(),
  DL_COOKIES_CONTENT: z.string().optional(),

  // Self keep-alive. Render's free web service hibernates after ~15 min with no
  // inbound HTTP — and while asleep the bot's long polling stops, so it goes
  // unresponsive until something wakes it. The bot pings its own public URL on
  // an interval to stay awake 24/7. Render injects RENDER_EXTERNAL_URL
  // automatically; KEEPALIVE_URL overrides it. On by default; set false to
  // disable (e.g. on a paid always-on plan, or to save free instance-hours).
  KEEPALIVE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  KEEPALIVE_URL: z.string().optional(),
  KEEPALIVE_INTERVAL_SEC: z.coerce.number().default(600), // 10 min (< Render's 15-min idle window)

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

  // Speech-to-text (voice/audio → text) via a hosted Whisper API. Groq's free
  // tier runs whisper-large-v3 fast and free (get a key at console.groq.com);
  // OpenAI is also supported. Reply «نص» to a voice message to transcribe it.
  TRANSCRIBE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TRANSCRIBE_PROVIDER: z.enum(['groq', 'openai']).default('groq'),
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().default('whisper-large-v3'),
  TRANSCRIBE_LANGUAGE: z.string().optional(), // '' = auto-detect; 'ar' to force Arabic
  TRANSCRIBE_MAX_MB: z.coerce.number().default(25),

  // Text-to-speech (text → natural voice-over). Default provider "edge" uses
  // Microsoft's neural voices — free, no key, great Arabic (incl. Jordanian
  // ar-JO-Taim/Sana). "elevenlabs" is a premium opt-in (needs TTS_API_KEY).
  TTS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TTS_PROVIDER: z.enum(['edge', 'elevenlabs', 'gemini']).default('edge'),
  TTS_VOICE: z.string().default('ar-EG-ShakirNeural'), // edge voice name / ElevenLabs voice id / Gemini voice (e.g. Kore)
  TTS_API_KEY: z.string().optional(), // ElevenLabs or Gemini (Google AI Studio) key
  TTS_MODEL: z.string().default('eleven_multilingual_v2'), // ElevenLabs model, or gemini-2.5-flash-preview-tts
  TTS_MAX_CHARS: z.coerce.number().default(2000),

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

  // Monetization: premium subscriptions + referral, paid in Telegram Stars (XTR).
  // Stars invoices use an EMPTY provider token, so no PSP setup is needed — just
  // flip this on. Prices/referral% are editable live from the dashboard; these
  // are only the initial defaults. Referral commission is a percent of each paid
  // subscription, credited to the referrer's wallet.
  PAYMENTS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  PREMIUM_PRICE_WEEK: z.coerce.number().default(75), // Stars
  PREMIUM_PRICE_MONTH: z.coerce.number().default(200), // Stars
  PREMIUM_PRICE_YEAR: z.coerce.number().default(1500), // Stars
  REFERRAL_PERCENT: z.coerce.number().default(20), // % of a paid sub credited to referrer

  // ── Stars reseller (buy Telegram Stars, paid in TON) ──────────────────────
  // The buyer sends TON (with a unique comment) to TON_WALLET_ADDRESS; the bot
  // detects the on-chain payment via toncenter, then fulfils. Detection is
  // read-only (safe). Auto-buy from Fragment is opt-in (FRAGMENT_AUTOBUY) and
  // needs the wallet mnemonic + Fragment cookies; when off/failed the owner
  // fulfils manually and the buyer's money is never lost.
  STARS_SELL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TON_WALLET_ADDRESS: z.string().optional(), // public address that receives payments
  TON_API_BASE: z.string().default('https://toncenter.com/api/v2'),
  TON_API_KEY: z.string().optional(), // toncenter API key (free at @tonapibot)
  STAR_PRICE_TON: z.coerce.number().default(0.006), // TON charged per Star (incl. your markup); editable in dashboard
  STARS_MIN: z.coerce.number().default(50),
  STARS_MAX: z.coerce.number().default(10000),
  ORDER_TTL_MIN: z.coerce.number().default(30), // payment window in minutes

  // Fragment auto-buy (opt-in). OFF by default — nothing risky runs until set.
  FRAGMENT_AUTOBUY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  FRAGMENT_COOKIES: z.string().optional(), // fragment.com session cookies (owner logged in + wallet connected)
  TON_MNEMONIC: z.string().optional(), // 24-word wallet mnemonic used to pay Fragment (SECRET)
  FRAGMENT_MAX_STARS: z.coerce.number().default(5000), // safety cap per auto-buy
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
