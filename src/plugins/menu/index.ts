import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { MENU, type MenuCategory } from './data';
import { searchMenu, CATEGORY_COLORS } from './logic';

export const HOME_TEXT =
  '🤖 <b>قائمة البوت</b>\n\nاختر قسماً بالضغط على الأزرار 👇\nأو اكتب أي أمر مباشرة (بالعربي بدون /).';

const color = (key: string) => CATEGORY_COLORS[key] ?? '▫️';

export function homeKeyboard() {
  const buttons = MENU.map((c) => Markup.button.callback(`${color(c.key)} ${c.title}`, `menu:c:${c.key}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('🔍 بحث عن أمر', 'menu:find')]);
  return Markup.inlineKeyboard(rows);
}

function categoryText(c: MenuCategory): string {
  const lines = c.items.map((it) => `• <b>${esc(it.ar)}</b>  <code>/${it.cmd}</code>\n   ${esc(it.desc)}`).join('\n');
  return `${color(c.key)} ${c.emoji} <b>${esc(c.title)}</b>\n${c.note ? esc(c.note) + '\n' : ''}\n${lines}`;
}

const backKeyboard = () => Markup.inlineKeyboard([[Markup.button.callback('⬅️ رجوع للقائمة', 'menu:home')]]);

const FIND_TEXT = '🔍 <b>البحث عن أمر</b>\n\nاكتب: <code>بحث</code> ثم الكلمة.\nمثال: <code>بحث بنك</code> أو <code>بحث لعبة</code>';

/** Organized, button-driven command menu (categories → commands) + search. */
export const menuPlugin: Plugin = {
  name: 'menu',
  description: 'Organized interactive command menu',
  commands: [
    { command: 'menu', description: '📋 كل الأوامر مرتّبة بالأقسام (ابدأ من هنا)' },
    { command: 'find', description: '🔍 ابحث عن أمر: /find بنك' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('menu', async (ctx) => {
      await ctx.reply(HOME_TEXT, { parse_mode: 'HTML', ...homeKeyboard() });
    });

    bot.command('find', async (ctx) => {
      const q = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!q) return void ctx.reply('🔍 اكتب كلمة للبحث:\n/find بنك', { parse_mode: 'HTML' });
      await ctx.reply(renderSearch(q), { parse_mode: 'HTML', ...backKeyboard() });
    });

    bot.action('menu:home', async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(HOME_TEXT, { parse_mode: 'HTML', ...homeKeyboard() }).catch(() => undefined);
    });

    bot.action('menu:find', async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(FIND_TEXT, { parse_mode: 'HTML', ...backKeyboard() }).catch(() => undefined);
    });

    bot.action(/^menu:c:(.+)$/, async (ctx) => {
      const cat = MENU.find((c) => c.key === ctx.match[1]);
      await ctx.answerCbQuery().catch(() => undefined);
      if (!cat) return;
      await ctx.editMessageText(categoryText(cat), { parse_mode: 'HTML', ...backKeyboard() }).catch(() => undefined);
    });
  },
};

function renderSearch(query: string): string {
  const hits = searchMenu(query);
  if (!hits.length) return `🔍 لا نتائج لـ «${esc(query)}». جرّب كلمة أخرى.`;
  const lines = hits
    .map((h) => `• <b>${esc(h.item.ar)}</b>  <code>/${h.item.cmd}</code> — ${esc(h.item.desc)} <i>(${esc(h.category)})</i>`)
    .join('\n');
  return `🔍 نتائج «${esc(query)}»:\n\n${lines}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
