import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import { stat } from 'node:fs/promises';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { youtubeQueue } from '../../services/youtube/queue';
import { scSearch, scDownload, type ScItem } from '../../services/soundcloud';
import { searchPodcasts, registerShowResults } from '../podcast';
import { archiveSearch, indexAudio } from '../../services/archive';

const log = createLogger('plugin:soundcloud');
const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024; // ~50MB bot upload cap

const pending = new Map<string, ScItem[]>(); // `${chatId}:${msgId}` → results

const fmtDur = (s: number | null) => (s == null ? '' : ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`);

/** Song search & audio download from SoundCloud (a non-YouTube source). */
export const soundcloudPlugin: Plugin = {
  name: 'soundcloud',
  description: 'Search and download songs from SoundCloud',
  commands: [
    { command: 'song', description: '🎵 ابحث عن أغنية: /song اسم الأغنية' },
    { command: 'ytall', description: '🔎 ابحث بأغاني وبودكاست معاً: يوت اسم البحث' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('song', async (ctx) => {
      if (!ctx.chat) return;
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('🎵 اكتب اسم الأغنية:\n/song بابا الحاره   أو   اغنية اسم الأغنية');
      await postSongResults(ctx, query);
    });

    // "يوت" — one search, one merged list: songs (🎵 SoundCloud) + podcasts (🎙).
    bot.command('ytall', async (ctx) => {
      if (!ctx.chat) return;
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) return void ctx.reply('🔎 اكتب اسم الأغنية أو البودكاست:\nيوت اسم البحث');
      const status = await ctx.reply('🔎 عم دوّر بالأغاني والبودكاست…');
      // Cache-first: if the song is archived, send it instantly and skip the
      // SoundCloud song list (still show podcasts).
      const served = await trySendFromArchive(ctx, query);
      const [songsRes, showsRes] = await Promise.all([
        served ? Promise.resolve([] as ScItem[]) : scSearch(query, 5),
        searchPodcasts(query, 5).catch(() => ({ error: 'failed' as const })),
      ]);
      const songs = 'error' in songsRes ? [] : songsRes;
      const shows = 'error' in showsRes ? [] : showsRes;
      if (!songs.length && !shows.length) {
        return void ctx.telegram
          .editMessageText(
            ctx.chat.id,
            status.message_id,
            undefined,
            served ? '✅ بعتّها من الأرشيف 🎵' : '❌ ما لقيت ولا نتيجة، جرّب كلمات ثانية.',
          )
          .catch(() => undefined);
      }
      const rows = [
        ...songs.map((r, i) => [Markup.button.callback(`🎵 ${r.title.slice(0, 40)}${fmtDur(r.duration)}`, `sc:${i}`)]),
        ...shows.map((s, i) => [Markup.button.callback(`🎙 ${s.name.slice(0, 40)}`, `pod:s:${i}`)]),
      ];
      pending.set(`${ctx.chat.id}:${status.message_id}`, songs);
      registerShowResults(ctx.chat.id, status.message_id, shows);
      await ctx.telegram
        .editMessageText(
          ctx.chat.id,
          status.message_id,
          undefined,
          '🔎 اختر من النتائج:\n🎵 = أغنية  ·  🎙 = بودكاست',
          Markup.inlineKeyboard(rows),
        )
        .catch(() => undefined);
    });

    bot.action(/^sc:(\d+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const list = pending.get(key);
      const item = list?.[Number(ctx.match[1])];
      if (!item) return void ctx.answerCbQuery('انتهت الصلاحية، أعد البحث.').catch(() => undefined);
      pending.delete(key);
      await ctx.answerCbQuery('⏳ جاري التنزيل...').catch(() => undefined);
      const chatId = ctx.chat!.id;
      const telegram = ctx.telegram;
      await ctx.editMessageText(`⏳ جاري تنزيل: ${item.title}`).catch(() => undefined);

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
            const sent = await telegram.sendAudio(chatId, Input.fromLocalFile(dl.filePath), { title: dl.title, caption: `🎵 ${dl.title}` });
            // Dynamic cache: remember this file_id so the next request for the
            // same song is served instantly, no re-download.
            const fid = (sent as { audio?: { file_id?: string; duration?: number } }).audio;
            if (fid?.file_id) void indexAudio({ fileId: fid.file_id, title: dl.title, duration: fid.duration ?? 0, source: 'cache' });
            if (ctx.callbackQuery.message) await telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => undefined);
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
    });
  },
};

/** Send a cached archive hit if there is one. Returns true if served from cache. */
async function trySendFromArchive(ctx: BotContext, query: string): Promise<boolean> {
  if (!ctx.chat) return false;
  const hit = await archiveSearch(query);
  if (!hit) return false;
  const send =
    hit.kind === 'document'
      ? ctx.telegram.sendDocument(ctx.chat.id, hit.fileId, { caption: `🎵 ${hit.title}` })
      : ctx.telegram.sendAudio(ctx.chat.id, hit.fileId, { title: hit.title, caption: `🎵 ${hit.title}` });
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
