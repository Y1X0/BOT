import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { renderDevCardImage, renderDevCardVideo, getLastVideoError } from '../../services/idcard/image';
import { getAvatar, setAvatar } from '../../services/idcard/cache';
import { isBotOwner } from '../../utils/permissions';
import { env } from '../../config/env';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:developer');

/** Global cache of the rendered developer card (one developer for the whole
 *  bot — render once, re-send the file_id everywhere). */
interface DevCacheEntry {
  fileId: string;
  kind: 'photo' | 'animation';
  name: string;
  url?: string;
  at: number;
}
let cardCache: DevCacheEntry | null = null;
const CACHE_TTL_MS = 3_600_000; // 1 hour

type PhotoSize = { file_id: string; width: number };

function pickAvatarFileId(sizes?: PhotoSize[]): string | undefined {
  if (!sizes?.length) return undefined;
  const sorted = [...sizes].sort((a, b) => a.width - b.width);
  return (sorted.find((s) => s.width >= 320) ?? sorted[sorted.length - 1]).file_id;
}

/** Normalize @user / username / URL into a t.me/tg link, or undefined. */
function contactUrl(v?: string, fallbackId?: string): string | undefined {
  const s = (v ?? '').trim();
  if (s) {
    if (/^https?:\/\//i.test(s) || /^tg:\/\//i.test(s)) return s;
    const u = s.replace(/^@/, '');
    if (/^[a-zA-Z0-9_]{4,32}$/.test(u)) return `https://t.me/${u}`;
  }
  return fallbackId ? `tg://user?id=${fallbackId}` : undefined;
}

/** The developer's Telegram id: DEV_ID, else the first configured bot owner. */
function devId(): bigint | null {
  if (env.DEV_ID && /^\d+$/.test(env.DEV_ID)) return BigInt(env.DEV_ID);
  return env.OWNER_IDS[0] ?? null;
}

export const developerPlugin: Plugin = {
  name: 'developer',
  description: "Show a holographic animated card for the bot's developer",
  commands: [{ command: 'dev', description: '⚡ بطاقة مطوّر البوت' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('dev', async (ctx) => {
      await showDevCard(ctx);
    });

    // Diagnostic (owner-only): clear cache, render fresh, report ffmpeg status.
    bot.command('devdiag', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      cardCache = null;
      const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'غير معروف').slice(0, 8);
      const sample = {
        name: env.DEV_NAME || ctx.from?.first_name || 'Developer',
        username: ctx.from?.username ? `@${ctx.from.username}` : '—',
        id: String(devId() ?? ctx.from?.id ?? 0),
        title: env.DEV_TITLE,
        tagline: env.DEV_TAGLINE,
        initial: (env.DEV_NAME?.trim()[0] || ctx.from?.first_name?.trim()[0] || '?').toUpperCase(),
      };
      const t0 = Date.now();
      const vid = await renderDevCardVideo(sample).catch((e) => {
        log.warn({ e }, 'devdiag video threw');
        return null;
      });
      const ms = Date.now() - t0;
      const lines = [
        '🩺 <b>تشخيص بطاقة المطوّر</b>',
        `• الإصدار (commit): <code>${sha}</code>`,
        `• توليد الفيديو: <b>${vid ? 'يعمل ✅' : 'فشل ❌'}</b>`,
        vid ? `• الحجم: <b>${(vid.buffer.length / 1024).toFixed(0)}KB</b> خلال ${ms}ms` : `• آخر خطأ: <code>${escapeHtml(getLastVideoError() || 'غير معروف')}</code>`,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' }).catch(() => undefined);
      if (vid) {
        await ctx
          .replyWithAnimation({ source: vid.buffer, filename: `dev.${vid.ext}` }, { caption: '🎬 عيّنة الفيديو' })
          .catch((e) => ctx.reply(`تعذّر إرسال الفيديو: ${e instanceof Error ? e.message : e}`).catch(() => undefined));
      }
    });
  },
};

async function showDevCard(ctx: BotContext): Promise<void> {
  const cap = '⚡ مطوّر البوت';

  // FAST PATH: re-send the cached card by file_id.
  if (cardCache && Date.now() - cardCache.at <= CACHE_TTL_MS) {
    const c = cardCache;
    const kb = c.url ? Markup.inlineKeyboard([Markup.button.url(c.name, c.url)]) : undefined;
    const send = (extra: object): Promise<unknown> =>
      c.kind === 'animation' ? ctx.replyWithAnimation(c.fileId, extra) : ctx.replyWithPhoto(c.fileId, extra);
    const resent = await send({ caption: cap, ...(kb ?? {}) }).catch(() => send({ caption: cap }).catch(() => null));
    if (resent) return;
    cardCache = null; // stale file_id → re-render
  }

  const id = devId();
  if (!id) {
    await ctx.reply('⚠️ لم يتم ضبط هوية المطوّر بعد (DEV_ID أو OWNER_IDS).').catch(() => undefined);
    return;
  }

  await ctx.sendChatAction('upload_photo').catch(() => undefined);

  // Resolve the developer's live Telegram profile (name / username / avatar),
  // with env overrides taking precedence.
  let firstName = env.DEV_NAME || '';
  let username = env.DEV_USERNAME ? env.DEV_USERNAME.replace(/^@/, '') : '';
  let photoFileId: string | undefined;
  try {
    const chat = (await ctx.telegram.getChat(Number(id))) as {
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    if (!firstName) firstName = `${chat.first_name ?? ''}${chat.last_name ? ' ' + chat.last_name : ''}`.trim();
    if (!username && chat.username) username = chat.username;
  } catch (err) {
    log.debug({ err }, 'getChat(dev) failed — using env overrides only');
  }
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(Number(id), 0, 1);
    photoFileId = pickAvatarFileId(photos?.photos?.[0] as PhotoSize[] | undefined);
  } catch (err) {
    log.debug({ err }, 'dev avatar fetch failed');
  }

  const name = firstName || 'المطوّر';
  const handle = username ? `@${username}` : '—';
  const url = contactUrl(env.DEV_CONTACT || (username ? username : undefined), String(id));

  // Avatar → data URI (reuse the id-card avatar cache).
  let avatarDataUri: string | undefined;
  if (photoFileId) {
    avatarDataUri = getAvatar(photoFileId) ?? undefined;
    if (!avatarDataUri) {
      try {
        const link = await ctx.telegram.getFileLink(photoFileId);
        const res = await fetch(link.toString());
        if (res.ok) {
          avatarDataUri = `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
          setAvatar(photoFileId, avatarDataUri);
        }
      } catch (err) {
        log.debug({ err }, 'dev avatar download failed');
      }
    }
  }

  const keyboard = url ? Markup.inlineKeyboard([Markup.button.url(name, url)]) : undefined;
  const cardData = {
    name,
    username: handle,
    id: String(id),
    title: env.DEV_TITLE,
    tagline: env.DEV_TAGLINE,
    avatarDataUri,
    initial: (name.trim()[0] || '?').toUpperCase(),
  };

  try {
    const vid = await renderDevCardVideo(cardData).catch(() => null);
    if (vid) {
      const sent = await ctx
        .replyWithAnimation({ source: vid.buffer, filename: `dev.${vid.ext}` }, { caption: cap, ...(keyboard ?? {}) })
        .catch(() => ctx.replyWithAnimation({ source: vid.buffer, filename: `dev.${vid.ext}` }, { caption: cap }));
      const animId = (sent as { animation?: { file_id?: string } }).animation?.file_id;
      if (animId) cardCache = { fileId: animId, kind: 'animation', name, url, at: Date.now() };
      return;
    }

    const png = await renderDevCardImage(cardData);
    const sent = await ctx
      .replyWithPhoto(Input.fromBuffer(png, 'dev.jpg'), { caption: cap, ...(keyboard ?? {}) })
      .catch(() => ctx.replyWithPhoto(Input.fromBuffer(png, 'dev.jpg'), { caption: cap }));
    const fid = (sent as { photo?: { file_id: string }[] }).photo?.pop()?.file_id;
    if (fid) cardCache = { fileId: fid, kind: 'photo', name, url, at: Date.now() };
    return;
  } catch (err) {
    log.warn({ err }, 'dev card render failed; falling back to text');
  }

  // Text fallback.
  const lines = [
    '⚡ <b>مطوّر البوت</b>',
    '',
    `👤 الاسم: <b>${escapeHtml(name)}</b>`,
    `🔗 المعرّف: ${handle === '—' ? 'لا يوجد' : escapeHtml(handle)}`,
    `🆔 الآيدي: <code>${id}</code>`,
    `🎖 ${escapeHtml(env.DEV_TITLE)}`,
    `✦ ${escapeHtml(env.DEV_TAGLINE)} ✦`,
  ];
  await ctx
    .reply(lines.join('\n'), { parse_mode: 'HTML', ...(keyboard ?? {}) })
    .catch(() => ctx.reply(lines.join('\n').replace(/<[^>]+>/g, '')).catch(() => undefined));
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
