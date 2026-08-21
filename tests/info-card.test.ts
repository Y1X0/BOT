import { describe, it, expect } from 'vitest';
import { statLabel, interactionLabel, renderIdCard, DEFAULT_ID_CARD } from '../src/plugins/info/card';

describe('statLabel', () => {
  it('maps staff roles regardless of activity', () => {
    expect(statLabel('owner', 0)).toContain('المالك');
    expect(statLabel('supervisor', 0)).toContain('مشرف');
    expect(statLabel('manager', 0)).toContain('مدير');
    expect(statLabel('admin', 0)).toContain('أدمن');
    expect(statLabel('vip', 0)).toContain('مميّز');
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

describe('renderIdCard', () => {
  const vars = {
    name: 'أحمد',
    username: '@ahmad',
    id: '12345',
    stats: 'عضو مسكين 🦦',
    title: 'لا يوجد',
    interaction: 'غير متفاعل',
    level: '3',
    xp: '120',
    messages: '40',
    rank: '🥉 مبتدئ',
    joined: '2024/01/01',
  };

  it('fills the default template with every value', () => {
    const { text } = renderIdCard(DEFAULT_ID_CARD, [], vars);
    expect(text).toContain('أحمد');
    expect(text).toContain('@ahmad');
    expect(text).toContain('عضو مسكين 🦦');
    expect(text).toContain('🥉 مبتدئ');
    expect(text).toContain('12345');
    expect(text).not.toContain('{'); // no leftover placeholders
  });

  it('wraps the id value in a copyable code entity', () => {
    const { text, entities } = renderIdCard('id: {id}', [], vars);
    const code = entities.find((e) => e.type === 'code');
    expect(code).toBeTruthy();
    expect(text.slice(code!.offset, code!.offset + code!.length)).toBe('12345');
  });

  it('shifts a custom-emoji entity that follows a placeholder', () => {
    // Template: "x {name} 😀" — the emoji entity sits after {name} (offset 9,
    // len 2). After substituting name→أحمد (4 chars, delta = 4 - 6 = -2), the
    // emoji moves to offset 7.
    const tmpl = 'x {name} 😀';
    const emoji = { type: 'custom_emoji', offset: 9, length: 2, custom_emoji_id: '5' };
    const { text, entities } = renderIdCard(tmpl, [emoji], vars);
    const ce = entities.find((e) => e.type === 'custom_emoji');
    expect(ce).toBeTruthy();
    expect(text.slice(ce!.offset, ce!.offset + ce!.length)).toBe('😀');
  });

  it('drops a template entity that overlaps a substituted placeholder', () => {
    const tmpl = 'hi {name}!';
    const italic = { type: 'italic', offset: 3, length: 6 }; // covers "{name}"
    const { entities } = renderIdCard(tmpl, [italic], vars);
    expect(entities.some((e) => e.type === 'italic')).toBe(false);
  });

  it('auto-bolds the name value', () => {
    const { text, entities } = renderIdCard('الاسم: {name}', [], vars);
    const bold = entities.find((e) => e.type === 'bold');
    expect(bold).toBeTruthy();
    expect(text.slice(bold!.offset, bold!.offset + bold!.length)).toBe('أحمد');
  });
});
