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
];

/** Find the first matching smart rule for a given text, or null. */
export function matchSmartRule(text: string): SmartRule | null {
  const lower = text.toLowerCase();
  return SMART_RULES.find((rule) => rule.patterns.some((p) => lower.includes(p.toLowerCase()))) ?? null;
}
