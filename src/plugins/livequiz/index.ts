import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { QUIZ_QUESTIONS, type QuizQuestion } from '../games/quiz-data';
import { addCoins } from '../../services/economy.service';
import { recordGameWin } from '../../services/member.service';
import { incMissionGames } from '../../services/missions.service';
import { displayName } from '../../utils/format';

interface LiveSession {
  questions: QuizQuestion[];
  index: number;
  scores: Map<number, { name: string; points: number }>;
  answered: boolean;
  timer?: NodeJS.Timeout;
}

const sessions = new Map<string, LiveSession>();
const QUESTION_TIME_MS = 25_000;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const liveQuizPlugin: Plugin = {
  name: 'livequiz',
  description: 'Live multi-question quiz competition',
  commands: [
    { command: 'quizstart', description: '🧠 بدء مسابقة مباشرة: /quizstart 5' },
    { command: 'quizstop', description: '🛑 إيقاف المسابقة', staffOnly: true },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('quizstart', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const key = String(ctx.chat.id);
      if (sessions.has(key)) return void ctx.reply('🧠 توجد مسابقة جارية بالفعل. /quizstop لإيقافها.');

      const count = Math.min(Math.max(parseInt(ctx.message.text.split(/\s+/)[1] ?? '5', 10) || 5, 1), 15);
      const questions = shuffle(QUIZ_QUESTIONS).slice(0, count);
      const session: LiveSession = { questions, index: 0, scores: new Map(), answered: false };
      sessions.set(key, session);
      await ctx.reply(`🧠 مسابقة مباشرة! ${questions.length} أسئلة.\nأول من يجيب صح يأخذ نقطة 🏆`);
      await askNext(ctx, key);
    });

    bot.command('quizstop', async (ctx) => {
      if (!ctx.chat) return;
      const key = String(ctx.chat.id);
      const s = sessions.get(key);
      if (!s) return void ctx.reply('لا توجد مسابقة جارية.');
      if (s.timer) clearTimeout(s.timer);
      sessions.delete(key);
      await ctx.reply('🛑 تم إيقاف المسابقة.');
    });

    // Answer checker.
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return next();
      const key = String(chat.id);
      const s = sessions.get(key);
      if (!s || s.answered) return next();
      const q = s.questions[s.index];
      const text = ctx.message.text.trim().toLowerCase();
      if (text.startsWith('/') || !q.answers.some((a) => a.toLowerCase() === text)) return next();

      // Correct!
      s.answered = true;
      if (s.timer) clearTimeout(s.timer);
      if (ctx.from) {
        const prev = s.scores.get(ctx.from.id) ?? { name: displayName(ctx.from), points: 0 };
        prev.points += 1;
        s.scores.set(ctx.from.id, prev);
      }
      await ctx.reply(`✅ صحيح يا ${displayName(ctx.from)}! (+1 نقطة)`);
      setTimeout(() => void askNext(ctx, key), 2500).unref?.();
      return; // consumed
    });
  },
};

async function askNext(ctx: BotContext, key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  if (s.index >= s.questions.length) {
    await finish(ctx, key);
    return;
  }
  const q = s.questions[s.index];
  s.answered = false;
  await ctx.reply(`🧠 سؤال ${s.index + 1}/${s.questions.length}:\n${q.question}`).catch(() => undefined);
  s.timer = setTimeout(async () => {
    const cur = sessions.get(key);
    if (!cur || cur.answered) return;
    cur.answered = true;
    await ctx.reply(`⏰ انتهى الوقت! الإجابة: ${q.answers[0]}`).catch(() => undefined);
    setTimeout(() => void askNext(ctx, key), 2000).unref?.();
  }, QUESTION_TIME_MS);
  s.timer.unref?.();
  s.index++;
}

async function finish(ctx: BotContext, key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  const ranked = [...s.scores.entries()].sort((a, b) => b[1].points - a[1].points);
  if (!ranked.length) {
    await ctx.reply('🧠 انتهت المسابقة بدون إجابات صحيحة.').catch(() => undefined);
    return;
  }
  const board = ranked
    .map(([, v], i) => `${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`} ${v.name} — ${v.points}`)
    .join('\n');
  const [winnerId, winner] = ranked[0];
  await ctx.reply(`🏆 انتهت المسابقة!\n\n${board}\n\n👑 الفائز: ${winner.name}`).catch(() => undefined);

  // Reward the winner (direct service calls — winner may not be ctx.from).
  if (ctx.chat) {
    await addCoins(ctx.chat.id, winnerId, 100).catch(() => undefined);
    await recordGameWin(ctx.chat.id, { id: winnerId, first_name: winner.name }, 25).catch(() => undefined);
    await incMissionGames(ctx.chat.id, winnerId).catch(() => undefined);
  }
}
