import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { pickRandom, displayName } from '../../utils/format';
import { awardGameWin } from '../../utils/progression';
import { matchAnswer } from '../newgames/logic';
import { MOVIES, SONGS, type MediaPuzzle } from './data';

interface Active {
  answers: string[];
  kind: 'movie' | 'song';
}
const games = new Map<number, Active>();

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

function start(ctx: BotContext, list: MediaPuzzle[], kind: 'movie' | 'song', label: string): Promise<unknown> {
  const p = pickRandom(list);
  games.set(ctx.chat!.id, { answers: p.answers, kind });
  return ctx.reply(`${label}\n\n${p.clue}\n\nاكتب إجابتك في الشات 👇`);
}

/** Guess the movie / song from an emoji clue. */
export const guessMediaPlugin: Plugin = {
  name: 'guessmedia',
  description: 'Guess the movie or song from emojis',
  commands: [
    { command: 'guessmovie', description: '🎬 خمّن الفيلم من الإيموجي' },
    { command: 'guesssong', description: '🎵 خمّن الأغنية من الإيموجي' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('guessmovie', async (ctx) => {
      if (isGroup(ctx)) await start(ctx, MOVIES, 'movie', '🎬 خمّن الفيلم من الإيموجي:');
    });
    bot.command('guesssong', async (ctx) => {
      if (isGroup(ctx)) await start(ctx, SONGS, 'song', '🎵 خمّن الأغنية من الإيموجي:');
    });

    bot.on(message('text'), async (ctx, next) => {
      if (!isGroup(ctx)) return next();
      const g = games.get(ctx.chat!.id);
      if (!g) return next();
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return next();
      if (!matchAnswer(text, g.answers)) return next();

      games.delete(ctx.chat!.id);
      if (ctx.from) await awardGameWin(ctx, g.kind === 'movie' ? 15 : 15);
      const emoji = g.kind === 'movie' ? '🎬' : '🎵';
      await ctx
        .reply(`${emoji} إجابة صحيحة! ${displayName(ctx.from)} 🎉\nالجواب: ${g.answers[0]}`)
        .catch(() => undefined);
      return; // consumed
    });
  },
};
