/** Pure builders for the fancy profile ("id") card — no I/O, so it's testable. */

/** Group-status label from the member's role and activity (fun tiers). */
export function statLabel(role: string, messageCount: number): string {
  if (role === 'owner') return 'المالك 👑';
  if (role === 'admin') return 'مشرف 🛡';
  if (role === 'moderator') return 'مشرف مساعد 🚨';
  if (messageCount >= 5000) return 'أسطورة الجروب 🐉';
  if (messageCount >= 2000) return 'عضو محترف 💪';
  if (messageCount >= 500) return 'عضو نشيط 🔥';
  if (messageCount >= 50) return 'عضو عادي 🙂';
  return 'عضو مسكين 🦦';
}

/** Interaction label from total message count. */
export function interactionLabel(messageCount: number): string {
  if (messageCount >= 5000) return 'متفاعل أسطوري 🐉';
  if (messageCount >= 1000) return 'متفاعل جداً 🔥';
  if (messageCount >= 200) return 'متفاعل 💬';
  if (messageCount >= 20) return 'متفاعل قليلاً 🙂';
  return 'غير متفاعل';
}

export interface CardData {
  name: string;
  username: string;
  stats: string;
  title: string;
  interaction: string;
  id: number | string;
}

/**
 * Render the decorated profile card. Text fields are inserted verbatim, so the
 * caller must HTML-escape any user-controlled value before passing it in.
 */
export function buildIdCard(d: CardData): string {
  return (
    '🔝 ˖ıl ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ɢʀᴏᴜᴘ lı🔝\n' +
    `👤🔥 ɴᴀᴍᴇ 𖥳 ${d.name}\n` +
    `🐶🔥 ᴜѕᴇʀɴᴀᴍᴇ 𖥳 ${d.username}\n` +
    `🛡🔥 ѕᴛᴀᴛѕ 𖥳 ${d.stats} .\n` +
    `🖋🔥 ᴛɪᴛʟᴇ 𖥳 ${d.title} .\n` +
    `💬🔥 ɪɴᴛᴇʀᴀᴄᴛɪᴏɴ 𖥳 ${d.interaction} .\n` +
    `🆔🔥 ɪᴅ 𖥳 <code>${d.id}</code>`
  );
}
