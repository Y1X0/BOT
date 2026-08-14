import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { createLogger } from '../../core/logger';
import { env } from '../../config/env';
import { youtubeQueue } from '../../services/youtube/queue';
import { stat } from 'node:fs/promises';
import {
  searchPodcasts,
  fetchEpisodes,
  downloadAudio,
  compressAudio,
  type PodcastShow,
  type PodcastEpisode,
} from '../../services/podcast';

const log = createLogger('plugin:podcast');

const URL_SEND_LIMIT = 20 * 1024 * 1024; // Telegram fetches URLs up to ~20MB
const SOURCE_CAP = 300 * 1024 * 1024; // don't download sources larger than this to compress
// Configurable upload cap: 50MB on the cloud API, up to 2000MB with a local
// Bot API server (set MEDIA_UPLOAD_LIMIT_MB + TELEGRAM_API_ROOT).
const UPLOAD_LIMIT = env.MEDIA_UPLOAD_LIMIT_MB * 1024 * 1024;

// Short-lived selection state, keyed by `${chatId}:${messageId}`.
const showState = new Map<string, PodcastShow[]>();
const epState = new Map<string, PodcastEpisode[]>();

const fmtDur = (s: number | null) =>
  s == null ? '' : ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
const fmtSize = (b: number | null) => (b == null ? '' : ` ~${Math.round(b / 1024 / 1024)}MB`);

/** Podcast search + audio download (Apple directory → RSS enclosures). */
export const podcastPlugin: Plugin = {
  name: 'podcast',
  description: 'Search podcasts and download episodes as audio',
  commands: [
    { command: 'podcast', description: '🎙 ابحث عن بودكاست: /podcast فنجان' },
    { command: 'stories', description: '📻 بودكاست قصص واقعية' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('podcast', async (ctx) => {
      const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!query) {
        return void ctx.reply(
          '🎙 اكتب اسم البودكاست بعد الأمر:\n' +
            '/podcast فنجان\n/podcast قصص واقعية\n\n' +
            'أو استخدم «بودكاست اسم_البودكاست»، ولـ القصص الواقعية: /stories',
        );
      }
      await runSearch(ctx, query);
    });

    // Shortcut for real-life story podcasts.
    bot.command('stories', async (ctx) => {
      await runSearch(ctx, 'قصص واقعية');
    });

    // Show picked → list its latest episodes.
    bot.action(/^pod:s:(\d+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const show = showState.get(key)?.[Number(ctx.match[1])];
      if (!show) return void ctx.answerCbQuery('انتهت الصلاحية، أعد البحث.').catch(() => undefined);
      showState.delete(key);
      await ctx.answerCbQuery('⏳ جاري جلب الحلقات...').catch(() => undefined);
      await ctx.editMessageText(`🎙 «${show.name}» — جاري جلب الحلقات...`).catch(() => undefined);

      const eps = await fetchEpisodes(show.feedUrl, 8);
      if ('error' in eps) {
        return void ctx.editMessageText('⚠️ تعذّر جلب حلقات هذا البودكاست، جرّب واحداً آخر.').catch(() => undefined);
      }
      const rows = eps.map((e, i) => [
        Markup.button.callback(`${i + 1}. ${e.title.slice(0, 40)}${fmtDur(e.durationSec)}`, `pod:e:${i}`),
      ]);
      epState.set(`${ctx.chat!.id}:${ctx.callbackQuery.message!.message_id}`, eps);
      await ctx
        .editMessageText(`🎙 «${show.name}» — اختر حلقة:`, Markup.inlineKeyboard(rows))
        .catch(() => undefined);
    });

    // Episode picked → deliver the audio.
    bot.action(/^pod:e:(\d+)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const ep = epState.get(key)?.[Number(ctx.match[1])];
      if (!ep) return void ctx.answerCbQuery('انتهت الصلاحية، أعد البحث.').catch(() => undefined);
      epState.delete(key);
      await ctx.answerCbQuery('⏳ جاري التجهيز...').catch(() => undefined);
      await ctx.editMessageText(`⏳ جاري تجهيز: ${ep.title}`).catch(() => undefined);
      const chatId = ctx.chat!.id;
      const messageId = ctx.callbackQuery.message?.message_id;
      youtubeQueue.enqueue(chatId, () => deliver(ctx, chatId, messageId, ep), 3, 20);
    });
  },
};

async function runSearch(ctx: BotContext & { message: { text: string } }, query: string): Promise<void> {
  if (!ctx.chat) return;
  const status = await ctx.reply('🔎 جاري البحث عن البودكاست...');
  const res = await searchPodcasts(query, 8);
  if ('error' in res) {
    const msg = res.error === 'notfound' ? '❌ ما لقيت بودكاست بهذا الاسم، جرّب كلمات ثانية.' : '⚠️ تعذّر البحث، حاول لاحقاً.';
    return void ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, msg).catch(() => undefined);
  }
  const rows = res.map((s, i) => [
    Markup.button.callback(`${i + 1}. ${s.name.slice(0, 45)}`, `pod:s:${i}`),
  ]);
  showState.set(`${ctx.chat.id}:${status.message_id}`, res);
  await ctx.telegram
    .editMessageText(ctx.chat.id, status.message_id, undefined, '🎙 اختر البودكاست:', Markup.inlineKeyboard(rows))
    .catch(() => undefined);
}

/** Send an episode as audio, choosing URL send / upload / link by size. */
async function deliver(
  ctx: BotContext,
  chatId: number,
  messageId: number | undefined,
  ep: PodcastEpisode,
): Promise<void> {
  const tg = ctx.telegram;
  const caption = `🎙 ${ep.title}${fmtSize(ep.sizeBytes)}`;
  const clearStatus = () => (messageId ? tg.deleteMessage(chatId, messageId).catch(() => undefined) : undefined);

  // Small (or Telegram can fetch it): let Telegram pull the URL directly.
  if (ep.sizeBytes != null && ep.sizeBytes <= URL_SEND_LIMIT) {
    try {
      await tg.sendAudio(chatId, ep.audioUrl, { title: ep.title.slice(0, 64), caption });
      await clearStatus();
      return;
    } catch (err) {
      log.warn({ err }, 'url audio send failed — falling back to download');
    }
  }

  const sendLink = () =>
    tg
      .sendMessage(chatId, `🎙 ${ep.title}\n\nالحلقة طويلة جداً ولم أستطع ضغطها تحت الحد.\nرابط التحميل المباشر:\n${ep.audioUrl}`)
      .catch(() => undefined);

  // Mid-size that already fits the upload cap → download and upload as-is.
  if (ep.sizeBytes != null && ep.sizeBytes <= UPLOAD_LIMIT) {
    const dl = await downloadAudio(ep.audioUrl, UPLOAD_LIMIT);
    if (!('error' in dl)) {
      try {
        await tg.sendAudio(chatId, Input.fromLocalFile(dl.filePath), { title: ep.title.slice(0, 64), caption });
        await clearStatus();
        return;
      } catch (err) {
        log.error({ err }, 'podcast upload failed');
      } finally {
        await dl.cleanup();
      }
    }
  }

  // Big (or unknown-size): download the source and COMPRESS it to fit, so the
  // user still gets a playable file instead of a bare link.
  await tg.sendMessage(chatId, '🎧 الحلقة كبيرة — جاري ضغطها لتصلك كملف صوتي...').catch(() => undefined);
  const dl = await downloadAudio(ep.audioUrl, SOURCE_CAP);
  if ('error' in dl) {
    await sendLink();
    await clearStatus();
    return;
  }
  try {
    const compressed = await compressAudio(dl.filePath, ep.durationSec, UPLOAD_LIMIT - 2 * 1024 * 1024);
    const size = compressed ? await stat(compressed).then((s) => s.size).catch(() => Infinity) : Infinity;
    if (compressed && size <= UPLOAD_LIMIT) {
      await tg.sendAudio(chatId, Input.fromLocalFile(compressed), {
        title: ep.title.slice(0, 64),
        caption: `${caption} (مضغوط 🎧)`,
      });
      await clearStatus();
      return;
    }
    await sendLink();
    await clearStatus();
  } catch (err) {
    log.error({ err }, 'podcast compress/upload failed');
    await sendLink();
    await clearStatus();
  } finally {
    await dl.cleanup();
  }
}
