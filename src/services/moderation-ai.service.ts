/**
 * Content moderation. Ships with a fast, high-precision heuristic classifier
 * (no cost, no keys). A full AI/vision classifier can be plugged into
 * `moderateText`/`moderateImage` later — the action pipeline is already here.
 * Only ever inspects content Telegram delivered to the bot.
 */
export interface ModerationVerdict {
  flagged: boolean;
  category: string;
  severity: number; // 0 none, 1 low, 2 medium, 3 high
}

const URL_RE = /(https?:\/\/|www\.|t\.me\/|wa\.me\/)/i;
const SCAM_WORDS = [
  'ربحت', 'مبروك فزت', 'جائزة نقدية', 'استثمار مضمون', 'ارباح يوميه', 'ارباح مضمونه',
  'تداول مضمون', 'بيتكوين مجاني', 'usdt free', 'free crypto', 'اضغط هنا واربح',
  'سحب فوري', 'ايداع فوري', 'راسلني على الخاص للربح', 'شغل اونلاين مضمون',
];
const HATE_WORDS = ['كلب', 'حمار', 'خنزير', 'قذر', 'حقير']; // conservative sample; extend per community

/** Heuristic text moderation. Returns a non-flagged verdict when nothing matches. */
export function moderateText(text: string): ModerationVerdict {
  const lower = text.toLowerCase();
  const hasUrl = URL_RE.test(text);
  if (SCAM_WORDS.some((w) => lower.includes(w)) && hasUrl) {
    return { flagged: true, category: 'scam', severity: 3 };
  }
  if (SCAM_WORDS.some((w) => lower.includes(w))) {
    return { flagged: true, category: 'spam', severity: 2 };
  }
  const hate = HATE_WORDS.filter((w) => lower.includes(w)).length;
  if (hate >= 2) return { flagged: true, category: 'hate', severity: 3 };
  return { flagged: false, category: 'none', severity: 0 };
}

/**
 * Image moderation placeholder — requires a Vision/NSFW API + key, which the
 * Bot API cannot do on its own. Returns not-flagged until a provider is wired.
 */
export function moderateImage(_fileId: string): ModerationVerdict {
  return { flagged: false, category: 'none', severity: 0 };
}
