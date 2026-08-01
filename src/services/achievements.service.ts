import { prisma } from '../core/database';
import { addCoins } from './economy.service';

export interface AchievementStats {
  messageCount: number;
  xp: number;
  level: number;
  gamesWon: number;
  joinedAt: Date;
}

export interface AchievementDef {
  code: string;
  name: string;
  desc: string;
  coins: number;
  met: (s: AchievementStats) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { code: 'msg100', name: '🗣 ثرثار', desc: 'أرسل 100 رسالة', coins: 100, met: (s) => s.messageCount >= 100 },
  { code: 'msg1000', name: '📣 نجم التفاعل', desc: 'أرسل 1000 رسالة', coins: 300, met: (s) => s.messageCount >= 1000 },
  { code: 'xp1000', name: '⭐️ نجم', desc: 'اجمع 1000 XP', coins: 150, met: (s) => s.xp >= 1000 },
  { code: 'level10', name: '🏅 محترف', desc: 'وصل للمستوى 10', coins: 200, met: (s) => s.level >= 10 },
  { code: 'games10', name: '🎮 بطل الألعاب', desc: 'افز بـ 10 ألعاب', coins: 200, met: (s) => s.gamesWon >= 10 },
  {
    code: 'veteran30',
    name: '🎖 عضو مخضرم',
    desc: 'عضو منذ 30 يوماً',
    coins: 250,
    met: (s) => Date.now() - s.joinedAt.getTime() >= 30 * 24 * 3600_000,
  },
];

/**
 * Check the member's stats and unlock any newly-earned achievements, awarding
 * their coins. Returns the list of newly unlocked achievements.
 */
export async function checkAchievements(
  chatId: number | bigint,
  userId: number | bigint,
  stats: AchievementStats,
): Promise<AchievementDef[]> {
  const cId = BigInt(chatId);
  const uId = BigInt(userId);
  const already = new Set(
    (await prisma.achievement.findMany({ where: { chatId: cId, userId: uId }, select: { code: true } })).map(
      (a) => a.code,
    ),
  );

  const unlocked: AchievementDef[] = [];
  for (const def of ACHIEVEMENTS) {
    if (already.has(def.code) || !def.met(stats)) continue;
    try {
      await prisma.achievement.create({ data: { chatId: cId, userId: uId, code: def.code } });
      await addCoins(cId, uId, def.coins);
      unlocked.push(def);
    } catch {
      // unique race — already unlocked
    }
  }
  return unlocked;
}

export async function listAchievements(
  chatId: number | bigint,
  userId: number | bigint,
): Promise<{ unlocked: AchievementDef[]; locked: AchievementDef[] }> {
  const codes = new Set(
    (
      await prisma.achievement.findMany({
        where: { chatId: BigInt(chatId), userId: BigInt(userId) },
        select: { code: true },
      })
    ).map((a) => a.code),
  );
  return {
    unlocked: ACHIEVEMENTS.filter((a) => codes.has(a.code)),
    locked: ACHIEVEMENTS.filter((a) => !codes.has(a.code)),
  };
}
