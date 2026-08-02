import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { pickRandom, displayName } from '../../utils/format';
import { awardGameWin } from '../../utils/progression';
import { EMOJI_PUZZLES, FLAGS, HANGMAN_WORDS } from './data';
import {
  matchAnswer,
  newHangman,
  maskWord,
  hangmanGuess,
  hangmanWon,
  hangmanLost,
  normalizeAr,
  type HangmanState,
} from './logic';

// Active puzzles per chat.
const emojiGames = new Map<number, { answers: string[]; clue: string }>();
const flagGames = new Map<number, { answers: string[]; clue: string }>();
const hangmanGames = new Map<number, HangmanState>();

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

/** New guessing games: emoji, flags, and hangman. */
export const newGamesPlugin: Plugin = {
  name: 'newgames',
  description: 'Emoji guess, flag guess, hangman',
  commands: [
    { command: 'emoji', description: '😄 خمّن بالإيموجي' },
    { command: 'flag', description: '🚩 خمّن العلم' },
    { command: 'hangman', description: '🔤 حبل المشنقة' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('emoji', async (ctx) => {
      if (!isGroup(ctx)) return;
      const p = pickRandom(EMOJI_PUZZLES);
      emojiGames.set(ctx.chat!.id, { answers: p.answers, clue: p.clue });
      await ctx.reply(`😄 خمّن الكلمة/الفيلم من الإيموجي:\n\n${p.clue}\n\nاكتب إجابتك في الشات.`);
    });

    bot.command('flag', async (ctx) => {
      if (!isGroup(ctx)) return;
      const p = pickRandom(FLAGS);
      flagGames.set(ctx.chat!.id, { answers: p.answers, clue: p.clue });
      await ctx.reply(`🚩 أي دولة هذا علمها؟\n\n${p.clue}\n\nاكتب اسم الدولة.`);
    });

    bot.command('hangman', async (ctx) => {
      if (!isGroup(ctx)) return;
      const word = pickRandom(HANGMAN_WORDS);
      const g = newHangman(word);
      hangmanGames.set(ctx.chat!.id, g);
      await ctx.reply(`🔤 حبل المشنقة!\n\n${maskWord(g)}\n\nخمّن حرفاً حرفاً (اكتب حرفاً)، أو اكتب الكلمة كاملة.\n❤️ ${g.max} محاولات.`);
    });

    // Passive answer capture. Consumes only correct/valid game input; else next().
    bot.on(message('text'), async (ctx, next) => {
      if (!isGroup(ctx)) return next();
      const chatId = ctx.chat!.id;
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return next();

      // Emoji / flag: match against accepted answers.
      for (const [map, emoji, points] of [
        [emojiGames, '😄', 15],
        [flagGames, '🚩', 12],
      ] as const) {
        const g = map.get(chatId);
        if (g && matchAnswer(text, g.answers)) {
          map.delete(chatId);
          if (ctx.from) await awardGameWin(ctx, points);
          await ctx.reply(`${emoji} إجابة صحيحة! ${displayName(ctx.from)} 🎉\nالجواب: ${g.answers[0]}`).catch(() => undefined);
          return; // consumed
        }
      }

      // Hangman.
      const hg = hangmanGames.get(chatId);
      if (hg) {
        const norm = normalizeAr(text);
        // Full-word attempt.
        if (norm === normalizeAr(hg.word)) {
          hangmanGames.delete(chatId);
          if (ctx.from) await awardGameWin(ctx, 20);
          await ctx.reply(`🔤 صحيح! الكلمة: «${hg.word}» 🎉\n${displayName(ctx.from)}`).catch(() => undefined);
          return;
        }
        // Single-letter guess.
        if (norm.length === 1 && /[؀-ۿ]/.test(norm)) {
          const res = hangmanGuess(hg, text);
          if (res === 'dup') {
            await ctx.reply('🔁 هذا الحرف مجرّب من قبل.').catch(() => undefined);
            return;
          }
          if (hangmanWon(hg)) {
            hangmanGames.delete(chatId);
            if (ctx.from) await awardGameWin(ctx, 20);
            await ctx.reply(`🔤 أحسنت! الكلمة: «${hg.word}» 🎉\n${displayName(ctx.from)}`).catch(() => undefined);
            return;
          }
          if (hangmanLost(hg)) {
            hangmanGames.delete(chatId);
            await ctx.reply(`💀 انتهت المحاولات! الكلمة كانت: «${hg.word}»`).catch(() => undefined);
            return;
          }
          const hearts = '❤️'.repeat(hg.max - hg.wrong) + '🖤'.repeat(hg.wrong);
          const missed = [...hg.missed].join(' ') || '—';
          await ctx.reply(`${res === 'hit' ? '✅' : '❌'} ${maskWord(hg)}\n${hearts}\nحروف خاطئة: ${missed}`).catch(() => undefined);
          return;
        }
      }

      return next();
    });
  },
};
