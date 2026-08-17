/** Pure builders for the fancy profile ("id") card — no I/O, so it's testable. */

/** Group-status label from the member's role and activity (fun tiers). */
export function statLabel(role: string, messageCount: number): string {
  if (role === 'owner') return 'المالك 👑';
  if (role === 'admin') return 'مشرف 🛡';
  if (role === 'moderator') return 'مشرف مساعد 🚨';
  if (role === 'vip') return 'عضو مميّز ⭐';
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

/** Placeholders an admin can use in a custom id-card template. */
export const ID_PLACEHOLDERS = [
  'name',
  'username',
  'id',
  'stats',
  'title',
  'interaction',
  'level',
  'xp',
  'messages',
  'rank',
  'joined',
] as const;

/** The default card, as a placeholder template (rendered the same way as a custom one). */
export const DEFAULT_ID_CARD =
  '╭──── 🦋 بطاقة العضو ────╮\n' +
  '👤 الاسم: {name}\n' +
  '🔗 المعرّف: {username}\n' +
  '🏅 الرتبة: {rank}\n' +
  '🛡 الحالة: {stats}\n' +
  '🎖 اللقب: {title}\n' +
  '⭐ المستوى: {level}  •  🔥 النقاط: {xp}\n' +
  '💬 الرسائل: {messages}  •  {interaction}\n' +
  '📅 انضمّ: {joined}\n' +
  '🆔 الآيدي: {id}\n' +
  '╰───────────────────╯';

export interface Entity {
  type: string;
  offset: number;
  length: number;
  [k: string]: unknown;
}

export interface RenderedCard {
  text: string;
  entities: Entity[];
}

/**
 * Fill a card template with values and keep Telegram entities aligned.
 *
 * `entities` are the template's own entities (custom/premium emoji, bold…), with
 * offsets relative to `template`. As placeholders are substituted the text
 * shifts, so every entity that sits after a replacement is moved by the running
 * delta; entities that overlap a placeholder are dropped. The `{id}` value is
 * additionally wrapped in a `code` entity so it stays tap-to-copy. Offsets are
 * UTF-16 code units (what both JS strings and Telegram use), so emoji in names
 * or the template are counted correctly.
 */
export function renderIdCard(template: string, entities: Entity[], vars: Record<string, string>): RenderedCard {
  const re = /\{(\w+)\}/g;
  const repls: { key: string; start: number; end: number; value: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      repls.push({ key, start: m.index, end: m.index + m[0].length, value: vars[key] ?? '' });
    }
  }

  let out = '';
  let last = 0;
  const placed: { key: string; outStart: number; outLen: number }[] = [];
  for (const r of repls) {
    out += template.slice(last, r.start);
    const outStart = out.length;
    out += r.value;
    placed.push({ key: r.key, outStart, outLen: r.value.length });
    last = r.end;
  }
  out += template.slice(last);

  const result: Entity[] = [];
  for (const e of entities) {
    const eEnd = e.offset + e.length;
    // Drop an entity that overlaps any substituted placeholder.
    if (repls.some((r) => e.offset < r.end && eEnd > r.start)) continue;
    let add = 0;
    for (const r of repls) if (r.end <= e.offset) add += r.value.length - (r.end - r.start);
    result.push({ ...e, offset: e.offset + add });
  }
  // Keep the id copyable.
  for (const p of placed) {
    if (p.key === 'id' && p.outLen > 0) result.push({ type: 'code', offset: p.outStart, length: p.outLen });
  }
  return { text: out, entities: result };
}
