import type { BotContext } from '../core/context';
import { recordGameWin, getMember } from '../services/member.service';
import { incMissionGames } from '../services/missions.service';
import { checkAchievements } from '../services/achievements.service';
import { displayName } from './format';

/**
 * Central hook for a game win: awards XP + a game win, advances the daily
 * "play a game" mission, and unlocks any newly-earned achievements —
 * announcing level-ups and achievements to the chat.
 */
export async function awardGameWin(ctx: BotContext, xpGain: number): Promise<void> {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;

  const result = await recordGameWin(chat.id, from, xpGain);
  await incMissionGames(chat.id, from.id).catch(() => undefined);

  if (result.leveledUp) {
    await ctx.reply(`🎊 ${displayName(from)} وصل للمستوى ${result.newLevel}!`).catch(() => undefined);
  }
  await announceAchievements(ctx);
}

/** Check + announce any achievements the sender just unlocked. */
export async function announceAchievements(ctx: BotContext): Promise<void> {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;
  const member = await getMember(chat.id, from.id);
  if (!member) return;

  const unlocked = await checkAchievements(chat.id, from.id, {
    messageCount: member.messageCount,
    xp: member.xp,
    level: member.level,
    gamesWon: member.gamesWon,
    joinedAt: member.joinedAt,
  });
  for (const a of unlocked) {
    await ctx
      .reply(`🏆 إنجاز جديد لـ ${displayName(from)}:\n${a.name} — ${a.desc}\n+${a.coins} 💰`)
      .catch(() => undefined);
  }
}
