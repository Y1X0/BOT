/** Pure helpers for weekly reports: formatting + scheduling predicate. */

export interface WeeklyReportData {
  title: string;
  activeMembers: number; // members with activity this week
  weeklyMessages: number; // total messages this week
  top: Array<{ name: string; count: number }>;
  newXpLeader?: { name: string; xp: number };
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function formatWeeklyReport(d: WeeklyReportData): string {
  const top = d.top.length
    ? d.top.map((m, i) => `${MEDALS[i] ?? `${i + 1}.`} ${m.name} — ${m.count} 💬`).join('\n')
    : '— لا نشاط هذا الأسبوع —';
  let out = `📊 التقرير الأسبوعي — ${d.title}\n\n`;
  out += `👥 أعضاء نشطون: ${d.activeMembers}\n`;
  out += `💬 رسائل الأسبوع: ${d.weeklyMessages}\n\n`;
  out += `🔥 نجوم الأسبوع:\n${top}`;
  if (d.newXpLeader) out += `\n\n⬆️ الأعلى خبرة: ${d.newXpLeader.name} (${d.newXpLeader.xp} XP)`;
  return out;
}

/**
 * Should the weekly report fire now? True on the target weekday & hour (UTC),
 * as long as it hasn't already fired within the last 6 days.
 */
export function isWeeklyDue(
  now: Date,
  lastSent: Date | null,
  weekday = 5, // Friday
  hour = 18,
): boolean {
  if (now.getUTCDay() !== weekday || now.getUTCHours() !== hour) return false;
  if (!lastSent) return true;
  return now.getTime() - lastSent.getTime() > 6 * 24 * 60 * 60 * 1000;
}
