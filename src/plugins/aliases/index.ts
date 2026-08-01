import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isAwaitingWhisper } from '../whisper/state';

/**
 * Natural-language command aliases: lets users trigger commands by typing
 * plain Arabic words (no leading "/"). It works by rewriting a matching
 * message into the equivalent "/command args" — including the bot_command
 * entity Telegraf needs — then passing control to the normal command
 * handlers via next(). Zero duplication: every existing command is reused.
 *
 * Registered FIRST so its rewrite happens before any command handler runs.
 */

interface Alias {
  command: string;
  triggers: string[]; // Arabic phrases (may be multi-word)
}

// Order does not matter much: matching is word-exact after normalization.
const ALIASES: Alias[] = [
  { command: 'time', triggers: ['الوقت', 'وقت', 'الساعه', 'كم الساعه'] },
  { command: 'date', triggers: ['التاريخ', 'تاريخ', 'كم التاريخ'] },
  { command: 'day', triggers: ['اليوم', 'كم اليوم', 'شو اليوم', 'وش اليوم'] },
  { command: 'weather', triggers: ['الطقس', 'طقس', 'الجو', 'حاله الطقس'] },
  { command: 'id', triggers: ['ايدي', 'id', 'معلوماتي', 'معلوماتك', 'الايدي', 'ايديي'] },
  { command: 'rules', triggers: ['القوانين', 'قوانين', 'الشروط'] },
  { command: 'help', triggers: ['مساعده', 'الاوامر', 'اوامر', 'المساعده', 'قائمه الاوامر'] },
  { command: 'joke', triggers: ['نكته', 'اضحكني', 'نكت', 'نكته جديده'] },
  { command: 'quote', triggers: ['حكمه', 'اقتباس', 'حكمه اليوم'] },
  { command: 'fact', triggers: ['معلومه', 'معلومات', 'معلومه جديده'] },
  { command: 'flip', triggers: ['اقلب عمله', 'عمله', 'قرعه'] },
  { command: 'dice', triggers: ['نرد', 'زهر', 'حجر النرد'] },
  { command: 'rate', triggers: ['قيم', 'تقييم', 'رتب'] },
  { command: 'truth', triggers: ['صراحه', 'سؤال صراحه'] },
  { command: 'dare', triggers: ['تحدي', 'تحديني'] },
  { command: 'wyr', triggers: ['لو خيروك'] },
  { command: 'rank', triggers: ['نقاطي', 'مستواي', 'رتبتي', 'خبرتي'] },
  { command: 'levels', triggers: ['المستويات', 'توب المستويات'] },
  { command: 'balance', triggers: ['رصيدي', 'رصيد', 'فلوسي'] },
  { command: 'daily', triggers: ['يومي', 'مكافاتي', 'المكافاه', 'مكافاه'] },
  { command: 'top', triggers: ['الاغنياء', 'توب الفلوس', 'المتصدرين'] },
  { command: 'stats', triggers: ['الاحصائيات', 'احصائيات', 'احصائيه'] },
  { command: 'activetop', triggers: ['الاكثر تفاعلا', 'النشطين'] },
  { command: 'quiz', triggers: ['سؤال', 'مسابقه', 'سؤال ثقافي'] },
  { command: 'guess', triggers: ['خمن', 'تخمين', 'لعبه التخمين'] },
  { command: 'rps', triggers: ['حجر ورقه مقص', 'حجره ورقه مقص', 'حجر ورق مقص'] },
  { command: 'notes', triggers: ['الملاحظات', 'ملاحظات'] },
  { command: 'afk', triggers: ['غائب', 'انا غائب', 'باك بعدين'] },
  { command: 'poll', triggers: ['تصويت', 'استفتاء'] },
  { command: 'decorate', triggers: ['زخرفه', 'زخرف', 'زخرفه كلمه'] },
  { command: 'whisper', triggers: ['اهمس', 'همس', 'همسه'] },
];

/** Normalize Arabic text: strip diacritics/tatweel, unify alef/ya/ta-marbuta. */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // harakat
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

// Pre-normalize triggers, longest (most words) first so specific phrases win.
const NORMALIZED: Array<{ command: string; words: string[] }> = ALIASES.flatMap((a) =>
  a.triggers.map((t) => ({ command: a.command, words: normalize(t).split(' ') })),
).sort((x, y) => y.words.length - x.words.length);

/**
 * Resolve a plain-text message to a "/command args" string, or null if no
 * Arabic alias matches. Pure and side-effect free for easy testing.
 */
export function matchAlias(text: string): string | null {
  if (!text || text.startsWith('/')) return null;
  const words = text.split(/\s+/).filter(Boolean);
  const normWords = words.map(normalize);

  for (const alias of NORMALIZED) {
    const n = alias.words.length;
    if (normWords.length < n) continue;
    if (normWords.slice(0, n).join(' ') === alias.words.join(' ')) {
      const args = words.slice(n).join(' ');
      return args ? `/${alias.command} ${args}` : `/${alias.command}`;
    }
  }
  return null;
}

export const aliasesPlugin: Plugin = {
  name: 'aliases',
  description: 'Arabic natural-language triggers for commands (no slash needed)',

  register(bot: Telegraf<BotContext>) {
    bot.on(message('text'), async (ctx, next) => {
      // While a user is typing a whisper secret in DM, their text is data,
      // not a command — never rewrite it.
      if (ctx.from && isAwaitingWhisper(ctx.from.id)) return next();

      const rewritten = matchAlias(ctx.message.text);
      if (rewritten) {
        const commandText = rewritten.split(' ')[0]; // e.g. "/joke"
        // Rewrite message so Telegraf's command handlers match it.
        const msg = ctx.message as { text: string; entities?: unknown[] };
        msg.text = rewritten;
        msg.entities = [{ type: 'bot_command', offset: 0, length: commandText.length }];
      }
      return next();
    });
  },
};
