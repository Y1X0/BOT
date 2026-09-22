import type { Telegraf } from 'telegraf';
import { Input } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { displayName } from '../../utils/format';
import { getAvatar, setAvatar } from '../../services/idcard/cache';
import { renderWeddingCardImage, renderWeddingCardVideo, type WeddingCardData } from '../../services/wedding/card';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:wedding');

interface Person {
  id: number;
  name: string;
}

/** Parse two free-typed names from the command text (for private chat / custom
 *  names). Accepts separators: newline, «+», «&», «،», «,», or « و ». */
function parseTwoNames(arg: string): [string, string] | null {
  const raw = arg.trim();
  if (!raw) return null;
  let parts = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) parts = raw.split(/\s*[+&،,]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) parts = raw.split(/\s+و\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const clean = (s: string) => s.slice(0, 40).trim();
  return [clean(parts[0]), clean(parts[1])];
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
      const argText = (ctx.message.text || '').split(/\s+/).slice(1).join(' ');

      // Resolve the couple. In a group with a reply/mention we use the real
      // members (with their avatars). Otherwise — including in the bot's private
      // chat — we take two names the user typed («زفاف الأول و الثاني»), so a
      // card can be made for anyone, no members needed.
      let aName: string;
      let bName: string;
      let aId: number | undefined;
      let bId: number | undefined;
      const couple = await resolveCouple(ctx);
      if (!('error' in couple)) {
        [aId, bId] = [couple[0].id, couple[1].id];
        [aName, bName] = [couple[0].name, couple[1].name];
      } else {
        const names = parseTwoNames(argText);
        if (!names) {
          return void ctx.reply(
            '💍 اكتب اسمين:\n«زفاف محمد و سارة»\nأو بالرد على شخص، أو «زفاف @الأول @الثاني».',
          );
        }
        [aName, bName] = names;
      }

      await ctx.sendChatAction('upload_video').catch(() => undefined);

      const [aAvatar, bAvatar] = await Promise.all([
        aId ? fetchAvatar(ctx, aId) : Promise.resolve(undefined),
        bId ? fetchAvatar(ctx, bId) : Promise.resolve(undefined),
      ]);
      const data: WeddingCardData = {
        aName,
        bName,
        aAvatarDataUri: aAvatar,
        bAvatarDataUri: bAvatar,
        aInitial: (aName.trim()[0] || '?').toUpperCase(),
        bInitial: (bName.trim()[0] || '?').toUpperCase(),
        note: 'بالرفاء والبنين 🎉',
      };

      const cap = `💍 مبروك الزواج 💍\n${aName} ❤️ ${bName}`;
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
        await ctx.reply(`💍 ${aName} ❤️ ${bName}\nمبروك الزواج 🎉`).catch(() => undefined);
      }
    });
  },
};
