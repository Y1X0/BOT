import { describe, it, expect } from 'vitest';
import { statLabel, interactionLabel, buildIdCard } from '../src/plugins/info/card';

describe('statLabel', () => {
  it('maps staff roles regardless of activity', () => {
    expect(statLabel('owner', 0)).toContain('المالك');
    expect(statLabel('admin', 0)).toContain('مشرف');
    expect(statLabel('moderator', 0)).toContain('مساعد');
  });
  it('tiers regular members by message count', () => {
    expect(statLabel('member', 0)).toContain('مسكين');
    expect(statLabel('member', 60)).toContain('عادي');
    expect(statLabel('member', 600)).toContain('نشيط');
    expect(statLabel('member', 2500)).toContain('محترف');
    expect(statLabel('member', 9000)).toContain('أسطورة');
  });
});

describe('interactionLabel', () => {
  it('scales with message count', () => {
    expect(interactionLabel(0)).toBe('غير متفاعل');
    expect(interactionLabel(30)).toContain('قليلاً');
    expect(interactionLabel(300)).toContain('متفاعل');
    expect(interactionLabel(1500)).toContain('جداً');
    expect(interactionLabel(9000)).toContain('أسطوري');
  });
});

describe('buildIdCard', () => {
  const card = buildIdCard({
    name: 'أحمد',
    username: '@ahmad',
    stats: 'عضو مسكين 🦦',
    title: 'لا يوجد',
    interaction: 'غير متفاعل',
    id: 12345,
  });

  it('includes every field and the copyable id', () => {
    expect(card).toContain('ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ɢʀᴏᴜᴘ');
    expect(card).toContain('أحمد');
    expect(card).toContain('@ahmad');
    expect(card).toContain('عضو مسكين 🦦');
    expect(card).toContain('<code>12345</code>');
  });

  it('keeps the six labelled lines in order', () => {
    const idx = ['ɴᴀᴍᴇ', 'ᴜѕᴇʀɴᴀᴍᴇ', 'ѕᴛᴀᴛѕ', 'ᴛɪᴛʟᴇ', 'ɪɴᴛᴇʀᴀᴄᴛɪᴏɴ', 'ɪᴅ'].map((k) => card.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx]).toEqual([...idx].sort((a, b) => a - b));
  });
});
