import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { renderOwnerCardImage, renderOwnerCardVideo, getLastVideoError } from '../../services/idcard/image';
import { getAvatar, setAvatar } from '../../services/idcard/cache';
import { getMember } from '../../services/member.service';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:owner');

/** Per-group cache of the rendered owner card's file_id (image generation is
 *  costly, and the owner rarely changes). */
interface OwnerCacheEntry {
  fileId: string;
  kind: 'photo' | 'animation';
  name: string;
  url: string;
  at: number;
}
const cardCache = new Map<number, OwnerCacheEntry>();
const CACHE_TTL_MS = 600_000; // 10 minutes

type PhotoSize = { file_id: string; width: number };

/** Pick a mid-size avatar file_id (~320px) to keep the download light. */
function pickAvatarFileId(sizes?: PhotoSize[]): string | undefined {
  if (!sizes?.length) return undefined;
  const sorted = [...sizes].sort((a, b) => a.width - b.width);
  return (sorted.find((s) => s.width >= 320) ?? sorted[sorted.length - 1]).file_id;
}

const fmtNum = (n: number): string => n.toLocaleString('en-US');

/** Show a designed card for the group's creator (owner). */
export const ownerPlugin: Plugin = {
  name: 'owner',
  description: "Show a luxury card for the group's owner (creator)",
  commands: [{ command: 'owner', description: '👑 بطاقة مالك الجروب' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('owner', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') {
        await ctx.reply('👑 هذا الأمر يعمل داخل الجروب فقط.').catch(() => undefined);
        return;
      }
      await showOwnerCard(ctx);
    });

    // Owner diagnostic: clears the cache, renders the video fresh, and reports
    // whether ffmpeg produced it (and the last error if not) + running commit.
    bot.command('ownerdiag', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) return;
      if (ctx.chat) cardCache.delete(ctx.chat.id);
      const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'غير معروف').slice(0, 8);
      const sample = {
        name: ctx.from?.first_name || 'Owner',
        username: ctx.from?.username ? `@${ctx.from.username}` : '—',
        id: String(ctx.from?.id ?? 0),
        members: '1',
        date: '—',
        dateLabel: 'تاريخ الانضمام',
        initial: (ctx.from?.first_name?.trim()[0] || '?').toUpperCase(),
      };
      const t0 = Date.now();
      const vid = await renderOwnerCardVideo(sample).catch((e) => {
        log.warn({ e }, 'ownerdiag video threw');
        return null;
      });
      const ms = Date.now() - t0;
      const lines = [
        '🩺 <b>تشخيص بطاقة المالك</b>',
        `• الإصدار (commit): <code>${sha}</code>`,
        `• توليد الفيديو: <b>${vid ? 'يعمل ✅' : 'فشل ❌'}</b>`,
        vid ? `• الحجم: <b>${(vid.buffer.length / 1024).toFixed(0)}KB</b> خلال ${ms}ms` : `• آخر خطأ ffmpeg: <code>${escapeHtml(getLastVideoError() || 'غير معروف')}</code>`,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' }).catch(() => undefined);
      if (vid) {
        await ctx
          .replyWithAnimation({ source: vid.buffer, filename: `owner.${vid.ext}` }, { caption: '🎬 عيّنة الفيديو' })
          .catch((e) => ctx.reply(`تعذّر إرسال الفيديو: ${e instanceof Error ? e.message : e}`).catch(() => undefined));
      }
    });
  },
};

async function showOwnerCard(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat!.id;

  // FAST PATH: re-send the cached card by file_id (no admin lookup, no render).
  const cached = cardCache.get(chatId);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) {
    const kb = Markup.inlineKeyboard([Markup.button.url(cached.name, cached.url)]);
    const cap = '👑 مالك الجروب';
    const send = (extra: object): Promise<unknown> =>
      cached.kind === 'animation'
        ? ctx.replyWithAnimation(cached.fileId, extra)
        : ctx.replyWithPhoto(cached.fileId, extra);
    const resent = await send({ caption: cap, ...kb })
      // Button URL refused → resend the cached media without it.
      .catch(() => send({ caption: cap }).catch(() => null));
    if (resent) return;
    cardCache.delete(chatId); // stale file_id → re-render
  }

  // Find the creator among the chat administrators.
  const admins = await ctx.telegram.getChatAdministrators(chatId).catch((err) => {
    log.debug({ err, chatId }, 'getChatAdministrators failed');
    return null;
  });
  if (!admins) {
    await ctx.reply('⚠️ تعذّر جلب قائمة المشرفين. تأكّد أن البوت مشرف في الجروب وحاول ثانية.').catch(() => undefined);
    return;
  }
  const creator = admins.find((a) => a.status === 'creator');
  if (!creator) {
    // Migrated/anonymous groups can have no visible creator.
    await ctx
      .reply('👑 لا يوجد مالك ظاهر لهذا الجروب (قد يكون جروب مهاجر أو المالك مخفي).')
      .catch(() => undefined);
    return;
  }

  const user = creator.user;
  // Deleted accounts have no first_name / are flagged; Telegram sends id 0-ish
  // names as "Deleted Account".
  const isDeleted = !user || (!user.first_name && !user.username);
  if (isDeleted) {
    await ctx.reply('👑 مالك الجروب حسابه محذوف، لا يمكن عرض بطاقته.').catch(() => undefined);
    return;
  }

  const fullName = `${user.first_name ?? ''}${user.last_name ? ' ' + user.last_name : ''}`.trim() || 'المالك';
  const username = user.username ? `@${user.username}` : '—';
  const url = user.username ? `https://t.me/${user.username}` : `tg://user?id=${user.id}`;

  await ctx.sendChatAction('upload_photo').catch(() => undefined);

  // Members count + owner join date (creation date isn't exposed by the API).
  const [count, member, photos] = await Promise.all([
    ctx.telegram.getChatMembersCount(chatId).catch(() => 0),
    getMember(chatId, user.id).catch(() => null),
    ctx.telegram.getUserProfilePhotos(user.id, 0, 1).catch(() => null),
  ]);

  let dateLabel = 'تاريخ الانضمام';
  let date = '—';
  if (member?.joinedAt) {
    date = new Date(member.joinedAt).toLocaleDateString('ar');
  }

  // Owner avatar → data URI (reuse the id-card avatar cache).
  const photoFileId = pickAvatarFileId(photos?.photos?.[0] as PhotoSize[] | undefined);
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
        log.debug({ err }, 'owner avatar download failed');
      }
    }
  }

  const keyboard = Markup.inlineKeyboard([Markup.button.url(fullName, url)]);
  const cap = '👑 مالك الجروب';
  const cardData = {
    name: fullName,
    username,
    id: String(user.id),
    members: fmtNum(count),
    date,
    dateLabel,
    avatarDataUri,
    initial: (fullName.trim()[0] || '?').toUpperCase(),
  };

  // Preferred look: an ANIMATED video card (gold shine sweep). Falls back to the
  // still image if ffmpeg/render fails.
  try {
    const vid = await renderOwnerCardVideo(cardData).catch(() => null);
    if (vid) {
      // Send with the owner button; a rejected button URL (tg://user can be
      // refused) → resend the same media without it so the card still appears.
      const sent = await ctx
        .replyWithAnimation({ source: vid.buffer, filename: `owner.${vid.ext}` }, { caption: cap, ...keyboard })
        .catch(() => ctx.replyWithAnimation({ source: vid.buffer, filename: `owner.${vid.ext}` }, { caption: cap }));
      const animId = (sent as { animation?: { file_id?: string } }).animation?.file_id;
      if (animId) cardCache.set(chatId, { fileId: animId, kind: 'animation', name: fullName, url, at: Date.now() });
      return;
    }

    const png = await renderOwnerCardImage(cardData);
    const sent = await ctx
      .replyWithPhoto(Input.fromBuffer(png, 'owner.jpg'), { caption: cap, ...keyboard })
      .catch(() => ctx.replyWithPhoto(Input.fromBuffer(png, 'owner.jpg'), { caption: cap }));
    const fid = (sent as { photo?: { file_id: string }[] }).photo?.pop()?.file_id;
    if (fid) cardCache.set(chatId, { fileId: fid, kind: 'photo', name: fullName, url, at: Date.now() });
    return;
  } catch (err) {
    log.warn({ err }, 'owner card render failed; falling back to text');
  }

  // Text fallback — same information, no image.
  const lines = [
    '👑 <b>مالك الجروب</b>',
    '',
    `👤 الاسم: <b>${escapeHtml(fullName)}</b>`,
    `🔗 المعرّف: ${username === '—' ? 'لا يوجد' : escapeHtml(username)}`,
    `🆔 الآيدي: <code>${user.id}</code>`,
    `👥 عدد الأعضاء: <b>${fmtNum(count)}</b>`,
    `📅 ${dateLabel}: ${escapeHtml(date)}`,
  ];
  await ctx
    .reply(lines.join('\n'), { parse_mode: 'HTML', ...keyboard })
    .catch(() => ctx.reply(lines.join('\n').replace(/<[^>]+>/g, '')).catch(() => undefined));
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
