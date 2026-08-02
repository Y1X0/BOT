import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { MENU, type MenuCategory } from './data';

const HOME_TEXT =
  '🤖 <b>قائمة البوت</b>\n\nاختر قسماً بالضغط على الأزرار 👇\nأو اكتب أي أمر مباشرة (بالعربي بدون /).';

function homeKeyboard() {
  const buttons = MENU.map((c) => Markup.button.callback(`${c.emoji} ${c.title}`, `menu:c:${c.key}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return Markup.inlineKeyboard(rows);
}

function categoryText(c: MenuCategory): string {
  const lines = c.items.map((it) => `• <b>${esc(it.ar)}</b>  <code>/${it.cmd}</code>\n   ${esc(it.desc)}`).join('\n');
  return `${c.emoji} <b>${esc(c.title)}</b>\n${c.note ? esc(c.note) + '\n' : ''}\n${lines}`;
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ رجوع للقائمة', 'menu:home')]]);
}

/** Organized, button-driven command menu (categories → commands). */
export const menuPlugin: Plugin = {
  name: 'menu',
  description: 'Organized interactive command menu',
  commands: [{ command: 'menu', description: '📋 قائمة الأوامر المنظّمة' }],

  register(bot: Telegraf<BotContext>) {
    const showHome = async (ctx: BotContext) => {
      await ctx.reply(HOME_TEXT, { parse_mode: 'HTML', ...homeKeyboard() });
    };
    bot.command('menu', showHome);

    bot.action('menu:home', async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await ctx.editMessageText(HOME_TEXT, { parse_mode: 'HTML', ...homeKeyboard() }).catch(() => undefined);
    });

    bot.action(/^menu:c:(.+)$/, async (ctx) => {
      const cat = MENU.find((c) => c.key === ctx.match[1]);
      await ctx.answerCbQuery().catch(() => undefined);
      if (!cat) return;
      await ctx.editMessageText(categoryText(cat), { parse_mode: 'HTML', ...backKeyboard() }).catch(() => undefined);
    });
  },
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
