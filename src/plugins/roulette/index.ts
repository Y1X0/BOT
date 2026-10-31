import type { Telegraf, Telegram } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { isBotOwner } from '../../utils/permissions';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:roulette');

const isGroup = (ctx: BotContext): boolean =>
  !!ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

const MIN_SECONDS = 10;
const MAX_SECONDS = 3600;
const MAX_NAME = 40;

interface Roulette {
  prize: string;
  hostId: number;
  participants: Map<number, string>; // userId → display name
  drawing: boolean;
  timer?: NodeJS.Timeout;
  endsAt?: number;
}
const rooms = new Map<string, Roulette>(); // `${chatId}:${msgId}`

const key = (chatId: number | string, msgId: number): string => `${chatId}:${msgId}`;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mentionOf = (id: number, name: string): string => `<a href="tg://user?id=${id}">${escapeHtml(name)}</a>`;

function keyboard(count: number, endsAt?: number) {
  const left = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : 0;
  const joinLabel = `🎰 دخول (${count})` + (endsAt ? ` · ⏳${left}ث` : '');
  return Markup.inlineKeyboard([
    [Markup.button.callback(joinLabel, 'rl:join')],
    [Markup.button.callback('🎲 سحب الآن', 'rl:draw'), Markup.button.callback('❌ إلغاء', 'rl:cancel')],
  ]);
}

function board(r: Roulette): string {
  return (
    '🎰 <b>روليت المسابقة</b>\n' +
    '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
    `🎁 <b>الجائزة:</b> ${escapeHtml(r.prize)}\n` +
    `👥 <b>المشتركون:</b> ${r.participants.size}\n` +
    (r.endsAt ? `⏳ <b>السحب بعد:</b> ${Math.max(0, Math.round((r.endsAt - Date.now()) / 1000))} ثانية\n` : '') +
    '\nاضغط <b>🎰 دخول</b> للمشاركة! 🍀'
  );
}

/** The spinning reveal + winner announcement. Shared by manual draw and the timer. */
async function runDraw(tg: Telegram, chatId: number | string, msgId: number): Promise<void> {
  const r = rooms.get(key(chatId, msgId));
  if (!r || r.drawing) return;
  r.drawing = true;
  if (r.timer) clearTimeout(r.timer);

  const edit = (text: string): Promise<unknown> =>
    tg.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML' }).catch(() => undefined);

  const ids = [...r.participants.keys()];
  const names = [...r.participants.values()];
  if (ids.length === 0) {
    await edit(`🎰 <b>روليت «${escapeHtml(r.prize)}»</b>\n\n❌ ما في مشتركين — انلغى السحب.`);
    rooms.delete(key(chatId, msgId));
    return;
  }

  const winnerId = ids[Math.floor(Math.random() * ids.length)];
  const winnerName = r.participants.get(winnerId) ?? 'الفائز';

  // Spin: cycle random names, slowing down, then land on the winner.
  const spinner = ['🎰', '🎡', '🎲', '🔄'];
  const frames = Math.min(14, 6 + ids.length);
  for (let i = 0; i < frames; i++) {
    const shown = names[Math.floor(Math.random() * names.length)];
    await edit(`${spinner[i % spinner.length]} <b>الروليت بتلفّ…</b>\n\n⬅️ ${escapeHtml(shown)} ➡️`);
    await delay(220 + i * 70); // ease-out
  }

  await edit(
    `🎉🏆 <b>روليت «${escapeHtml(r.prize)}»</b>\n` +
      '✦ ┈┈┈┈┈┈┈┈┈┈ ✦\n' +
      `🥇 <b>الفائز:</b> ${mentionOf(winnerId, winnerName)}\n` +
      `👥 من بين ${ids.length} مشترك\n\n🥳 مبروووك!`,
  );
  rooms.delete(key(chatId, msgId));
}

/** Only the host or a bot owner may draw/cancel. */
const canManage = (r: Roulette, userId: number): boolean => userId === r.hostId || isBotOwner(userId);

/**
 * 🎰 Roulette for contests: a host starts one (optionally timed), members join
 * via a button, then the bot does an animated spin and announces a random winner.
 */
export const roulettePlugin: Plugin = {
  name: 'roulette',
  description: 'Animated contest roulette: members join, bot spins and picks a winner',
  commands: [{ command: 'roulette', description: '🎰 روليت مسابقة: /roulette [ثواني] الجائزة' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('roulette', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) {
        return void ctx.reply('🎰 شغّل الروليت داخل جروب.').catch(() => undefined);
      }
      const rest = ctx.message.text.split(' ').slice(1);
      // Optional leading number = auto-draw after that many seconds.
      let seconds = 0;
      if (rest[0] && /^\d+$/.test(rest[0])) {
        seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(rest.shift())));
      }
      const prize = rest.join(' ').trim();
      if (!prize) {
        return void ctx
          .reply('🎰 اكتب الجائزة:\n<code>/roulette اشتراك بريميوم</code>\nأو بمؤقّت: <code>/roulette 60 اشتراك بريميوم</code>', {
            parse_mode: 'HTML',
          })
          .catch(() => undefined);
      }

      const r: Roulette = { prize: prize.slice(0, 200), hostId: ctx.from.id, participants: new Map(), drawing: false };
      if (seconds) r.endsAt = Date.now() + seconds * 1000;
      const sent = await ctx.reply(board(r), { parse_mode: 'HTML', ...keyboard(0, r.endsAt) }).catch(() => undefined);
      if (!sent) return;
      const k = key(ctx.chat!.id, sent.message_id);
      rooms.set(k, r);
      if (seconds) {
        const chatId = ctx.chat!.id;
        const msgId = sent.message_id;
        r.timer = setTimeout(() => void runDraw(ctx.telegram, chatId, msgId), seconds * 1000);
        r.timer.unref?.();
      }
    });

    bot.action('rl:join', async (ctx) => {
      const msgId = ctx.callbackQuery.message?.message_id;
      const r = msgId ? rooms.get(key(ctx.chat!.id, msgId)) : undefined;
      if (!r || r.drawing) return void ctx.answerCbQuery('انتهى هذا الروليت.').catch(() => undefined);
      if (r.participants.has(ctx.from.id)) return void ctx.answerCbQuery('أنت مشترك بالفعل ✅').catch(() => undefined);
      r.participants.set(ctx.from.id, displayName(ctx.from).slice(0, MAX_NAME));
      await ctx.answerCbQuery('تم دخولك للروليت! 🍀').catch(() => undefined);
      await ctx.telegram
        .editMessageText(ctx.chat!.id, msgId!, undefined, board(r), { parse_mode: 'HTML', ...keyboard(r.participants.size, r.endsAt) })
        .catch(() => undefined);
    });

    bot.action('rl:draw', async (ctx) => {
      const msgId = ctx.callbackQuery.message?.message_id;
      const r = msgId ? rooms.get(key(ctx.chat!.id, msgId)) : undefined;
      if (!r) return void ctx.answerCbQuery('انتهى هذا الروليت.').catch(() => undefined);
      if (!canManage(r, ctx.from.id)) return void ctx.answerCbQuery('فقط المضيف يقدر يسحب.', { show_alert: true }).catch(() => undefined);
      if (r.drawing) return void ctx.answerCbQuery('السحب شغّال…').catch(() => undefined);
      await ctx.answerCbQuery('يلّا نلفّ! 🎰').catch(() => undefined);
      // Detached isn't needed (spin ~8s < handler timeout), but guard errors.
      await runDraw(ctx.telegram, ctx.chat!.id, msgId!).catch((err) => log.error({ err }, 'roulette draw failed'));
    });

    bot.action('rl:cancel', async (ctx) => {
      const msgId = ctx.callbackQuery.message?.message_id;
      const r = msgId ? rooms.get(key(ctx.chat!.id, msgId)) : undefined;
      if (!r) return void ctx.answerCbQuery('انتهى هذا الروليت.').catch(() => undefined);
      if (!canManage(r, ctx.from.id)) return void ctx.answerCbQuery('فقط المضيف يقدر يلغي.', { show_alert: true }).catch(() => undefined);
      if (r.timer) clearTimeout(r.timer);
      rooms.delete(key(ctx.chat!.id, msgId!));
      await ctx.answerCbQuery('تم الإلغاء.').catch(() => undefined);
      await ctx.telegram
        .editMessageText(ctx.chat!.id, msgId!, undefined, `🎰 روليت «${escapeHtml(r.prize)}»\n\n❌ ألغاه المضيف.`, { parse_mode: 'HTML' })
        .catch(() => undefined);
    });
  },
};
