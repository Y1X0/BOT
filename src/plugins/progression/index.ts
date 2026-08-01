import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { getBalance } from '../../services/economy.service';
import { SHOP_ITEMS, buyItem, listOwned, equipTitle } from '../../services/shop.service';
import { listAchievements } from '../../services/achievements.service';
import { getMissions, MISSIONS, claimMission } from '../../services/missions.service';
import { getMember } from '../../services/member.service';
import { displayName } from '../../utils/format';

export const progressionPlugin: Plugin = {
  name: 'progression',
  description: 'Shop, titles, achievements, daily missions',
  commands: [
    { command: 'shop', description: '🛒 المتجر' },
    { command: 'buy', description: '💳 شراء: /buy king' },
    { command: 'title', description: '🏷 تجهيز لقب: /title vip' },
    { command: 'achievements', description: '🏆 إنجازاتك' },
    { command: 'missions', description: '📋 المهام اليومية' },
    { command: 'claim', description: '🎁 استلام مكافأة مهمة: /claim messages' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('shop', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const bal = ctx.from ? await getBalance(ctx.chat.id, ctx.from.id) : 0;
      const list = SHOP_ITEMS.map((i) => `• ${i.name} — ${i.price} 💰\n   /buy ${i.id}`).join('\n');
      await ctx.reply(`🛒 المتجر (رصيدك: ${bal} 💰)\n\n${list}`);
    });

    bot.command('buy', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const id = ctx.message.text.split(/\s+/)[1]?.trim() ?? '';
      const result = await buyItem(ctx.chat.id, ctx.from.id, id);
      if (result.ok) {
        await ctx.reply(`✅ اشتريت «${result.item.name}» وتم تجهيزه كلقب لك!`);
      } else {
        const msg = {
          not_found: '❌ لا يوجد عنصر بهذا الاسم. شاهد /shop',
          owned: 'ℹ️ تملك هذا العنصر بالفعل. جهّزه بـ /title',
          insufficient: '❌ رصيدك لا يكفي.',
        }[result.reason];
        await ctx.reply(msg);
      }
    });

    bot.command('title', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const id = ctx.message.text.split(/\s+/)[1]?.trim();
      if (!id) {
        const owned = await listOwned(ctx.chat.id, ctx.from.id);
        if (!owned.length) return void ctx.reply('لا تملك ألقاباً بعد. شاهد /shop');
        await ctx.reply('🏷 ألقابك:\n' + owned.map((i) => `• ${i.name} → /title ${i.id}`).join('\n'));
        return;
      }
      const ok = await equipTitle(ctx.chat.id, ctx.from.id, id);
      await ctx.reply(ok ? '✅ تم تجهيز اللقب.' : '❌ لا تملك هذا اللقب.');
    });

    bot.command('achievements', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const { unlocked, locked } = await listAchievements(ctx.chat.id, ctx.from.id);
      const u = unlocked.length ? unlocked.map((a) => `✅ ${a.name} — ${a.desc}`).join('\n') : 'لا شيء بعد';
      const l = locked.map((a) => `🔒 ${a.name} — ${a.desc} (+${a.coins}💰)`).join('\n');
      await ctx.reply(`🏆 إنجازات ${displayName(ctx.from)}:\n\n${u}\n\nالمتبقّي:\n${l}`);
    });

    bot.command('missions', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const p = await getMissions(ctx.chat.id, ctx.from.id);
      await ctx.reply(
        '📋 مهامك اليوم:\n\n' +
          `💬 ${MISSIONS.messages.label}: ${p.messages}/${MISSIONS.messages.target} ${p.claimedMessages ? '✅' : `(+${MISSIONS.messages.reward}💰 /claim messages)`}\n` +
          `🎮 ${MISSIONS.games.label}: ${p.games}/${MISSIONS.games.target} ${p.claimedGames ? '✅' : `(+${MISSIONS.games.reward}💰 /claim games)`}`,
      );
    });

    bot.command('claim', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private' || !ctx.from) return;
      const type = ctx.message.text.split(/\s+/)[1]?.trim();
      if (type !== 'messages' && type !== 'games') {
        return void ctx.reply('🎁 استخدم: /claim messages  أو  /claim games');
      }
      const r = await claimMission(ctx.chat.id, ctx.from.id, type);
      if (r.ok) await ctx.reply(`🎁 استلمت +${r.reward} 💰!`);
      else if (r.reason === 'already') await ctx.reply('ℹ️ استلمت هذه المكافأة اليوم.');
      else await ctx.reply('⏳ لم تكمل المهمة بعد.');
    });
  },
};

// Re-export a small helper so /rank can show the equipped title.
export async function memberTitle(chatId: number | bigint, userId: number | bigint): Promise<string | null> {
  const m = await getMember(chatId, userId);
  return m?.title ?? null;
}
