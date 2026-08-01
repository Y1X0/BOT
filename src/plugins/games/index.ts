import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { awardGameWin } from '../../utils/progression';
import { addCoins } from '../../services/economy.service';
import { displayName, pickRandom } from '../../utils/format';
import { QUIZ_QUESTIONS } from './quiz-data';

/** Per-chat active game state (in-memory; games are ephemeral by design). */
interface GuessGame {
  number: number;
  min: number;
  max: number;
}
interface QuizGame {
  answers: string[];
  timer: NodeJS.Timeout;
}

const guessGames = new Map<string, GuessGame>();
const quizGames = new Map<string, QuizGame>();

const RPS_CHOICES = ['✊', '✋', '✌️'] as const;
const RPS_BEATS: Record<string, string> = { '✊': '✌️', '✋': '✊', '✌️': '✋' };

export const gamesPlugin: Plugin = {
  name: 'games',
  description: 'Rock-paper-scissors, number guessing, and quizzes',
  commands: [
    { command: 'rps', description: '✊✋✌️ حجر ورقة مقص' },
    { command: 'guess', description: '🔢 لعبة تخمين الرقم' },
    { command: 'quiz', description: '🧠 سؤال ثقافي' },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- Rock Paper Scissors (inline keyboard) ---
    bot.command('rps', async (ctx) => {
      if (!gamesEnabled(ctx)) return;
      const t = ctx.state.t!;
      await ctx.reply(
        t('games.rps_choose'),
        Markup.inlineKeyboard([RPS_CHOICES.map((c) => Markup.button.callback(c, `rps:${c}`))]),
      );
    });

    bot.action(/^rps:(.+)$/, async (ctx) => {
      const t = ctx.state.t!;
      const userChoice = ctx.match[1];
      if (!RPS_CHOICES.includes(userChoice as (typeof RPS_CHOICES)[number])) {
        await ctx.answerCbQuery().catch(() => undefined);
        return;
      }
      const botChoice = pickRandom([...RPS_CHOICES]);
      await ctx.answerCbQuery().catch(() => undefined);

      let text: string;
      if (userChoice === botChoice) {
        text = t('games.rps_draw', { choice: userChoice });
      } else if (RPS_BEATS[userChoice] === botChoice) {
        if (ctx.chat && ctx.from) await awardGameWin(ctx, 10);
        text = t('games.rps_win', {
          user: displayName(ctx.from),
          choice: userChoice,
          bot: '🤖',
          botChoice,
          xp: 10,
        });
      } else {
        text = t('games.rps_lose', { bot: '🤖', botChoice, user: displayName(ctx.from), choice: userChoice });
      }
      await ctx.editMessageText(text).catch(() => undefined);
    });

    // --- Number guessing ---
    bot.command('guess', async (ctx) => {
      if (!gamesEnabled(ctx) || !ctx.chat) return;
      const t = ctx.state.t!;
      const key = String(ctx.chat.id);
      const min = 1;
      const max = 100;
      guessGames.set(key, { number: randInt(min, max), min, max });
      await ctx.reply(t('games.guess_start', { min, max }));
    });

    // --- Quiz ---
    bot.command('quiz', async (ctx) => {
      if (!gamesEnabled(ctx) || !ctx.chat) return;
      const t = ctx.state.t!;
      const key = String(ctx.chat.id);
      if (quizGames.has(key)) {
        await ctx.reply(t('games.quiz_running'));
        return;
      }
      const q = pickRandom(QUIZ_QUESTIONS);
      const timer = setTimeout(async () => {
        quizGames.delete(key);
        await ctx.reply(t('games.quiz_timeout', { answer: q.answers[0] })).catch(() => undefined);
      }, 30_000);
      timer.unref?.();
      quizGames.set(key, { answers: q.answers.map((a) => a.toLowerCase()), timer });
      await ctx.reply(t('games.quiz_start', { question: q.question }));
    });

    // --- Answer checker for guess & quiz (passes through when not consumed) ---
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      const text = ctx.message.text.trim();
      if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup') || text.startsWith('/')) {
        return next();
      }
      const key = String(chat.id);
      const t = ctx.state.t!;

      // Quiz answer?
      const quiz = quizGames.get(key);
      if (quiz && quiz.answers.includes(text.toLowerCase())) {
        clearTimeout(quiz.timer);
        quizGames.delete(key);
        if (ctx.from) {
          if (ctx.state.settings?.economyEnabled) await addCoins(chat.id, ctx.from.id, 50);
          await awardGameWin(ctx, 20);
        }
        await ctx.reply(t('games.quiz_win', { name: displayName(ctx.from), xp: 20, coins: 50 }));
        return; // consumed
      }

      // Guess answer?
      const guess = guessGames.get(key);
      if (guess && /^\d+$/.test(text)) {
        const n = Number(text);
        if (n === guess.number) {
          guessGames.delete(key);
          if (ctx.from) {
            if (ctx.state.settings?.economyEnabled) await addCoins(chat.id, ctx.from.id, 30);
            await awardGameWin(ctx, 15);
          }
          await ctx.reply(
            t('games.guess_win', { name: displayName(ctx.from), number: guess.number, xp: 15, coins: 30 }),
          );
          return; // consumed
        }
        await ctx.reply(n < guess.number ? t('games.guess_higher') : t('games.guess_lower'));
        return; // consumed (it was a numeric guess during an active game)
      }

      return next();
    });
  },
};

function gamesEnabled(ctx: BotContext): boolean {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return true; // allow rps in DM
  return ctx.state.settings?.gamesEnabled ?? true;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
