import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { requireRole } from '../../utils/permissions';
import { indexAudio, archiveCount, archiveList, archiveRecent } from '../../services/archive';
import { escapeHtml } from '../../locales';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:musicarchive');

const STREAMER_URL = (process.env.STREAMER_URL || '').replace(/\/+$/, '');
const STREAMER_TOKEN = process.env.STREAMER_TOKEN || '';

/** POST to the streamer's control API. Returns the parsed body, or null on error. */
async function callStreamer(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!STREAMER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(`${STREAMER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(STREAMER_TOKEN ? { 'X-Token': STREAMER_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err, path }, 'streamer call failed');
    return { ok: false, error: 'unreachable' };
  }
}

type TgAudio = { file_id: string; title?: string; performer?: string; file_name?: string; duration?: number };
type TgDocument = { file_id: string; file_name?: string; mime_type?: string };

const AUDIO_EXT = /\.(mp3|m4a|flac|wav|ogg|opus|aac|wma|alac|aiff?)$/i;

/** Is this document actually an audio file (music channels often upload MP3s as
 *  documents, not as Telegram's native "audio" type)? */
function isAudioDoc(doc: TgDocument | undefined): doc is TgDocument {
  if (!doc?.file_id) return false;
  const mime = (doc.mime_type || '').toLowerCase();
  return mime.startsWith('audio/') || AUDIO_EXT.test(doc.file_name || '');
}

/** Auto-index audio posted to the storage channel, and expose the archive size. */
export const musicArchivePlugin: Plugin = {
  name: 'musicarchive',
  description: 'Index audio from the storage channel into the archive',
  commands: [
    { command: 'archivecount', description: '🗂 عدد الأغاني بالأرشيف (مالك)', staffOnly: true },
    { command: 'archivelist', description: '🔍 تصفّح/ابحث بالأرشيف: /archivelist [اسم] (مالك)', staffOnly: true },
    { command: 'archivediag', description: '🔧 تشخيص الأرشيف والإصدار (مالك)', staffOnly: true },
    { command: 'publisharchive', description: '📤 نشر آخر أصوات الأرشيف لقناة ببصمة البوت (مالك)', staffOnly: true },
    { command: 'import', description: '📥 استيراد أغاني من قناة للأرشيف (مالك)', staffOnly: true },
    { command: 'importstop', description: '🛑 إيقاف الاستيراد (مالك)', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    // Auto-index audio from channels. By default this covers EVERY channel the
    // bot is admin in (the bot only receives channel_post from those), so you
    // can post songs to any of your channels and they all feed one archive. Set
    // ARCHIVE_ALL_CHANNELS=false to restrict indexing to the storage channel.
    bot.on('channel_post', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      if (!env.ARCHIVE_ALL_CHANNELS && chatId !== env.MUSIC_STORAGE_CHANNEL_ID) return;
      const post = ctx.channelPost as { audio?: TgAudio; document?: TgDocument } | undefined;
      const audio = post?.audio;
      const doc = post?.document;
      let res: { indexed: boolean } | null = null;
      if (audio?.file_id) {
        res = await indexAudio({
          fileId: audio.file_id,
          title: audio.title || audio.file_name || 'غير معروف',
          artist: audio.performer ?? null,
          duration: audio.duration ?? 0,
          source: 'channel',
          kind: 'audio',
        });
      } else if (isAudioDoc(doc)) {
        res = await indexAudio({
          fileId: doc.file_id,
          title: (doc.file_name || 'غير معروف').replace(AUDIO_EXT, ''),
          duration: 0,
          source: 'channel',
          kind: 'document',
        });
      }
      if (res?.indexed) log.info({ chatId }, 'archived channel audio');
    });

    bot.command('archivecount', requireRole('founder'), async (ctx) => {
      const n = await archiveCount();
      await ctx.reply(`🗂 الأرشيف الصوتي: ${n} أغنية.`);
    });

    // One-shot diagnostic: what version is live, is the archive channel set, can
    // the bot post there, how many songs are stored. Resolves "did the deploy
    // land / why isn't a song archived" without guessing.
    bot.command('archivediag', requireRole('founder'), async (ctx) => {
      const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'غير معروف').slice(0, 8);
      const storage = env.MUSIC_STORAGE_CHANNEL_ID;
      const count = await archiveCount();
      let postTest = '—';
      if (storage) {
        postTest = await ctx.telegram
          .sendMessage(storage, '🔧 اختبار نشر — تجاهل هذه الرسالة')
          .then(() => 'ينشر ✅')
          .catch((e) => `فشل ❌ (${String((e as Error)?.message || e).slice(0, 70)})`);
      }
      await ctx.reply(
        '🔧 تشخيص الأرشيف:\n' +
          `• الإصدار (commit): ${sha}\n` +
          `• وضع البوت: ${env.BOT_MODE}\n` +
          `• قناة الأرشيف: ${storage || 'غير مضبوطة ❌'}\n` +
          `• النشر بالقناة: ${postTest}\n` +
          `• عدد الأغاني: ${count}\n` +
          `• فهرسة كل القنوات: ${env.ARCHIVE_ALL_CHANNELS ? 'مفعّل ✅' : 'معطّل'}\n` +
          '• التنسيق (bold): <b>يعمل</b> ✅',
      );
    });

    // Browse or search the archive: "/archivelist" → latest 20; "/archivelist نانسي"
    // → fuzzy matches. Lets the owner verify a song is stored.
    bot.command('archivelist', requireRole('founder'), async (ctx) => {
      const q = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const [list, total] = await Promise.all([archiveList(q || undefined, 20), archiveCount()]);
      if (!list.length) {
        return void ctx.reply(q ? `🔍 ما لقيت «${q}» بالأرشيف.` : '🗂 الأرشيف فاضي لسه.');
      }
      const dur = (s: number) => (s ? ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})` : '');
      const lines = list.map((e, i) => `${i + 1}. ${e.title}${e.artist ? ' — ' + e.artist : ''}${dur(e.duration)}`);
      const header = q
        ? `🔍 نتائج «${q}» (${list.length}):`
        : `🗂 آخر ${list.length} أغنية (المجموع ${total}):`;
      await ctx.reply(`${header}\n${lines.join('\n')}`);
    });

    // Re-publish the latest N archived audios into another channel, each stamped
    // with the surah/title and a CLICKABLE bot link (like a username).
    // Usage: /publisharchive -100xxxxxxxxxx [count]   (default 114)
    bot.command('publisharchive', requireRole('founder'), async (ctx) => {
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const target = parts[0];
      if (!target || !/^-100\d{5,}$/.test(target))
        return void ctx.reply('الاستخدام:\n<code>/publisharchive -100xxxxxxxxxx [العدد]</code>\nمثال: <code>/publisharchive -1001234567890 114</code>');
      const count = Math.min(Math.max(1, parseInt(parts[1] || '114', 10) || 114), 500);
      const channelId = Number(target);

      const me = await ctx.telegram.getMe();
      const uname = me.username;
      const botName = me.first_name || uname || 'البوت';
      const brand = uname
        ? `<a href="https://t.me/${uname}">🎧 ${escapeHtml(botName)}</a> · @${uname}`
        : `🎧 ${escapeHtml(botName)}`;

      const items = await archiveRecent(count);
      if (!items.length) return void ctx.reply('🗂 الأرشيف فاضي.');
      items.reverse(); // publish oldest-of-the-batch first, so the channel reads in order

      const status = await ctx.reply(`⏳ عم أنشر ${items.length} صوت للقناة… (بياخد شوي، لا تستعجل)`);
      const sid = status.message_id;
      const homeChat = ctx.chat!.id;

      // Detached: posting dozens of files takes minutes — don't block the handler.
      void (async () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const floodWait = (err: unknown): number => {
          const e = err as { parameters?: { retry_after?: number }; response?: { parameters?: { retry_after?: number } } };
          return e?.parameters?.retry_after ?? e?.response?.parameters?.retry_after ?? 0;
        };
        const sendOne = async (it: (typeof items)[number]): Promise<void> => {
          const caption = `📖 <b>${escapeHtml(it.title)}</b>\n\n${brand}`;
          if (it.kind === 'document') {
            await ctx.telegram.sendDocument(channelId, it.fileId, { caption, parse_mode: 'HTML' } as never);
          } else {
            await ctx.telegram.sendAudio(channelId, it.fileId, { caption, parse_mode: 'HTML', title: it.title, performer: botName } as never);
          }
        };

        let sent = 0;
        let failed = 0;
        const reasons = new Map<string, number>();
        for (const it of items) {
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            try {
              await sendOne(it);
              ok = true;
            } catch (err) {
              const wait = floodWait(err);
              if (wait > 0 && attempt === 0) {
                await sleep((wait + 1) * 1000); // Telegram flood — wait it out and retry once
                continue;
              }
              const msg = String((err as Error)?.message || err).slice(0, 60);
              reasons.set(msg, (reasons.get(msg) ?? 0) + 1);
              log.warn({ err, title: it.title }, 'publisharchive send failed');
            }
          }
          if (ok) sent++;
          else failed++;
          // If nothing sends at all early on, it's a config error — bail.
          if (sent === 0 && failed >= 3) {
            await ctx.telegram
              .editMessageText(homeChat, sid, undefined, '❌ تعذّر النشر. تأكد إنّ البوت أدمن بالقناة وإنّ الآيدي صحيح.')
              .catch(() => undefined);
            return;
          }
          if ((sent + failed) % 10 === 0) {
            await ctx.telegram.editMessageText(homeChat, sid, undefined, `⏳ ${sent + failed}/${items.length} (نُشر ${sent})…`).catch(() => undefined);
          }
          await sleep(2000); // ~1 msg/2s — safe for channel posting
        }
        const breakdown = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `• ${n}× ${escapeHtml(m)}`).join('\n');
        await ctx.telegram
          .editMessageText(
            homeChat,
            sid,
            undefined,
            `✅ تم نشر <b>${sent}</b> صوت${failed ? ` (تعذّر ${failed})` : ''}.` + (breakdown ? `\n\nأسباب الفشل:\n${breakdown}` : ''),
            { parse_mode: 'HTML' } as never,
          )
          .catch(() => undefined);
      })();
    });

    // Bulk-import audio from a source channel via the assistant account. The
    // streamer does the slow, ban-safe copying into the storage channel; the
    // bot's channel_post handler above then indexes each copied track. Progress
    // is relayed back through POST /import/progress.
    bot.command('import', requireRole('founder'), async (ctx) => {
      if (!STREAMER_URL)
        return void ctx.reply('🎧 خدمة البث مش مفعّلة (STREAMER_URL). الاستيراد يحتاجها.');
      if (!env.MUSIC_STORAGE_CHANNEL_ID)
        return void ctx.reply('⚠️ ما في قناة أرشيف مضبوطة (MUSIC_STORAGE_CHANNEL_ID).');
      const parts = ctx.message.text.split(/\s+/).slice(1);
      const source = parts[0];
      const limit = Math.max(1, Math.min(Number(parts[1]) || 50, 200));
      if (!source)
        return void ctx.reply(
          '📥 الاستخدام:\n/import <رابط أو @معرّف القناة> <العدد>\nمثال: /import @songs 100\n\nالاستيراد بطيء ومتحفّظ (الحظر أخطر من البطء).',
        );
      const r = await callStreamer('/import', { source, limit, notify_chat: ctx.chat.id });
      if (r?.ok) {
        await ctx.reply(`📥 بدأ الاستيراد من ${source} (حد ${r.limit ?? limit}). بوصلك تقدّم أول بأول.`);
      } else {
        const e = String(r?.error || 'unreachable');
        const msg =
          e === 'already_importing'
            ? '⏳ في استيراد شغّال حالياً. استنى يخلص أو /importstop.'
            : e === 'no_storage_channel'
              ? '⚠️ قناة الأرشيف مش مضبوطة عند خدمة البث.'
              : e === 'starting'
                ? '⏳ خدمة البث لسه عم تشتغل، جرّب بعد شوي.'
                : '⚠️ تعذّر بدء الاستيراد، تأكد من الرابط وخدمة البث.';
        await ctx.reply(msg);
      }
    });

    bot.command('importstop', requireRole('founder'), async (ctx) => {
      if (!STREAMER_URL) return void ctx.reply('🎧 خدمة البث مش مفعّلة.');
      const r = await callStreamer('/importstop', {});
      await ctx.reply(r?.ok ? '🛑 طلبت إيقاف الاستيراد.' : '⚠️ تعذّر إيقاف الاستيراد.');
    });
  },
};
