import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { formatTime, formatDate, formatDay } from '../../utils/time';
import { resolveTarget, displayName, pickRandom } from '../../utils/format';
import { BIO_QUOTES } from './bios';
import { getSettings, setIdCard, setIdCardImage, setIdCardTheme } from '../../services/settings.service';
import { getMember } from '../../services/member.service';
import { getChatRole } from '../../services/roles.service';
import { getGlobalIdCard, setGlobalIdCard } from '../../services/global.service';
import { renderIdCardImage, renderIdCardVideo, getLastVideoError, resolveCardTheme, CARD_THEMES } from '../../services/idcard/image';
import { getCard, setCard, clearCard, getAvatar, setAvatar } from '../../services/idcard/cache';
import { hasRole, requireRole, isBotOwner, type Role } from '../../utils/permissions';
import { rankForLevel } from '../ranks/logic';
import { statLabel, interactionLabel, renderIdCard, DEFAULT_ID_CARD, ID_PLACEHOLDERS, type Entity } from './card';
import { createLogger } from '../../core/logger';

const log = createLogger('plugin:info');

export const infoPlugin: Plugin = {
  name: 'info',
  description: 'Utility info commands: time, date, day, weather, id, rules',
  commands: [
    { command: 'time', description: '🕐 الوقت الحالي' },
    { command: 'date', description: '📅 التاريخ' },
    { command: 'day', description: '📆 اليوم' },
    { command: 'weather', description: '🌤 حالة الطقس' },
    { command: 'id', description: '🆔 معلوماتك (صورة، بايو، آيدي)' },
    { command: 'info', description: '👤 معلومات عضو (بالرد عليه)' },
    { command: 'idcardhelp', description: '🎨 كيف تخصّص بطاقة الايدي' },
    { command: 'setidcard', description: '🖌 ضبط بطاقة ايدي مخصّصة (بالرد)', staffOnly: true },
    { command: 'setidcardall', description: '🌐 ضبط بطاقة ايدي لكل القروبات (المالك)', staffOnly: true },
    { command: 'idcardimage', description: '🖼 كرت ايدي كصورة مصمّمة', staffOnly: true },
    { command: 'idcardtheme', description: '🎨 ثيم/لون بطاقة ايدي', staffOnly: true },
    { command: 'idcardtext', description: '📝 كرت ايدي كنص', staffOnly: true },
    { command: 'residcard', description: '♻️ إرجاع بطاقة ايدي الافتراضية', staffOnly: true },
    { command: 'residcardall', description: '♻️ إرجاع بطاقة ايدي العامة (المالك)', staffOnly: true },
    { command: 'bio', description: '📝 بايو عضو (بالرد عليه)' },
    { command: 'rules', description: '📜 قوانين الجروب' },
  ],

  register(bot: Telegraf<BotContext>) {
    bot.command('time', async (ctx) => {
      const t = ctx.state.t!;
      await ctx.reply(t('info.time', { time: formatTime(ctx.state.locale!) }));
    });

    bot.command('date', async (ctx) => {
      const t = ctx.state.t!;
      await ctx.reply(t('info.date', { date: formatDate(ctx.state.locale!) }));
    });

    bot.command('day', async (ctx) => {
      const t = ctx.state.t!;
      await ctx.reply(t('info.day', { day: formatDay(ctx.state.locale!) }));
    });

    // /id and /info → rich profile card (photo + bio + username + id).
    // With a reply, shows the replied user's info; otherwise the sender's.
    const infoHandler = async (ctx: BotContext) => {
      const target = resolveTarget(ctx) ?? ctx.from;
      if (!target) return;
      await sendUserInfo(ctx, target);
    };
    bot.command('id', infoHandler);
    bot.command('info', infoHandler);

    // /idping — admin diagnostic: run the real id-card pipeline for the caller
    // and report how many ms each stage took, so we can see the actual
    // bottleneck (Telegram API vs download vs render vs upload) in-chat.
    bot.command('idping', requireRole('admin'), async (ctx) => {
      if (!ctx.from) return;
      const uid = ctx.from.id;
      const now = () => Number(process.hrtime.bigint() / 1000000n);
      const marks: string[] = [];
      let t = now();
      const lap = (label: string) => {
        const d = now() - t;
        t = now();
        marks.push(`${label}: ${d}ms`);
        return d;
      };

      const t0 = now();
      // 1) profile photos
      const photos = await ctx.telegram.getUserProfilePhotos(uid, 0, 1).catch(() => null);
      lap('صور البروفايل (getUserProfilePhotos)');
      const fid = pickAvatarFileId(photos?.photos?.[0] as PhotoSize[] | undefined);

      // 2) file link + 3) download
      let avatarDataUri: string | undefined;
      if (fid) {
        const link = await ctx.telegram.getFileLink(fid).catch(() => null);
        lap('رابط الملف (getFileLink)');
        if (link) {
          const res = await fetch(link.toString()).catch(() => null);
          if (res?.ok) avatarDataUri = `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
          lap('تنزيل الصورة');
        }
      } else {
        marks.push('لا يوجد صورة بروفايل');
      }

      // 4) render
      const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || '—';
      const png = await renderIdCardImage({
        name, username: ctx.from.username ? `@${ctx.from.username}` : 'لا يوجد', id: String(uid),
        rank: '⭐ تجربة', stats: 'عضو 🙂', title: 'لا يوجد', level: '1', xp: '0', messages: '0',
        interaction: 'تجربة', joined: 'اليوم', avatarDataUri, initial: (name.trim()[0] || '?').toUpperCase(),
      }).catch((e) => { marks.push(`فشل الرسم: ${e instanceof Error ? e.message : e}`); return null; });
      const renderMs = lap('رسم البطاقة (canvas)');

      // 5) upload
      if (png) {
        await ctx.replyWithPhoto({ source: png }).catch(() => undefined);
        lap('رفع الصورة لتيليجرام');
      }

      // 6) animated video card (premium) — canvas frames → ffmpeg mp4
      const cardData = {
        name, username: ctx.from.username ? `@${ctx.from.username}` : 'لا يوجد', id: String(uid),
        rank: '⭐ تجربة', stats: 'عضو 🙂', title: 'لا يوجد', level: '1', xp: '0', messages: '0',
        interaction: 'تجربة', joined: 'اليوم', avatarDataUri, initial: (name.trim()[0] || '?').toUpperCase(),
      };
      const vid = await renderIdCardVideo(cardData).catch(() => null);
      const vidMs = lap('بناء الفيديو (canvas+ffmpeg)');
      if (vid) {
        await ctx.replyWithAnimation({ source: vid.buffer, filename: `card.${vid.ext}` }).catch(() => undefined);
        lap('رفع الفيديو لتيليجرام');
      } else {
        marks.push(`الفيديو: ${getLastVideoError() || 'فشل'}`);
      }

      const total = now() - t0;
      await ctx.reply(
        `⏱ قياس بطاقة الايدي:\n\n${marks.join('\n')}\n\n📦 حجم الصورة: ${png ? (png.length / 1024).toFixed(0) : '—'}KB` +
          `\n🎬 حجم الفيديو: ${vid ? (vid.buffer.length / 1024).toFixed(0) : '—'}KB` +
          `\n🎨 رسم الصورة: ${renderMs}ms\n🎞 بناء الفيديو: ${vidMs}ms\n⏳ المجموع: ${total}ms`,
      );
    });

    // /idcardtest — admin diagnostic: try to render the image card and report
    // success or the exact error (so we know if Chromium works on this host).
    bot.command('idcardtest', requireRole('admin'), async (ctx) => {
      await ctx.reply('⏳ بجرّب أعمل صورة البطاقة...').catch(() => undefined);
      try {
        const png = await renderIdCardImage({
          name: 'اختبار', username: '@test', id: '123456', rank: '⭐ تجربة', stats: 'عضو 🙂',
          title: 'لا يوجد', level: '1', xp: '0', messages: '0', interaction: 'تجربة', joined: 'اليوم', initial: 'T',
        });
        await ctx.replyWithPhoto({ source: png }, { caption: `✅ الصورة اشتغلت (${png.length} بايت).` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ فشل إنشاء الصورة:\n${msg}\n\nيعني Chromium مش شغّال للصور على السيرفر — البوت رح يرجع للكرت النصي.`);
        return;
      }
      // Also test the animated video card (Premium members).
      await ctx.reply('⏳ بجرّب فيديو البطاقة المميزة...').catch(() => undefined);
      const vid = await renderIdCardVideo(
        { name: 'اختبار', username: '@test', id: '123456', rank: '⭐ مميّز', stats: 'عضو 🙂', title: 'لا يوجد', level: '1', xp: '0', messages: '0', interaction: 'تجربة', joined: 'اليوم', initial: 'T' },
        'gold',
      ).catch(() => null);
      if (vid) {
        await ctx.replyWithAnimation({ source: vid.buffer, filename: `card.${vid.ext}` }, { caption: `✅ الفيديو اشتغل (${vid.ext}, ${vid.buffer.length} بايت).` }).catch((e) => ctx.reply(`⚠️ الفيديو تولّد بس تيليجرام رفضه: ${e instanceof Error ? e.message : e}`));
      } else {
        await ctx.reply(`❌ فشل فيديو البطاقة:\n${getLastVideoError() || 'سبب غير معروف'}\n\nالمشتركون المميزون رح ياخذوا صورة بدل الفيديو.`);
      }
    });

    // /idcardhelp — explain customization AND hand back the current template
    // ready to copy, so the user just swaps the emoji for premium ones.
    bot.command('idcardhelp', async (ctx) => {
      const ph = ID_PLACEHOLDERS.map((p) => `{${p}}`).join('  ');
      await ctx.reply(
        '🆔 تخصيص بطاقة «ايدي» (وإضافة إيموجي مميّز):\n\n' +
          '1) انسخ القالب الحالي من الرسالة الجاية 👇\n' +
          '2) الصقه برسالة جديدة، وبدّل الإيموجي العادية بإيموجي مميّز من كيبورد تيليجرام (يلزم حسابك Premium)، وخلّي المتغيّرات { } زي ما هي.\n' +
          '3) ردّ على رسالتك واكتب: بطاقة ايدي\n\n' +
          `المتغيّرات المتاحة:\n${ph}\n\n` +
          '✨ عشان الإيموجي المميّز يبيّن متحرّك للكل، لازم مالك البوت كمان عندو Premium.\n' +
          '🌐 مالك البوت يقدر يطبّقها على *كل* القروبات: ردّ واكتب «بطاقة ايدي للكل».\n' +
          'للرجوع للافتراضي: رجع بطاقة ايدي',
      );
      // Second message: the current effective template, tap-to-copy.
      const settings = ctx.chat ? await getSettings(ctx.chat.id).catch(() => null) : null;
      const current = settings?.idCardTemplate || DEFAULT_ID_CARD;
      const escaped = current.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await ctx.reply(`<pre>${escaped}</pre>`, { parse_mode: 'HTML' }).catch(() => ctx.reply(current).catch(() => undefined));
    });

    // /setidcard — capture the replied message (text + premium-emoji entities)
    // as this group's custom id-card template.
    bot.command('setidcard', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      const replied = (ctx.message as {
        reply_to_message?: { text?: string; caption?: string; entities?: unknown[]; caption_entities?: unknown[] };
      }).reply_to_message;
      const body = replied?.text ?? replied?.caption;
      if (!body) {
        await ctx.reply('↩️ ردّ على رسالة فيها شكل البطاقة والمتغيّرات ({name} {id}…) ثم اكتب: بطاقة ايدي.\nللمساعدة: /idcardhelp');
        return;
      }
      const entities = (replied?.entities ?? replied?.caption_entities ?? []) as unknown[];
      if (!/\{(name|id|username|rank|level|stats)\}/.test(body)) {
        await ctx.reply('⚠️ البطاقة لازم تحتوي متغيّر واحد على الأقل مثل {name} أو {id}. شوف /idcardhelp.');
        return;
      }
      await setIdCard(ctx.chat.id, body, entities);
      const hasPremium = entities.some((e) => (e as { type?: string }).type === 'custom_emoji');
      await ctx.reply(
        '✅ تم ضبط بطاقة «ايدي» المخصّصة لهذا الجروب. جرّب: ايدي' +
          (hasPremium ? '\n✨ فيها إيموجي مميّز — لازم مالك البوت عندو Telegram Premium حتى يبيّن متحرّك.' : ''),
      );
    });

    // /residcard — restore the default card.
    bot.command('residcard', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      await setIdCard(ctx.chat.id, null, null);
      await ctx.reply('♻️ رجّعت بطاقة «ايدي» للشكل الافتراضي.');
    });

    // Switch the card between a designed image and the text template.
    bot.command('idcardimage', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      await setIdCardImage(ctx.chat.id, true);
      await ctx.reply('🖼 صار كرت «ايدي» يطلع كـ *صورة* مصمّمة. جرّب: ايدي');
    });
    bot.command('idcardtext', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      await setIdCardImage(ctx.chat.id, false);
      await ctx.reply('📝 صار كرت «ايدي» يطلع كـ *نص* (تقدر تخصصه بـ «بطاقة ايدي»).');
    });

    // /idcardtheme — pick the card's color theme (buttons). Includes «auto»
    // (a different stable look per member) and «random» (varies each time).
    const themeKeyboard = () => {
      const rows = CARD_THEMES.map((th) => [{ text: th.label, callback_data: `idth:${th.id}` }]);
      rows.unshift([
        { text: '🎲 عشوائي', callback_data: 'idth:random' },
        { text: '🧩 تلقائي (لكل عضو شكل)', callback_data: 'idth:auto' },
      ]);
      return { reply_markup: { inline_keyboard: rows } };
    };
    bot.command('idcardtheme', requireRole('admin'), async (ctx) => {
      if (!ctx.chat || ctx.chat.type === 'private') return;
      await ctx.reply('🎨 اختر ثيم بطاقة «ايدي»:\n(«تلقائي» = كل عضو بلون ثابت مختلف، «عشوائي» = يتغيّر كل مرة)', themeKeyboard());
    });
    bot.action(/^idth:(.+)$/, requireRole('admin'), async (ctx) => {
      if (!ctx.chat) return;
      const id = ctx.match[1];
      const valid = id === 'auto' || id === 'random' || CARD_THEMES.some((th) => th.id === id);
      if (!valid) return void ctx.answerCbQuery().catch(() => undefined);
      await setIdCardTheme(ctx.chat.id, id);
      const label = id === 'auto' ? '🧩 تلقائي' : id === 'random' ? '🎲 عشوائي' : CARD_THEMES.find((th) => th.id === id)?.label;
      await ctx.answerCbQuery(`تم: ${label}`).catch(() => undefined);
      await ctx.editMessageText(`✅ صار ثيم البطاقة: ${label}\nجرّب: ايدي`).catch(() => undefined);
    });

    // /setidcardall — bot-owner only. Sets a GLOBAL card applied to every group
    // that hasn't set its own. Same reply-capture flow as /setidcard.
    bot.command('setidcardall', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) {
        await ctx.reply('🔒 هذا الأمر لمالك البوت فقط.');
        return;
      }
      const replied = (ctx.message as {
        reply_to_message?: { text?: string; caption?: string; entities?: unknown[]; caption_entities?: unknown[] };
      }).reply_to_message;
      const body = replied?.text ?? replied?.caption;
      if (!body) {
        await ctx.reply('↩️ ردّ على رسالة فيها شكل البطاقة والمتغيّرات ({name} {id}…) ثم اكتب: بطاقة ايدي للكل.\nللمساعدة: /idcardhelp');
        return;
      }
      const entities = (replied?.entities ?? replied?.caption_entities ?? []) as unknown[];
      if (!/\{(name|id|username|rank|level|stats)\}/.test(body)) {
        await ctx.reply('⚠️ البطاقة لازم تحتوي متغيّر واحد على الأقل مثل {name} أو {id}. شوف /idcardhelp.');
        return;
      }
      await setGlobalIdCard(body, entities);
      const hasPremium = entities.some((e) => (e as { type?: string }).type === 'custom_emoji');
      await ctx.reply(
        '✅ صار هذا شكل بطاقة «ايدي» في *كل* القروبات (إلا القروبات اللي عاملة شكل خاص فيها).' +
          (hasPremium ? '\n✨ فيها إيموجي مميّز — لازم مالك البوت عندو Telegram Premium حتى يبيّن متحرّك.' : ''),
      );
    });

    // /residcardall — bot-owner only. Clears the global card (back to default).
    bot.command('residcardall', async (ctx) => {
      if (!ctx.from || !isBotOwner(ctx.from.id)) {
        await ctx.reply('🔒 هذا الأمر لمالك البوت فقط.');
        return;
      }
      await setGlobalIdCard(null, null);
      await ctx.reply('♻️ رجّعت بطاقة «ايدي» العامة للشكل الافتراضي في كل القروبات.');
    });

    // /bio (reply) → the member's Telegram bio, or a bot-picked phrase if none.
    bot.command('bio', async (ctx) => {
      const target = resolveTarget(ctx) ?? ctx.from;
      if (!target) return;
      let bio = '';
      try {
        const chat = (await ctx.telegram.getChat(target.id)) as { bio?: string };
        bio = chat.bio?.trim() ?? '';
      } catch {
        /* bio unavailable */
      }
      const name = displayName(target);
      if (bio) {
        await ctx.reply(`📝 بايو ${name}:\n«${bio}»`);
      } else {
        await ctx.reply(`📝 ${name} ما حاطط بايو 🤷\nخُذ هاي من عندي:\n«${pickRandom(BIO_QUOTES)}»`);
      }
    });

    // Also trigger on a bare "id" / "آيدي" message (no slash needed).
    bot.on(message('text'), async (ctx, next) => {
      const chat = ctx.chat;
      const t = ctx.message.text.trim().toLowerCase();
      const isTrigger =
        t === 'id' || t === 'ايدي' || t === 'آيدي' || t === 'الايدي' || t === 'ا' || t === 'أ';
      if (
        chat &&
        (chat.type === 'group' || chat.type === 'supergroup') &&
        isTrigger
      ) {
        // A bare "ا"/"id" always shows the SENDER's own card — never the person
        // they happen to be replying to. Use /id (reply) to see someone else's.
        if (ctx.from) await sendUserInfo(ctx, ctx.from);
      }
      return next();
    });

    bot.command('rules', async (ctx) => {
      const t = ctx.state.t!;
      const settings = ctx.state.settings ?? (ctx.chat ? await getSettings(ctx.chat.id) : null);
      if (!settings?.rules) {
        await ctx.reply(t('info.rules_empty'));
        return;
      }
      await ctx.reply(t('info.rules_header', { rules: settings.rules }));
    });

    bot.command('weather', async (ctx) => {
      const t = ctx.state.t!;
      if (!env.WEATHER_API_KEY) {
        await ctx.reply(t('info.weather_disabled'));
        return;
      }
      const city = ctx.message.text.split(' ').slice(1).join(' ').trim();
      if (!city) {
        await ctx.reply(t('info.weather_usage'));
        return;
      }
      const result = await fetchWeather(city, ctx.state.locale!);
      if (!result) {
        await ctx.reply(t('info.weather_notfound'));
        return;
      }
      await ctx.reply(t('info.weather_result', result));
    });
  },
};

interface TargetUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
}

/**
 * Pick the smallest profile-photo size that's still ~320px wide. The largest
 * size can be a multi-hundred-KB image that takes ~1s to download; a 320px
 * source is more than enough for a 148px avatar circle and a darkened cover,
 * and downloads in a fraction of the time.
 */
function pickAvatarFileId(sizes: PhotoSize[] | undefined): string | undefined {
  if (!sizes?.length) return undefined;
  const ordered = [...sizes].sort((a, b) => a.width - b.width);
  const midOrUp = ordered.find((s) => s.width >= 300);
  return (midOrUp ?? ordered[ordered.length - 1]).file_id;
}

/**
 * Build and send a decorated profile ("id") card for `target`: profile photo
 * (if any) plus name, username, group status, equipped title, interaction level
 * and a copyable numeric ID. Every Telegram call is guarded so missing data
 * never breaks the reply.
 */
async function sendUserInfo(ctx: BotContext, target: TargetUser): Promise<void> {
  const fullName = [target.first_name, target.last_name].filter(Boolean).join(' ') || '—';
  const username = target.username ? `@${target.username}` : 'لا يوجد';

  // Settings first — they decide the fast path (image vs text, theme) and are
  // usually already loaded on ctx.state (no round-trip).
  const settings = ctx.chat ? ctx.state.settings ?? (await getSettings(ctx.chat.id).catch(() => null)) : null;
  const wantImage = !target.is_bot && (settings ? settings.idCardImage !== false : true);
  const cacheChatId = ctx.chat?.id ?? target.id;
  const cacheable = wantImage && (settings?.idCardTheme || 'auto') !== 'random';

  // FAST PATH: resend the recently-rendered card by file_id. This runs BEFORE
  // any stats/photo lookups, so a repeat «ايدي» is a single Telegram call —
  // no DB reads, no avatar download, no render.
  if (cacheable) {
    const hit = getCard(cacheChatId, target.id);
    if (hit) {
      const resent = hit.kind === 'animation'
        ? await ctx.replyWithAnimation(hit.fileId, { caption: `💎 ${fullName}` }).catch(() => null)
        : await ctx.replyWithPhoto(hit.fileId).catch(() => null);
      if (resent) return;
      clearCard(cacheChatId, target.id); // stale/expired file_id → re-render
    }
  }

  // Cache miss → show instant feedback, then gather everything concurrently.
  if (wantImage) ctx.sendChatAction('upload_photo').catch(() => undefined);
  const [member, custom, photos] = await Promise.all([
    ctx.chat ? getMember(ctx.chat.id, target.id).catch(() => null) : Promise.resolve(null),
    !target.is_bot && ctx.chat ? getChatRole(ctx.chat.id, target.id).catch(() => null) : Promise.resolve(null),
    ctx.telegram.getUserProfilePhotos(target.id, 0, 1).catch((err) => {
      log.debug({ err, userId: target.id }, 'getUserProfilePhotos failed');
      return null;
    }),
  ]);

  let role = target.is_bot ? 'member' : member?.role ?? 'member';
  // A custom bot rank overrides the stored member role when it's stronger.
  if (custom && hasRole(custom, role as Role)) role = custom;
  const messageCount = member?.messageCount ?? 0;
  const level = member?.level ?? 0;
  const rankInfo = rankForLevel(level);
  const stats = target.is_bot ? 'بوت 🤖' : statLabel(role, messageCount);
  const interaction = target.is_bot ? 'بوت 🤖' : interactionLabel(messageCount);
  const joined = member?.joinedAt ? new Date(member.joinedAt).toLocaleDateString('ar') : '—';

  // Values are inserted verbatim (no parse_mode, entities keep formatting), so
  // no HTML-escaping is needed — nothing is interpreted as markup.
  const vars: Record<string, string> = {
    name: fullName,
    username,
    id: String(target.id),
    stats,
    title: member?.title || 'لا يوجد',
    interaction,
    level: String(level),
    xp: String(member?.xp ?? 0),
    messages: String(messageCount),
    rank: `${rankInfo.emoji} ${rankInfo.name}`,
    joined,
  };

  // Template resolution: this group's own custom card → the bot-wide global
  // card (set by the owner) → the built-in default.
  let template = DEFAULT_ID_CARD;
  let templateEntities: Entity[] = [];
  if (settings?.idCardTemplate) {
    template = settings.idCardTemplate;
    if (settings.idCardEntities) {
      try {
        const parsed = JSON.parse(settings.idCardEntities);
        if (Array.isArray(parsed)) templateEntities = parsed as Entity[];
      } catch {
        /* ignore malformed entities */
      }
    }
  } else {
    const global = await getGlobalIdCard().catch(() => null);
    if (global) {
      template = global.template;
      templateEntities = global.entities as Entity[];
    }
  }
  const { text, entities } = renderIdCard(template, templateEntities, vars);

  // Latest profile photo — a mid-size (~320px), not the largest, to keep the
  // avatar download fast.
  const photoFileId = pickAvatarFileId(photos?.photos?.[0] as PhotoSize[] | undefined);

  // Preferred look: a designed IMAGE card (rendered on CPU via @napi-rs/canvas).
  // Disabled per-group with idCardImage=false, and it silently falls back to the
  // text card if rendering fails.
  if (wantImage) {
    try {
      let avatarDataUri: string | undefined;
      if (photoFileId) {
        // Reuse a recently-downloaded avatar (keyed by file_id) to skip the
        // getFileLink + download round-trips.
        avatarDataUri = getAvatar(photoFileId) ?? undefined;
        if (!avatarDataUri) {
          const link = await ctx.telegram.getFileLink(photoFileId);
          const res = await fetch(link.toString());
          if (res.ok) {
            avatarDataUri = `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
            setAvatar(photoFileId, avatarDataUri);
          }
        }
      }
      // Pick a color theme so people don't see the same card every time:
      // 'auto' gives each member a stable-but-different look; 'random' varies it.
      const themeId = resolveCardTheme(settings?.idCardTheme, String(target.id), Date.now());
      const cardData = {
        name: fullName,
        username,
        id: String(target.id),
        rank: vars.rank,
        stats,
        title: vars.title,
        level: vars.level,
        xp: vars.xp,
        messages: vars.messages,
        interaction,
        joined,
        avatarDataUri,
        initial: (fullName.trim()[0] || '?').toUpperCase(),
      };
      // Telegram Premium members get an animated video card; everyone else the
      // static image. Video render falls back to the image if it fails.
      const isPremium = Boolean((target as { is_premium?: boolean }).is_premium);
      if (isPremium) {
        const vid = await renderIdCardVideo(cardData, themeId).catch(() => null);
        if (vid) {
          const sent = await ctx
            .replyWithAnimation({ source: vid.buffer, filename: `card.${vid.ext}` }, { caption: `💎 ${fullName}` })
            .catch(async () => {
              const png = await renderIdCardImage(cardData, themeId);
              return ctx.replyWithPhoto({ source: png }).catch(() => undefined);
            });
          const animId = (sent as { animation?: { file_id?: string }; photo?: { file_id: string }[] } | undefined)?.animation?.file_id;
          const photoId = (sent as { photo?: { file_id: string }[] } | undefined)?.photo?.pop?.()?.file_id;
          if (cacheable && animId) setCard(cacheChatId, target.id, animId, 'animation');
          else if (cacheable && photoId) setCard(cacheChatId, target.id, photoId, 'photo');
          return;
        }
      }
      const png = await renderIdCardImage(cardData, themeId);
      const sent = await ctx.replyWithPhoto({ source: png });
      const fid = (sent as { photo?: { file_id: string }[] }).photo?.pop()?.file_id;
      if (cacheable && fid) setCard(cacheChatId, target.id, fid, 'photo');
      return;
    } catch (err) {
      log.debug({ err }, 'id-card image render failed, falling back to text');
    }
  }

  const ents = entities as never;
  if (photoFileId) {
    await ctx
      .replyWithPhoto(photoFileId, { caption: text, caption_entities: ents })
      // A premium-emoji entity fails if the bot owner lacks Premium → retry plain.
      .catch(() => ctx.replyWithPhoto(photoFileId!, { caption: text }).catch(() => ctx.reply(text).catch(() => undefined)));
  } else {
    await ctx.reply(text, { entities: ents }).catch(() => ctx.reply(text).catch(() => undefined));
  }
}

interface WeatherResult {
  city: string;
  desc: string;
  temp: number;
  feels: number;
  humidity: number;
  wind: number;
}

async function fetchWeather(city: string, locale: string): Promise<WeatherResult | null> {
  try {
    const url = new URL('https://api.openweathermap.org/data/2.5/weather');
    url.searchParams.set('q', city);
    url.searchParams.set('appid', env.WEATHER_API_KEY!);
    url.searchParams.set('units', 'metric');
    url.searchParams.set('lang', locale);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as {
      name: string;
      weather: Array<{ description: string }>;
      main: { temp: number; feels_like: number; humidity: number };
      wind: { speed: number };
    };
    return {
      city: data.name,
      desc: data.weather?.[0]?.description ?? '',
      temp: Math.round(data.main.temp),
      feels: Math.round(data.main.feels_like),
      humidity: data.main.humidity,
      wind: data.wind.speed,
    };
  } catch (err) {
    log.warn({ err, city }, 'Weather lookup failed');
    return null;
  }
}
