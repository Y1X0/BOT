import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';
import { env } from '../../config/env';
import { formatTime, formatDate, formatDay } from '../../utils/time';
import { displayName } from '../../utils/format';
import { getSettings } from '../../services/settings.service';
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
    { command: 'id', description: '🆔 معرّفك ومعرّف الجروب' },
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

    bot.command('id', async (ctx) => {
      const t = ctx.state.t!;
      let text = t('info.id_user', {
        name: displayName(ctx.from),
        userId: ctx.from?.id ?? '?',
      });
      if (ctx.chat && ctx.chat.type !== 'private') {
        text += t('info.id_chat', {
          title: (ctx.chat as { title?: string }).title ?? '',
          chatId: ctx.chat.id,
        });
      }
      await ctx.replyWithMarkdownV2(escapeIds(text));
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

function escapeIds(text: string): string {
  // Only escape characters that break MarkdownV2, preserving backtick code spans.
  return text.replace(/([_*[\]()~>#+\-=|{}.!])/g, '\\$1');
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
