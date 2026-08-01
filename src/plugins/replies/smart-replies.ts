/**
 * Built-in "smart" replies shipped with the bot. Each rule has trigger
 * patterns (matched as substrings, case-insensitive) and a set of possible
 * responses (one chosen at random). Admins can extend these per-chat via
 * /addreply without touching code.
 */
export interface SmartRule {
  id: string;
  patterns: string[];
  responses: string[];
  /** Optional emoji reaction to add instead of / in addition to replying. */
  reaction?: string;
}

export const SMART_RULES: SmartRule[] = [
  {
    id: 'salam',
    patterns: ['السلام عليكم', 'سلام عليكم'],
    responses: ['وعليكم السلام ورحمة الله وبركاته 🌹', 'وعليكم السلام 🌸'],
  },
  {
    id: 'hi',
    patterns: ['هاي', 'هلا', 'اهلا', 'أهلا', 'مرحبا', 'مرحبتين'],
    responses: ['هلا والله 👋', 'أهلاً وسهلاً 🌟', 'حياك الله 🌹'],
  },
  {
    id: 'thanks',
    patterns: ['شكرا', 'شكراً', 'يعطيك العافية', 'مشكور', 'تسلم'],
    responses: ['العفو 🌷', 'حياك الله 🙏', 'لا شكر على واجب 😊'],
  },
  {
    id: 'whoami',
    patterns: ['مين أنا', 'مين انا', 'من أنا'],
    responses: ['إنت نجم الجروب ✨', 'إنت شخص مهم جداً هنا 😄'],
  },
  {
    id: 'news',
    patterns: ['شو الأخبار', 'شو الاخبار', 'كيف الأحوال', 'كيف الاحوال', 'شخبارك'],
    responses: ['كله تمام الحمد لله 🌟', 'بخير والجروب عامر فيكم 💬'],
  },
  {
    id: 'goodnight',
    patterns: ['تصبحون على خير', 'تصبح على خير', 'تصبحوا على خير'],
    responses: ['وأنت من أهله 🌙', 'تصبح على خير وأحلام سعيدة 😴🌟'],
    reaction: '🌙',
  },
  {
    id: 'congrats',
    patterns: ['مبروك', 'مبارك', 'الف مبروك', 'ألف مبروك'],
    responses: ['🎉 مبروووك! عقبال المزيد 🥳', 'ألف مبروك 🎊'],
    reaction: '🎉',
  },
  {
    id: 'morning',
    patterns: ['صباح الخير', 'صباح النور'],
    responses: ['صباح الخير والسعادة ☀️', 'صباح الورد 🌹'],
  },
  {
    id: 'evening',
    patterns: ['مساء الخير', 'مساء النور'],
    responses: ['مساء الخير والأنوار 🌆', 'مساء الورد والياسمين 🌸'],
  },
  {
    id: 'welcome_back',
    patterns: ['وينك', 'وحشتنا', 'اشتقنا', 'غايب'],
    responses: ['حياك الله، نورت 🌟', 'الله يسلمك، مشغول شوي 😅', 'موجود موجود 💬'],
  },
  {
    id: 'love',
    patterns: ['احبك', 'أحبك', 'بحبك', 'تسلم يا غالي'],
    responses: ['والله يخليك 🌹', 'أنت أغلى ❤️', 'الله يحبك 😊'],
  },
  {
    id: 'sorry',
    patterns: ['اسف', 'آسف', 'سامحني', 'معذرة'],
    responses: ['ولا يهمك، صار خير 🤝', 'ما فيه شي، الأمور طيبة 🌷'],
  },
  {
    id: 'bye',
    patterns: ['مع السلامة', 'في أمان الله', 'باي', 'الله يحفظك'],
    responses: ['في أمان الله 👋', 'مع السلامة، عودة حميدة 🌟'],
  },
  {
    id: 'ramadan',
    patterns: ['رمضان كريم', 'رمضان مبارك'],
    responses: ['الله أكرم، وكل عام وأنت بخير 🌙', 'رمضان كريم علينا وعليك 🕌'],
    reaction: '🌙',
  },
  {
    id: 'eid',
    patterns: ['عيد مبارك', 'عيدكم مبارك', 'كل عام وانتم بخير'],
    responses: ['وأنت بخير وصحة وسلامة 🎉', 'عيد سعيد علينا وعليك 🥳'],
    reaction: '🎉',
  },
  {
    id: 'inshallah',
    patterns: ['ان شاء الله', 'إن شاء الله'],
    responses: ['يارب 🤲', 'بإذن الله ✨'],
  },
  {
    id: 'mashallah',
    patterns: ['ما شاء الله', 'ماشاء الله'],
    responses: ['تبارك الله 🌟', 'اللهم بارك 🤲'],
  },
  {
    id: 'help_call',
    patterns: ['مساعدة', 'ساعدوني', 'محتاج مساعدة'],
    responses: ['اكتب /help وبتشوف كل الأوامر 📋', 'أنا هنا! جرّب /help 🤖'],
  },
];

/** Find the first matching smart rule for a given text, or null. */
export function matchSmartRule(text: string): SmartRule | null {
  const lower = text.toLowerCase();
  return SMART_RULES.find((rule) => rule.patterns.some((p) => lower.includes(p.toLowerCase()))) ?? null;
}
