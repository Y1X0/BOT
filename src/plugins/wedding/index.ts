import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { getAvatar, setAvatar } from '../../services/idcard/cache';
import { renderWeddingCardImage, renderWeddingCardVideo, type WeddingCardData } from '../../services/wedding/card';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:wedding');

const isGroup = (ctx: BotContext) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');

interface Person {
  id: number;
  name: string;
}

type PhotoSize = { file_id: string; width: number };
function pickAvatarFileId(sizes?: PhotoSize[]): string | undefined {
  if (!sizes?.length) return undefined;
  return [...sizes].sort((a, b) => b.width - a.width)[0]?.file_id;
}

/** A user's avatar as a data URI (reusing the id-card avatar cache). */
async function fetchAvatar(ctx: BotContext, userId: number): Promise<string | undefined> {
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1).catch(() => null);
    const fileId = pickAvatarFileId(photos?.photos?.[0] as PhotoSize[] | undefined);
    if (!fileId) return undefined;
    const cached = getAvatar(fileId);
    if (cached) return cached;
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(link.toString());
    if (!res.ok) return undefined;
    const uri = `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    setAvatar(fileId, uri);
    return uri;
  } catch (err) {
    log.debug({ err, userId }, 'wedding avatar fetch failed');
    return undefined;
  }
}

/** Resolve the couple from a reply and/or the mentions in the command text. */
async function resolveCouple(ctx: BotContext): Promise<[Person, Person] | { error: string }> {
  const msg = ctx.message as {
    text?: string;
    entities?: { type: string; offset: number; length: number; user?: { id: number; first_name?: string; last_name?: string } }[];
    reply_to_message?: { from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string } };
  };
  const me = ctx.from ? { id: ctx.from.id, name: displayName(ctx.from) } : null;

  // Gather explicit targets: text_mention entities, then @username / numeric-id tokens.
  const targets: Person[] = [];
  const text = msg.text ?? '';
  for (const e of msg.entities ?? []) {
    if (e.type === 'text_mention' && e.user && !targets.some((t) => t.id === e.user!.id)) {
      const u = e.user;
      targets.push({ id: u.id, name: `${u.first_name ?? ''}${u.last_name ? ' ' + u.last_name : ''}`.trim() || 'عضو' });
    } else if (e.type === 'mention') {
      const uname = text.slice(e.offset, e.offset + e.length).replace(/^@/, '');
      try {
        const chat = (await ctx.telegram.getChat(uname)) as { id: number; first_name?: string; last_name?: string; title?: string };
        if (chat?.id && !targets.some((t) => t.id === chat.id)) {
          targets.push({ id: chat.id, name: `${chat.first_name ?? ''}${chat.last_name ? ' ' + chat.last_name : ''}`.trim() || chat.title || uname });
        }
      } catch {
        /* unknown username — skip */
      }
    }
  }
  // Numeric ids in the text (only when we still need people).
  if (targets.length < 2) {
    for (const m of text.matchAll(/\b(\d{5,})\b/g)) {
      const id = Number(m[1]);
      if (targets.some((t) => t.id === id)) continue;
      try {
        const cm = await ctx.telegram.getChatMember(ctx.chat!.id, id);
        targets.push({ id, name: displayName(cm.user) });
      } catch {
        /* not a member — skip */
      }
      if (targets.length >= 2) break;
    }
  }

  const replied = msg.reply_to_message?.from;
  if (replied && !replied.is_bot) {
    const other: Person = { id: replied.id, name: `${replied.first_name ?? ''}${replied.last_name ? ' ' + replied.last_name : ''}`.trim() || 'عضو' };
    // reply + a mentioned person → those two; otherwise you + the replied person.
    if (targets.length >= 1 && targets[0].id !== other.id) return [other, targets[0]];
    if (me && me.id !== other.id) return [me, other];
    return { error: '💍 ما بقدر أزوّجك من نفسك.' };
  }

  if (targets.length >= 2) return [targets[0], targets[1]];
  if (targets.length === 1) {
    if (!me) return { error: '💍 حدّد شخصين.' };
    if (me.id === targets[0].id) return { error: '💍 ما بقدر أزوّجك من نفسك.' };
    return [me, targets[0]];
  }
  return { error: '💍 حدّد العروسين: ردّ على رسالة الشخص، أو اكتب «زفاف @الأول @الثاني».' };
}

export const weddingPlugin: Plugin = {
  name: 'wedding',
  description: 'Wedding invitation card (animated) between two members',
  commands: [{ command: 'wedding', description: '💍 بطاقة زفاف بين شخصين (بالرد أو منشن)' }],

  register(bot: Telegraf<BotContext>) {
    bot.command('wedding', async (ctx) => {
      if (!isGroup(ctx)) return void ctx.reply('💍 هذا الأمر للجروبات فقط.');
      const couple = await resolveCouple(ctx);
      if ('error' in couple) return void ctx.reply(couple.error);
      const [a, b] = couple;

      await ctx.sendChatAction('upload_video').catch(() => undefined);

      const [aAvatar, bAvatar] = await Promise.all([fetchAvatar(ctx, a.id), fetchAvatar(ctx, b.id)]);
      const data: WeddingCardData = {
        aName: a.name,
        bName: b.name,
        aAvatarDataUri: aAvatar,
        bAvatarDataUri: bAvatar,
        aInitial: (a.name.trim()[0] || '?').toUpperCase(),
        bInitial: (b.name.trim()[0] || '?').toUpperCase(),
        note: 'بالرفاء والبنين 🎉',
      };

      const cap = `💍 مبروك الزواج 💍\n${a.name} ❤️ ${b.name}`;
      try {
        const vid = await renderWeddingCardVideo(data).catch(() => null);
        if (vid) {
          await ctx
            .replyWithAnimation({ source: vid.buffer, filename: `wedding.${vid.ext}` }, { caption: cap })
            .catch(() => undefined);
          return;
        }
        const png = await renderWeddingCardImage(data);
        await ctx.replyWithPhoto(Input.fromBuffer(png, 'wedding.jpg'), { caption: cap }).catch(() => undefined);
      } catch (err) {
        log.warn({ err }, 'wedding card render failed');
        await ctx.reply(`💍 ${a.name} ❤️ ${b.name}\nمبروك الزواج 🎉`).catch(() => undefined);
      }
    });
  },
};
