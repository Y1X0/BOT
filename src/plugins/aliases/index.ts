import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { isAwaitingWhisper } from '../whisper/state';
import { isAwaitingMusaraha } from '../musaraha/state';
import { isAwaitingStickerText } from '../sticker/state';
import { isAwaitingPackTitle } from '../stickerpack/state';
import { isAwaitingPdf } from '../pdf/state';

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
  { command: 'owner', triggers: ['المالك', 'مالك القروب', 'مالك الجروب', 'مالك المجموعه', 'owner'] },
  { command: 'dev', triggers: ['المطور', 'مطور البوت', 'المبرمج', 'مبرمج البوت', 'developer', 'dev'] },
  { command: 'story', triggers: ['ستوري', 'نزل ستوري', 'حفظ ستوري', 'حمل ستوري', 'story'] },
  { command: 'bio', triggers: ['بايو', 'البايو', 'نبذه', 'bio'] },
  { command: 'rules', triggers: ['القوانين', 'قوانين', 'الشروط'] },
  { command: 'help', triggers: ['مساعده', 'المساعده'] },
  { command: 'menu', triggers: ['القائمه', 'قائمه', 'الاوامر', 'اوامر', 'المنيو', 'الاقسام'] },
  { command: 'find', triggers: ['بحث', 'ابحث', 'دور على'] },
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
  { command: 'interaction', triggers: ['تفاعلي', 'تفاعلاتي', 'تفاعلك'] },
  { command: 'interactors', triggers: ['المتفاعلين', 'المتفاعلون', 'توب التفاعل', 'اكثر تفاعل'] },
  { command: 'levels', triggers: ['المستويات', 'توب المستويات'] },
  { command: 'balance', triggers: ['رصيدي', 'رصيد', 'فلوسي'] },
  { command: 'daily', triggers: ['يومي', 'مكافاتي', 'المكافاه', 'مكافاه'] },
  { command: 'top', triggers: ['الاغنياء', 'توب الفلوس', 'المتصدرين'] },
  { command: 'bank', triggers: ['البنك', 'بنك', 'حسابي'] },
  { command: 'deposit', triggers: ['ايداع', 'اودع', 'ايداع فلوس'] },
  { command: 'withdraw', triggers: ['سحب', 'اسحب', 'سحب فلوس'] },
  { command: 'rob', triggers: ['سرقه', 'اسرق', 'سرقة'] },
  { command: 'slots', triggers: ['سلوت', 'ماكينه', 'ماكينه الحظ'] },
  { command: 'work', triggers: ['اشتغل', 'شغل', 'وظيفه', 'عمل'] },
  { command: 'crime', triggers: ['جريمه', 'جريمة'] },
  { command: 'podcast', triggers: ['بودكاست', 'بودكاستات', 'بودكاست جديد'] },
  { command: 'stories', triggers: ['قصص واقعيه', 'قصص واقعية', 'قصص', 'قصه واقعيه'] },
  { command: 'spy', triggers: ['جاسوس', 'الجاسوس', 'لعبة الجاسوس', 'برة السالفه'] },
  { command: 'pet', triggers: ['حيواني', 'حيوان', 'اليفي', 'حيوان اليف'] },
  { command: 'feed', triggers: ['اطعم', 'طعمي', 'اطعام'] },
  { command: 'play', triggers: ['العب مع', 'لعب حيوان'] },
  { command: 'pettop', triggers: ['اقوى الحيوانات', 'توب الحيوانات'] },
  { command: 'type', triggers: ['كتابه سريعه', 'تحدي الكتابه', 'سباق كتابه'] },
  { command: 'guessmovie', triggers: ['خمن الفيلم', 'تخمين الافلام', 'خمن فيلم'] },
  { command: 'guesssong', triggers: ['خمن الاغنيه', 'تخمين الاغاني', 'خمن اغنيه'] },
  { command: 'pdf', triggers: ['pdf', 'بي دي اف', 'انشئ pdf', 'ملف pdf', 'اعمل pdf', 'مستند', 'اعمل مستند', 'وورد', 'ورد', 'word', 'بوربوينت', 'باوربوينت', 'عرض تقديمي', 'powerpoint'] },
  { command: 'stats', triggers: ['الاحصائيات', 'احصائيات', 'احصائيه'] },
  { command: 'activetop', triggers: ['الاكثر تفاعلا', 'النشطين'] },
  { command: 'quiz', triggers: ['سؤال', 'مسابقه', 'سؤال ثقافي'] },
  { command: 'guess', triggers: ['خمن', 'تخمين', 'لعبه التخمين'] },
  { command: 'rps', triggers: ['حجر ورقه مقص', 'حجره ورقه مقص', 'حجر ورق مقص'] },
  { command: 'notes', triggers: ['الملاحظات', 'ملاحظات'] },
  { command: 'afk', triggers: ['غائب', 'انا غائب', 'باك بعدين'] },
  { command: 'poll', triggers: ['تصويت', 'استفتاء'] },
  { command: 'decorate', triggers: ['زخرفه', 'زخرف', 'زخرفه كلمه'] },
  { command: 'whisper', triggers: ['اهمس', 'همس', 'همسه', 'همسة', 'ه'] },
  { command: 'musaraha', triggers: ['مصارحه', 'مصارحة', 'صارحني', 'رسايل مجهوله'] },
  { command: 'yt', triggers: ['yt'] },
  // "يوت"/"يوتيوب" → instant top result (SoundCloud, no cookies). "اغنيه" → list.
  { command: 'ytall', triggers: ['يوت', 'يوتيوب'] },
  { command: 'song', triggers: ['اغنيه', 'اغنية', 'صوت', 'موسيقى', 'اغاني'] },
  { command: 'archivelist', triggers: ['الارشيف', 'الأرشيف', 'ارشيف'] },
  // NB: bare "تنزيل" belongs to /unrank (bot ranks); download keeps نزل/حمل.
  { command: 'dl', triggers: ['نزل', 'حمل', 'نزلها', 'dl'] },
  { command: 'sticker', triggers: ['ملصق', 'ستيكر', 'حولها ملصق', 'sticker'] },
  { command: 'newpack', triggers: ['مجموعه جديده', 'انشئ مجموعه', 'مجموعه ملصقات'] },
  { command: 'newemoji', triggers: ['رموز مميزه', 'مجموعه رموز', 'ايموجي مميز'] },
  { command: 'mosaic', triggers: ['موزاييك', 'فسيفساء', 'بوستر رموز', 'صوره رموز', 'قص الصوره رموز'] },
  { command: 'mypack', triggers: ['مجموعتي', 'ملصقاتي'] },
  { command: 'myemoji', triggers: ['رموزي', 'رموزي المميزه'] },
  { command: 'saveemoji', triggers: ['احفظ رموز', 'خزن رموز', 'حفظ رموز'] },
  { command: 'pemoji', triggers: ['ارسل رموزي', 'ابعت رموزي', 'رموز مميزه'] },
  { command: 'clearemoji', triggers: ['امسح رموزي', 'مسح الرموز'] },
  { command: 'addsticker', triggers: ['اضف ملصق', 'اضف للمجموعه'] },
  { command: 'addemoji', triggers: ['اضف رمز', 'اضف ايموجي'] },
  // Telegram-native admin promote/demote (kept English-first; "رفع/تنزيل *"
  // now belong to the bot-rank system below).
  { command: 'promote', triggers: ['ترقيه', 'ترقية', 'رفع تيليجرام'] },
  { command: 'demote', triggers: ['تنزيل تيليجرام', 'تنزيل ترقية'] },
  // In-bot ranks — "رفع <رتبة>" (by reply). The rank word decides.
  { command: 'rvip', triggers: ['رفع مميز', 'رتبة مميز', 'رتبه مميز'] },
  { command: 'radmin', triggers: ['رفع ادمن', 'رفع ادمن بوت', 'رتبة ادمن', 'رتبه ادمن', 'رفع مشرف', 'رفع مشرف بوت', 'رتبة مشرف', 'رتبه مشرف'] },
  { command: 'rmanager', triggers: ['رفع مدير', 'رتبة مدير', 'رتبه مدير', 'مدير بوت'] },
  { command: 'rowner', triggers: ['رفع مالك', 'رتبة مالك', 'رتبه مالك', 'مالك بوت'] },
  { command: 'unrank', triggers: ['تنزيل', 'تنزيل رتبه', 'شيل رتبه', 'شيل الرتبه', 'حذف رتبه', 'سحب رتبه', 'ازالة رتبه'] },
  { command: 'roles', triggers: ['الرتب', 'رتب البوت', 'قائمه الرتب', 'رتب الاداره', 'مشرفين البوت'] },
  { command: 'setreply', triggers: ['رد مميز', 'احفظ رد مميز', 'حفظ رد مميز', 'رد بايموجي'] },
  { command: 'setidcardall', triggers: ['بطاقة ايدي للكل', 'بطاقة ايدي لكل القروبات', 'بطاقة عامه', 'ايدي لكل القروبات'] },
  { command: 'residcardall', triggers: ['رجع بطاقة ايدي للكل', 'رجع البطاقة العامه', 'ايدي افتراضي للكل'] },
  { command: 'idcardtheme', triggers: ['ثيم البطاقة', 'ثيم ايدي', 'لون البطاقة', 'الوان البطاقة'] },
  { command: 'idcardimage', triggers: ['بطاقة صوره', 'بطاقة صورة', 'ايدي صوره', 'كرت صوره'] },
  { command: 'idcardtext', triggers: ['بطاقة نص', 'بطاقة كتابه', 'ايدي نص', 'كرت نص'] },
  { command: 'setidcard', triggers: ['بطاقة ايدي', 'ضبط بطاقة ايدي', 'خصص ايدي', 'تخصيص الايدي'] },
  { command: 'residcard', triggers: ['رجع بطاقة ايدي', 'ايدي افتراضي', 'استرجاع الايدي'] },
  { command: 'idcardhelp', triggers: ['مساعدة الايدي', 'كيف اخصص الايدي', 'شرح بطاقة الايدي'] },
  { command: 'mute', triggers: ['كتم', 'اكتم', 'كتمه'] },
  { command: 'unmute', triggers: ['الغاء كتم', 'فك كتم', 'رفع كتم', 'الغاء الكتم'] },
  { command: 'warn', triggers: ['تحذير', 'انذار', 'حذره', 'نبهه'] },
  { command: 'unwarn', triggers: ['الغاء تحذير', 'فك تحذير', 'شيل تحذير', 'حذف تحذير'] },
  { command: 'warns', triggers: ['تحذيراته', 'تحذيرات العضو', 'كم تحذير'] },
  { command: 'restrict', triggers: ['تقييد', 'قيد', 'قيده'] },
  { command: 'unrestrict', triggers: ['الغاء تقييد', 'فك تقييد', 'رفع تقييد', 'الغاء التقييد'] },
  { command: 'ban', triggers: ['حظر', 'احظر', 'حظره'] },
  { command: 'unban', triggers: ['الغاء حظر', 'فك حظر', 'رفع حظر', 'الغاء الحظر'] },
  { command: 'kick', triggers: ['طرد', 'اطرد', 'طرده'] },
  // NB: «منع السب / فتح سب / منع روابط …» are handled by the unified quick-toggle
  // in the protection plugin — NOT aliased here (that would route to the old
  // on/off command and shadow the new behavior).
  { command: 'checkup', triggers: ['فحص', 'فحص البوت', 'تشخيص', 'حالة البوت'] },
  { command: 'speed', triggers: ['سرعه', 'سرعة البوت', 'فحص السرعه', 'فحص سرعه', 'قياس السرعه'] },
  { command: 'msgedits', triggers: ['التعديلات', 'الرسائل المعدله', 'ردودي المحفوظه'] },
  { command: 'guard', triggers: ['حارس', 'حماية قصوى', 'وضع الحارس', 'حارس الجروب'] },
  { command: 'guardall', triggers: ['حارس الكل', 'حماية كل القروبات'] },
  // Islamic
  { command: 'prayer', triggers: ['صلاه', 'مواقيت', 'وقت الصلاه', 'الصلاه'] },
  { command: 'ayah', triggers: ['ايه', 'آيه', 'ايه عشوائيه'] },
  { command: 'hadith', triggers: ['حديث', 'حديث شريف'] },
  { command: 'thikr', triggers: ['ذكر', 'ذكرني بالله'] },
  { command: 'athkar', triggers: ['اذكار', 'أذكار'] },
  { command: 'sabah', triggers: ['اذكار الصباح', 'أذكار الصباح', 'ذكر الصباح'] },
  { command: 'masa', triggers: ['اذكار المساء', 'أذكار المساء', 'ذكر المساء'] },
  { command: 'ayahtafsir', triggers: ['اية اليوم', 'آية اليوم', 'تفسير', 'اية وتفسير'] },
  { command: 'prayernotify', triggers: ['تنبيه الصلاه', 'تنبيهات الصلاه', 'منبه الصلاه'] },
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
  { command: 'ranks', triggers: ['رتب الجروب', 'مستويات الجروب'] },
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
  // Voice-chat music (streamed via the assistant account). Avoid bare "شغل"
  // (economy /work) and bare "اغنيه" (soundcloud /song) — use كول-specific phrases.
  { command: 'vcplay', triggers: ['تشغيل', 'شغل بالكول', 'شغل اغنيه بالكول', 'غني بالكول'] },
  { command: 'vcjoin', triggers: ['ضم المساعد', 'ضم الحساب', 'ضيف المساعد'] },
  { command: 'vcstart', triggers: ['افتح كول', 'افتح الكول', 'فتح كول', 'شغل كول'] },
  { command: 'vcstop', triggers: ['سكر كول', 'سكر الكول', 'اغلق الكول', 'انهي الكول', 'طلع من الكول'] },
  { command: 'vcskip', triggers: ['تخطي', 'الاغنيه التاليه', 'سكيب', 'اغنيه تاليه'] },
  { command: 'vcpause', triggers: ['وقف الاغنيه', 'ايقاف الاغنيه', 'وقف الكول'] },
  { command: 'vcresume', triggers: ['كمل الاغنيه', 'استكمال الاغنيه', 'كمل الكول'] },
  { command: 'vcqueue', triggers: ['قائمه التشغيل', 'طابور الاغاني', 'قائمه الكول'] },
  { command: 'vcremove', triggers: ['احذف من الطابور', 'شيل من الطابور'] },
  { command: 'vcclear', triggers: ['فرغ الطابور', 'مسح الطابور', 'فضي الطابور'] },
  { command: 'vccard', triggers: ['بطاقه', 'ايموجي البطاقه', 'ايموجي التشغيل'] },
  { command: 'vccardall', triggers: ['ايموجي عام', 'بطاقه عامه', 'ايموجي كل البوت'] },
  { command: 'premiumemoji', triggers: ['مميز', 'ايموجي مميز', 'حول لمميز'] },
  // Fun image editor
  { command: 'edit', triggers: ['تعديل', 'عدل الصوره', 'فن', 'محرر الصور'] },
  { command: 'imagine', triggers: ['تخيل', 'ولد صوره', 'ارسم', 'انشئ صوره'] },
  { command: 'imgmodel', triggers: ['موديل الصور', 'غير موديل الصور'] },
  { command: 'imgstyle', triggers: ['نمط الصور', 'ستايل الصور', 'انماط الصور'] },
  // Protection
  { command: 'lockdown', triggers: ['قفل الجروب', 'اقفل الجروب', 'اغلاق الجروب'] },
  { command: 'unlock', triggers: ['فتح الجروب', 'افتح الجروب'] },
  { command: 'antiraid', triggers: ['وضع الحمايه'] }, // «مكافحة الغارات» → quick-toggle
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

/** Commands whose Arabic triggers are common words — only fire them on a reply. */
const REPLY_ONLY_COMMANDS = new Set([
  '/promote',
  '/demote',
  '/mute',
  '/unmute',
  '/restrict',
  '/unrestrict',
  '/ban',
  '/unban',
  '/kick',
  '/radmin',
  '/rmanager',
  '/rowner',
  '/rvip',
  '/unrank',
  '/setreply',
  '/whisper', // اهمس/همسه/ه — always used as a reply to the target
]);

export const aliasesPlugin: Plugin = {
  name: 'aliases',
  description: 'Arabic natural-language triggers for commands (no slash needed)',

  register(bot: Telegraf<BotContext>) {
    bot.on(message('text'), async (ctx, next) => {
      // While a user is typing a whisper secret in DM, their text is data,
      // not a command — never rewrite it.
      if (ctx.from && (isAwaitingWhisper(ctx.from.id) || isAwaitingMusaraha(ctx.from.id))) return next();
      if (ctx.from && ctx.chat && isAwaitingStickerText(ctx.chat.id, ctx.from.id)) return next();
      if (ctx.from && isAwaitingPackTitle(ctx.from.id)) return next();
      // While the PDF wizard is collecting input, text is data — never rewrite it.
      if (ctx.from && isAwaitingPdf(ctx.from.id)) return next();
      // In DM, a native reply to the bot's own message is an interaction
      // (e.g. a musaraha reply/block), never a command — don't rewrite it.
      if (ctx.chat?.type === 'private') {
        const repliedFrom = (ctx.message as { reply_to_message?: { from?: { id?: number } } }).reply_to_message?.from?.id;
        if (repliedFrom != null && ctx.botInfo?.id != null && repliedFrom === ctx.botInfo.id) return next();
      }

      // Reuse the rate-limiter's already-computed result when present (it runs
      // matchAlias first to decide whether to throttle), else compute it now.
      const cached = (ctx.state as { aliasRewrite?: string | null }).aliasRewrite;
      const rewritten = cached !== undefined ? cached : matchAlias(ctx.message.text);
      if (rewritten) {
        const commandText = rewritten.split(' ')[0]; // e.g. "/joke"
        // Reply-only moderation triggers (كتم/حظر/طرد/تقييد…) are common Arabic
        // words. Only rewrite them when the message is an actual reply, so a
        // casual mention in chat never fires a staff action or a denial notice.
        const isReply = Boolean((ctx.message as { reply_to_message?: unknown }).reply_to_message);
        if (REPLY_ONLY_COMMANDS.has(commandText) && !isReply) return next();
        // Rewrite message so Telegraf's command handlers match it.
        type Ent = { type: string; offset: number; length: number; custom_emoji_id?: string };
        const msg = ctx.message as { text: string; entities?: Ent[] };
        const original = msg.text;
        const customEmoji = (msg.entities || []).filter((e) => e.type === 'custom_emoji');
        msg.text = rewritten;
        const entities: Ent[] = [{ type: 'bot_command', offset: 0, length: commandText.length }];
        // Preserve custom (premium) emoji in the args so commands like /vccard
        // can rebuild them — the rewrite replaces the whole entity list, which
        // would otherwise drop them. Offsets shift because the command word
        // differs in length from the Arabic trigger.
        const newArgsStart = commandText.length + 1; // after "/cmd "
        const argsStr = rewritten.slice(newArgsStart);
        if (argsStr && customEmoji.length && original.endsWith(argsStr)) {
          const delta = newArgsStart - (original.length - argsStr.length);
          for (const e of customEmoji) entities.push({ ...e, offset: e.offset + delta });
        }
        msg.entities = entities;
      }
      return next();
    });
  },
};
