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
  { command: 'help', triggers: ['مساعده', 'المساعده'] },
  { command: 'menu', triggers: ['القائمه', 'قائمه', 'الاوامر', 'اوامر', 'المنيو', 'الاقسام'] },
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
  { command: 'bank', triggers: ['البنك', 'بنك', 'حسابي'] },
  { command: 'deposit', triggers: ['ايداع', 'اودع', 'ايداع فلوس'] },
  { command: 'withdraw', triggers: ['سحب', 'اسحب', 'سحب فلوس'] },
  { command: 'rob', triggers: ['سرقه', 'اسرق', 'سرقة'] },
  { command: 'slots', triggers: ['سلوت', 'ماكينه', 'ماكينه الحظ'] },
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
  { command: 'yt', triggers: ['يوت', 'يوتيوب', 'اغنيه', 'صوت', 'yt'] },
  { command: 'dl', triggers: ['نزل', 'حمل', 'تنزيل', 'نزلها', 'dl'] },
  // Islamic
  { command: 'prayer', triggers: ['صلاه', 'مواقيت', 'وقت الصلاه', 'الصلاه'] },
  { command: 'ayah', triggers: ['ايه', 'آيه', 'ايه عشوائيه'] },
  { command: 'hadith', triggers: ['حديث', 'حديث شريف'] },
  { command: 'thikr', triggers: ['ذكر', 'ذكرني بالله'] },
  { command: 'athkar', triggers: ['اذكار', 'أذكار'] },
  { command: 'tasbeeh', triggers: ['تسبيح', 'سبح', 'مسبحه'] },
  // Toolbox
  { command: 'tr', triggers: ['ترجم', 'ترجمه', 'translate'] },
  { command: 'qr', triggers: ['باركود', 'كيو ار', 'qr'] },
  { command: 'currency', triggers: ['دولار', 'عمله', 'اسعار العملات', 'صرف'] },
  { command: 'crypto', triggers: ['بيتكوين', 'عمله رقميه', 'كريبتو'] },
  { command: 'remind', triggers: ['ذكرني', 'تذكير', 'ذكرني بعد'] },
  // Management / games
  { command: 'all', triggers: ['منشن', 'الكل', 'نداء'] },
  { command: 'admins', triggers: ['المشرفين', 'الادمن', 'الاداره'] },
  { command: 'xo', triggers: ['اكس او', 'xo', 'اكسو'] },
  { command: 'riddle', triggers: ['فزوره', 'لغز', 'فزورة'] },
  { command: 'wordchain', triggers: ['سلسله كلمات', 'سلسله', 'كلمات متسلسله'] },
  { command: 'emoji', triggers: ['خمن الايموجي', 'ايموجي', 'لعبه الايموجي'] },
  { command: 'flag', triggers: ['خمن العلم', 'علم', 'اعلام', 'لعبه الاعلام'] },
  { command: 'hangman', triggers: ['حبل المشنقه', 'المشنقه', 'خمن الكلمه'] },
  // Social / fun
  { command: 'compliment', triggers: ['مجامله', 'جاملني', 'قول شي حلو'] },
  { command: 'fortune', triggers: ['حظي', 'حظك اليوم', 'حظي اليوم', 'طالعي'] },
  { command: 'persona', triggers: ['من انا اليوم', 'شخصيتي اليوم', 'من انت اليوم'] },
  { command: 'soulmate', triggers: ['توام الروح', 'توام روحي', 'نصيبي'] },
  { command: 'setbirthday', triggers: ['ميلادي', 'سجل ميلادي', 'عيد ميلادي'] },
  { command: 'birthdays', triggers: ['اعياد الميلاد', 'المواليد', 'الاعياد'] },
  { command: 'weekly', triggers: ['تقرير اسبوعي', 'التقرير الاسبوعي', 'احصائيات الاسبوع'] },
  // Marriage
  { command: 'marry', triggers: ['زواج', 'اتزوج', 'تزوجني', 'اطلب الزواج'] },
  { command: 'divorce', triggers: ['طلاق', 'طلقني', 'انفصال'] },
  { command: 'marriage', triggers: ['زواجي', 'حالتي الاجتماعيه', 'شريكي'] },
  { command: 'couples', triggers: ['الازواج', 'ازواج الجروب', 'المتزوجين'] },
  // Reputation
  { command: 'rep', triggers: ['سمعه', 'احترام', 'نقطه احترام'] },
  { command: 'myrep', triggers: ['سمعتي', 'احترامي'] },
  { command: 'reptop', triggers: ['الاكثر احتراما', 'توب السمعه', 'المحترمين'] },
  // Support tickets
  { command: 'ticket', triggers: ['تذكره', 'شكوى', 'اقتراح', 'شكوه'] },
  { command: 'tickets', triggers: ['التذاكر', 'الشكاوى', 'الاقتراحات'] },
  // Ranks
  { command: 'ranks', triggers: ['الرتب', 'قائمه الرتب', 'رتب الجروب'] },
  { command: 'myrank', triggers: ['مرتبتي', 'رتبتي الحاليه'] },
  // Giveaway (avoid bare "سحب" — it's the economy withdraw alias)
  { command: 'giveaway', triggers: ['قرعه', 'سحب على', 'مسابقه سحب', 'هديه'] },
  { command: 'qotd', triggers: ['سؤال اليوم', 'سوال اليوم', 'سؤال نقاش'] },
  // Decision tools
  { command: '8ball', triggers: ['الكره السحريه', 'اسال الكره', 'كره سحريه'] },
  { command: 'choose', triggers: ['اختر', 'اختار', 'اختر لي', 'خير'] },
  // Countdown events
  { command: 'events', triggers: ['المناسبات', 'الفعاليات', 'العد التنازلي'] },
  // Utilities
  { command: 'calc', triggers: ['احسب', 'حاسبه', 'calc'] },
  { command: 'convert', triggers: ['حول', 'تحويل وحده'] },
  { command: 'password', triggers: ['باسورد', 'كلمه سر', 'password'] },
  { command: 'hijri', triggers: ['هجري', 'التاريخ الهجري', 'تاريخ هجري'] },
  { command: 'short', triggers: ['اختصر', 'اختصار', 'قصر الرابط'] },
  { command: 'mp3', triggers: ['حوله', 'صوت الفيديو', 'استخرج الصوت'] },
  // Progression / economy
  { command: 'shop', triggers: ['المتجر', 'متجر', 'المحل'] },
  { command: 'buy', triggers: ['اشتري', 'شراء'] },
  { command: 'title', triggers: ['لقب', 'القابي', 'العابي'] },
  { command: 'achievements', triggers: ['انجازاتي', 'الانجازات', 'انجازات'] },
  { command: 'missions', triggers: ['مهامي', 'المهام', 'مهام'] },
  { command: 'claim', triggers: ['استلم', 'استلام'] },
  { command: 'spin', triggers: ['عجله', 'عجله الحظ', 'دور'] },
  { command: 'groupreport', triggers: ['تقرير', 'تقرير الجروب'] },
  { command: 'schedule', triggers: ['جدول', 'جدوله'] },
  { command: 'schedules', triggers: ['المجدوله', 'الرسائل المجدوله'] },
  { command: 'quizstart', triggers: ['مسابقه', 'مسابقه مباشره', 'ابدا مسابقه'] },
  { command: 'mafia', triggers: ['مافيا', 'لعبه المافيا'] },
  // Fun image editor
  { command: 'edit', triggers: ['تعديل', 'عدل الصوره', 'فن', 'محرر الصور'] },
  { command: 'imagine', triggers: ['تخيل', 'ولد صوره', 'ارسم', 'انشئ صوره'] },
  // Protection
  { command: 'lockdown', triggers: ['قفل الجروب', 'اقفل الجروب', 'اغلاق الجروب'] },
  { command: 'unlock', triggers: ['فتح الجروب', 'افتح الجروب'] },
  { command: 'antiraid', triggers: ['مكافحة الغارات', 'وضع الحمايه'] },
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
