import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { formatTime, formatDate, formatDay } from '../../utils/time';
import { resolveTarget, displayName, pickRandom } from '../../utils/format';
import { BIO_QUOTES } from './bios';
import { getSettings, setIdCard } from '../../services/settings.service';
import { getMember } from '../../services/member.service';
import { getChatRole } from '../../services/roles.service';
import { hasRole, requireRole, type Role } from '../../utils/permissions';
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
    { command: 'residcard', description: '♻️ إرجاع بطاقة ايدي الافتراضية', staffOnly: true },
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

/**
 * Build and send a decorated profile ("id") card for `target`: profile photo
 * (if any) plus name, username, group status, equipped title, interaction level
 * and a copyable numeric ID. Every Telegram call is guarded so missing data
 * never breaks the reply.
 */
async function sendUserInfo(ctx: BotContext, target: TargetUser): Promise<void> {
  const fullName = [target.first_name, target.last_name].filter(Boolean).join(' ') || '—';
  const username = target.username ? `@${target.username}` : 'لا يوجد';

  // Pull group-scoped stats (role, equipped title, message count) when in a group.
  const member = ctx.chat ? await getMember(ctx.chat.id, target.id).catch(() => null) : null;
  let role = target.is_bot ? 'member' : member?.role ?? 'member';
  // A custom bot rank overrides the stored member role when it's stronger.
  if (!target.is_bot && ctx.chat) {
    const custom = await getChatRole(ctx.chat.id, target.id).catch(() => null);
    if (custom && hasRole(custom, role as Role)) role = custom;
  }
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

  // Use the group's custom template if set, else the default.
  const settings = ctx.chat ? ctx.state.settings ?? (await getSettings(ctx.chat.id).catch(() => null)) : null;
  const template = settings?.idCardTemplate || DEFAULT_ID_CARD;
  let templateEntities: Entity[] = [];
  if (settings?.idCardTemplate && settings.idCardEntities) {
    try {
      const parsed = JSON.parse(settings.idCardEntities);
      if (Array.isArray(parsed)) templateEntities = parsed as Entity[];
    } catch {
      /* ignore malformed entities */
    }
  }
  const { text, entities } = renderIdCard(template, templateEntities, vars);

  // Fetch the latest profile photo (largest size), if available.
  let photoFileId: string | undefined;
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(target.id, 0, 1);
    const sizes = photos.photos?.[0];
    if (sizes?.length) photoFileId = sizes[sizes.length - 1].file_id;
  } catch (err) {
    log.debug({ err, userId: target.id }, 'getUserProfilePhotos failed');
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
