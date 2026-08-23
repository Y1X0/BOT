import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { youtubeQueue } from '../../services/youtube/queue';
import { scSearch, scDownload, type ScItem } from '../../services/soundcloud';
import { archiveSearch, indexAudio } from '../../services/archive';
import { env } from '../../config/env';

const log = createLogger('plugin:soundcloud');
const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024; // ~50MB bot upload cap

// The bot's own @handle, appended to every song it sends (fetched once, cached).
let botHandle: string | null = null;
async function botTag(telegram: BotContext['telegram']): Promise<string> {
  if (botHandle === null) {
    botHandle = await telegram
      .getMe()
      .then((me) => (me.username ? `@${me.username}` : ''))
      .catch(() => '');
  }
  return botHandle;
}
/** Song caption with the bot's handle as a signature line. */
async function songCaption(telegram: BotContext['telegram'], title: string): Promise<string> {
  const tag = await botTag(telegram);
  return tag ? `🎵 ${title}\n${tag}` : `🎵 ${title}`;
}

const pending = new Map<string, ScItem[]>(); // `${chatId}:${msgId}` → results

const fmtDur = (s: number | null) => (s == null ? '' : ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`);

/** Song search & audio download from SoundCloud (a non-YouTube source). */
export const soundcloudPlugin: Plugin = {
  name: 'soundcloud',
  description: 'Search and download songs from SoundCloud',
  commands: [
    { command: 'song', description: '🎵 ابحث عن أغنية واختر من القائمة: /song اسم الأغنية' },
    { command: 'ytall', description: '⚡ أغنية فورية بلا اختيار: يوت اسم الأغنية' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('song', async (ctx) => {
      if (!ctx.chat) return;
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('🎵 اكتب اسم الأغنية:\n/song بابا الحاره   أو   اغنية اسم الأغنية');
      await postSongResults(ctx, query);
    });

    // "يوت" — instant: grab the top result and send it, no picking a list.
    bot.command('ytall', async (ctx) => {
      if (!ctx.chat) return;
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('⚡ اكتب اسم الأغنية وبتوصلك فوراً:\nيوت اسم الأغنية');
      await sendTopSong(ctx, query);
    });

    bot.action(/^sc:(\d+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const list = pending.get(key);
      const item = list?.[Number(ctx.match[1])];
      if (!item) return void ctx.answerCbQuery('انتهت الصلاحية، أعد البحث.').catch(() => undefined);
      pending.delete(key);
      await ctx.answerCbQuery('⏳ جاري التنزيل...').catch(() => undefined);
      const chatId = ctx.chat!.id;
      await ctx.editMessageText(`⏳ جاري تنزيل: ${item.title}`).catch(() => undefined);
      enqueueDownloadAndSend(ctx.telegram, chatId, item, ctx.callbackQuery.message?.message_id);
    });
  },
};

/** Download a SoundCloud item and send it as audio (queued), caching its file_id.
 *  If cleanupMsgId is given, that status message is deleted on success. */
function enqueueDownloadAndSend(
  telegram: BotContext['telegram'],
  chatId: number,
  item: ScItem,
  cleanupMsgId?: number,
): void {
  youtubeQueue.enqueue(
    chatId,
    async () => {
      const dl = await scDownload(item.url);
      if ('error' in dl) {
        await telegram.sendMessage(chatId, '⚠️ تعذّر تنزيل هذه الأغنية، جرّب وحدة ثانية.').catch(() => undefined);
        return;
      }
      try {
        const { size } = await stat(dl.filePath);
        if (size > TELEGRAM_SEND_LIMIT) {
          await telegram.sendMessage(chatId, '⚠️ الملف أكبر من الحد المسموح (50MB).').catch(() => undefined);
          return;
        }
        const caption = await songCaption(telegram, dl.title);
        const sent = await telegram.sendAudio(chatId, Input.fromLocalFile(dl.filePath), { title: dl.title, caption });
        // Dynamic cache: remember this file_id so the next request for the same
        // song is served instantly, no re-download.
        const fid = (sent as { audio?: { file_id?: string; duration?: number } }).audio;
        if (fid?.file_id) {
          void indexAudio({ fileId: fid.file_id, title: dl.title, duration: fid.duration ?? 0, source: 'cache' });
          // Also drop a copy into the archive channel so it's stored there too
          // (reuses the file_id — no re-upload). The channel indexer dedups it.
          if (env.MUSIC_STORAGE_CHANNEL_ID)
            void telegram
              .sendAudio(env.MUSIC_STORAGE_CHANNEL_ID, fid.file_id, { title: dl.title, caption: `🎵 ${dl.title}` })
              .catch(() => undefined);
        }
        if (cleanupMsgId != null) await telegram.deleteMessage(chatId, cleanupMsgId).catch(() => undefined);
      } catch (err) {
        log.error({ err }, 'soundcloud send failed');
        await telegram.sendMessage(chatId, '⚠️ حدث خطأ أثناء الإرسال.').catch(() => undefined);
      } finally {
        await dl.cleanup();
      }
    },
    3,
    20,
  );
}

/** "يوت" fast path: archive-first, else auto-pick the top SoundCloud result and
 *  send it directly — no keyboard, no choosing. */
async function sendTopSong(ctx: BotContext, query: string): Promise<void> {
  if (!ctx.chat) return;
  const status = await ctx.reply('⚡ عم جيب الأغنية…');
  if (await trySendFromArchive(ctx, query)) {
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => undefined);
    return;
  }
  const res = await scSearch(query, 5);
  if ('error' in res || !res.length) {
    return void ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, undefined, '❌ ما لقيت الأغنية، جرّب كلمات ثانية.')
      .catch(() => undefined);
  }
  const item = res[0];
  await ctx.telegram
    .editMessageText(ctx.chat.id, status.message_id, undefined, `⏳ جاري تنزيل: ${item.title}`)
    .catch(() => undefined);
  enqueueDownloadAndSend(ctx.telegram, ctx.chat.id, item, status.message_id);
}

/** Send a cached archive hit if there is one. Returns true if served from cache. */
async function trySendFromArchive(ctx: BotContext, query: string): Promise<boolean> {
  if (!ctx.chat) return false;
  const hit = await archiveSearch(query);
  if (!hit) return false;
  const caption = await songCaption(ctx.telegram, hit.title);
  const send =
    hit.kind === 'document'
      ? ctx.telegram.sendDocument(ctx.chat.id, hit.fileId, { caption })
      : ctx.telegram.sendAudio(ctx.chat.id, hit.fileId, { title: hit.title, caption });
  const ok = await send
    .then(() => true)
    .catch(() => false); // stale file_id → let the caller fall back to a live search
  return ok;
}

/** Search SoundCloud and post the pick-a-song keyboard (shared by /song and يوت). */
async function postSongResults(ctx: BotContext, query: string): Promise<void> {
  if (!ctx.chat) return;
  // Cache-first: instant if the song is already in the archive.
  if (await trySendFromArchive(ctx, query)) return;
  const status = await ctx.reply('🔎 جاري البحث في ساوندكلاود...');
  const res = await scSearch(query, 5);
  if ('error' in res) {
    const msg =
      res.error === 'notfound'
        ? '❌ ما لقيت نتائج، جرّب كلمات ثانية.'
        : res.error === 'notinstalled'
          ? '❌ أداة التنزيل غير مثبّتة.'
          : '⚠️ تعذّر البحث، حاول لاحقاً.';
    return void ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, msg).catch(() => undefined);
  }
  const rows = res.map((r, i) => [
    Markup.button.callback(`${i + 1}. ${r.title.slice(0, 45)}${fmtDur(r.duration)}`, `sc:${i}`),
  ]);
  pending.set(`${ctx.chat.id}:${status.message_id}`, res);
  await ctx.telegram
    .editMessageText(ctx.chat.id, status.message_id, undefined, '🎵 اختر أغنية للتنزيل:', Markup.inlineKeyboard(rows))
    .catch(() => undefined);
}
