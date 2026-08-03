import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { formatTime, formatDate, formatDay } from '../../utils/time';
import { resolveTarget } from '../../utils/format';
import { getSettings } from '../../services/settings.service';
import { getMember } from '../../services/member.service';
import { statLabel, interactionLabel, buildIdCard } from './card';
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
        const target = resolveTarget(ctx) ?? ctx.from;
        if (target) await sendUserInfo(ctx, target);
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  const role = target.is_bot ? 'member' : member?.role ?? 'member';
  const messageCount = member?.messageCount ?? 0;
  const stats = target.is_bot ? 'بوت 🤖' : statLabel(role, messageCount);
  const title = member?.title ? escapeHtml(member.title) : 'لا يوجد';
  const interaction = target.is_bot ? 'بوت 🤖' : interactionLabel(messageCount);

  const caption = buildIdCard({
    name: escapeHtml(fullName),
    username: escapeHtml(username),
    stats,
    title,
    interaction,
    id: target.id,
  });

  // Fetch the latest profile photo (largest size), if available.
  let photoFileId: string | undefined;
  try {
    const photos = await ctx.telegram.getUserProfilePhotos(target.id, 0, 1);
    const sizes = photos.photos?.[0];
    if (sizes?.length) photoFileId = sizes[sizes.length - 1].file_id;
  } catch (err) {
    log.debug({ err, userId: target.id }, 'getUserProfilePhotos failed');
  }

  if (photoFileId) {
    await ctx
      .replyWithPhoto(photoFileId, { caption, parse_mode: 'HTML' })
      .catch(() => ctx.reply(caption, { parse_mode: 'HTML' }).catch(() => undefined));
  } else {
    await ctx.reply(caption, { parse_mode: 'HTML' }).catch(() => undefined);
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
