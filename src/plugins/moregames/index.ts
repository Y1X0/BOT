import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { recordActivity } from '../../services/member.service';
import { awardGameWin } from '../../utils/progression';
import { displayName, pickRandom } from '../../utils/format';
import { winner as xoWinner, bestMove, type Cell } from '../../services/xo-ai';

// ---------------- Tic-Tac-Toe (XO) ----------------
interface XoGame {
  board: Cell[];
  x?: number; // user id of X (the starter)
  o?: number; // user id of O
  turn: 'X' | 'O';
  vsBot?: boolean; // when true, O is the bot
}
const xoGames = new Map<string, XoGame>();
const CELL: Record<Cell, string> = { ' ': '▫️', X: '❌', O: '⭕️' };

function xoKeyboard(g: XoGame) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    rows.push(
      [0, 1, 2].map((c) => {
        const i = r * 3 + c;
        return Markup.button.callback(CELL[g.board[i]], `xo:${i}`);
      }),
    );
  }
  return Markup.inlineKeyboard(rows);
}

// ---------------- Riddles ----------------
const RIDDLES: Array<{ q: string; a: string }> = [
  { q: 'شيء كلما أخذت منه كبر؟', a: 'الحفرة' },
  { q: 'ما هو الشيء الذي يمشي ويقف وليس له أرجل؟', a: 'الساعة' },
  { q: 'له أوراق وليس نبات، وله جلد وليس حيوان؟', a: 'الكتاب' },
  { q: 'يكتب ولا يقرأ؟', a: 'القلم' },
  { q: 'شيء يوجد في وسط باريس؟', a: 'حرف الراء' },
  { q: 'ما هو البيت الذي ليس فيه أبواب ولا نوافذ؟', a: 'بيت الشعر' },
  { q: 'يزيد وينقص ولا يُرى؟', a: 'العمر' },
];

// ---------------- Word chain ----------------
interface WordChain {
  lastChar: string;
  used: Set<string>;
}
const wordChains = new Map<string, WordChain>();
const lastArabicChar = (w: string) => {
  const cleaned = w.trim().replace(/[ةً ]$/g, (c) => (c === 'ة' ? 'ه' : c)).trim();
  return cleaned.slice(-1);
};

export const moreGamesPlugin: Plugin = {
  name: 'moregames',
  description: 'Tic-tac-toe (XO), riddles, word chain',
  commands: [
    { command: 'xo', description: '⭕️❌ لعبة إكس-أو (شخصين)' },
    { command: 'riddle', description: '🧩 فزّورة' },
    { command: 'wordchain', description: '🔤 سلسلة كلمات' },
  ],

  register(bot: Telegraf<BotContext>) {
    // --- XO --- choose a mode first.
    bot.command('xo', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      await ctx.reply(
        '⭕️❌ إكس-أو — اختر نمط اللعب:',
        Markup.inlineKeyboard([
          [Markup.button.callback('🤖 ضد البوت', 'xostart:bot')],
          [Markup.button.callback('👥 ضد لاعب', 'xostart:pvp')],
        ]),
      );
    });

    bot.action(/^xostart:(bot|pvp)$/, async (ctx) => {
      if (!ctx.chat) return;
      const vsBot = ctx.match[1] === 'bot';
      const g: XoGame = { board: Array(9).fill(' '), turn: 'X', vsBot };
      if (vsBot) g.x = ctx.from.id; // starter is X (human); O is the bot
      await ctx.answerCbQuery().catch(() => undefined);
      const header = vsBot
        ? `⭕️❌ إكس-أو ضد البوت\nأنت ❌ — دورك`
        : '⭕️❌ إكس-أو\nأول لاعب يضغط = ❌، الثاني = ⭕️\nدور: ❌';
      const sent = await ctx.editMessageText(header, xoKeyboard(g)).catch(() => undefined);
      const messageId = typeof sent === 'object' && sent ? sent.message_id : ctx.callbackQuery.message?.message_id;
      if (messageId) xoGames.set(`${ctx.chat.id}:${messageId}`, g);
    });

    bot.action(/^xo:(\d)$/, async (ctx) => {
      const key = `${ctx.chat!.id}:${ctx.callbackQuery.message?.message_id}`;
      const g = xoGames.get(key);
      const uid = ctx.from.id;
      const pos = Number(ctx.match[1]);
      if (!g) return void ctx.answerCbQuery('انتهت اللعبة.').catch(() => undefined);

      // Assign players. In vs-bot mode only the human (X) may play.
      if (g.x === undefined) g.x = uid;
      else if (!g.vsBot && g.o === undefined && uid !== g.x) g.o = uid;
      const mark: 'X' | 'O' | null = uid === g.x ? 'X' : uid === g.o ? 'O' : null;
      if (!mark || (g.vsBot && mark !== 'X')) {
        return void ctx.answerCbQuery(g.vsBot ? 'هذه اللعبة ضد البوت 🤖' : 'اللعبة بين لاعبين فقط.', { show_alert: true }).catch(() => undefined);
      }
      if (mark !== g.turn) return void ctx.answerCbQuery('مو دورك ✋').catch(() => undefined);
      if (g.board[pos] !== ' ') return void ctx.answerCbQuery('الخانة محجوزة.').catch(() => undefined);

      g.board[pos] = mark;
      await ctx.answerCbQuery().catch(() => undefined);

      // Human move resolved? Check end state, else either hand over or let the bot play.
      if (await finishIfOver(ctx, key, g)) return;
      g.turn = g.turn === 'X' ? 'O' : 'X';

      if (g.vsBot && g.turn === 'O') {
        const move = bestMove(g.board, 'O');
        if (move >= 0) g.board[move] = 'O';
        if (await finishIfOver(ctx, key, g)) return;
        g.turn = 'X';
        await ctx.editMessageText('⭕️❌ إكس-أو ضد البوت\nدورك ❌', xoKeyboard(g)).catch(() => undefined);
        return;
      }
      await ctx.editMessageText(`⭕️❌ إكس-أو\nدور: ${CELL[g.turn]}`, xoKeyboard(g)).catch(() => undefined);
    });

    // --- Riddle (reveal via button) ---
    bot.command('riddle', async (ctx) => {
      const r = pickRandom(RIDDLES);
      await ctx.reply(
        `🧩 فزّورة:\n${r.q}`,
        Markup.inlineKeyboard([[Markup.button.callback('🔍 الإجابة', `rid:${Buffer.from(r.a).toString('base64')}`)]]),
      );
    });
    bot.action(/^rid:(.+)$/, async (ctx) => {
      const answer = Buffer.from(ctx.match[1], 'base64').toString('utf8');
      await ctx.answerCbQuery(`💡 ${answer}`, { show_alert: true }).catch(() => undefined);
    });

    // --- Word chain ---
    bot.command('wordchain', async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const starters = ['بيت', 'قلم', 'شمس', 'وردة', 'مطر'];
      const start = pickRandom(starters);
      wordChains.set(String(ctx.chat.id), { lastChar: lastArabicChar(start), used: new Set([start]) });
      await ctx.reply(`🔤 سلسلة الكلمات بدأت!\nالكلمة: «${start}»\nاكتب كلمة تبدأ بحرف: «${lastArabicChar(start)}»`);
    });

    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return next();
      const game = wordChains.get(String(chat.id));
      const word = ctx.message.text.trim();
      if (!game || word.startsWith('/') || /\s/.test(word) || word.length < 2) return next();
      // Only react to a plausible single Arabic word.
      if (!/^[؀-ۿ]+$/.test(word)) return next();

      if (word[0] !== game.lastChar) return next(); // not a continuation
      if (game.used.has(word)) {
        await ctx.reply('🔁 هذه الكلمة استُخدمت، جرّب غيرها.').catch(() => undefined);
        return;
      }
      game.used.add(word);
      game.lastChar = lastArabicChar(word);
      if (ctx.from) await recordActivity(chat.id, ctx.from, 3);
      await ctx.reply(`✅ ${displayName(ctx.from)}! التالي يبدأ بحرف: «${game.lastChar}»`).catch(() => undefined);
      return; // consumed
    });
  },
};

function boardText(g: XoGame): string {
  let s = '';
  for (let r = 0; r < 3; r++) s += g.board.slice(r * 3, r * 3 + 3).map((c) => CELL[c]).join('') + '\n';
  return s;
}

/**
 * If the board is won or full, end the game, announce it, award XP, and return
 * true. In vs-bot mode XP is only granted when the human (X) actually wins.
 */
async function finishIfOver(ctx: BotContext, key: string, g: XoGame): Promise<boolean> {
  const win = xoWinner(g.board);
  if (win) {
    xoGames.delete(key);
    if (!g.vsBot) await awardGameWin(ctx, 15);
    else if (win === 'X') await awardGameWin(ctx, 20); // beating a perfect bot is rare
    const verdict = g.vsBot
      ? win === 'X'
        ? '🎉 فزت على البوت! أسطورة!'
        : '🤖 البوت فاز! حظ أوفر المرة الجاية.'
      : `فاز ${CELL[win]}! 🎉`;
    await ctx.editMessageText(`⭕️❌ ${verdict}\n\n${boardText(g)}`).catch(() => undefined);
    return true;
  }
  if (!g.board.includes(' ')) {
    xoGames.delete(key);
    await ctx.editMessageText(`⭕️❌ تعادل 🤝\n\n${boardText(g)}`).catch(() => undefined);
    return true;
  }
  return false;
}
