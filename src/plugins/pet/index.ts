import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { getBalance, addCoins } from '../../services/economy.service';
import {
  getPet,
  adoptPet,
  feedPet,
  playPet,
  setPetLevel,
  topPets,
  speciesFor,
  type LivePet,
} from '../../services/pet.service';
import { addPetXp, mood, bar, xpForLevel } from '../../services/pet-logic';

const FEED_COST = 20;
const FEED_HUNGER = 30;
const PLAY_HAPPY = 30;
const XP_GAIN = 6;

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** Virtual pet: adopt, feed, play, and level it up (ties into the economy). */
export const petPlugin: Plugin = {
  name: 'pet',
  description: 'Adopt and raise a virtual pet',
  commands: [
    { command: 'pet', description: '🐾 حيوانك الأليف: /pet [اسم]' },
    { command: 'feed', description: '🍖 أطعم حيوانك' },
    { command: 'play', description: '🎾 العب مع حيوانك' },
    { command: 'pettop', description: '🏆 أقوى الحيوانات' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('pet', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
      const pet = await getPet(ctx.chat!.id, ctx.from.id);
      if (!pet) {
        const name = arg || `حيوان ${displayName(ctx.from)}`;
        const adopted = await adoptPet(ctx.chat!.id, ctx.from.id, name, speciesFor(ctx.from.id));
        await ctx.reply(`🎉 تبنّيت حيواناً جديداً!\n${card(adopted)}\n\n🍖 /feed لإطعامه · 🎾 /play للعب معه`);
        return;
      }
      await ctx.reply(card(pet));
    });

    bot.command('feed', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const existing = await getPet(ctx.chat!.id, ctx.from.id);
      if (!existing) return void ctx.reply('ليس لديك حيوان بعد. اكتب /pet لتبنّي واحد 🐾');
      if (existing.hunger >= 100) return void ctx.reply(`${existing.species} ${existing.name} شبعان تماماً! 😋`);
      if ((await getBalance(ctx.chat!.id, ctx.from.id)) < FEED_COST) {
        return void ctx.reply(`🍖 الإطعام يكلّف ${FEED_COST} 💰 ورصيدك لا يكفي. جرّب /daily أو /work.`);
      }
      await addCoins(ctx.chat!.id, ctx.from.id, -FEED_COST);
      const pet = await feedPet(ctx.chat!.id, ctx.from.id, FEED_HUNGER, XP_GAIN);
      if (pet) await handleLevel(ctx, pet);
      await ctx.reply(`🍖 أطعمت ${pet?.species} ${pet?.name}! (-${FEED_COST} 💰)\n${card(pet!)}`);
    });

    bot.command('play', async (ctx) => {
      if (!isGroup(ctx) || !ctx.from) return;
      const existing = await getPet(ctx.chat!.id, ctx.from.id);
      if (!existing) return void ctx.reply('ليس لديك حيوان بعد. اكتب /pet لتبنّي واحد 🐾');
      const pet = await playPet(ctx.chat!.id, ctx.from.id, PLAY_HAPPY, XP_GAIN);
      if (pet) await handleLevel(ctx, pet);
      await ctx.reply(`🎾 لعبت مع ${pet?.species} ${pet?.name}! صار أسعد 😄\n${card(pet!)}`);
    });

    bot.command('pettop', async (ctx) => {
      if (!isGroup(ctx)) return;
      const list = await topPets(ctx.chat!.id, 10);
      if (!list.length) return void ctx.reply('لا توجد حيوانات في الجروب بعد. /pet لتبنّي واحد 🐾');
      const rows = list
        .map((p, i) => `${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`} ${p.species} ${p.name} — مستوى ${p.level}`)
        .join('\n');
      await ctx.reply(`🏆 أقوى الحيوانات:\n\n${rows}`);
    });
  },
};

/** Roll accumulated XP into levels and announce a level-up. Mutates `pet`. */
async function handleLevel(ctx: BotContext, pet: LivePet): Promise<void> {
  const res = addPetXp(pet.level, pet.xp, 0);
  if (res.level !== pet.level) {
    await setPetLevel(ctx.chat!.id, ctx.from!.id, res.level, res.xp);
    pet.level = res.level;
    pet.xp = res.xp;
    await ctx.reply(`🎊 ${pet.species} ${pet.name} وصل للمستوى ${res.level}!`).catch(() => undefined);
  }
}

function card(p: LivePet): string {
  return (
    `${p.species} ${p.name}\n` +
    `⭐️ المستوى: ${p.level}  (XP ${p.xp}/${xpForLevel(p.level)})\n` +
    `🍖 الجوع: ${bar(p.hunger)} ${p.hunger}%\n` +
    `😊 السعادة: ${bar(p.happiness)} ${p.happiness}%\n` +
    `💭 الحالة: ${mood(p.hunger, p.happiness)}`
  );
}
