import { MENU, type MenuItem } from './data';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

export interface SearchHit {
  category: string;
  item: MenuItem;
}

/** Search the menu by Arabic trigger, command, or description. */
export function searchMenu(query: string, limit = 12): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const cat of MENU) {
    for (const item of cat.items) {
      const hay = normalize(`${item.ar} ${item.cmd} ${item.desc}`);
      if (hay.includes(q)) hits.push({ category: cat.title, item });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** Vivid color marker per category, for a more distinct look. */
export const CATEGORY_COLORS: Record<string, string> = {
  games: '🔴',
  econ: '🟢',
  levels: '🟡',
  social: '🟣',
  islamic: '🟩',
  tools: '🔵',
  media: '🟠',
  events: '🩷',
  info: '⚪',
  admin: '⚫',
};
