import type { Telegraf } from 'telegraf';
import { Input, Markup } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { renderNameImage, NAME_STYLES, STYLE_LABEL, type NameStyle } from '../../services/namedesign';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:namedesign');

// «تصميم [لون] <الاسم>» — optional leading style keyword, rest is the name.
const TRIGGER = /^(?:تصميم|صمم|صمّم|صمملي)\s+([\s\S]+)/;
const STYLE_WORDS: Record<string, NameStyle> = {
  فلسطين: 'palestine', فلسطيني: 'palestine',
  ذهبي: 'gold', ذهب: 'gold',
  نار: 'fire', ناري: 'fire',
  ملكي: 'royal', ملوكي: 'royal',
  ازرق: 'ocean', أزرق: 'ocean', بحري: 'ocean',
};

/** Split an optional leading style keyword off the name. */
function parseArg(raw: string): { style: NameStyle; name: string } {
  const parts = raw.trim().split(/\s+/);
  const first = parts[0];
  if (parts.length > 1 && STYLE_WORDS[first]) return { style: STYLE_WORDS[first], name: parts.slice(1).join(' ') };
  return { style: 'palestine', name: raw.trim() };
}

// Short-lived store so the color buttons can re-render without stuffing the
// (possibly long, multi-byte) name into 64-byte callback data.
const nameStore = new Map<string, { name: string; at: number }>();
const STORE_TTL = 60 * 60 * 1000;
function putName(name: string): string {
  const id = Math.random().toString(36).slice(2, 8);
  nameStore.set(id, { name, at: Date.now() });
  // Opportunistic cleanup.
  if (nameStore.size > 500) for (const [k, v] of nameStore) if (Date.now() - v.at > STORE_TTL) nameStore.delete(k);
  return id;
}

function colorKeyboard(id: string) {
  const btns = NAME_STYLES.map((s) => Markup.button.callback(STYLE_LABEL[s], `nd:${s}:${id}`));
  return Markup.inlineKeyboard([btns.slice(0, 3), btns.slice(3)]);
}

async function generate(ctx: BotContext, name: string, style: NameStyle, id: string): Promise<void> {
  const buf = await renderNameImage(name, style).catch((err) => {
    log.warn({ err }, 'render failed');
    return null;
  });
  if (!buf) {
    await ctx.reply('⚠️ تعذّر التصميم الآن، جرّب مرة ثانية.').catch(() => undefined);
    return;
  }
  // Send as a document (not a photo) so the transparent PNG keeps its quality
  // and transparency — ready to save or turn into a sticker.
  await ctx
    .replyWithDocument(Input.fromBuffer(buf, 'name.png'), {
      caption: `🎨 تصميم «${name}»\nاختر لون ثاني من الأزرار 👇`,
      ...colorKeyboard(id),
    })
    .catch(async () => {
      // Fallback to a photo if document upload is refused.
      await ctx.replyWithPhoto(Input.fromBuffer(buf, 'name.png'), { caption: `🎨 تصميم «${name}»` }).catch(() => undefined);
    });
}

/** Design a name into a decorative transparent PNG (gold/colored), several styles. */
export const nameDesignPlugin: Plugin = {
  name: 'namedesign',
  description: 'Design a name into a decorative image (several color styles)',
  commands: [{ command: 'design', description: '🎨 صمّم اسمك بتصميم فخم: تصميم الاسم' }],

  register(bot: Telegraf<BotContext>) {
    const run = async (ctx: BotContext, raw: string): Promise<void> => {
      const { style, name } = parseArg(raw);
      if (!name) {
        await ctx.reply('🎨 اكتب: <code>تصميم الاسم</code>\nمثال: <code>تصميم ملوكة النابلسية</code>\nأو لون: <code>تصميم ملكي سارة</code>', { parse_mode: 'HTML' }).catch(() => undefined);
        return;
      }
      const status = await ctx.reply('🎨 جاري التصميم... ⏳').catch(() => undefined);
      const id = putName(name);
      await generate(ctx, name, style, id);
      const sid = (status as { message_id?: number } | undefined)?.message_id;
      if (sid && ctx.chat) await ctx.telegram.deleteMessage(ctx.chat.id, sid).catch(() => undefined);
    };

    bot.command('design', async (ctx) => {
      const raw = ctx.message.text.split(/\s+/).slice(1).join(' ');
      await run(ctx, raw);
    });
    bot.hears(TRIGGER, async (ctx, next) => {
      if (!ctx.match?.[1]) return next();
      await run(ctx, ctx.match[1]);
    });

    bot.action(/^nd:([a-z]+):([a-z0-9]+)$/, async (ctx) => {
      const style = ctx.match[1] as NameStyle;
      const rec = nameStore.get(ctx.match[2]);
      if (!rec || !NAME_STYLES.includes(style)) {
        await ctx.answerCbQuery('انتهت الصلاحية — اكتب «تصميم الاسم» من جديد.').catch(() => undefined);
        return;
      }
      await ctx.answerCbQuery('🎨 ' + STYLE_LABEL[style]).catch(() => undefined);
      await generate(ctx, rec.name, style, ctx.match[2]);
    });
  },
};
