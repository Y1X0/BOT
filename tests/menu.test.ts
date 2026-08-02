import { describe, it, expect } from 'vitest';
import { MENU } from '../src/plugins/menu/data';

describe('menu structure', () => {
  it('has categories with unique keys', () => {
    const keys = MENU.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MENU.length).toBeGreaterThan(5);
  });

  it('every category has an emoji, title, and items', () => {
    for (const c of MENU) {
      expect(c.emoji).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.items.length).toBeGreaterThan(0);
    }
  });

  it('every item has an Arabic trigger, command, and description', () => {
    for (const c of MENU) {
      for (const it of c.items) {
        expect(it.ar.trim()).toBeTruthy();
        expect(it.cmd).toMatch(/^[a-z0-9]+$/i);
        expect(it.desc.trim()).toBeTruthy();
      }
    }
  });

  it('callback keys stay short (Telegram 64-byte limit)', () => {
    for (const c of MENU) {
      expect(`menu:c:${c.key}`.length).toBeLessThan(64);
    }
  });
});
